/**
 * Wizard entry point. Walks the user through install per
 * gravel-cloud/docs/spec/wizard.md §2.
 *
 * Tone (2026-05-08 v3): the wizard speaks to the user one step at a
 * time. Three pillars (Dashboard / Prompts / Traces); each is its
 * own conversation:
 *
 *   1. Explain what's about to happen.
 *   2. Confirm.
 *   3. Do it (with a spinner if it takes any time).
 *   4. Tell the user what they should see, and where.
 *   5. Pause until they hit Enter — gives them time to actually look
 *      at the result before the next pillar starts.
 *
 * The Prompts pillar verifies its scan results before continuing —
 * Mallet-style: show what we found, let the user confirm or trim, and
 * offer a deeper LLM-assisted scan if the regex pass missed code-
 * embedded prompts.
 *
 * The Traces pillar pre-flights the DB connection before asking
 * "create tables?" — a yes to that question shouldn't surface as an
 * authentication error two lines later.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { detect } from './detect.js'
import { generateConfigFile } from './config-file.js'
import { mountDashboardRoute, installNextTracingHooks } from './mount.js'
import { writeEnvAdditions, generatePassword } from './env.js'
import { runBootstrap } from './migrate.js'
import { probeDatabase } from './db-test.js'
import { installHook } from '../manifest/hook.js'
import { fastScan } from '../manifest/scan.js'
import { readManifest, writeManifest } from '../manifest/io.js'
import type { Manifest, ManifestPrompt } from '../manifest/types.js'
import { resolveControlPlaneUrl } from './oauth.js'
import { askText, confirm, pressEnter } from './prompt.js'
import {
  bullet,
  c,
  done,
  note,
  say,
  spinner,
  stepHeader,
  welcome,
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
  const pause = async (msg?: string): Promise<void> => {
    if (!interactive) return
    await pressEnter(msg)
  }

  // Inspect existing state so re-runs can announce "already configured"
  // instead of clobbering files.
  const state = await inspectState(cwd, detection)

  // Early exit: both pillars explicitly off via flags. Skip everything,
  // including the dashboard mount — there's nothing for it to host.
  if (opts.prompts === false && opts.traces === false) {
    return summary({
      detection,
      password: null,
      mountedRoute: null,
      ranBootstrap: false,
      installedHook: null,
      controlPlane,
      blockers,
      projectId,
      apiKey,
      authMode,
      pillars: { dashboard: false, prompts: false, traces: false },
    })
  }

  welcome(
    'Gravel install',
    'embedded prompt management for AI engineering teams',
  )
  say(
    `Detected ${c.bold(detection.framework)} (${detection.language}, ${detection.packageManager}, db=${detection.database.driver}). I'll walk you through three things — you can skip any.`,
  )
  if (detection.nextHasBothRouters) {
    bullet(
      `Heads-up: this project has both ${detection.nextAppDir}/ and pages/. I'll mount under the App Router. Re-run with --framework or hand-mount per gravel.artanis.ai/docs/install if you want pages/ instead.`,
      'warn',
    )
    say('')
  }

  // Resolve which pillars to attempt. Flags take priority; otherwise
  // we ask at each section so the user can see the previous result
  // before deciding on the next one.
  const wantPromptsResolved =
    typeof opts.prompts === 'boolean'
      ? opts.prompts
      : opts.noHook === true && opts.noScan === true
        ? false
        : null // null = ask at the section
  const wantTracesResolved =
    typeof opts.traces === 'boolean'
      ? opts.traces
      : opts.noMigrate === true && opts.noInstrumentation === true
        ? false
        : null

  // ── Step 1 of 3 — Dashboard ──
  // Always required if either pillar is selected. We can't know that
  // upfront when the user hasn't been asked yet, so we run the dashboard
  // step optimistically — if the user declines all pillars after that
  // we'll have written a few harmless files (mount route, password,
  // gravel.config.ts). Tradeoff worth taking for the simpler flow.
  stepHeader(1, 3, 'Dashboard')
  say(
    `First I'll mount an embedded admin UI at ${c.bold(mountPath)}. This is where ` +
      `your domain experts open Gravel — they'll see prompts to edit and (later) ` +
      `LLM outputs to review. I'll also write a ${c.bold('gravel.config.ts')} so you can ` +
      `wire up your own ${c.bold('getUser')} callback later.`,
  )
  let dashboardWritten = false
  let mountedRoute = null as Awaited<ReturnType<typeof mountDashboardRoute>>
  let password: string | null = null
  if (state.mountExists && state.envHasPassword) {
    bullet(`Already wired up. Skipping.`, 'skip')
    note(`(Re-run with a clean .env.local + ${mountFilePath(detection)} removed if you want to start over.)`)
    say('')
    dashboardWritten = true
  } else {
    const wantMount = await ask('Continue?', true)
    if (!wantMount) {
      bullet('Skipped. Nothing else can run without the dashboard.', 'skip')
      return summary({
        detection,
        password: null,
        mountedRoute: null,
        ranBootstrap: false,
        installedHook: null,
        controlPlane,
        blockers,
        projectId,
        apiKey,
        authMode,
        pillars: { dashboard: false, prompts: false, traces: false },
      })
    }
    password = generatePassword()
    const envVars: Record<string, string> = { GRAVEL_ADMIN_PASSWORD: password }
    if (projectId) envVars.GRAVEL_PROJECT_ID = projectId
    if (apiKey) envVars.GRAVEL_API_KEY = apiKey
    await writeEnvAdditions(cwd, envVars)
    const sp = spinner('Mounting dashboard…')
    try {
      mountedRoute = await mountDashboardRoute(detection, cwd, mountPath, {
        // Defer instrumentation to step 3 so the prompts-only path
        // doesn't drop dead-code into the user's repo.
        withTracingDeps: false,
      })
      await generateConfigFile(detection, cwd, { mountPath })
      sp.stop(`Wrote ${describeMount(detection, mountPath)} + gravel.config.ts`)
      bullet(`Admin password saved to .env.local`, 'ok')
      dashboardWritten = true
    } catch (e) {
      sp.fail(`Mount failed: ${(e as Error).message}`)
      blockers.push(`Mount failed: ${(e as Error).message}`)
    }
  }

  if (dashboardWritten) {
    say('')
    say(
      `When your dev server's running, open ${c.cyan('http://localhost:3000' + mountPath)} ` +
        `and log in with the password from ${c.bold('.env.local')}.`,
    )
    await pause('Press Enter once you can see the dashboard (or Enter to skip ahead)')
  }

  // ── Step 2 of 3 — Prompts ──
  let promptsRan = false
  let installedHook = null as { mode: string; path?: string } | null
  if (wantPromptsResolved !== false) {
    stepHeader(2, 3, 'Prompts')
    say(
      `Now I'll scan your repo for prompt files (${c.bold('.md')} / ${c.bold('.txt')} ` +
        `under ${c.bold('prompts/')}, ${c.bold('templates/')}, etc.) and write a manifest. ` +
        `Your team edits these from the dashboard; nothing is sent anywhere — no DB needed.`,
    )
    const wantPrompts =
      wantPromptsResolved === true ? true : await ask('Continue?', true)
    if (!wantPrompts) {
      bullet('Skipped. Run `gravel init --prompts` later.', 'skip')
    } else {
      const manifest = await runScanAndVerify(cwd, ask, askInteractiveText(interactive))
      if (manifest) {
        promptsRan = true
        if (detection.hasGit && opts.noHook !== true && !state.hookInstalled) {
          say('')
          say(
            `Optional: install a pre-commit hook so the manifest stays in sync ` +
              `with your repo (so when you change a prompt file, the manifest ` +
              `updates automatically).`,
          )
          const wantHook = await ask('Install the hook?', true)
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
        } else if (state.hookInstalled) {
          bullet('Pre-commit hook already installed', 'skip')
        }
        say('')
        say(
          `Open the ${c.bold('Prompts')} tab in the dashboard and try editing one. ` +
            `Drafts pile up locally — to actually open a PR you'll need the ` +
            `Gravel GitHub App, but the dashboard walks you through that when you ` +
            `click ${c.bold('Submit changes')}.`,
        )
        await pause()
      }
    }
  }

  // ── Step 3 of 3 — Traces ──
  let ranBootstrap = false
  let tracesAttempted = false
  if (wantTracesResolved !== false) {
    stepHeader(3, 3, 'Traces')
    say(
      `Last step: capture every LLM call your app makes. I'll add ${c.bold('two tables')} to ` +
        `your database (gravel_samples, gravel_feedback) and turn on auto-tracing for ` +
        `OpenAI, Anthropic, LangChain, Vercel AI, and raw fetch. Your team will see ` +
        `the calls in the ${c.bold('Outputs')} tab.`,
    )
    const wantTraces =
      wantTracesResolved === true ? true : await ask('Continue?', true)
    if (!wantTraces) {
      bullet('Skipped. Run `gravel init --traces` later.', 'skip')
    } else {
      tracesAttempted = true
      if (opts.noMigrate === true) {
        bullet('Schema bootstrap skipped (--no-migrate)', 'skip')
        // Still install the tracing hooks if Next.
        await maybeInstallTracingHooks(detection, cwd, opts, state)
      } else {
        const proceed = await runTracesPillar(cwd, ask, detection, opts, state)
        if (proceed.ranBootstrap) ranBootstrap = true
        if (proceed.skipped) {
          bullet(proceed.skipped, 'skip')
        }
      }
    }
  }

  // ── Closing summary ──
  say('')
  done('Done.')
  bullet(
    `Dashboard at ${c.cyan('http://localhost:3000' + mountPath)} (password in .env.local)`,
    'ok',
  )
  if (promptsRan) {
    const m = await readManifestSafe(cwd)
    bullet(
      `Prompts: ${m?.prompts.length ?? 0} in manifest${installedHook ? ', hook installed' : ''}`,
      'ok',
    )
  } else if (wantPromptsResolved === false) {
    bullet('Prompts: skipped (re-run with `gravel init --prompts`)', 'skip')
  }
  if (ranBootstrap) {
    bullet('Traces: tables created, auto-tracing wired up', 'ok')
  } else if (wantTracesResolved === false) {
    bullet('Traces: skipped (re-run with `gravel init --traces`)', 'skip')
  }
  say('')
  say(`Docs: ${c.cyan('https://gravel.artanis.ai/docs')}`)

  return summary({
    detection,
    password,
    mountedRoute,
    ranBootstrap,
    installedHook,
    controlPlane,
    blockers,
    projectId,
    apiKey,
    authMode,
    pillars: { dashboard: dashboardWritten, prompts: promptsRan, traces: tracesAttempted },
  })
}

// ─── Pillar helpers ───────────────────────────────────────────────────────

/**
 * Mallet-style scan + verify: run the regex fast-scan, show the
 * results, let the user confirm or trim, and offer a deeper LLM scan
 * if the fast pass came up short or missed embedded code prompts.
 *
 * Returns the final manifest (already written to disk) on success,
 * null if the user bailed.
 */
async function runScanAndVerify(
  cwd: string,
  ask: (q: string, defaultYes?: boolean) => Promise<boolean>,
  askTextFn: (q: string, def?: string) => Promise<string>,
): Promise<Manifest | null> {
  const sp = spinner('Scanning repo for prompts…')
  let manifest: Manifest
  let added: number
  try {
    const current = await readManifest(cwd)
    const result = await fastScan(cwd, current)
    manifest = result.manifest
    added = result.added
    sp.stop(`Found ${manifest.prompts.length} prompt(s) (+${added} new)`)
  } catch (e) {
    sp.fail(`Scan failed: ${(e as Error).message}`)
    return null
  }

  // Show what we found.
  if (manifest.prompts.length === 0) {
    say('')
    say(
      `I didn't find any ${c.bold('.md')} / ${c.bold('.txt')} prompts in conventional ` +
        `directories. They might be embedded in code as string literals — that needs ` +
        `the deeper LLM-assisted scan (see ${c.bold('gravel scan --deep')} when implemented). ` +
        `For now you can also commit a prompt file (e.g. ${c.bold('prompts/system.md')}) and ` +
        `re-run.`,
    )
    await writeManifest(cwd, manifest)
    return manifest
  }

  say('')
  say(`Here's what I found:`)
  for (let i = 0; i < manifest.prompts.length; i++) {
    const p = manifest.prompts[i]!
    bullet(`${i + 1}. ${formatPromptEntry(p)}`, 'plain')
  }
  say('')
  const looksRight = await ask('Look right?', true)
  if (!looksRight) {
    say('')
    say(
      `Tell me which to drop (comma-separated numbers, or ${c.bold('all')} to clear). ` +
        `Press Enter to keep them all.`,
    )
    const answer = await askTextFn('Drop:', '')
    if (answer.trim().length > 0) {
      const trimmed = applyDrop(manifest.prompts, answer)
      manifest = { ...manifest, prompts: trimmed.kept }
      if (trimmed.dropped.length > 0) {
        bullet(`Dropped ${trimmed.dropped.length} entry(ies)`, 'ok')
      }
    }
  }

  // Offer the deeper scan as a hint-only opt-in (the LLM-assisted path
  // isn't implemented yet — see CLI's `gravel scan --deep`). The
  // question still surfaces because users with code-embedded prompts
  // will want to know it exists.
  say('')
  say(
    `If your prompts are embedded in code (string literals, template ` +
      `strings), the regex scan above won't catch them. A deeper LLM-assisted ` +
      `scan can — runs locally with your own LLM key, code never leaves your ` +
      `machine.`,
  )
  const wantDeep = await ask('Run a deeper scan now?', false)
  if (wantDeep) {
    bullet(
      `${c.bold('gravel scan --deep')} isn't implemented yet — coming soon. Run it once available.`,
      'warn',
    )
  } else {
    note(`(Run ${c.bold('npx @artanis-ai/gravel scan --deep')} later if you change your mind.)`)
  }

  await writeManifest(cwd, manifest)
  bullet(
    `Manifest written: ${manifest.prompts.length} prompt(s) (.artanis/manifest.json)`,
    'ok',
  )
  return manifest
}

function applyDrop(
  prompts: ManifestPrompt[],
  answer: string,
): { kept: ManifestPrompt[]; dropped: ManifestPrompt[] } {
  const trimmed = answer.trim().toLowerCase()
  if (trimmed === 'all') {
    return { kept: [], dropped: prompts.slice() }
  }
  const indices = new Set<number>()
  for (const part of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const n = Number.parseInt(part, 10)
    if (Number.isFinite(n) && n >= 1 && n <= prompts.length) {
      indices.add(n - 1)
    }
  }
  const kept: ManifestPrompt[] = []
  const dropped: ManifestPrompt[] = []
  prompts.forEach((p, i) => (indices.has(i) ? dropped.push(p) : kept.push(p)))
  return { kept, dropped }
}

function formatPromptEntry(p: ManifestPrompt): string {
  if (p.type === 'embedded') {
    const tag = p.varName ? ` ${c.dim('(' + p.varName + ')')}` : ''
    return `${c.bold(p.path)}${tag} ${c.dim(`@ L${p.lineStart}`)}`
  }
  return c.bold(p.path)
}

/**
 * Runs the Traces pillar: probe the DB, decide whether to bootstrap,
 * install Next.js tracing hooks. Returns whether bootstrap actually
 * ran and (optionally) a "skipped because X" reason for the summary.
 */
async function runTracesPillar(
  cwd: string,
  ask: (q: string, defaultYes?: boolean) => Promise<boolean>,
  detection: Awaited<ReturnType<typeof detect>>,
  opts: WizardOptions,
  state: InspectedState,
): Promise<{ ranBootstrap: boolean; skipped?: string }> {
  // Pre-flight the DB so we don't ask "create tables?" then fail.
  const sp = spinner('Checking DATABASE_URL…')
  const probe = await probeDatabase(cwd)
  let ranBootstrap = false
  if (probe.kind === 'no-url') {
    sp.fail('No DATABASE_URL detected in .env / .env.local')
    say('')
    say(
      `Set ${c.bold('DATABASE_URL')} in ${c.bold('.env.local')} and re-run ` +
        `${c.bold('gravel init --traces')} when you're ready. The dashboard's ` +
        `Outputs tab will keep nudging you until tables exist.`,
    )
    return { ranBootstrap: false, skipped: 'No DATABASE_URL — fix .env.local and run `gravel init --traces`.' }
  }
  if (probe.kind === 'placeholder') {
    sp.fail(`DATABASE_URL still has placeholder credentials`)
    note(`  ${probe.url}`)
    say('')
    say(
      `That URL looks like a tutorial default. Swap in real credentials in ` +
        `${c.bold('.env.local')} and re-run ${c.bold('gravel init --traces')}.`,
    )
    return { ranBootstrap: false, skipped: 'DATABASE_URL has placeholder credentials.' }
  }
  if (probe.kind === 'connect-failed') {
    const headline =
      probe.reason === 'auth'
        ? `Couldn't connect: ${probe.message.trim()}`
        : probe.reason === 'host'
          ? `Couldn't reach the database: ${probe.message.trim()}`
          : `Couldn't connect: ${probe.message.trim()}`
    sp.fail(headline)
    say('')
    if (probe.reason === 'auth') {
      say(`Looks like a credentials problem. Fix ${c.bold('.env.local')} and re-run.`)
    } else if (probe.reason === 'host') {
      say(`Is the database reachable? Try ${c.bold('psql "$DATABASE_URL"')} from your shell.`)
    }
    const skipNow = await ask('Skip Traces for now and continue?', true)
    if (skipNow) {
      return {
        ranBootstrap: false,
        skipped: `DB unreachable — fix and re-run \`gravel init --traces\`.`,
      }
    }
    return { ranBootstrap: false, skipped: 'DB unreachable.' }
  }

  sp.stop(`Connected to ${probe.dialect} OK`)
  // Already-bootstrapped detection: skip the create-tables question
  // entirely if both tables already exist.
  if (await tablesAlreadyExist(probe.url, probe.dialect)) {
    bullet('gravel_* tables already exist. Skipping CREATE.', 'skip')
  } else {
    const wantMigrate = await ask(
      `Create the two gravel_* tables now? ${c.dim('(idempotent CREATE TABLE IF NOT EXISTS)')}`,
      true,
    )
    if (wantMigrate) {
      const sp2 = spinner('Bootstrapping schema…')
      try {
        await runBootstrap(cwd)
        ranBootstrap = true
        sp2.stop('Two gravel_* tables ready')
      } catch (e) {
        sp2.fail(`Bootstrap failed: ${(e as Error).message}`)
        return {
          ranBootstrap: false,
          skipped: `Bootstrap failed (${(e as Error).message}). Re-run with \`gravel migrate\`.`,
        }
      }
    } else {
      return {
        ranBootstrap: false,
        skipped: 'Tables not created — run `gravel migrate` later.',
      }
    }
  }

  await maybeInstallTracingHooks(detection, cwd, opts, state)
  say('')
  say(
    `Trigger an LLM call from your app — auto-tracing's on, so the call ` +
      `lands in the ${c.bold('Outputs')} tab as soon as it completes.`,
  )
  return { ranBootstrap }
}

async function maybeInstallTracingHooks(
  detection: Awaited<ReturnType<typeof detect>>,
  cwd: string,
  opts: WizardOptions,
  state: InspectedState,
): Promise<void> {
  if (!detection.framework.startsWith('next-')) return
  if (opts.noInstrumentation === true) return
  if (state.instrumentationExists) {
    bullet('instrumentation.ts already present', 'skip')
    return
  }
  const sp = spinner('Wiring instrumentation.ts + next.config externals…')
  try {
    await installNextTracingHooks(cwd, {
      srcLayout: detection.nextAppDir === 'src/app',
    })
    sp.stop('Tracing hooks installed')
  } catch (e) {
    sp.fail(`Tracing hook install failed: ${(e as Error).message}`)
  }
}

async function tablesAlreadyExist(url: string, dialect: 'postgres' | 'sqlite'): Promise<boolean> {
  try {
    const { openDatabase, gravelTablesExist } = await import('../db/index.js')
    const db = await openDatabase({ url })
    try {
      return await gravelTablesExist(db)
    } finally {
      await db.close()
    }
  } catch {
    return false
  }
}

async function readManifestSafe(cwd: string): Promise<Manifest | null> {
  try {
    return await readManifest(cwd)
  } catch {
    return null
  }
}

function askInteractiveText(
  interactive: boolean,
): (q: string, def?: string) => Promise<string> {
  return (q, def) => (interactive ? askText(q, { defaultValue: def }) : Promise.resolve(def ?? ''))
}

// ─── State inspection + helpers ──────────────────────────────────────────

interface InspectedState {
  mountExists: boolean
  manifestExists: boolean
  promptCount: number
  hookInstalled: boolean
  envHasPassword: boolean
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
  const readText = async (rel: string): Promise<string | null> => {
    try {
      return await fs.readFile(join(cwd, rel), 'utf8')
    } catch {
      return null
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
      /* malformed → treat as empty */
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
  const envFiles = await Promise.all(['.env.local', '.env'].map(readText))
  const envBody = envFiles.filter(Boolean).join('\n')
  const envHasPassword = /GRAVEL_ADMIN_PASSWORD=/.test(envBody)

  return {
    mountExists,
    manifestExists,
    promptCount,
    hookInstalled,
    envHasPassword,
    instrumentationExists,
  }
}

function describeMount(detection: Awaited<ReturnType<typeof detect>>, mountPath: string): string {
  if (detection.framework === 'next-app-router') {
    const dir = detection.nextAppDir === 'src/app' ? 'src/app' : 'app'
    return `${dir}${mountPath}/[[...slug]]/route.ts`
  }
  if (detection.framework === 'next-pages-router') {
    return `pages${mountPath}/[[...slug]].ts`
  }
  if (detection.framework === 'fastapi') return 'gravel_route.py'
  return 'mount file'
}

function mountFilePath(detection: Awaited<ReturnType<typeof detect>>): string {
  if (detection.framework === 'next-app-router') {
    const dir = detection.nextAppDir === 'src/app' ? 'src/app' : 'app'
    return `${dir}/admin/ai/[[...slug]]/route.ts`
  }
  if (detection.framework === 'next-pages-router') return 'pages/admin/ai/[[...slug]].ts'
  if (detection.framework === 'fastapi') return 'gravel_route.py'
  return 'mount file'
}

function summary(args: {
  detection: Awaited<ReturnType<typeof detect>>
  password: string | null
  mountedRoute: WizardSummary['mountedRoute']
  ranBootstrap: boolean
  installedHook: WizardSummary['installedHook']
  controlPlane: string
  blockers: string[]
  projectId: string | null
  apiKey: string | null
  authMode: WizardAuthMode
  pillars: WizardSummary['pillars']
}): WizardSummary {
  return {
    detection: args.detection,
    installedSdk: false,
    wroteConfig: args.pillars.dashboard,
    mountedRoute: args.mountedRoute,
    ranBootstrap: args.ranBootstrap,
    installedHook: args.installedHook,
    passwordGenerated: args.password,
    controlPlane: args.controlPlane,
    blockers: args.blockers,
    projectId: args.projectId,
    apiKey: args.apiKey,
    authMode: args.authMode,
    pillars: args.pillars,
  }
}
