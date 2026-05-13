/**
 * Shared route context type + route-table shape.
 *
 * Each per-domain file in `handler/routes/` exports a
 * `Record<string, RouteHandler>` keyed by `"METHOD /api/path"`. The
 * top-level `routes.ts` merges them all into one dispatch table.
 *
 * Decoupling this small type was the price of breaking up the 670-
 * line routes.ts: each domain file can `import type { RouteCtx }`
 * without pulling in any other route's dependencies.
 */
import type { Database } from '../db/index.js'
import type { GravelRequest, GravelUser, ResolvedGravelConfig } from '../types.js'

export interface RouteCtx {
  config: ResolvedGravelConfig
  /**
   * Null when the customer hasn't wired DATABASE_URL (prompts-only
   * install). Routes that need it handle null and degrade gracefully
   * (see /api/samples for the pattern).
   */
  db: Database | null
  request: Request
  grRequest: GravelRequest
  path: string
  authed: GravelUser | null
}

export type RouteHandler = (ctx: RouteCtx) => Promise<Response>

export type RouteTable = Record<string, RouteHandler>
