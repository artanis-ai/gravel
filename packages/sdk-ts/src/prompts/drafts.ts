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
 * Implementation note: this module currently only supports the Postgres
 * dialect. The SQLite schema is identical at the column level (enforced
 * by the schema-drift CI workflow), but the Drizzle type plumbing for a
 * dual-dialect helper is more friction than it's worth pre-v1. SQLite
 * users hit a clear runtime error directing them at this comment.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import type { Database } from '../db/index.js'
import { gravelPromptDrafts } from '../schema/postgres.js'

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

function pg(db: Database): NodePgDatabase {
  if (db.dialect !== 'postgres') {
    throw new Error(
      "[gravel] Prompt-drafts helpers currently require Postgres. SQLite parity is on the v1 punch list. " +
        "Switch DATABASE_URL to a postgres:// URL or open an issue.",
    )
  }
  return db.drizzle as NodePgDatabase
}

export async function upsertDraft(
  db: Database,
  input: { promptId: string; draftBranch: string; newText: string; editorUserId: string },
): Promise<DraftRow> {
  const [row] = await pg(db)
    .insert(gravelPromptDrafts)
    .values({
      promptId: input.promptId,
      draftBranch: input.draftBranch,
      newText: input.newText,
      editorUserId: input.editorUserId,
    })
    .onConflictDoUpdate({
      target: [gravelPromptDrafts.promptId, gravelPromptDrafts.draftBranch],
      set: {
        newText: input.newText,
        editorUserId: input.editorUserId,
        updatedAt: sql`now()`,
      },
    })
    .returning()
  return row as DraftRow
}

export async function listDraftsForBranch(db: Database, draftBranch: string): Promise<DraftRow[]> {
  const rows = await pg(db)
    .select()
    .from(gravelPromptDrafts)
    .where(eq(gravelPromptDrafts.draftBranch, draftBranch))
  return rows as DraftRow[]
}

export async function getDraft(
  db: Database,
  input: { promptId: string; draftBranch: string },
): Promise<DraftRow | null> {
  const rows = await pg(db)
    .select()
    .from(gravelPromptDrafts)
    .where(
      and(
        eq(gravelPromptDrafts.promptId, input.promptId),
        eq(gravelPromptDrafts.draftBranch, input.draftBranch),
      ),
    )
    .limit(1)
  return (rows[0] as DraftRow | undefined) ?? null
}

export async function deleteDraft(
  db: Database,
  input: { promptId: string; draftBranch: string },
): Promise<void> {
  await pg(db)
    .delete(gravelPromptDrafts)
    .where(
      and(
        eq(gravelPromptDrafts.promptId, input.promptId),
        eq(gravelPromptDrafts.draftBranch, input.draftBranch),
      ),
    )
}

export async function clearDraftsForBranch(db: Database, draftBranch: string): Promise<void> {
  await pg(db).delete(gravelPromptDrafts).where(eq(gravelPromptDrafts.draftBranch, draftBranch))
}
