/**
 * SQLite mirror of the Postgres schema. Used when DATABASE_URL points at sqlite.
 *
 * Differences from postgres.ts:
 *   - `jsonb` becomes `text` (we serialize to/from JSON in the db layer).
 *   - `timestamp` becomes `integer` (unix ms).
 *   - `uuid` becomes `text` with a generated UUID at insert time.
 *   - `bigint` becomes `integer` (SQLite's only number type).
 *   - GIN indexes are dropped; we use plain indexes on jsonb-as-text.
 *
 * The semantic shape is identical. The db layer in src/db/ normalizes both.
 */
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const now = sql`(unixepoch() * 1000)`

// gravel_users — see postgres.ts for the rationale on the dropped tables
// (gravel_projects, gravel_environments, gravel_labels, gravel_prompts).
export const gravelUsers = sqliteTable('gravel_users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  role: text('role').notNull(),
  lastSeenAt: integer('last_seen_at').notNull().default(now),
  extra: text('extra'), // JSON-encoded
})

export const gravelTraces = sqliteTable(
  'gravel_traces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    groupId: text('group_id'),
    environment: text('environment'),
    metadata: text('metadata'),
    status: text('status').notNull().default('running'),
    timestamp: integer('timestamp').notNull(),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
    durationMs: integer('duration_ms'),
    commitSha: text('commit_sha'),
    promptId: text('prompt_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    envTimestamp: index('gravel_traces_env_timestamp_idx').on(table.environment, table.timestamp),
    promptIdx: index('gravel_traces_prompt_id_idx').on(table.promptId),
  }),
)

export const gravelObservations = sqliteTable(
  'gravel_observations',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id')
      .notNull()
      .references(() => gravelTraces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: text('data').notNull(),
    key: text('key'),
    timestamp: integer('timestamp').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    traceTimestamp: index('gravel_observations_trace_timestamp_idx').on(
      table.traceId,
      table.timestamp,
    ),
  }),
)

export const gravelFeedback = sqliteTable(
  'gravel_feedback',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id').references(() => gravelTraces.id, { onDelete: 'cascade' }),
    observationId: text('observation_id').references(() => gravelObservations.id, {
      onDelete: 'cascade',
    }),
    comment: text('comment'),
    correction: text('correction'),
    score: text('score'),
    source: text('source').notNull().default('ui'),
    reporterUserId: text('reporter_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
    metadata: text('metadata'),
    timestamp: integer('timestamp').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    traceIdx: index('gravel_feedback_trace_id_idx').on(table.traceId),
    observationIdx: index('gravel_feedback_observation_id_idx').on(table.observationId),
  }),
)

export const gravelDatasets = sqliteTable('gravel_datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  environment: text('environment'),
  createdByUserId: text('created_by_user_id').references(() => gravelUsers.id, {
    onDelete: 'set null',
  }),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
  deletedAt: integer('deleted_at'),
})

export const gravelDatasetTraces = sqliteTable(
  'gravel_dataset_traces',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => gravelDatasets.id, { onDelete: 'cascade' }),
    traceId: text('trace_id')
      .notNull()
      .references(() => gravelTraces.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at').notNull().default(now),
  },
  (table) => ({
    unique: uniqueIndex('gravel_dataset_traces_unique').on(table.datasetId, table.traceId),
  }),
)

export const gravelPromptDrafts = sqliteTable(
  'gravel_prompt_drafts',
  {
    id: text('id').primaryKey(),
    promptId: text('prompt_id').notNull(),
    draftBranch: text('draft_branch').notNull(),
    newText: text('new_text').notNull(),
    editorUserId: text('editor_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => ({
    branchIdx: index('gravel_prompt_drafts_branch_idx').on(table.draftBranch),
    promptBranchIdx: index('gravel_prompt_drafts_prompt_branch_idx').on(
      table.promptId,
      table.draftBranch,
    ),
  }),
)

export const gravelEvalRuns = sqliteTable(
  'gravel_eval_runs',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => gravelDatasets.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    triggeredByUserId: text('triggered_by_user_id').references(() => gravelUsers.id, {
      onDelete: 'set null',
    }),
    commitSha: text('commit_sha'),
    targetEnvironment: text('target_environment'),
    totalRows: integer('total_rows').notNull().default(0),
    completedRows: integer('completed_rows').notNull().default(0),
    summary: text('summary'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (table) => ({
    datasetIdx: index('gravel_eval_runs_dataset_id_idx').on(table.datasetId),
    statusIdx: index('gravel_eval_runs_status_idx').on(table.status),
  }),
)

export const gravelEvalResults = sqliteTable(
  'gravel_eval_results',
  {
    id: text('id').primaryKey(),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => gravelEvalRuns.id, { onDelete: 'cascade' }),
    datasetTraceId: text('dataset_trace_id').references(() => gravelDatasetTraces.id, {
      onDelete: 'set null',
    }),
    traceId: text('trace_id').references(() => gravelTraces.id, { onDelete: 'set null' }),
    liveOutput: text('live_output'),
    verdict: text('verdict').notNull(),
    judgeCallMs: integer('judge_call_ms'),
    pipelineCallMs: integer('pipeline_call_ms'),
    createdAt: integer('created_at').notNull().default(now),
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
