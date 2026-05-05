/**
 * Thin GitHub REST client. Lifted from
 * home-page/mallet-worker/src/routes/create-pr.ts so the gravel lib uses
 * the same battle-tested PR-creation flow Mallet ships in production.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §6
 */

export interface GitHubError extends Error {
  status?: number
}

export async function githubAPI<T = unknown>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Gravel-SDK',
      ...((options.headers as Record<string, string>) || {}),
    },
  })
  const data = (await res.json()) as { message?: string }
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API error: ${res.status}`) as GitHubError
    err.status = res.status
    throw err
  }
  return data as T
}
