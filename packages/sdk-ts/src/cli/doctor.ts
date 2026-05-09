/**
 * `gravel doctor` — self-diagnostic. Reports environment health, and
 * actively probes the dependencies the SDK talks to.
 *
 * Probes are timeboxed (~3s each) so a wedged dependency doesn't hang
 * the whole report. Each probe ends with ✓ / ✗ + a short detail line;
 * non-zero exit code if anything failed.
 */
import { detect } from '../wizard/detect.js'
import { config as loadEnv } from '../wizard/load-env.js'
import { readManifest } from '../manifest/io.js'

const PROBE_TIMEOUT_MS = 3_000

interface ProbeResult {
  name: string
  ok: boolean
  /** True when the probe didn't run (e.g. nothing to probe). Doesn't count as failure. */
  skipped?: boolean
  detail: string
}

async function probeDb(databaseUrl?: string): Promise<ProbeResult> {
  const name = 'Database'
  if (!databaseUrl) {
    // Prompts-only installs intentionally have no DATABASE_URL — not
    // an error. `gravel init --traces` adds the DB.
    return { name, ok: true, skipped: true, detail: 'not configured (prompts-only install)' }
  }
  try {
    const { openDatabase, detectDialect } = await import('../db/index.js')
    const dialect = detectDialect(databaseUrl)
    const db = await openDatabase({ url: databaseUrl })
    try {
      await db.exec('SELECT 1')
      return { name, ok: true, detail: `${dialect} reachable` }
    } finally {
      await db.close().catch(() => {})
    }
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message }
  }
}

async function probeControlPlane(): Promise<ProbeResult> {
  const name = 'Control plane'
  const cp = process.env.GRAVEL_CONTROL_PLANE_URL ?? 'https://gravel.artanis.ai'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${cp}/api/health`, { signal: ctrl.signal })
    return res.ok
      ? { name, ok: true, detail: `${cp} → ${res.status}` }
      : { name, ok: false, detail: `${cp} → ${res.status}` }
  } catch (e) {
    return { name, ok: false, detail: `${cp} unreachable: ${(e as Error).message}` }
  } finally {
    clearTimeout(t)
  }
}

async function probeJudge(): Promise<ProbeResult> {
  const name = 'Judge'
  // The judge is internal infra; the customer doesn't need it for v0/v1
  // unless they're running evals. Check `/health` if reachable, else skip.
  const judge = process.env.GRAVEL_JUDGE_URL ?? 'https://gravel-judge.artanis-ai.workers.dev'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${judge}/health`, { signal: ctrl.signal })
    return res.ok
      ? { name, ok: true, detail: `${judge} → ${res.status}` }
      : { name, ok: false, detail: `${judge} → ${res.status}` }
  } catch (e) {
    return { name, ok: false, detail: `${judge} unreachable: ${(e as Error).message}` }
  } finally {
    clearTimeout(t)
  }
}

async function probeGitHubApp(): Promise<ProbeResult> {
  const name = 'GitHub App install'
  // Cheap check: just hit the public install URL and see if GitHub has
  // the app slug indexed. Doesn't tell us if the customer's repo has
  // it installed — that's a DB lookup elsewhere — but tells us the App
  // exists and our slug is right.
  const slug = process.env.GRAVEL_GH_APP_SLUG ?? 'gravel-bot'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/apps/${slug}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.github+json' },
    })
    return res.ok
      ? { name, ok: true, detail: `gravel-bot app exists (slug: ${slug})` }
      : { name, ok: false, detail: `apps/${slug} → ${res.status}` }
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message }
  } finally {
    clearTimeout(t)
  }
}

export async function runDoctor(): Promise<void> {
  const cwd = process.cwd()
  const detection = await detect(cwd)
  const env = await loadEnv(cwd)
  const manifest = await readManifest(cwd).catch(() => null)

  console.log('Gravel doctor')
  console.log('─────────────')
  console.log(`Language:        ${detection.language}`)
  console.log(`Framework:       ${detection.framework}`)
  console.log(`Package manager: ${detection.packageManager}`)
  console.log(`Database driver: ${detection.database.driver} (env: ${detection.database.envVar ?? 'none'})`)
  console.log(`Auth provider:   ${detection.auth}`)
  console.log(`Existing tracers: ${detection.existingTracers.length ? detection.existingTracers.join(', ') : 'none'}`)
  console.log(`Git repo:        ${detection.hasGit ? 'yes' : 'no'}`)
  console.log(`Manifest:        ${manifest ? `${manifest.prompts.length} prompts` : 'missing'}`)
  console.log(`GRAVEL_PROJECT_ID: ${env.GRAVEL_PROJECT_ID ?? '<unset>'}`)
  console.log(`GRAVEL_API_KEY:    ${env.GRAVEL_API_KEY ? '<set>' : '<unset>'}`)
  console.log(`GRAVEL_ADMIN_PASSWORD: ${env.GRAVEL_ADMIN_PASSWORD ? '<set>' : '<unset>'}`)
  console.log(`GRAVEL_TRACING_DISABLED: ${env.GRAVEL_TRACING_DISABLED ?? '<unset>'}`)

  console.log('')
  console.log('Probes')
  console.log('──────')
  const [db, controlPlane, judge, githubApp] = await Promise.all([
    probeDb(env.DATABASE_URL ?? process.env.DATABASE_URL),
    probeControlPlane(),
    probeJudge(),
    probeGitHubApp(),
  ])
  // Fail-blocking probes are the ones the user's local install actually
  // depends on. Judge + GitHub App are remote optional services (evals
  // and PR creation) — they can be down or unprovisioned without
  // breaking dashboard/prompts/traces, so we surface them as warnings.
  const blocking = [db, controlPlane]
  const advisory = [judge, githubApp]
  for (const p of blocking) {
    const mark = p.skipped ? '·' : p.ok ? '✓' : '✗'
    console.log(`${mark} ${p.name.padEnd(22)} ${p.detail}`)
  }
  for (const p of advisory) {
    const mark = p.ok ? '✓' : '!'
    console.log(`${mark} ${p.name.padEnd(22)} ${p.detail}${p.ok ? '' : ' (advisory)'}`)
  }
  if (blocking.some((p) => !p.ok)) {
    process.exitCode = 1
  }
}
