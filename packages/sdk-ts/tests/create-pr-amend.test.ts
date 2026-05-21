/**
 * Tests for the v0.9.x single-open-PR amendment path in createPullRequest.
 *
 * Cross-stack parity with
 * `python/gravel/tests/test_github_api.py::test_create_pull_request_amends_when_open_pr_exists`.
 *
 * What we pin:
 *   - findOpenGravelPR matches by head.ref === 'gravel/draft' and ignores
 *     any non-Gravel open PR (or open PRs on a different bot branch)
 *   - When an open Gravel PR is found, createPullRequest skips branch +
 *     PR creation, PUTs files on the existing branch, and returns
 *     isAmendment=true with the existing PR's url + number
 *   - Fresh-PR path returns isAmendment=false
 *   - Fresh-PR path issues a DELETE on the stale branch before
 *     creating the new one (tolerates leftover branches from
 *     closed/merged PRs)
 */
import { describe, expect, it, vi } from 'vitest'

const githubAPISpy = vi.fn()
vi.mock('../src/github/api.js', () => ({
  githubAPI: (...args: unknown[]) => githubAPISpy(...args),
  GitHubAPIError: class extends Error {
    status = 0
    constructor(msg: string, status = 0) {
      super(msg)
      this.status = status
    }
  },
}))

import { createPullRequest, findOpenGravelPR } from '../src/github/create-pr.js'

function reset() {
  githubAPISpy.mockReset()
}

describe('findOpenGravelPR', () => {
  it('returns the gravel/draft PR when present', async () => {
    reset()
    githubAPISpy.mockResolvedValueOnce([
      { head: { ref: 'feature/x' }, html_url: 'u1', number: 1 },
      { head: { ref: 'gravel/draft' }, html_url: 'https://gh/acme/app/pull/7', number: 7 },
    ])
    const pr = await findOpenGravelPR('tok', 'acme', 'app')
    expect(pr).not.toBeNull()
    expect(pr?.number).toBe(7)
    expect(pr?.html_url).toBe('https://gh/acme/app/pull/7')
  })

  it('returns null when no open PR is on gravel/draft', async () => {
    reset()
    githubAPISpy.mockResolvedValueOnce([
      { head: { ref: 'feature/x' }, html_url: 'u1', number: 1 },
    ])
    expect(await findOpenGravelPR('tok', 'acme', 'app')).toBeNull()
  })

  it('returns null when the pulls response is not an array (defensive)', async () => {
    reset()
    githubAPISpy.mockResolvedValueOnce(null)
    expect(await findOpenGravelPR('tok', 'acme', 'app')).toBeNull()
  })
})

describe('createPullRequest amendment path', () => {
  it('skips branch + PR creation, PUTs files on the existing branch, returns isAmendment=true', async () => {
    reset()
    // 1. pulls?state=open → open gravel/draft PR
    githubAPISpy.mockResolvedValueOnce([
      { head: { ref: 'gravel/draft' }, html_url: 'https://gh/acme/app/pull/12', number: 12 },
    ])
    // 2. GET /contents/x.md?ref=gravel/draft → file exists with a sha
    githubAPISpy.mockResolvedValueOnce({ sha: 'prior-sha' })
    // 3. PUT /contents/x.md → ok
    githubAPISpy.mockResolvedValueOnce({})

    const result = await createPullRequest({
      accessToken: 'tok',
      repoOwner: 'acme',
      repoName: 'app',
      changes: [{ path: 'x.md', content: 'amended' }],
      title: 'Bulk',
      branchName: 'gravel/draft',
    })

    expect(result).toEqual({
      prUrl: 'https://gh/acme/app/pull/12',
      prNumber: 12,
      branchName: 'gravel/draft',
      isAmendment: true,
    })

    // No POST /git/refs (branch create); no POST /pulls (PR create).
    const methods = githubAPISpy.mock.calls.map((c) => {
      const opts = c[2] as { method?: string } | undefined
      return opts?.method ?? 'GET'
    })
    const endpoints = githubAPISpy.mock.calls.map((c) => c[0] as string)
    expect(methods).toEqual(['GET', 'GET', 'PUT'])
    expect(endpoints[0]).toContain('/pulls?state=open')
    expect(endpoints[1]).toContain('/contents/x.md?ref=gravel/draft')
    expect(endpoints[2]).toContain('/contents/x.md')

    // PUT body included the prior sha (existing-file replace).
    const putBody = JSON.parse((githubAPISpy.mock.calls[2]![2] as { body: string }).body)
    expect(putBody.sha).toBe('prior-sha')
    expect(putBody.branch).toBe('gravel/draft')
  })
})

describe('createPullRequest fresh path', () => {
  it('returns isAmendment=false and DELETEs stale branch before creating', async () => {
    reset()
    // 1. pulls?state=open → no open Gravel PR
    githubAPISpy.mockResolvedValueOnce([])
    // 2. DELETE /git/refs/heads/gravel/draft → ok (success)
    githubAPISpy.mockResolvedValueOnce({})
    // 3. GET /repos/{o}/{r} → default_branch
    githubAPISpy.mockResolvedValueOnce({ default_branch: 'main' })
    // 4. GET /git/ref/heads/main → base sha
    githubAPISpy.mockResolvedValueOnce({ object: { sha: 'base-sha' } })
    // 5. POST /git/refs → ok (branch create)
    githubAPISpy.mockResolvedValueOnce({})
    // 6. GET /contents/x.md → 404 (file doesn't exist on branch yet)
    githubAPISpy.mockRejectedValueOnce(new Error('not found'))
    // 7. PUT /contents/x.md → ok
    githubAPISpy.mockResolvedValueOnce({})
    // 8. POST /pulls → opens
    githubAPISpy.mockResolvedValueOnce({ html_url: 'https://gh/acme/app/pull/99', number: 99 })

    const result = await createPullRequest({
      accessToken: 'tok',
      repoOwner: 'acme',
      repoName: 'app',
      changes: [{ path: 'x.md', content: 'new' }],
      title: 'Bulk',
      branchName: 'gravel/draft',
    })

    expect(result.isAmendment).toBe(false)
    expect(result.prNumber).toBe(99)

    const sequence = githubAPISpy.mock.calls.map((c) => {
      const opts = c[2] as { method?: string } | undefined
      return [opts?.method ?? 'GET', (c[0] as string).split('?')[0]]
    })
    expect(sequence).toEqual([
      ['GET', '/repos/acme/app/pulls'],
      ['DELETE', '/repos/acme/app/git/refs/heads/gravel/draft'],
      ['GET', '/repos/acme/app'],
      ['GET', '/repos/acme/app/git/ref/heads/main'],
      ['POST', '/repos/acme/app/git/refs'],
      ['GET', '/repos/acme/app/contents/x.md'],
      ['PUT', '/repos/acme/app/contents/x.md'],
      ['POST', '/repos/acme/app/pulls'],
    ])
  })

  it('tolerates a DELETE failure on the stale branch (404 = nothing to clean)', async () => {
    reset()
    githubAPISpy.mockResolvedValueOnce([]) // no open PR
    githubAPISpy.mockRejectedValueOnce(new Error('not found')) // DELETE 404
    githubAPISpy.mockResolvedValueOnce({ default_branch: 'main' })
    githubAPISpy.mockResolvedValueOnce({ object: { sha: 'base-sha' } })
    githubAPISpy.mockResolvedValueOnce({})
    githubAPISpy.mockRejectedValueOnce(new Error('not found'))
    githubAPISpy.mockResolvedValueOnce({})
    githubAPISpy.mockResolvedValueOnce({ html_url: 'https://gh/a/b/pull/1', number: 1 })

    const result = await createPullRequest({
      accessToken: 'tok',
      repoOwner: 'a',
      repoName: 'b',
      changes: [{ path: 'x.md', content: 'x' }],
      title: 'T',
      branchName: 'gravel/draft',
    })
    expect(result.isAmendment).toBe(false)
    expect(result.prNumber).toBe(1)
  })
})
