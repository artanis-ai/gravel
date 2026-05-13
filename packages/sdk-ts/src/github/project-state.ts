/**
 * GitHub install state — read straight from process.env.
 *
 * The install flow (anonymous, no Gravel cloud account required)
 * writes four env vars to `.env.local` after the GH App is installed:
 *
 *   GRAVEL_GH_INSTALL_ID        — the numeric installation_id GitHub minted
 *   GRAVEL_GH_INSTALL_SECRET    — HMAC-derived bearer for token mints
 *   GRAVEL_GH_REPO_OWNER        — repo the install is scoped to (e.g. "acme")
 *   GRAVEL_GH_REPO_NAME         — repo name (e.g. "app")
 *
 * That's the entire SDK-side state. Token minting goes through the CP
 * via `mintInstallationTokenViaCp()` (passes install_id + install_secret;
 * CP HMAC-verifies and forwards a 1-hour repo-scoped token from GitHub).
 *
 * The legacy project-API-key path (GRAVEL_PROJECT_ID + GRAVEL_API_KEY)
 * is gone — the install_secret is now the only auth the GH endpoints
 * need. The project API key still gates Trace Evals (a separate,
 * metered, billed surface).
 */

export interface GhInstallState {
  installationId: number
  repoOwner: string
  repoName: string
  /** Bearer secret for CP token-mint calls. Treat as a password. */
  installSecret: string
}

export function readGhInstallStateFromEnv(): GhInstallState | null {
  // Dev stub: bypass everything (used by the fixture suite + UI
  // iteration without a deployed CP). Pairs with the same flag in
  // handler/routes.ts.
  if (process.env.GRAVEL_GH_DEV_STUB === '1') {
    const owner = process.env.GRAVEL_GH_DEV_REPO_OWNER
    const name = process.env.GRAVEL_GH_DEV_REPO_NAME
    if (!owner || !name) return null
    return {
      installationId: 0,
      repoOwner: owner,
      repoName: name,
      installSecret: 'dev-stub',
    }
  }

  const idRaw = process.env.GRAVEL_GH_INSTALL_ID
  const secret = process.env.GRAVEL_GH_INSTALL_SECRET
  const owner = process.env.GRAVEL_GH_REPO_OWNER
  const name = process.env.GRAVEL_GH_REPO_NAME
  if (!idRaw || !secret || !owner || !name) return null
  const installationId = Number(idRaw)
  if (!Number.isInteger(installationId) || installationId <= 0) return null
  return { installationId, repoOwner: owner, repoName: name, installSecret: secret }
}

/**
 * Async to keep call sites (which awaited the old CP-fetching version)
 * working unchanged. Pure env read now.
 */
export async function getGhInstallState(): Promise<GhInstallState | null> {
  return readGhInstallStateFromEnv()
}

/** No-op: state lives in env now, nothing to bust. */
export function bustGhInstallStateCache(): void {
  /* no-op */
}

/** Test seam — was a cache reset; kept as a no-op for source-compat. */
export function _resetGhInstallStateCacheForTests(): void {
  /* no-op */
}

function controlPlaneUrl(): string {
  return process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'
}

export interface MintedInstallationToken {
  token: string
  expiresAt: string
  repoFullName: string | null
}

/**
 * Ask the CP to mint a 1-hour repo-scoped GitHub installation token.
 * Auth = the install_secret in our env (HMAC-verified server-side).
 *
 * `repo_full_name` (from .env.local) is passed so the CP can verify
 * that the install actually covers this repo — required when the
 * install covers multiple repos (the install_secret unlocks the whole
 * install; the repo name picks which one to bind the token to).
 */
export async function mintInstallationTokenViaCp(
  state: GhInstallState,
): Promise<MintedInstallationToken> {
  const url = new URL('/api/cli/github/installation-token', controlPlaneUrl())
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installation_id: state.installationId,
      install_secret: state.installSecret,
      repo_full_name: `${state.repoOwner}/${state.repoName}`,
    }),
  })
  if (!res.ok) {
    throw new Error(`installation-token mint failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as {
    token: string
    expires_at: string
    repo_full_name: string | null
  }
  return {
    token: body.token,
    expiresAt: body.expires_at,
    repoFullName: body.repo_full_name,
  }
}
