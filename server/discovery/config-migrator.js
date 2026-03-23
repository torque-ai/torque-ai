'use strict';

/**
 * server/discovery/config-migrator.js — Config-to-Registry Migration
 *
 * Reads legacy config keys from the `config` table and writes into the new
 * registry/roles/capabilities system. All operations are idempotent.
 *
 * Exported API:
 *   migrateConfigToRegistry(db)  → void
 *
 * Legacy config keys handled:
 *   ollama_model            → model_roles (ollama/default)
 *   ollama_fast_model       → model_roles (ollama/fast)
 *   ollama_balanced_model   → model_roles (ollama/balanced)
 *   ollama_quality_model    → model_roles (ollama/quality)
 *   hashline_capable_models → model_capabilities (cap_hashline=1, source='config_migration')
 *   ollama_model_settings   → model_registry.tuning_json (only where NULL)
 *   ollama_model_prompts    → model_registry.prompt_template (only where NULL)
 */

/**
 * Read a single config value by key. Returns null when key is absent.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string|null}
 */
function _getConfig(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Migrate legacy Ollama model tier config keys into model_roles.
 *
 * @param {import('better-sqlite3').Database} db
 */
function _migrateTierModels(db) {
  const mappings = [
    { key: 'ollama_model',          role: 'default'  },
    { key: 'ollama_fast_model',     role: 'fast'     },
    { key: 'ollama_balanced_model', role: 'balanced' },
    { key: 'ollama_quality_model',  role: 'quality'  },
  ];

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO model_roles (provider, role, model_name, updated_at)
     VALUES ('ollama', ?, ?, datetime('now'))`
  );

  for (const { key, role } of mappings) {
    const modelName = _getConfig(db, key);
    if (modelName && modelName.trim()) {
      stmt.run(role, modelName.trim());
    }
  }
}

/**
 * Migrate hashline_capable_models config key into model_capabilities rows.
 *
 * @param {import('better-sqlite3').Database} db
 */
function _migrateHashlineCapabilities(db) {
  const value = _getConfig(db, 'hashline_capable_models');
  if (!value || !value.trim()) return;

  const models = value.split(',').map(m => m.trim()).filter(Boolean);
  if (models.length === 0) return;

  // Upsert each model: if a row exists, update cap_hashline and capability_source.
  // If it doesn't exist, insert a minimal row.
  const upsert = db.prepare(
    `INSERT INTO model_capabilities (model_name, cap_hashline, capability_source, updated_at)
     VALUES (?, 1, 'config_migration', datetime('now'))
     ON CONFLICT(model_name) DO UPDATE SET
       cap_hashline = 1,
       capability_source = 'config_migration',
       updated_at = datetime('now')`
  );

  for (const modelName of models) {
    upsert.run(modelName);
  }
}

/**
 * Migrate ollama_model_settings JSON into model_registry.tuning_json
 * (only for rows where tuning_json IS NULL).
 *
 * @param {import('better-sqlite3').Database} db
 */
function _migrateModelSettings(db) {
  const value = _getConfig(db, 'ollama_model_settings');
  if (!value || !value.trim()) return;

  let settings;
  try {
    settings = JSON.parse(value);
  } catch (_e) {
    // Malformed JSON — skip gracefully
    return;
  }

  if (!settings || typeof settings !== 'object') return;

  const stmt = db.prepare(
    `UPDATE model_registry
     SET tuning_json = ?
     WHERE model_name = ? AND tuning_json IS NULL`
  );

  for (const [modelName, tuning] of Object.entries(settings)) {
    if (modelName && tuning != null) {
      const tuningStr = typeof tuning === 'string' ? tuning : JSON.stringify(tuning);
      stmt.run(tuningStr, modelName);
    }
  }
}

/**
 * Migrate ollama_model_prompts JSON into model_registry.prompt_template
 * (only for rows where prompt_template IS NULL).
 *
 * @param {import('better-sqlite3').Database} db
 */
function _migrateModelPrompts(db) {
  const value = _getConfig(db, 'ollama_model_prompts');
  if (!value || !value.trim()) return;

  let prompts;
  try {
    prompts = JSON.parse(value);
  } catch (_e) {
    // Malformed JSON — skip gracefully
    return;
  }

  if (!prompts || typeof prompts !== 'object') return;

  const stmt = db.prepare(
    `UPDATE model_registry
     SET prompt_template = ?
     WHERE model_name = ? AND prompt_template IS NULL`
  );

  for (const [modelName, prompt] of Object.entries(prompts)) {
    if (modelName && prompt != null) {
      const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
      stmt.run(promptStr, modelName);
    }
  }
}

/**
 * Migrate legacy config keys into the model registry/roles/capabilities system.
 *
 * All operations are idempotent:
 * - model_roles uses INSERT OR IGNORE
 * - model_capabilities uses INSERT ... ON CONFLICT DO UPDATE
 * - model_registry updates only use WHERE tuning_json/prompt_template IS NULL
 *
 * Missing config keys are skipped gracefully (no error thrown).
 *
 * @param {import('better-sqlite3').Database} db - A better-sqlite3 database instance
 */
function migrateConfigToRegistry(db) {
  _migrateTierModels(db);
  _migrateHashlineCapabilities(db);
  _migrateModelSettings(db);
  _migrateModelPrompts(db);
}

module.exports = {
  migrateConfigToRegistry,
};
