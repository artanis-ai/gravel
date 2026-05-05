/**
 * GitHub integration. Reuses Mallet's OAuth App + PR creation flow per
 * decisions.md D-Q53 (build-session correction).
 */
export { githubAPI } from './api.js'
export type { GitHubError } from './api.js'

export { createPullRequest } from './create-pr.js'
export type { PromptChange, CreatePullRequestArgs, CreatePullRequestResult } from './create-pr.js'

export { startConnectFlow, finalizeConnectCallback } from './connect.js'
export type { ConnectStartResult, ConnectFinalizeResult } from './connect.js'
