/**
 * Deep prompt scan that delegates to a locally-installed coding agent
 * (Claude Code or Codex). Code never leaves the dev's machine — the
 * agent uses its own tools (Read/Grep/Glob) to navigate and reports
 * findings back as JSONL on stdout.
 *
 * Why agent-delegation rather than the file-by-file OpenAI scan in
 * `manifest/deep-scan.ts`:
 *   - Cheaper in tokens (one agent session vs. one API call per file).
 *   - The agent can prune obviously-irrelevant files itself with Glob.
 *   - The user already has it installed; no extra API key required.
 *
 * Contract with the agent:
 *   - We send a precise task message describing what counts as a prompt.
 *   - The agent emits one JSON line per finding to stdout, terminating
 *     with the literal sentinel `###DONE###`.
 *   - Char offsets are computed by us after the fact from the agent-
 *     reported line ranges — line numbers are easier for the agent to
 *     produce reliably than byte offsets.
 */
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, sep, relative } from 'node:path'
import { generatePromptId, hashPrompt } from './hash.js'
import { lineToCharOffset } from './offsets.js'
import type { Manifest, ManifestPromptEmbedded } from './types.js'

export type AgentName = 'claude' | 'codex'

export interface AgentAvailability {
  claude: boolean
  codex: boolean
}

export interface AgentDeepScanOptions {
  /** Override for tests / unusual setups (e.g. point at an absolute path). */
  binary?: string
  /**
   * Extra CLI args prepended before the agent-specific args. Used by
   * tests to invoke a Node-based stand-in (`binary: process.execPath`,
   * `extraArgs: [scriptPath]`).
   */
  extraArgs?: string[]
  /** Forward agent stderr to our stderr (debugging). */
  verbose?: boolean
  /** Per-process timeout. Defaults to 5 minutes. */
  timeoutMs?: number
  /** Stream agent stdout (one chunk at a time) to a callback for live progress. */
  onChunk?: (text: string) => void
}

export interface AgentDeepScanResult {
  manifest: Manifest
  newFindings: ManifestPromptEmbedded[]
  /** Agent-reported entries that we couldn't enrich (file gone, line out of range, etc.) */
  orphans: AgentFinding[]
  /** Errors thrown while parsing agent output (didn't kill the run). */
  errors: string[]
  rawOutput: string
}

/** What the agent reports per finding. */
export interface AgentFinding {
  path: string
  lineStart: number
  lineEnd: number
  /** Best-effort variable / constant name (`SYSTEM_PROMPT`, etc.). */
  varName?: string | null
  /** A short snippet, used for human-readable output + sanity checks. */
  snippet?: string
}

export function detectAgents(): AgentAvailability {
  return { claude: hasCommand('claude'), codex: hasCommand('codex') }
}

const IS_WIN = process.platform === 'win32'

function hasCommand(cmd: string): boolean {
  if (IS_WIN) {
    // Windows: `where` walks PATH + PATHEXT (.cmd / .exe / .bat),
    // matching how the npm shim for `claude` actually resolves.
    const r = spawnSync('where', [cmd], { stdio: 'ignore' })
    return r.status === 0
  }
  // POSIX: `command -v` (built into sh) is the portable check; fall
  // back to `which` for shells that don't expose it on PATH.
  const cv = spawnSync('sh', ['-c', `command -v ${shellQuote(cmd)}`], {
    stdio: 'ignore',
  })
  if (cv.status === 0) return true
  const w = spawnSync('which', [cmd], { stdio: 'ignore' })
  return w.status === 0
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Run the deep scan against `repoRoot` using the named agent. Existing
 * manifest entries are skipped — we only return new prompts.
 */
export async function agentDeepScan(
  repoRoot: string,
  current: Manifest,
  agent: AgentName,
  opts: AgentDeepScanOptions = {},
): Promise<AgentDeepScanResult> {
  const knownPaths = new Set(current.prompts.map((p) => p.path))
  const task = renderTaskMessage(knownPaths)
  const errors: string[] = []
  const { stdout, stderr, exitCode } = await spawnAgent(agent, task, repoRoot, opts)
  if (exitCode !== 0) {
    errors.push(`agent exited with code ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`)
  }

  const findings = parseFindings(stdout, errors)
  const enriched: ManifestPromptEmbedded[] = []
  const orphans: AgentFinding[] = []
  for (const f of findings) {
    if (knownPaths.has(f.path)) continue
    const entry = await enrich(repoRoot, f)
    if (entry) enriched.push(entry)
    else orphans.push(f)
  }

  // Dedupe by (path, lineStart, lineEnd) — agents occasionally repeat findings.
  const seen = new Set<string>()
  const newFindings = enriched.filter((e) => {
    const key = `${e.path}:${e.lineStart}:${e.lineEnd}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const manifest: Manifest = {
    ...current,
    prompts: [...current.prompts, ...newFindings].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  }

  return { manifest, newFindings, orphans, errors, rawOutput: stdout }
}

function renderTaskMessage(knownPaths: Set<string>): string {
  const skipList =
    knownPaths.size === 0
      ? 'None.'
      : Array.from(knownPaths)
          .map((p) => `- ${p}`)
          .join('\n')
  // The task is intentionally rigid — we want JSONL we can parse, not
  // chatter. Agents are good at this if you tell them exactly what to
  // do. The ###DONE### sentinel lets us stop reading when the agent
  // has emitted everything; trailing chatter is ignored.
  return [
    `# Deep prompt scan`,
    ``,
    `Find every "prompt" embedded in this codebase. A prompt is a string`,
    `literal or template that's used as a system / user / assistant message`,
    `to an LLM call (OpenAI, Anthropic, LangChain, Vercel AI, raw fetch to`,
    `an LLM endpoint). Examples:`,
    ``,
    `  const SYSTEM_PROMPT = "You are a careful triage assistant..."`,
    `  messages: [{ role: "system", content: \`Translate to Spanish: ...\` }]`,
    `  await openai.chat.completions.create({ messages: [{role: "user", content: prompt}] })`,
    ``,
    `## Steps`,
    ``,
    `1. Use Glob to find candidate files. Look in: src/, lib/, app/, server/,`,
    `   packages/, api/, agents/. Skip: node_modules/, dist/, build/, .next/,`,
    `   __pycache__/, .venv/, venv/, .git/, **/__tests__/**, **/*.test.*,`,
    `   **/*.spec.*.`,
    ``,
    `2. Use Read/Grep on candidates to identify prompt-like string literals.`,
    `   Skim, don't deep-dive — false positives are fine, false negatives are`,
    `   the cost.`,
    ``,
    `3. For each prompt you find, output ONE line of JSON to stdout (no`,
    `   prefix or explanation around it):`,
    ``,
    `   {"path":"src/agents/triage.ts","lineStart":12,"lineEnd":28,"varName":"SYSTEM_PROMPT","snippet":"You are a careful..."}`,
    ``,
    `4. After ALL findings, output exactly this on its own line:`,
    `   ###DONE###`,
    ``,
    `## Constraints`,
    ``,
    `- Paths must be relative to the repo root, forward slashes.`,
    `- "lineStart" is 1-indexed, inclusive. "lineEnd" is the last line of the`,
    `  prompt, inclusive.`,
    `- "varName" is best-effort; null is fine if there's no obvious name.`,
    `- "snippet" is the first ~80 characters of the prompt content (escape`,
    `  control chars; one line).`,
    `- Skip prompts shorter than ~30 characters (those are probably labels,`,
    `  not prompts).`,
    `- Do NOT emit anything other than JSONL findings + the final ###DONE###`,
    `  line. No commentary, no headers.`,
    ``,
    `## Already-tracked prompts (skip these)`,
    ``,
    skipList,
  ].join('\n')
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function spawnAgent(
  agent: AgentName,
  task: string,
  cwd: string,
  opts: AgentDeepScanOptions,
): Promise<SpawnResult> {
  const binary = opts.binary ?? agent
  // Task goes via stdin, never as a CLI arg. Two reasons:
  //   1. The task is multi-kilobyte; some shells truncate long argv.
  //   2. It contains shell metacharacters (backticks, quotes, $) — fine
  //      when spawn is called without a shell, but on Windows we need
  //      `shell: true` to resolve `.cmd` shims and that re-introduces
  //      escaping. Keeping the prompt out of argv sidesteps both.
  const args = [
    ...(opts.extraArgs ?? []),
    ...(agent === 'claude' ? claudeArgs() : codexArgs()),
  ]
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000

  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows-only: `claude` ships as an npm `.cmd` shim, which
      // Node's spawn won't resolve without going through a shell.
      // POSIX keeps the direct exec for predictable arg handling.
      shell: IS_WIN,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += `\n[gravel] agent exceeded ${timeoutMs}ms — killed.`
    }, timeoutMs)

    // Pipe the task in. Both `claude -p` (no positional) and
    // `codex exec` (no positional) read the prompt from stdin.
    child.stdin.write(task)
    child.stdin.end()

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      opts.onChunk?.(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      if (opts.verbose) process.stderr.write(text)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

function claudeArgs(): string[] {
  // `claude -p` with no positional argument reads the prompt from
  // stdin. Restrict to read-only tools so the agent can't write
  // anything during the scan; bypass-permissions is safe with that
  // narrow allowlist. Earlier versions used `--bare` to skip
  // CLAUDE.md noise, but `--bare` also strips OAuth/keychain auth so
  // users logged in via `claude /login` got "Not logged in"
  // failures. Keep normal auth context; the noise cost is acceptable.
  return [
    '-p',
    '--output-format',
    'text',
    '--allowed-tools',
    'Read Grep Glob',
    '--permission-mode',
    'bypassPermissions',
  ]
}

function codexArgs(): string[] {
  // `codex exec` runs a single task non-interactively, reading the
  // prompt from stdin when no positional is provided. The exec mode
  // already sandboxes file access by default; no extra flags needed.
  return ['exec']
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function parseFindings(stdout: string, errors: string[]): AgentFinding[] {
  const cleaned = stdout.replace(ANSI_RE, '')
  const out: AgentFinding[] = []
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === '###DONE###') break
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed) as Partial<AgentFinding>
      if (
        typeof obj.path === 'string' &&
        typeof obj.lineStart === 'number' &&
        typeof obj.lineEnd === 'number' &&
        obj.lineEnd >= obj.lineStart &&
        obj.lineStart >= 1
      ) {
        out.push({
          path: obj.path.replace(new RegExp('\\' + sep, 'g'), '/'),
          lineStart: obj.lineStart,
          lineEnd: obj.lineEnd,
          varName: typeof obj.varName === 'string' ? obj.varName : null,
          snippet: typeof obj.snippet === 'string' ? obj.snippet : undefined,
        })
      }
    } catch (e) {
      errors.push(`bad JSON line: ${trimmed.slice(0, 120)} — ${(e as Error).message}`)
    }
  }
  return out
}

async function enrich(
  repoRoot: string,
  f: AgentFinding,
): Promise<ManifestPromptEmbedded | null> {
  const abs = join(repoRoot, ...f.path.split('/'))
  let text: string
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
  // Compute char offsets from the line range. Gravel's manifest stores
  // half-open [charStart, charEnd) into the raw file content.
  const charStart = lineToCharOffset(text, f.lineStart - 1)
  if (charStart < 0) return null
  const charEnd = lineToCharOffset(text, f.lineEnd)
  if (charEnd <= charStart) return null
  const slice = text.slice(charStart, charEnd)
  const rel = relative(repoRoot, abs).split(sep).join('/')
  return {
    id: generatePromptId(`${rel}:${f.lineStart}:${f.lineEnd}:${f.varName ?? ''}`),
    type: 'embedded',
    path: rel,
    hash: hashPrompt(slice),
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    charStart,
    charEnd,
    varName: f.varName ?? undefined,
  }
}

