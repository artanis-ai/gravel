/**
 * Detect the host's package manager + language at request time from
 * lockfiles in the cwd. Cached per-process — we don't expect the
 * host's package manager to switch under us between requests.
 *
 * Used by the dashboard's UpdateBanner and `gravel doctor` to render
 * the upgrade command for the right stack instead of always showing
 * `pnpm`. Mirrors the lockfile probing the wizard does at install
 * time (src/wizard/detect.ts), but evaluated at runtime so a host
 * that switched package managers post-install picks up the change.
 *
 * Detection precedence (lockfile present == winner):
 *   TS:  pnpm-lock.yaml → yarn.lock → bun.lock(b) → package-lock.json → 'npm'
 *   Py:  uv.lock → poetry.lock → Pipfile.lock → 'pip'
 *
 * Language is derived from whether package.json or pyproject.toml /
 * requirements.txt is present, with the lockfile check breaking ties.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export type PackageManager =
  | 'pnpm'
  | 'npm'
  | 'yarn'
  | 'bun'
  | 'uv'
  | 'pip'
  | 'poetry'
  | 'pipenv'

export type Language = 'ts' | 'python'

export interface HostStack {
  language: Language
  packageManager: PackageManager
}

let cached: { cwd: string; stack: HostStack } | null = null

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function detectStackUncached(cwd: string): Promise<HostStack> {
  const has = (rel: string) => exists(join(cwd, rel))

  // Python-side detection wins if any Python lockfile or pyproject is
  // present — the TS SDK could in principle live alongside a Python
  // app, but that's not the common shape, and a Python host that has
  // a node_modules from a build tool shouldn't be told to `pnpm update`.
  if (await has('uv.lock')) return { language: 'python', packageManager: 'uv' }
  if (await has('poetry.lock')) return { language: 'python', packageManager: 'poetry' }
  if (await has('Pipfile.lock')) return { language: 'python', packageManager: 'pipenv' }
  // No Python lockfile but a pyproject / requirements file → bare pip.
  const hasPythonRoot =
    (await has('pyproject.toml')) ||
    (await has('requirements.txt')) ||
    (await has('setup.py'))
  if (hasPythonRoot && !(await has('package.json'))) {
    return { language: 'python', packageManager: 'pip' }
  }

  // TS-side detection. Same precedence as the wizard.
  if (await has('pnpm-lock.yaml')) return { language: 'ts', packageManager: 'pnpm' }
  if (await has('yarn.lock')) return { language: 'ts', packageManager: 'yarn' }
  if ((await has('bun.lock')) || (await has('bun.lockb'))) {
    return { language: 'ts', packageManager: 'bun' }
  }
  // package-lock.json OR no lockfile at all in a JS repo: npm.
  return { language: 'ts', packageManager: 'npm' }
}

/**
 * Detect the host stack from `cwd` (default: `process.cwd()`).
 * Cached per-cwd; re-detects if the working directory changes between
 * calls (rare, but it makes tests deterministic).
 */
export async function detectHostStack(cwd: string = process.cwd()): Promise<HostStack> {
  if (cached && cached.cwd === cwd) return cached.stack
  const stack = await detectStackUncached(cwd)
  cached = { cwd, stack }
  return stack
}

/** Test seam — drop the cached stack so the next call re-detects. */
export function _resetHostStackCacheForTests(): void {
  cached = null
}
