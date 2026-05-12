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
