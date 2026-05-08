/**
 * DB pre-flight for the install wizard. Tries to open a connection
 * against `DATABASE_URL` and runs a trivial query so we can confirm
 * the connection works *before* asking the user "create tables?" — a
 * "yes" to that question shouldn't surface as an authentication error
 * on the next line. If it can't connect, the wizard offers a clean
 * skip instead of a hard blocker.
 *
 * Also detects placeholder-shaped URLs (postgres://user:password@…,
 * unset env, etc.) so we can warn before even attempting a connection.
 */
import { config as loadEnv } from './load-env.js'
import { openDatabase } from '../db/index.js'

export type DbProbeResult =
  | { kind: 'ok'; url: string; dialect: 'postgres' | 'sqlite' }
  | { kind: 'no-url' }
  | { kind: 'placeholder'; url: string }
  | { kind: 'connect-failed'; url: string; reason: 'auth' | 'host' | 'other'; message: string }

/**
 * Heuristic: does the URL look like a default/placeholder rather than
 * a real connection string? Common shapes the wizard's own
 * gravel.config.ts emits, plus the more notorious tutorial defaults.
 */
export function looksLikePlaceholder(url: string): boolean {
  const placeholders = [
    /\/\/user:password@/i,
    /\/\/postgres:postgres@/i,
    /\/\/myuser:mypassword@/i,
    /\/\/USER:PASS@/i,
    /\/\/<.*?>:<.*?>@/i, // ${...} or <user>:<pass>@
    /YOUR_PASSWORD/i,
    /<password>/i,
  ]
  return placeholders.some((re) => re.test(url))
}

export async function probeDatabase(cwd: string): Promise<DbProbeResult> {
  const env = await loadEnv(cwd)
  const url = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.NEON_DATABASE_URL
  if (!url) return { kind: 'no-url' }
  if (looksLikePlaceholder(url)) return { kind: 'placeholder', url }

  let dialect: 'postgres' | 'sqlite'
  try {
    const { detectDialect } = await import('../db/index.js')
    dialect = detectDialect(url)
  } catch (e) {
    return { kind: 'connect-failed', url, reason: 'other', message: (e as Error).message }
  }

  try {
    const db = await openDatabase({ url })
    try {
      // Trivial round-trip — we don't care about the shape, just that
      // the connection authenticates and the query layer responds.
      await db.exec('SELECT 1')
    } finally {
      await db.close()
    }
    return { kind: 'ok', url, dialect }
  } catch (e) {
    const msg = (e as Error).message
    let reason: 'auth' | 'host' | 'other' = 'other'
    if (
      /password authentication failed/i.test(msg) ||
      /authentication/i.test(msg) ||
      /role .* does not exist/i.test(msg)
    ) {
      reason = 'auth'
    } else if (
      /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|ENOTFOUND/i.test(msg)
    ) {
      reason = 'host'
    }
    return { kind: 'connect-failed', url, reason, message: msg }
  }
}
