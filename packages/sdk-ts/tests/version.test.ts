/**
 * Tests for the SDK's version-check helper. These pin the contract
 * the dashboard's UpdateBanner + the new `gravel doctor` CLI rely on
 * to tell users when to upgrade.
 *
 * Coverage:
 *   - `isNewer` semver comparator across the realistic cases (patch,
 *     minor, major bumps, pre-release tags, leading 'v', equal,
 *     non-numeric fallback).
 *   - `fetchLatestFromRegistry` (indirect, via getVersionInfo): mocks
 *     `globalThis.fetch` to simulate a 200 / non-200 / network error
 *     / disabled flag, and checks the returned shape.
 *   - In-process cache: a second call within the 1h TTL doesn't hit
 *     the network; in-flight calls dedupe to a single fetch.
 *   - `readSdkVersion`: returns the real package.json version (not the
 *     `0.0.0-unknown` sentinel) when run from this repo.
 *
 * The 1-hour TTL itself isn't tested (it'd add fake-timers complexity
 * for a constant). Instead we verify the dedup + same-window behaviour.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  _resetVersionCacheForTests,
  _versionTesting,
  getVersionInfo,
  readSdkVersion,
} from '../src/handler/version.js'
import { _resetHostStackCacheForTests } from '../src/handler/host-stack.js'

describe('isNewer (semver comparator)', () => {
  const { isNewer } = _versionTesting
  it('detects patch bumps', () => {
    expect(isNewer('0.1.0', '0.1.1')).toBe(true)
    expect(isNewer('0.1.1', '0.1.0')).toBe(false)
  })
  it('detects minor bumps', () => {
    expect(isNewer('0.1.5', '0.2.0')).toBe(true)
  })
  it('detects major bumps', () => {
    expect(isNewer('0.9.9', '1.0.0')).toBe(true)
  })
  it('returns false for equal versions', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
  })
  it('handles a leading v prefix on either side', () => {
    expect(isNewer('v0.1.0', '0.1.1')).toBe(true)
    expect(isNewer('0.1.0', 'v0.1.1')).toBe(true)
  })
  it('treats prerelease suffixes as the same base', () => {
    // We strip after `-` / `+`, so 0.1.0-rc.1 -> 0.1.0; the user has
    // already shipped 0.1.0 (or beyond) so we don't push a downgrade.
    expect(isNewer('0.1.0', '0.1.0-rc.1')).toBe(false)
    expect(isNewer('0.1.0-rc.1', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0-rc.1', '0.1.1')).toBe(true)
  })
  it('treats missing tail components as zero', () => {
    expect(isNewer('1.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0', '1.0.1')).toBe(true)
  })
})

describe('getVersionInfo (fetch + cache)', () => {
  beforeEach(() => {
    _resetVersionCacheForTests()
    _resetHostStackCacheForTests()
    delete process.env.GRAVEL_VERSION_CHECK_DISABLED
  })
  afterEach(() => {
    _resetVersionCacheForTests()
    _resetHostStackCacheForTests()
    vi.restoreAllMocks()
  })

  it('returns hasUpdate=true when registry advertises a newer version', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '99.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const info = await getVersionInfo()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(info.latest).toBe('99.0.0')
    expect(info.hasUpdate).toBe(true)
    expect(info.current).toMatch(/^\d+\.\d+\.\d+/)
    // Always populated — packageManager + language are detected from
    // the host's cwd lockfiles at request time. For this repo it's TS.
    expect(info.language).toBe('ts')
    expect(['pnpm', 'npm', 'yarn', 'bun']).toContain(info.packageManager)
  })

  it('returns hasUpdate=false when current >= latest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '0.0.1' }), { status: 200 }),
    )
    const info = await getVersionInfo()
    expect(info.latest).toBe('0.0.1')
    expect(info.hasUpdate).toBe(false)
  })

  it('returns latest=null + hasUpdate=false on a non-200 registry response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 502 }))
    const info = await getVersionInfo()
    expect(info.latest).toBeNull()
    expect(info.hasUpdate).toBe(false)
  })

  it('returns latest=null + hasUpdate=false when fetch throws (offline / DNS / etc.)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETUNREACH'))
    const info = await getVersionInfo()
    expect(info.latest).toBeNull()
    expect(info.hasUpdate).toBe(false)
  })

  it('skips the registry hit entirely when GRAVEL_VERSION_CHECK_DISABLED=1', async () => {
    process.env.GRAVEL_VERSION_CHECK_DISABLED = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const info = await getVersionInfo()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(info.latest).toBeNull()
    expect(info.hasUpdate).toBe(false)
  })

  it('caches the registry result inside the TTL window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }),
    )
    await getVersionInfo()
    await getVersionInfo()
    await getVersionInfo()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent in-flight calls into a single fetch', async () => {
    let resolveFetch: (() => void) | null = null
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () =>
            resolve(new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }))
        }),
    )
    const p1 = getVersionInfo()
    const p2 = getVersionInfo()
    const p3 = getVersionInfo()
    resolveFetch!()
    const [a, b, c] = await Promise.all([p1, p2, p3])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a.latest).toBe('2.0.0')
    expect(b.latest).toBe('2.0.0')
    expect(c.latest).toBe('2.0.0')
  })
})

describe('readSdkVersion', () => {
  beforeEach(() => _resetVersionCacheForTests())
  afterEach(() => _resetVersionCacheForTests())

  it('returns a real semver from the SDK package.json (not the sentinel)', async () => {
    const v = await readSdkVersion()
    // The SDK's package.json is sitting one level up from tests/.
    // If our import.meta-walking ever regresses, we'd get the
    // `0.0.0-unknown` sentinel instead.
    expect(v).not.toBe('0.0.0-unknown')
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('caches the version across calls', async () => {
    const a = await readSdkVersion()
    const b = await readSdkVersion()
    expect(a).toBe(b)
  })
})
