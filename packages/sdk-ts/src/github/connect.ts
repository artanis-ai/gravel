/**
 * "Connect GitHub" handshake on the lib side. The actual OAuth exchange
 * happens on the control plane (which holds GITHUB_CLIENT_SECRET); the lib's
 * job is just to:
 *
 *   1. Send the user to the control plane's /api/cli/github/start endpoint
 *      with `return_to=<their-app.com>/admin/ai/api/github/callback`.
 *   2. Receive the callback hop with a signed JWT carrying the gh access
 *      token. Verify the JWT (HMAC with the project's API key, derived).
 *   3. Persist the token in `gravel_users.extra` keyed on the DE's user id.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §6 connection flow.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const CONTROL_PLANE_DEFAULT = 'https://gravel.artanis.ai'

export interface ConnectStartResult {
  /** Where to redirect the user's browser to begin the GitHub OAuth flow. */
  redirectUrl: string
}

export interface ConnectFinalizeResult {
  ghAccessToken: string
  ghLogin: string
  ghUserId: string
  ghName?: string
  ghAvatarUrl?: string
}

export interface ConnectStartArgs {
  /** Project API key — used by the control plane to identify the install. */
  projectId: string
  apiKey: string
  /** Where the lib's callback endpoint lives, fully qualified. */
  callbackUrl: string
  /** Optional override for testing. */
  controlPlaneUrl?: string
}

export function startConnectFlow(args: ConnectStartArgs): ConnectStartResult {
  const cp = (args.controlPlaneUrl ?? CONTROL_PLANE_DEFAULT).replace(/\/$/, '')
  const url = new URL(`${cp}/api/cli/github/start`)
  url.searchParams.set('project_id', args.projectId)
  url.searchParams.set('api_key', args.apiKey) // sent over TLS; control plane validates
  url.searchParams.set('return_to', args.callbackUrl)
  return { redirectUrl: url.toString() }
}

/**
 * Lib-side callback: control plane redirects here with `?session=<jwt>`.
 * The JWT is HMAC-signed with a secret derived from the project API key.
 */
export interface ConnectFinalizeArgs {
  apiKey: string
  jwt: string
}

export function finalizeConnectCallback(args: ConnectFinalizeArgs): ConnectFinalizeResult {
  const parts = args.jwt.split('.')
  if (parts.length !== 3) throw new Error('[gravel] Invalid GitHub-connect JWT shape.')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  const expected = createHmac('sha256', deriveSecret(args.apiKey))
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  const provided = fromBase64url(sigB64)
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    throw new Error('[gravel] GitHub-connect JWT signature mismatch.')
  }

  const payload = JSON.parse(fromBase64url(payloadB64).toString('utf8')) as Record<string, unknown>
  if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) {
    throw new Error('[gravel] GitHub-connect JWT expired.')
  }
  if (typeof payload.gh_token !== 'string' || typeof payload.login !== 'string' || typeof payload.id !== 'number') {
    throw new Error('[gravel] GitHub-connect JWT missing required fields.')
  }
  return {
    ghAccessToken: payload.gh_token,
    ghLogin: payload.login,
    ghUserId: String(payload.id),
    ghName: typeof payload.name === 'string' ? payload.name : undefined,
    ghAvatarUrl: typeof payload.avatar_url === 'string' ? payload.avatar_url : undefined,
  }
}

function deriveSecret(apiKey: string): Buffer {
  return createHmac('sha256', apiKey).update('gravel-github-connect-v1').digest()
}

function fromBase64url(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Buffer.from(s, 'base64')
}
