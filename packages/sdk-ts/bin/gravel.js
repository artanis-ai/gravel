#!/usr/bin/env node
// =============================================================================
// gravel — Node wrapper around the gravel CLI binary.
// =============================================================================
//
// The real wizard lives in a single Go binary published per platform at
//   https://github.com/artanis-ai/gravel/releases/download/v<X>/gravel-<os>-<arch>
//
// This file is the npm-side door: read it before you trust it. ~120 lines of
// straightforward JS, no obfuscation, no postinstall hooks.
//
// What it does, in order:
//   1. Read this package's version (from the sibling package.json) so we
//      always fetch the binary that matches the SDK semver in the user's
//      lockfile. Lockstep is enforced by the release pipeline.
//   2. Detect OS + arch via `process.platform` / `process.arch`. Map to the
//      release asset name (e.g. "gravel-darwin-arm64").
//   3. Look in `~/.cache/artanis-gravel/v<version>/` for a cached copy.
//      Hit → skip download. Miss → fetch + sha256-verify + persist.
//   4. `child_process.spawnSync` the binary with the user's argv,
//      `stdio: 'inherit'`, propagate the exit code.
//
// What it does NOT do:
//   - No postinstall script. CI runs that never invoke the CLI pay zero cost
//     (no download, no disk space).
//   - No registry detection / token exchange / OIDC fingerprinting.
//   - No anonymous analytics.
//   - No writes outside the user's $HOME cache directory.
//
// Source: https://github.com/artanis-ai/gravel/blob/main/packages/sdk-ts/bin/gravel.js
// Architecture: https://github.com/artanis-ai/gravel/blob/main/cli/DESIGN.md
// =============================================================================

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO = 'artanis-ai/gravel'

// Map process.platform/process.arch -> the GH Release asset filename.
// Unsupported platforms exit with a clear "where to look" message rather
// than a confusing "no such file or directory".
const PLATFORMS = {
  'linux-x64': 'gravel-linux-amd64',
  'linux-arm64': 'gravel-linux-arm64',
  'darwin-x64': 'gravel-darwin-amd64',
  'darwin-arm64': 'gravel-darwin-arm64',
  'win32-x64': 'gravel-windows-amd64.exe',
}

main()

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const version = `v${pkg.version}`

  const key = `${process.platform}-${process.arch}`
  const asset = PLATFORMS[key]
  if (!asset) {
    die(`unsupported platform '${key}'. See https://github.com/${REPO}/releases.`)
  }

  const cacheDir = join(homedir(), '.cache', 'artanis-gravel', version)
  const binPath = join(cacheDir, asset)

  if (!existsSync(binPath)) {
    await downloadAndVerify(version, asset, cacheDir, binPath)
  }

  // Pass-through invocation. `stdio: 'inherit'` keeps the TTY attached so the
  // wizard's prompts work normally. Exit code propagates so callers can gate
  // CI on `gravel doctor` without parsing output.
  const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' })
  if (result.error) die(`failed to run ${binPath}: ${result.error.message}`)
  process.exit(result.status ?? 1)
}

async function downloadAndVerify(version, asset, cacheDir, binPath) {
  writeSync(2, `[gravel] fetching ${asset} ${version}…\n`)
  mkdirSync(cacheDir, { recursive: true })

  // Default base URL is the GH Release; override via GRAVEL_RELEASES_BASE_URL
  // for tests + for users who mirror the release assets internally. The env
  // var should NOT include the version (we append it ourselves), so a mirror
  // can serve `v0.4.0/gravel-...` etc.
  const baseRoot =
    process.env.GRAVEL_RELEASES_BASE_URL || `https://github.com/${REPO}/releases/download`
  const base = `${baseRoot}/${version}`
  const binUrl = `${base}/${asset}`
  const shaUrl = `${base}/${asset}.sha256`

  let expectedSha
  try {
    const shaBody = (await get(shaUrl)).toString('utf8')
    expectedSha = shaBody.trim().split(/\s+/)[0]
  } catch (e) {
    die(`couldn't fetch ${shaUrl}: ${e.message}`)
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    die(`malformed sha256 from ${shaUrl}: ${expectedSha}`)
  }

  let binBuf
  try {
    binBuf = await get(binUrl)
  } catch (e) {
    die(`couldn't fetch ${binUrl}: ${e.message}`)
  }

  const actualSha = createHash('sha256').update(binBuf).digest('hex')
  if (actualSha !== expectedSha) {
    die(`sha256 mismatch for ${asset}: expected ${expectedSha}, got ${actualSha}`)
  }

  // Atomic write: tmp → rename so a crashed download never leaves a
  // half-written binary in the cache that would fail to exec next time.
  const tmp = binPath + '.tmp'
  writeFileSync(tmp, binBuf, { mode: 0o755 })
  renameSync(tmp, binPath)
  chmodSync(binPath, 0o755)
}

// HTTP(S) GET that follows redirects (GitHub Releases redirect through
// S3-backed hosts) and returns the body as a Buffer. Picks http vs https
// based on the URL protocol so the GRAVEL_RELEASES_BASE_URL override can
// point at a plaintext internal mirror.
//
// `family: 4` forces IPv4 resolution. Some hosts (Linux runners under
// certain libnss configs, dual-stack macOS setups) resolve `localhost` /
// `127.0.0.1` to `::1` first, which a server listening on IPv4-only times
// out connecting to. GitHub Releases happily serve both stacks, so
// pinning IPv4 here costs us nothing and unblocks the mirror-host case.
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      family: 4,
      headers: { 'user-agent': 'gravel-npm-wrapper' },
    }
    client
      .get(options, (res) => {
        const code = res.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          if (redirects > 5) {
            reject(new Error(`too many redirects fetching ${url}`))
            res.resume()
            return
          }
          res.resume()
          get(res.headers.location, redirects + 1).then(resolve, reject)
          return
        }
        if (code !== 200) {
          reject(new Error(`HTTP ${code} fetching ${url}`))
          res.resume()
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

// die writes to fd 2 synchronously (fs.writeSync) rather than via
// process.stderr.write because process.exit() drops the pipe buffer
// before async writes drain — meaning callers reading from a pipe
// (CI logs, parent processes) would see a truncated error.
function die(msg) {
  writeSync(2, `[gravel] ${msg}\n`)
  process.exit(1)
}
