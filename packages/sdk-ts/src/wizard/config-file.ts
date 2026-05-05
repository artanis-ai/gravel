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
}

export async function generateConfigFile(
  detection: DetectionResult,
  cwd: string,
  opts: ConfigFileOptions,
): Promise<string> {
  if (detection.language === 'ts') {
    const path = join(cwd, 'gravel.config.ts')
    if (await pathExists(path)) return path
    await fs.writeFile(path, tsConfigContent(detection, opts))
    return path
  }
  const path = join(cwd, 'gravel_config.py')
  if (await pathExists(path)) return path
  await fs.writeFile(path, pyConfigContent(detection, opts))
  return path
}

function tsConfigContent(detection: DetectionResult, opts: ConfigFileOptions): string {
  const authBlock = detection.auth === 'clerk'
    ? clerkAuthBlock()
    : detection.auth === 'next-auth'
      ? nextAuthBlock()
      : passwordOnlyAuthBlock()

  return `import { defineConfig } from '@artanis/gravel'
${authImport(detection.auth)}

export const config = defineConfig({
  mountPath: '${opts.mountPath}',
  database: {
    url: process.env.${detection.database.envVar ?? 'DATABASE_URL'}!,
  },
${authBlock}
})
`
}

function authImport(auth: DetectionResult['auth']): string {
  if (auth === 'clerk') return "import { auth } from '@clerk/nextjs/server'"
  if (auth === 'next-auth') return "import { auth as nextAuth } from '@/auth'"
  return ''
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
