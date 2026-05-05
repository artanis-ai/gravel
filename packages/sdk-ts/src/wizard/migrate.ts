/**
 * Wizard wraps the schema bootstrap. Reads DATABASE_URL from env and runs
 * the idempotent CREATE TABLE script.
 */
import { config as loadEnv } from './load-env.js'
import { openDatabase } from '../db/index.js'
import { bootstrap } from '../db/bootstrap.js'

export async function runBootstrap(cwd: string): Promise<void> {
  const env = await loadEnv(cwd)
  const url = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.NEON_DATABASE_URL
  if (!url) {
    throw new Error(
      '[gravel] No DATABASE_URL detected. Set it in .env.local and re-run `npx @artanis/gravel migrate`.',
    )
  }
  const db = await openDatabase({ url })
  try {
    await bootstrap(db)
  } finally {
    await db.close()
  }
}
