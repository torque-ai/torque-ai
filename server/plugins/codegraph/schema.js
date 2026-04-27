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
    end_col INTEGER NOT NULL,
    is_exported INTEGER NOT NULL DEFAULT 0,
    is_async INTEGER NOT NULL DEFAULT 0,
    is_generator INTEGER NOT NULL DEFAULT 0,
    is_static INTEGER NOT NULL DEFAULT 0
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
    col INTEGER NOT NULL,
    resolved_symbol_id INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_target ON cg_references(repo_path, target_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_caller ON cg_references(caller_symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_refs_resolved ON cg_references(resolved_symbol_id)`,
  // cg_imports: per-file binding of a local name to an external module/name.
  // Powers scoped resolution — cg_find_references with scope='strict' uses
  // resolved_symbol_id (set by indexer pass 2) which itself is computed by
  // joining cg_references against this table + cg_symbols.
  //   import { foo as fooLocal } from './bar'
  //     → (local_name='fooLocal', source_module='./bar', source_name='foo')
  //   import './side-effects'
  //     → not recorded (no binding)
  //   const { foo } = require('./bar')   (CommonJS destructure)
  //     → (local_name='foo', source_module='./bar', source_name='foo')
  // source_name is NULL for namespace imports (`import * as ns`) and for
  // bare-module imports where the local name IS the module.
  `CREATE TABLE IF NOT EXISTS cg_imports (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    local_name TEXT NOT NULL,
    source_module TEXT NOT NULL,
    source_name TEXT,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_imports_file  ON cg_imports(repo_path, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_imports_local ON cg_imports(repo_path, file_path, local_name)`,
  `CREATE TABLE IF NOT EXISTS cg_index_state (
    repo_path TEXT PRIMARY KEY,
    commit_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,
    symbols INTEGER NOT NULL DEFAULT 0,
    references_count INTEGER NOT NULL DEFAULT 0
  )`,
  // cg_dispatch_edges: maps a string literal used as a switch-case label
  // to the function name dispatched in the case body. Lets cg_resolve_tool
  // answer "what function handles tool X" — the gap exposed by querying
  // tool names like 'smart_submit_task' that aren't symbol declarations.
  `CREATE TABLE IF NOT EXISTS cg_dispatch_edges (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    case_string TEXT NOT NULL,
    handler_name TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_dispatch_case ON cg_dispatch_edges(repo_path, case_string)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_dispatch_handler ON cg_dispatch_edges(repo_path, handler_name)`,
  // cg_class_edges: extends/implements relationships between classes and
  // interfaces. edge_kind is 'extends' (class:class or interface:interface)
  // or 'implements' (class:interface). Powers cg_class_hierarchy — the
  // "what subclasses depend on this base?" question that comes up before
  // refactoring a parent class.
  `CREATE TABLE IF NOT EXISTS cg_class_edges (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    subtype_name TEXT NOT NULL,
    supertype_name TEXT NOT NULL,
    edge_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_class_sub   ON cg_class_edges(repo_path, subtype_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_class_super ON cg_class_edges(repo_path, supertype_name)`,
];

// Idempotent column adds for upgrade paths from existing schemas.
const COLUMN_MIGRATIONS = [
  { table: 'cg_symbols', column: 'is_exported',  sql: "ALTER TABLE cg_symbols ADD COLUMN is_exported INTEGER NOT NULL DEFAULT 0" },
  { table: 'cg_symbols', column: 'is_async',     sql: "ALTER TABLE cg_symbols ADD COLUMN is_async INTEGER NOT NULL DEFAULT 0" },
  { table: 'cg_symbols', column: 'is_generator', sql: "ALTER TABLE cg_symbols ADD COLUMN is_generator INTEGER NOT NULL DEFAULT 0" },
  { table: 'cg_symbols', column: 'is_static',    sql: "ALTER TABLE cg_symbols ADD COLUMN is_static INTEGER NOT NULL DEFAULT 0" },
  { table: 'cg_references', column: 'resolved_symbol_id', sql: "ALTER TABLE cg_references ADD COLUMN resolved_symbol_id INTEGER" },
];

function ensureSchema(db) {
  for (const sql of SCHEMA_SQL) {
    db.prepare(sql).run();
  }
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info('${m.table}')`).all().map((c) => c.name);
    if (!cols.includes(m.column)) {
      db.prepare(m.sql).run();
    }
  }
}

module.exports = { ensureSchema };
