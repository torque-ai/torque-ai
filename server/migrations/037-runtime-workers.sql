CREATE TABLE IF NOT EXISTS runtime_workers (
  worker_id TEXT PRIMARY KEY,
  display_name TEXT,
  kind TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  endpoint TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_heartbeat_at TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_workers_kind ON runtime_workers(kind);
CREATE INDEX IF NOT EXISTS idx_runtime_workers_status ON runtime_workers(status);
