/**
 * Idempotent CREATE TABLE bootstrap for v0. Used by the wizard to bring up
 * a fresh schema. Replaced by proper drizzle-kit migrations before v0 ships.
 *
 * Why this and not migrations: until the migration toolchain is wired up,
 * a single idempotent bootstrap script lets the wizard create the gravel_*
 * tables without depending on a versioned migrations directory.
 *
 * Mirrors python/gravel/src/artanis_gravel/schema.py — schema-drift CI
 * rejects mismatches.
 *
 * 2026-05-08 simplification: dropped gravel_projects, gravel_environments,
 * gravel_labels, gravel_prompts (see decisions.md D-Q53). Nine tables now.
 */
import type { Database } from './index.js'

const POSTGRES_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS gravel_users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  role TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extra JSONB
);

CREATE TABLE IF NOT EXISTS gravel_traces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  environment TEXT,
  metadata JSONB,
  status TEXT NOT NULL DEFAULT 'running',
  timestamp TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT,
  commit_sha TEXT,
  prompt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_traces_env_timestamp_idx ON gravel_traces(environment, timestamp DESC);
CREATE INDEX IF NOT EXISTS gravel_traces_prompt_id_idx ON gravel_traces(prompt_id);
CREATE INDEX IF NOT EXISTS gravel_traces_metadata_idx ON gravel_traces USING GIN(metadata);

CREATE TABLE IF NOT EXISTS gravel_observations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES gravel_traces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  key TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_observations_trace_timestamp_idx ON gravel_observations(trace_id, timestamp ASC);

CREATE TABLE IF NOT EXISTS gravel_feedback (
  id TEXT PRIMARY KEY,
  trace_id TEXT REFERENCES gravel_traces(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES gravel_observations(id) ON DELETE CASCADE,
  comment TEXT,
  correction TEXT,
  score TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  reporter_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_feedback_trace_id_idx ON gravel_feedback(trace_id);
CREATE INDEX IF NOT EXISTS gravel_feedback_observation_id_idx ON gravel_feedback(observation_id);

CREATE TABLE IF NOT EXISTS gravel_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT,
  created_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gravel_dataset_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL REFERENCES gravel_traces(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_id, trace_id)
);

CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id TEXT NOT NULL,
  draft_branch TEXT NOT NULL,
  new_text TEXT NOT NULL,
  editor_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_branch_idx ON gravel_prompt_drafts(draft_branch);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_idx ON gravel_prompt_drafts(prompt_id, draft_branch);

CREATE TABLE IF NOT EXISTS gravel_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  triggered_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  commit_sha TEXT,
  target_environment TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  completed_rows INTEGER NOT NULL DEFAULT 0,
  summary JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_dataset_id_idx ON gravel_eval_runs(dataset_id);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_status_idx ON gravel_eval_runs(status);

CREATE TABLE IF NOT EXISTS gravel_eval_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_run_id UUID NOT NULL REFERENCES gravel_eval_runs(id) ON DELETE CASCADE,
  dataset_trace_id UUID REFERENCES gravel_dataset_traces(id) ON DELETE SET NULL,
  trace_id TEXT REFERENCES gravel_traces(id) ON DELETE SET NULL,
  live_output JSONB,
  verdict JSONB NOT NULL,
  judge_call_ms INTEGER,
  pipeline_call_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_eval_results_run_id_idx ON gravel_eval_results(eval_run_id);
`

const SQLITE_BOOTSTRAP = `
-- SQLite variant. JSON columns are TEXT; timestamps are INTEGER (unix ms).
CREATE TABLE IF NOT EXISTS gravel_users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  role TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  extra TEXT
);

CREATE TABLE IF NOT EXISTS gravel_traces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  environment TEXT,
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  timestamp INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  commit_sha TEXT,
  prompt_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_traces_env_timestamp_idx ON gravel_traces(environment, timestamp DESC);
CREATE INDEX IF NOT EXISTS gravel_traces_prompt_id_idx ON gravel_traces(prompt_id);

CREATE TABLE IF NOT EXISTS gravel_observations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES gravel_traces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  key TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_observations_trace_timestamp_idx ON gravel_observations(trace_id, timestamp ASC);

CREATE TABLE IF NOT EXISTS gravel_feedback (
  id TEXT PRIMARY KEY,
  trace_id TEXT REFERENCES gravel_traces(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES gravel_observations(id) ON DELETE CASCADE,
  comment TEXT,
  correction TEXT,
  score TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  reporter_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_feedback_trace_id_idx ON gravel_feedback(trace_id);
CREATE INDEX IF NOT EXISTS gravel_feedback_observation_id_idx ON gravel_feedback(observation_id);

CREATE TABLE IF NOT EXISTS gravel_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT,
  created_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS gravel_dataset_traces (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL REFERENCES gravel_traces(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (dataset_id, trace_id)
);

CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  draft_branch TEXT NOT NULL,
  new_text TEXT NOT NULL,
  editor_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_branch_idx ON gravel_prompt_drafts(draft_branch);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_idx ON gravel_prompt_drafts(prompt_id, draft_branch);

CREATE TABLE IF NOT EXISTS gravel_eval_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  triggered_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  commit_sha TEXT,
  target_environment TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  completed_rows INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_dataset_id_idx ON gravel_eval_runs(dataset_id);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_status_idx ON gravel_eval_runs(status);

CREATE TABLE IF NOT EXISTS gravel_eval_results (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL REFERENCES gravel_eval_runs(id) ON DELETE CASCADE,
  dataset_trace_id TEXT REFERENCES gravel_dataset_traces(id) ON DELETE SET NULL,
  trace_id TEXT REFERENCES gravel_traces(id) ON DELETE SET NULL,
  live_output TEXT,
  verdict TEXT NOT NULL,
  judge_call_ms INTEGER,
  pipeline_call_ms INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_eval_results_run_id_idx ON gravel_eval_results(eval_run_id);
`

export async function bootstrap(db: Database): Promise<void> {
  const sql = db.dialect === 'postgres' ? POSTGRES_BOOTSTRAP : SQLITE_BOOTSTRAP
  // Split on `;` is safe here because we control the script.
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await db.exec(statement)
  }
}

/**
 * Sync helper used by `openDatabase` for SQLite. Applies the same DDL as
 * `bootstrap()` directly against a `better-sqlite3` Database instance —
 * cheaper than wrapping in a Database adapter when we just want the
 * idempotent CREATE TABLE IF NOT EXISTS semantics on first open.
 */
export function applySqliteBootstrap(sqlite: { exec: (sql: string) => unknown }): void {
  for (const statement of SQLITE_BOOTSTRAP.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    sqlite.exec(statement)
  }
}
