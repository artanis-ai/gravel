/**
 * Tiny .env reader for the wizard. Avoids pulling in dotenv as a hard dep.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export async function config(cwd: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>
  for (const file of ['.env', '.env.local']) {
    try {
      const text = await fs.readFile(join(cwd, file), 'utf8')
      for (const line of text.split('\n')) {
        const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        if (!m) continue
        const [, key, raw] = m as unknown as [string, string, string]
        if (key in out) continue // process.env wins
        out[key] = raw.replace(/^['"]|['"]$/g, '')
      }
    } catch {
      /* file missing — fine */
    }
  }
  return out
}
