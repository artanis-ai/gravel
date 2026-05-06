/**
 * Route-level tests for the prompt-PR endpoints in `handler/routes.ts`.
 *
 * Drives the route table directly (no HTTP listener); mocks the prompts
 * helpers + manifest IO so we can assert auth gating, body validation,
 * and the wiring without a DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const upsertSpy = vi.fn()
const listSpy = vi.fn()
const deleteSpy = vi.fn(async () => {})
const submitSpy = vi.fn()
const ensureUserSpy = vi.fn(async () => {})
const getGhStateSpy = vi.fn()
const patchGhStateSpy = vi.fn(async () => {})

vi.mock('../src/prompts/drafts.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prompts/drafts.js')>(
    '../src/prompts/drafts.js',
  )
  return {
    ...actual,
    upsertDraft: (...a: unknown[]) => upsertSpy(...a),
    listDraftsForBranch: (...a: unknown[]) => listSpy(...a),
    deleteDraft: (...a: unknown[]) => deleteSpy(...a),
  }
})

vi.mock('../src/prompts/submit.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prompts/submit.js')>(
    '../src/prompts/submit.js',
  )
  return {
    ...actual,
    submitDrafts: (...a: unknown[]) => submitSpy(...a),
  }
})

vi.mock('../src/prompts/user-extra.js', () => ({
  ensureGravelUser: (...a: unknown[]) => ensureUserSpy(...a),
  getUserGhState: (...a: unknown[]) => getGhStateSpy(...a),
  patchUserGhState: (...a: unknown[]) => patchGhStateSpy(...a),
}))

let originalCwd: string
let workdir: string

async function writeManifest(prompts: unknown[]): Promise<void> {
  await fs.mkdir(join(workdir, '.artanis'), { recursive: true })
  await fs.writeFile(
    join(workdir, '.artanis', 'manifest.json'),
    JSON.stringify(
      { version: 1, lastFullScanCommit: null, lastFullScanAt: null, prompts },
      null,
      2,
    ),
  )
}

async function runRoute(
  method: string,
  path: string,
  opts: { body?: unknown; authed?: { id: string; firstName: string; role: 'admin' | 'user' } | null } = {},
): Promise<Response> {
  const { route } = await import('../src/handler/routes.js')
  const headers: Record<string, string> = {}
  let bodyInit: BodyInit | undefined
  if (opts.body !== undefined) {
    bodyInit = JSON.stringify(opts.body)
    headers['content-type'] = 'application/json'
  }
  const request = new Request(`http://example${path}`, {
    method,
    headers,
    body: method === 'GET' || method === 'DELETE' ? undefined : bodyInit,
  })
  const grRequest = {
    url: request.url,
    method: request.method,
    headers: request.headers,
    cookies: { get: () => undefined },
    raw: request,
  }
  const config = {
    mountPath: '/admin/ai',
    productName: 'Gravel',
    hideArtanisBranding: false,
    auth: {},
    database: { url: 'file:test.db' },
  } as unknown as import('../src/types.js').ResolvedGravelConfig
  return route({
    config,
    db: {} as unknown as import('../src/db/index.js').Database,
    request,
    grRequest: grRequest as unknown as import('../src/types.js').GravelRequest,
    path,
    authed: opts.authed === undefined ? { id: 'u1', firstName: 'Alice', role: 'admin' } : opts.authed,
  })
}

describe('prompt routes', () => {
  beforeEach(async () => {
    originalCwd = process.cwd()
    workdir = await fs.mkdtemp(join(tmpdir(), 'gravel-routes-'))
    process.chdir(workdir)
    upsertSpy.mockReset()
    listSpy.mockReset()
    deleteSpy.mockClear()
    submitSpy.mockReset()
    ensureUserSpy.mockClear()
    getGhStateSpy.mockReset()
    patchGhStateSpy.mockClear()
  })
  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('PUT /api/prompts/:id', () => {
    it('401 when unauthed', async () => {
      const r = await runRoute('PUT', '/api/prompts/p_a1b2c3d4e5', { body: { newText: 'x' }, authed: null })
      expect(r.status).toBe(401)
    })

    it('400 when newText missing', async () => {
      await writeManifest([{ id: 'p_a1b2c3d4e5', type: 'file', path: 'a.md', hash: 'h' }])
      const r = await runRoute('PUT', '/api/prompts/p_a1b2c3d4e5', { body: { foo: 'bar' } })
      expect(r.status).toBe(400)
    })

    it('404 when prompt id not in manifest', async () => {
      await writeManifest([{ id: 'p_e1e2e3e4e5', type: 'file', path: 'a.md', hash: 'h' }])
      const r = await runRoute('PUT', '/api/prompts/p_a9b8c7d6e5', { body: { newText: 'x' } })
      expect(r.status).toBe(404)
    })

    it('200 happy path: ensures user + upserts draft on canonical branch', async () => {
      await writeManifest([{ id: 'p_d1d2d3d4d5', type: 'file', path: 'a.md', hash: 'h' }])
      upsertSpy.mockResolvedValue({
        id: 'd1',
        promptId: 'p_d1d2d3d4d5',
        draftBranch: 'gravel/draft-2026-05-06-u1',
        newText: 'NEW',
        editorUserId: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      const r = await runRoute('PUT', '/api/prompts/p_d1d2d3d4d5', { body: { newText: 'NEW' } })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.draftBranch).toMatch(/^gravel\/draft-\d{4}-\d{2}-\d{2}-u1$/)
      expect(ensureUserSpy).toHaveBeenCalledOnce()
      expect(upsertSpy).toHaveBeenCalledOnce()
      const args = upsertSpy.mock.calls[0]![1] as { promptId: string; newText: string; editorUserId: string }
      expect(args).toMatchObject({ promptId: 'p_d1d2d3d4d5', newText: 'NEW', editorUserId: 'u1' })
    })
  })

  describe('GET /api/prompts/drafts', () => {
    it('401 unauthed', async () => {
      const r = await runRoute('GET', '/api/prompts/drafts', { authed: null })
      expect(r.status).toBe(401)
    })
    it('lists drafts for the user branch', async () => {
      listSpy.mockResolvedValue([
        { id: 'd1', promptId: 'p_aaa1bbb2', draftBranch: 'gravel/draft-2026-05-06-u1', newText: 'a', editorUserId: 'u1', createdAt: new Date(), updatedAt: new Date() },
      ])
      const r = await runRoute('GET', '/api/prompts/drafts')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.drafts).toHaveLength(1)
      expect(body.draftBranch).toContain('u1')
    })
  })

  describe('POST /api/prompts/submit', () => {
    it('409 github_not_connected when no token', async () => {
      getGhStateSpy.mockResolvedValue({})
      const r = await runRoute('POST', '/api/prompts/submit', { body: {} })
      expect(r.status).toBe(409)
      const body = await r.json()
      expect(body.error).toBe('github_not_connected')
    })
    it('200 when GH connected: returns PR URL + clears drafts', async () => {
      getGhStateSpy.mockResolvedValue({
        ghAccessToken: 'gh_t',
        repoOwner: 'acme',
        repoName: 'app',
      })
      submitSpy.mockResolvedValue({
        prUrl: 'https://github.com/acme/app/pull/9',
        prNumber: 9,
        branchName: 'gravel/draft-2026-05-06-u1',
      })
      const r = await runRoute('POST', '/api/prompts/submit', { body: { title: 'My PR' } })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.pr.prUrl).toBe('https://github.com/acme/app/pull/9')
      expect(submitSpy).toHaveBeenCalledOnce()
      const args = submitSpy.mock.calls[0]![0] as { title?: string; deFirstName?: string; repoOwner: string }
      expect(args).toMatchObject({ title: 'My PR', deFirstName: 'Alice', repoOwner: 'acme' })
    })
  })

  describe('DELETE /api/prompts/:id/draft', () => {
    it('discards a single draft', async () => {
      const r = await runRoute('DELETE', '/api/prompts/p_d2d3d4d5d6/draft')
      expect(r.status).toBe(200)
      expect(deleteSpy).toHaveBeenCalledOnce()
      const args = deleteSpy.mock.calls[0]![1] as { promptId: string }
      expect(args.promptId).toBe('p_d2d3d4d5d6')
    })
  })

  describe('POST /api/github/repo', () => {
    it('400 on bad owner/name', async () => {
      const r = await runRoute('POST', '/api/github/repo', { body: { owner: 'acme', name: '' } })
      expect(r.status).toBe(400)
    })
    it('200 + persists', async () => {
      const r = await runRoute('POST', '/api/github/repo', { body: { owner: 'acme', name: 'app' } })
      expect(r.status).toBe(200)
      expect(ensureUserSpy).toHaveBeenCalledOnce()
      expect(patchGhStateSpy).toHaveBeenCalledWith(expect.any(Object), 'u1', { repoOwner: 'acme', repoName: 'app' })
    })
  })

  describe('GET /api/github/status', () => {
    it('reports connected: false when no token', async () => {
      getGhStateSpy.mockResolvedValue({})
      const r = await runRoute('GET', '/api/github/status')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body).toMatchObject({ connected: false, repoOwner: null })
    })
    it('reports connected with repo state', async () => {
      getGhStateSpy.mockResolvedValue({
        ghAccessToken: 'gh_t',
        repoOwner: 'acme',
        repoName: 'app',
        ghConnectedAt: '2026-05-06T05:00:00.000Z',
      })
      const r = await runRoute('GET', '/api/github/status')
      const body = await r.json()
      expect(body).toMatchObject({
        connected: true,
        repoOwner: 'acme',
        repoName: 'app',
        connectedAt: '2026-05-06T05:00:00.000Z',
      })
    })
  })
})
