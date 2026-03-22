'use strict';

/**
 * Database Migration System for TORQUE
 *
 * Manages schema changes via numbered migration entries.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Usage:
 *   const { runMigrations } = require('./db/migrations');
 *   runMigrations(db);  // db = better-sqlite3 instance
 */

const MIGRATIONS = [
  {
    version: 1,
    name: 'remove_unused_notification_templates',
    up: 'DROP TABLE IF EXISTS notification_templates;',
    down: [
      'CREATE TABLE IF NOT EXISTS notification_templates (',
      '  id TEXT PRIMARY KEY,',
      '  integration_type TEXT NOT NULL,',
      '  event_type TEXT NOT NULL,',
      '  template TEXT NOT NULL,',
      '  enabled INTEGER DEFAULT 1,',
      '  created_at TEXT NOT NULL',
      ')',
    ].join('\n'),
  },
  {
    version: 2,
    name: 'add_provider_composite_index',
    up: 'CREATE INDEX IF NOT EXISTS idx_provider_stats_composite ON provider_task_stats(provider, task_type, total_tasks);',
    down: 'DROP INDEX IF EXISTS idx_provider_stats_composite;',
  },
  {
    version: 3,
    name: 'add_model_affinity_columns',
    up: [
      'ALTER TABLE ollama_hosts ADD COLUMN last_model_used TEXT',
      'ALTER TABLE ollama_hosts ADD COLUMN model_loaded_at TEXT',
    ].join('; '),
    down: [
      // SQLite doesn't support DROP COLUMN easily, but these columns are nullable so just ignore
    ].join('; '),
  },
  {
    version: 4,
    name: 'add_lock_heartbeat_column',
    up: 'ALTER TABLE distributed_locks ADD COLUMN last_heartbeat TEXT',
    down: '',
  },
  {
    version: 5,
    name: 'add_project_tuning_table',
    up: [
      'CREATE TABLE IF NOT EXISTS project_tuning (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  project_path TEXT NOT NULL UNIQUE,',
      '  settings_json TEXT NOT NULL,',
      '  description TEXT,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ')',
    ].join('\n'),
    down: 'DROP TABLE IF EXISTS project_tuning',
  },
  {
    version: 6,
    name: 'add_benchmark_results_table',
    up: [
      'CREATE TABLE IF NOT EXISTS benchmark_results (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  host_id TEXT NOT NULL,',
      '  model TEXT NOT NULL,',
      '  test_type TEXT NOT NULL,',
      '  prompt_type TEXT,',
      '  tokens_per_second REAL,',
      '  prompt_tokens INTEGER,',
      '  output_tokens INTEGER,',
      '  eval_duration_seconds REAL,',
      '  num_gpu INTEGER,',
      '  num_ctx INTEGER,',
      '  temperature REAL,',
      '  success INTEGER DEFAULT 1,',
      '  error_message TEXT,',
      '  raw_result TEXT,',
      '  benchmarked_at TEXT NOT NULL',
      ')',
    ].join('\n'),
    down: 'DROP TABLE IF EXISTS benchmark_results',
  },
  {
    version: 7,
    name: 'add_api_keys_table_and_server_secret',
    up: [
      [
        'CREATE TABLE IF NOT EXISTS api_keys (',
        '  id TEXT PRIMARY KEY,',
        '  key_hash TEXT NOT NULL,',
        '  name TEXT NOT NULL,',
        "  role TEXT NOT NULL DEFAULT 'admin',",
        "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
        '  last_used_at TEXT,',
        '  revoked_at TEXT',
        ')',
      ].join('\n'),
      'CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)',
    ].join('; '),
    down: 'DROP TABLE IF EXISTS api_keys',
  },
  {
    version: 8,
    name: 'remove_aider_provider_config',
    up: [
      // Delete aider-specific config keys
      "DELETE FROM config WHERE key IN ('aider_auto_commits', 'aider_auto_switch_format', 'aider_edit_format', 'aider_map_tokens', 'aider_model_edit_formats', 'aider_subtree_only')",
      // Rename stall_threshold_aider → stall_threshold_hashline (hashline-ollama uses this key)
      "UPDATE config SET key = 'stall_threshold_hashline' WHERE key = 'stall_threshold_aider'",
      // Reroute complexity_routing from aider-ollama to hashline-ollama
      "UPDATE complexity_routing SET target_provider = 'hashline-ollama' WHERE target_provider = 'aider-ollama'",
    ].join('; '),
    down: '',
  },
];

function ensureMigrationTable(sqliteDb) {
  sqliteDb.prepare([
    'CREATE TABLE IF NOT EXISTS schema_migrations (',
    '  version INTEGER PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  applied_at TEXT NOT NULL',
    ')',
  ].join('\n')).run();
}

function getAppliedVersions(sqliteDb) {
  const rows = sqliteDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return new Set(rows.map(r => r.version));
}

function runMigrations(sqliteDb) {
  ensureMigrationTable(sqliteDb);
  const applied = getAppliedVersions(sqliteDb);
  let count = 0;

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // Wrap each migration in a transaction for atomicity
    const runOne = sqliteDb.transaction(() => {
      const stmts = migration.up.split(';').filter(s => s.trim());
      for (const stmt of stmts) {
        try {
          sqliteDb.prepare(stmt).run();
        } catch (err) {
          // Tolerate "duplicate column" errors — the column may already exist in the base schema
          if (err.message && err.message.includes('duplicate column')) {
            // Column already exists, migration is effectively a no-op for this statement
          } else {
            throw err;
          }
        }
      }

      sqliteDb.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    try {
      runOne();
      count++;
    } catch (err) {
      console.error('Migration ' + migration.version + ' (' + migration.name + ') failed:', err.message);
      throw err;
    }
  }

  return count;
}

function rollbackMigration(sqliteDb, version) {
  const migration = MIGRATIONS.find(function(m) { return m.version === version; });
  if (!migration) throw new Error('Migration ' + version + ' not found');
  if (!migration.down) throw new Error('Migration ' + version + ' has no rollback');

  try {
    sqliteDb.prepare(migration.down).run();
  } catch (_err) {
    void _err;
    const stmts = migration.down.split(';').filter(function(s) { return s.trim(); });
    for (const stmt of stmts) {
      sqliteDb.prepare(stmt).run();
    }
  }
  sqliteDb.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
}

module.exports = { runMigrations, rollbackMigration, MIGRATIONS };
