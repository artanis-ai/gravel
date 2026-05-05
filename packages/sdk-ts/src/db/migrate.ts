/**
 * Migration runner. Uses drizzle-kit-generated SQL files under migrations/.
 *
 * Per data-model.md §3.4:
 *   - Dev: auto-migrates on app boot if there are pending migrations (warn).
 *   - Prod: refuses to start with pending migrations; user runs `gravel migrate`.
 *   - GRAVEL_DISABLE_AUTO_MIGRATE=1 turns off auto-migration in dev.
 *
 * BLOCKER: drizzle-kit-generated SQL files don't exist yet. The TS schema
 * compiles, but we haven't run `drizzle-kit generate` against it. To do during
 * v0 implementation. Tracking in gravel-cloud/docs/blockers.md §schema.
 */
import type { Database } from './index.js'

export interface MigrateOptions {
  /** When true, throw on pending migrations instead of applying. */
  dryRun?: boolean
}

export async function migrate(db: Database, _opts: MigrateOptions = {}): Promise<void> {
  // BLOCKER: implementation deferred until drizzle-kit migrations are generated.
  // For v0, this is invoked by the wizard at install time, but the wizard
  // currently runs a hardcoded CREATE TABLE script (src/db/bootstrap.ts) instead.
  // Replace with proper migration runner once drizzle-kit setup is finalized.
  void db
  throw new Error('[gravel] Migration runner not implemented yet. v0 uses bootstrap.ts.')
}

export function shouldAutoMigrate(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GRAVEL_DISABLE_AUTO_MIGRATE === '1') return false
  if (env.NODE_ENV === 'production') return false
  return true
}
