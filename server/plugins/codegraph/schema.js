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
    is_static INTEGER NOT NULL DEFAULT 0,
    container_name TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_name ON cg_symbols(repo_path, name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_file ON cg_symbols(repo_path, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_symbols_container ON cg_symbols(repo_path, container_name, name)`,
  `CREATE TABLE IF NOT EXISTS cg_references (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    caller_symbol_id INTEGER,
    target_name TEXT NOT NULL,
    receiver_name TEXT,
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
  // cg_locals: per-scope variable type bindings used by Slice B method-call
  // resolution. A row records "in this file, inside this enclosing function/
  // method, the local name X has type Y". When the indexer encounters a
  // member call `obj.foo()`, it looks up `obj` here to find the receiver's
  // type, then looks up methods on that type.
  //
  //   const x: Foo = ...           → (local='x', type='Foo')        TS only
  //   x: Foo = make()              → (local='x', type='Foo')        Python
  //   const x = new Foo()          → (local='x', type='Foo')        JS/TS/C#
  //   var x Foo                    → (local='x', type='Foo')        Go
  //   Foo x;                       → (local='x', type='Foo')        C#
  //   func f(x Foo)                → (local='x', type='Foo')        Go param
  //   def f(x: Foo)                → (local='x', type='Foo')        Python param
  //
  // scope_symbol_id: the cg_symbols.id of the enclosing function/method,
  // or NULL if file-scope. Member-call resolution walks up the scope chain
  // (function scope first, then file scope).
  `CREATE TABLE IF NOT EXISTS cg_locals (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    scope_symbol_id INTEGER,
    local_name TEXT NOT NULL,
    type_name TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cg_locals_lookup ON cg_locals(repo_path, file_path, scope_symbol_id, local_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cg_locals_file   ON cg_locals(repo_path, file_path)`,
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
  { table: 'cg_references', column: 'receiver_name', sql: "ALTER TABLE cg_references ADD COLUMN receiver_name TEXT" },
  { table: 'cg_symbols',    column: 'container_name', sql: "ALTER TABLE cg_symbols ADD COLUMN container_name TEXT" },
];

function ensureSchema(db) {
  // Three-pass order so an upgrade path from an older cg_symbols (without
  // is_exported / container_name / etc.) doesn't fail. The previous single-
  // pass loop ran CREATE INDEX statements that reference container_name BEFORE
  // the column migration that adds it — fine on fresh DBs (CREATE TABLE
  // includes the column) but crashes on pre-migration tables, e.g.
  //   SqliteError: no such column: container_name
  //     at ensureSchema schema.js:154
  // surfaced by tests/schema.test.js > "migrates is_exported column onto an
  // existing pre-migration cg_symbols".
  //
  //   1. CREATE TABLE statements first — gives the migration a target to
  //      ALTER, and is a no-op via IF NOT EXISTS when the table already exists.
  //   2. COLUMN_MIGRATIONS — backfills columns missing on legacy tables.
  //   3. Everything else (CREATE INDEX etc.) — now safe because every column
  //      referenced by an index either came from the CREATE TABLE or from a
  //      migration.
  const isCreateTable = (sql) => /^\s*CREATE\s+TABLE\b/i.test(sql);
  for (const sql of SCHEMA_SQL) {
    if (isCreateTable(sql)) db.prepare(sql).run();
  }
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info('${m.table}')`).all().map((c) => c.name);
    if (!cols.includes(m.column)) {
      db.prepare(m.sql).run();
    }
  }
  for (const sql of SCHEMA_SQL) {
    if (!isCreateTable(sql)) db.prepare(sql).run();
  }
}

module.exports = { ensureSchema };
