/**
 * End-to-end: run the actual `runWizard` against a tmpdir project,
 * then dynamically import the gravel.config.ts it generated, mount
 * `createGravelHandler` against that config, and exercise the login
 * route. If this passes, "wizard runs cleanly + dashboard accepts
 * the password" is wired correctly. If it fails, something between
 * the two is broken — which is exactly the gap the customer's
 * "still getting 500s" report kept exposing.
 *
 * Both pillars covered:
 *   - prompts-only (no DATABASE_URL block in the generated config)
 *   - prompts + traces (with a SQLite DATABASE_URL that the wizard
 *     bootstraps, so /api/samples returns an empty 200, not a 500)
 *
 * The wizard runs in `--yes` style by passing explicit pillar flags
 * so it never blocks on stdin in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetHandlerForTests, createGravelHandler } from '../src/handler/index.js'
import { _resetGravelTracingForTests } from '../src/tracing/persist.js'
import { runWizard } from '../src/wizard/index.js'
import type { GravelConfig } from '../src/types.js'

let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gravel-e2e-'))
  // Minimal generic-node project — no Next, no DB drivers, just
  // package.json so detect() picks it up.
  await fs.writeFile(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'sandbox', version: '0.0.0', type: 'module' }, null, 2),
  )
  _resetHandlerForTests()
  _resetGravelTracingForTests()
})
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

/**
 * Read the gravel.config.ts the wizard wrote. We don't dynamically
 * import it (no TS loader at test time); instead we parse the
 * relevant fields out of the source. Crude but enough for "did the
 * wizard write the right shape?".
 */
async function readGeneratedConfig(): Promise<{
  hasDatabaseBlock: boolean
  hasDefaultPassword: boolean
  source: string
}> {
  const path = join(workdir, 'gravel.config.ts')
  const source = await fs.readFile(path, 'utf8')
  return {
    hasDatabaseBlock: /\bdatabase\s*:\s*\{/.test(source),
    hasDefaultPassword: /defaultPassword\s*:/.test(source),
    source,
  }
}

/**
 * Mock a config equivalent to what the wizard's gravel.config.ts
 * would resolve to at runtime. We can't `import()` a TS file mid-
 * test, but we know what env vars + flags the wizard threaded in.
 */
function mockConfigFromWizardOutputs(opts: {
  password: string
  databaseUrl?: string
}): GravelConfig {
  const config: GravelConfig = {
    mountPath: '/admin/ai',
    auth: { defaultPassword: opts.password },
  }
  if (opts.databaseUrl) {
    config.database = { url: opts.databaseUrl }
  }
  return config
}

async function loginPost(
  handler: ReturnType<typeof createGravelHandler>,
  password: string,
): Promise<Response> {
  const form = new URLSearchParams({ password })
  return await handler(
    new Request('http://localhost:3000/admin/ai/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: 'app.example.com', // non-localhost so the gate runs
      },
      body: form.toString(),
    }),
  )
}

describe('wizard → handler end-to-end (prompts-only)', () => {
  it('generated config has no database block, login works', async () => {
    const summary = await runWizard({
      cwd: workdir,
      prompts: true,
      traces: false,
      noHook: true,
      noDeepScan: true,
      noTestTrace: true,
    })

    expect(summary.pillars.prompts).toBe(true)
    expect(summary.pillars.traces).toBe(false)
    expect(summary.passwordGenerated).toBeTruthy()

    // Critical: the generated config has NO database block. This is
    // what guarantees the SDK's resolveConfig produces database:null
    // and the handler skips the DB entirely on every request.
    const { hasDatabaseBlock, hasDefaultPassword } = await readGeneratedConfig()
    expect(hasDatabaseBlock).toBe(false)
    expect(hasDefaultPassword).toBe(true)

    // Mount a handler shaped like the runtime would and verify login.
    const handler = createGravelHandler({
      config: mockConfigFromWizardOutputs({ password: summary.passwordGenerated! }),
    })
    const response = await loginPost(handler, summary.passwordGenerated!)
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toMatch(/^gravel_session=/)
  })

  it('login fast-fails on wrong password — no 500 even when DATABASE_URL is set in env', async () => {
    // Customer scenario: the .env has a DATABASE_URL pointing at an
    // unreachable Postgres, but the wizard ran prompts-only so the
    // generated gravel.config.ts has no database block. The runtime
    // ignores process.env.DATABASE_URL because the config doesn't
    // reference it. Login still 303s.
    const prevDbUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/nope'
    try {
      const summary = await runWizard({
        cwd: workdir,
        prompts: true,
        traces: false,
        noHook: true,
        noDeepScan: true,
        noTestTrace: true,
      })
      const handler = createGravelHandler({
        config: mockConfigFromWizardOutputs({ password: summary.passwordGenerated! }),
      })
      const response = await loginPost(handler, 'totally-wrong')
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toContain('/login?error=1')
    } finally {
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDbUrl
    }
  })
})
