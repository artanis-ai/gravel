/**
 * Tests for src/wizard/oauth.ts — browser OAuth handshake against the control plane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserOAuthHandshake,
  generateAuthToken,
  pickFreePort,
  resolveControlPlaneUrl,
} from '../src/wizard/oauth.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveControlPlaneUrl', () => {
  const ORIGINAL = process.env.GRAVEL_CONTROL_PLANE_URL
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GRAVEL_CONTROL_PLANE_URL
    else process.env.GRAVEL_CONTROL_PLANE_URL = ORIGINAL
  })

  it('defaults to gravel.artanis.ai', () => {
    delete process.env.GRAVEL_CONTROL_PLANE_URL
    expect(resolveControlPlaneUrl()).toBe('https://gravel.artanis.ai')
  })

  it('honours explicit override arg', () => {
    expect(resolveControlPlaneUrl('http://localhost:8080')).toBe('http://localhost:8080')
  })

  it('honours GRAVEL_CONTROL_PLANE_URL env', () => {
    process.env.GRAVEL_CONTROL_PLANE_URL = 'https://stage.example.com'
    expect(resolveControlPlaneUrl()).toBe('https://stage.example.com')
  })
})

describe('generateAuthToken', () => {
  it('returns a 32-char URL-safe token', () => {
    const t = generateAuthToken()
    expect(t).toHaveLength(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('produces distinct tokens', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generateAuthToken())
    expect(seen.size).toBe(50)
  })
})

describe('pickFreePort', () => {
  it('binds to an ephemeral port when called with an empty preferred list', async () => {
    const { server, port } = await pickFreePort([])
    try {
      expect(port).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('falls back to ephemeral when preferred ports are unavailable', async () => {
    // Hold one port, then ask pickFreePort to use only that port; it should
    // skip via EADDRINUSE and fall back to an ephemeral one.
    const taken = await pickFreePort([])
    try {
      const result = await pickFreePort([taken.port])
      try {
        expect(result.port).not.toBe(taken.port)
      } finally {
        await new Promise<void>((r) => result.server.close(() => r()))
      }
    } finally {
      await new Promise<void>((r) => taken.server.close(() => r()))
    }
  })
})

describe('browserOAuthHandshake', () => {
  const BASE = 'https://example.test'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('completes the handshake on the first claim 200', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) {
        return jsonResponse({ ok: true, expires_in_seconds: 600 })
      }
      if (url.includes('/api/cli/auth/claim')) {
        return jsonResponse({
          project_id: 'proj_abc',
          api_key: 'ak_live_xyz',
          project_name: 'My App',
          organization_name: 'Acme',
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const claim = await browserOAuthHandshake({
      baseUrl: BASE,
      openBrowser: false,
      pollIntervalMs: 5,
      timeoutMs: 5_000,
    })

    expect(claim).toEqual({
      projectId: 'proj_abc',
      apiKey: 'ak_live_xyz',
      projectName: 'My App',
      organizationName: 'Acme',
    })

    // init was POSTed with token + redirect_port
    const initCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cli/auth/init'))!
    const initInit = initCall[1] as RequestInit
    expect(initInit.method).toBe('POST')
    const body = JSON.parse(initInit.body as string)
    expect(typeof body.token).toBe('string')
    expect(body.token).toHaveLength(32)
    expect(typeof body.redirect_port).toBe('number')
    expect(body.redirect_port).toBeGreaterThan(0)
  })

  it('polls until pending → claimed', async () => {
    let claimCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) {
        return jsonResponse({ ok: true, expires_in_seconds: 600 })
      }
      if (url.includes('/api/cli/auth/claim')) {
        claimCalls++
        if (claimCalls < 3) return jsonResponse({ error: 'pending' }, 202)
        return jsonResponse({
          project_id: 'proj_2',
          api_key: 'ak_2',
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const claim = await browserOAuthHandshake({
      baseUrl: BASE,
      openBrowser: false,
      pollIntervalMs: 5,
      timeoutMs: 5_000,
    })

    expect(claimCalls).toBe(3)
    expect(claim.projectId).toBe('proj_2')
    expect(claim.apiKey).toBe('ak_2')
    expect(claim.projectName).toBeUndefined()
    expect(claim.organizationName).toBeUndefined()
  })

  it('throws on 410 expired', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) return jsonResponse({ ok: true, expires_in_seconds: 600 })
      return jsonResponse({ error: 'expired' }, 410)
    })

    await expect(
      browserOAuthHandshake({ baseUrl: BASE, openBrowser: false, pollIntervalMs: 5, timeoutMs: 5_000 }),
    ).rejects.toThrow(/expired/i)
  })

  it('throws on 404 not found', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) return jsonResponse({ ok: true, expires_in_seconds: 600 })
      return jsonResponse({ error: 'not found' }, 404)
    })

    await expect(
      browserOAuthHandshake({ baseUrl: BASE, openBrowser: false, pollIntervalMs: 5, timeoutMs: 5_000 }),
    ).rejects.toThrow(/not recognised/i)
  })

  it('throws when init returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ error: 'boom' }, 500))
    await expect(
      browserOAuthHandshake({ baseUrl: BASE, openBrowser: false, pollIntervalMs: 5, timeoutMs: 5_000 }),
    ).rejects.toThrow(/auth\/init failed/i)
  })

  it('times out after the configured window when polling stays pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) return jsonResponse({ ok: true, expires_in_seconds: 600 })
      return jsonResponse({ error: 'pending' }, 202)
    })

    await expect(
      browserOAuthHandshake({
        baseUrl: BASE,
        openBrowser: false,
        pollIntervalMs: 1,
        timeoutMs: 30, // very short — exhaust quickly
      }),
    ).rejects.toThrow(/timed out/i)
  })

  it('invokes onAuthUrl with the browser hand-off URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) return jsonResponse({ ok: true, expires_in_seconds: 600 })
      return jsonResponse({ project_id: 'p', api_key: 'ak_x' })
    })

    let captured = ''
    await browserOAuthHandshake({
      baseUrl: BASE,
      openBrowser: false,
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      onAuthUrl: (u) => {
        captured = u
      },
    })
    expect(captured).toMatch(new RegExp(`^${BASE}/cli/auth\\?token=[A-Za-z0-9_-]{32}$`))
  })
})
