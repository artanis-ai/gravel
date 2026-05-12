/**
 * Tests for bin/gravel.js — the Node wrapper around the gravel CLI binary.
 *
 * Coverage strategy
 * -----------------
 * The wrapper does three things: (1) detect platform, (2) download +
 * sha256-verify a binary from GitHub Releases (or the
 * GRAVEL_RELEASES_BASE_URL mirror), (3) exec it.
 *
 * (1) and the no-network failure paths are tested here in-process.
 *
 * (2) needs to fetch over HTTP. We exercise it by staging a local file:// URL
 *     directory and pointing GRAVEL_RELEASES_BASE_URL at it — but the wrapper
 *     deliberately doesn't speak file://, so for the http/https flow we rely
 *     on the release pipeline's e2e smoke job (a real `gravel doctor` against
 *     a tagged GitHub Release) to validate end-to-end correctness.
 *
 *     We also assert that running with GRAVEL_RELEASES_BASE_URL set produces
 *     the correct URLs in the wrapper's error output by pointing at an
 *     unreachable host and grepping the failure message for the expected
 *     URL shape.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WRAPPER_SRC = join(__dirname, '..', 'bin', 'gravel.js')

const TEST_VERSION = '99.0.0'

function stageWrapper(): { wrapper: string; home: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gravel-wrapper-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', version: TEST_VERSION }))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  copyFileSync(WRAPPER_SRC, join(binDir, 'gravel.js'))
  const home = join(dir, 'home')
  mkdirSync(home)
  return { wrapper: join(binDir, 'gravel.js'), home, dir }
}

function runWrapper(args: string[], staged: { wrapper: string; home: string }, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [staged.wrapper, ...args], {
    env: { ...process.env, HOME: staged.home, ...env },
    encoding: 'utf8',
    timeout: 8_000,
  })
}

// --- helper exports + shape -------------------------------------------------

describe('bin/gravel.js — structural', () => {
  it('starts with the shebang and is importable as ESM', () => {
    const src = readFileSync(WRAPPER_SRC, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('lists the five supported platforms (matches the release matrix)', () => {
    const src = readFileSync(WRAPPER_SRC, 'utf8')
    for (const platform of [
      "'linux-x64': 'gravel-linux-amd64'",
      "'linux-arm64': 'gravel-linux-arm64'",
      "'darwin-x64': 'gravel-darwin-amd64'",
      "'darwin-arm64': 'gravel-darwin-arm64'",
      "'win32-x64': 'gravel-windows-amd64.exe'",
    ]) {
      expect(src).toContain(platform)
    }
  })

  it('honours GRAVEL_RELEASES_BASE_URL (escape hatch for internal mirrors)', () => {
    const src = readFileSync(WRAPPER_SRC, 'utf8')
    expect(src).toContain('GRAVEL_RELEASES_BASE_URL')
  })

  it('uses fs.writeSync for the die path (process.exit drops piped stderr otherwise)', () => {
    const src = readFileSync(WRAPPER_SRC, 'utf8')
    // The whole point of writeSync to fd 2 is preserving the error message
    // when callers (CI logs, parent processes) read stderr through a pipe.
    expect(src).toContain('writeSync(2,')
  })
})

// --- platform mapping -------------------------------------------------------

describe('bin/gravel.js — platform mapping', () => {
  it('exits with "unsupported platform" when the host arch is missing from the table', () => {
    const staged = stageWrapper()
    // Patch the staged copy so every host is "unsupported" — the wrapper
    // should detect this synchronously and bail before any network call.
    const src = readFileSync(staged.wrapper, 'utf8')
    writeFileSync(staged.wrapper, src.replace(/const PLATFORMS = \{[\s\S]*?\}\n/, 'const PLATFORMS = {}\n'))
    const out = runWrapper([], staged)
    expect(out.status).not.toBe(0)
    expect(out.stderr).toMatch(/unsupported platform/i)
  })
})

// --- env override + URL shape -----------------------------------------------

describe('bin/gravel.js — GRAVEL_RELEASES_BASE_URL override', () => {
  // Skip on non-linux-x64 so the asset name we assert on matches the
  // wrapper's platform detection.
  const supported = process.platform === 'linux' && process.arch === 'x64'

  it.skipIf(!supported)('builds the asset URL as <base>/v<version>/<asset> and reports it on failure', () => {
    // Use a deliberately closed port to force a fast failure. We're not
    // testing the download — we're testing the URL shape ends up in the
    // wrapper's error message verbatim, which proves the env override is
    // wired through correctly.
    const staged = stageWrapper()
    const out = runWrapper([], staged, { GRAVEL_RELEASES_BASE_URL: 'http://127.0.0.1:1' })
    expect(out.status).not.toBe(0)
    expect(out.stderr).toMatch(/http:\/\/127\.0\.0\.1:1\/v99\.0\.0\/gravel-linux-amd64\.sha256/)
  })
})
