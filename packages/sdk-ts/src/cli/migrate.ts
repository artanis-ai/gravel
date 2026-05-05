/**
 * `gravel migrate` — applies pending drizzle-kit migrations.
 *
 * Falls back to the idempotent bootstrap.ts CREATE-TABLE-IF-NOT-EXISTS path
 * when migrations haven't been generated yet (early v0). Once `drizzle-kit
 * generate` has been run and the migration files are checked in, the runner
 * uses them and the bootstrap fallback is skipped.
 */
import { existsSync } from 'node:fs'
import { config as loadEnv } from '../wizard/load-env.js'
import { openDatabase } from '../db/index.js'
import { migrate, migrationsDir } from '../db/migrate.js'
import { bootstrap } from '../db/bootstrap.js'

export async function runMigrate(): Promise<void> {
  const env = await loadEnv(process.cwd())
  const url = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.NEON_DATABASE_URL
  if (!url) {
    console.error('[gravel] No DATABASE_URL detected. Set it in .env.local and re-run.')
    process.exit(1)
  }
  const db = await openDatabase({ url })
  try {
    if (existsSync(migrationsDir(db.dialect))) {
      await migrate(db)
      console.log(`Applied pending ${db.dialect} migrations.`)
    } else {
      // Migrations not generated yet — fall back to bootstrap (CREATE TABLE
      // IF NOT EXISTS path). Logged so users know the proper migration set
      // hasn't been generated.
      console.log('[gravel] Drizzle-kit migrations not present; running bootstrap fallback.')
      await bootstrap(db)
      console.log('Schema bootstrap complete.')
    }
  } finally {
    await db.close()
  }
}
