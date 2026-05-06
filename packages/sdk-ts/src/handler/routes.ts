/**
 * Internal HTTP route table. Maps `(method, path)` to handlers.
 *
 * Most handlers are stubbed for v0; the real implementations land alongside
 * the dashboard wiring. Keeping the routing surface defined now means the
 * dashboard can be developed against a stable contract.
 *
 * Spec: gravel-cloud/docs/spec/api-surface.md §5
 */
import type { GravelRequest, GravelUser, ResolvedGravelConfig } from '../types.js'
import type { Database } from '../db/index.js'
import { json } from './index.js'
import {
  signSession,
  verifyPassword,
  SESSION_COOKIE,
  VIEW_AS_COOKIE,
} from '../auth/session.js'
import { attemptLogin, recordSuccess } from '../auth/rate-limit.js'

interface RouteCtx {
  config: ResolvedGravelConfig
  db: Database
  request: Request
  grRequest: GravelRequest
  path: string
  authed: GravelUser | null
}

export async function route(ctx: RouteCtx): Promise<Response> {
  const key = `${ctx.request.method} ${matchPath(ctx.path)}`
  const handler = ROUTES[key]
  if (!handler) return json({ error: 'not-found', path: ctx.path }, 404)
  return await handler(ctx)
}

function matchPath(path: string): string {
  // Normalize :id-style segments for routing.
  return path
    .replace(/\/[a-f0-9-]{8,}(\/|$)/g, '/:id$1')
    .replace(/\/$/, '') || '/'
}

const ROUTES: Record<string, (ctx: RouteCtx) => Promise<Response>> = {
  // Auth
  'GET /api/auth/me': async ({ authed, config }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    return json({
      user: authed,
      productName: config.productName,
      mountPath: config.mountPath,
      hideArtanisBranding: config.hideArtanisBranding,
    })
  },
  'POST /api/auth/login': async ({ request, config, grRequest }) => {
    if (!config.auth.defaultPassword) {
      return json({ error: 'password mode not configured' }, 400)
    }
    // Body parsing: form-encoded (login form) or JSON.
    const ctype = request.headers.get('content-type') ?? ''
    let password = ''
    if (ctype.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData()
      password = String(form.get('password') ?? '')
    } else {
      try {
        const body = (await request.json()) as { password?: unknown }
        password = typeof body.password === 'string' ? body.password : ''
      } catch {
        password = ''
      }
    }
    const ip = clientIp(grRequest)
    const rate = attemptLogin(ip)
    if (!rate.allowed) {
      return new Response(
        JSON.stringify({
          error: 'too many attempts',
          retry_after_ms: rate.retryAfterMs ?? 60_000,
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    if (!password || !verifyPassword(password, config.auth.defaultPassword)) {
      // Form-driven flow: bounce back to /login. JSON-driven: 401.
      const isForm = ctype.includes('application/x-www-form-urlencoded')
      if (isForm) {
        return new Response(null, {
          status: 303,
          headers: { location: `${config.mountPath}/login?error=1` },
        })
      }
      return json({ error: 'invalid password' }, 401)
    }
    recordSuccess(ip)
    const cookie = signSession(config.auth.defaultPassword)
    const headers = new Headers({ 'set-cookie': sessionCookieValue(cookie, request.url) })
    const isForm = ctype.includes('application/x-www-form-urlencoded')
    if (isForm) {
      headers.set('location', config.mountPath || '/')
      return new Response(null, { status: 303, headers })
    }
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
  },
  'POST /api/auth/logout': async ({ request, config }) => {
    const headers = new Headers({ 'set-cookie': sessionCookieClearValue(request.url) })
    headers.set('location', `${config.mountPath}/login`)
    return new Response(null, { status: 303, headers })
  },
  'POST /api/auth/view-as': async ({ request, authed, config }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    if (authed.role !== 'admin') return json({ error: 'admin only' }, 403)
    let mode: string | null = null
    try {
      const body = (await request.json()) as { mode?: unknown }
      mode = typeof body.mode === 'string' ? body.mode : null
    } catch {
      // form-style: cookie cleared
    }
    const headers = new Headers({
      'content-type': 'application/json',
    })
    if (mode === 'user') {
      headers.set('set-cookie', viewAsCookieValue('user', request.url))
    } else {
      headers.set('set-cookie', viewAsCookieClearValue(request.url))
    }
    void config
    return new Response(JSON.stringify({ ok: true, view_as: mode === 'user' ? 'user' : null }), {
      status: 200,
      headers,
    })
  },

  // Prompts (v0 surface) — list + read implemented from the manifest;
  // edit + submit-as-PR pending (depends on dashboard wiring).
  'GET /api/prompts': async () => {
    const { readManifest } = await import('../manifest/io.js')
    const manifest = await readManifest(process.cwd())
    return json({ prompts: manifest.prompts, last_scan_at: manifest.lastFullScanAt })
  },
  'GET /api/prompts/:id': async ({ path }) => {
    const id = path.split('/').pop()
    if (!id) return json({ error: 'missing id' }, 400)
    const { readManifest } = await import('../manifest/io.js')
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const manifest = await readManifest(process.cwd())
    const entry = manifest.prompts.find((p) => p.id === id)
    if (!entry) return json({ error: 'not found' }, 404)

    const fullText = await fs.readFile(join(process.cwd(), entry.path), 'utf8')
    if (entry.type === 'file') {
      return json({ id: entry.id, type: entry.type, path: entry.path, content: fullText })
    }
    // Embedded: slice by char range.
    const content = fullText.slice(entry.charStart, entry.charEnd)
    return json({
      id: entry.id,
      type: entry.type,
      path: entry.path,
      varName: entry.varName,
      content,
    })
  },
  'PUT /api/prompts/:id': async () => json({ error: 'not-implemented', spec: 'spec/prompts.md §4 — pending dashboard wiring' }, 501),
  'POST /api/prompts/submit': async () => json({ error: 'not-implemented', spec: 'spec/prompts.md §5 — pending dashboard wiring' }, 501),

  // GitHub OAuth connection. Spec: gravel-cloud/docs/spec/prompts.md §6.
  'GET /api/github/status': async ({ db }) => {
    void db
    // BLOCKER: query gravel_users.extra for the calling user once the
    // connect-finalize handler stores the gh_token there.
    return json({ connected: false })
  },
  'GET /api/github/connect': async ({ request, config }) => {
    const apiKey = process.env.GRAVEL_API_KEY
    const projectId = process.env.GRAVEL_PROJECT_ID
    if (!apiKey || !projectId) {
      return json({ error: 'GRAVEL_API_KEY / GRAVEL_PROJECT_ID not set in .env' }, 500)
    }
    const { startConnectFlow } = await import('../github/index.js')
    const callbackUrl = new URL(`${config.mountPath}/api/github/callback`, request.url).toString()
    const { redirectUrl } = startConnectFlow({ apiKey, projectId, callbackUrl })
    return json({ redirectUrl })
  },
  'GET /api/github/callback': async ({ request }) => {
    const apiKey = process.env.GRAVEL_API_KEY
    if (!apiKey) return json({ error: 'GRAVEL_API_KEY not set' }, 500)
    const url = new URL(request.url)
    const jwt = url.searchParams.get('session')
    if (!jwt) return json({ error: 'missing session parameter' }, 400)
    try {
      const { finalizeConnectCallback } = await import('../github/index.js')
      const result = finalizeConnectCallback({ apiKey, jwt })
      // BLOCKER: persist result.ghAccessToken into gravel_users.extra for the
      // current user. Needs the auth-resolved user from the request + a
      // small schema slot. Lands alongside the dashboard-side prompt-submit
      // wiring.
      void result
      return json({ ok: true, blocker: 'gh_token persistence pending' })
    } catch (err) {
      return json({ error: (err as Error).message }, 400)
    }
  },

  // Traces (v1)
  'GET /api/traces': async () => json({ traces: [] }),
  'GET /api/traces/:id': async () => json({ error: 'not-implemented' }, 501),
  'POST /api/traces/:id/feedback': async () => json({ error: 'not-implemented' }, 501),

  // Datasets (v1)
  'GET /api/datasets': async () => json({ datasets: [] }),
  'POST /api/datasets': async () => json({ error: 'not-implemented' }, 501),
  'POST /api/datasets/:id/traces': async () => json({ error: 'not-implemented' }, 501),

  // Eval runs (v2)
  'GET /api/evals/runs': async () => json({ runs: [] }),
  'POST /api/evals/runs': async () => json({ error: 'not-implemented' }, 501),
  'GET /api/evals/runs/:id': async () => json({ error: 'not-implemented' }, 501),
  'POST /api/evals/runs/:id/cancel': async () => json({ error: 'not-implemented' }, 501),

  // Mallet analysis (v3 paid)
  'GET /api/analysis/:id': async () => json({ error: 'not-implemented' }, 501),

  // Billing — placeholder. v0/v1 have no paid surface; this returns the
  // free tier permanently. v2 will fetch from the control plane (the
  // judge dispatcher decrements credits there, not here).
  'GET /api/billing/credits': async () =>
    json({ tier: 'free', creditsRemaining: 0, paidSurfaceVersion: null }),
  'POST /api/billing/refresh': async () => json({ error: 'not-implemented' }, 501),

  // Dashboard SPA bootstrap
  'GET /': async ({ config }) =>
    new Response(htmlShell(config), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  'GET /login': async ({ config }) =>
    new Response(loginShell(config), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
}

function htmlShell(config: ResolvedGravelConfig): string {
  // BLOCKER: replace with the Vite-built dashboard's index.html, with
  // assets paths rewritten to mount-relative URLs.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escape(config.productName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; color: #2D1810; }
    code { background: #FFF7E8; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .badge { display: inline-block; background: #D4A76A; color: #2D1810; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  </style>
</head>
<body>
  <h1>${escape(config.productName)} <span class="badge">Skeleton</span></h1>
  <p>The dashboard SPA isn't bundled into this build yet.</p>
  <p>You're authenticated. The internal API is reachable at <code>${escape(config.mountPath)}/api/*</code>.</p>
  <p>Try: <code>${escape(config.mountPath)}/api/auth/me</code></p>
  <p style="color: #6B5744; font-size: 13px;">v0 build in progress — see <a href="https://github.com/artanis-ai/gravel">github.com/artanis-ai/gravel</a>.</p>
</body>
</html>`
}

function loginShell(config: ResolvedGravelConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sign in — ${escape(config.productName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 360px; margin: 8rem auto; padding: 0 1rem; color: #2D1810; }
    h1 { font-size: 1.4rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
    input { padding: 0.6rem 0.8rem; border: 1px solid #D4A76A; border-radius: 8px; font-size: 14px; }
    button { padding: 0.6rem 0.8rem; background: #9B4340; color: white; border: 0; border-radius: 8px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Sign in to ${escape(config.productName)}</h1>
  <form method="POST" action="${escape(config.mountPath)}/api/auth/login">
    <input type="password" name="password" placeholder="Admin password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`
}

// ---- Cookie + IP helpers ----

function isHttps(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function sessionCookieValue(value: string, requestUrl: string): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000', // 30 days
  ]
  if (isHttps(requestUrl)) parts.push('Secure')
  return parts.join('; ')
}

function sessionCookieClearValue(requestUrl: string): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (isHttps(requestUrl)) parts.push('Secure')
  return parts.join('; ')
}

function viewAsCookieValue(value: string, requestUrl: string): string {
  const parts = [
    `${VIEW_AS_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
  ]
  if (isHttps(requestUrl)) parts.push('Secure')
  return parts.join('; ')
}

function viewAsCookieClearValue(requestUrl: string): string {
  const parts = [
    `${VIEW_AS_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (isHttps(requestUrl)) parts.push('Secure')
  return parts.join('; ')
}

function clientIp(req: GravelRequest): string {
  // Best-effort IP — proxies usually set X-Forwarded-For.
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
