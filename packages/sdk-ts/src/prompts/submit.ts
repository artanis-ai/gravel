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
import {
  createPullRequest,
  defaultPRTitle,
  findOpenGravelPR,
  type PromptChange,
  type CreatePullRequestResult,
  type ManifestDiffEntry,
} from '../github/create-pr.js'

/** A single draft passed in from the dashboard's localStorage. */
export interface DraftInput {
  promptId: string
  newText: string
}

/** Stable branch name for Gravel draft PRs. Always `gravel/draft`,
 *  regardless of user or date: the single-open-PR model means
 *  subsequent submissions amend the existing branch (and the open
 *  PR auto-updates) instead of fanning out into multiple PRs.
 *  Signature retained for backward compat; arguments ignored. */
export function draftBranchFor(_userId: string, _now: Date = new Date()): string {
  return 'gravel/draft'
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

/** Return true when `.gravel/manifest.json` does NOT yet exist on the
 *  repo's default branch. Used to override the manifest-diff kind from
 *  `edited` / `added` to `first_add` for brand-new manifests — the user
 *  may have a populated local manifest already (from `gravel init`)
 *  but reviewers seeing the PR have no prior state. Reviewers want the
 *  "what is this file?" explainer, not per-prompt deltas.
 *
 *  Returns false if the manifest exists, on any unexpected GH error,
 *  or on missing-repo fall-through (callers degrade gracefully to the
 *  local-state diff). v0.10.0 fix for Olly's 2026-05-21 dogfooding. */
async function manifestMissingOnDefaultBranch(args: SubmitArgs): Promise<boolean> {
  try {
    const repo = await githubAPI<{ default_branch: string }>(
      `/repos/${args.repoOwner}/${args.repoName}`,
      args.accessToken,
    )
    await githubAPI(
      `/repos/${args.repoOwner}/${args.repoName}/contents/.gravel/manifest.json?ref=${repo.default_branch}`,
      args.accessToken,
    )
    return false
  } catch (err) {
    // GitHub's contents API returns 404 when the file is missing.
    // Other errors (network blip, auth) fall through to the same
    // "treat as exists" path: better to under-trigger first_add than
    // mis-trigger it on transient failures.
    const message = err instanceof Error ? err.message : String(err)
    return /\b404\b/.test(message)
  }
}

/** Fetch `.gravel/manifest.json` from the open Gravel PR's branch.
 *  Returns null when no open PR exists, when the branch doesn't carry
 *  a manifest yet, or on any other failure (caller falls back to the
 *  local-disk manifest). Mirrors
 *  `python/gravel/src/artanis_gravel/_prompts_submit.py:_fetch_branch_manifest`. */
async function fetchBranchManifest(args: SubmitArgs): Promise<Manifest | null> {
  let pr: { head: { ref: string } } | null
  try {
    pr = await findOpenGravelPR(args.accessToken, args.repoOwner, args.repoName)
  } catch {
    return null
  }
  if (!pr || typeof pr.head?.ref !== 'string') return null
  let resp: { content?: string; encoding?: string }
  try {
    resp = await githubAPI<{ content: string; encoding: string }>(
      `/repos/${args.repoOwner}/${args.repoName}/contents/.gravel/manifest.json?ref=${pr.head.ref}`,
      args.accessToken,
    )
  } catch {
    return null
  }
  if (typeof resp.content !== 'string' || resp.encoding !== 'base64') return null
  try {
    const body = Buffer.from(resp.content.replace(/\s+/g, ''), 'base64').toString('utf-8')
    return JSON.parse(body) as Manifest
  } catch {
    return null
  }
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

  const localManifest = await readManifest(args.repoRoot)
  if (localManifest.prompts.length === 0) {
    throw new SubmitError(
      'manifest_missing',
      'Manifest is empty (the dashboard expected at least one prompt)',
    )
  }
  // Branch-aware baseline: when an open Gravel PR exists, fetch the
  // manifest from its `gravel/draft` branch and use it as the baseline
  // instead of the user's local disk. Without this, user B's submit
  // baselines against their stale local state and silently drops
  // manifest entries user A just added in the open PR. v0.9.5 closes
  // the follow-up the v0.9.4 commit message flagged.
  const branchManifest = await fetchBranchManifest(args).catch(() => null)
  const manifest =
    branchManifest && branchManifest.prompts.length > 0 ? branchManifest : localManifest
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

  // Per-prompt-file title list: filter out the manifest itself so the
  // PR title reflects the prompt edits, not the bookkeeping change.
  const promptFilePaths = changes
    .filter((c) => c.path !== MANIFEST_PATH)
    .map((c) => c.path)
  let manifestDiff = computeManifestDiffSummary(manifest, updatedManifest)
  // Brand-new manifest on the default branch: override the per-prompt
  // diff (which only sees the LOCAL state's already-populated baseline)
  // with a single `first_add` entry, so the PR body shows the
  // "what is this file?" explainer for reviewers.
  if (await manifestMissingOnDefaultBranch(args)) {
    manifestDiff = [{ kind: 'first_add' }]
  }

  try {
    return await createPullRequest({
      accessToken: args.accessToken,
      repoOwner: args.repoOwner,
      repoName: args.repoName,
      changes,
      title: args.title ?? defaultPRTitle(promptFilePaths),
      description: args.description,
      deFirstName: args.deFirstName,
      branchName: args.draftBranch,
      manifestDiff,
    })
  } catch (err) {
    throw new SubmitError('github_failed', 'Failed to open PR', err)
  }
}

/**
 * Diff old vs new manifest and return one entry per observable change.
 * The shapes line up 1:1 with the cases the PR-body explainer renders;
 * see `describeManifestDiff` in github/create-pr.ts. Six cases:
 *   - first_add: old manifest empty AND new has prompts (no prior state)
 *   - added: id is new in next
 *   - removed: id is gone from next
 *   - edited: same id+path, hash changed
 *   - renamed: same hash, different path
 *   - anchors_changed: same embedded id, startsWith/endsWith updated
 */
export function computeManifestDiffSummary(
  prev: Manifest,
  next: Manifest,
): ManifestDiffEntry[] {
  if (prev.prompts.length === 0 && next.prompts.length > 0) {
    return [{ kind: 'first_add' }]
  }
  const out: ManifestDiffEntry[] = []
  const prevById = new Map(prev.prompts.map((p) => [p.id, p]))
  const nextById = new Map(next.prompts.map((p) => [p.id, p]))
  for (const [id, np] of nextById) {
    const op = prevById.get(id)
    if (!op) {
      out.push({ kind: 'added', promptId: id, path: np.path })
      continue
    }
    if (op.path !== np.path) {
      if (op.hash === np.hash) {
        out.push({ kind: 'renamed', promptId: id, oldPath: op.path, path: np.path })
      } else {
        // Path moved AND content changed — surface as edited; the
        // path move alone shows up in the file diff.
        out.push({ kind: 'edited', promptId: id, path: np.path })
      }
      continue
    }
    if (op.hash !== np.hash) {
      out.push({ kind: 'edited', promptId: id, path: np.path })
      continue
    }
    // Path + hash unchanged; check whether the embedded prompt's
    // resolved offsets shifted (surrounding code edited around it).
    if (
      op.type === 'embedded' &&
      np.type === 'embedded' &&
      (op.lineStart !== np.lineStart || op.charStart !== np.charStart)
    ) {
      out.push({ kind: 'anchors_changed', promptId: id, path: np.path })
    }
  }
  for (const [id, op] of prevById) {
    if (!nextById.has(id)) {
      out.push({ kind: 'removed', promptId: id, path: op.path })
    }
  }
  return out
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
