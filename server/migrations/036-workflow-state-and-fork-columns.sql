CREATE TABLE IF NOT EXISTS workflow_state (
  workflow_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL DEFAULT '{}',
  schema_json TEXT,
  reducers_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_state_updated ON workflow_state(updated_at);

ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT;
ALTER TABLE workflows ADD COLUMN fork_checkpoint_id TEXT;
