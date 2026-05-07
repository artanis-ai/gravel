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

// 1.1 gravel_projects — local cache of the project this install is bound to.
//
// GH columns are populated by `/api/github/install/callback` once the
// dev installs the Gravel App on their repo. PR creation reads them on
// every submit. Null while the App isn't installed.
export const gravelProjects = pgTable('gravel_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tier: text('tier').notNull().default('free'),
  creditsRemaining: bigint('credits_remaining', { mode: 'number' }).notNull().default(0),
  creditsRefreshedAt: timestamp('credits_refreshed_at', { mode: 'date' }),
  ghInstallationId: bigint('gh_installation_id', { mode: 'number' }),
  ghRepoOwner: text('gh_repo_owner'),
  ghRepoName: text('gh_repo_name'),
  ghBindingToken: text('gh_binding_token'),
  ghInstalledAt: timestamp('gh_installed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
})

// 1.2 gravel_environments — environments inside a project.
export const gravelEnvironments = pgTable(
  'gravel_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    nameUnique: uniqueIndex('gravel_environments_name_unique').on(table.name),
  }),
)

// 1.3 gravel_users — mirror of users seen via the getUser callback.
export const gravelUsers = pgTable('gravel_users', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  role: text('role').notNull(), // 'user' | 'admin'
  lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull().defaultNow(),
  extra: jsonb('extra'),
})

// 1.4 gravel_traces — mirrors platform `traces`.
export const gravelTraces = pgTable(
  'gravel_traces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    groupId: text('group_id'),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => gravelEnvironments.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata'),
    status: text('status').notNull().default('running'), // 'running' | 'completed' | 'errored'
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    commitSha: text('commit_sha'),
    promptId: text('prompt_id'), // FK added below; see relations
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    envTimestamp: index('gravel_traces_env_timestamp_idx').on(
      table.environmentId,
      table.timestamp,
    ),
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

// 1.7 gravel_labels — mirrors platform `labels`.
export const gravelLabels = pgTable(
  'gravel_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    observationId: text('observation_id')
      .notNull()
      .references(() => gravelObservations.id, { onDelete: 'cascade' }),
    labelData: jsonb('label_data').notNull(),
    timestamp: timestamp('timestamp', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    observationIdx: index('gravel_labels_observation_id_idx').on(table.observationId),
  }),
)

// 1.8 gravel_datasets
export const gravelDatasets = pgTable('gravel_datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  environmentId: uuid('environment_id').references(() => gravelEnvironments.id, {
    onDelete: 'set null',
  }),
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

// 1.10 gravel_prompts — DB-side mirror of .artanis/manifest.json
export const gravelPrompts = pgTable(
  'gravel_prompts',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull(),
    type: text('type').notNull(), // 'file' | 'embedded'
    segment: jsonb('segment'),
    currentHash: text('current_hash').notNull(),
    currentText: text('current_text').notNull(),
    lastSeenCommit: text('last_seen_commit').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pathIdx: index('gravel_prompts_path_idx').on(table.path),
    hashIdx: index('gravel_prompts_hash_idx').on(table.currentHash),
  }),
)

// 1.11 gravel_prompt_drafts — accumulated unsaved DE edits per draft branch
export const gravelPromptDrafts = pgTable(
  'gravel_prompt_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: text('prompt_id')
      .notNull()
      .references(() => gravelPrompts.id, { onDelete: 'cascade' }),
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
    targetEnvironmentId: uuid('target_environment_id').references(() => gravelEnvironments.id, {
      onDelete: 'set null',
    }),
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
  gravelProjects,
  gravelEnvironments,
  gravelUsers,
  gravelTraces,
  gravelObservations,
  gravelFeedback,
  gravelLabels,
  gravelDatasets,
  gravelDatasetTraces,
  gravelPrompts,
  gravelPromptDrafts,
  gravelEvalRuns,
  gravelEvalResults,
}

// Suppress unused-import warning when only the `sql` template is used elsewhere.
void sql
