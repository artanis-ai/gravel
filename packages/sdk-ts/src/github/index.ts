/**
 * GitHub integration. Uses the dedicated `gravel[bot]` GitHub App per
 * `decisions.md` D-Q53 (2026-05-07 re-reversal entry).
 */
export { githubAPI } from './api.js'
export type { GitHubError } from './api.js'

export { createPullRequest } from './create-pr.js'
export type { PromptChange, CreatePullRequestArgs, CreatePullRequestResult } from './create-pr.js'

export { buildInstallUrl, DEFAULT_APP_SLUG, DEFAULT_APP_ID } from './app.js'
export type { GravelAppId, InstallationBinding, InstallationToken } from './app.js'

export {
  getGhInstallState,
  bustGhInstallStateCache,
  mintInstallationTokenViaCp,
} from './project-state.js'
export type { GhInstallState, MintedInstallationToken } from './project-state.js'
