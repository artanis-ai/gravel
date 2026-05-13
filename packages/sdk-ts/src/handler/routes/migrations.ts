/**
 * Pending-migrations check — surfaced as a banner in the dashboard so
 * an admin sees "N pending DB migrations" before the first query 4xx's
 * on a missing column. Admin-only because the count is part of the
 * same operational-status surface as /api/version, and we don't want
 * domain experts staring at schema diagnostics.
 *
 * Returns `{ pending: <number>, dialect, autoMigrate }` so the banner
 * can decide between "auto-migrate disabled, run X" vs "auto-migrate
 * ON but something failed". The actual upgrade command is shaped by
 * the host's package manager (same source as /api/version's
 * packageManager field — see host-stack.ts).
 */
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'

export const migrationsRoutes: RouteTable = {
  'GET /api/migrations/status': async ({ authed, db }) => {
    if (!authed || authed.role !== 'admin') return json({ error: 'unauthorized' }, 401)
    if (!db) {
      return json({ pending: 0, dialect: null, autoMigrate: false, reason: 'no-db' })
    }
    const { pendingMigrationCount, shouldAutoMigrate } = await import('../../db/migrate.js')
    return json({
      pending: await pendingMigrationCount(db),
      dialect: db.dialect,
      autoMigrate: shouldAutoMigrate(),
    })
  },
}
