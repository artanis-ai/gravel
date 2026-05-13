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
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetHandlerForTests, createGravelHandler } from '../src/handler/index.js'
import { _resetGravelTracingForTests } from '../src/tracing/persist.js'

beforeEach(() => {
  _resetHandlerForTests()
  _resetGravelTracingForTests()
})

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

  it('GET /api/samples returns an empty page, not 500, when DB is not configured', async () => {
    const handler = buildHandler()
    // Authed via the localhost shortcut — request is from 127.0.0.1.
    const response = await request(handler, 'GET', '/admin/ai/api/samples')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { samples: unknown[]; total: number }
    expect(body.samples).toEqual([])
    expect(body.total).toBe(0)
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

  it('GET /api/samples returns 401 from a non-loopback host with no cookie', async () => {
    // REGRESSION (v0.5.11 audit): TS routes used to accept unauthed
    // GET /api/samples and return the data, while Python returned
    // 401. Leaked every traced LLM call on the host to anyone with
    // the dashboard URL. Pin the gate explicitly with a non-loopback
    // Host so the localhost-admin shortcut doesn't paper over it.
    const handler = buildHandler()
    const response = await handler(
      new Request('https://acme.example.com/admin/ai/api/samples', {
        method: 'GET',
        headers: { host: 'acme.example.com' },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('GET /api/prompts returns 401 from a non-loopback host with no cookie', async () => {
    // Same regression as above for the prompts list. Leaked the
    // customer's prompt manifest + 280-char preview per prompt to
    // unauthenticated callers.
    const handler = buildHandler()
    const response = await handler(
      new Request('https://acme.example.com/admin/ai/api/prompts', {
        method: 'GET',
        headers: { host: 'acme.example.com' },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('GET /api/github/status returns 401 from a non-loopback host with no cookie', async () => {
    // Same regression: leaked repoOwner + repoName to anonymous
    // callers. The Python handler already enforced auth here.
    const handler = buildHandler()
    const response = await handler(
      new Request('https://acme.example.com/admin/ai/api/github/status', {
        method: 'GET',
        headers: { host: 'acme.example.com' },
      }),
    )
    expect(response.status).toBe(401)
  })
})

describe('handler with an UNREACHABLE database (bad URL in config)', () => {
  // Mirrors the customer scenario where the wizard was run before the
  // optional-database fix landed: `gravel.config.ts` has a `database`
  // block but DATABASE_URL points at a Postgres that isn't actually
  // running. `pg.Pool` doesn't attempt the connection until the first
  // query, so opening the pool succeeds — the question is whether
  // routes that DON'T need the DB (login!) still work.
  function buildBadUrlHandler() {
    return createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        // Picked from the fixtures' tracked .env — placeholder shape,
        // no real Postgres listening.
        database: { url: 'postgres://user:pass@localhost:5432/test_app' },
        auth: { defaultPassword: PASSWORD },
      },
    })
  }

  it('login POST still 303s — does NOT 500 because the DB is unreachable', async () => {
    const handler = buildBadUrlHandler()
    const form = new URLSearchParams({ password: PASSWORD })
    const response = await request(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toMatch(/^gravel_session=/)
  })

  it('login POST is fast — does not block on a 30s pg connect timeout', async () => {
    const handler = buildBadUrlHandler()
    const form = new URLSearchParams({ password: PASSWORD })
    const start = Date.now()
    await request(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    const elapsed = Date.now() - start
    // Login shouldn't even touch the DB; if it did and the DB was
    // unreachable, we'd see ~30s here. Guard with a generous 1s.
    expect(elapsed).toBeLessThan(1000)
  })
})
