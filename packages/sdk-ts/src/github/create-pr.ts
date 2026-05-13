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
        body: composeBody({ description, deFirstName, changes }),
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

function composeBody(opts: { description?: string; deFirstName?: string; changes: PromptChange[] }): string {
  const lines: string[] = []
  if (opts.deFirstName) {
    lines.push(`On behalf of ${opts.deFirstName}.`)
  }
  if (opts.description?.trim()) {
    lines.push('', opts.description.trim())
  }
  if (opts.changes.length > 1) {
    lines.push('', `**Files changed (${opts.changes.length}):**`)
    for (const c of opts.changes) {
      lines.push(`- \`${c.path}\``)
    }
  }
  lines.push('', '---', '<sub>PR created via [Gravel](https://gravel.artanis.ai).</sub>')
  return lines.join('\n').trimStart()
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
