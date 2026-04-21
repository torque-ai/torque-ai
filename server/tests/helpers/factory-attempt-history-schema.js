'use strict';

// Shared test helper. Seeds the minimal set of tables needed to exercise
// factory-attempt-history and the factory_loop_instances.verify_silent_reruns
// column without calling runMigrations() — which requires the full
// schema (provider_task_stats, ollama_hosts, distributed_locks, ...) that
// these unit tests do not otherwise create.
//
// Mirrors the layout of migration 30 + the surrounding factory tables.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS factory_projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    trust_level TEXT,
    config_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS factory_work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    status TEXT,
    metadata_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS factory_loop_instances (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    work_item_id INTEGER,
    batch_id TEXT,
    loop_state TEXT NOT NULL DEFAULT 'IDLE',
    paused_at_stage TEXT,
    last_action_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    terminated_at TEXT,
    verify_silent_reruns INTEGER NOT NULL DEFAULT 0
  )`,
  // Matches migration #13 (add_factory_decisions) column layout —
  // actor and action are NOT NULL, and logDecision() in
  // server/db/factory-decisions.js binds values for actor,
  // inputs_json, and confidence on every insert. Omitting these
  // columns makes the insert silently fail and the tests that
  // assert on row existence see undefined.
  `CREATE TABLE IF NOT EXISTS factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    reasoning TEXT,
    inputs_json TEXT,
    outcome_json TEXT,
    confidence REAL,
    batch_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS factory_attempt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('execute', 'verify_retry')),
    task_id TEXT NOT NULL,
    files_touched TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    stdout_tail TEXT,
    zero_diff_reason TEXT,
    classifier_source TEXT NOT NULL DEFAULT 'none' CHECK (classifier_source IN ('heuristic', 'llm', 'none')),
    classifier_conf REAL,
    verify_output_tail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_batch ON factory_attempt_history(batch_id, attempt)`,
  `CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_work_item ON factory_attempt_history(work_item_id, created_at DESC)`,
];

function createMinimalSchema(db) {
  for (const sql of STATEMENTS) {
    db.prepare(sql).run();
  }
}

module.exports = { createMinimalSchema };
