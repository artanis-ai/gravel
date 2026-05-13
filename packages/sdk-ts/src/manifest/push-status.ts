/**
 * Local helper to ask git "is this file on the upstream branch yet?".
 *
 * Mirrors `python/gravel/src/artanis_gravel/_push_status.py`. Used by
 * the dashboard's /api/prompts list to badge unpushed prompts and by
 * /api/prompts/submit to fail fast (with a clear `prompt_not_pushed`
 * code) rather than letting the GitHub API return a generic 404.
 *
 * Strategy:
 *   1. Resolve the upstream of the current branch (`git rev-parse @{u}`).
 *      Falls back to `origin/main`, then `origin/master`.
 *   2. Run a single `git ls-tree --name-only <upstream> -- <paths…>`.
 *      Anything in `paths` that didn't echo back is unpushed.
 *
 * Returns an empty set on any failure (no git, not a repo, no upstream,
 * no remote). Treat "unknown" the same as "pushed" — GitHub's actual
 * response at submit time is the ground truth.
 */
import { execFileSync } from 'node:child_process'

function git(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    return { code: 0, stdout }
  } catch {
    return { code: 1, stdout: '' }
  }
}

function resolveUpstream(repoRoot: string): string | null {
  const r = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot)
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim()
  for (const fallback of ['origin/main', 'origin/master']) {
    if (git(['rev-parse', '--verify', fallback], repoRoot).code === 0) return fallback
  }
  return null
}

/**
 * Return the subset of `paths` that are NOT on the upstream branch.
 * Quiet on any git failure (returns empty set).
 */
export function unpushedPaths(repoRoot: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set()
  const upstream = resolveUpstream(repoRoot)
  if (!upstream) return new Set()
  const r = git(['ls-tree', '--name-only', upstream, '--', ...paths], repoRoot)
  if (r.code !== 0) return new Set()
  const present = new Set(
    r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  return new Set(paths.filter((p) => !present.has(p)))
}
