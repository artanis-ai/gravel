/**
 * Edge-safe sub-entry: `import { defineConfig } from '@artanis-ai/gravel/define'`.
 *
 * `gravel.config.ts` is statically imported from `instrumentation.ts`, and
 * Next.js compiles `instrumentation.ts` for BOTH the node and edge
 * runtimes whenever the host has middleware (which Clerk, NextAuth, etc.
 * all install). The main `@artanis-ai/gravel` entry pulls Node builtins
 * (`node:fs`, `node:crypto`, `better-sqlite3` lazy require, etc.) and so
 * fails to bundle for the edge target — it kills `next dev` with
 * `Module not found: Can't resolve '@artanis-ai/gravel'` even when the
 * config is only ever read from the node runtime.
 *
 * This sub-entry re-exports just the pure type-passthrough helpers from
 * `./types`. Nothing in `types.ts` imports anything Node-flavoured, so
 * the resulting bundle is safe for the edge runtime.
 */
export { defineConfig, resolveConfig } from './types.js'
export type {
  GravelConfig,
  ResolvedGravelConfig,
  GravelDatabaseConfig,
  GravelAuthConfig,
  GravelUser,
  GravelRole,
  GravelRequest,
} from './types.js'
