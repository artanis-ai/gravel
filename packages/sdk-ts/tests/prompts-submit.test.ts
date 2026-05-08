import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SubmitError, submitDrafts, type DraftInput } from '../src/prompts/submit.js'

// Mock the GH API + PR creation modules at the path the submit module imports.
const githubAPISpy = vi.fn()
vi.mock('../src/github/api.js', () => ({
  githubAPI: (...args: unknown[]) => githubAPISpy(...args),
}))

const createPullRequestSpy = vi.fn()
vi.mock('../src/github/create-pr.js', () => ({
  createPullRequest: (...args: unknown[]) => createPullRequestSpy(...args),
}))

let workdir: string

async function writeManifest(prompts: unknown[]) {
  await fs.mkdir(join(workdir, '.artanis'), { recursive: true })
  await fs.writeFile(
    join(workdir, '.artanis', 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        lastFullScanCommit: null,
        lastFullScanAt: null,
        prompts,
      },
      null,
      2,
    ),
  )
}

describe('submitDrafts', () => {
  beforeEach(async () => {
    workdir = await fs.mkdtemp(join(tmpdir(), 'gravel-submit-'))
    githubAPISpy.mockReset()
    createPullRequestSpy.mockReset()
  })
  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const baseArgs = {
    draftBranch: 'gravel/draft-2026-05-08-alice',
    accessToken: 'gh_test',
    repoOwner: 'acme',
    repoName: 'app',
    deFirstName: 'Alice',
  }

  function call(drafts: DraftInput[]) {
    return submitDrafts({ ...baseArgs, repoRoot: workdir, drafts })
  }

  it('throws no_drafts on empty list', async () => {
    await expect(call([])).rejects.toMatchObject({ code: 'no_drafts' })
  })

  it('throws manifest_missing when manifest empty', async () => {
    await writeManifest([])
    await expect(call([{ promptId: 'p_a', newText: 'x' }])).rejects.toMatchObject({
      code: 'manifest_missing',
    })
  })

  it('throws unknown_prompt when draft refers to unknown prompt', async () => {
    await writeManifest([{ id: 'p_real', type: 'file', path: 'a.md', hash: 'h' }])
    await expect(call([{ promptId: 'p_missing', newText: 'x' }])).rejects.toMatchObject({
      code: 'unknown_prompt',
      details: { missing: ['p_missing'] },
    })
  })

  it('file-type prompt: replaces full content + opens PR', async () => {
    await writeManifest([{ id: 'p_a', type: 'file', path: 'prompts/sys.md', hash: 'h' }])
    createPullRequestSpy.mockResolvedValue({
      prUrl: 'https://github.com/acme/app/pull/1',
      prNumber: 1,
      branchName: baseArgs.draftBranch,
    })

    const result = await call([{ promptId: 'p_a', newText: 'NEW WHOLE FILE' }])

    expect(githubAPISpy).not.toHaveBeenCalled()
    expect(createPullRequestSpy).toHaveBeenCalledOnce()
    const args = createPullRequestSpy.mock.calls[0]![0] as { changes: Array<{ path: string; content: string }> }
    expect(args.changes).toEqual([{ path: 'prompts/sys.md', content: 'NEW WHOLE FILE' }])
    expect(result.prUrl).toBe('https://github.com/acme/app/pull/1')
  })

  it('embedded prompts: applies surgical edits in descending charStart order', async () => {
    // Compute ranges from the original string itself so we can't get the
    // off-by-one wrong: charStart = indexOf, charEnd = indexOf + length
    // (half-open, matching the manifest convention in `manifest/types.ts`).
    const PROMPT_ONE = 'prompt one'
    const PROMPT_TWO = 'prompt two long'
    const original = `const A = \`${PROMPT_ONE}\`; const B = \`${PROMPT_TWO}\`;`
    const oneStart = original.indexOf(PROMPT_ONE)
    const twoStart = original.indexOf(PROMPT_TWO)
    const oneEnd = oneStart + PROMPT_ONE.length
    const twoEnd = twoStart + PROMPT_TWO.length
    const b64 = Buffer.from(original, 'utf-8').toString('base64')
    githubAPISpy.mockResolvedValue({ content: b64, encoding: 'base64' })

    await writeManifest([
      { id: 'p_first', type: 'embedded', path: 'src/prompts.ts', hash: 'h1', lineStart: 1, lineEnd: 1, charStart: oneStart, charEnd: oneEnd },
      { id: 'p_second', type: 'embedded', path: 'src/prompts.ts', hash: 'h2', lineStart: 1, lineEnd: 1, charStart: twoStart, charEnd: twoEnd },
    ])
    createPullRequestSpy.mockResolvedValue({
      prUrl: 'https://github.com/acme/app/pull/2',
      prNumber: 2,
      branchName: baseArgs.draftBranch,
    })

    // Drafts deliberately listed in ASCENDING charStart order to verify
    // that submit re-sorts to descending before applying.
    await call([
      { promptId: 'p_first', newText: 'P1!' },
      { promptId: 'p_second', newText: 'P2!!' },
    ])

    const args = createPullRequestSpy.mock.calls[0]![0] as { changes: Array<{ path: string; content: string }> }
    expect(args.changes).toEqual([
      { path: 'src/prompts.ts', content: 'const A = `P1!`; const B = `P2!!`;' },
    ])
  })

  it('rejects mixed file + embedded drafts on the same path', async () => {
    await writeManifest([
      { id: 'p_file', type: 'file', path: 'a.md', hash: 'h' },
      { id: 'p_embed', type: 'embedded', path: 'a.md', hash: 'h', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 5 },
    ])
    await expect(
      call([
        { promptId: 'p_file', newText: 'whole' },
        { promptId: 'p_embed', newText: 'part' },
      ]),
    ).rejects.toBeInstanceOf(SubmitError)
  })

  it('wraps GH read failure as github_failed', async () => {
    await writeManifest([
      { id: 'p_e', type: 'embedded', path: 'src/x.ts', hash: 'h', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 1 },
    ])
    githubAPISpy.mockRejectedValue(new Error('network down'))

    await expect(call([{ promptId: 'p_e', newText: 'X' }])).rejects.toMatchObject({
      code: 'github_failed',
    })
  })
})
