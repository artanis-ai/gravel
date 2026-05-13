/**
 * Version info — admin only. Used by the dashboard to surface an
 * "update available" banner when the host's installed @artanis-ai/gravel
 * is behind npm @latest. See handler/version.ts for the cache + opt-out
 * (`GRAVEL_VERSION_CHECK_DISABLED=1`).
 */
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'
import { getVersionInfo } from '../version.js'

export const versionRoutes: RouteTable = {
  'GET /api/version': async ({ authed }) => {
    if (!authed || authed.role !== 'admin') return json({ error: 'unauthorized' }, 401)
    return json(await getVersionInfo())
  },
}
