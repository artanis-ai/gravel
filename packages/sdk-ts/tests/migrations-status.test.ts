/**
 * Tests for the migration-status surface — both the `pendingMigrationCount`
 * helper and the `/api/migrations/status` route. The dashboard banner is
 * the loudest pre-deploy signal we have for "you forgot to run
 * `gravel migrate`", so its inputs must be honest.
 *
 * Strategy:
 *   - Open a real SQLite DB in a tmpdir (the same path the dashboard
 *     uses), let bootstrap create the gravel_* tables, then assert
 *     pendingMigrationCount returns a sensible value.
 *   - Drive the route via the handler with the localhost-admin
 *     shortcut so we exercise the auth gate end-to-end.
 *   - Verify the route 401s for non-localhost unauthed callers (the
 *     count is part of the ops surface, no leak to the public).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetHandlerForTests, createGravelHandler } from '../src/handler/index.js'
import { _resetGravelTracingForTests } from '../src/tracing/persist.js'
import { openDatabase } from '../src/db/index.js'
import { pendingMigrationCount, shouldAutoMigrate } from '../src/db/migrate.js'

let sandbox: string
beforeEach(async () => {
  _resetHandlerForTests()
  _resetGravelTracingForTests()
  sandbox = await mkdtemp(join(tmpdir(), 'gravel-migrations-status-'))
  // Disable auto-migrate so opening the DB doesn't try to apply
  // anything during these tests — we want to OBSERVE pending count,
  // not have openDatabase silently drain it.
  process.env.GRAVEL_DISABLE_AUTO_MIGRATE = '1'
})
afterEach(async () => {
  delete process.env.GRAVEL_DISABLE_AUTO_MIGRATE
  await rm(sandbox, { recursive: true, force: true })
})

describe('pendingMigrationCount', () => {
  it('returns 0 when the SDK ships no migrations folder', async () => {
    // The SDK doesn't actually ship migrations today — the bootstrap
    // is the source of truth — so this is the live shape.
    const db = await openDatabase({ url: `file:${join(sandbox, 'gravel.db')}` })
    expect(await pendingMigrationCount(db)).toBe(0)
    await db.close()
  })
})

describe('shouldAutoMigrate', () => {
  it('honours GRAVEL_DISABLE_AUTO_MIGRATE=1', () => {
    expect(shouldAutoMigrate({ GRAVEL_DISABLE_AUTO_MIGRATE: '1' } as NodeJS.ProcessEnv)).toBe(false)
  })
  it('skips in production', () => {
    expect(shouldAutoMigrate({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
  })
  it('is on by default in dev', () => {
    expect(shouldAutoMigrate({} as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('GET /api/migrations/status', () => {
  function handler() {
    return createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        auth: { defaultPassword: 'irrelevant' },
        database: { url: `file:${join(sandbox, 'gravel.db')}` },
      },
    })
  }

  it('returns the live count + dialect + autoMigrate flag for a loopback admin', async () => {
    const res = await handler()(
      new Request('http://127.0.0.1/admin/ai/api/migrations/status', {
        headers: { host: '127.0.0.1' },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pending: number
      dialect: string | null
      autoMigrate: boolean
    }
    expect(body.dialect).toBe('sqlite')
    expect(body.pending).toBe(0)
    expect(body.autoMigrate).toBe(false) // we set GRAVEL_DISABLE_AUTO_MIGRATE in beforeEach
  })

  it('rejects unauthed non-loopback callers with 401', async () => {
    const res = await handler()(
      new Request('http://app.example.com/admin/ai/api/migrations/status', {
        headers: { host: 'app.example.com' },
      }),
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string; pending?: number }
    expect(body.error).toBe('unauthorized')
    // No data leak — the count must NOT appear in the 401 body.
    expect(body.pending).toBeUndefined()
  })

  it('reports {pending: 0, dialect: null, reason: "no-db"} when no DATABASE_URL is configured', async () => {
    const handlerNoDb = createGravelHandler({
      config: {
        mountPath: '/admin/ai',
        auth: { defaultPassword: 'irrelevant' },
        // No database block — prompts-only install.
      },
    })
    const res = await handlerNoDb(
      new Request('http://127.0.0.1/admin/ai/api/migrations/status', {
        headers: { host: '127.0.0.1' },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pending: number
      dialect: string | null
      autoMigrate: boolean
      reason?: string
    }
    expect(body.pending).toBe(0)
    expect(body.dialect).toBeNull()
    expect(body.reason).toBe('no-db')
  })
})
