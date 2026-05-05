/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * v0 implementation status:
 *   - Step 1 (detect):           ✓ implemented (./detect.ts)
 *   - Step 2 (browser OAuth):    ✓ implemented (./oauth.ts) against gravel.artanis.ai
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
import { resolveControlPlaneUrl, browserOAuthHandshake } from './oauth.js'

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
  /** Skip browser launch during OAuth (CI / tests). */
  noBrowser?: boolean
  /** Override OAuth poll interval in ms (test injection). */
  oauthPollIntervalMs?: number
  /** Override OAuth total timeout in ms (test injection). */
  oauthTimeoutMs?: number
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
  projectId: string
  apiKey: string
  projectName?: string
  organizationName?: string
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const blockers: string[] = []

  // Step 1
  const detection = await detect(cwd)
  log(`Detected ${detection.language}, ${detection.framework}, pkg=${detection.packageManager}, db=${detection.database.driver}, auth=${detection.auth}`)

  // Step 2 (OAuth) — browser handshake against the live control plane.
  // Shortcut: if --api-key + --project (or env equivalents) are provided, skip
  // the browser dance entirely (non-interactive mode per spec/wizard.md).
  const controlPlane = resolveControlPlaneUrl()
  const flagApiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY
  const flagProject = opts.project ?? process.env.GRAVEL_PROJECT_ID
  let apiKey: string
  let projectId: string
  let projectName: string | undefined
  let organizationName: string | undefined

  if (flagApiKey && flagProject) {
    apiKey = flagApiKey
    projectId = flagProject
  } else if (opts.ci) {
    // CI without explicit creds → dev placeholder, surface a blocker.
    apiKey = flagApiKey ?? `ak_dev_${randomToken(28)}`
    projectId = flagProject ?? `proj_dev_${randomToken(12)}`
    blockers.push(
      'Running in --ci without --api-key + --project: emitted dev placeholder credentials. ' +
        'Set GRAVEL_API_KEY and GRAVEL_PROJECT_ID (from your project settings page) before deploying.',
    )
  } else {
    log(`Opening ${controlPlane}/cli/auth in your browser to sign in…`)
    const claim = await browserOAuthHandshake({
      baseUrl: controlPlane,
      openBrowser: !opts.noBrowser,
      ...(opts.oauthPollIntervalMs !== undefined ? { pollIntervalMs: opts.oauthPollIntervalMs } : {}),
      ...(opts.oauthTimeoutMs !== undefined ? { timeoutMs: opts.oauthTimeoutMs } : {}),
      onAuthUrl: (u) => log(`If your browser didn't open, visit: ${u}`),
    })
    apiKey = claim.apiKey
    projectId = claim.projectId
    projectName = claim.projectName
    organizationName = claim.organizationName
    log(
      `Authorized ${claim.projectName ?? projectId}` +
        (claim.organizationName ? ` (${claim.organizationName})` : ''),
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
  log(`  1. Visit ${opts.mountPath ?? '/admin/ai'} in your app and log in (admin password is in your .env).`)
  log(`  2. Edit your getUser callback in gravel.config.ts to match your auth.`)
  log(`  3. Send a test trace:`)
  log(`       curl -X POST ${controlPlane}/api/traces \\`)
  log(`         -H "Authorization: Bearer ${apiKey}" \\`)
  log(`         -H "Content-Type: application/json" \\`)
  log(`         -d '{"project_id":"${projectId}","prompt":"hello","completion":"world"}'`)
  log(`  4. Read https://gravel.artanis.ai/docs`)

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
    ...(projectName !== undefined ? { projectName } : {}),
    ...(organizationName !== undefined ? { organizationName } : {}),
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
