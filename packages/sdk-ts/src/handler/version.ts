/**
 * Version-check helper for the dashboard's "update available" banner.
 *
 * The dashboard ships embedded in the SDK bundle (see
 * `dashboard.md` D-Q28: not CDN-fetched), which means a domain expert
 * loading `/admin/ai` is locked to whatever SDK version the host
 * developer last installed. Without a heads-up, a reviewer can be
 * weeks behind on bug fixes and feature work.
 *
 * Strategy:
 *   - The handler exposes `GET /api/version` (admin-only).
 *   - That route reports the running SDK's `package.json` version
 *     (`current`) and what npm's registry has tagged @latest
 *     (`latest`). The frontend compares them and conditionally
 *     surfaces a banner with the upgrade command.
 *   - `latest` is fetched once per process, then refreshed at most
 *     every `CHECK_INTERVAL_MS` (default 60 minutes) — the banner
 *     stays informative without hammering registry.npmjs.org.
 *   - Failures (offline, network blocked, etc.) return null and are
 *     swallowed: the banner just doesn't appear.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@artanis-ai/gravel/latest'
const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1h

interface CachedCheck {
  fetchedAt: number
  /** null = the last check failed; we still cache to throttle retries. */
  latest: string | null
}

let cached: CachedCheck | null = null
let inflight: Promise<string | null> | null = null
let cachedCurrent: string | null = null

/**
 * Reads the SDK's own `package.json` version. Cached on first call.
 *
 * The SDK's source layout puts package.json one level above `src/`,
 * but after tsup bundles into `dist/`, it's two levels above the
 * compiled file (or one — depends on how the user imports). We walk
 * upwards from import.meta.url until we find a package.json with our
 * name in it.
 */
export async function readSdkVersion(): Promise<string> {
  if (cachedCurrent) return cachedCurrent
  let dir: string
  try {
    dir = dirname(fileURLToPath(import.meta.url))
  } catch {
    // CJS fallback — process.cwd() walking will likely fail too, so
    // return a sentinel rather than crash the version route.
    cachedCurrent = '0.0.0-unknown'
    return cachedCurrent
  }
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json')
    try {
      const body = JSON.parse(await fs.readFile(candidate, 'utf8')) as {
        name?: string
        version?: string
      }
      if (body.name === '@artanis-ai/gravel' && typeof body.version === 'string') {
        cachedCurrent = body.version
        return cachedCurrent
      }
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedCurrent = '0.0.0-unknown'
  return cachedCurrent
}

/**
 * Fetches the latest version tag from npm. Returns null on any
 * failure (network blocked, non-200, parse error, etc.).
 *
 * Honors `GRAVEL_VERSION_CHECK_DISABLED=1` so privacy-conscious
 * deployments can opt out entirely.
 */
async function fetchLatestFromRegistry(): Promise<string | null> {
  if (process.env.GRAVEL_VERSION_CHECK_DISABLED === '1') return null
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

async function getLatest(): Promise<string | null> {
  if (cached && Date.now() - cached.fetchedAt < CHECK_INTERVAL_MS) {
    return cached.latest
  }
  if (inflight) return inflight
  inflight = (async () => {
    const latest = await fetchLatestFromRegistry()
    cached = { fetchedAt: Date.now(), latest }
    inflight = null
    return latest
  })()
  return inflight
}

export interface VersionInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
}

/**
 * Compare semver-ish version strings. Returns true if `b` is strictly
 * newer than `a`. Falls back to string compare if either side is
 * non-numeric (rare in our context — npm publishes are semver).
 */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((p) => Number.parseInt(p, 10))
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0
    const y = B[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return b > a
    if (y > x) return true
    if (y < x) return false
  }
  return false
}

export async function getVersionInfo(): Promise<VersionInfo> {
  const [current, latest] = await Promise.all([readSdkVersion(), getLatest()])
  return {
    current,
    latest,
    hasUpdate: latest !== null && isNewer(current, latest),
  }
}

/** Test seam — drops the cached current + remote check. */
export function _resetVersionCacheForTests(): void {
  cached = null
  inflight = null
  cachedCurrent = null
}

/** Exported for direct unit testing of the comparator. */
export const _versionTesting = { isNewer }
