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
import { join, dirname } from 'node:path'
import type { DetectionResult } from './detect.js'

export type MountResult = {
  path: string
  mode: 'created' | 'updated' | 'manual-instructions'
} | null

export interface MountOptions {
  /**
   * Skip writing/patching `instrumentation.ts` (Next.js only). The file
   * is what bootstraps `import '@artanis-ai/gravel/auto'` server-side
   * so LLM calls auto-trace; without it you'd have to add the import
   * manually somewhere on the server boot path.
   */
  noInstrumentation?: boolean
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
      return printDjangoInstructions(mountPath)
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

const handler = createGravelHandler({ config })

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
`,
  )
  await ensureNextServerExternalPackages(cwd)
  if (!opts.noInstrumentation) {
    await ensureNextInstrumentation(cwd, appDir === 'src/app')
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
  await ensureNextServerExternalPackages(cwd)
  if (!opts.noInstrumentation) {
    // Pages projects don't have a `src/app/` convention, but they may
    // still use `src/` for `pages/`. We probe both `instrumentation.ts`
    // candidates inside `ensureNextInstrumentation`, so just default to
    // root for the seed location.
    await ensureNextInstrumentation(cwd, false)
  }
  return { path: file, mode: 'created' }
}

async function mountFastApi(cwd: string, mountPath: string): Promise<MountResult> {
  const file = join(cwd, 'gravel_route.py')
  if (await pathExists(file)) await safeBackup(file)
  await fs.writeFile(
    file,
    `from artanis_gravel.fastapi import create_gravel_router
from gravel_config import config

router = create_gravel_router(config=config)
`,
  )
  // BLOCKER: AST-edit main.py to add `app.include_router(router, prefix='${mountPath}')`.
  // For now, print the line to add.
  return { path: file, mode: 'created' }
}

function printDjangoInstructions(mountPath: string): MountResult {
  // BLOCKER: locate the project's root urls.py and AST-add the include.
  // For v0, we print instructions.
  // eslint-disable-next-line no-console
  console.log(`
[gravel] Add the following to your root urls.py:

    from django.urls import path, include
    from artanis_gravel.django import gravel_urls

    urlpatterns = [
        # ... your existing routes ...
        path('${mountPath.replace(/^\//, '')}/', include(gravel_urls)),
    ]
`)
  return { path: '<your urls.py>', mode: 'manual-instructions' }
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

  if (existing && existingBody.includes('@artanis-ai/gravel/auto')) return

  if (existing && /\bregister\s*\(/.test(existingBody)) {
    // Hand-written instrumentation with its own register(). Don't risk
    // corrupting it — emit a sibling .suggestion.txt with the snippet.
    await fs.writeFile(
      existing + '.gravel.instrumentation.suggestion.txt',
      `// Add this inside your existing register() function so gravel's
// auto-patches install on Next.js server boot:

if (process.env.NEXT_RUNTIME === 'nodejs') {
  await import('@artanis-ai/gravel/auto')
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
  await fs.writeFile(
    target,
    `// Added by Gravel wizard. Next.js calls register() once on server
// startup — the canonical place to bootstrap server-side instrumentation.
// We import \`@artanis-ai/gravel/auto\` so the SDK's monkey-patches for
// OpenAI / Anthropic / LangChain / Vercel AI / raw fetch install
// before any LLM call fires, and traces flow into gravel_traces.
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@artanis-ai/gravel/auto')
  }
}
`,
  )
}

async function safeBackup(file: string): Promise<void> {
  const bak = file + '.gravel.bak'
  await fs.copyFile(file, bak)
  // eslint-disable-next-line no-console
  console.log(`[gravel] Existing ${file} backed up to ${bak}.`)
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
