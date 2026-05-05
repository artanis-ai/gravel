/**
 * Migration runner. Applies pending drizzle-kit migrations from
 * `migrations/postgres` or `migrations/sqlite` based on the detected dialect.
 *
 * Spec: gravel-cloud/docs/spec/data-model.md §3.4
 *
 * Policy:
 *   - Dev (NODE_ENV != 'production'): auto-applies pending migrations on app
 *     boot, with a console notice. Disable via GRAVEL_DISABLE_AUTO_MIGRATE=1.
 *   - Prod: refuses to apply automatically; surfaces an error directing the
 *     user to run `npx @artanis-ai/gravel migrate` as a deploy step.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface MigrateOptions {
  /** When true, throw on pending migrations instead of applying. */
  dryRun?: boolean
}

export function migrationsDir(dialect: 'postgres' | 'sqlite'): string {
  // Migrations live alongside the published package. During dev (running from
  // src/), look up two levels to packages/sdk-ts/migrations/. After bundling,
  // dist/ is one level inside packages/sdk-ts/, so the same up-two works.
  return resolve(__dirname, '../../migrations', dialect)
}

export async function migrate(db: Database, _opts: MigrateOptions = {}): Promise<void> {
  if (db.dialect === 'postgres') {
    const { migrate: pgMigrate } = await import('drizzle-orm/node-postgres/migrator')
    await pgMigrate(db.drizzle as any, { migrationsFolder: migrationsDir('postgres') })
    return
  }
  const { migrate: sqliteMigrate } = await import('drizzle-orm/better-sqlite3/migrator')
  await sqliteMigrate(db.drizzle as any, { migrationsFolder: migrationsDir('sqlite') })
}

export function shouldAutoMigrate(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GRAVEL_DISABLE_AUTO_MIGRATE === '1') return false
  if (env.NODE_ENV === 'production') return false
  return true
}
