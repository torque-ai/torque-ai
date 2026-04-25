ALTER TABLE tasks ADD COLUMN concurrency_key TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_concurrency_key ON tasks(concurrency_key, status);

CREATE TABLE IF NOT EXISTS concurrency_limits (
  key_pattern TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
