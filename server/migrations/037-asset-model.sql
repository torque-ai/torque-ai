CREATE TABLE IF NOT EXISTS assets (
  asset_key TEXT PRIMARY KEY,
  description TEXT,
  kind TEXT,
  partition_key TEXT,
  metadata_json TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_materializations (
  materialization_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL,
  task_id TEXT,
  workflow_id TEXT,
  content_hash TEXT,
  metadata_json TEXT,
  produced_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_materializations_asset_time
ON asset_materializations(asset_key, produced_at);

CREATE TABLE IF NOT EXISTS asset_checks (
  check_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL,
  check_name TEXT NOT NULL,
  passed INTEGER NOT NULL,
  severity TEXT,
  task_id TEXT,
  metadata_json TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_checks_asset_time
ON asset_checks(asset_key, checked_at);

CREATE TABLE IF NOT EXISTS asset_dependencies (
  asset_key TEXT NOT NULL,
  depends_on_asset_key TEXT NOT NULL,
  PRIMARY KEY (asset_key, depends_on_asset_key)
);
