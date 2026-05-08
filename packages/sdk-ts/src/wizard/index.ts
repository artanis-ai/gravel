/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * Structure (2026-05-08 refresh): the wizard is three sections, two
 * of which are independently skippable:
 *
 *   1. Dashboard — mount the embedded admin UI + write
 *      gravel.config.ts + .env password. Always runs if the user
 *      takes either of the next two pillars (it's the surface they
 *      land in).
 *   2. Prompts — manifest scan + pre-commit hook. The wedge: lets
 *      domain experts edit prompts and ship PRs. Needs no DB.
 *   3. Traces — DB tables + auto-instrumentation hooks. Captures
 *      LLM calls so the Outputs tab fills with real data.
 *
 * Either pillar can be skipped now and added later by re-running
 * `gravel init --prompts` / `--traces`. The wizard inspects existing
 * state on each run and shows an "already configured" tag instead of
 * re-asking for things that are done.
 *
 * UI: clack-style rail rendered by wizard/ui.ts. On a TTY, prompts are
 * branded with a braille spinner during long async steps; on non-TTY
 * (CI / pipes), every helper degrades to a plain line so logs stay
 * greppable.
 *
 * Step status:
 *   - Step 1 detect:           ✓ ./detect.ts
 *   - Step 2 auth:             ✓ LOCAL — no CLI sign-in. Dashboard handles
 *                                cloud auth on first cloud-feature click.
 *   - Step 3 install SDK:      ✓ assumed (caller is invoking gravel)
 *   - Step 4 .env:             ✓ writeEnvAdditions
 *   - Step 5 mount:            ✓ mountDashboardRoute (Next/FastAPI/Django + generics)
 *   - Step 6 schema:           ✓ runBootstrap — only fires if `traces` pillar selected
 *   - Step 7 pre-commit hook:  ✓ installHook — only if `prompts` pillar selected
 *   - Step 7.5 manifest scan:  ✓ fastScan — only if `prompts` pillar selected
 *   - Step 8 deep scan:        ⚠ blocker — gravel scan --deep, opt-in
 *   - Step 9 test trace:       not run during init — auto-patches handle the first real call
 *   - Step 10 next-steps:      ✓ panel
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { detect } from './detect.js'
import { generateConfigFile } from './config-file.js'
import { mountDashboardRoute, installNextTracingHooks } from './mount.js'
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
  section,
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
  /** Toggle the prompts pillar (manifest scan + hook). Default: ask, then yes. */
  prompts?: boolean
  /** Toggle the traces pillar (DB tables + instrumentation). Default: ask, then yes. */
  traces?: boolean
  /** @deprecated use `traces: false`. Kept for backwards-compat with --no-migrate. */
  noMigrate?: boolean
  /** @deprecated use `prompts: false`. Kept for backwards-compat with --no-hook. */
  noHook?: boolean
  /** @deprecated use `traces: false`. Kept for backwards-compat with --no-instrumentation. */
  noInstrumentation?: boolean
  /** @deprecated use `prompts: false`. */
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
  /** Which pillars actually ran this invocation. */
  pillars: { dashboard: boolean; prompts: boolean; traces: boolean }
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardSummary> {
  const cwd = opts.cwd ?? process.cwd()
  const blockers: string[] = []
  const mountPath = opts.mountPath ?? '/admin/ai'

  header('Gravel install', 'embedded prompt management for AI engineering teams')

  // Step 1 — detect.
  const detection = await detect(cwd)

  // Step 2 — auth (always local; see header doc).
  const controlPlane = resolveControlPlaneUrl()
  const flagApiKey = opts.apiKey ?? process.env.GRAVEL_API_KEY
  const flagProject = opts.project ?? process.env.GRAVEL_PROJECT_ID
  let apiKey: string | null = null
  let projectId: string | null = null
  let authMode: WizardAuthMode = 'local'
  if (flagApiKey && flagProject) {
    apiKey = flagApiKey
    projectId = flagProject
    authMode = 'flags'
  }

  // Interactivity setup.
  const stdinIsTTY = (process.stdin as NodeJS.ReadStream).isTTY === true
  const interactive = stdinIsTTY && !opts.yes && !opts.nonInteractive
  const ask = async (question: string, defaultYes = true): Promise<boolean> => {
    if (!interactive) return defaultYes
    return await confirm(question, { defaultYes })
  }

  // Inspect existing state so re-runs can show "already configured" tags
  // instead of re-asking the same questions.
  const state = await inspectState(cwd, detection)

  // ── Pick pillars ──
  // Resolution order, per pillar:
  //   1. Explicit opts.prompts / opts.traces if set (CLI flags).
  //   2. Legacy --no-{migrate,hook,scan,instrumentation} flags map onto
  //      the new pillars.
  //   3. Interactive ask (default-yes for both pillars; the wizard's
  //      pitch is "the dashboard works for both prompts and traces").
  //   4. Non-interactive default: yes for both — matches the prior
  //      behaviour where omitting all flags set everything up.
  step('Detect project')
  note(
    `${c.bold(detection.framework)} · ${detection.language} · pkg=${detection.packageManager} · db=${detection.database.driver} · auth=${detection.auth}`,
  )
  if (state.mountExists) note(c.dim('• dashboard mount file already present'))
  if (state.manifestExists) note(c.dim(`• manifest exists (${state.promptCount} prompt(s))`))
  if (state.tablesLikelyExist) note(c.dim('• gravel_* tables likely present (DATABASE_URL set)'))
  success('Stack identified')

  if (detection.nextHasBothRouters) {
    const warning =
      `This project has BOTH ${detection.nextAppDir}/ and pages/ — mid-migration. ` +
      `Mounted under the App Router (${detection.nextAppDir}/admin/ai/[[...slug]]/route.ts). ` +
      `Re-run with --framework or hand-mount per gravel.artanis.ai/docs/install if you want pages/ instead.`
    warn(warning)
    blockers.push(warning)
  }

  // Pillar 1 (prompts): the wedge. Defaults to yes.
  let wantPrompts: boolean
  if (typeof opts.prompts === 'boolean') {
    wantPrompts = opts.prompts
  } else if (opts.noHook === true && opts.noScan === true) {
    wantPrompts = false
  } else if (state.manifestExists && state.hookInstalled) {
    // Fully set up — don't re-ask, don't re-run. Skip cleanly.
    wantPrompts = false
    note(c.dim(`Prompts pillar already configured — skipping.`))
  } else {
    wantPrompts = await ask(
      `Set up ${c.bold('Prompts')}? ${c.dim('(manifest scan + DE editor at /admin/ai)')}`,
      true,
    )
  }

  // Pillar 2 (traces): defaults to yes.
  let wantTraces: boolean
  if (typeof opts.traces === 'boolean') {
    wantTraces = opts.traces
  } else if (opts.noMigrate === true && opts.noInstrumentation === true) {
    wantTraces = false
  } else if (state.tablesLikelyExist && state.instrumentationExists) {
    wantTraces = false
    note(c.dim(`Traces pillar already configured — skipping.`))
  } else {
    wantTraces = await ask(
      `Set up ${c.bold('Traces')}? ${c.dim('(2 DB tables + auto-instrumentation for OpenAI/Anthropic/etc)')}`,
      true,
    )
  }

  if (!wantPrompts && !wantTraces) {
    info('Nothing to set up. Re-run `gravel init --prompts` or `gravel init --traces` when you want one.')
    return {
      detection,
      installedSdk: false,
      wroteConfig: false,
      mountedRoute: null,
      ranBootstrap: false,
      installedHook: null,
      passwordGenerated: null,
      controlPlane,
      blockers,
      projectId,
      apiKey,
      authMode,
      pillars: { dashboard: false, prompts: false, traces: false },
    }
  }

  // ── Section 1: Dashboard ──
  // Always runs if at least one pillar was selected. .env, mount route,
  // gravel.config.ts. The mount step calls into installNextTracingHooks
  // when the traces pillar is on.
  section(
    1,
    'Dashboard',
    `Mount /admin/ai, write gravel.config.ts, generate the admin password.`,
  )
  const password = generatePassword()
  const envVars: Record<string, string> = { GRAVEL_ADMIN_PASSWORD: password }
  if (projectId) envVars.GRAVEL_PROJECT_ID = projectId
  if (apiKey) envVars.GRAVEL_API_KEY = apiKey
  await writeEnvAdditions(cwd, envVars)
  note(c.dim(`GRAVEL_ADMIN_PASSWORD written to .env.local (${authMode} mode)`))

  let mountedRoute = null as Awaited<ReturnType<typeof mountDashboardRoute>>
  const sp1 = spinner('Wiring dashboard mount + config files…')
  try {
    mountedRoute = await mountDashboardRoute(detection, cwd, mountPath, {
      withTracingDeps: wantTraces && opts.noInstrumentation !== true,
    })
    await generateConfigFile(detection, cwd, { mountPath })
    sp1.stop(`Mounted ${c.bold(mountPath)}; wrote gravel.config.ts`)
  } catch (e) {
    sp1.fail(`Mount failed: ${(e as Error).message}`)
    blockers.push(`Mount failed: ${(e as Error).message}`)
  }

  // ── Section 2: Prompts ──
  let initialScan: { promptCount: number; added: number } | null = null
  let installedHook = null as { mode: string; path?: string } | null
  if (wantPrompts) {
    section(
      2,
      'Prompts',
      'Find prompts in your repo and surface them in the dashboard for editing.',
    )

    const sp2 = spinner('Scanning repo for prompts…')
    try {
      const current = await readManifest(cwd)
      const result = await fastScan(cwd, current)
      await writeManifest(cwd, result.manifest)
      initialScan = { promptCount: result.manifest.prompts.length, added: result.added }
      sp2.stop(
        `Manifest seeded: ${c.bold(String(initialScan.promptCount))} prompt(s) found (+${initialScan.added} new)`,
      )
    } catch (e) {
      sp2.fail(`Initial scan failed: ${(e as Error).message}`)
      blockers.push(`Initial manifest scan failed: ${(e as Error).message}. Run \`npx @artanis-ai/gravel manifest --update\` once resolved.`)
    }

    if (detection.hasGit && opts.noHook !== true) {
      const wantHook = await ask(
        `Install a pre-commit hook to keep ${c.bold('.artanis/manifest.json')} in sync? ${c.dim('(removable via .git/hooks/pre-commit)')}`,
        true,
      )
      if (wantHook) {
        const sp3 = spinner('Installing pre-commit hook…')
        try {
          const result = await installHook(cwd)
          installedHook = { mode: result.mode, path: result.path }
          sp3.stop(`Hook installed (${result.mode})`)
        } catch (e) {
          sp3.fail(`Hook install failed: ${(e as Error).message}`)
        }
      }
    }
  }

  // ── Section 3: Traces ──
  let ranBootstrap = false
  if (wantTraces) {
    section(
      3,
      'Traces',
      'Auto-trace LLM calls into 2 tables in your database (gravel_samples, gravel_feedback).',
    )

    if (opts.noMigrate !== true) {
      const dbDriver = detection.database.driver
      const dbDest =
        dbDriver === 'postgres'
          ? `Postgres at ${c.bold(detection.database.envVar ?? 'DATABASE_URL')}`
          : dbDriver === 'sqlite'
            ? `SQLite (${c.bold(detection.database.envVar ?? 'DATABASE_URL')})`
            : 'your configured DATABASE_URL'
      const wantMigrate = await ask(
        `Create 2 tables (${c.bold('gravel_samples')}, ${c.bold('gravel_feedback')}) in ${dbDest}? ${c.dim('(idempotent)')}`,
        true,
      )
      if (wantMigrate) {
        const sp4 = spinner('Bootstrapping schema…')
        try {
          await runBootstrap(cwd)
          ranBootstrap = true
          sp4.stop('Schema ready (2 tables)')
        } catch (e) {
          sp4.fail(`Bootstrap failed: ${(e as Error).message}`)
          blockers.push(`Schema bootstrap failed: ${(e as Error).message}. Re-run \`npx @artanis-ai/gravel migrate\`.`)
        }
      } else {
        blockers.push(
          'Schema migration skipped — run `npx @artanis-ai/gravel migrate` before starting your app.',
        )
      }
    }

    // If the dashboard mount ran above with `withTracingDeps: false` (because
    // we didn't yet know they wanted traces — e.g. mount was earlier or
    // failed), run the tracing hooks now. Idempotent.
    if (
      detection.framework.startsWith('next-') &&
      opts.noInstrumentation !== true &&
      !state.instrumentationExists
    ) {
      const sp5 = spinner('Installing instrumentation.ts + next.config externals…')
      try {
        await installNextTracingHooks(cwd, {
          srcLayout: detection.nextAppDir === 'src/app',
        })
        sp5.stop('Tracing hooks installed')
      } catch (e) {
        sp5.fail(`Tracing hook install failed: ${(e as Error).message}`)
        blockers.push(`Could not install instrumentation.ts: ${(e as Error).message}`)
      }
    }
  }

  // ── Step 8 — deep scan still pending (placeholder). ──
  if (wantPrompts && !opts.noDeepScan) {
    blockers.push(
      'LLM-assisted deep scan not implemented yet (the regex fast-scan ran above). When available, run `npx @artanis-ai/gravel scan --deep` to catch dynamically-built prompts.',
    )
  }

  void opts.noTestTrace

  // ── Next-steps panel ──
  const nextSteps: string[] = []
  if (initialScan) {
    nextSteps.push(`${c.dim('●')} ${c.bold(String(initialScan.promptCount))} prompt(s) in manifest (+${initialScan.added} new)`)
  }
  nextSteps.push(`${c.brand('1.')} Open ${c.bold(mountPath)} in your app — admin password is in ${c.bold('.env.local')}`)
  if (wantPrompts) {
    nextSteps.push(`${c.brand('2.')} Click a prompt → edit → submit. The dashboard will walk you through installing the GitHub App.`)
  }
  if (wantTraces) {
    nextSteps.push(
      `${c.brand(wantPrompts ? '3.' : '2.')} Trigger an LLM call from your app — auto-tracing is on. Outputs tab will fill in.`,
    )
  }
  nextSteps.push(`${c.brand('•')} Docs: ${c.cyan('https://gravel.artanis.ai/docs')}`)
  panel('Next steps', nextSteps)

  if (blockers.length > 0) {
    failure(`${blockers.length} item(s) need follow-up:`)
    for (const b of blockers) note(`• ${b}`)
  }
  done('Gravel skeleton installed.')

  return {
    detection,
    installedSdk: false,
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
    pillars: { dashboard: true, prompts: wantPrompts, traces: wantTraces },
  }
}

interface InspectedState {
  mountExists: boolean
  manifestExists: boolean
  promptCount: number
  hookInstalled: boolean
  /**
   * Best-effort: we can't probe the user's DB during `init` (no
   * connection on a dry run, may not be reachable in CI), so this is a
   * proxy — DATABASE_URL is set AND the user previously ran the wizard.
   */
  tablesLikelyExist: boolean
  instrumentationExists: boolean
}

async function inspectState(
  cwd: string,
  detection: Awaited<ReturnType<typeof detect>>,
): Promise<InspectedState> {
  const exists = async (rel: string): Promise<boolean> => {
    try {
      await fs.stat(join(cwd, rel))
      return true
    } catch {
      return false
    }
  }

  const manifestExists = await exists('.artanis/manifest.json')
  let promptCount = 0
  if (manifestExists) {
    try {
      const raw = await fs.readFile(join(cwd, '.artanis', 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as { prompts?: unknown[] }
      promptCount = Array.isArray(parsed.prompts) ? parsed.prompts.length : 0
    } catch {
      /* ignore — manifest is malformed; treat as empty */
    }
  }

  let mountExists = false
  if (detection.framework === 'next-app-router') {
    const dir = detection.nextAppDir === 'src/app' ? 'src/app' : 'app'
    mountExists = await exists(`${dir}/admin/ai/[[...slug]]/route.ts`)
  } else if (detection.framework === 'next-pages-router') {
    mountExists = await exists('pages/admin/ai/[[...slug]].ts')
  } else if (detection.framework === 'fastapi') {
    mountExists = await exists('gravel_route.py')
  }

  const hookInstalled = await exists('.git/hooks/pre-commit')
  const instrumentationExists =
    (await exists('instrumentation.ts')) || (await exists('src/instrumentation.ts'))
  const tablesLikelyExist = Boolean(detection.database.envVar) && manifestExists

  return {
    mountExists,
    manifestExists,
    promptCount,
    hookInstalled,
    tablesLikelyExist,
    instrumentationExists,
  }
}

void info
void success
