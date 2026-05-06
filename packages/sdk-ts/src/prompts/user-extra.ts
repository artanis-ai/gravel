/**
 * Per-user GitHub state stored in `gravel_users.extra`.
 *
 * The `extra` jsonb column is the SDK's "anything goes" slot per
 * `data-model.md` §1.3. We use it for the GH access token + selected
 * repo so we don't have to add columns for an evolving feature set.
 *
 * Postgres-only for now (mirrors `prompts/drafts.ts` rationale).
 */
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import type { Database } from '../db/index.js'
import { gravelUsers } from '../schema/postgres.js'

export interface UserGhState {
  ghAccessToken?: string
  repoOwner?: string
  repoName?: string
  /** ISO timestamp of last token refresh — surfaced in dashboard "connected since" UI. */
  ghConnectedAt?: string
}

function pg(db: Database): NodePgDatabase {
  if (db.dialect !== 'postgres') {
    throw new Error(
      "[gravel] gravel_users helpers currently require Postgres. SQLite parity is on the v1 punch list.",
    )
  }
  return db.drizzle as NodePgDatabase
}

export async function getUserGhState(db: Database, userId: string): Promise<UserGhState> {
  const rows = await pg(db)
    .select({ extra: gravelUsers.extra })
    .from(gravelUsers)
    .where(eq(gravelUsers.id, userId))
    .limit(1)
  const extra = (rows[0]?.extra ?? {}) as Record<string, unknown>
  return {
    ghAccessToken: typeof extra.ghAccessToken === 'string' ? extra.ghAccessToken : undefined,
    repoOwner: typeof extra.repoOwner === 'string' ? extra.repoOwner : undefined,
    repoName: typeof extra.repoName === 'string' ? extra.repoName : undefined,
    ghConnectedAt: typeof extra.ghConnectedAt === 'string' ? extra.ghConnectedAt : undefined,
  }
}

export async function patchUserGhState(
  db: Database,
  userId: string,
  patch: Partial<UserGhState>,
): Promise<void> {
  const current = await getUserGhState(db, userId)
  const next: UserGhState = { ...current, ...patch }
  await pg(db)
    .update(gravelUsers)
    .set({ extra: next as Record<string, unknown> })
    .where(eq(gravelUsers.id, userId))
}

/**
 * Ensure a `gravel_users` row exists for this id. Sessions hit endpoints
 * before any auto-created user row exists, so we upsert defensively.
 */
export async function ensureGravelUser(
  db: Database,
  user: { id: string; firstName: string; role: 'user' | 'admin' },
): Promise<void> {
  await pg(db)
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
}
