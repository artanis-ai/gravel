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
