/**
 * Tests for the `GET /api/version` route — the backend half of the
 * update-prompting journey. The dashboard's UpdateBanner is admin-only
 * because the data it surfaces is too: a domain expert in production
 * shouldn't see "your developer is on an out-of-date SDK". The route
 * enforces that gate server-side too.
 *
 * Coverage:
 *   - localhost-admin shortcut returns 200 + the VersionInfo shape.
 *   - Non-localhost host without a session returns 401 (auth gate).
 *   - GRAVEL_VERSION_CHECK_DISABLED=1 returns latest=null + hasUpdate=false.
 *   - Registry fetch is mocked end-to-end via globalThis.fetch.
 *
 * We share the same handler-construction pattern as the other tests
 * in this directory (createGravelHandler + a Request) so we exercise
 * the real auth pipeline rather than calling the route function in
 * isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetHandlerForTests, createGravelHandler } from '../src/handler/index.js'
import { _resetGravelTracingForTests } from '../src/tracing/persist.js'
import { _resetVersionCacheForTests } from '../src/handler/version.js'

const LOOPBACK_HOST = '127.0.0.1'
const PROD_HOST = 'app.example.com'

beforeEach(() => {
  _resetHandlerForTests()
  _resetGravelTracingForTests()
  _resetVersionCacheForTests()
  delete process.env.GRAVEL_VERSION_CHECK_DISABLED
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockRegistry(version: string | null, opts: { status?: number; throws?: boolean } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.includes('registry.npmjs.org/@artanis-ai/gravel/latest')) {
      if (opts.throws) throw new Error('mocked network failure')
      const status = opts.status ?? 200
      return new Response(
        version === null ? 'no version' : JSON.stringify({ version }),
        { status },
      )
    }
    return new Response('not found', { status: 404 })
  })
}

function buildHandler() {
  return createGravelHandler({
    config: {
      mountPath: '/admin/ai',
      auth: { defaultPassword: 'irrelevant-for-this-test' },
      // Default `localhostIsAdmin: true` — loopback host = admin.
    },
  })
}

async function get(handler: ReturnType<typeof buildHandler>, host: string): Promise<Response> {
  return handler(
    new Request(`http://${host}/admin/ai/api/version`, {
      method: 'GET',
      headers: { host },
    }),
  )
}

describe('GET /api/version', () => {
  it('returns the VersionInfo shape to a loopback (admin) caller', async () => {
    mockRegistry('99.0.0')
    const handler = buildHandler()
    const res = await get(handler, LOOPBACK_HOST)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      current: string
      latest: string | null
      hasUpdate: boolean
    }
    expect(body.current).toMatch(/^\d+\.\d+\.\d+/)
    expect(body.latest).toBe('99.0.0')
    expect(body.hasUpdate).toBe(true)
  })

  it('reports hasUpdate=false when current >= latest', async () => {
    mockRegistry('0.0.1')
    const handler = buildHandler()
    const res = await get(handler, LOOPBACK_HOST)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.latest).toBe('0.0.1')
    expect(body.hasUpdate).toBe(false)
  })

  it('falls back to latest=null when the registry returns non-200', async () => {
    mockRegistry(null, { status: 502 })
    const handler = buildHandler()
    const res = await get(handler, LOOPBACK_HOST)
    const body = await res.json()
    expect(body.latest).toBeNull()
    expect(body.hasUpdate).toBe(false)
  })

  it('falls back to latest=null when the registry fetch throws', async () => {
    mockRegistry(null, { throws: true })
    const handler = buildHandler()
    const res = await get(handler, LOOPBACK_HOST)
    const body = await res.json()
    expect(body.latest).toBeNull()
    expect(body.hasUpdate).toBe(false)
  })

  it('honours GRAVEL_VERSION_CHECK_DISABLED=1 (no registry hit, latest=null)', async () => {
    process.env.GRAVEL_VERSION_CHECK_DISABLED = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = buildHandler()
    const res = await get(handler, LOOPBACK_HOST)
    expect(fetchSpy).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.latest).toBeNull()
    expect(body.hasUpdate).toBe(false)
  })

  it('rejects unauthed non-localhost callers with 401 (no version leak)', async () => {
    mockRegistry('99.0.0')
    const handler = buildHandler()
    const res = await get(handler, PROD_HOST)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string; current?: string }
    // The 401 body MUST NOT carry version info — only authenticated
    // admins on the host get to see it.
    expect(body.current).toBeUndefined()
    expect(body.error).toBe('unauthorized')
  })
})
