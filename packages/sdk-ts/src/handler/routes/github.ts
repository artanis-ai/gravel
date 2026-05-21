/**
 * GitHub App install routes.
 *
 * Anonymous install flow (no Gravel cloud account required):
 *
 *   1. Dashboard calls GET /api/github/install -> we 302 the browser
 *      to the CP's install/start endpoint, which signs a state JWT
 *      that carries `return_to`.
 *   2. User installs the app on GitHub.
 *   3. GitHub redirects to the App's globally-configured Setup URL
 *      (CP's /api/cli/github/install/callback), which verifies the
 *      state, computes a deterministic install_secret, and 302s back
 *      to our /api/github/install/callback with installation_id,
 *      install_secret, repo_owner, repo_name as query params.
 *   4. Callback writes the four env vars into .env.local + the
 *      current process so subsequent requests see the install.
 *
 * `GRAVEL_GH_DEV_STUB=1` bypasses the entire CP roundtrip for local
 * dev — pairs with the same flag in `github/project-state.ts`.
 *
 */
import { json } from '../index.js'
import type { RouteTable } from '../route-ctx.js'

export const githubRoutes: RouteTable = {
  'GET /api/github/status': async ({ authed }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const { getGhInstallState } = await import('../../github/project-state.js')
    const state = await getGhInstallState()
    return json({
      connected: !!state,
      repoOwner: state?.repoOwner ?? null,
      repoName: state?.repoName ?? null,
    })
  },
  /**
   * Pre-flight: "is the gravel-bot GitHub App already installed on
   * this checkout's repo?" The dashboard's dev-box uses this to show
   * developer-targeted guidance when the local `.env.local` lacks
   * the GRAVEL_GH_INSTALL_* vars but the CP already has a row for
   * the repo (a colleague installed it earlier).
   *
   * Returns `{installed: false}` when we can't determine the repo
   * locally (no git remote) OR when the CP says no row OR when the
   * CP call fails. Dashboard falls through to normal Install button
   * behaviour in all those cases.
   *
   * Owner+repo comes from `git remote get-url origin`. Secret never
   * leaves the CP; we only return `{installed, installationId,
   * installedAt}` — the install_secret stays in the original
   * installer's .env.local. Trust model unchanged.
   */
  'GET /api/github/already-installed-on-repo': async ({ authed, request }) => {
    if (!authed) return json({ error: 'unauthorized' }, 401)
    const { detectLocalGithubRepo } = await import('../../github/repo-detect.js')
    const repo = detectLocalGithubRepo()
    if (!repo) {
      return json({ installed: false, reason: 'no-local-repo' })
    }
    const cpUrl = process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'
    const cp = new URL('/api/cli/github/check-installation', cpUrl)
    cp.searchParams.set('owner', repo.owner)
    cp.searchParams.set('repo', repo.name)
    try {
      const resp = await fetch(cp.toString(), { method: 'GET' })
      if (!resp.ok) {
        return json({ installed: false, reason: `cp-${resp.status}` })
      }
      const body = (await resp.json()) as {
        installed: boolean
        installationId?: number
        installedAt?: string
      }
      // Pass through the CP shape + tack on the local repo info so
      // the dev box can render the (owner/repo) pair without a
      // second round-trip.
      return json({
        installed: body.installed,
        installationId: body.installationId ?? null,
        installedAt: body.installedAt ?? null,
        repoOwner: repo.owner,
        repoName: repo.name,
      })
    } catch (err) {
      return json({ installed: false, reason: 'cp-unreachable' })
    }
  },
  'GET /api/github/install': async ({ request, config }) => {
    const requestUrl = new URL(request.url)
    // Pin the install-initiating origin into the callback URL so the
    // final post-install redirect lands on the SAME origin the user
    // started on. Pre-v0.10.0 this drifted: GitHub / the CP could
    // canonicalise the round-trip URL (localhost ↔ 127.0.0.1) and
    // bounce the user to a different origin. localStorage is
    // origin-scoped, so the drafts the user typed before the install
    // looked gone (they were on the OLD origin). Olly hit this 2026-05-21.
    const callback = new URL(
      `${config.mountPath}/api/github/install/callback`,
      request.url,
    )
    callback.searchParams.set('return_origin', requestUrl.origin)
    if (process.env.GRAVEL_GH_DEV_STUB === '1') {
      const owner = process.env.GRAVEL_GH_DEV_REPO_OWNER
      const name = process.env.GRAVEL_GH_DEV_REPO_NAME
      if (!owner || !name) {
        return json(
          { error: 'GRAVEL_GH_DEV_STUB=1 requires GRAVEL_GH_DEV_REPO_OWNER + GRAVEL_GH_DEV_REPO_NAME' },
          500,
        )
      }
      callback.searchParams.set('gh', 'installed')
      return json({ redirectUrl: callback.toString() })
    }
    // Bounce to the CP's install/start so it can sign the state JWT
    // GitHub's install URL needs. No project_id — the CP is anonymous
    // for this flow. We also pass `expected_repo` (best-effort, from
    // `git remote get-url origin`) so the callback can pick the right
    // repo if the user's install covers multiple — without it, the
    // callback falls back to the first repo and the SDK surfaces a
    // mismatch prompt to the user.
    const cpUrl = process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'
    const start = new URL('/api/cli/github/install/start', cpUrl)
    start.searchParams.set('return_to', callback.toString())
    const { detectLocalGithubRepo } = await import('../../github/repo-detect.js')
    const localRepo = detectLocalGithubRepo()
    if (localRepo) {
      start.searchParams.set('expected_repo', `${localRepo.owner}/${localRepo.name}`)
    }
    return json({ redirectUrl: start.toString() })
  },
  'GET /api/github/install/callback': async ({ request, config }) => {
    const url = new URL(request.url)
    const installationIdRaw = url.searchParams.get('installation_id')
    const installSecret = url.searchParams.get('install_secret')
    const repoOwner = url.searchParams.get('repo_owner')
    const repoName = url.searchParams.get('repo_name')
    if (installationIdRaw && installSecret && repoOwner && repoName) {
      try {
        const { writeEnvAdditions } = await import('../env.js')
        await writeEnvAdditions(
          process.cwd(),
          {
            GRAVEL_GH_INSTALL_ID: installationIdRaw,
            GRAVEL_GH_INSTALL_SECRET: installSecret,
            GRAVEL_GH_REPO_OWNER: repoOwner,
            GRAVEL_GH_REPO_NAME: repoName,
          },
          { overwrite: true },
        )
        // Make the env vars visible to subsequent requests in this
        // process without restart (Next dev rereads .env on file
        // change anyway, but a fresh tab in the same boot needs this).
        process.env.GRAVEL_GH_INSTALL_ID = installationIdRaw
        process.env.GRAVEL_GH_INSTALL_SECRET = installSecret
        process.env.GRAVEL_GH_REPO_OWNER = repoOwner
        process.env.GRAVEL_GH_REPO_NAME = repoName
      } catch (e) {
        // Fall through to a clean redirect — the dashboard surfaces
        // the missing-env case as "App not installed" and the user
        // can retry. Logging is per-host.
        // eslint-disable-next-line no-console
        console.error('[gravel] failed to write GH install env vars:', e)
      }
    }
    // Redirect back to the install-initiating origin (see the
    // `return_origin` set in /api/github/install). Falls back to a
    // same-origin relative redirect when absent (older callbacks).
    const returnOrigin = url.searchParams.get('return_origin')
    const target = returnOrigin
      ? `${returnOrigin}${config.mountPath}/?gh=installed`
      : `${config.mountPath}/?gh=installed`
    return new Response(null, {
      status: 302,
      headers: { location: target },
    })
  },
}
