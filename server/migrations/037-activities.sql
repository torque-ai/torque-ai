CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,           -- 'provider' | 'mcp_tool' | 'verify' | 'remote_shell' | other
  name TEXT NOT NULL,           -- e.g., 'codex.runPrompt', 'snapscope.peek_ui'
  input_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed | cancelled | timed_out
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  start_to_close_timeout_ms INTEGER,
  heartbeat_timeout_ms INTEGER,
  last_heartbeat_at TEXT,
  result_json TEXT,
  error_text TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_status_heartbeat ON activities(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_activities_task ON activities(task_id);
CREATE INDEX IF NOT EXISTS idx_activities_kind ON activities(kind);
