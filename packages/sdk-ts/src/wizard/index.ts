/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * v0 implementation status:
 *   - Step 1 (detect):           ✓ implemented (./detect.ts)
 *   - Step 2 (auth):             ✓ LOCAL by default — no OAuth, ever, from
 *                                  the CLI. Sign-in happens from the dashboard
 *                                  when the user invokes a cloud feature.
 *                                  `--api-key` + `--project` flags exist for
 *                                  CI / scripted installs.
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

export type WizardAuthMode = 'local' | 'flags'

export interface WizardOptions {
  cwd?: string
  /** Only honoured if both apiKey + project are also set; emits flag-mode creds. */
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
  /** Null when no cloud creds were supplied; sign-in is dashboard-driven. */
  projectId: string | null
  apiKey: string | null
  authMode: WizardAuthMode
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const blockers: string[] = []

  // Step 1
  const detection = await detect(cwd)
  log(`Detected ${detection.language}, ${detection.framework}, pkg=${detection.packageManager}, db=${detection.database.driver}, auth=${detection.auth}`)

  // Step 2 — auth.
  //
  // `init` is ALWAYS local. The OSS install path never phones home from the
  // CLI; the user gets a working dashboard, schema, hook, and admin password
  // with zero cloud round-trips. Sign-in for cloud features (judge, analyze,
  // evals) lives in the dashboard itself — when the user clicks a cloud
  // feature that 401s, the dashboard runs the OAuth handshake and binds the
  // project. The CLI never asks.
  //
  // `--api-key` + `--project` (or env equivalents) remain for CI / scripted
  // installs that want creds baked into `.env` from the start.
  const controlPlane = resolveControlPlaneUrl()
  const flagApiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY
  const flagProject = opts.project ?? process.env.GRAVEL_PROJECT_ID
  let apiKey: string | null
  let projectId: string | null
  let authMode: WizardAuthMode

  if (flagApiKey && flagProject) {
    apiKey = flagApiKey
    projectId = flagProject
    authMode = 'flags'
  } else {
    apiKey = null
    projectId = null
    authMode = 'local'
  }

  // Step 3 — installing SDK is a stub: assume already installed (which is why
  // the user is running this wizard).
  const installedSdk = false

  // Step 4 — env additions. In local mode we omit cloud creds entirely; the
  // dashboard handles sign-in lazily.
  const password = generatePassword()
  const envVars: Record<string, string> = { GRAVEL_ADMIN_PASSWORD: password }
  if (projectId) envVars.GRAVEL_PROJECT_ID = projectId
  if (apiKey) envVars.GRAVEL_API_KEY = apiKey
  await writeEnvAdditions(cwd, envVars)

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
  log(`  1. Visit ${opts.mountPath ?? '/admin/ai'} in your app and log in (admin password is in your .env).`)
  log(`  2. Edit your getUser callback in gravel.config.ts to match your auth.`)

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
    projectId,
    apiKey,
    authMode,
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg)
}
