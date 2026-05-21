/**
 * Route-level tests for the prompt-PR endpoints in `handler/routes.ts`.
 *
 * Drives the route table directly (no HTTP listener); mocks the submit
 * helper + manifest IO so we can assert auth gating, body validation, and
 * the wiring without a DB. Drafts live in the dashboard's localStorage —
 * there are no draft routes left to test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const submitSpy = vi.fn()
const getGhStateSpy = vi.fn()
const patchGhStateSpy = vi.fn(async () => {})
const mintTokenSpy = vi.fn()

vi.mock('../src/prompts/submit.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prompts/submit.js')>(
    '../src/prompts/submit.js',
  )
  return {
    ...actual,
    submitDrafts: (...a: unknown[]) => submitSpy(...a),
  }
})

vi.mock('../src/github/project-state.js', () => ({
  getGhInstallState: (...a: unknown[]) => getGhStateSpy(...a),
  bustGhInstallStateCache: () => patchGhStateSpy(),
  mintInstallationTokenViaCp: (...a: unknown[]) => mintTokenSpy(...a),
}))

let originalCwd: string
let workdir: string

async function writeManifest(prompts: unknown[]): Promise<void> {
  await fs.mkdir(join(workdir, '.gravel'), { recursive: true })
  await fs.writeFile(
    join(workdir, '.gravel', 'manifest.json'),
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
    // Match prod: handler/index.ts passes url.pathname (no query string).
    path: path.split('?')[0]!,
    authed: opts.authed === undefined ? { id: 'u1', firstName: 'Alice', role: 'admin' } : opts.authed,
  })
}

describe('prompt routes', () => {
  beforeEach(async () => {
    originalCwd = process.cwd()
    workdir = await fs.mkdtemp(join(tmpdir(), 'gravel-routes-'))
    process.chdir(workdir)
    submitSpy.mockReset()
    getGhStateSpy.mockReset()
    patchGhStateSpy.mockClear()
    mintTokenSpy.mockReset()
  })
  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('POST /api/prompts/submit', () => {
    const draftBody = {
      drafts: [{ promptId: 'p_aaa1bbb2', newText: 'NEW' }],
      title: 'My PR',
    }

    it('401 when unauthed', async () => {
      const r = await runRoute('POST', '/api/prompts/submit', { body: draftBody, authed: null })
      expect(r.status).toBe(401)
    })

    it('400 when drafts array is missing or empty', async () => {
      getGhStateSpy.mockResolvedValue({
        installationId: 1,
        repoOwner: 'a',
        repoName: 'b',
        installedAt: '',
      })
      const empty = await runRoute('POST', '/api/prompts/submit', { body: { drafts: [] } })
      expect(empty.status).toBe(400)
      expect((await empty.json()).error).toBe('no_drafts')

      const missing = await runRoute('POST', '/api/prompts/submit', { body: {} })
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toBe('no_drafts')
    })

    it('400 when a draft entry is malformed', async () => {
      getGhStateSpy.mockResolvedValue({
        installationId: 1,
        repoOwner: 'a',
        repoName: 'b',
        installedAt: '',
      })
      const r = await runRoute('POST', '/api/prompts/submit', {
        body: { drafts: [{ promptId: 'p_x' }] },
      })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toBe('invalid_draft')
    })

    it('409 github_not_installed when App not installed', async () => {
      getGhStateSpy.mockResolvedValue(null)
      const r = await runRoute('POST', '/api/prompts/submit', { body: draftBody })
      expect(r.status).toBe(409)
      const body = await r.json()
      expect(body.error).toBe('github_not_installed')
    })

    it('200 when App installed: mints token, returns PR URL, forwards drafts to submitDrafts', async () => {
      // Anonymous flow — no project ID / API key in env. The
      // install_secret on the install state is the only auth.
      getGhStateSpy.mockResolvedValue({
        installationId: 12345,
        repoOwner: 'acme',
        repoName: 'app',
        installSecret: 'sec_test',
      })
      mintTokenSpy.mockResolvedValue({
        token: 'ghs_minted',
        repoFullName: 'acme/app',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      submitSpy.mockResolvedValue({
        prUrl: 'https://github.com/acme/app/pull/9',
        prNumber: 9,
        branchName: 'gravel/draft-2026-05-08-u1',
      })
      const r = await runRoute('POST', '/api/prompts/submit', { body: draftBody })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.pr.prUrl).toBe('https://github.com/acme/app/pull/9')
      expect(mintTokenSpy).toHaveBeenCalledOnce()
      // The mint call now takes the install state directly, not
      // (apiKey, projectId).
      const mintArgs = mintTokenSpy.mock.calls[0]![0] as {
        installationId: number
        installSecret: string
      }
      expect(mintArgs.installationId).toBe(12345)
      expect(mintArgs.installSecret).toBe('sec_test')
      expect(submitSpy).toHaveBeenCalledOnce()
      const args = submitSpy.mock.calls[0]![0] as {
        title?: string
        deFirstName?: string
        repoOwner: string
        accessToken: string
        drafts: { promptId: string; newText: string }[]
        draftBranch: string
      }
      expect(args).toMatchObject({
        title: 'My PR',
        deFirstName: 'Alice',
        repoOwner: 'acme',
        accessToken: 'ghs_minted',
      })
      expect(args.drafts).toEqual([{ promptId: 'p_aaa1bbb2', newText: 'NEW' }])
      // v0.9.x single-open-PR: branch is stable, no per-user / per-date suffix.
      expect(args.draftBranch).toBe('gravel/draft')
    })

    it('502 if token mint fails (e.g. customer uninstalled the App)', async () => {
      getGhStateSpy.mockResolvedValue({
        installationId: 12345,
        repoOwner: 'acme',
        repoName: 'app',
        installSecret: 'sec_test',
      })
      mintTokenSpy.mockRejectedValue(new Error('installation/12345 404: not found'))
      const r = await runRoute('POST', '/api/prompts/submit', { body: draftBody })
      expect(r.status).toBe(502)
      const body = await r.json()
      expect(body.error).toBe('github_token_mint_failed')
    })
  })

  describe('GET /api/prompts', () => {
    it('lists manifest prompts when authed', async () => {
      await writeManifest([{ id: 'p_a1b2c3d4e5', type: 'file', path: 'a.md', hash: 'h' }])
      const r = await runRoute('GET', '/api/prompts')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.prompts).toHaveLength(1)
    })

    it('401 when unauthed (regression: route was previously public)', async () => {
      // Before v0.5.11 the TS handler omitted the auth check on this
      // route while the Python handler enforced it. Result was an
      // information disclosure on JS-SDK customers who mounted the
      // dashboard at a public path. Pin the gate.
      await writeManifest([{ id: 'p_a1b2c3d4e5', type: 'file', path: 'a.md', hash: 'h' }])
      const r = await runRoute('GET', '/api/prompts', { authed: null })
      expect(r.status).toBe(401)
    })
  })

  describe('GET /api/github/install/callback', () => {
    it('writes install env vars + 302s back to dashboard when CP returned them', async () => {
      const r = await runRoute(
        'GET',
        '/api/github/install/callback?gh=installed&installation_id=99&install_secret=sec_test&repo_owner=acme&repo_name=app',
      )
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toContain('/admin/ai/?gh=installed')
      // Env should be live for the rest of the process so the
      // immediately-following status check sees the install.
      expect(process.env.GRAVEL_GH_INSTALL_ID).toBe('99')
      expect(process.env.GRAVEL_GH_INSTALL_SECRET).toBe('sec_test')
      expect(process.env.GRAVEL_GH_REPO_OWNER).toBe('acme')
      expect(process.env.GRAVEL_GH_REPO_NAME).toBe('app')
      // .env.local picked up the writes (or .env if that's what
      // existed; this sandbox has neither yet).
      const written = await fs.readFile(join(workdir, '.env.local'), 'utf8')
      expect(written).toContain('GRAVEL_GH_INSTALL_ID=99')
      expect(written).toContain('GRAVEL_GH_INSTALL_SECRET=sec_test')
    })

    it('still 302s back even if the CP omitted the install params (degrades gracefully)', async () => {
      // Reset so leakage from the previous test doesn't make this pass
      // for the wrong reason.
      delete process.env.GRAVEL_GH_INSTALL_ID
      const r = await runRoute('GET', '/api/github/install/callback?gh=installed')
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toContain('/admin/ai/?gh=installed')
      expect(process.env.GRAVEL_GH_INSTALL_ID).toBeUndefined()
    })
  })

  describe('GET /api/github/status', () => {
    // No project ID / API key in the anonymous flow — install state
    // comes from GRAVEL_GH_INSTALL_* env vars (mocked through
    // getGhInstallState here).
    it('reports connected: false when no install state', async () => {
      getGhStateSpy.mockResolvedValue(null)
      const r = await runRoute('GET', '/api/github/status')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body).toMatchObject({ connected: false, repoOwner: null, repoName: null })
    })
    it('401 when unauthed (regression: route was previously public)', async () => {
      // Same parity bug as GET /api/prompts: TS skipped auth, Python
      // enforced it. Leaked repoOwner / repoName to anyone hitting
      // the dashboard route on an unauthenticated host.
      getGhStateSpy.mockResolvedValue({
        installationId: 12345,
        repoOwner: 'acme',
        repoName: 'app',
        installSecret: 'sec_test',
      })
      const r = await runRoute('GET', '/api/github/status', { authed: null })
      expect(r.status).toBe(401)
    })
    it('reports connected with repo state', async () => {
      getGhStateSpy.mockResolvedValue({
        installationId: 12345,
        repoOwner: 'acme',
        repoName: 'app',
        installSecret: 'sec_test',
      })
      const r = await runRoute('GET', '/api/github/status')
      const body = await r.json()
      expect(body).toMatchObject({
        connected: true,
        repoOwner: 'acme',
        repoName: 'app',
      })
    })
  })
})
