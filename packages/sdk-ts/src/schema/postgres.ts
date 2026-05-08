/**
 * Drizzle schema for Postgres. Source of truth for the gravel_* tables that
 * live in the user's database (data plane).
 *
 * Mirrors the schema spec at gravel-cloud/docs/spec/data-model.md §1.
 *
 * Kept in lockstep with:
 *   - python/gravel/src/artanis_gravel/schema.py (SQLAlchemy)
 *   - packages/sdk-ts/src/schema/sqlite.ts (SQLite variant)
 *
 * CI fails on drift between these. See .github/workflows/schema-drift.yml.
 */
import {
  pgTable,
  text,
  uuid,
  timestamp,
  bigint,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// gravel_users — mirror of users seen via the getUser callback.
//
// (Both gravel_projects and gravel_environments were dropped in the
// 2026-05-08 schema simplification: GitHub install state moved to the
// control plane keyed by project_id, and `environment` is now a plain
// text column on gravel_traces. See decisions.md D-Q53 + the schema
// section of spec/data-model.md.)
export const gravelUsers = pgTable('gravel_users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  role: text('role').notNull(), // 'user' | 'admin'
  lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull().defaultNow(),
  extra: jsonb('extra'),
})

// gravel_traces — mirrors platform `traces`.
export const gravelTraces = pgTable(
  'gravel_traces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    groupId: text('group_id'),
    /** Free-form tag — typically 'prod'/'staging'/'dev' but anything
     * the customer's tracing config sets. Null = no env tag. */
    environment: text('environment'),
    metadata: jsonb('metadata'),
    status: text('status').notNull().default('running'), // 'running' | 'completed' | 'errored'
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    commitSha: text('commit_sha'),
    /** Manifest entry id this trace pinned to. Plain text, no FK —
     * the manifest is the source of truth (it's in git). */
    promptId: text('prompt_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    envTimestamp: index('gravel_traces_env_timestamp_idx').on(table.environment, table.timestamp),
    promptIdx: index('gravel_traces_prompt_id_idx').on(table.promptId),
    metadataIdx: index('gravel_traces_metadata_idx').using('gin', table.metadata),
  }),
)

// 1.5 gravel_observations — mirrors platform `observations`.
export const gravelObservations = pgTable(
  'gravel_observations',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id')
      .notNull()
      .references(() => gravelTraces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'input' | 'output' | 'state'
    data: jsonb('data').notNull(),
    key: text('key'),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    traceTimestamp: index('gravel_observations_trace_timestamp_idx').on(
      table.traceId,
      table.timestamp,
    ),
  }),
)

// 1.6 gravel_feedback — mirrors platform `feedback`.
export const gravelFeedback = pgTable(
  'gravel_feedback',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id').references(() => gravelTraces.id, { onDelete: 'cascade' }),
    observationId: text('observation_id').references(() => gravelObservations.id, {
      onDelete: 'cascade',
    }),
    comment: text('comment'),
    correction: text('correction'),
    score: text('score'), // 'positive' | 'negative' | 'neutral'
    source: text('source').notNull().default('ui'),
    reporterUserId: text('reporter_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata'),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    traceIdx: index('gravel_feedback_trace_id_idx').on(table.traceId),
    observationIdx: index('gravel_feedback_observation_id_idx').on(table.observationId),
  }),
)


// gravel_datasets
export const gravelDatasets = pgTable('gravel_datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** Optional env scope — purely a label, no FK. */
  environment: text('environment'),
  createdByUserId: text('created_by_user_id').references(() => gravelUsers.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { mode: 'date' }),
})

// 1.9 gravel_dataset_traces
export const gravelDatasetTraces = pgTable(
  'gravel_dataset_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => gravelDatasets.id, { onDelete: 'cascade' }),
    traceId: text('trace_id')
      .notNull()
      .references(() => gravelTraces.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    unique: uniqueIndex('gravel_dataset_traces_unique').on(table.datasetId, table.traceId),
  }),
)

// gravel_prompt_drafts — accumulated unsaved DE edits per draft branch.
// `prompt_id` is plain text now: the manifest at .artanis/manifest.json
// is the source of truth, no DB mirror needed.
export const gravelPromptDrafts = pgTable(
  'gravel_prompt_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: text('prompt_id').notNull(),
    draftBranch: text('draft_branch').notNull(),
    newText: text('new_text').notNull(),
    editorUserId: text('editor_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
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
  }),
)

// 1.12 gravel_eval_runs — persistent state for an eval run
export const gravelEvalRuns = pgTable(
  'gravel_eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => gravelDatasets.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'trace' | 'live'
    status: text('status').notNull().default('pending'),
    triggeredByUserId: text('triggered_by_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
    commitSha: text('commit_sha'),
    /** Free-form env tag for live runs ('prod', 'staging', etc.). */
    targetEnvironment: text('target_environment'),
    totalRows: integer('total_rows').notNull().default(0),
    completedRows: integer('completed_rows').notNull().default(0),
    summary: jsonb('summary'),
    startedAt: timestamp('started_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    datasetIdx: index('gravel_eval_runs_dataset_id_idx').on(table.datasetId),
    statusIdx: index('gravel_eval_runs_status_idx').on(table.status),
  }),
)

// 1.13 gravel_eval_results — per-row verdict
export const gravelEvalResults = pgTable(
  'gravel_eval_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => gravelEvalRuns.id, { onDelete: 'cascade' }),
    datasetTraceId: uuid('dataset_trace_id').references(() => gravelDatasetTraces.id, {
      onDelete: 'set null',
    }),
    traceId: text('trace_id').references(() => gravelTraces.id, { onDelete: 'set null' }),
    liveOutput: jsonb('live_output'),
    verdict: jsonb('verdict').notNull(),
    judgeCallMs: integer('judge_call_ms'),
    pipelineCallMs: integer('pipeline_call_ms'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index('gravel_eval_results_run_id_idx').on(table.evalRunId),
  }),
)

export const allTables = {
  gravelUsers,
  gravelTraces,
  gravelObservations,
  gravelFeedback,
  gravelDatasets,
  gravelDatasetTraces,
  gravelPromptDrafts,
  gravelEvalRuns,
  gravelEvalResults,
}

// Suppress unused-import warning when only the `sql` template is used elsewhere.
void sql
