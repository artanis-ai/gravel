/**
 * Minimal host app for the Gravel E2E suite.
 *
 * Mounts `createGravelHandler` (workspace-linked) at `/admin/ai/*` using
 * Hono + @hono/node-server. SQLite (file-backed) + default-password mode
 * keeps the fixture self-contained — no Postgres, no control plane, no
 * external network calls.
 *
 * Env:
 *   E2E_PORT — port to listen on (default 4321)
 *   GRAVEL_ADMIN_PASSWORD — required; the password the tests log in with
 *   DATABASE_URL — sqlite URL, e.g. file:./test.db
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGravelHandler, defineConfig } from '@artanis-ai/gravel'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')

const PORT = Number(process.env.E2E_PORT ?? 4321)
const PASSWORD = process.env.GRAVEL_ADMIN_PASSWORD
const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./test.db'

if (!PASSWORD) {
  console.error('[e2e] GRAVEL_ADMIN_PASSWORD is required')
  process.exit(1)
}

// Wipe any prior sqlite file so each `pnpm dev` starts clean. (Playwright's
// webServer reuses across tests within one run, but a fresh file across
// runs avoids stale-schema surprises.)
async function ensureFreshDb() {
  if (!DATABASE_URL.startsWith('file:')) return
  const path = resolve(APP_ROOT, DATABASE_URL.replace(/^file:/, ''))
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await fs.rm(path + suffix, { force: true })
  }
}

const config = defineConfig({
  mountPath: '/admin/ai',
  database: { url: DATABASE_URL },
  auth: { defaultPassword: PASSWORD },
  // The E2E suite exists to exercise the password / session flow end-to-end,
  // which the localhost = admin shortcut would short-circuit. Disable the
  // shortcut so Playwright actually drives login + cookie roundtrip.
  localhostIsAdmin: false,
})

const handler = createGravelHandler({ config })

const app = new Hono()

app.get('/', (c) => c.text('e2e-test-app: Gravel mounted at /admin/ai'))

// Forward every request under the mount path (and the bare mount path
// itself) to the Gravel fetch handler. Hono passes the raw web `Request`
// straight through.
app.all('/admin/ai', (c) => handler(c.req.raw))
app.all('/admin/ai/*', (c) => handler(c.req.raw))

await ensureFreshDb()

serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[e2e] listening on http://localhost:${info.port} — Gravel at /admin/ai`)
})
