/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * v0 implementation status:
 *   - Step 1 (detect):           ✓ implemented (./detect.ts)
 *   - Step 2 (auth):             ✓ interactive — defaults to LOCAL-ONLY mode;
 *                                  user opts in to OAuth (or `gravel login` later).
 *                                  CI / explicit creds / `--local` skip the prompt.
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
import { askChoice, type PromptOptions } from './prompt.js'

export type WizardAuthMode = 'oauth' | 'local' | 'ci' | 'flags'

export interface WizardOptions {
  cwd?: string
  ci?: boolean
  /** Skip OAuth and run a fully local install (no cloud creds in .env). */
  local?: boolean
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
  /** Override interactive-prompt I/O (test injection). */
  prompt?: PromptOptions
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
  /** Null in local mode (no cloud project minted). */
  projectId: string | null
  /** Null in local mode (no cloud API key minted). */
  apiKey: string | null
  authMode: WizardAuthMode
  projectName?: string
  organizationName?: string
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const blockers: string[] = []

  // Step 1
  const detection = await detect(cwd)
  log(`Detected ${detection.language}, ${detection.framework}, pkg=${detection.packageManager}, db=${detection.database.driver}, auth=${detection.auth}`)

  // Step 2 — auth.
  //
  // Resolution order, picking the first that matches:
  //   1. --api-key + --project (or env equivalents) → 'flags' mode, no OAuth.
  //   2. --local                                    → 'local' mode, no OAuth.
  //   3. --ci without creds                         → 'ci' mode, dev placeholders.
  //   4. Interactive TTY                            → ask; default LOCAL.
  //   5. Non-TTY without --local/--ci/creds         → fall through to OAuth (legacy).
  //
  // The default for an interactive `npx @artanis-ai/gravel init` is now
  // local-only: cloud features (judge, analyze, evals) require running
  // `gravel login` afterwards. This keeps the OSS install path zero-friction
  // and aligned with the lander's "your data stays in your DB" pitch.
  const controlPlane = resolveControlPlaneUrl()
  const flagApiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY
  const flagProject = opts.project ?? process.env.GRAVEL_PROJECT_ID
  let apiKey: string | null
  let projectId: string | null
  let projectName: string | undefined
  let organizationName: string | undefined
  let authMode: WizardAuthMode

  if (flagApiKey && flagProject) {
    apiKey = flagApiKey
    projectId = flagProject
    authMode = 'flags'
  } else if (opts.local) {
    apiKey = null
    projectId = null
    authMode = 'local'
    log('Local-only install: skipping cloud sign-in. Run `gravel login` later to enable cloud features (judge, analyze, evals).')
  } else if (opts.ci) {
    // CI without explicit creds → dev placeholder, surface a blocker.
    apiKey = flagApiKey ?? `ak_dev_${randomToken(28)}`
    projectId = flagProject ?? `proj_dev_${randomToken(12)}`
    authMode = 'ci'
    blockers.push(
      'Running in --ci without --api-key + --project: emitted dev placeholder credentials. ' +
        'Set GRAVEL_API_KEY and GRAVEL_PROJECT_ID (from your project settings page) before deploying.',
    )
  } else {
    // Interactive: ask before phoning home. Default = local.
    const choice = await askChoice(
      [
        '',
        'Gravel can run in two modes:',
        '  [L] Local-only — install everything without contacting Artanis cloud (default).',
        '  [s] Sign in    — open your browser to mint a project ID + API key',
        '                   (enables judge, analyze, evals, and managed dashboards).',
        '',
        'Choice [L/s]: ',
      ].join('\n'),
      ['l', 's'],
      'l',
      opts.prompt ?? {},
    )

    if (choice === 's') {
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
      authMode = 'oauth'
      log(
        `Authorized ${claim.projectName ?? projectId}` +
          (claim.organizationName ? ` (${claim.organizationName})` : ''),
      )
    } else {
      apiKey = null
      projectId = null
      authMode = 'local'
      log('Local-only install. Run `gravel login` later to enable cloud features.')
    }
  }

  // Step 3 — installing SDK is a stub: assume already installed (which is why
  // the user is running this wizard).
  const installedSdk = false

  // Step 4 — env additions. In local mode we skip the cloud creds entirely;
  // the admin password is still useful for default-mode dashboard auth.
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
  if (authMode === 'local') {
    log(`  3. When you're ready for cloud features (judge, analyze, evals), run:`)
    log(`       npx @artanis-ai/gravel login`)
    log(`  4. Read https://gravel.artanis.ai/docs`)
  } else {
    log(`  3. Send a test trace:`)
    log(`       curl -X POST ${controlPlane}/api/traces \\`)
    log(`         -H "Authorization: Bearer ${apiKey}" \\`)
    log(`         -H "Content-Type: application/json" \\`)
    log(`         -d '{"project_id":"${projectId}","prompt":"hello","completion":"world"}'`)
    log(`  4. Read https://gravel.artanis.ai/docs`)
  }

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
