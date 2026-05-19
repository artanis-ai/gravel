/**
 * Create a PR with multiple file changes via the GitHub REST API. Lifted from
 * home-page/mallet-worker/src/routes/create-pr.ts and extended to handle
 * multiple files per PR (Gravel batches all draft edits into one PR; Mallet
 * was single-file).
 *
 */
import { githubAPI } from './api.js'

export interface PromptChange {
  /** Path inside the repo, forward-slashes, no leading `./`. */
  path: string
  /** Full new content of the file (post-edit). */
  content: string
}

export interface CreatePullRequestArgs {
  accessToken: string
  repoOwner: string
  repoName: string
  changes: PromptChange[]
  title: string
  /** Body the DE wrote in the dashboard. May be empty. */
  description?: string
  /** Submitting DE's first name; embedded in PR body for credit. */
  deFirstName?: string
  /**
   * Branch name. Auto-generated if not provided. Convention:
   * `gravel/draft-<YYYY-MM-DD>-<slug>`.
   */
  branchName?: string
  /**
   * Manifest diff summary. When present, the PR body explains the
   * `.gravel/manifest.json` change so reviewers without context don't
   * dismiss it as "weird JSON file Gravel added". See
   * {@link ManifestDiffEntry}. Pass an empty array to skip the
   * explanation (e.g. when only prompt files changed, not the
   * manifest's bookkeeping fields).
   */
  manifestDiff?: ManifestDiffEntry[]
}

/**
 * One line item in the manifest's diff summary. The PR body explains
 * each entry to reviewers — the six cases come straight out of the
 * dogfooding feedback list. Tests in create-pr.test.ts pin each shape.
 */
export interface ManifestDiffEntry {
  kind:
    | 'first_add' // manifest didn't exist before; just-added
    | 'added' // new prompt entered the manifest (new file or new inline)
    | 'edited' // same id + path, hash changed (content edit)
    | 'removed' // id no longer in the manifest
    | 'renamed' // same hash, different path (file moved)
    | 'anchors_changed' // embedded prompt's startsWith / endsWith updated
  promptId?: string
  path?: string
  oldPath?: string
}

export interface CreatePullRequestResult {
  prUrl: string
  prNumber: number
  branchName: string
}

export async function createPullRequest(args: CreatePullRequestArgs): Promise<CreatePullRequestResult> {
  const { accessToken, repoOwner, repoName, changes, title, description, deFirstName } = args

  if (!repoOwner || !repoName || changes.length === 0) {
    throw new Error('repoOwner, repoName, and at least one change are required')
  }
  if (!/^[\w.-]+$/.test(repoOwner) || !/^[\w.-]+$/.test(repoName)) {
    throw new Error('Invalid repo owner or name')
  }

  const branchName = args.branchName ?? defaultBranchName(deFirstName)

  // 1. Get default branch + base SHA.
  const repo = await githubAPI<{ default_branch: string }>(
    `/repos/${repoOwner}/${repoName}`,
    accessToken,
  )
  const defaultBranch = repo.default_branch
  const ref = await githubAPI<{ object: { sha: string } }>(
    `/repos/${repoOwner}/${repoName}/git/ref/heads/${defaultBranch}`,
    accessToken,
  )
  const baseSha = ref.object.sha

  // 2. Create new branch.
  await githubAPI(`/repos/${repoOwner}/${repoName}/git/refs`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }),
  })

  // 3. Commit each file. Sequential — keeps the diff readable; PRs typically
  //    have a handful of file changes.
  for (const change of changes) {
    let fileSha: string | undefined
    try {
      const existing = await githubAPI<{ sha: string }>(
        `/repos/${repoOwner}/${repoName}/contents/${change.path}?ref=${branchName}`,
        accessToken,
      )
      fileSha = existing.sha
    } catch {
      // File doesn't exist yet — create.
    }

    const encoded = base64Utf8(change.content)
    await githubAPI(`/repos/${repoOwner}/${repoName}/contents/${change.path}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Update ${change.path}`,
        content: encoded,
        branch: branchName,
        ...(fileSha ? { sha: fileSha } : {}),
      }),
    })
  }

  // 4. Open PR.
  const pr = await githubAPI<{ html_url: string; number: number }>(
    `/repos/${repoOwner}/${repoName}/pulls`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        head: branchName,
        base: defaultBranch,
        body: composeBody({
          description,
          deFirstName,
          changes,
          manifestDiff: args.manifestDiff,
          repoOwner,
          repoName,
          branchName,
        }),
      }),
    },
  )

  return { prUrl: pr.html_url, prNumber: pr.number, branchName }
}

function defaultBranchName(deFirstName?: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const slug = (deFirstName ?? 'edit').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `gravel/draft-${date}-${slug}-${Math.random().toString(36).slice(2, 6)}`
}

function composeBody(opts: {
  description?: string
  deFirstName?: string
  changes: PromptChange[]
  manifestDiff?: ManifestDiffEntry[]
  repoOwner: string
  repoName: string
  branchName: string
}): string {
  const lines: string[] = []
  if (opts.deFirstName) {
    lines.push(`On behalf of ${opts.deFirstName}.`)
  }
  if (opts.description?.trim()) {
    lines.push('', opts.description.trim())
  }
  // Filter out the manifest itself from the human-facing "Files
  // changed" — it always changes alongside prompt edits and reviewers
  // get a dedicated explanation below.
  const promptChanges = opts.changes.filter((c) => c.path !== '.gravel/manifest.json')
  if (promptChanges.length > 1) {
    lines.push('', `**Files changed (${promptChanges.length}):**`)
    for (const c of promptChanges) {
      lines.push(`- \`${c.path}\``)
    }
  }
  const manifestLines = describeManifestDiff(opts.manifestDiff ?? [])
  if (manifestLines.length > 0) {
    lines.push('', ...manifestLines)
  }
  // Footer: link to Gravel + feedback link prefilled with repo + branch
  // so Yousef can see the install context if the DE clicks through.
  const feedbackUrl =
    `https://gravel.artanis.ai/feedback?repo=` +
    encodeURIComponent(`${opts.repoOwner}/${opts.repoName}`) +
    `&branch=` +
    encodeURIComponent(opts.branchName)
  lines.push(
    '',
    '---',
    `<sub>PR created via [Gravel](https://gravel.artanis.ai). [Send feedback →](${feedbackUrl})</sub>`,
  )
  return lines.join('\n').trimStart()
}

/**
 * Build human-readable PR-body bullets explaining each manifest-diff
 * entry. `first_add` collapses to a single paragraph so reviewers get
 * the "what is this file?" answer once; other cases enumerate per
 * entry. Each line stands on its own; the caller chooses how to space.
 */
export function describeManifestDiff(diffs: ManifestDiffEntry[]): string[] {
  if (diffs.length === 0) return []
  if (diffs.some((d) => d.kind === 'first_add')) {
    return [
      '**About `.gravel/manifest.json`:** this PR also adds the Gravel manifest. It tracks which prompts in this repo are managed by the embedded dashboard — your team edits these files in-app and Gravel opens a PR like this one when they hit Submit. Keep the file in the repo; future updates need it to know what lives where.',
    ]
  }
  const lines: string[] = ['**Manifest changes** (`.gravel/manifest.json`):']
  for (const d of diffs) {
    switch (d.kind) {
      case 'added':
        lines.push(
          `- Added prompt \`${d.path}\` (id \`${d.promptId}\`). New entry tracked by the manifest.`,
        )
        break
      case 'edited':
        lines.push(
          `- Updated prompt at \`${d.path}\` (id \`${d.promptId}\`). The content hash changed — that's the actual edit you're reviewing.`,
        )
        break
      case 'removed':
        lines.push(
          `- Removed prompt \`${d.path}\` (id \`${d.promptId}\`). The manifest no longer tracks this file.`,
        )
        break
      case 'renamed':
        lines.push(
          `- Renamed: \`${d.oldPath}\` → \`${d.path}\` (id \`${d.promptId}\`). Same content (same hash); the manifest follows the move.`,
        )
        break
      case 'anchors_changed':
        lines.push(
          `- Updated inline-prompt anchors for \`${d.path}\` (id \`${d.promptId}\`). The surrounding code shifted; the start/end markers moved with it.`,
        )
        break
    }
  }
  return lines
}

/**
 * Build the default PR title from the list of changed prompt file
 * paths. No LLM call — just basename joining. Software-default;
 * deterministic; never embarrassing if a model would otherwise overfit.
 *
 * 1 file:  `Update judge.txt`
 * 2:        `Update judge.txt and rewrite.txt`
 * 3:        `Update judge.txt, rewrite.txt and triage.md`
 * 4+:       `Update judge.txt, rewrite.txt and 3 others`
 */
export function defaultPRTitle(paths: string[]): string {
  const names = paths.map((p) => p.split('/').pop() ?? p).filter((s) => s.length > 0)
  if (names.length === 0) return 'Update prompts'
  if (names.length === 1) return `Update ${names[0]}`
  if (names.length === 2) return `Update ${names[0]} and ${names[1]}`
  if (names.length === 3) return `Update ${names[0]}, ${names[1]} and ${names[2]}`
  const remaining = names.length - 2
  return `Update ${names[0]}, ${names[1]} and ${remaining} others`
}

/**
 * Encode UTF-8 → base64. Works in Node + Edge runtimes; the deprecated
 * `unescape(encodeURIComponent(s))` trick from the Mallet code only handles
 * BMP characters reliably, so we use Buffer where available.
 */
function base64Utf8(s: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(s, 'utf-8').toString('base64')
  }
  // Edge runtime fallback.
  return btoa(unescape(encodeURIComponent(s)))
}
