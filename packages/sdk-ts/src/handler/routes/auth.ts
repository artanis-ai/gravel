/**
 * Auth routes: me, login, logout, view-as.
 *
 * Login accepts both form-encoded (the bundled login UI posts as
 * form so the dashboard works even with JS disabled) and JSON
 * (programmatic callers). The form path 303s back to the mount root
 * on success and /login?error=1 on failure; the JSON path returns
 * 200 / 401 respectively.
 *
 * Rate-limit is per-IP: 5 attempts per minute, lockout doubles on
 * each consecutive block (see auth/rate-limit.ts).
 */
import { signSession, verifyPassword } from '../../auth/session.js'
import { attemptLogin, recordSuccess } from '../../auth/rate-limit.js'
import {
  clientIp,
  sessionCookieClearValue,
  sessionCookieValue,
  viewAsCookieClearValue,
  viewAsCookieValue,
} from '../cookies.js'
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'

export const authRoutes: RouteTable = {
  'GET /api/auth/me': async ({ authed, config }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    return json({
      user: authed,
      productName: config.productName,
      mountPath: config.mountPath,
      hideArtanisBranding: config.hideArtanisBranding,
    })
  },
  'POST /api/auth/login': async ({ request, config, grRequest }) => {
    if (!config.auth.defaultPassword) {
      return json({ error: 'password mode not configured' }, 400)
    }
    const ctype = request.headers.get('content-type') ?? ''
    const isForm = ctype.includes('application/x-www-form-urlencoded')

    let password = ''
    if (isForm) {
      const form = await request.formData()
      password = String(form.get('password') ?? '')
    } else {
      try {
        const body = (await request.json()) as { password?: unknown }
        password = typeof body.password === 'string' ? body.password : ''
      } catch {
        password = ''
      }
    }

    const ip = clientIp(grRequest)
    const rate = attemptLogin(ip)
    if (!rate.allowed) {
      return new Response(
        JSON.stringify({
          error: 'too many attempts',
          retry_after_ms: rate.retryAfterMs ?? 60_000,
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    }
    if (!password || !verifyPassword(password, config.auth.defaultPassword)) {
      if (isForm) {
        return new Response(null, {
          status: 303,
          headers: { location: `${config.mountPath}/login?error=1` },
        })
      }
      return json({ error: 'invalid password' }, 401)
    }
    recordSuccess(ip)
    const cookie = signSession(config.auth.defaultPassword)
    const headers = new Headers({ 'set-cookie': sessionCookieValue(cookie, request.url) })
    if (isForm) {
      // Trailing slash matters: relative asset URLs in the SPA shell
      // resolve against the directory of the URL. `/admin/ai` (no slash)
      // resolves `./assets/x.js` to `/admin/assets/x.js` which is wrong.
      // The trailing slash also keeps Vite happy in dev (its base-path
      // server only matches `${MOUNT_PATH}/`, so a redirect without the
      // slash 404s and the user sees a blank page).
      headers.set('location', `${config.mountPath || ''}/`)
      return new Response(null, { status: 303, headers })
    }
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
  },
  'POST /api/auth/logout': async ({ request, config }) => {
    const headers = new Headers({ 'set-cookie': sessionCookieClearValue(request.url) })
    headers.set('location', `${config.mountPath}/login`)
    return new Response(null, { status: 303, headers })
  },
  'POST /api/auth/view-as': async ({ request, authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    if (authed.role !== 'admin') return json({ error: 'admin only' }, 403)
    let mode: string | null = null
    try {
      const body = (await request.json()) as { mode?: unknown }
      mode = typeof body.mode === 'string' ? body.mode : null
    } catch {
      // form-style: cookie cleared
    }
    const headers = new Headers({ 'content-type': 'application/json' })
    if (mode === 'user') {
      headers.set('set-cookie', viewAsCookieValue('user', request.url))
    } else {
      headers.set('set-cookie', viewAsCookieClearValue(request.url))
    }
    return new Response(JSON.stringify({ ok: true, view_as: mode === 'user' ? 'user' : null }), {
      status: 200,
      headers,
    })
  },
}
