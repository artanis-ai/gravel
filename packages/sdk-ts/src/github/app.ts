/**
 * GitHub App authentication — sign App-level JWTs and mint repo-scoped
 * installation tokens. Replaces the per-user OAuth flow that lived in
 * `connect.ts` (still present, marked deprecated).
 *
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
 * The PR-creation feature is free — no tier or paid-customer check.
 * Auth boundary is the install_secret in the SDK's env (HMAC-derived
 * server-side from installation_id; see project-state.ts and
 * `mintInstallationTokenViaCp` for the actual mint call).
 */
