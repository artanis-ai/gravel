/**
 * GitHub integration. Uses the dedicated `gravel[bot]` GitHub App per
 * `decisions.md` D-Q53 (2026-05-07 re-reversal entry).
 */
export { githubAPI } from './api.js'
export type { GitHubError } from './api.js'

export { createPullRequest } from './create-pr.js'
export type { PromptChange, CreatePullRequestArgs, CreatePullRequestResult } from './create-pr.js'

export { buildInstallUrl, mintInstallationToken } from './app.js'
export type { GravelAppId, InstallationBinding, InstallationToken } from './app.js'

/**
 * @deprecated Per-user OAuth flow. Superseded by the App above. Kept
 * exported for one release so the cutover can land in pieces; remove once
 * the App is live in production and no project rows still reference
 * per-user GH tokens.
 */
export { startConnectFlow, finalizeConnectCallback } from './connect.js'
export type { ConnectStartResult, ConnectFinalizeResult } from './connect.js'
