/**
 * "Submit changes" — turn a DE's accumulated drafts into a single PR.
 *
 *
 * Drafts are passed in by the caller (the dashboard reads them from the
 * browser's localStorage and POSTs them inline on the submit request).
 * No server-side draft persistence — see schema.py header.
 *
 * Pipeline:
 *   1. Look up each draft's prompt manifest entry for path + char range.
 *   2. Group drafts by file path.
 *   3. For each path: fetch current file content via the GitHub API (using
 *      the DE's OAuth access token), apply surgical edits in *descending*
 *      char-start order so earlier offsets aren't shifted by later edits.
 *   4. Hand the resulting per-file content to `createPullRequest()`.
 *
 * Invariants enforced here:
 *   - All drafts must reference prompts the manifest knows about. If a
 *     draft refers to a missing manifest entry (e.g. the prompt was
 *     deleted in the codebase since the draft was made), the submit
 *     fails fast with a structured error so the dashboard can surface it.
 *   - Embedded prompts within the same file are sorted by descending
 *     `charStart` to keep offsets valid through sequential applies.
 *   - File-type prompts replace the entire file content.
 */
import {
  MANIFEST_PATH,
  readManifest,
  type Manifest,
  type ManifestPrompt,
  type ManifestPromptEmbedded,
} from '../manifest/index.js'
import { hashPrompt } from '../manifest/hash.js'
import { codePointLength, sliceByCodePoints } from '../manifest/offsets.js'
import { githubAPI } from '../github/api.js'
import { createPullRequest, type PromptChange, type CreatePullRequestResult } from '../github/create-pr.js'

/** A single draft passed in from the dashboard's localStorage. */
export interface DraftInput {
  promptId: string
  newText: string
}

/** Compute the draft branch name for a given user. Idempotent within a day. */
export function draftBranchFor(userId: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD
  const sanitized = userId.replace(/[^A-Za-z0-9._-]/g, '-')
  return `gravel/draft-${date}-${sanitized}`
}

export interface SubmitArgs {
  /** Repo root for reading the manifest (typically `process.cwd()`). */
  repoRoot: string
  /** Drafts read from the dashboard's localStorage. */
  drafts: DraftInput[]
  /** Git branch to push the PR from. */
  draftBranch: string
  accessToken: string
  repoOwner: string
  repoName: string
  /** Optional title; defaults to "[Gravel] Update N prompt(s)". */
  title?: string
  description?: string
  deFirstName?: string
}

export class SubmitError extends Error {
  constructor(
    public code:
      | 'no_drafts'
      | 'manifest_missing'
      | 'unknown_prompt'
      | 'prompt_not_pushed'
      | 'github_failed',
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'SubmitError'
  }
}

export async function submitDrafts(args: SubmitArgs): Promise<CreatePullRequestResult> {
  if (args.drafts.length === 0) {
    throw new SubmitError('no_drafts', 'No drafts to submit')
  }

  const manifest = await readManifest(args.repoRoot)
  if (manifest.prompts.length === 0) {
    throw new SubmitError(
      'manifest_missing',
      'Manifest is empty — the dashboard expected at least one prompt',
    )
  }
  const promptIndex = new Map<string, ManifestPrompt>(manifest.prompts.map((p) => [p.id, p]))

  type Resolved = { draft: DraftInput; entry: ManifestPrompt }
  const resolved: Resolved[] = []
  const missing: string[] = []
  for (const draft of args.drafts) {
    const entry = promptIndex.get(draft.promptId)
    if (!entry) {
      missing.push(draft.promptId)
      continue
    }
    resolved.push({ draft, entry })
  }
  if (missing.length > 0) {
    throw new SubmitError('unknown_prompt', 'One or more drafts refer to unknown prompts', { missing })
  }

  // Pre-flight: if any drafts reference files that aren't yet on the
  // upstream branch, fail fast with a clear code rather than letting
  // GitHub return a generic 404. The dashboard's pre-submit check
  // should have caught this — this branch is the server-side defence-
  // in-depth so we don't burn a GitHub roundtrip on a missing file.
  const { unpushedPaths } = await import('../manifest/push-status.js')
  const draftPaths = Array.from(new Set(resolved.map((r) => r.entry.path))).sort()
  const notPushed = unpushedPaths(args.repoRoot, draftPaths)
  if (notPushed.size > 0) {
    const unpushedList = [...notPushed].sort()
    const filesWord = unpushedList.length === 1 ? 'file' : 'files'
    throw new SubmitError(
      'prompt_not_pushed',
      `The following ${filesWord} haven't been pushed to the upstream branch yet: ${unpushedList.join(', ')}. Push your branch first, then retry.`,
      { unpushed: unpushedList },
    )
  }

  const byPath = new Map<string, Resolved[]>()
  for (const r of resolved) {
    const arr = byPath.get(r.entry.path) ?? []
    arr.push(r)
    byPath.set(r.entry.path, arr)
  }

  const changes: PromptChange[] = []
  // Track each path's new content so we can recompute manifest entries
  // (offsets, line numbers, hashes) below. Keys are repo-relative paths
  // (the manifest's native form); empty when no embedded edit landed
  // for that path.
  const newContentByPath = new Map<string, string>()
  for (const [path, items] of byPath) {
    const fileChanges = items.filter((i) => i.entry.type === 'file')
    const embeddedChanges = items.filter((i) => i.entry.type === 'embedded')

    if (fileChanges.length > 0 && embeddedChanges.length > 0) {
      throw new SubmitError(
        'unknown_prompt',
        `Path ${path} has both file-type and embedded-type prompts in the same submit (ambiguous).`,
      )
    }

    if (fileChanges.length > 1) {
      throw new SubmitError(
        'unknown_prompt',
        `Path ${path} has multiple file-type prompt drafts in this submit`,
      )
    }

    if (fileChanges.length === 1) {
      const newText = fileChanges[0]!.draft.newText
      changes.push({ path, content: newText })
      newContentByPath.set(path, newText)
      continue
    }

    let current: string
    try {
      const file = await githubAPI<{ content: string; encoding: string }>(
        `/repos/${args.repoOwner}/${args.repoName}/contents/${path}`,
        args.accessToken,
      )
      current = decodeBase64Utf8(file.content, file.encoding)
    } catch (err) {
      throw new SubmitError('github_failed', `Could not read ${path} from ${args.repoOwner}/${args.repoName}`, err)
    }

    const sorted = embeddedChanges
      .map((i) => ({ entry: i.entry as ManifestPromptEmbedded, draft: i.draft }))
      .sort((a, b) => b.entry.charStart - a.entry.charStart)

    let next = current
    for (const { entry, draft } of sorted) {
      // Splice in code-point space (the manifest offset unit), not
      // UTF-16. Same characters either way for pure ASCII; surrogate
      // pairs (any emoji, astral char) split mid-pair otherwise.
      const before = sliceByCodePoints(next, 0, entry.charStart)
      const after = sliceByCodePoints(next, entry.charEnd, codePointLength(next))
      next = before + draft.newText + after
    }
    changes.push({ path, content: next })
    newContentByPath.set(path, next)
  }

  // Manifest update: every edit shifts subsequent embedded prompts'
  // char/line offsets, and every edited prompt needs a new hash. If we
  // skipped this, the merged repo would have a stale manifest pointing
  // at the wrong byte ranges and `gravel manifest --check` would fail.
  // Include the regenerated `.gravel/manifest.json` as another change
  // in the same PR so the update is atomic.
  const editedIds = new Set(resolved.map((r) => r.entry.id))
  const editsByPathMap = new Map<string, Map<number, string>>()
  for (const r of resolved) {
    if (r.entry.type !== 'embedded') continue
    const m = editsByPathMap.get(r.entry.path) ?? new Map<number, string>()
    m.set(r.entry.charStart, r.draft.newText)
    editsByPathMap.set(r.entry.path, m)
  }
  const promptsByPath = new Map<string, ManifestPrompt[]>()
  for (const p of manifest.prompts) {
    const arr = promptsByPath.get(p.path) ?? []
    arr.push(p)
    promptsByPath.set(p.path, arr)
  }
  const updatedPrompts: ManifestPrompt[] = manifest.prompts.map((entry) => {
    const newContent = newContentByPath.get(entry.path)
    if (newContent === undefined) return entry // file untouched
    if (entry.type === 'file') {
      return { ...entry, hash: hashPrompt(newContent) }
    }
    // Embedded: walk same-file embedded entries with smaller charStart
    // and accumulate the length deltas they introduced.
    const edits = editsByPathMap.get(entry.path) ?? new Map<number, string>()
    const sameFileEmbedded = (promptsByPath.get(entry.path) ?? []).filter(
      (p): p is ManifestPromptEmbedded => p.type === 'embedded',
    )
    let delta = 0
    for (const e of sameFileEmbedded) {
      if (e.charStart < entry.charStart && edits.has(e.charStart)) {
        const newText = edits.get(e.charStart)!
        // Measure in code points to match the offset unit; `.length`
        // on a JS string is UTF-16 code units.
        delta += codePointLength(newText) - (e.charEnd - e.charStart)
      }
    }
    const newCharStart = entry.charStart + delta
    let newCharEnd: number
    let newHash: string
    if (editedIds.has(entry.id)) {
      const newText = edits.get(entry.charStart)!
      newCharEnd = newCharStart + codePointLength(newText)
      newHash = hashPrompt(newText)
    } else {
      newCharEnd = entry.charEnd + delta
      newHash = entry.hash // text unchanged
    }
    return {
      ...entry,
      charStart: newCharStart,
      charEnd: newCharEnd,
      lineStart: charOffsetToLine(newContent, newCharStart),
      lineEnd: charOffsetToLine(newContent, Math.max(newCharStart, newCharEnd - 1)),
      hash: newHash,
    }
  })
  const updatedManifest: Manifest = { ...manifest, prompts: updatedPrompts }
  changes.push({ path: MANIFEST_PATH, content: serializeManifest(updatedManifest) })

  try {
    return await createPullRequest({
      accessToken: args.accessToken,
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      changes,
      title: args.title ?? `[Gravel] Update ${resolved.length} prompt(s)`,
      description: args.description,
      deFirstName: args.deFirstName,
      branchName: args.draftBranch,
    })
  } catch (err) {
    throw new SubmitError('github_failed', 'Failed to open PR', err)
  }
}

/**
 * 1-indexed line number for the line containing the code-point at
 * `cpOffset`. Walks the string by code point so a surrogate-pair
 * astral character before the offset doesn't undercount or overcount.
 */
function charOffsetToLine(text: string, cpOffset: number): number {
  let line = 1
  let cp = 0
  for (const ch of text) {
    if (cp >= cpOffset) break
    if (ch === '\n') line++
    cp++
  }
  return line
}

/** Same shape as `writeManifest` but returns the string instead of writing. */
function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

function decodeBase64Utf8(content: string, encoding: string): string {
  if (encoding !== 'base64') {
    throw new Error(`Unexpected GitHub contents encoding: ${encoding}`)
  }
  const clean = content.replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(clean, 'base64').toString('utf-8')
  }
  return decodeURIComponent(escape(atob(clean)))
}
