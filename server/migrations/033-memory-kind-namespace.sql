ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic';
ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_memories_kind_namespace ON memories(kind, namespace);
