'use strict';

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS cg_files (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    content_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE(repo_path, file_path)
  )`,
  `CREATE TABLE IF NOT EXISTS cg_symbols (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_name ON cg_symbols(repo_path, name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_file ON cg_symbols(repo_path, file_path)`,
  `CREATE TABLE IF NOT EXISTS cg_references (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    caller_symbol_id INTEGER,
    target_name TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_target ON cg_references(repo_path, target_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_caller ON cg_references(caller_symbol_id)`,
  `CREATE TABLE IF NOT EXISTS cg_index_state (
    repo_path TEXT PRIMARY KEY,
    commit_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,
    symbols INTEGER NOT NULL DEFAULT 0,
    references_count INTEGER NOT NULL DEFAULT 0
  )`,
];

function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) {
    db.prepare(sql).run();
  }
}

module.exports = { ensureSchema };
