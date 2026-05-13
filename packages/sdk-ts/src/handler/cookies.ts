/**
 * Cookie + request helpers shared across the route table.
 *
 * Pulled out of routes.ts in v0.5.12 so each per-domain route file
 * can import just the cookie shape it needs without dragging the
 * dispatch table along. The Python `_handler.py` already keeps
 * cookies isolated this way; this brings parity to the file layout.
 */
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  VIEW_AS_COOKIE,
} from '../auth/session.js'
import type { GravelRequest } from '../types.js'

/**
 * Detect HTTPS from a request URL so we can set the cookie `Secure`
 * flag conditionally. Browsers reject `Secure` cookies issued over
 * plain http, so always-setting would break local dev (Next.js
 * defaults to http on `next dev`).
 */
export function isHttps(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === 'https:'
  } catch {
    return false
  }
}

function buildCookie(
  name: string,
  value: string,
  requestUrl: string,
  maxAge: number,
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (isHttps(requestUrl)) parts.push('Secure')
  return parts.join('; ')
}

const SESSION_TTL_S = Math.floor(SESSION_TTL_MS / 1000)

export function sessionCookieValue(value: string, requestUrl: string): string {
  return buildCookie(SESSION_COOKIE, value, requestUrl, SESSION_TTL_S)
}

export function sessionCookieClearValue(requestUrl: string): string {
  return buildCookie(SESSION_COOKIE, '', requestUrl, 0)
}

export function viewAsCookieValue(value: string, requestUrl: string): string {
  return buildCookie(VIEW_AS_COOKIE, value, requestUrl, SESSION_TTL_S)
}

export function viewAsCookieClearValue(requestUrl: string): string {
  return buildCookie(VIEW_AS_COOKIE, '', requestUrl, 0)
}

/**
 * Best-effort client IP from proxy headers. Used by the auth
 * rate-limiter — bucket key is per-IP so a bug here lets a single
 * attacker exhaust the global lockout pool.
 */
export function clientIp(req: GravelRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}
