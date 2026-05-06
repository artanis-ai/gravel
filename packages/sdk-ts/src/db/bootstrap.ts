/**
 * Idempotent CREATE TABLE bootstrap for v0. Used by the wizard to bring up
 * a fresh schema. Replaced by proper drizzle-kit migrations before v0 ships.
 *
 * Why this and not migrations: until the migration toolchain is wired up
 * (BLOCKER in gravel-cloud/docs/blockers.md §schema), having a single
 * idempotent bootstrap script lets the wizard create the gravel_* tables
 * without depending on a versioned migrations directory.
 *
 * Mirrors python/gravel/src/artanis_gravel/db/bootstrap.py — kept hand-in-sync;
 * schema-drift CI rejects mismatches.
 */
import type { Database } from './index.js'

const POSTGRES_BOOTSTRAP = `
-- gravel_projects
CREATE TABLE IF NOT EXISTS gravel_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  credits_remaining BIGINT NOT NULL DEFAULT 0,
  credits_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- gravel_environments
CREATE TABLE IF NOT EXISTS gravel_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- gravel_users
CREATE TABLE IF NOT EXISTS gravel_users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  role TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extra JSONB
);

-- gravel_traces
CREATE TABLE IF NOT EXISTS gravel_traces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  environment_id UUID NOT NULL REFERENCES gravel_environments(id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS gravel_traces_env_timestamp_idx ON gravel_traces(environment_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS gravel_traces_prompt_id_idx ON gravel_traces(prompt_id);
CREATE INDEX IF NOT EXISTS gravel_traces_metadata_idx ON gravel_traces USING GIN(metadata);

-- gravel_observations
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

-- gravel_feedback
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

-- gravel_labels
CREATE TABLE IF NOT EXISTS gravel_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id TEXT NOT NULL REFERENCES gravel_observations(id) ON DELETE CASCADE,
  label_data JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_labels_observation_id_idx ON gravel_labels(observation_id);

-- gravel_datasets
CREATE TABLE IF NOT EXISTS gravel_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  environment_id UUID REFERENCES gravel_environments(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- gravel_dataset_traces
CREATE TABLE IF NOT EXISTS gravel_dataset_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL REFERENCES gravel_traces(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_id, trace_id)
);

-- gravel_prompts
CREATE TABLE IF NOT EXISTS gravel_prompts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  segment JSONB,
  current_hash TEXT NOT NULL,
  current_text TEXT NOT NULL,
  last_seen_commit TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_prompts_path_idx ON gravel_prompts(path);
CREATE INDEX IF NOT EXISTS gravel_prompts_hash_idx ON gravel_prompts(current_hash);

-- gravel_prompt_drafts
CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id TEXT NOT NULL REFERENCES gravel_prompts(id) ON DELETE CASCADE,
  draft_branch TEXT NOT NULL,
  new_text TEXT NOT NULL,
  editor_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_branch_idx ON gravel_prompt_drafts(draft_branch);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_idx ON gravel_prompt_drafts(prompt_id, draft_branch);

-- gravel_eval_runs
CREATE TABLE IF NOT EXISTS gravel_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES gravel_datasets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  triggered_by_user_id TEXT REFERENCES gravel_users(id) ON DELETE SET NULL,
  commit_sha TEXT,
  target_environment_id UUID REFERENCES gravel_environments(id) ON DELETE SET NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  completed_rows INTEGER NOT NULL DEFAULT 0,
  summary JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_dataset_id_idx ON gravel_eval_runs(dataset_id);
CREATE INDEX IF NOT EXISTS gravel_eval_runs_status_idx ON gravel_eval_runs(status);

-- gravel_eval_results
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
CREATE TABLE IF NOT EXISTS gravel_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  credits_remaining INTEGER NOT NULL DEFAULT 0,
  credits_refreshed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS gravel_environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

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
  environment_id TEXT NOT NULL REFERENCES gravel_environments(id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS gravel_traces_env_timestamp_idx ON gravel_traces(environment_id, timestamp DESC);
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

CREATE TABLE IF NOT EXISTS gravel_labels (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES gravel_observations(id) ON DELETE CASCADE,
  label_data TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_labels_observation_id_idx ON gravel_labels(observation_id);

CREATE TABLE IF NOT EXISTS gravel_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  environment_id TEXT REFERENCES gravel_environments(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS gravel_prompts (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  segment TEXT,
  current_hash TEXT NOT NULL,
  current_text TEXT NOT NULL,
  last_seen_commit TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_prompts_path_idx ON gravel_prompts(path);
CREATE INDEX IF NOT EXISTS gravel_prompts_hash_idx ON gravel_prompts(current_hash);

CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES gravel_prompts(id) ON DELETE CASCADE,
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
  target_environment_id TEXT REFERENCES gravel_environments(id) ON DELETE SET NULL,
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
