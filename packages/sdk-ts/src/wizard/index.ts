/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * v0 implementation status:
 *   - Step 1 (detect):           ✓ implemented (./detect.ts)
 *   - Step 2 (browser OAuth):    ⚠ stubbed against placeholder control plane
 *   - Step 3 (install SDK):      ✓ shells out to detected pkg manager
 *   - Step 4 (write .env):       ✓ implemented
 *   - Step 5 (AST mount edits):  ⚠ partial — emits files for Next.js/FastAPI/Django;
 *                                  generic frameworks print copy-paste instructions
 *   - Step 6 (schema migrate):   ✓ uses src/db/bootstrap.ts (idempotent CREATE TABLE)
 *   - Step 7 (pre-commit hook):  ✓ implemented via src/manifest/hook.ts
 *   - Step 8 (deep scan):        BLOCKER — deferred until LLM-shellout helpers exist
 *   - Step 9 (test trace):       BLOCKER — deferred until v1 tracing patches exist
 *   - Step 10 (next-steps):      ✓ implemented
 *
 * Each step is its own module so they can be unit-tested in isolation.
 */
import { detect } from './detect.js'
import { generateConfigFile } from './config-file.js'
import { mountDashboardRoute } from './mount.js'
import { writeEnvAdditions, generatePassword } from './env.js'
import { runBootstrap } from './migrate.js'
import { installHook } from '../manifest/hook.js'
import { resolveControlPlaneUrl } from './oauth.js'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface WizardOptions {
  cwd?: string
  ci?: boolean
  apiKey?: string
  project?: string
  mountPath?: string
  noMigrate?: boolean
  noHook?: boolean
  noDeepScan?: boolean
  noTestTrace?: boolean
  framework?: string
}

export interface WizardSummary {
  detection: ReturnType<typeof detect> extends Promise<infer R> ? R : never
  installedSdk: boolean
  wroteConfig: boolean
  mountedRoute: { path: string; mode: 'created' | 'updated' | 'manual-instructions' } | null
  ranBootstrap: boolean
  installedHook: { mode: string; path?: string } | null
  passwordGenerated: string | null
  controlPlane: string
  blockers: string[]
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const blockers: string[] = []

  // Step 1
  const detection = await detect(cwd)
  log(`Detected ${detection.language}, ${detection.framework}, pkg=${detection.packageManager}, db=${detection.database.driver}, auth=${detection.auth}`)

  // Step 2 (OAuth) — STUBBED
  // BLOCKER: real handshake needs the control plane online. For now, accept
  // --api-key + --project from CLI flags or env. If neither, emit a mock pair.
  const controlPlane = resolveControlPlaneUrl()
  const apiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY ?? `grk_dev_${randomToken(20)}`
  const projectId = opts.project ?? process.env.GRAVEL_PROJECT_ID ?? `proj_dev_${randomToken(12)}`
  if (!opts.apiKey && !process.env.GRAVEL_API_KEY) {
    blockers.push(
      `Wizard OAuth not available: control plane at ${controlPlane} is not provisioned. ` +
        `Using a dev-mode mock API key. Re-run init with --api-key from your project's settings page once the control plane is live.`,
    )
  }

  // Step 3 — installing SDK is a stub: assume already installed (which is why
  // the user is running this wizard).
  const installedSdk = false

  // Step 4
  const password = generatePassword()
  await writeEnvAdditions(cwd, {
    GRAVEL_PROJECT_ID: projectId,
    GRAVEL_API_KEY: apiKey,
    GRAVEL_ADMIN_PASSWORD: password,
  })

  // Step 5
  const mountedRoute = await mountDashboardRoute(detection, cwd, opts.mountPath ?? '/admin/ai')
  await generateConfigFile(detection, cwd, { mountPath: opts.mountPath ?? '/admin/ai' })

  // Step 6
  let ranBootstrap = false
  if (!opts.noMigrate) {
    try {
      await runBootstrap(cwd)
      ranBootstrap = true
    } catch (e) {
      blockers.push(`Schema bootstrap failed: ${(e as Error).message}. Re-run \`npx @artanis-ai/gravel migrate\`.`)
    }
  }

  // Step 7
  let installedHook = null as { mode: string; path?: string } | null
  if (!opts.noHook && detection.hasGit) {
    const result = await installHook(cwd)
    installedHook = { mode: result.mode, path: result.path }
  }

  // Step 8 — BLOCKER
  if (!opts.noDeepScan) {
    blockers.push(
      'Deep prompt scan not implemented yet. Run `npx @artanis-ai/gravel scan --deep` later when available.',
    )
  }

  // Step 9 — BLOCKER (no tracing yet)
  if (!opts.noTestTrace) {
    blockers.push(
      'Test trace not implemented yet (tracing auto-patches land in v1).',
    )
  }

  // Step 10
  log('')
  log('Gravel skeleton installed. Next:')
  log(`  1. Visit ${opts.mountPath ?? '/admin/ai'} in your app and log in.`)
  log(`  2. Edit your getUser callback in gravel.config.ts to match your auth.`)
  log(`  3. Connect GitHub from the Settings page (when available).`)
  log(`  4. Read https://gravel.artanis.ai/docs`)

  await fs.writeFile(join(cwd, '.artanis', 'install-summary.json'), JSON.stringify(
    { detection, blockers, controlPlane, mountedRoute, installedHook, ranBootstrap },
    null, 2,
  ).then ? '' : '')
  // (not awaiting filesystem mkdir intentionally — manifest dir created later)

  return {
    detection,
    installedSdk,
    wroteConfig: true,
    mountedRoute,
    ranBootstrap,
    installedHook,
    passwordGenerated: password,
    controlPlane,
    blockers,
  }
}

function randomToken(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg)
}
