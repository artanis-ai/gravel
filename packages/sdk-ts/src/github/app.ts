/**
 * GitHub App authentication — sign App-level JWTs and mint repo-scoped
 * installation tokens. Replaces the per-user OAuth flow that lived in
 * `connect.ts` (still present, marked deprecated).
 *
 * Spec: `gravel-cloud/docs/spec/prompts.md` §6
 * Decision: `gravel-cloud/docs/decisions.md` D-Q53 (2026-05-07 entry)
 *
 * Trust boundary: the App's RS256 private key NEVER leaves the control
 * plane (Cloudflare Worker at gravel.artanis.ai). The customer-side SDK
 * calls the control plane to mint installation tokens; the SDK only
 * sees the resulting token, scoped to one repo, valid for ~1 hour.
 *
 * Why we don't sign App JWTs in the customer's process:
 *  - Distributing the private key to every `pnpm install` would mean
 *    every customer could mint tokens for any other customer's
 *    installation. Single-tenant private key = single-tenant blast
 *    radius.
 *  - Customer envs leak (committed to git, shipped in Docker layers,
 *    logged by APM). Worker secrets are managed by Cloudflare.
 *
 * Status: this file is the schema/types for the cutover. The control
 * plane endpoint and the SDK→CP transport land in a follow-up commit
 * once the App registration is complete (see runbook).
 */

/** App-level identity. Public. */
export interface GravelAppId {
  /** Numeric App ID from github.com/settings/apps. Public; ships as a default. */
  appId: string
  /** Lowercased App name. Forms the install URL: github.com/apps/<slug>/installations/new */
  slug: string
}

/** What the SDK persists per project. Comes from the install callback. */
export interface InstallationBinding {
  installationId: number
  repoOwner: string
  repoName: string
  installedAt: Date
}

/** A repo-scoped token, the only secret the SDK ever holds. */
export interface InstallationToken {
  /** Bearer token for the GitHub REST API. Treat as a password. */
  token: string
  /** Use only against this repo — the token is scoped here at mint time. */
  repoFullName: string
  /** Re-mint a few minutes before this. */
  expiresAt: Date
}

/**
 * Production App registered at github.com/organizations/artanis-ai/settings/apps/gravel-bot
 * (slug `gravel-bot` because `gravel` was taken). Override per-deployment
 * via GRAVEL_GH_APP_SLUG / GRAVEL_GH_APP_ID for test or self-hosted setups.
 */
export const DEFAULT_APP_SLUG = 'gravel-bot'
export const DEFAULT_APP_ID = '3637942'

/**
 * Build the install URL the customer's dev clicks once. The CSRF state is
 * round-tripped through GitHub and verified by the install callback.
 */
export function buildInstallUrl(args: { state: string; slug?: string }): string {
  const slug = args.slug ?? process.env.GRAVEL_GH_APP_SLUG ?? DEFAULT_APP_SLUG
  const params = new URLSearchParams({ state: args.state })
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${params.toString()}`
}

/**
 * Mint a repo-scoped installation token by asking the control plane. The
 * control plane signs an App JWT with the private key and exchanges it
 * for the token, then forwards it back to us.
 *
 * The PR-creation feature is free — there's no tier or paid-customer
 * check. The bearer token below is a *binding* check: the install
 * callback hands the SDK a one-time-issued signed token, the SDK
 * persists it, and the control plane verifies it on every mint. That
 * stops a stranger who knows an `installation_id` (a smallish integer)
 * from minting tokens to push to someone else's repo. Without this
 * check the mint endpoint would be a free write-anywhere oracle for
 * every repo `gravel[bot]` is installed on.
 *
 * Caching is the caller's job — see `tokenCache` in `submit.ts` (added
 * in the cutover commit).
 */
export async function mintInstallationToken(args: {
  controlPlaneUrl: string
  /** Project API key (Clerk-managed). CP looks up the install. */
  apiKey: string
  projectId: string
}): Promise<InstallationToken> {
  // Dev stub: bypass the CP entirely. Pairs with GRAVEL_GH_DEV_STUB=1
  // in handler/routes.ts + project-state.ts.
  if (process.env.GRAVEL_GH_DEV_STUB === '1') {
    const stubToken = process.env.GRAVEL_GH_DEV_STUB_TOKEN
    if (!stubToken) {
      throw new Error(
        'GRAVEL_GH_DEV_STUB_TOKEN not set — required when GRAVEL_GH_DEV_STUB=1. Use a PAT scoped to your test repo.',
      )
    }
    const repoFullName = `${process.env.GRAVEL_GH_DEV_REPO_OWNER}/${process.env.GRAVEL_GH_DEV_REPO_NAME}`
    return {
      token: stubToken,
      repoFullName,
      // PATs don't expire, but pretending an hour from now keeps the
      // shape consistent + caches/refresh logic happy if we add it.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }
  }
  const res = await fetch(`${args.controlPlaneUrl}/api/cli/github/installation-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({ project_id: args.projectId }),
  })
  if (!res.ok) {
    throw new Error(`installation-token mint failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as {
    token: string
    repo_full_name: string
    expires_at: string
  }
  return {
    token: body.token,
    repoFullName: body.repo_full_name,
    expiresAt: new Date(body.expires_at),
  }
}
