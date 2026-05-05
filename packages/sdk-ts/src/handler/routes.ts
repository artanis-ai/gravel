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
  'POST /api/auth/login': async () => {
    // BLOCKER: implement password login + session cookie issuance.
    // Spec: auth.md §2.2.
    return json({ error: 'not-implemented' }, 501)
  },
  'POST /api/auth/logout': async () => {
    // BLOCKER: clear session cookie.
    return json({ error: 'not-implemented' }, 501)
  },
  'POST /api/auth/view-as': async () => {
    // BLOCKER: set/clear gravel_view_as cookie.
    return json({ error: 'not-implemented' }, 501)
  },

  // Prompts (v0 surface)
  'GET /api/prompts': async () => json({ prompts: [], BLOCKER: 'wire to gravel_prompts' }),
  'GET /api/prompts/:id': async () => json({ error: 'not-implemented' }, 501),
  'PUT /api/prompts/:id': async () => json({ error: 'not-implemented' }, 501),
  'POST /api/prompts/submit': async () => json({ error: 'not-implemented' }, 501),

  // GitHub App connection (v0 surface)
  'GET /api/github/status': async () => json({ connected: false }),
  'GET /api/github/connect': async () => json({ error: 'not-implemented' }, 501),

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

  // Billing
  'GET /api/billing/credits': async ({ db }) => {
    void db
    return json({ tier: 'free', creditsRemaining: 0, BLOCKER: 'fetch from gravel_projects' })
  },
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

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
