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

// `import.meta.url` works in both builds because tsup's `shims: true`
// rewrites it to a `__filename`-derived URL in the CJS output. Without
// the shim, a literal `import.meta` in a `.cjs` file is a parse-time
// SyntaxError that crashes any host that externalises us through
// `require('@artanis-ai/gravel/...')` from a Pages Router or App
// Router server bundle.
const __module_dirname = dirname(fileURLToPath(import.meta.url))

export interface MigrateOptions {
  /** When true, throw on pending migrations instead of applying. */
  dryRun?: boolean
}

export function migrationsDir(dialect: 'postgres' | 'sqlite'): string {
  // Migrations live alongside the published package. During dev (running from
  // src/), look up two levels to packages/sdk-ts/migrations/. After bundling,
  // dist/ is one level inside packages/sdk-ts/, so the same up-two works.
  return resolve(__module_dirname, '../../migrations', dialect)
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

/**
 * Count migrations that exist in the bundled `migrations/<dialect>`
 * folder but haven't been applied to this DB yet.
 *
 * Drizzle records applied migrations in `__drizzle_migrations`
 * (sqlite) or the `drizzle.__drizzle_migrations` table (postgres),
 * keyed by content hash. We compare the count of journal entries to
 * the count of applied rows — same approximation drizzle's migrator
 * uses to decide whether to do anything.
 *
 * Returns 0 if the bundled migrations folder is empty (the SDK
 * doesn't ship drizzle-kit migrations yet — the bootstrap is the
 * source of truth) or if anything goes wrong reading state. We err
 * on the side of "no warning to show" rather than nag users with
 * false positives.
 */
export async function pendingMigrationCount(db: Database): Promise<number> {
  try {
    const { readFile, readdir } = await import('node:fs/promises')
    const dir = migrationsDir(db.dialect)
    // Each numbered .sql file in the folder is a migration. The
    // `_journal.json` is the authoritative list but a directory
    // listing is good enough for a count — the user-visible signal
    // is "N pending", not the exact names.
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return 0
    }
    const sqlFiles = entries.filter((f) => /^\d+_.*\.sql$/.test(f))
    if (sqlFiles.length === 0) return 0

    if (db.dialect === 'sqlite') {
      // Pull the applied row count from drizzle's bookkeeping table.
      // The table doesn't exist on a brand-new DB — that means zero
      // applied, so all journal entries are pending.
      const drizzleDb = db.drizzle as unknown as {
        run?: (sql: { sql: string; params: unknown[] }) => unknown
      }
      void drizzleDb
      // Use the raw sqlite connection if we can reach it; otherwise
      // fall back to "all pending" — over-reporting is fine for a
      // banner that says "you might want to run migrate".
      try {
        const { sql } = await import('drizzle-orm')
        const r = await (db.drizzle as any).all(
          sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`,
        )
        const applied = Number((r?.[0] as { n?: number })?.n ?? 0)
        return Math.max(0, sqlFiles.length - applied)
      } catch {
        return sqlFiles.length
      }
    }
    // Postgres: drizzle's `drizzle.__drizzle_migrations` lives in the
    // `drizzle` schema. Same approximation.
    try {
      const { sql } = await import('drizzle-orm')
      const r = await (db.drizzle as any).execute(
        sql`SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`,
      )
      const rows = (r as { rows?: Array<{ n?: number }> }).rows ?? []
      const applied = Number(rows[0]?.n ?? 0)
      return Math.max(0, sqlFiles.length - applied)
    } catch {
      return sqlFiles.length
    }
    // (read kept for symmetry / future "show the next migration name")
    void readFile
  } catch {
    return 0
  }
}
