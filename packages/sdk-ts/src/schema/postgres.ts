/**
 * Drizzle schema for the customer's database (data plane).
 *
 * 2026-05-08 simplification (D-Q53): the customer-side schema is three
 * tables. Traces became samples; samples carry their own input/output
 * jsonb (no separate observations table). Users + datasets + evals
 * tables retired until the corresponding UI surfaces ship — they're a
 * query away when needed.
 *
 *   gravel_samples       — one row per LLM call. group_id links samples
 *                          into a "trace" (a virtual grouping).
 *   gravel_feedback      — flagged samples (1..N per sample).
 *   gravel_prompt_drafts — in-flight prompt edits before a PR.
 *
 * Mirrored by python/gravel/src/artanis_gravel/schema.py — schema-
 * drift CI rejects mismatches.
 */
import {
  pgTable,
  text,
  uuid,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

void sql

// gravel_samples — one LLM call. The unit. Field shape matches the
// dashboard's "Outputs" tab (the user-facing label) — each row is a
// sample of model behaviour: input, output, metadata, plus the
// timing/status book-keeping.
//
// Multi-step traces (agent loops, RAG pipelines) are samples that share
// the same group_id. There is no separate "trace" table — a trace is
// the set of samples WHERE group_id = X, rendered together.
export const gravelSamples = pgTable(
  'gravel_samples',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Null for single-shot samples. Non-null = part of a multi-step trace. */
    groupId: text('group_id'),
    /** Free-form env tag — 'prod', 'staging', 'dev', whatever the
     * customer's tracing config sets. Null = no tag. */
    environment: text('environment'),
    model: text('model'),
    status: text('status').notNull().default('completed'), // 'running' | 'completed' | 'errored'
    /** What went IN to the model (messages array, prompt text, tool defs). */
    input: jsonb('input'),
    /** What came OUT (completion text, tool calls, structured output). */
    output: jsonb('output'),
    /** Anything else: token counts, latency, custom tags from the
     * tracing context, agent intermediate states, error message. */
    metadata: jsonb('metadata'),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    commitSha: text('commit_sha'),
    /** Manifest entry id this sample's prompt pinned to. Plain text;
     * the manifest at .artanis/manifest.json is the source of truth. */
    promptId: text('prompt_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    envTimestamp: index('gravel_samples_env_timestamp_idx').on(table.environment, table.timestamp),
    groupIdx: index('gravel_samples_group_id_idx').on(table.groupId),
    promptIdx: index('gravel_samples_prompt_id_idx').on(table.promptId),
    metadataIdx: index('gravel_samples_metadata_idx').using('gin', table.metadata),
  }),
)

// gravel_feedback — one row per "this sample needs attention" or
// per-sample comment. The dashboard surfaces these as flags on the
// Outputs tab and as the work queue in any future Review surface.
export const gravelFeedback = pgTable(
  'gravel_feedback',
  {
    id: text('id').primaryKey(),
    sampleId: text('sample_id')
      .notNull()
      .references(() => gravelSamples.id, { onDelete: 'cascade' }),
    comment: text('comment'),
    correction: text('correction'),
    score: text('score'), // 'positive' | 'negative' | 'neutral'
    source: text('source').notNull().default('ui'),
    /** From the host's getUser callback. Plain text; we don't mirror
     * users into a local table any more. */
    reporterUserId: text('reporter_user_id'),
    metadata: jsonb('metadata'),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    sampleIdx: index('gravel_feedback_sample_id_idx').on(table.sampleId),
  }),
)

// gravel_prompt_drafts — accumulated unsaved prompt edits per draft
// branch. The dashboard reads these to show "you have N drafts"; the
// submit flow reads them to push commits + open one PR.
export const gravelPromptDrafts = pgTable(
  'gravel_prompt_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Manifest entry id. Plain text — the manifest is source of truth. */
    promptId: text('prompt_id').notNull(),
    draftBranch: text('draft_branch').notNull(),
    newText: text('new_text').notNull(),
    /** From getUser. Plain text, no FK. */
    editorUserId: text('editor_user_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
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
