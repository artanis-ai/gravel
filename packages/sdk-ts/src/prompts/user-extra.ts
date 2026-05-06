/**
 * Per-user GitHub state stored in `gravel_users.extra`.
 *
 * The `extra` jsonb column is the SDK's "anything goes" slot per
 * `data-model.md` §1.3. We use it for the GH access token + selected
 * repo so we don't have to add columns for an evolving feature set.
 *
 * Both Postgres and SQLite are supported. SQLite stores `extra` as a
 * JSON-encoded text column; Postgres uses native jsonb.
 */
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface UserGhState {
  ghAccessToken?: string
  repoOwner?: string
  repoName?: string
  /** ISO timestamp of last token refresh — surfaced in dashboard "connected since" UI. */
  ghConnectedAt?: string
}

function decodeExtra(extra: unknown): Record<string, unknown> {
  if (!extra) return {}
  if (typeof extra === 'string') {
    try {
      return JSON.parse(extra) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (typeof extra === 'object') return extra as Record<string, unknown>
  return {}
}

function pickGhFields(extra: Record<string, unknown>): UserGhState {
  return {
    ghAccessToken: typeof extra.ghAccessToken === 'string' ? extra.ghAccessToken : undefined,
    repoOwner: typeof extra.repoOwner === 'string' ? extra.repoOwner : undefined,
    repoName: typeof extra.repoName === 'string' ? extra.repoName : undefined,
    ghConnectedAt: typeof extra.ghConnectedAt === 'string' ? extra.ghConnectedAt : undefined,
  }
}

export async function getUserGhState(db: Database, userId: string): Promise<UserGhState> {
  if (db.dialect === 'postgres') {
    const { gravelUsers } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select({ extra: gravelUsers.extra })
      .from(gravelUsers)
      .where(eq(gravelUsers.id, userId))
      .limit(1)
    return pickGhFields(decodeExtra(rows[0]?.extra))
  }
  const { gravelUsers } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select({ extra: gravelUsers.extra })
    .from(gravelUsers)
    .where(eq(gravelUsers.id, userId))
    .limit(1)
    .all()
  return pickGhFields(decodeExtra(rows[0]?.extra))
}

export async function patchUserGhState(
  db: Database,
  userId: string,
  patch: Partial<UserGhState>,
): Promise<void> {
  const current = await getUserGhState(db, userId)
  const next: UserGhState = { ...current, ...patch }
  if (db.dialect === 'postgres') {
    const { gravelUsers } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz
      .update(gravelUsers)
      .set({ extra: next as Record<string, unknown> })
      .where(eq(gravelUsers.id, userId))
    return
  }
  const { gravelUsers } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz
    .update(gravelUsers)
    .set({ extra: JSON.stringify(next) })
    .where(eq(gravelUsers.id, userId))
    .run()
}

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
