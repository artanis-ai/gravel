/**
 * Fast scan: pure file-IO, no LLM. Runs in pre-commit hook.
 *
 * As of v0.9.0 the scan walks the WHOLE repo (respecting .gitignore)
 * instead of only the conventional `prompts/`, `templates/`, etc.
 * directories. Olly's de_platform install kept prompts under
 * `api/py/prompts/`; the v0.8.1 `promptScanRoots` config field was a
 * band-aid we've now removed. The Go CLI in `cli/internal/manifest/scan.go`
 * is the canonical implementation; this TS port stays in lockstep.
 *
 * Catches:
 *   - Edits to known prompts (re-hash, update positions)
 *   - New `.md`/`.markdown`/`.txt`/`.mdx`/`.mdc` files anywhere in the repo
 *   - Deletions (remove entries)
 *
 * Does NOT detect new embedded prompts in code — that's the deep scan's job.
 */
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, sep, basename, extname } from 'node:path'
import { hashPrompt, generatePromptId } from './hash.js'
import { sliceByCodePoints } from './offsets.js'
import {
  type Manifest,
  type ManifestPrompt,
  type ManifestPromptFile,
  type ManifestPromptEmbedded,
} from './types.js'

const PROMPT_FILE_EXTS = new Set(['.md', '.markdown', '.txt', '.mdx', '.mdc'])

// Case-insensitive denylist of directory names that the scanner
// refuses to recurse into for prompts. `prompts/docs/foo.md` is docs
// about the prompts, not a prompt. Applied as a path-segment filter
// on every candidate so nested cases (`templates/examples/foo.md`)
// also get pruned.
const DOC_DIR_NAMES = new Set(['docs', 'doc', 'documentation', 'examples'])

// Case-insensitive denylist of conventional documentation stems. A
// README.md next to a genuine prompt would otherwise pollute the
// manifest with non-prompt entries.
const DOC_FILE_STEMS = new Set([
  'README',
  'CHANGELOG',
  'CONTRIBUTING',
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'AUTHORS',
  'MAINTAINERS',
  'HISTORY',
  'CHANGES',
  'SECURITY',
  'CODE_OF_CONDUCT',
  'COPYING',
  'INSTALL',
  'TODO',
  'ROADMAP',
  'USAGE',
])

// FS-walk fallback ignore list: kicks in only when the repo isn't a
// git checkout. When git is available we let .gitignore decide.
const FS_FALLBACK_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '.env',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  'vendor',
])

export interface FastScanResult {
  manifest: Manifest
  added: number
  removed: number
  changed: number
  unchanged: number
}

/**
 * Re-scan against the working tree. Returns updated manifest + counts.
 */
export async function fastScan(repoRoot: string, current: Manifest): Promise<FastScanResult> {
  const result: FastScanResult = {
    manifest: { ...current, prompts: [] },
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  }

  // 1. Update / preserve existing entries.
  const seenIds = new Set<string>()
  for (const prompt of current.prompts) {
    const filePath = join(repoRoot, prompt.path)
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      // file gone — drop
      result.removed++
      continue
    }

    if (prompt.type === 'file') {
      const newHash = hashPrompt(content)
      if (newHash === prompt.hash) {
        result.manifest.prompts.push(prompt)
        result.unchanged++
      } else {
        result.manifest.prompts.push({ ...prompt, hash: newHash } satisfies ManifestPromptFile)
        result.changed++
      }
      seenIds.add(prompt.id)
    } else {
      // embedded — code-point slice match; deep-scan owns AST-aware
      // position tracking.
      const slice = sliceByCodePoints(content, prompt.charStart, prompt.charEnd)
      const newHash = hashPrompt(slice)
      if (newHash === prompt.hash) {
        result.manifest.prompts.push(prompt)
        result.unchanged++
      } else {
        result.manifest.prompts.push({ ...prompt, hash: newHash } satisfies ManifestPromptEmbedded)
        result.changed++
      }
      seenIds.add(prompt.id)
    }
  }

  // 2. Discover new file-type prompts anywhere in the repo,
  // respecting .gitignore.
  const known = new Set(current.prompts.map((p) => p.path))
  const candidates = await walkRepoFiles(repoRoot)
  for (const rel of candidates) {
    if (known.has(rel)) continue
    const ext = extname(rel).toLowerCase()
    if (!PROMPT_FILE_EXTS.has(ext)) continue
    const stem = basename(rel, ext).toUpperCase()
    if (DOC_FILE_STEMS.has(stem)) continue
    if (rel.split('/').some((seg) => DOC_DIR_NAMES.has(seg.toLowerCase()))) continue
    let content: string
    try {
      content = await fs.readFile(join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    result.manifest.prompts.push({
      id: generatePromptId(rel),
      type: 'file',
      path: rel,
      hash: hashPrompt(content),
    } satisfies ManifestPromptFile)
    result.added++
  }

  // Sort for deterministic output (CI-stable diffs).
  result.manifest.prompts.sort((a, b) => a.path.localeCompare(b.path))

  return result
}

/**
 * Returns repo-relative, forward-slashed paths of every file in the
 * repo. Tries `git ls-files` first (honours .gitignore + global
 * ignore + .git/info/exclude); falls back to a filesystem walk with
 * FS_FALLBACK_IGNORE_DIRS when git isn't available or the directory
 * isn't a working tree.
 */
async function walkRepoFiles(repoRoot: string): Promise<string[]> {
  const fromGit = gitListFiles(repoRoot)
  if (fromGit !== null) return fromGit
  return fsWalkFiles(repoRoot)
}

function gitListFiles(repoRoot: string): string[] | null {
  // `-z` makes git use NUL separators so paths containing newlines
  // don't corrupt the list.
  const res = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  if (res.status !== 0 || typeof res.stdout !== 'string') return null
  const out: string[] = []
  for (const p of res.stdout.split('\0')) {
    if (p.length > 0) out.push(p)
  }
  return out
}

async function fsWalkFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (FS_FALLBACK_IGNORE_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue // dot-dirs (.cache, .idea, …)
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(relative(repoRoot, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }
  await walk(repoRoot)
  return out
}

/**
 * Compares two manifests as a diff suitable for the polite-blocking hook
 * to print to stderr.
 */
export function diffManifests(a: Manifest, b: Manifest): string {
  const aPrompts = new Map(a.prompts.map((p) => [p.id, p]))
  const bPrompts = new Map(b.prompts.map((p) => [p.id, p]))
  const lines: string[] = []
  for (const [id, p] of aPrompts) {
    const after = bPrompts.get(id)
    if (!after) lines.push(`- ${p.path} (removed)`)
    else if (after.hash !== p.hash) lines.push(`~ ${p.path} (content changed)`)
  }
  for (const [id, p] of bPrompts) {
    if (!aPrompts.has(id)) lines.push(`+ ${p.path} (added)`)
  }
  return lines.join('\n')
}

// Suppress unused-type warnings under verbatimModuleSyntax.
export type { ManifestPrompt }
