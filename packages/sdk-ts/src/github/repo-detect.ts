/**
 * Best-effort detection of the GitHub repo this SDK is running in.
 *
 * Used to send `expected_repo=owner/name` to the CP's install/start
 * endpoint so multi-repo installs land the right repo in the SDK's
 * `.env.local`. Falls back to `null` if:
 *   - we're not in a git work tree,
 *   - the repo has no `origin` remote,
 *   - the remote isn't on github.com (gitlab / bitbucket / mirror),
 *   - the URL is unparseable.
 *
 * The CP treats `expected_repo` as a hint, not a contract — when it's
 * missing the callback picks the first repo from the install and the
 * SDK surfaces a "repo mismatch, reinstall" prompt if the env value
 * doesn't match the local git remote.
 */
import { execSync } from 'node:child_process'

/** Parsed `owner/name` from a GitHub remote URL, or null. */
export function parseGithubRemoteUrl(url: string): { owner: string; name: string } | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // SSH: git@github.com:owner/name.git
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! }
  // HTTPS: https://github.com/owner/name(.git)? — also catches
  // https://oauth2:token@github.com/owner/name.git
  const https = trimmed.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (https) return { owner: https[1]!, name: https[2]! }
  // git://, ssh://git@github.com/owner/name(.git)?
  const proto = trimmed.match(/^(?:ssh|git)(?:\+ssh)?:\/\/(?:[^@]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (proto) return { owner: proto[1]!, name: proto[2]! }
  return null
}

/**
 * Detect the local GitHub `owner/name` by shelling out to `git remote
 * get-url origin`. Returns null on any failure (no git, no remote,
 * not a github URL).
 */
export function detectLocalGithubRepo(cwd: string = process.cwd()): { owner: string; name: string } | null {
  let url: string
  try {
    url = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
  } catch {
    return null
  }
  return parseGithubRemoteUrl(url)
}
