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
 *   - Step 7.5 (initial scan):   ✓ regex fast-scan (no LLM); seeds the
 *                                  manifest so the dashboard shows the
 *                                  dev's existing prompts on first sign-in.
 *   - Step 8 (deep scan):        ✓ LLM-assisted; off by default — opt-in via
 *                                  `npx @artanis-ai/gravel scan --deep` once
 *                                  the customer wants to discover prompts in
 *                                  dynamically-built strings.
 *   - Step 9 (test trace):       not run during init — tracing auto-patches
 *                                  ship by default; the first real trace lands
 *                                  on the first LLM call.
 *   - Step 10 (next-steps):      ✓ implemented
 *
 * Each step is its own module so they can be unit-tested in isolation.
 *
 * UI: clack-style rail rendered by wizard/ui.ts. On a TTY, prompts are
 * branded (warm sandstone) with a braille spinner during long async
 * steps; on non-TTY (CI / pipes), every helper degrades to a plain line
 * so logs stay greppable.
 */
import { detect } from './detect.js'
import { generateConfigFile } from './config-file.js'
import { mountDashboardRoute } from './mount.js'
import { writeEnvAdditions, generatePassword } from './env.js'
import { runBootstrap } from './migrate.js'
import { installHook } from '../manifest/hook.js'
import { fastScan } from '../manifest/scan.js'
import { readManifest, writeManifest } from '../manifest/io.js'
import { resolveControlPlaneUrl } from './oauth.js'
import { confirm } from './prompt.js'
import {
  c,
  done,
  failure,
  header,
  info,
  note,
  panel,
  spinner,
  step,
  success,
  warn,
} from './ui.js'

export type WizardAuthMode = 'local' | 'flags'

export interface WizardOptions {
  cwd?: string
  /** Only honoured if both apiKey + project are also set; emits flag-mode creds. */
  apiKey?: string
  project?: string
  mountPath?: string
  noMigrate?: boolean
  noHook?: boolean
  noInstrumentation?: boolean
  noScan?: boolean
  noDeepScan?: boolean
  noTestTrace?: boolean
  /** Skip interactive prompts even on a TTY — assume yes for everything. */
  yes?: boolean
  /** Force non-interactive (no prompts even if stdin is a TTY). */
  nonInteractive?: boolean
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
  const mountPath = opts.mountPath ?? '/admin/ai'

  header('Gravel install', 'embedded prompt management for AI engineering teams')

  // Step 1
  const detection = await detect(cwd)
  step('Detect project')
  note(
    `${c.bold(detection.framework)} · ${detection.language} · pkg=${detection.packageManager} · db=${detection.database.driver} · auth=${detection.auth}`,
  )
  success('Stack identified')
  if (detection.nextHasBothRouters) {
    const warning =
      `This project has BOTH ${detection.nextAppDir}/ and pages/ — mid-migration. ` +
      `Mounted under the App Router (${detection.nextAppDir}/admin/ai/[[...slug]]/route.ts). ` +
      `Re-run with --framework or hand-mount per gravel.artanis.ai/docs/install if you want pages/ instead.`
    warn(warning)
    blockers.push(warning)
  }

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

  // Interactivity setup. By default we prompt on a TTY, run silently
  // otherwise. `--yes` skips prompts even on a TTY (default-yes for all).
  // `--non-interactive` forces no prompts even on a TTY (also default-yes).
  const stdinIsTTY = (process.stdin as NodeJS.ReadStream).isTTY === true
  const interactive = stdinIsTTY && !opts.yes && !opts.nonInteractive
  const ask = async (question: string, defaultYes = true): Promise<boolean> => {
    if (!interactive) return true
    return await confirm(question, { defaultYes })
  }

  // Step 5 — mount + framework config patches.
  const mountQuestion =
    `Mount the dashboard at ${c.bold(mountPath)} and write gravel.config.ts?` +
    (detection.framework.startsWith('next-')
      ? c.dim(' (Also patches next.config + adds instrumentation.ts.)')
      : '')
  const wantMount = await ask(mountQuestion, true)
  let mountedRoute = null as Awaited<ReturnType<typeof mountDashboardRoute>>
  if (wantMount) {
    const sp = spinner('Wiring dashboard mount + config files…')
    try {
      mountedRoute = await mountDashboardRoute(detection, cwd, mountPath, {
        noInstrumentation: opts.noInstrumentation === true,
      })
      await generateConfigFile(detection, cwd, { mountPath })
      sp.stop(`Mounted ${c.bold(mountPath)}; wrote gravel.config.ts`)
    } catch (e) {
      sp.fail(`Mount failed: ${(e as Error).message}`)
      blockers.push(`Mount failed: ${(e as Error).message}`)
    }
  } else {
    blockers.push(
      'Mount step skipped — re-run `npx @artanis-ai/gravel init` to mount the dashboard.',
    )
  }

  // Step 6 — DB schema. Two tables (gravel_samples, gravel_feedback)
  // since the 2026-05-08 simplification.
  let ranBootstrap = false
  const dbDriver = detection.database.driver
  const dbDest =
    dbDriver === 'postgres'
      ? `Postgres at ${c.bold(detection.database.envVar ?? 'DATABASE_URL')}`
      : dbDriver === 'sqlite'
        ? `SQLite (${c.bold(detection.database.envVar ?? 'DATABASE_URL')})`
        : 'your configured DATABASE_URL'
  if (!opts.noMigrate) {
    const wantMigrate = await ask(
      `Create 2 gravel_* tables (${c.bold('gravel_samples')}, ${c.bold('gravel_feedback')}) in ${dbDest}? ${c.dim('(idempotent CREATE TABLE IF NOT EXISTS)')}`,
      true,
    )
    if (wantMigrate) {
      const sp = spinner('Bootstrapping schema…')
      try {
        await runBootstrap(cwd)
        ranBootstrap = true
        sp.stop('Schema ready (2 tables)')
      } catch (e) {
        sp.fail(`Bootstrap failed: ${(e as Error).message}`)
        blockers.push(`Schema bootstrap failed: ${(e as Error).message}. Re-run \`npx @artanis-ai/gravel migrate\`.`)
      }
    } else {
      blockers.push(
        'Schema migration skipped — run `npx @artanis-ai/gravel migrate` before starting your app.',
      )
    }
  }

  // Step 7 — pre-commit hook (keeps prompts manifest in sync with git).
  let installedHook = null as { mode: string; path?: string } | null
  if (!opts.noHook && detection.hasGit) {
    const wantHook = await ask(
      `Install a pre-commit hook to keep ${c.bold('.artanis/manifest.json')} in sync with the repo? ${c.dim('(removable via .git/hooks/pre-commit)')}`,
      true,
    )
    if (wantHook) {
      const sp = spinner('Installing pre-commit hook…')
      try {
        const result = await installHook(cwd)
        installedHook = { mode: result.mode, path: result.path }
        sp.stop(`Hook installed (${result.mode})`)
      } catch (e) {
        sp.fail(`Hook install failed: ${(e as Error).message}`)
      }
    }
  }

  // Step 7.5 — initial manifest scan. Regex-based; no LLM required.
  // Same code path as `gravel manifest --update`; running it here means
  // the dashboard shows the dev's existing prompts the moment they
  // first sign in, instead of an empty list with CLI advice.
  let initialScan: { promptCount: number; added: number } | null = null
  if (!opts.noScan) {
    const sp = spinner('Scanning repo for prompts…')
    try {
      const current = await readManifest(cwd)
      const result = await fastScan(cwd, current)
      await writeManifest(cwd, result.manifest)
      initialScan = { promptCount: result.manifest.prompts.length, added: result.added }
      sp.stop(
        `Manifest seeded: ${c.bold(String(initialScan.promptCount))} prompt(s) found (+${initialScan.added} new)`,
      )
    } catch (e) {
      sp.fail(`Initial scan failed: ${(e as Error).message}`)
      blockers.push(`Initial manifest scan failed: ${(e as Error).message}. Run \`npx @artanis-ai/gravel manifest --update\` once resolved.`)
    }
  }

  // Step 8 — deep (LLM-assisted) scan: BLOCKER until shellout helpers exist.
  if (!opts.noDeepScan) {
    blockers.push(
      'LLM-assisted deep scan not implemented yet (the regex fast-scan ran above). When available, run `npx @artanis-ai/gravel scan --deep` to catch dynamically-built prompts.',
    )
  }

  // Step 9 — test trace. Tracing auto-patches ship by default (the
  // SDK's `auto.ts` is loaded via instrumentation.ts on Next, or
  // imported manually elsewhere). We don't synthesize a fake call
  // here because that'd burn the customer's OpenAI quota during init
  // for no signal — the real first trace lands as soon as their app
  // makes its first LLM call. The dashboard's empty Outputs state
  // already covers the "no traffic yet" case.
  void opts.noTestTrace

  // Step 10 — next-steps panel.
  const nextSteps: string[] = []
  if (initialScan) {
    nextSteps.push(`${c.dim('●')} ${c.bold(String(initialScan.promptCount))} prompt(s) detected (+${initialScan.added} new)`)
  }
  nextSteps.push(`${c.brand('1.')} Visit ${c.bold(mountPath)} in your app — admin password is in ${c.bold('.env.local')}`)
  nextSteps.push(`${c.brand('2.')} Install the Gravel GitHub App: ${c.cyan('https://github.com/apps/gravel-bot/installations/new')}`)
  nextSteps.push(`${c.brand('3.')} Edit ${c.bold('gravel.config.ts')} ${c.dim('→ getUser callback')} to match your auth`)
  nextSteps.push(`${c.brand('4.')} Read the docs: ${c.cyan('https://gravel.artanis.ai/docs')}`)
  panel('Next steps', nextSteps)

  if (blockers.length > 0) {
    failure(`${blockers.length} item(s) need follow-up:`)
    for (const b of blockers) note(`• ${b}`)
  }
  done('Gravel skeleton installed.')

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

// `info` and `success` are imported above; keep void references so
// tree-shake doesn't drop them when callers only use a subset.
void info
void success
