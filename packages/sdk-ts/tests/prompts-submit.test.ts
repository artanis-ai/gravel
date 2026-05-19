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
vi.mock('../src/github/create-pr.js', async () => {
  // Keep the real helpers (defaultPRTitle, describeManifestDiff,
  // ManifestDiffEntry type) and only stub createPullRequest. The
  // submit module imports `defaultPRTitle` to build the default PR
  // title; mocking the whole module makes it undefined and the
  // submit fails with TypeError → SubmitError('github_failed').
  const actual = (await vi.importActual('../src/github/create-pr.js')) as Record<string, unknown>
  return {
    ...actual,
    createPullRequest: (...args: unknown[]) => createPullRequestSpy(...args),
  }
})

let workdir: string

async function writeManifest(prompts: unknown[]) {
  await fs.mkdir(join(workdir, '.gravel'), { recursive: true })
  await fs.writeFile(
    join(workdir, '.gravel', 'manifest.json'),
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
    const fileChange = args.changes.find((c) => c.path === 'prompts/sys.md')
    expect(fileChange).toEqual({ path: 'prompts/sys.md', content: 'NEW WHOLE FILE' })
    // Manifest update lands in the same PR with the new hash.
    const manifestChange = args.changes.find((c) => c.path === '.gravel/manifest.json')
    expect(manifestChange).toBeDefined()
    const updated = JSON.parse(manifestChange!.content) as { prompts: Array<{ id: string; hash: string }> }
    expect(updated.prompts[0]!.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(updated.prompts[0]!.hash).not.toBe('h')
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
    const fileChange = args.changes.find((c) => c.path === 'src/prompts.ts')
    expect(fileChange).toEqual({ path: 'src/prompts.ts', content: 'const A = `P1!`; const B = `P2!!`;' })
    expect(args.changes.some((c) => c.path === '.gravel/manifest.json')).toBe(true)
  })

  it('embedded prompts: manifest entries cascade-shift after a length change', async () => {
    // Two embedded prompts in the same file; edit the FIRST one to be
    // longer. The SECOND prompt's charStart/charEnd must shift by the
    // length delta, both prompts get rehashed where text changed, and
    // line numbers must reflect any new newlines.
    const PROMPT_ONE = 'short'
    const PROMPT_TWO = 'second'
    const original = `const A = \`${PROMPT_ONE}\`;\nconst B = \`${PROMPT_TWO}\`;`
    const oneStart = original.indexOf(PROMPT_ONE)
    const twoStart = original.indexOf(PROMPT_TWO)
    const oneEnd = oneStart + PROMPT_ONE.length
    const twoEnd = twoStart + PROMPT_TWO.length
    const b64 = Buffer.from(original, 'utf-8').toString('base64')
    githubAPISpy.mockResolvedValue({ content: b64, encoding: 'base64' })

    await writeManifest([
      { id: 'p_first', type: 'embedded', path: 'src/prompts.ts', hash: 'h1', lineStart: 1, lineEnd: 1, charStart: oneStart, charEnd: oneEnd },
      { id: 'p_second', type: 'embedded', path: 'src/prompts.ts', hash: 'h2', lineStart: 2, lineEnd: 2, charStart: twoStart, charEnd: twoEnd },
    ])
    createPullRequestSpy.mockResolvedValue({
      prUrl: 'https://github.com/acme/app/pull/3',
      prNumber: 3,
      branchName: baseArgs.draftBranch,
    })

    const newOne = 'much\nlonger\nfirst'
    await call([{ promptId: 'p_first', newText: newOne }])

    const args = createPullRequestSpy.mock.calls[0]![0] as { changes: Array<{ path: string; content: string }> }
    const manifestChange = args.changes.find((c) => c.path === '.gravel/manifest.json')
    expect(manifestChange).toBeDefined()
    const updated = JSON.parse(manifestChange!.content) as {
      prompts: Array<{ id: string; charStart: number; charEnd: number; lineStart: number; lineEnd: number; hash: string }>
    }
    const first = updated.prompts.find((p) => p.id === 'p_first')!
    const second = updated.prompts.find((p) => p.id === 'p_second')!

    // First prompt: charEnd grew by (newLen - oldLen); spans 3 lines now.
    const delta = newOne.length - PROMPT_ONE.length
    expect(first.charStart).toBe(oneStart)
    expect(first.charEnd).toBe(oneStart + newOne.length)
    expect(first.lineStart).toBe(1)
    expect(first.lineEnd).toBe(3)
    expect(first.hash).toMatch(/^sha256:/)
    expect(first.hash).not.toBe('h1')

    // Second prompt: text didn't change but offsets cascade-shift.
    // Two extra newlines in the new content push it onto line 4.
    expect(second.charStart).toBe(twoStart + delta)
    expect(second.charEnd).toBe(twoEnd + delta)
    expect(second.lineStart).toBe(4)
    expect(second.lineEnd).toBe(4)
    expect(second.hash).toBe('h2') // text unchanged → hash unchanged
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
