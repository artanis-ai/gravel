/**
 * Step 5: AST-mount the dashboard route into the user's app entry.
 *
 * v0 implementation:
 *   - Next.js App Router → write app/admin/ai/[[...slug]]/route.ts
 *   - Next.js Pages Router → write pages/admin/ai/[[...slug]].ts
 *   - Express → print copy-paste instructions (real AST edit lands in v1)
 *   - FastAPI → write a gravel_route.py the user includes; print the include line
 *   - Django → print urls.py change instructions
 *   - Generic → print copy-paste instructions
 *
 * Conflict policy (Sentry pattern): if our target file already exists, we
 * write `.gravel.bak` next to it and prompt the user (when interactive); in
 * --ci mode, we skip and report.
 *
 * BLOCKER: full AST-aware edits (magicast for TS, libcst for Py) land
 * iteratively. For v0 we use the easy cases (file creation) and document the
 * harder ones.
 */
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import type { DetectionResult } from './detect.js'

export type MountResult = {
  path: string
  mode: 'created' | 'updated' | 'manual-instructions'
} | null

export interface MountOptions {
  /**
   * When true, skip the tracing-only side-effects: writing/patching
   * `instrumentation.ts` and patching `next.config` server-externals
   * for `pg` / `better-sqlite3`. Set this when the user installed
   * Gravel for prompts only — they have no DB and no LLM-call tracing
   * to wire up, so the extra files would just be confusing dead code.
   */
  withTracingDeps?: boolean
}

/**
 * Wire up the Next.js tracing side-effects: instrumentation.ts hook +
 * server-externals for native Node bindings. Idempotent. Exposed as a
 * separate export so the wizard can run it later (when the user adds
 * the traces pillar via `gravel init --traces`) without re-mounting.
 */
export async function installNextTracingHooks(
  cwd: string,
  opts: { srcLayout?: boolean } = {},
): Promise<void> {
  await ensureNextServerExternalPackages(cwd)
  await ensureNextInstrumentation(cwd, opts.srcLayout === true)
}

export async function mountDashboardRoute(
  detection: DetectionResult,
  cwd: string,
  mountPath: string,
  opts: MountOptions = {},
): Promise<MountResult> {
  switch (detection.framework) {
    case 'next-app-router':
      // Honour the detected layout: `./app/...` for the root convention,
      // `./src/app/...` when the project uses src/.
      return await mountNextAppRouter(cwd, mountPath, detection.nextAppDir ?? 'app', opts)
    case 'next-pages-router':
      return await mountNextPagesRouter(cwd, mountPath, opts)
    case 'fastapi':
      return await mountFastApi(cwd, mountPath)
    case 'django':
      return await mountDjango(cwd, mountPath)
    case 'express':
      return printExpressInstructions(mountPath)
    default:
      return printGenericInstructions(mountPath)
  }
}

async function mountNextAppRouter(
  cwd: string,
  mountPath: string,
  appDir: 'app' | 'src/app',
  opts: MountOptions = {},
): Promise<MountResult> {
  const segments = mountPath.replace(/^\//, '').split('/').filter(Boolean)
  const appSegments = appDir.split('/')
  const dir = join(cwd, ...appSegments, ...segments, '[[...slug]]')
  const file = join(dir, 'route.ts')
  if (await pathExists(file)) {
    await safeBackup(file)
  }
  await fs.mkdir(dir, { recursive: true })
  // src/ projects conventionally configure tsconfig `paths: { "@/*": ["./src/*"] }`,
  // which makes `@/gravel.config` resolve to `./src/gravel.config`. The
  // wizard writes `gravel.config.ts` at the cwd root, so we use a relative
  // import from the route file instead.
  const relPrefix = appDir === 'src/app' ? '../'.repeat(segments.length + 2) : '@/'
  const configImport = appDir === 'src/app' ? `${relPrefix}gravel.config` : `@/gravel.config`
  await fs.writeFile(
    file,
    `import { createGravelHandler } from '@artanis-ai/gravel/next'
import { config } from '${configImport}'

// Force-dynamic so Next never caches a snapshot of the manifest /
// samples / auth state. The dashboard polls these endpoints; cached
// responses make new prompts (or freshly-written drafts) invisible
// until the dev server restarts.
export const dynamic = 'force-dynamic'

const handler = createGravelHandler({ config })

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
`,
  )
  if (opts.withTracingDeps) {
    await installNextTracingHooks(cwd, { srcLayout: appDir === 'src/app' })
  }
  return { path: file, mode: 'created' }
}

async function mountNextPagesRouter(cwd: string, mountPath: string, opts: MountOptions = {}): Promise<MountResult> {
  const segments = mountPath.replace(/^\//, '').split('/').filter(Boolean)
  const dir = join(cwd, 'pages', ...segments)
  const file = join(dir, '[[...slug]].ts')
  if (await pathExists(file)) await safeBackup(file)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    file,
    `import { createGravelHandler } from '@artanis-ai/gravel/next-pages'
import { config } from '@/gravel.config'

export default createGravelHandler({ config })
`,
  )
  if (opts.withTracingDeps) {
    // Pages projects may still use `src/` for `pages/`; the helper
    // probes both instrumentation.ts candidates internally.
    await installNextTracingHooks(cwd, { srcLayout: false })
  }
  return { path: file, mode: 'created' }
}

async function mountFastApi(cwd: string, mountPath: string): Promise<MountResult> {
  // 1. Write the per-app router file the customer's main.py imports.
  const routeFile = join(cwd, 'gravel_route.py')
  if (await pathExists(routeFile)) await safeBackup(routeFile)
  await fs.writeFile(
    routeFile,
    `from artanis_gravel.fastapi import create_gravel_router
from gravel_config import config

router = create_gravel_router(config=config)
`,
  )

  // 2. Patch the customer's main.py / app.py to include our router.
  // Conventional locations, in priority order. Stops at the first match
  // so we don't write the same line into multiple candidate files.
  const candidates = ['main.py', 'app.py', 'src/main.py', 'src/app.py', 'app/main.py']
  for (const rel of candidates) {
    const file = join(cwd, rel)
    if (!(await pathExists(file))) continue
    const original = await fs.readFile(file, 'utf8')
    if (/from\s+gravel_route\s+import\s+router\s+as\s+gravel_router/.test(original)) {
      // Already mounted (re-running the wizard). Idempotent — leave alone.
      return { path: rel, mode: 'updated' }
    }
    if (!/\bFastAPI\s*\(/.test(original)) continue
    await safeBackup(file)
    const patched = patchFastApiMain(original, mountPath)
    if (patched === original) {
      // Couldn't find a safe insertion point; fall through to the
      // copy-paste instruction printout so the customer isn't blocked.
      printFastApiInstructions(rel, mountPath)
      return { path: rel, mode: 'manual-instructions' }
    }
    await fs.writeFile(file, patched)
    return { path: rel, mode: 'updated' }
  }
  // No main.py / app.py found — fall back to instructions.
  printFastApiInstructions('main.py', mountPath)
  return { path: routeFile, mode: 'manual-instructions' }
}

/**
 * Add the gravel router import + include_router call to a FastAPI
 * entry file. Returns the original string unchanged if no safe edit
 * point is found (caller surfaces this as a manual-instructions
 * fallback). Idempotent: a second pass over the patched output is a
 * no-op.
 *
 * The strategy:
 *  - Insert the import on the first line after the existing
 *    `from fastapi import ...` (or top of file if absent).
 *  - Insert the include_router call on the line after `app = FastAPI(…)`,
 *    which is the only place the wizard knows for sure that `app`
 *    exists. (Anywhere later risks running before app is defined.)
 *
 * If the file has more than one FastAPI() construction, only the
 * first is patched — surfacing this as ambiguous would just block the
 * customer; they can rerun the wizard against the right entry, or
 * paste manually.
 */
export function patchFastApiMain(source: string, mountPath: string): string {
  if (/from\s+gravel_route\s+import\s+router\s+as\s+gravel_router/.test(source)) return source
  const importLine = 'from gravel_route import router as gravel_router\n'
  const includeLine = `app.include_router(gravel_router, prefix='${mountPath}')\n`

  // Inject import after the last `from fastapi …` import block, or at the
  // top if there is none.
  let withImport = source
  const fastapiImportRe = /^from\s+fastapi\s+import\s+[^\n]+\n/gm
  const matches = [...source.matchAll(fastapiImportRe)]
  if (matches.length > 0) {
    const last = matches[matches.length - 1]!
    const insertAt = (last.index ?? 0) + last[0].length
    withImport = source.slice(0, insertAt) + importLine + source.slice(insertAt)
  } else {
    withImport = importLine + source
  }

  // Inject include_router after the first `app = FastAPI(…)` line. We
  // tolerate balanced parens on the same line (the common case); for
  // multi-line FastAPI() calls, fall back to copy-paste — robustly
  // matching multi-line calls would need a real parser.
  const fastapiCtorRe = /^([ \t]*)(\w+)\s*=\s*FastAPI\s*\([^()\n]*\)\s*$/m
  const m = withImport.match(fastapiCtorRe)
  if (!m) return source // signal failure: no safe insertion point
  const appName = m[2]
  const lineEnd = (m.index ?? 0) + m[0].length
  // Use the captured app name (might not literally be "app").
  const include = includeLine.replace(/^app\./, `${appName}.`)
  return withImport.slice(0, lineEnd) + '\n' + include + withImport.slice(lineEnd)
}

function printFastApiInstructions(relPath: string, mountPath: string): void {
  // eslint-disable-next-line no-console
  console.log(`
[gravel] Couldn't auto-edit ${relPath}. Add these two lines:

    from gravel_route import router as gravel_router

    app.include_router(gravel_router, prefix='${mountPath}')
`)
}

async function mountDjango(cwd: string, mountPath: string): Promise<MountResult> {
  // Find the root urls.py — the one referenced by ROOT_URLCONF in
  // settings.py. Conventional Django layouts put it at <project>/urls.py.
  // We try the common candidates; if none match, fall back to printing.
  const candidates = await findDjangoRootUrls(cwd)
  for (const file of candidates) {
    if (!(await pathExists(file))) continue
    const original = await fs.readFile(file, 'utf8')
    if (/from\s+artanis_gravel\.django\s+import\s+gravel_urls/.test(original)) {
      return { path: file.replace(`${cwd}/`, ''), mode: 'updated' }
    }
    if (!/\burlpatterns\s*=\s*\[/.test(original)) continue
    await safeBackup(file)
    const patched = patchDjangoUrls(original, mountPath)
    if (patched === original) {
      printDjangoInstructions(mountPath)
      return { path: file.replace(`${cwd}/`, ''), mode: 'manual-instructions' }
    }
    await fs.writeFile(file, patched)
    return { path: file.replace(`${cwd}/`, ''), mode: 'updated' }
  }
  printDjangoInstructions(mountPath)
  return { path: '<your urls.py>', mode: 'manual-instructions' }
}

/** Find candidate `urls.py` files. Project root first, then any
 * sibling directories that look like a Django project (have settings.py).
 */
async function findDjangoRootUrls(cwd: string): Promise<string[]> {
  const out: string[] = []
  // <cwd>/urls.py — rare, but possible.
  out.push(join(cwd, 'urls.py'))
  // <cwd>/<projectName>/urls.py — the conventional layout.
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // Skip obvious non-app dirs.
      if (/^(node_modules|\.git|\.venv|venv|env|__pycache__|migrations|static)$/.test(e.name)) continue
      const projectUrls = join(cwd, e.name, 'urls.py')
      const settings = join(cwd, e.name, 'settings.py')
      if (await pathExists(settings)) out.push(projectUrls)
    }
  } catch {
    /* unreadable dir — skip */
  }
  return out
}

/**
 * Add the gravel include to a Django root urls.py. Returns the
 * original unchanged if no safe edit point was found.
 *
 * Strategy:
 *  - Insert `from django.urls import path, include` (idempotent — only
 *    if `include` isn't already imported).
 *  - Insert `from artanis_gravel.django import gravel_urls`.
 *  - Insert the include `path(...)` as the FIRST entry of urlpatterns.
 *    First-not-last because /admin/ai is a prefix; placing it after a
 *    catch-all swallows it.
 */
export function patchDjangoUrls(source: string, mountPath: string): string {
  if (/from\s+artanis_gravel\.django\s+import\s+gravel_urls/.test(source)) return source

  // Ensure `path, include` are imported from django.urls. The default
  // settings.py / urls.py imports just `path`; we extend it.
  let patched = source
  const djangoUrlsImportRe = /^from\s+django\.urls\s+import\s+([^\n]+)$/m
  const m = patched.match(djangoUrlsImportRe)
  if (m) {
    const names = m[1]!.split(',').map((s) => s.trim())
    if (!names.includes('include')) {
      const newNames = [...names, 'include'].join(', ')
      patched = patched.replace(djangoUrlsImportRe, `from django.urls import ${newNames}`)
    }
  } else {
    // No django.urls import at all — insert one at the top.
    patched = `from django.urls import path, include\n` + patched
  }

  // Add gravel import right after the django.urls import block.
  const importLine = `from artanis_gravel.django import gravel_urls\n`
  const afterImports = patched.match(/^from\s+django\.urls\s+import[^\n]+\n/m)
  if (afterImports) {
    const insertAt = (afterImports.index ?? 0) + afterImports[0].length
    patched = patched.slice(0, insertAt) + importLine + patched.slice(insertAt)
  } else {
    patched = importLine + patched
  }

  // Insert the path() at the start of urlpatterns. We match the literal
  // `urlpatterns = [` and inject the new entry on the next line.
  const cleanMount = mountPath.replace(/^\/+|\/+$/g, '')
  const pathLine = `    path('${cleanMount}/', include(gravel_urls)),\n`
  const urlpatternsRe = /(urlpatterns\s*=\s*\[\s*\n)/m
  if (!urlpatternsRe.test(patched)) return source
  patched = patched.replace(urlpatternsRe, `$1${pathLine}`)
  return patched
}

function printDjangoInstructions(mountPath: string): void {
  // eslint-disable-next-line no-console
  console.log(`
[gravel] Couldn't auto-edit your root urls.py. Add the following:

    from django.urls import path, include
    from artanis_gravel.django import gravel_urls

    urlpatterns = [
        path('${mountPath.replace(/^\//, '')}/', include(gravel_urls)),
        # ... your existing routes ...
    ]
`)
}

function printExpressInstructions(mountPath: string): MountResult {
  // eslint-disable-next-line no-console
  console.log(`
[gravel] Add the following to your Express app entry:

    import { gravelHandler } from '@artanis-ai/gravel/node'
    import { config } from './gravel.config.js'

    app.use('${mountPath}', gravelHandler({ config }))
`)
  return { path: '<your Express entry>', mode: 'manual-instructions' }
}

function printGenericInstructions(mountPath: string): MountResult {
  // eslint-disable-next-line no-console
  console.log(`
[gravel] No automatic mounting available for this framework. Mount the handler
at ${mountPath} using the @artanis-ai/gravel/node adapter. See
https://gravel.artanis.ai/docs/install for examples.
`)
  return { path: '<your app entry>', mode: 'manual-instructions' }
}

/**
 * Write (or splice into) a Next.js `instrumentation.ts` file so the
 * gravel SDK's auto-patches install on server boot. Without this, an
 * \`import '@artanis-ai/gravel/auto'\` would have to live somewhere
 * the user's server actually executes — there's no obvious natural
 * home in a Next.js app, so the wizard plugs the gap via Next.js's
 * dedicated server-instrumentation hook.
 *
 * Spec: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Idempotency:
 *   - If a file at the right location already imports `@artanis-ai/gravel/auto`,
 *     leave it alone.
 *   - If it has a \`register()\` function but no gravel import, write a
 *     sibling \`.gravel.instrumentation.suggestion.txt\` and warn — we
 *     don't want to risk corrupting hand-written instrumentation.
 *   - Otherwise (no file, or only \`export default {}\`-shaped file),
 *     create a fresh one.
 */
async function ensureNextInstrumentation(cwd: string, srcLayout: boolean): Promise<void> {
  // Per Next.js docs, `instrumentation.ts` lives at the project root or
  // alongside the app/pages tree if the project uses a `src/` directory.
  const candidates = srcLayout
    ? [
        join(cwd, 'src', 'instrumentation.ts'),
        join(cwd, 'instrumentation.ts'),
        join(cwd, 'src', 'instrumentation.js'),
        join(cwd, 'instrumentation.js'),
      ]
    : [
        join(cwd, 'instrumentation.ts'),
        join(cwd, 'src', 'instrumentation.ts'),
        join(cwd, 'instrumentation.js'),
        join(cwd, 'src', 'instrumentation.js'),
      ]

  let existing: string | null = null
  let existingBody = ''
  for (const p of candidates) {
    if (await pathExists(p)) {
      existing = p
      existingBody = await fs.readFile(p, 'utf8')
      break
    }
  }

  if (
    existing &&
    existingBody.includes('@artanis-ai/gravel/auto') &&
    existingBody.includes('setGravelTracingConfig')
  ) {
    return
  }

  // The instrumentation needs to import the user's gravel.config so it
  // can wire the DB into the tracer at boot — without this, the first
  // LLM call before any /admin/ai/* request fires has nowhere to
  // persist (the in-handler `setGravelTracingConfig` call hasn't run
  // yet) and the trace is dropped.
  const configImport = srcLayout ? '../gravel.config' : './gravel.config'
  const body = `// Added by Gravel wizard. Next.js calls register() once on server
// startup — the canonical place to bootstrap server-side instrumentation.
// We import \`@artanis-ai/gravel/auto\` so the SDK's monkey-patches for
// OpenAI / Anthropic / LangChain / Vercel AI / raw fetch install
// before any LLM call fires, then we hand the resolved config to
// setGravelTracingConfig so traces have a DB to land in straight away
// (without this, the first LLM call before any /admin/ai/* request
// gets dropped because the handler hasn't initialised the DB yet).
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  await import('@artanis-ai/gravel/auto')
  const [{ setGravelTracingConfig, resolveConfig }, { config }] = await Promise.all([
    import('@artanis-ai/gravel'),
    import('${configImport}'),
  ])
  setGravelTracingConfig(resolveConfig(config))
}
`

  if (existing && /\bregister\s*\(/.test(existingBody)) {
    // Hand-written instrumentation with its own register(). Don't risk
    // corrupting it — emit a sibling .suggestion.txt with the snippet.
    await fs.writeFile(
      existing + '.gravel.instrumentation.suggestion.txt',
      `// Add this inside your existing register() function so gravel's
// auto-patches install on Next.js server boot AND the tracer has a
// DB to write to before the first request:

if (process.env.NEXT_RUNTIME === 'nodejs') {
  await import('@artanis-ai/gravel/auto')
  const [{ setGravelTracingConfig, resolveConfig }, { config }] = await Promise.all([
    import('@artanis-ai/gravel'),
    import('${configImport}'),
  ])
  setGravelTracingConfig(resolveConfig(config))
}
`,
    )
    // eslint-disable-next-line no-console
    console.log(
      `[gravel] Found existing ${existing} — wrote suggestion to ${existing}.gravel.instrumentation.suggestion.txt. Splice the snippet into your register() to enable auto-tracing.`,
    )
    return
  }

  // Fresh write. Pick the first preferred path that doesn't exist.
  const target = existing ?? candidates[0]!
  if (existing) await safeBackup(existing)
  await fs.writeFile(target, body)
}

/**
 * Back up a file before we rewrite it — but only when git can't already
 * undo the change. If the file is tracked by git, the working-tree edit
 * is fully reversible via `git restore <file>` / `git checkout HEAD --
 * <file>`, so a sibling `.gravel.bak` is just clutter the dev has to
 * `.gitignore` or delete.
 *
 * Untracked files (or non-git projects) still get a `.gravel.bak`
 * companion since git won't help recover those.
 */
async function safeBackup(file: string): Promise<void> {
  if (isTrackedByGit(file)) return
  const bak = file + '.gravel.bak'
  await fs.copyFile(file, bak)
  // eslint-disable-next-line no-console
  console.log(`[gravel] ${file} is untracked; backed up to ${bak}.`)
}

function isTrackedByGit(file: string): boolean {
  const dir = dirname(file)
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: dir,
    stdio: 'ignore',
  })
  return result.status === 0
}

/**
 * Patch (or create) the project's `next.config.{ts,js,mjs}` to mark
 * `@artanis-ai/gravel`, `pg`, and `better-sqlite3` as
 * `serverExternalPackages` (Next 15) / `experimental.serverComponentsExternalPackages`
 * (Next 14). Without this, webpack tries to bundle the gravel SDK's
 * native peer deps and the dashboard route 500s with a "Could not
 * locate the bindings file" / "Module not found" error.
 *
 * Idempotent: looks for the package names in the existing config text;
 * if they're already mentioned anywhere in the file, leaves it alone.
 * Otherwise:
 *   - `next.config.ts` / `next.config.mjs`: regex-rewrites the
 *     `export default {…}` body. If the file is just `export default {}`
 *     we replace cleanly. If it's anything more complex, we back it up
 *     and emit a polite-blocking notice.
 *   - No `next.config.*`: writes a fresh `next.config.mjs`.
 */
async function ensureNextServerExternalPackages(cwd: string): Promise<void> {
  const candidates = ['next.config.ts', 'next.config.mjs', 'next.config.js']
  let target: string | null = null
  let body = ''
  for (const f of candidates) {
    const p = join(cwd, f)
    if (await pathExists(p)) {
      target = p
      body = await fs.readFile(p, 'utf8')
      break
    }
  }

  // App Router uses `serverExternalPackages` (Next 15) — keeps the listed
  // packages out of the App Router server bundle. Pages Router API routes
  // need a webpack `externals` block too. We add both so a project that
  // mounts under either router (or both) works.
  const required = ['@artanis-ai/gravel', 'pg', 'better-sqlite3']
  const block = `
  serverExternalPackages: ['@artanis-ai/gravel', 'pg', 'better-sqlite3'],
  webpack: (cfg, { isServer }) => {
    if (isServer) {
      cfg.externals = cfg.externals || []
      cfg.externals.push('better-sqlite3', 'pg', '@artanis-ai/gravel', '@artanis-ai/gravel/next', '@artanis-ai/gravel/next-pages', '@artanis-ai/gravel/auto')
    }
    return cfg
  },`

  // Already patched? Heuristic: webpack externals function with our
  // package names already in the file.
  if (
    target &&
    body.includes('@artanis-ai/gravel') &&
    body.includes('externals') &&
    required.every((pkg) => body.includes(`'${pkg}'`) || body.includes(`"${pkg}"`))
  ) {
    return
  }

  if (!target) {
    // No config file — create a minimal one.
    const newPath = join(cwd, 'next.config.mjs')
    await fs.writeFile(
      newPath,
      `// Added by Gravel wizard. Keeps Next.js's webpack from trying to
// bundle gravel's native peer deps (pg, better-sqlite3) into the
// server bundle. \`serverExternalPackages\` covers App Router server
// code; the \`webpack\` externals block covers Pages Router API
// routes (which are still bundled by webpack).
const config = {${block}
}
export default config
`,
    )
    return
  }

  // Splice in. Cheap path: empty config object.
  if (/export default\s*\{\s*\}/.test(body)) {
    const patched = body.replace(/export default\s*\{\s*\}/, `export default {${block}\n}`)
    await safeBackup(target)
    await fs.writeFile(target, patched)
    return
  }

  // Otherwise: write a sibling suggestion file. The user's config is
  // non-trivial; we don't want to risk corrupting it with a regex-rewrite.
  await fs.writeFile(
    target + '.gravel.next-config.suggestion.txt',
    `Add this to your Next.js config's exported object so the gravel
dashboard route doesn't 500 with "Module not found":${block}

If you only use App Router, the \`serverExternalPackages\` line alone
is enough. The \`webpack\` block additionally keeps Pages Router API
routes from bundling the native peer deps.
`,
  )
  // eslint-disable-next-line no-console
  console.log(
    `[gravel] Could not auto-patch ${target} — wrote a suggestion to ${target}.gravel.next-config.suggestion.txt. Add the snippet to fix dashboard 500s.`,
  )
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// dirname re-export silenced (unused here but useful for future imports).
export { dirname }
