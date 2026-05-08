/**
 * SQLite mirror of postgres.ts.
 *
 * Differences from postgres:
 *   - jsonb → text (JSON-encoded; the db layer (de)serializes).
 *   - timestamp → integer (unix ms).
 *   - bigint → integer (SQLite's only number type).
 *   - GIN indexes dropped.
 *
 * Semantic shape is identical. Three tables, same as postgres.ts.
 */
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const now = sql`(unixepoch() * 1000)`

export const gravelSamples = sqliteTable(
  'gravel_samples',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    groupId: text('group_id'),
    environment: text('environment'),
    model: text('model'),
    status: text('status').notNull().default('completed'),
    input: text('input'),
    output: text('output'),
    metadata: text('metadata'),
    timestamp: integer('timestamp').notNull(),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
    durationMs: integer('duration_ms'),
    commitSha: text('commit_sha'),
    promptId: text('prompt_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    envTimestamp: index('gravel_samples_env_timestamp_idx').on(table.environment, table.timestamp),
    groupIdx: index('gravel_samples_group_id_idx').on(table.groupId),
    promptIdx: index('gravel_samples_prompt_id_idx').on(table.promptId),
  }),
)

export const gravelFeedback = sqliteTable(
  'gravel_feedback',
  {
    id: text('id').primaryKey(),
    sampleId: text('sample_id')
      .notNull()
      .references(() => gravelSamples.id, { onDelete: 'cascade' }),
    comment: text('comment'),
    correction: text('correction'),
    score: text('score'),
    source: text('source').notNull().default('ui'),
    reporterUserId: text('reporter_user_id'),
    metadata: text('metadata'),
    timestamp: integer('timestamp').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    sampleIdx: index('gravel_feedback_sample_id_idx').on(table.sampleId),
  }),
)

export const gravelPromptDrafts = sqliteTable(
  'gravel_prompt_drafts',
  {
    id: text('id').primaryKey(),
    promptId: text('prompt_id').notNull(),
    draftBranch: text('draft_branch').notNull(),
    newText: text('new_text').notNull(),
    editorUserId: text('editor_user_id'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => ({
    branchIdx: index('gravel_prompt_drafts_branch_idx').on(table.draftBranch),
    promptBranchIdx: index('gravel_prompt_drafts_prompt_branch_idx').on(
      table.promptId,
      table.draftBranch,
    ),
    promptBranchUnique: uniqueIndex('gravel_prompt_drafts_prompt_branch_unique').on(
      table.promptId,
      table.draftBranch,
    ),
  }),
)

export const allTables = {
  gravelSamples,
  gravelFeedback,
  gravelPromptDrafts,
}
