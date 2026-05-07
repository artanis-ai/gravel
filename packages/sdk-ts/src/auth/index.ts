/**
 * Auth gate. Two mutually-exclusive modes per gravel-cloud/docs/spec/auth.md:
 *
 *   1. `getUser` callback — host app delegates auth. null = "not authed".
 *   2. Default password — fallback when getUser is absent. Lib hosts /login.
 *
 * Per the auth spec: no fall-through. If getUser is set, password mode is
 * unreachable. The wizard ensures one is set during install.
 */
import type { GravelRequest, GravelUser, ResolvedGravelConfig } from '../types.js'
import { verifyPassword, signSession, verifySession, SESSION_COOKIE } from './session.js'
import { isViewAsUser } from './view-as.js'
import { isLocalhostRequest } from './origin.js'

export type AuthOutcome =
  | { kind: 'authed'; user: GravelUser }
  | { kind: 'unauthed-getuser'; reason: 'getuser-returned-null' }
  | { kind: 'unauthed-password'; reason: 'no-session' | 'bad-session' }
  | { kind: 'misconfigured' }

export async function authenticate(
  config: ResolvedGravelConfig,
  req: GravelRequest,
): Promise<AuthOutcome> {
  // Localhost = admin shortcut. The browser-facing hostname (X-Forwarded-Host
  // ?? Host) drives the decision so prod behind a proxy isn't fooled by the
  // server's local interface. View-as cookie still demotes to user — devs
  // need to be able to preview the user-role experience without changing
  // hosts.
  if (config.localhostIsAdmin && isLocalhostRequest(req)) {
    const role = isViewAsUser(req) ? 'user' : 'admin'
    return {
      kind: 'authed',
      user: { id: 'localhost', firstName: 'Developer', role },
    }
  }

  if (config.auth.getUser) {
    return await authViaCallback(config, req)
  }
  if (config.auth.defaultPassword) {
    return await authViaPassword(config, req)
  }
  return { kind: 'misconfigured' }
}

async function authViaCallback(
  config: ResolvedGravelConfig,
  req: GravelRequest,
): Promise<AuthOutcome> {
  const user = await config.auth.getUser!(req)
  if (!user) return { kind: 'unauthed-getuser', reason: 'getuser-returned-null' }

  // View-as: admin viewing as user. Demote role.
  const effective = isViewAsUser(req) && user.role === 'admin' ? { ...user, role: 'user' as const } : user
  return { kind: 'authed', user: effective }
}

async function authViaPassword(
  config: ResolvedGravelConfig,
  req: GravelRequest,
): Promise<AuthOutcome> {
  const cookie = req.cookies.get(SESSION_COOKIE)
  if (!cookie) return { kind: 'unauthed-password', reason: 'no-session' }

  const verified = await verifySession(cookie, config.auth.defaultPassword!)
  if (!verified) return { kind: 'unauthed-password', reason: 'bad-session' }

  // Default-password mode is admin-only by design. View-as can demote to user.
  const role = isViewAsUser(req) ? 'user' : 'admin'
  return {
    kind: 'authed',
    user: { id: 'admin', firstName: 'Admin', role },
  }
}

export { verifyPassword, signSession, verifySession, SESSION_COOKIE }
