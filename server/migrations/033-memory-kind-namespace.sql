CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  role TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT
);
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic';
ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_memories_kind_namespace ON memories(kind, namespace);
