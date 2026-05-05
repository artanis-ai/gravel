/**
 * drizzle-kit config for SQLite. Generates migrations/sqlite/*.sql.
 */
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/schema/sqlite.ts',
  out: './migrations/sqlite',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./gravel.db',
  },
} satisfies Config
