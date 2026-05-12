/**
 * Generates `gravel.config.ts` (or `.py`) tailored to the detected stack.
 *
 * Wizard step 5b. Spec: gravel-cloud/docs/spec/wizard.md §2 step 5.
 *
 * v0 emits a minimal config. AST integration (auth callback wiring per
 * provider) lives in step 5a (mount.ts) for now; future iterations will
 * AST-edit existing config files instead of writing alongside.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DetectionResult } from './detect.js'

export interface ConfigFileOptions {
  mountPath: string
  /**
   * When false, omit the `database` block entirely. Prompts-only
   * installs run with no DB at all — every DB-dependent code path
   * (handler/index.ts ensureDb, tracing/persist.ts getDb) checks
   * `config.database` for null and short-circuits. Adding the block
   * later (`gravel init --traces`) re-enables tracing.
   */
  withDatabase?: boolean
}

export async function generateConfigFile(
  detection: DetectionResult,
  cwd: string,
  opts: ConfigFileOptions,
): Promise<string> {
  // Always overwrites. The wizard calls this twice intentionally:
  // once paired with the mount (no DB block) and again after the
  // traces pillar succeeds (with DB block). Hand-edited configs
  // are out of scope for v0 — re-run `gravel init` to regenerate.
  if (detection.language === 'ts') {
    const path = join(cwd, 'gravel.config.ts')
    await fs.writeFile(path, await tsConfigContent(detection, cwd, opts))
    return path
  }
  const path = join(cwd, 'gravel_config.py')
  await fs.writeFile(path, pyConfigContent(detection, opts))
  return path
}

async function tsConfigContent(
  detection: DetectionResult,
  cwd: string,
  opts: ConfigFileOptions,
): Promise<string> {
  // The next-auth template imports `auth` from `@/auth` — the
  // canonical NextAuth v5 location. Some projects keep their helper
  // elsewhere (e.g. `lib/auth.ts`) or are pre-v5 and don't have one
  // at all. If we can't find it we'd emit a config that 500s every
  // dashboard request with "Module not found: @/auth", so fall back
  // to the password-only template and let the user wire getUser
  // themselves later.
  let auth = detection.auth
  if (auth === 'next-auth' && !(await nextAuthHelperExists(cwd))) {
    auth = 'unknown'
  }
  const authBlock = auth === 'clerk'
    ? clerkAuthBlock()
    : auth === 'next-auth'
      ? nextAuthBlock()
      : passwordOnlyAuthBlock()

  const dbBlock = opts.withDatabase
    ? `  database: {
    url: process.env.${detection.database.envVar ?? 'DATABASE_URL'}!,
  },
`
    : ''

  // Import defineConfig from the dedicated edge-safe sub-entry. The
  // main `@artanis-ai/gravel` entry pulls Node builtins (better-sqlite3,
  // node:fs, etc.) and so fails to bundle for the edge runtime when the
  // host has middleware (Clerk, NextAuth, …) — Next compiles
  // `instrumentation.ts` for both runtimes whenever middleware exists,
  // and a static `import { defineConfig } from '@artanis-ai/gravel'` in
  // gravel.config.ts breaks the edge bundle. `/define` is just types +
  // type-passthrough helpers, no Node deps.
  return `import { defineConfig } from '@artanis-ai/gravel/define'
${authImport(auth)}

export const config = defineConfig({
  mountPath: '${opts.mountPath}',
${dbBlock}${authBlock}
})
`
}

function authImport(auth: DetectionResult['auth']): string {
  if (auth === 'clerk') return "import { auth } from '@clerk/nextjs/server'"
  if (auth === 'next-auth') return "import { auth as nextAuth } from '@/auth'"
  return ''
}

/**
 * NextAuth v5 conventionally exports `auth` from `auth.ts` at the
 * project root (or `src/auth.ts` for `src/`-layout projects). Older
 * setups use `pages/api/auth/[...nextauth].ts` instead, which doesn't
 * export a request-side `auth()` helper. We require the v5 helper to
 * exist before generating the next-auth config — otherwise the
 * dashboard 500s on every request with `Module not found: '@/auth'`.
 */
async function nextAuthHelperExists(cwd: string): Promise<boolean> {
  for (const candidate of ['auth.ts', 'auth.js', 'src/auth.ts', 'src/auth.js']) {
    try {
      await fs.access(join(cwd, candidate))
      return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

function clerkAuthBlock(): string {
  return `  auth: {
    async getUser() {
      const { userId, sessionClaims } = await auth()
      if (!userId) return null
      return {
        id: userId,
        firstName: (sessionClaims?.first_name as string) ?? 'User',
        // TODO: define your own admin check
        role: 'user',
      }
    },
  },`
}

function nextAuthBlock(): string {
  return `  auth: {
    async getUser() {
      const session = await nextAuth()
      if (!session?.user) return null
      return {
        id: session.user.id,
        firstName: session.user.name?.split(' ')[0] ?? 'User',
        role: 'user',
      }
    },
  },`
}

function passwordOnlyAuthBlock(): string {
  return `  auth: {
    // No auth callback detected. Default-password mode is active.
    // Configure getUser() to integrate with your real auth.
    defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!,
  },`
}

function pyConfigContent(detection: DetectionResult, opts: ConfigFileOptions): string {
  const dbEnv = detection.database.envVar ?? 'DATABASE_URL'
  const auth =
    detection.auth === 'django-auth'
      ? `\nasync def get_user(req):
    django_user = req.scope.get('user')
    if not django_user or not getattr(django_user, 'is_authenticated', False):
        return None
    return GravelUser(
        id=str(django_user.id),
        first_name=django_user.first_name or 'User',
        role='admin' if django_user.groups.filter(name='gravel_admin').exists() else 'user',
    )

`
      : ''

  const authConfig =
    detection.auth === 'django-auth'
      ? `auth={'get_user': get_user},`
      : `auth={'default_password': os.environ['GRAVEL_ADMIN_PASSWORD']},`

  return `import os
from artanis_gravel import GravelConfig, GravelUser
${auth}
config = GravelConfig(
    mount_path='${opts.mountPath}',
    database={'url': os.environ['${dbEnv}']},
    ${authConfig}
)
`
}

