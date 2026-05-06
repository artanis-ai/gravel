/**
 * Framework / package-manager / DB / auth detection used by the wizard.
 *
 * Spec: gravel-cloud/docs/spec/wizard.md §2 step 1.
 *
 * All detection is best-effort and reversible — we never write anything
 * during detection; we just look.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm' | 'uv' | 'poetry' | 'pip' | 'pipenv'

export type Framework =
  | 'next-app-router'
  | 'next-pages-router'
  | 'express'
  | 'fastify'
  | 'hono'
  | 'fastapi'
  | 'django'
  | 'flask'
  | 'generic-node'
  | 'generic-asgi'
  | 'generic-wsgi'

export type DbDriver = 'postgres' | 'sqlite' | 'mysql' | 'unknown'

export type AuthProvider = 'clerk' | 'next-auth' | 'better-auth' | 'lucia' | 'auth0' | 'fastapi-users' | 'django-auth' | 'unknown'

export interface DetectionResult {
  cwd: string
  language: 'ts' | 'python'
  packageManager: PackageManager
  framework: Framework
  /**
   * For Next.js projects, where `app/` lives relative to `cwd`. Empty
   * string for the root convention (`./app/`); `'src'` for the src/
   * convention (`./src/app/`); `null` if neither (e.g. pages-router
   * project, or non-Next stack).
   */
  nextAppDir: 'app' | 'src/app' | null
  /**
   * For Next.js projects: true if BOTH `app/` (or `src/app/`) AND
   * `pages/` (or `src/pages/`) exist — incremental migration scenario.
   * The wizard prefers app router but surfaces this so the caller can
   * warn the user.
   */
  nextHasBothRouters: boolean
  database: { driver: DbDriver; envVar: string | null }
  auth: AuthProvider
  existingTracers: string[]
  hasGit: boolean
}

export async function detect(cwd: string = process.cwd()): Promise<DetectionResult> {
  const tsResult = await detectTs(cwd)
  if (tsResult) return tsResult
  const pyResult = await detectPython(cwd)
  if (pyResult) return pyResult
  // No clear language detected — assume TS-generic-node as the safe fallback.
  return {
    cwd,
    language: 'ts',
    packageManager: 'npm',
    framework: 'generic-node',
    nextAppDir: null,
    nextHasBothRouters: false,
    database: { driver: 'unknown', envVar: null },
    auth: 'unknown',
    existingTracers: [],
    hasGit: await pathExists(join(cwd, '.git')),
  }
}

async function detectTs(cwd: string): Promise<DetectionResult | null> {
  const pkgPath = join(cwd, 'package.json')
  if (!(await pathExists(pkgPath))) return null
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, any>
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

  const packageManager: PackageManager = (await pathExists(join(cwd, 'pnpm-lock.yaml')))
    ? 'pnpm'
    : (await pathExists(join(cwd, 'yarn.lock')))
      ? 'yarn'
      : // Bun ≥1.2 default is text-format `bun.lock`; older versions used
        // the binary `bun.lockb`. Check both so the wizard catches projects
        // that opted into the new format.
        (await pathExists(join(cwd, 'bun.lock'))) || (await pathExists(join(cwd, 'bun.lockb')))
        ? 'bun'
        : 'npm'

  let framework: Framework = 'generic-node'
  let nextAppDir: 'app' | 'src/app' | null = null
  let nextHasBothRouters = false
  if (allDeps['next']) {
    // Detect the App Router by looking in both conventional locations:
    // `app/` at the repo root, or `src/app/`. Same for `pages/`. A project
    // with both directories (incremental migration) is flagged via
    // `nextHasBothRouters` so the wizard surfaces a warning rather than
    // silently picking app-router.
    const hasAppRoot = await pathExists(join(cwd, 'app'))
    const hasAppSrc = await pathExists(join(cwd, 'src', 'app'))
    const hasPagesRoot = await pathExists(join(cwd, 'pages'))
    const hasPagesSrc = await pathExists(join(cwd, 'src', 'pages'))
    if (hasAppRoot) nextAppDir = 'app'
    else if (hasAppSrc) nextAppDir = 'src/app'
    framework = nextAppDir ? 'next-app-router' : 'next-pages-router'
    nextHasBothRouters = !!nextAppDir && (hasPagesRoot || hasPagesSrc)
  } else if (allDeps['express']) {
    framework = 'express'
  } else if (allDeps['fastify']) {
    framework = 'fastify'
  } else if (allDeps['hono']) {
    framework = 'hono'
  }

  const auth: AuthProvider = allDeps['@clerk/nextjs']
    ? 'clerk'
    : allDeps['@clerk/clerk-js']
      ? 'clerk'
      : allDeps['next-auth']
        ? 'next-auth'
        : allDeps['better-auth']
          ? 'better-auth'
          : allDeps['lucia']
            ? 'lucia'
            : allDeps['@auth0/auth0-react'] || allDeps['@auth0/nextjs-auth0']
              ? 'auth0'
              : 'unknown'

  const dbEnv = await readEnvVar(cwd, ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL'])
  const database = inferDb(dbEnv)

  const existingTracers: string[] = []
  if (allDeps['@sentry/node'] || allDeps['@sentry/nextjs']) existingTracers.push('Sentry')
  if (allDeps['langsmith']) existingTracers.push('LangSmith')
  if (allDeps['langfuse']) existingTracers.push('Langfuse')

  return {
    cwd,
    language: 'ts',
    packageManager,
    framework,
    nextAppDir,
    nextHasBothRouters,
    database,
    auth,
    existingTracers,
    hasGit: await pathExists(join(cwd, '.git')),
  }
}

async function detectPython(cwd: string): Promise<DetectionResult | null> {
  const hasPyproject = await pathExists(join(cwd, 'pyproject.toml'))
  const hasManagePy = await pathExists(join(cwd, 'manage.py'))
  const hasReqs = await pathExists(join(cwd, 'requirements.txt'))
  if (!hasPyproject && !hasManagePy && !hasReqs) return null

  const pmText = await readManyOptional(cwd, ['pyproject.toml', 'requirements.txt', 'Pipfile'])
  const packageManager: PackageManager = (await pathExists(join(cwd, 'uv.lock')))
    ? 'uv'
    : (await pathExists(join(cwd, 'poetry.lock')))
      ? 'poetry'
      : (await pathExists(join(cwd, 'Pipfile.lock')))
        ? 'pipenv'
        : 'pip'

  const allText = pmText.join('\n').toLowerCase()
  let framework: Framework = 'generic-asgi'
  if (hasManagePy || allText.includes('django')) framework = 'django'
  else if (allText.includes('fastapi')) framework = 'fastapi'
  else if (allText.includes('flask')) framework = 'flask'

  const auth: AuthProvider = allText.includes('django.contrib.auth') || hasManagePy
    ? 'django-auth'
    : allText.includes('fastapi-users')
      ? 'fastapi-users'
      : 'unknown'

  const dbEnv = await readEnvVar(cwd, ['DATABASE_URL', 'POSTGRES_URL'])
  const database = inferDb(dbEnv)

  const existingTracers: string[] = []
  if (allText.includes('sentry-sdk')) existingTracers.push('Sentry')
  if (allText.includes('langsmith')) existingTracers.push('LangSmith')
  if (allText.includes('langfuse')) existingTracers.push('Langfuse')

  return {
    cwd,
    language: 'python',
    packageManager,
    framework,
    nextAppDir: null,
    nextHasBothRouters: false,
    database,
    auth,
    existingTracers,
    hasGit: await pathExists(join(cwd, '.git')),
  }
}

function inferDb(envValue: { name: string; value: string } | null): DetectionResult['database'] {
  if (!envValue) return { driver: 'unknown', envVar: null }
  if (envValue.value.startsWith('postgres')) return { driver: 'postgres', envVar: envValue.name }
  if (envValue.value.startsWith('mysql')) return { driver: 'mysql', envVar: envValue.name }
  if (envValue.value.startsWith('file:') || envValue.value.endsWith('.db')) {
    return { driver: 'sqlite', envVar: envValue.name }
  }
  return { driver: 'unknown', envVar: envValue.name }
}

async function readEnvVar(cwd: string, candidates: string[]): Promise<{ name: string; value: string } | null> {
  for (const file of ['.env.local', '.env']) {
    const path = join(cwd, file)
    if (!(await pathExists(path))) continue
    const text = await fs.readFile(path, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      const [, name, raw] = m as unknown as [string, string, string]
      if (!candidates.includes(name)) continue
      const value = raw.replace(/^['"]|['"]$/g, '')
      return { name, value }
    }
  }
  return null
}

async function readManyOptional(cwd: string, files: string[]): Promise<string[]> {
  const results: string[] = []
  for (const f of files) {
    try {
      results.push(await fs.readFile(join(cwd, f), 'utf8'))
    } catch {
      /* ignore */
    }
  }
  return results
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
