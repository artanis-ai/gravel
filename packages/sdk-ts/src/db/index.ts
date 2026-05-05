/**
 * DB connector. Picks Postgres or SQLite based on DATABASE_URL.
 *
 * Both flavours present an identical `Database` interface to the rest of
 * the SDK so callers don't care which engine is in use.
 *
 * Spec: gravel-cloud/docs/spec/data-model.md §3
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

  return {
    dialect: 'sqlite',
    drizzle: db,
    async exec(sql) {
      sqlite.exec(sql)
    },
    async close() {
      sqlite.close()
    },
  }
}
