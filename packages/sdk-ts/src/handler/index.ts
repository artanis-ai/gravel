/**
 * The handler factory. Returns a fetch-style handler that the framework
 * adapters wrap. Every framework integration lowers down to this.
 *
 * Spec:
 *   gravel-cloud/docs/spec/api-surface.md §2 — mounting
 *   gravel-cloud/docs/spec/api-surface.md §5 — internal HTTP API
 */
import type { GravelConfig, GravelRequest, ResolvedGravelConfig } from '../types.js'
import { resolveConfig } from '../types.js'
import { authenticate } from '../auth/index.js'
import { openDatabase, type Database } from '../db/index.js'
import { setGravelTracingConfig } from '../tracing/persist.js'
import { route } from './routes.js'

export interface CreateHandlerOpts {
  config: GravelConfig
}

let cachedDb: Database | null = null
let cachedConfig: ResolvedGravelConfig | null = null
let dbOpenAttempted = false
let dbOpenError: Error | null = null

/**
 * Lazily open the customer's DB. Returns null when no DATABASE_URL is
 * set OR when the configured URL fails to open. This is by design:
 * customers who installed only the Prompts pillar (no traces) will
 * have no DB, and every request would otherwise 500 in `openDatabase`
 * before even reaching its route handler. Routes that need the DB
 * check for null and degrade gracefully (Outputs renders an empty
 * "set up traces" state, etc.).
 */
async function ensureDb(config: ResolvedGravelConfig): Promise<Database | null> {
  if (cachedDb) return cachedDb
  if (dbOpenAttempted) return null
  // Prompts-only install: the user's gravel.config.ts has no
  // `database` block on purpose. Don't probe, don't warn — just
  // return null and let DB-dependent routes degrade.
  if (config.database === null) return null
  dbOpenAttempted = true
  if (!config.database.url) return null
  try {
    cachedDb = await openDatabase(config.database)
    return cachedDb
  } catch (e) {
    dbOpenError = e as Error
    // eslint-disable-next-line no-console
    console.warn(
      `[gravel] could not open DB (${dbOpenError.message}). Outputs/feedback ` +
        `routes will report unavailable until DATABASE_URL is reachable.`,
    )
    return null
  }
}

/**
 * Returns a fetch-style handler `(Request) => Promise<Response>`. Framework
 * adapters convert their native request/response into web standards and
 * delegate here.
 */
export function createGravelHandler(opts: CreateHandlerOpts) {
  if (!cachedConfig) {
    cachedConfig = resolveConfig(opts.config)
    // Hand the resolved config to the tracing module so the auto-patches
    // (loaded via `import '@artanis-ai/gravel/auto'`) have a DB to write
    // their traces into. Without this they're lazily inert.
    setGravelTracingConfig(cachedConfig)
  }
  const config = cachedConfig

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const mountPath = config.mountPath.replace(/\/$/, '')
    const path = url.pathname.startsWith(mountPath)
      ? url.pathname.slice(mountPath.length) || '/'
      : url.pathname

    const grRequest: GravelRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      cookies: parseCookies(request.headers.get('cookie') ?? ''),
      raw: request,
    }

    // Public routes (login page, login POST) skip auth.
    if (path === '/login' || path.startsWith('/api/auth/login')) {
      const db = await ensureDb(config)
      return route({ config, db, request, grRequest, path, authed: null })
    }

    // Asset routes (the bundled dashboard JS/CSS) are public read-only.
    if (path.startsWith('/_assets/')) {
      const db = await ensureDb(config)
      return route({ config, db, request, grRequest, path, authed: null })
    }

    const auth = await authenticate(config, grRequest)
    if (auth.kind !== 'authed') {
      // For HTML routes: redirect to login (password mode) or return 401 (getUser mode).
      const isApi = path.startsWith('/api/')
      if (auth.kind === 'unauthed-getuser') {
        return isApi
          ? json({ error: 'unauthorized' }, 401)
          : new Response('Sign in via your app to access this dashboard.', { status: 401 })
      }
      // password mode → redirect to /login
      return isApi
        ? json({ error: 'unauthorized' }, 401)
        : redirect(`${mountPath}/login`)
    }

    const db = await ensureDb(config)
    return route({ config, db, request, grRequest, path, authed: auth.user })
  }
}

function parseCookies(header: string): GravelRequest['cookies'] {
  const map = new Map<string, string>()
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    map.set(name, decodeURIComponent(value))
  }
  return {
    get(name) {
      return map.get(name)
    },
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } })
}
