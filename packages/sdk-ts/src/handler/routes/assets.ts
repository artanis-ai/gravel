/**
 * Bundled dashboard assets — content-hashed Vite output served from
 * the bundle on disk.
 *
 * Public route (no auth gate) so the login page can load its JS/CSS
 * before the user is authenticated. Auth bypass lives in
 * handler/index.ts. Filenames are content-hashed so we cache
 * aggressively.
 */
import { DASHBOARD_ASSETS } from '../dashboard-bundle.js'
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'

export const assetsRoutes: RouteTable = {
  'GET /_assets/:id': async ({ path }) => {
    const filename = decodeURIComponent(path.split('/').pop() ?? '')
    if (!filename || filename.includes('/') || filename.includes('..')) {
      return json({ error: 'invalid asset name' }, 400)
    }
    const asset = DASHBOARD_ASSETS[filename]
    if (!asset) return json({ error: 'asset not found', filename }, 404)
    const bytes = Buffer.from(asset.content, 'base64')
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': asset.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(bytes.byteLength),
      },
    })
  },
}
