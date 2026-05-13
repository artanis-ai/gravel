/**
 * Lightweight HMAC-signed session for default-password mode.
 *
 * We deliberately do NOT use a JWT library here — keeps zero deps. The cookie
 * is just `<base64url(payload)>.<base64url(hmac-sha256(payload))>`.
 *
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'gravel_session'
export const VIEW_AS_COOKIE = 'gravel_view_as'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface SessionPayload {
  exp: number // unix ms
  nonce: string
}

function deriveSecret(password: string): Buffer {
  // The session secret is derived from the password so rotating the password
  // invalidates all sessions automatically. A separate GRAVEL_SESSION_SECRET
  // env var can override this in v1+.
  return createHmac('sha256', password).update('gravel-session-v1').digest()
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Buffer.from(s, 'base64')
}

export function signSession(password: string, ttlMs: number = SESSION_TTL_MS): string {
  const payload: SessionPayload = {
    exp: Date.now() + ttlMs,
    nonce: randomBytes(8).toString('hex'),
  }
  const secret = deriveSecret(password)
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)))
  const sig = createHmac('sha256', secret).update(payloadB64).digest()
  return `${payloadB64}.${base64url(sig)}`
}

export async function verifySession(cookie: string, password: string): Promise<boolean> {
  const parts = cookie.split('.')
  if (parts.length !== 2) return false
  const [payloadB64, sigB64] = parts as [string, string]

  const secret = deriveSecret(password)
  const expected = createHmac('sha256', secret).update(payloadB64).digest()
  const provided = fromBase64url(sigB64)
  if (provided.length !== expected.length) return false
  if (!timingSafeEqual(expected, provided)) return false

  try {
    const payload = JSON.parse(fromBase64url(payloadB64).toString('utf8')) as SessionPayload
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false
    return true
  } catch {
    return false
  }
}

export function verifyPassword(input: string, expected: string): boolean {
  if (input.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(input), Buffer.from(expected))
}
