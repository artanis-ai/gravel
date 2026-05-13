/**
 * DB connector. Picks Postgres or SQLite based on DATABASE_URL.
 *
 * Both flavours present an identical `Database` interface to the rest of
 * the SDK so callers don't care which engine is in use.
 *
 */
import type { GravelDatabaseConfig } from '../types.js'

export type DatabaseDialect = 'postgres' | 'sqlite'

export interface Database {
  dialect: DatabaseDialect
  /** Drizzle instance, typed loosely here so we don't pull both flavours' types. */
  drizzle: unknown
  /** Raw SQL execution for migrations + manual queries. */
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

/**
 * Lightweight probe: are the gravel_* tables present? Returns false on
 * any error (table missing, DB unreachable, etc). Callers use this to
 * short-circuit the Outputs UI when the user hasn't run
 * `gravel init --traces` yet.
 */
export async function gravelTablesExist(db: Database | null): Promise<boolean> {
  if (!db) return false
  try {
    const { sql } = await import('drizzle-orm')
    if (db.dialect === 'postgres') {
      const drz = db.drizzle as { execute: (q: unknown) => Promise<unknown> }
      // Use to_regclass instead of a SELECT against gravel_samples so we
      // don't poison the connection on missing-table errors.
      const result = (await drz.execute(
        sql`SELECT to_regclass('public.gravel_samples') AS t`,
      )) as { rows?: Array<{ t: string | null }> } | Array<{ t: string | null }>
      const rows = Array.isArray(result) ? result : (result.rows ?? [])
      return Boolean(rows[0] && rows[0].t)
    }
    // SQLite
    const drz = db.drizzle as { all: (q: unknown) => unknown[] }
    const rows = drz.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='gravel_samples'`,
    ) as Array<{ name: string }>
    return rows.length > 0
  } catch {
    return false
  }
}

export function detectDialect(url: string): DatabaseDialect {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return 'postgres'
  }
  if (url.startsWith('file:') || url.startsWith('sqlite:') || url.endsWith('.db') || url.endsWith('.sqlite')) {
    return 'sqlite'
  }
  throw new Error(
    `[gravel] Unsupported DATABASE_URL: ${url}. Use postgres:// or file:/sqlite: prefix.`,
  )
}

/**
 * Opens a connection for the given config. The actual driver imports are
 * lazy so users only pay for what they use.
 */
export async function openDatabase(config: GravelDatabaseConfig): Promise<Database> {
  const dialect = detectDialect(config.url)
  if (dialect === 'postgres') {
    return await openPostgres(config)
  }
  return await openSqlite(config)
}

async function openPostgres(config: GravelDatabaseConfig): Promise<Database> {
  // Lazy import — `pg` is a peer dep, optional.
  let pg: typeof import('pg')
  try {
    pg = await import('pg')
  } catch {
    throw new Error(
      "[gravel] Postgres driver not installed. Run `pnpm add pg` (or yarn/npm), or use a sqlite URL for local dev.",
    )
  }
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new pg.Pool({ connectionString: config.url })
  const db = drizzle(pool)

  return {
    dialect: 'postgres',
    drizzle: db,
    async exec(sql) {
      await pool.query(sql)
    },
    async close() {
      await pool.end()
    },
  }
}

async function openSqlite(config: GravelDatabaseConfig): Promise<Database> {
  let Database: any
  try {
    Database = (await import('better-sqlite3')).default
  } catch {
    throw new Error(
      "[gravel] SQLite driver not installed. Run `pnpm add better-sqlite3`, or use a postgres URL.",
    )
  }
  const { drizzle } = await import('drizzle-orm/better-sqlite3')

  const path = config.url.replace(/^(file:|sqlite:)/, '')
  const sqlite = new Database(path)
  // Recommended pragmas for prod use.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite)

  // Auto-bootstrap the schema on first open. For SQLite (single-process,
  // local-only) this is a no-op idempotent CREATE TABLE IF NOT EXISTS. For
  // Postgres we skip — multi-instance deploys want explicit `gravel migrate`
  // so the DDL doesn't race across boots. The bootstrap statements live in
  // src/db/bootstrap.ts; we apply just the SQLite variant.
  try {
    const { applySqliteBootstrap } = await import('./bootstrap.js')
    applySqliteBootstrap(sqlite)
  } catch {
    // Bootstrap is best-effort; if the user already migrated by hand, the
    // CREATE TABLE IF NOT EXISTS statements would be no-ops anyway.
  }

  const handle: Database = {
    dialect: 'sqlite',
    drizzle: db,
    async exec(sql) {
      sqlite.exec(sql)
    },
    async close() {
      sqlite.close()
    },
  }

  // Apply any pending drizzle-kit migrations in dev. Bootstrap handles
  // first-install schema, but doesn't migrate forward when the SDK
  // ships a new column. Skipped in prod (deploy step should call
  // `gravel migrate` explicitly so the DDL doesn't race across
  // instances). Best-effort: failure here doesn't abort the open;
  // the dashboard's `/api/migrations/status` surfaces a banner.
  try {
    const { shouldAutoMigrate, migrate, pendingMigrationCount } = await import('./migrate.js')
    if (shouldAutoMigrate() && (await pendingMigrationCount(handle)) > 0) {
      // eslint-disable-next-line no-console
      console.log('[gravel] Applying pending DB migrations (dev). Disable with GRAVEL_DISABLE_AUTO_MIGRATE=1.')
      await migrate(handle)
    }
  } catch {
    /* never block boot on a migration attempt */
  }

  return handle
}
