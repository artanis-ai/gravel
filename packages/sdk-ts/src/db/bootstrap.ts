/**
 * Idempotent CREATE TABLE bootstrap. Brings up the three gravel_*
 * tables on a fresh DB. Mirrors python schema.py — schema-drift CI
 * rejects mismatches.
 */
import type { Database } from './index.js'

const POSTGRES_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS gravel_samples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  environment TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  input JSONB,
  output JSONB,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT,
  commit_sha TEXT,
  prompt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_samples_env_timestamp_idx ON gravel_samples(environment, timestamp DESC);
CREATE INDEX IF NOT EXISTS gravel_samples_group_id_idx ON gravel_samples(group_id);
CREATE INDEX IF NOT EXISTS gravel_samples_prompt_id_idx ON gravel_samples(prompt_id);
CREATE INDEX IF NOT EXISTS gravel_samples_metadata_idx ON gravel_samples USING GIN(metadata);

CREATE TABLE IF NOT EXISTS gravel_feedback (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES gravel_samples(id) ON DELETE CASCADE,
  comment TEXT,
  correction TEXT,
  score TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  reporter_user_id TEXT,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_feedback_sample_id_idx ON gravel_feedback(sample_id);

CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id TEXT NOT NULL,
  draft_branch TEXT NOT NULL,
  new_text TEXT NOT NULL,
  editor_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_branch_idx ON gravel_prompt_drafts(draft_branch);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_idx ON gravel_prompt_drafts(prompt_id, draft_branch);
CREATE UNIQUE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_unique ON gravel_prompt_drafts(prompt_id, draft_branch);
`

const SQLITE_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS gravel_samples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  environment TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  input TEXT,
  output TEXT,
  metadata TEXT,
  timestamp INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  commit_sha TEXT,
  prompt_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_samples_env_timestamp_idx ON gravel_samples(environment, timestamp DESC);
CREATE INDEX IF NOT EXISTS gravel_samples_group_id_idx ON gravel_samples(group_id);
CREATE INDEX IF NOT EXISTS gravel_samples_prompt_id_idx ON gravel_samples(prompt_id);

CREATE TABLE IF NOT EXISTS gravel_feedback (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES gravel_samples(id) ON DELETE CASCADE,
  comment TEXT,
  correction TEXT,
  score TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  reporter_user_id TEXT,
  metadata TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_feedback_sample_id_idx ON gravel_feedback(sample_id);

CREATE TABLE IF NOT EXISTS gravel_prompt_drafts (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  draft_branch TEXT NOT NULL,
  new_text TEXT NOT NULL,
  editor_user_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_branch_idx ON gravel_prompt_drafts(draft_branch);
CREATE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_idx ON gravel_prompt_drafts(prompt_id, draft_branch);
CREATE UNIQUE INDEX IF NOT EXISTS gravel_prompt_drafts_prompt_branch_unique ON gravel_prompt_drafts(prompt_id, draft_branch);
`

export async function bootstrap(db: Database): Promise<void> {
  const sql = db.dialect === 'postgres' ? POSTGRES_BOOTSTRAP : SQLITE_BOOTSTRAP
  for (const statement of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await db.exec(statement)
  }
}

export function applySqliteBootstrap(sqlite: { exec: (sql: string) => unknown }): void {
  for (const statement of SQLITE_BOOTSTRAP.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    sqlite.exec(statement)
  }
}
