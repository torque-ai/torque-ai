CREATE TABLE IF NOT EXISTS registered_repos (
  repo_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT DEFAULT 'main',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS repo_symbols (
  repo_id TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  body_preview TEXT,
  PRIMARY KEY (repo_id, symbol_id),
  FOREIGN KEY (repo_id) REFERENCES registered_repos(repo_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_repo_symbols_name ON repo_symbols(name);
CREATE INDEX IF NOT EXISTS idx_repo_symbols_qualified ON repo_symbols(qualified_name);
