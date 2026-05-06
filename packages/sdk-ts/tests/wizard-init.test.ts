/**
 * Tests for src/wizard/index.ts — the orchestrator. We focus on:
 *   - default install is fully local (no cloud creds in .env, no fetch)
 *   - --api-key + --project bypass to "flags" mode and bake creds into .env
 *   - env var fallback for GRAVEL_API_KEY + GRAVEL_PROJECT_ID
 *
 * Cloud sign-in is *never* triggered from the CLI — the dashboard owns it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('default install is fully local: no fetch, no cloud creds in .env', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('the CLI must never call out to the cloud — sign-in is dashboard-side')
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
    expect(summary.projectId).toBeNull()
    expect(summary.passwordGenerated).toMatch(/^[A-Za-z0-9]{32}$/)

    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).not.toContain('GRAVEL_API_KEY')
    expect(envContents).not.toContain('GRAVEL_PROJECT_ID')
    expect(envContents).toMatch(/GRAVEL_ADMIN_PASSWORD=[A-Za-z0-9]{32}/)
  })

  it('--api-key + --project bake creds into .env (flags mode)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in flags mode')
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
    expect(summary.authMode).toBe('flags')
    expect(summary.apiKey).toBe('ak_supplied_123')
    expect(summary.projectId).toBe('proj_supplied_456')
    expect(summary.passwordGenerated).toMatch(/^[A-Za-z0-9]{32}$/)

    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).toContain('GRAVEL_API_KEY=ak_supplied_123')
    expect(envContents).toContain('GRAVEL_PROJECT_ID=proj_supplied_456')
    expect(envContents).toMatch(/GRAVEL_ADMIN_PASSWORD=[A-Za-z0-9]{32}/)
  })

  it('reads creds from env vars instead of flags', async () => {
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
    expect(summary.authMode).toBe('flags')
    expect(summary.apiKey).toBe('ak_env_999')
    expect(summary.projectId).toBe('proj_env_888')
  })

  it('only api-key without project still falls back to local', async () => {
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      apiKey: 'ak_orphan',
      noMigrate: true,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.authMode).toBe('local')
    expect(summary.apiKey).toBeNull()
    expect(summary.projectId).toBeNull()
  })
})
