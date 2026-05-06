/**
 * Tests for src/cli/login.ts — the lazy-auth path. We focus on:
 *   - OAuth runs and creds get appended to .env.local
 *   - Existing GRAVEL_PROJECT_ID + GRAVEL_API_KEY in .env short-circuits OAuth
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLogin } from '../src/cli/login.js'

async function mkSandbox(extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gravel-login-'))
  await fs.writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'sandbox', version: '0.0.0', type: 'module' }, null, 2),
  )
  for (const [name, content] of Object.entries(extra)) {
    await fs.writeFile(join(dir, name), content)
  }
  return dir
}

describe('runLogin', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    delete process.env.GRAVEL_CONTROL_PLANE_URL
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('runs OAuth and writes creds to .env.local when none are set', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/cli/auth/init')) {
        return new Response(JSON.stringify({ ok: true, expires_in_seconds: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/cli/auth/claim')) {
        return new Response(
          JSON.stringify({
            project_id: 'proj_login_1',
            api_key: 'ak_login_1',
            project_name: 'Sandbox',
            organization_name: 'TestOrg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const cwd = await mkSandbox()

    const summary = await runLogin({
      cwd,
      noBrowser: true,
      oauthPollIntervalMs: 5,
      oauthTimeoutMs: 5_000,
    })

    expect(summary.alreadyConfigured).toBe(false)
    expect(summary.projectId).toBe('proj_login_1')
    expect(summary.apiKey).toBe('ak_login_1')

    const envContents = await fs.readFile(join(cwd, '.env.local'), 'utf8')
    expect(envContents).toContain('GRAVEL_PROJECT_ID=proj_login_1')
    expect(envContents).toContain('GRAVEL_API_KEY=ak_login_1')
  })

  it('short-circuits when GRAVEL_PROJECT_ID + GRAVEL_API_KEY are already in .env', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called when env is already configured')
    })
    const cwd = await mkSandbox({
      '.env.local': 'GRAVEL_PROJECT_ID=existing\nGRAVEL_API_KEY=existing\n',
    })

    const summary = await runLogin({ cwd, noBrowser: true })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.alreadyConfigured).toBe(true)
    expect(summary.envFile).toBe('.env.local')
  })

  it('detects .env when .env.local is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called when env is already configured')
    })
    const cwd = await mkSandbox({
      '.env': 'GRAVEL_PROJECT_ID=existing\nGRAVEL_API_KEY=existing\n',
    })

    const summary = await runLogin({ cwd, noBrowser: true })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(summary.alreadyConfigured).toBe(true)
    expect(summary.envFile).toBe('.env')
  })
})
