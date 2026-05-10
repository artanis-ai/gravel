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
      prompts: false,
      traces: false,
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
      prompts: false,
      traces: false,
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
      prompts: false,
      traces: false,
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
      prompts: false,
      traces: false,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.authMode).toBe('local')
    expect(summary.apiKey).toBeNull()
    expect(summary.projectId).toBeNull()
  })

  it('prompts-only pillar: no migrate, no instrumentation, manifest scanned', async () => {
    const cwd = await mkSandbox()
    // Plant a prompt file so the manifest scan picks it up. The fast-scan
    // walks conventional dirs (prompts/, templates/, etc.) for .md/.txt.
    await fs.mkdir(join(cwd, 'prompts'), { recursive: true })
    await fs.writeFile(join(cwd, 'prompts', 'system.md'), 'You are a careful assistant.')

    const summary = await runWizard({
      cwd,
      prompts: true,
      traces: false,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.pillars.prompts).toBe(true)
    expect(summary.pillars.traces).toBe(false)
    expect(summary.ranBootstrap).toBe(false)
    // Manifest got written.
    const manifest = JSON.parse(await fs.readFile(join(cwd, '.gravel/manifest.json'), 'utf8'))
    expect(manifest.prompts.length).toBeGreaterThanOrEqual(1)
  })

  it('traces-only pillar: no manifest, no hook, no scan side-effects', async () => {
    const cwd = await mkSandbox()
    await fs.writeFile(join(cwd, 'system.md'), 'You are a careful assistant.')

    // No DATABASE_URL in this sandbox, so the traces pillar's pre-flight
    // probe bails with "no-url" and the pillar skips bootstrap +
    // instrumentation cleanly — no need for granular skip flags.
    const summary = await runWizard({
      cwd,
      prompts: false,
      traces: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.pillars.prompts).toBe(false)
    expect(summary.pillars.traces).toBe(true)
    // Manifest should NOT have been touched.
    let manifestExists = true
    try {
      await fs.stat(join(cwd, '.gravel/manifest.json'))
    } catch {
      manifestExists = false
    }
    expect(manifestExists).toBe(false)
  })

  it('neither pillar: dashboard still mounts, no manifest or DB side-effects', async () => {
    // The dashboard pillar is unconditional — even with both feature
    // pillars off, the embedded admin UI lands so the user can wire
    // them up later. (The fixture verify harness relies on this:
    // install journey runs `--no-prompts --no-traces` to test the
    // mount + .env write in isolation.)
    const cwd = await mkSandbox()

    const summary = await runWizard({
      cwd,
      prompts: false,
      traces: false,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.pillars.dashboard).toBe(true)
    expect(summary.pillars.prompts).toBe(false)
    expect(summary.pillars.traces).toBe(false)
    expect(summary.passwordGenerated).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(summary.mountedRoute).not.toBeNull()
    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).toMatch(/GRAVEL_ADMIN_PASSWORD=/)
    let manifestExists = true
    try {
      await fs.stat(join(cwd, '.gravel/manifest.json'))
    } catch {
      manifestExists = false
    }
    expect(manifestExists).toBe(false)
  })
})
