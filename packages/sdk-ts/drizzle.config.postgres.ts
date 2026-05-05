/**
 * drizzle-kit config for Postgres dialect. Used to generate
 * migrations/postgres/*.sql from src/schema/postgres.ts.
 *
 * Usage:
 *   pnpm exec drizzle-kit generate --config=drizzle.config.postgres.ts
 *   pnpm exec drizzle-kit migrate  --config=drizzle.config.postgres.ts
 */
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/schema/postgres.ts',
  out: './migrations/postgres',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost/gravel_dev',
  },
} satisfies Config
