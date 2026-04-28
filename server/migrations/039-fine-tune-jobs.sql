CREATE TABLE IF NOT EXISTS fine_tune_jobs (
  job_id TEXT PRIMARY KEY,
  domain_id TEXT,
  name TEXT NOT NULL,
  base_model TEXT NOT NULL,
  backend TEXT NOT NULL,
  source_globs_json TEXT NOT NULL,
  dataset_path TEXT,
  adapter_path TEXT,
  model_alias TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fine_tune_status ON fine_tune_jobs(status);
