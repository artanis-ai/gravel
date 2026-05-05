/**
 * In-memory rate limit for default-password login attempts.
 *
 * 5 attempts per IP per minute, exponential backoff on lockout.
 * Per spec/auth.md §2 hardening.
 *
 * Process-local — sufficient for default-password mode (a single host),
 * inappropriate for distributed deployments. Users on serious traffic should
 * configure getUser instead.
 */
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5
const BASE_LOCKOUT_MS = 30_000

interface Bucket {
  attempts: number[] // timestamps
  lockedUntil: number
  consecutiveLockouts: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitOutcome {
  allowed: boolean
  retryAfterMs?: number
}

export function attemptLogin(ip: string): RateLimitOutcome {
  const now = Date.now()
  const bucket = buckets.get(ip) ?? {
    attempts: [],
    lockedUntil: 0,
    consecutiveLockouts: 0,
  }

  if (bucket.lockedUntil > now) {
    return { allowed: false, retryAfterMs: bucket.lockedUntil - now }
  }

  // Drop old attempts
  bucket.attempts = bucket.attempts.filter((t) => now - t < WINDOW_MS)

  if (bucket.attempts.length >= MAX_ATTEMPTS) {
    bucket.consecutiveLockouts += 1
    bucket.lockedUntil = now + BASE_LOCKOUT_MS * 2 ** (bucket.consecutiveLockouts - 1)
    bucket.attempts = []
    buckets.set(ip, bucket)
    return { allowed: false, retryAfterMs: bucket.lockedUntil - now }
  }

  bucket.attempts.push(now)
  buckets.set(ip, bucket)
  return { allowed: true }
}

export function recordSuccess(ip: string): void {
  buckets.delete(ip)
}
