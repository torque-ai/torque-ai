CREATE TABLE IF NOT EXISTS applied_actions (
  action_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  seq INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applied_actions_task ON applied_actions(task_id, seq);
