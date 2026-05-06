/**
 * Draft prompt edits — read/write/list `gravel_prompt_drafts` rows.
 *
 * Spec: gravel-cloud/docs/spec/prompts.md §2 (edit flow + draft branches).
 *
 * Each DE has their own draft branch named `gravel/draft-<YYYY-MM-DD>-<userId>`
 * — no actual git branch is created until they hit "Submit changes". All
 * edits accumulate in `gravel_prompt_drafts` rows keyed by that branch
 * name. Last-write-wins per (prompt_id, draft_branch).
 *
 * Both Postgres and SQLite are supported. SQLite emulates the Postgres
 * upsert by hand because the schema doesn't (yet) ship a UNIQUE
 * constraint on (prompt_id, draft_branch); a future migration can add
 * one and we'll be able to use `onConflictDoUpdate` directly.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { Database } from '../db/index.js'

export interface DraftRow {
  id: string
  promptId: string
  draftBranch: string
  newText: string
  editorUserId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Compute the draft branch name for a given user. Idempotent within a day. */
export function draftBranchFor(userId: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD
  // Sanitize user id for git ref shape: alphanumeric, dash, underscore, dot.
  const sanitized = userId.replace(/[^A-Za-z0-9._-]/g, '-')
  return `gravel/draft-${date}-${sanitized}`
}

function toDraftRow(raw: any): DraftRow {
  return {
    id: String(raw.id),
    promptId: String(raw.promptId ?? raw.prompt_id),
    draftBranch: String(raw.draftBranch ?? raw.draft_branch),
    newText: String(raw.newText ?? raw.new_text),
    editorUserId: (raw.editorUserId ?? raw.editor_user_id) ?? null,
    createdAt:
      raw.createdAt instanceof Date
        ? raw.createdAt
        : new Date(typeof raw.createdAt === 'number' ? raw.createdAt : raw.created_at),
    updatedAt:
      raw.updatedAt instanceof Date
        ? raw.updatedAt
        : new Date(typeof raw.updatedAt === 'number' ? raw.updatedAt : raw.updated_at),
  }
}

export async function upsertDraft(
  db: Database,
  input: { promptId: string; draftBranch: string; newText: string; editorUserId: string },
): Promise<DraftRow> {
  if (db.dialect === 'postgres') {
    const { gravelPromptDrafts } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    // Hand-rolled upsert: there's no UNIQUE(prompt_id, draft_branch) yet,
    // so `onConflictDoUpdate` would fail. Use a SELECT-then-INSERT/UPDATE.
    const existing = await drz
      .select()
      .from(gravelPromptDrafts)
      .where(
        and(
          eq(gravelPromptDrafts.promptId, input.promptId),
          eq(gravelPromptDrafts.draftBranch, input.draftBranch),
        ),
      )
      .limit(1)
    if (existing.length > 0 && existing[0]) {
      const [row] = await drz
        .update(gravelPromptDrafts)
        .set({
          newText: input.newText,
          editorUserId: input.editorUserId,
          updatedAt: sql`now()`,
        })
        .where(eq(gravelPromptDrafts.id, existing[0].id))
        .returning()
      return toDraftRow(row)
    }
    const [inserted] = await drz
      .insert(gravelPromptDrafts)
      .values({
        promptId: input.promptId,
        draftBranch: input.draftBranch,
        newText: input.newText,
        editorUserId: input.editorUserId,
      })
      .returning()
    return toDraftRow(inserted)
  }

  // SQLite path — same shape, manual upsert + explicit UUID generation.
  const { gravelPromptDrafts } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const existing = drz
    .select()
    .from(gravelPromptDrafts)
    .where(
      and(
        eq(gravelPromptDrafts.promptId, input.promptId),
        eq(gravelPromptDrafts.draftBranch, input.draftBranch),
      ),
    )
    .limit(1)
    .get()
  const now = Date.now()
  if (existing) {
    drz
      .update(gravelPromptDrafts)
      .set({ newText: input.newText, editorUserId: input.editorUserId, updatedAt: now })
      .where(eq(gravelPromptDrafts.id, existing.id))
      .run()
    return toDraftRow({ ...existing, newText: input.newText, editorUserId: input.editorUserId, updatedAt: now })
  }
  const id = randomUUID()
  drz
    .insert(gravelPromptDrafts)
    .values({
      id,
      promptId: input.promptId,
      draftBranch: input.draftBranch,
      newText: input.newText,
      editorUserId: input.editorUserId,
    })
    .run()
  const row = drz
    .select()
    .from(gravelPromptDrafts)
    .where(eq(gravelPromptDrafts.id, id))
    .limit(1)
    .get()
  return toDraftRow(row)
}

export async function listDraftsForBranch(db: Database, draftBranch: string): Promise<DraftRow[]> {
  if (db.dialect === 'postgres') {
    const { gravelPromptDrafts } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select()
      .from(gravelPromptDrafts)
      .where(eq(gravelPromptDrafts.draftBranch, draftBranch))
    return rows.map(toDraftRow)
  }
  const { gravelPromptDrafts } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const rows = drz
    .select()
    .from(gravelPromptDrafts)
    .where(eq(gravelPromptDrafts.draftBranch, draftBranch))
    .all()
  return rows.map(toDraftRow)
}

export async function getDraft(
  db: Database,
  input: { promptId: string; draftBranch: string },
): Promise<DraftRow | null> {
  if (db.dialect === 'postgres') {
    const { gravelPromptDrafts } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    const rows = await drz
      .select()
      .from(gravelPromptDrafts)
      .where(
        and(
          eq(gravelPromptDrafts.promptId, input.promptId),
          eq(gravelPromptDrafts.draftBranch, input.draftBranch),
        ),
      )
      .limit(1)
    return rows[0] ? toDraftRow(rows[0]) : null
  }
  const { gravelPromptDrafts } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  const row = drz
    .select()
    .from(gravelPromptDrafts)
    .where(
      and(
        eq(gravelPromptDrafts.promptId, input.promptId),
        eq(gravelPromptDrafts.draftBranch, input.draftBranch),
      ),
    )
    .limit(1)
    .get()
  return row ? toDraftRow(row) : null
}

export async function deleteDraft(
  db: Database,
  input: { promptId: string; draftBranch: string },
): Promise<void> {
  if (db.dialect === 'postgres') {
    const { gravelPromptDrafts } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz
      .delete(gravelPromptDrafts)
      .where(
        and(
          eq(gravelPromptDrafts.promptId, input.promptId),
          eq(gravelPromptDrafts.draftBranch, input.draftBranch),
        ),
      )
    return
  }
  const { gravelPromptDrafts } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz
    .delete(gravelPromptDrafts)
    .where(
      and(
        eq(gravelPromptDrafts.promptId, input.promptId),
        eq(gravelPromptDrafts.draftBranch, input.draftBranch),
      ),
    )
    .run()
}

export async function clearDraftsForBranch(db: Database, draftBranch: string): Promise<void> {
  if (db.dialect === 'postgres') {
    const { gravelPromptDrafts } = await import('../schema/postgres.js')
    const drz = db.drizzle as NodePgDatabase
    await drz.delete(gravelPromptDrafts).where(eq(gravelPromptDrafts.draftBranch, draftBranch))
    return
  }
  const { gravelPromptDrafts } = await import('../schema/sqlite.js')
  const drz = db.drizzle as BetterSQLite3Database
  drz.delete(gravelPromptDrafts).where(eq(gravelPromptDrafts.draftBranch, draftBranch)).run()
}
