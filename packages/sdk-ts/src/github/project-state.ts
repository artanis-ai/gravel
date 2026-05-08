/**
 * GitHub install state — queried from the control plane, not stored
 * locally. (The previous design mirrored install state into the
 * customer's DB; that table was dropped 2026-05-08.)
 *
 * Auth: project API key from `.env`. The CP enforces "you must own
 * this project" via the Clerk-managed key.
 */

export interface GhInstallState {
  installationId: number
  repoOwner: string
  repoName: string
  installedAt: string
}

interface CachedState {
  state: GhInstallState | null
  fetchedAt: number
}

// Tiny in-process cache so a status-check + a submit don't both hit
// the CP. TTL is short — install state changes rarely, and freshness
// is cheap.
const CACHE_TTL_MS = 30_000
let cache: CachedState | null = null

export function _resetGhInstallStateCacheForTests(): void {
  cache = null
}

function controlPlaneUrl(): string {
  return process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'
}

function projectId(): string {
  const id = process.env.GRAVEL_PROJECT_ID
  if (!id) throw new Error('GRAVEL_PROJECT_ID not set')
  return id
}

function apiKey(): string {
  const key = process.env.GRAVEL_API_KEY
  if (!key) throw new Error('GRAVEL_API_KEY not set')
  return key
}

/**
 * Read the install state from the CP, or `null` if the App isn't
 * installed on this project's repo yet.
 */
export async function getGhInstallState(): Promise<GhInstallState | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.state
  }
  // Dev stub: bypass CP entirely (used by the fixture suite + UI
  // iteration without a deployed CP). Pairs with the same flag in
  // handler/routes.ts and github/app.ts.
  if (process.env.GRAVEL_GH_DEV_STUB === '1') {
    const owner = process.env.GRAVEL_GH_DEV_REPO_OWNER
    const name = process.env.GRAVEL_GH_DEV_REPO_NAME
    if (!owner || !name) return null
    const state: GhInstallState = {
      installationId: 0,
      repoOwner: owner,
      repoName: name,
      installedAt: new Date().toISOString(),
    }
    cache = { state, fetchedAt: Date.now() }
    return state
  }

  const url = new URL(`/api/cli/projects/${encodeURIComponent(projectId())}/github`, controlPlaneUrl())
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey()}` },
  })
  if (res.status === 404) {
    cache = { state: null, fetchedAt: Date.now() }
    return null
  }
  if (!res.ok) {
    throw new Error(`gh-install-state fetch failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as
    | { installed: false }
    | {
        installed: true
        installation_id: number
        repo_owner: string
        repo_name: string
        installed_at: string | null
      }
  if (!body.installed) {
    cache = { state: null, fetchedAt: Date.now() }
    return null
  }
  const state: GhInstallState = {
    installationId: body.installation_id,
    repoOwner: body.repo_owner,
    repoName: body.repo_name,
    installedAt: body.installed_at ?? new Date().toISOString(),
  }
  cache = { state, fetchedAt: Date.now() }
  return state
}

/**
 * No-op kept for source compatibility with the SDK's install callback
 * route. The CP writes the install state; the SDK has nothing to
 * persist locally. (Bumps the cache so a status-refetch right after
 * install reflects the new state without waiting for the TTL.)
 */
export function bustGhInstallStateCache(): void {
  cache = null
}
