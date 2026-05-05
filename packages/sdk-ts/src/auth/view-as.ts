/**
 * View-as cookie (D-Q37). Admins toggle "View as user"; cookie persists until
 * toggled off. Demotes their effective role across the dashboard.
 */
import type { GravelRequest } from '../types.js'
import { VIEW_AS_COOKIE } from './session.js'

export function isViewAsUser(req: GravelRequest): boolean {
  return req.cookies.get(VIEW_AS_COOKIE) === 'user'
}
