/**
 * "Submit changes" — turn a DE's accumulated drafts into a single PR.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (Submission), §6 (PR authoring).
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
import { readManifest, type ManifestPrompt, type ManifestPromptEmbedded } from '../manifest/index.js'
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

  const byPath = new Map<string, Resolved[]>()
  for (const r of resolved) {
    const arr = byPath.get(r.entry.path) ?? []
    arr.push(r)
    byPath.set(r.entry.path, arr)
  }

  const changes: PromptChange[] = []
  for (const [path, items] of byPath) {
    const fileChanges = items.filter((i) => i.entry.type === 'file')
    const embeddedChanges = items.filter((i) => i.entry.type === 'embedded')

    if (fileChanges.length > 0 && embeddedChanges.length > 0) {
      throw new SubmitError(
        'unknown_prompt',
        `Path ${path} has both file-type and embedded-type prompts in the same submit — ambiguous`,
      )
    }

    if (fileChanges.length > 1) {
      throw new SubmitError(
        'unknown_prompt',
        `Path ${path} has multiple file-type prompt drafts in this submit`,
      )
    }

    if (fileChanges.length === 1) {
      changes.push({ path, content: fileChanges[0]!.draft.newText })
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
      next = next.slice(0, entry.charStart) + draft.newText + next.slice(entry.charEnd)
    }
    changes.push({ path, content: next })
  }

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
