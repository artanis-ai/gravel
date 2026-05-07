/**
 * `gravel_users` upsert helper. The per-user GH OAuth state that used
 * to live in `gravel_users.extra` is gone (D-Q53 2026-05-07 re-reversal
 * — the App handles repo auth at the project level).
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

/**
 * Ensure a `gravel_users` row exists for this id. Sessions hit endpoints
 * before any auto-created user row exists, so we upsert defensively.
 */
export async function ensureGravelUser(
  db: Database,
  user: { id: string; firstName: string; role: 'user' | 'admin' },
): Promise<void> {
  if (db.dialect === 'postgres') {
    const { gravelUsers } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz
      .insert(gravelUsers)
      .values({
        id: user.id,
        firstName: user.firstName,
        role: user.role,
      })
      .onConflictDoUpdate({
        target: gravelUsers.id,
        set: { firstName: user.firstName, role: user.role },
      })
    return
  }
  const { gravelUsers } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz
    .insert(gravelUsers)
    .values({
      id: user.id,
      firstName: user.firstName,
      role: user.role,
    })
    .onConflictDoUpdate({
      target: gravelUsers.id,
      set: { firstName: user.firstName, role: user.role },
    })
    .run()
}
