/**
 * Fast scan: pure file-IO, no LLM. Runs in pre-commit hook.
 *
 *
 * Catches:
 *   - Edits to known prompts (re-hash, update positions)
 *   - New `.md`/`.txt` files in conventional prompt directories
 *   - Deletions (remove entries)
 *
 * Does NOT detect new embedded prompts in code — that's the deep scan's job.
 */
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { hashPrompt, generatePromptId } from './hash.js'
import { sliceByCodePoints } from './offsets.js'
import {
  type Manifest,
  type ManifestPrompt,
  type ManifestPromptFile,
  type ManifestPromptEmbedded,
} from './types.js'

const PROMPT_FILE_DIRS = ['prompts', 'prompt', 'templates', 'assistants', 'agents']
const PROMPT_FILE_EXTS = new Set(['.md', '.txt', '.prompt'])

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
  const result: FastScanResult = { manifest: { ...current, prompts: [] }, added: 0, removed: 0, changed: 0, unchanged: 0 }

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
      // embedded — fast scan can update hash + line/char positions if the
      // exact same body still appears in the file (matched by hash). If body
      // changed, we update hash but keep positions where they were. A real
      // implementation needs an AST walk; for v0 fast scan, we just re-hash
      // by reading the same span.
      // Code-point slicing — manifest offsets are Unicode code points,
      // not UTF-16 code units. plain `content.slice` would chop on
      // surrogate-pair boundaries (any emoji, astral char).
      const slice = sliceByCodePoints(content, prompt.charStart, prompt.charEnd)
      const newHash = hashPrompt(slice)
      if (newHash === prompt.hash) {
        result.manifest.prompts.push(prompt)
        result.unchanged++
      } else {
        // Body in this span changed — update hash but flag for deep re-scan.
        // BLOCKER: AST-aware position tracking lands with deep scan. Until
        // then, embedded prompts that move within a file may produce a
        // stale/incorrect span. For v0 fast scan correctness, we update
        // hash only.
        result.manifest.prompts.push({ ...prompt, hash: newHash } satisfies ManifestPromptEmbedded)
        result.changed++
      }
      seenIds.add(prompt.id)
    }
  }

  // 2. Discover new file-type prompts in conventional dirs.
  for (const dir of PROMPT_FILE_DIRS) {
    const dirAbs = join(repoRoot, dir)
    try {
      await fs.access(dirAbs)
    } catch {
      continue
    }
    for await (const file of walk(dirAbs)) {
      const rel = relative(repoRoot, file).split(sep).join('/')
      // Already in manifest?
      if (current.prompts.some((p) => p.path === rel)) continue
      const ext = file.slice(file.lastIndexOf('.'))
      if (!PROMPT_FILE_EXTS.has(ext)) continue
      const content = await fs.readFile(file, 'utf8')
      const entry: ManifestPromptFile = {
        id: generatePromptId(rel),
        type: 'file',
        path: rel,
        hash: hashPrompt(content),
      }
      result.manifest.prompts.push(entry)
      result.added++
    }
  }

  // Sort for deterministic output (CI-stable diffs).
  result.manifest.prompts.sort((a, b) => a.path.localeCompare(b.path))

  return result
}

async function* walk(dir: string): AsyncIterable<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else if (entry.isFile()) {
      yield path
    }
  }
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
