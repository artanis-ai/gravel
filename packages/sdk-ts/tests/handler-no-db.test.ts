/**
 * Integration tests for the prompts-only install path: a
 * `createGravelHandler` instance with NO `database` block in its
 * config must not 500 on any request, ever.
 *
 * Regression-protects the May 2026 incident where `ensureDb` eagerly
 * called `openDatabase({ url: undefined })` on every request — the
 * login POST itself doesn't need a DB but it crashed there before
 * even reaching its handler. The customer hit the wizard's
 * prompts-only path, set their password, hit submit, and got 500.
 *
 * The unit-style wizard tests caught nothing: they checked the
 * generated env file + manifest + summary object, never the actual
 * runtime handler. So this test mounts the handler exactly the way
 * the customer's app would and exercises the routes that are
 * supposed to work in prompts-only mode.
 */
import { describe, it, expect } from 'vitest'
import { createGravelHandler } from '../src/handler/index.js'

const PASSWORD = 'test-pass-1234567890abcdef'

function buildHandler() {
  // No `database` block — exactly what `gravel init --prompts`
  // (or the wizard with traces declined) emits.
  return createGravelHandler({
    config: {
      mountPath: '/admin/ai',
      auth: { defaultPassword: PASSWORD },
    },
  })
}

async function request(
  handler: ReturnType<typeof buildHandler>,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  // Web `Request` doesn't auto-populate `Host` (the HTTP client sets
  // it at send-time, not at construction). The auth gate uses Host to
  // decide whether to take the localhost-admin shortcut, so set it
  // explicitly — this is exactly what a real Next.js / Express adapter
  // would forward in production.
  const headers: Record<string, string> = {
    host: 'localhost:3000',
    ...(init.headers ?? {}),
  }
  return await handler(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: init.body,
    }),
  )
}

describe('handler with no database (prompts-only install)', () => {
  it('login POST with the right password returns 303, not 500', async () => {
    const handler = buildHandler()
    const form = new URLSearchParams({ password: PASSWORD })
    const response = await request(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(response.status).toBe(303)
    // Cookie must be set even without a DB.
    expect(response.headers.get('set-cookie')).toMatch(/^gravel_session=/)
  })

  it('login POST with the wrong password returns 303 to /login?error=1, not 500', async () => {
    const handler = buildHandler()
    const form = new URLSearchParams({ password: 'wrong' })
    const response = await request(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/login?error=1')
  })

  it('GET /api/samples returns an empty page with onboarding hint, not 500', async () => {
    const handler = buildHandler()
    // Authed via the localhost shortcut — request is from 127.0.0.1.
    const response = await request(handler, 'GET', '/admin/ai/api/samples')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { samples: unknown[]; _onboarding?: { tablesExist: boolean; dbConfigured: boolean } }
    expect(body.samples).toEqual([])
    expect(body._onboarding).toEqual({ tablesExist: false, dbConfigured: false })
  })

  it('GET /api/onboarding/status reports tracesExist=false without crashing', async () => {
    const handler = buildHandler()
    const response = await request(handler, 'GET', '/admin/ai/api/onboarding/status')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { traces: { tablesExist: boolean; sampleCount: number } }
    expect(body.traces.tablesExist).toBe(false)
    expect(body.traces.sampleCount).toBe(0)
  })

  it('GET /api/auth/me returns the localhost admin without touching a DB', async () => {
    const handler = buildHandler()
    const response = await request(handler, 'GET', '/admin/ai/api/auth/me')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: { id: string; role: string } }
    expect(body.user.id).toBe('localhost')
    expect(body.user.role).toBe('admin')
  })

  it('POST /api/samples/:id/feedback returns 503 (not 500) when the DB is absent', async () => {
    const handler = buildHandler()
    // Sample IDs are UUID-shaped or `prefix_hex`. The route matcher
    // collapses both to `/:id` — give it a real-looking UUID so the
    // route table actually matches.
    const response = await request(handler, 'POST', '/admin/ai/api/samples/abcdef0123456789abcdef0123456789/feedback', {
      body: JSON.stringify({ score: 'positive' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('tables-missing')
  })

  it('GET / (dashboard SPA shell) renders without a DB', async () => {
    const handler = buildHandler()
    const response = await request(handler, 'GET', '/admin/ai/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
  })
})
