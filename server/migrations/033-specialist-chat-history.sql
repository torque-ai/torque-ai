CREATE TABLE IF NOT EXISTS specialist_chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spec_history_session
ON specialist_chat_history(user_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_spec_history_agent
ON specialist_chat_history(user_id, session_id, agent_id, created_at);
