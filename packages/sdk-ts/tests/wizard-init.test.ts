/**
 * Tests for src/wizard/index.ts — the orchestrator. We focus on:
 *   - the --api-key + --project shortcut bypasses OAuth (no fetch issued)
 *   - .env additions land with both creds + a fresh admin password
 *   - the OAuth-driven path picks up creds from a mocked control plane
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { runWizard } from '../src/wizard/index.js'

async function mkSandbox(extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gravel-wizard-'))
  // Minimal Node project so detect() picks "generic-node" and ESM defaults work.
  await fs.writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'sandbox', version: '0.0.0', type: 'module' }, null, 2),
  )
  for (const [name, content] of Object.entries(extra)) {
    await fs.writeFile(join(dir, name), content)
  }
  return dir
}

describe('runWizard', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    delete process.env.GRAVEL_API_KEY
    delete process.env.GRAVEL_PROJECT_ID
    delete process.env.DATABASE_URL
    delete process.env.GRAVEL_CONTROL_PLANE_URL
    // Silence wizard chatter
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('skips OAuth entirely when --api-key + --project are supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in non-interactive mode')
    })
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      apiKey: 'ak_supplied_123',
      project: 'proj_supplied_456',
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.apiKey).toBe('ak_supplied_123')
    expect(summary.projectId).toBe('proj_supplied_456')
    expect(summary.passwordGenerated).toMatch(/^[A-Za-z0-9]{32}$/)

    // .env.local should contain the supplied credentials + admin password.
    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).toContain('GRAVEL_API_KEY=ak_supplied_123')
    expect(envContents).toContain('GRAVEL_PROJECT_ID=proj_supplied_456')
    expect(envContents).toMatch(/GRAVEL_ADMIN_PASSWORD=[A-Za-z0-9]{32}/)
  })

  it('reads creds from env vars instead of prompts', async () => {
    process.env.GRAVEL_API_KEY = 'ak_env_999'
    process.env.GRAVEL_PROJECT_ID = 'proj_env_888'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called when env vars are set')
    })
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.apiKey).toBe('ak_env_999')
    expect(summary.projectId).toBe('proj_env_888')
  })

  it('runs the OAuth handshake and writes returned creds to .env', async () => {
    let claimCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) {
        return new Response(JSON.stringify({ ok: true, expires_in_seconds: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/cli/auth/claim')) {
        claimCalls++
        if (claimCalls < 2) {
          return new Response(JSON.stringify({ error: 'pending' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({
            project_id: 'proj_oauth_1',
            api_key: 'ak_oauth_1',
            project_name: 'Sandbox',
            organization_name: 'TestOrg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const cwd = await mkSandbox()

    // Default in interactive mode is now local-only; the user must press `s`
    // to opt into OAuth.
    const summary = await runWizard({
      cwd,
      noBrowser: true,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
      oauthPollIntervalMs: 5,
      oauthTimeoutMs: 5_000,
      prompt: { isTTY: true, input: makeStdin('s\n'), output: makeStdoutSink() },
    })

    expect(claimCalls).toBe(2)
    expect(summary.authMode).toBe('oauth')
    expect(summary.apiKey).toBe('ak_oauth_1')
    expect(summary.projectId).toBe('proj_oauth_1')
    expect(summary.projectName).toBe('Sandbox')
    expect(summary.organizationName).toBe('TestOrg')

    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).toContain('GRAVEL_API_KEY=ak_oauth_1')
    expect(envContents).toContain('GRAVEL_PROJECT_ID=proj_oauth_1')
  })

  it('non-TTY without flags defaults to local-only (no OAuth fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called when stdin is non-TTY')
    })
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.authMode).toBe('local')
    expect(summary.apiKey).toBeNull()
  })

  it('emits an ak_-prefixed dev placeholder in --ci without creds (not grk_dev_)', async () => {
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      ci: true,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.apiKey).not.toBeNull()
    expect(summary.apiKey!.startsWith('ak_')).toBe(true)
    expect(summary.apiKey!.startsWith('grk_dev_')).toBe(false)
    expect(summary.authMode).toBe('ci')
    expect(summary.blockers.some((b) => b.includes('--ci'))).toBe(true)
  })

  it('skips OAuth + omits cloud creds from .env when --local is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in --local mode')
    })
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      local: true,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.apiKey).toBeNull()
    expect(summary.projectId).toBeNull()
    expect(summary.authMode).toBe('local')
    expect(summary.passwordGenerated).toMatch(/^[A-Za-z0-9]{32}$/)

    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).not.toContain('GRAVEL_API_KEY')
    expect(envContents).not.toContain('GRAVEL_PROJECT_ID')
    expect(envContents).toMatch(/GRAVEL_ADMIN_PASSWORD=[A-Za-z0-9]{32}/)
  })

  it('interactive prompt: defaults to local on empty input (just-press-enter)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called when user accepts the local default')
    })
    const cwd = await mkSandbox()

    const stdin = makeStdin('\n')
    const stdout = makeStdoutSink()

    const summary = await runWizard({
      cwd,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
      prompt: { isTTY: true, input: stdin, output: stdout },
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.authMode).toBe('local')
    expect(summary.apiKey).toBeNull()
    expect(summary.projectId).toBeNull()
  })

  it('interactive prompt: explicit `s` triggers OAuth handshake', async () => {
    let claimCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) {
        return new Response(JSON.stringify({ ok: true, expires_in_seconds: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/cli/auth/claim')) {
        claimCalls++
        return new Response(
          JSON.stringify({
            project_id: 'proj_signed_in',
            api_key: 'ak_signed_in',
            project_name: 'Sandbox',
            organization_name: 'TestOrg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const cwd = await mkSandbox()
    const stdin = makeStdin('s\n')
    const stdout = makeStdoutSink()

    const summary = await runWizard({
      cwd,
      noBrowser: true,
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
      oauthPollIntervalMs: 5,
      oauthTimeoutMs: 5_000,
      prompt: { isTTY: true, input: stdin, output: stdout },
    })

    expect(claimCalls).toBeGreaterThanOrEqual(1)
    expect(summary.authMode).toBe('oauth')
    expect(summary.apiKey).toBe('ak_signed_in')
    expect(summary.projectId).toBe('proj_signed_in')
  })
})

function makeStdin(text: string): NodeJS.ReadableStream {
  return Readable.from([text])
}

function makeStdoutSink(): NodeJS.WritableStream {
  // Discard everything; readline only writes the prompt text.
  return new Writable({
    write(_chunk, _enc, cb): void {
      cb()
    },
  })
}
