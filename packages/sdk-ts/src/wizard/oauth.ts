/**
 * Browser-OAuth handshake against `app.gravel.artanis.ai`.
 *
 * STATUS: stubbed. Control plane not yet provisioned. Wizard accepts
 * --api-key / --project as a temporary substitute. This file currently only
 * resolves the control plane URL with override support (so dev tests can
 * point at a localhost stub).
 *
 * BLOCKER (gravel-cloud/docs/blockers.md §control-plane): real handshake
 * implementation lands when app.gravel.artanis.ai is up.
 */
const DEFAULT_CONTROL_PLANE = 'https://app.gravel.artanis.ai'

export function resolveControlPlaneUrl(): string {
  return process.env.GRAVEL_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE
}

export interface OAuthClaim {
  projectId: string
  apiKey: string
  organizationName?: string
  projectName?: string
}

/**
 * BLOCKER: not implemented. Real flow:
 *   1. Pick a free localhost port.
 *   2. POST /api/cli/auth/init {token, redirect_port} → control plane.
 *   3. Open browser to /cli/auth?token=<token>.
 *   4. User signs in via Clerk + picks/creates project.
 *   5. Browser redirects to localhost:<port>/callback?token=<token>.
 *   6. GET /api/cli/auth/claim?token=<token> → returns {project_id, api_key, ...}.
 *   7. Local server closes.
 */
export async function browserOAuthHandshake(): Promise<OAuthClaim> {
  throw new Error(
    '[gravel] Browser OAuth not yet available — control plane is not provisioned. ' +
      'Pass --api-key and --project explicitly.',
  )
}
