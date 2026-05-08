/**
 * End-to-end-style tests for the dashboard's runtime: spin up
 * `createGravelHandler`, drive it with sequences of requests the way
 * a browser would, assert what comes back. These tests are the gap
 * between the unit tests (which check route handlers in isolation)
 * and a real Playwright run (which we don't ship in this repo).
 *
 * Two scenarios:
 *   1. **Login flow over a non-localhost host** — defaultPassword
 *      mode. POSTing the right password sets a session cookie; the
 *      next request that carries that cookie is recognised as
 *      authed; the wrong password bounces to /login?error=1; logging
 *      out clears the cookie. Catches anything that breaks the
 *      sign / verify / cookie-parse pipeline.
 *   2. **With-DB Outputs flow** — open SQLite, run the bootstrap,
 *      seed a sample, then GET /api/samples and assert it comes
 *      back. Exercises the real query layer end-to-end so a SQL
 *      regression in `samples/query.ts` won't slip through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetHandlerForTests, createGravelHandler } from '../src/handler/index.js'
import { _resetGravelTracingForTests } from '../src/tracing/persist.js'
import { openDatabase } from '../src/db/index.js'
import { bootstrap } from '../src/db/bootstrap.js'

beforeEach(() => {
  // Module-level handler state is reset between tests so each builds
  // its own config + DB connection. Mirrors what a fresh
  // `createGravelHandler` call would see in a real request.
  _resetHandlerForTests()
  _resetGravelTracingForTests()
})

const PASSWORD = 'pa55w0rd-test-session-flow'

// Use a non-localhost host so the localhost-admin gate doesn't take
// over. We want to exercise the actual cookie-based session flow.
const PROD_HOST = 'app.example.com'

function buildPasswordHandler() {
  return createGravelHandler({
    config: {
      mountPath: '/admin/ai',
      auth: { defaultPassword: PASSWORD },
      // Off, so the gate doesn't shortcut on localhost host headers.
      localhostIsAdmin: false,
    },
  })
}

async function send(
  handler: ReturnType<typeof buildPasswordHandler>,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    host: init.headers?.host ?? PROD_HOST,
    ...(init.headers ?? {}),
  }
  if (init.cookie) headers.cookie = init.cookie
  return await handler(
    new Request(`http://${PROD_HOST}${path}`, {
      method,
      headers,
      body: init.body,
    }),
  )
}

/**
 * Pull the session cookie value out of a `set-cookie` response
 * header, ready to send back as `Cookie:` on the next request. Web
 * Headers concatenates set-cookies with a comma — fine for our
 * single-cookie case. Keeps just the `name=value` pair (drops
 * Path/HttpOnly/etc).
 */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null
  const match = /(^|;\s*|,\s*)(gravel_session=[^;,]+)/.exec(setCookie)
  return match ? match[2]! : null
}

describe('dashboard flow: defaultPassword over a non-localhost host', () => {
  it('login + cookie + authed call: full happy path', async () => {
    const handler = buildPasswordHandler()

    // Step 1: unauthed GET to a protected API → 401.
    const unauthed = await send(handler, 'GET', '/admin/ai/api/auth/me')
    expect(unauthed.status).toBe(401)

    // Step 2: POST the right password, follow the cookie.
    const form = new URLSearchParams({ password: PASSWORD })
    const login = await send(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(login.status).toBe(303)
    // Trailing slash is intentional — see the route comment.
    expect(login.headers.get('location')).toBe('/admin/ai/')
    const cookie = extractSessionCookie(login.headers.get('set-cookie'))
    expect(cookie).not.toBeNull()

    // Step 3: same protected API now succeeds with the cookie.
    const authed = await send(handler, 'GET', '/admin/ai/api/auth/me', {
      cookie: cookie!,
    })
    expect(authed.status).toBe(200)
    const body = (await authed.json()) as { user: { firstName: string; role: string } }
    // Default-password mode tags users as `admin` with firstName 'Admin'.
    expect(body.user.role).toBe('admin')
  })

  it('wrong password → 303 to /login?error=1, no session cookie', async () => {
    const handler = buildPasswordHandler()
    const form = new URLSearchParams({ password: 'definitely-not-it' })
    const login = await send(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(login.status).toBe(303)
    expect(login.headers.get('location')).toContain('/login?error=1')
    expect(extractSessionCookie(login.headers.get('set-cookie'))).toBeNull()
  })

  it('logout clears the cookie + redirects to /login', async () => {
    const handler = buildPasswordHandler()
    const form = new URLSearchParams({ password: PASSWORD })
    const login = await send(handler, 'POST', '/admin/ai/api/auth/login', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    const cookie = extractSessionCookie(login.headers.get('set-cookie'))!

    const logout = await send(handler, 'POST', '/admin/ai/api/auth/logout', {
      cookie,
    })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toContain('/login')
    // Logout sets a Max-Age=0 cookie to expire the session.
    const cleared = logout.headers.get('set-cookie') ?? ''
    expect(cleared).toMatch(/gravel_session=;/)
    expect(cleared).toMatch(/Max-Age=0/)
  })

  it('unauthed HTML route redirects to /login (not 401)', async () => {
    const handler = buildPasswordHandler()
    const r = await send(handler, 'GET', '/admin/ai/')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toContain('/login')
  })

  it('login asset routes are public (CSS/JS load without a cookie)', async () => {
    const handler = buildPasswordHandler()
    const r = await send(handler, 'GET', '/admin/ai/login')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/^text\/html/)
  })
})

describe('dashboard flow: with a real SQLite database', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gravel-dash-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  function buildHandlerWithDb(dbPath: string) {
    return createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        database: { url: `file:${dbPath}` },
        auth: { defaultPassword: PASSWORD },
        localhostIsAdmin: true,
      },
    })
  }

  it('GET /api/samples returns rows we wrote via the bootstrap + insert path', async () => {
    const dbPath = join(workdir, 'gravel.db')
    // Bootstrap directly (the wizard would do this; we do it inline so
    // the test is self-contained and not coupled to the wizard).
    const db = await openDatabase({ url: `file:${dbPath}` })
    await bootstrap(db)
    // Hand-insert a sample so we have something to query back.
    const drz = db.drizzle as { run: (q: unknown) => unknown }
    const { sql } = await import('drizzle-orm')
    drz.run(
      sql`INSERT INTO gravel_samples (id, name, status, environment, model, timestamp, started_at)
          VALUES ('sample_e2e1', 'openai.chat.completions.create', 'completed', 'prod', 'gpt-4o-mini', ${Date.now()}, ${Date.now() - 100})`,
    )
    await db.close()

    const handler = buildHandlerWithDb(dbPath)
    const headers = { host: 'localhost:3000' } // localhost-admin shortcut
    const r = await handler(
      new Request('http://localhost:3000/admin/ai/api/samples', {
        method: 'GET',
        headers,
      }),
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      samples: Array<{ id: string; name: string; status: string }>
    }
    expect(body.samples).toHaveLength(1)
    expect(body.samples[0]).toMatchObject({
      id: 'sample_e2e1',
      name: 'openai.chat.completions.create',
      status: 'completed',
    })
  })

  it('GET /api/onboarding/status surfaces the real sample count', async () => {
    const dbPath = join(workdir, 'gravel.db')
    const db = await openDatabase({ url: `file:${dbPath}` })
    await bootstrap(db)
    const drz = db.drizzle as { run: (q: unknown) => unknown }
    const { sql } = await import('drizzle-orm')
    for (const id of ['s1', 's2', 's3']) {
      drz.run(
        sql`INSERT INTO gravel_samples (id, name, status, environment, model, timestamp, started_at)
            VALUES (${id}, 'fn', 'completed', 'prod', 'm', ${Date.now()}, ${Date.now()})`,
      )
    }
    await db.close()

    const handler = buildHandlerWithDb(dbPath)
    const r = await handler(
      new Request('http://localhost:3000/admin/ai/api/onboarding/status', {
        headers: { host: 'localhost:3000' },
      }),
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      traces: { tablesExist: boolean; sampleCount: number }
    }
    expect(body.traces.tablesExist).toBe(true)
    expect(body.traces.sampleCount).toBe(3)
  })
})
