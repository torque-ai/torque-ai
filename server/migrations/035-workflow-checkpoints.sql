CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_id TEXT,
  task_id TEXT,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  taken_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_wf_time ON workflow_checkpoints(workflow_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_step ON workflow_checkpoints(workflow_id, step_id);
