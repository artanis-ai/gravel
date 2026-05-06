#!/usr/bin/env node
/**
 * Writes a minimal stub `src/handler/dashboard-bundle.ts` so the
 * TypeScript module resolves before the real Vite-built bundle has been
 * generated. Used by `pnpm test` / `pnpm typecheck` workflows where we
 * don't want to force a full dashboard rebuild.
 *
 * Pass `--if-missing` to make the write a no-op when the file already
 * exists (production builds via `build:bundle` overwrite with the real
 * artifact).
 */
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = resolve(__dirname, '..')
const OUTPUT_FILE = join(SDK_ROOT, 'src', 'handler', 'dashboard-bundle.ts')

async function main() {
  const ifMissing = process.argv.includes('--if-missing')
  if (ifMissing) {
    try {
      await fs.access(OUTPUT_FILE)
      return // already there, leave it alone
    } catch {
      // fall through to write the stub
    }
  }

  const stub = [
    '// AUTO-GENERATED stub by scripts/stub-dashboard.mjs.',
    '// Replaced with the real bundle by scripts/build-dashboard.mjs',
    '// during `pnpm build`. Do not edit.',
    '',
    'export interface DashboardAsset {',
    '  /** base64-encoded file contents. Decode at response time. */',
    '  content: string',
    '  contentType: string',
    '}',
    '',
    'export const DASHBOARD_INDEX_HTML: string =',
    `  '<!doctype html><html><head><meta charset=\"UTF-8\"><title>Gravel</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"./assets/stub.js\"></script></body></html>'`,
    '',
    'export const DASHBOARD_LOGIN_HTML: string = DASHBOARD_INDEX_HTML',
    '',
    'export const DASHBOARD_ASSETS: Record<string, DashboardAsset> = {',
    `  'stub.js': {`,
    `    content: '',`,
    `    contentType: 'application/javascript; charset=utf-8',`,
    '  },',
    '}',
    '',
  ].join('\n')

  await fs.mkdir(dirname(OUTPUT_FILE), { recursive: true })
  await fs.writeFile(OUTPUT_FILE, stub, 'utf8')
  console.log(`[stub-dashboard] wrote stub at ${OUTPUT_FILE}`)
}

main().catch((err) => {
  console.error('[stub-dashboard] fatal:', err)
  process.exit(1)
})
