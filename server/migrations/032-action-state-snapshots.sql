CREATE TABLE IF NOT EXISTS action_state_snapshots (
  app_id TEXT NOT NULL,
  partition_key TEXT NOT NULL DEFAULT '',
  sequence_id INTEGER NOT NULL,
  action_name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, partition_key, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_action_snapshots_app
ON action_state_snapshots(app_id, sequence_id);
