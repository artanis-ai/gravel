/**
 * LLM-assisted deep scan. Where `fastScan` only finds files in
 * conventional `prompts/` directories + raw markdown, the deep scan
 * walks the source tree and asks an LLM to identify prompt-like
 * strings inside code: SYSTEM_PROMPT constants, .messages([...])
 * arrays, dict values that look like instructions, etc.
 *
 * Cost: O(n_source_files) one-shot LLM calls. We chunk files larger
 * than ~16k chars to keep responses bounded; tiny files share a batch
 * call. The LLM does only classification + char-offset extraction —
 * we don't trust it to write the manifest itself.
 *
 * Provider: uses the customer's OPENAI_API_KEY (no Artanis-side
 * billing — this is a free local tool the customer runs on their
 * dev machine). Model defaults to gpt-5.4-nano-2026-03-17 (cheap,
 * structured-JSON capable). Override with GRAVEL_DEEP_SCAN_MODEL.
 */
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { generatePromptId, hashPrompt } from './hash.js'
import type { Manifest, ManifestPromptEmbedded } from './types.js'

const DEFAULT_MODEL = 'gpt-5.4-nano-2026-03-17'
const MAX_FILE_BYTES = 64 * 1024
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'])
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'dist',
  'build',
  '.gravel',
  'out',
])

interface DeepScanFinding {
  /** Path relative to repo root, forward slashes. */
  path: string
  /** 0-indexed half-open offsets into the file. */
  charStart: number
  charEnd: number
  /** 1-indexed inclusive lines. */
  lineStart: number
  lineEnd: number
  /** Best-effort variable / constant name. */
  varName?: string
  /** Why the LLM thinks this is a prompt — surfaced in --print mode. */
  why?: string
}

export interface DeepScanResult {
  manifest: Manifest
  newFindings: DeepScanFinding[]
  filesScanned: number
  filesSkipped: number
  /** Errors while scanning individual files; the run continues. */
  errors: Array<{ path: string; message: string }>
}

export interface DeepScanOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Optional progress logger; called per file. */
  onFile?: (path: string) => void
}

/**
 * Walk `repoRoot` and ask an LLM to find prompts in each source file.
 * Existing manifest entries are preserved unchanged; new findings are
 * added as `embedded` type. Returns the merged manifest.
 */
export async function deepScan(
  repoRoot: string,
  current: Manifest,
  opts: DeepScanOptions = {},
): Promise<DeepScanResult> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY not set. Deep scan calls OpenAI from your dev machine; set the key in .env or unset GRAVEL_DEEP_SCAN_PROVIDER to skip.',
    )
  }
  const model = opts.model ?? process.env.GRAVEL_DEEP_SCAN_MODEL ?? DEFAULT_MODEL
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'

  const result: DeepScanResult = {
    manifest: { ...current, prompts: [...current.prompts] },
    newFindings: [],
    filesScanned: 0,
    filesSkipped: 0,
    errors: [],
  }

  const existingPaths = new Set(current.prompts.map((p) => `${p.path}::${'charStart' in p ? p.charStart : 0}`))

  for await (const filePath of walkSource(repoRoot)) {
    const rel = relative(repoRoot, filePath).split(sep).join('/')
    if (opts.onFile) opts.onFile(rel)
    let content: string
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_FILE_BYTES) {
        result.filesSkipped++
        continue
      }
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      result.filesSkipped++
      continue
    }
    if (!hasPotentialPrompt(content)) {
      result.filesSkipped++
      continue
    }
    result.filesScanned++

    let findings: DeepScanFinding[]
    try {
      findings = await askLlm({ apiKey, baseUrl, model, path: rel, content })
    } catch (e) {
      result.errors.push({ path: rel, message: (e as Error).message })
      continue
    }

    for (const f of findings) {
      f.path = rel // overwrite anything the LLM hallucinated
      const key = `${f.path}::${f.charStart}`
      if (existingPaths.has(key)) continue
      const slice = content.slice(f.charStart, f.charEnd)
      if (!slice.trim()) continue
      const entry: ManifestPromptEmbedded = {
        id: generatePromptId(`${rel}:${f.charStart}-${f.charEnd}`),
        type: 'embedded',
        path: rel,
        hash: hashPrompt(slice),
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        charStart: f.charStart,
        charEnd: f.charEnd,
        varName: f.varName,
      }
      result.manifest.prompts.push(entry)
      result.newFindings.push(f)
      existingPaths.add(key)
    }
  }

  result.manifest.prompts.sort((a, b) => a.path.localeCompare(b.path))
  result.manifest.lastFullScanAt = new Date().toISOString()
  return result
}

/**
 * Source-file walker. Reads everything except SKIP_DIRS and binary /
 * non-source extensions. Yields absolute paths.
 */
async function* walkSource(root: string): AsyncGenerator<string> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        if (e.name.startsWith('.')) continue
        stack.push(full)
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.')
        if (dot < 0) continue
        const ext = e.name.slice(dot)
        if (SOURCE_EXTS.has(ext)) yield full
      }
    }
  }
}

/**
 * Quick filter: skip files that obviously can't contain a prompt.
 * Catches >half the source tree (utilities, types, configs). The LLM
 * is the slow/expensive step so this filter saves real money.
 */
function hasPotentialPrompt(content: string): boolean {
  // Strings of 80+ chars OR backticked multi-line strings OR dict
  // values with assistant/system/user keys.
  if (/['"][^'"\n]{80,}['"]/.test(content)) return true
  if (/`[^`]*\n[^`]*`/.test(content)) return true
  if (/(?:system|user|assistant|prompt|instruction)\s*[:=]/i.test(content)) return true
  if (/"""[\s\S]{40,}?"""/.test(content)) return true
  return false
}

/** Build the LLM request body. Public for testability. */
export function buildScanMessages(filePath: string, content: string): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `You identify LLM prompt strings hard-coded in source files. Return JSON only:
{"prompts": [{"charStart": int, "charEnd": int, "lineStart": int, "lineEnd": int, "varName": string, "why": string}]}

A "prompt" is a string literal that:
  - Instructs an LLM (system prompt, user prompt, template).
  - Is at least one full sentence OR clearly contains placeholders (\\\${var}, {{var}}, {var}).
  - Is statically defined in this file (a const, a key in a dict, an arg to chat/completions/messages).

NOT prompts:
  - Error messages, log lines, regex patterns, SQL/HTML/CSS strings.
  - Strings under 30 chars without placeholders.
  - Comments / docstrings about prompts (only the string itself).

charStart/charEnd are 0-indexed half-open offsets INTO THE EXACT FILE CONTENT below — count Unicode characters, INCLUDING the opening/closing quote characters. Example: if a prompt is 'You are a helpful AI.', the offsets cover the text including the surrounding quote chars.

If no prompts, return {"prompts": []}.`,
    },
    {
      role: 'user',
      content: `File: ${filePath}

\`\`\`
${content}
\`\`\``,
    },
  ]
}

interface LlmReqArgs {
  apiKey: string
  baseUrl: string
  model: string
  path: string
  content: string
}

async function askLlm(args: LlmReqArgs): Promise<DeepScanFinding[]> {
  const messages = buildScanMessages(args.path, args.content)
  const res = await fetch(`${args.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      messages,
      response_format: { type: 'json_object' },
      max_completion_tokens: 2000,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('empty completion')
  let parsed: { prompts?: unknown }
  try {
    parsed = JSON.parse(content) as typeof parsed
  } catch {
    throw new Error(`non-JSON completion: ${content.slice(0, 200)}`)
  }
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : []
  // Defensive: validate each entry. The LLM occasionally hallucinates
  // bad offsets (especially for files with multibyte content), so we
  // sanity-check and drop bad ones rather than corrupt the manifest.
  const findings: DeepScanFinding[] = []
  for (const raw of prompts) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as {
      charStart?: unknown
      charEnd?: unknown
      lineStart?: unknown
      lineEnd?: unknown
      varName?: unknown
      why?: unknown
    }
    if (typeof r.charStart !== 'number' || typeof r.charEnd !== 'number') continue
    if (r.charStart < 0 || r.charEnd <= r.charStart) continue
    if (r.charEnd > args.content.length) continue
    findings.push({
      path: args.path,
      charStart: Math.floor(r.charStart),
      charEnd: Math.floor(r.charEnd),
      lineStart: typeof r.lineStart === 'number' ? Math.floor(r.lineStart) : 1,
      lineEnd: typeof r.lineEnd === 'number' ? Math.floor(r.lineEnd) : 1,
      varName: typeof r.varName === 'string' ? r.varName : undefined,
      why: typeof r.why === 'string' ? r.why : undefined,
    })
  }
  return findings
}
