/**
 * Dashboard SPA bootstrap routes — / and /login.
 *
 * The Vite-built index.html is bundled at SDK build time (see
 * scripts/build-dashboard.mjs). Asset paths in the HTML are emitted
 * relative (`./assets/foo.js`) so we rewrite them to mount-relative
 * URLs at request time without parsing HTML. See `handler/shell.ts`.
 */
import {
  DASHBOARD_INDEX_HTML,
  DASHBOARD_LOGIN_HTML,
} from '../dashboard-bundle.js'
import type { RouteTable } from '../route-ctx.js'
import { rewriteShell } from '../shell.js'

export const shellRoutes: RouteTable = {
  'GET /': async ({ config }) =>
    new Response(rewriteShell(DASHBOARD_INDEX_HTML, config), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    }),
  'GET /login': async ({ config }) =>
    new Response(rewriteShell(DASHBOARD_LOGIN_HTML, config), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    }),
}
