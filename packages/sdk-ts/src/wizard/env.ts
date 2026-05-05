/**
 * Generates a random admin password (default-mode auth) and appends Gravel
 * env vars to the user's .env.local (TS) or .env (Py) without clobbering.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function generatePassword(): string {
  // 32 chars, alnum + a few specials. URL-safe-ish.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(32)
  let out = ''
  for (let i = 0; i < 32; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

export async function writeEnvAdditions(cwd: string, vars: Record<string, string>): Promise<void> {
  // Prefer .env.local (Next convention) if present, else .env
  const localPath = join(cwd, '.env.local')
  const fallback = join(cwd, '.env')
  let target = localPath
  let existing = ''
  try {
    existing = await fs.readFile(localPath, 'utf8')
  } catch {
    try {
      existing = await fs.readFile(fallback, 'utf8')
      target = fallback
    } catch {
      target = localPath
    }
  }

  const lines: string[] = []
  if (!existing.includes('GRAVEL_PROJECT_ID')) lines.push('# Added by Gravel wizard')
  for (const [k, v] of Object.entries(vars)) {
    if (existing.includes(`${k}=`)) continue // never overwrite
    lines.push(`${k}=${v}`)
  }
  if (lines.length > 0) {
    const sep = existing.endsWith('\n') ? '' : existing.length > 0 ? '\n' : ''
    await fs.writeFile(target, existing + sep + lines.join('\n') + '\n')
  }
}
