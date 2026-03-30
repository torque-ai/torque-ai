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
      // Rename stall_threshold_aider → stall_threshold_ollama
      "UPDATE config SET key = 'stall_threshold_ollama' WHERE key = 'stall_threshold_aider'",
    ].join('; '),
    down: '',
  },
  {
    version: 9,
    name: 'add_host_default_model',
    up: 'ALTER TABLE ollama_hosts ADD COLUMN default_model TEXT',
    down: '',
  },
  {
    // Vendor-aligned tuning: disable repeat_penalty (1.0) globally, set per-family
    // values per vendor recommendations (Qwen: temp 0.7/top_k 20/rp 1.05,
    // Llama: top_k 10, DeepSeek: temp 0.6). Research (ACL 2025) shows repeat_penalty
    // >=1.1 degrades code generation correctness.
    version: 10,
    name: 'vendor_aligned_tuning',
    up: [
      // qwen3: temp 0.7, top_k 20, repeat_penalty 1.05 (vendor-recommended)
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.7, '$.top_k', 20, '$.repeat_penalty', 1.05) WHERE family = 'qwen3'",
      // qwen2.5: temp 0.7, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.7, '$.repeat_penalty', 1.0) WHERE family = 'qwen2.5'",
      // llama: top_k 10, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.top_k', 10, '$.repeat_penalty', 1.0) WHERE family = 'llama'",
      // deepseek: temp 0.6, repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.temperature', 0.6, '$.repeat_penalty', 1.0) WHERE family = 'deepseek'",
      // All others: repeat_penalty 1.0
      "UPDATE model_family_templates SET tuning_json = json_set(tuning_json, '$.repeat_penalty', 1.0) WHERE family NOT IN ('qwen3', 'qwen2.5', 'llama', 'deepseek')",
      // Global config: repeat_penalty 1.1 -> 1.0
      "UPDATE config SET value = '1.0' WHERE key = 'ollama_repeat_penalty' AND value = '1.1'",
      // Note: deprecated model cleanup moved to migration 11
    ].join(';\n'),
    down: '',
  },
  {
    version: 11,
    name: 'remove_deprecated_models',
    up: "UPDATE model_registry SET status = 'removed' WHERE model_name IN ('qwen2.5-coder:32b', 'codestral:22b') AND status = 'approved'",
    down: '',
  },
  {
    version: 12,
    name: 'remove-hashline-aider-providers',
    description: 'Remove deprecated local providers and hashline config keys',
    up: (db) => {
      const removedProviders = ['hashline-ollama', 'hashline-openai', 'aider-ollama'];

      db.prepare("DELETE FROM provider_config WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();

      const hashlineKeys = [
        'hashline_capable_models',
        'hashline_format_auto_select',
        'hashline_model_formats',
        'hashline_lite_min_samples',
        'hashline_lite_threshold',
        'max_hashline_local_retries',
      ];
      const deleteConfig = db.prepare('DELETE FROM config WHERE key = ?');
      for (const key of hashlineKeys) {
        deleteConfig.run(key);
      }

      const defaultProvider = db.prepare("SELECT value FROM config WHERE key = 'smart_routing_default_provider'").get();
      if (defaultProvider && removedProviders.includes(defaultProvider.value)) {
        db.prepare("UPDATE config SET value = 'ollama' WHERE key = 'smart_routing_default_provider'").run();
      }

      try {
        db.prepare("DELETE FROM provider_task_stats WHERE provider IN ('hashline-ollama', 'hashline-openai', 'aider-ollama')").run();
      } catch {
        // Table may not exist in older databases.
      }

      try {
        const templates = db.prepare('SELECT id, rules FROM routing_templates').all();
        const updateTemplate = db.prepare('UPDATE routing_templates SET rules = ? WHERE id = ?');
        for (const template of templates) {
          try {
            const rules = JSON.parse(template.rules);
            let changed = false;
            for (const [category, chain] of Object.entries(rules)) {
              if (Array.isArray(chain)) {
                const filtered = chain.filter(provider => !removedProviders.includes(provider));
                if (filtered.length !== chain.length) {
                  rules[category] = filtered;
                  changed = true;
                }
              }
            }
            if (changed) {
              updateTemplate.run(JSON.stringify(rules), template.id);
            }
          } catch {
            // Skip malformed template rules.
          }
        }
      } catch {
        // Table may not exist in older databases.
      }
    },
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
      if (typeof migration.up === 'function') {
        migration.up(sqliteDb);
      } else {
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
