CREATE TABLE IF NOT EXISTS task_experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  task_description TEXT NOT NULL,
  task_description_embedding TEXT,
  output_summary TEXT,
  files_modified TEXT,
  provider TEXT,
  success_score REAL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_experiences_project
ON task_experiences(project, success_score DESC);
