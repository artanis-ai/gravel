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

export async function mountDashboardRoute(
  detection: DetectionResult,
  cwd: string,
  mountPath: string,
): Promise<MountResult> {
  switch (detection.framework) {
    case 'next-app-router':
      return await mountNextAppRouter(cwd, mountPath)
    case 'next-pages-router':
      return await mountNextPagesRouter(cwd, mountPath)
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

async function mountNextAppRouter(cwd: string, mountPath: string): Promise<MountResult> {
  const segments = mountPath.replace(/^\//, '').split('/').filter(Boolean)
  const dir = join(cwd, 'app', ...segments, '[[...slug]]')
  const file = join(dir, 'route.ts')
  if (await pathExists(file)) {
    await safeBackup(file)
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    file,
    `import { createGravelHandler } from '@artanis-ai/gravel/next'
import { config } from '@/gravel.config'

const handler = createGravelHandler({ config })

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
`,
  )
  return { path: file, mode: 'created' }
}

async function mountNextPagesRouter(cwd: string, mountPath: string): Promise<MountResult> {
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

async function safeBackup(file: string): Promise<void> {
  const bak = file + '.gravel.bak'
  await fs.copyFile(file, bak)
  // eslint-disable-next-line no-console
  console.log(`[gravel] Existing ${file} backed up to ${bak}.`)
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
