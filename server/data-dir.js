/**
 * Centralized data directory resolution for TORQUE.
 *
 * Every module that needs the data directory (database, logger, backups,
 * credential storage, snapshots) imports from here instead of resolving
 * independently.  This eliminates the historical fragmentation where each
 * module had its own fallback path.
 *
 * Resolution order:
 *   1. TORQUE_DATA_DIR environment variable (explicit override)
 *   2. ~/.torque  (user home, safe from Codex sandbox overwrites)
 *   3. Server directory (__dirname)  (legacy fallback)
 *   4. os.tmpdir()/torque  (last resort when home is read-only)
 *
 * Legacy migration:
 *   When resolving to a non-legacy directory, checks if the legacy
 *   server/tasks.db has provider configs (API keys, enabled states)
 *   that are missing from the new DB, and migrates them automatically.
 *   Also copies secret.key if missing from the new location.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME_DATA_DIR = path.join(os.homedir(), '.torque');
const LEGACY_DATA_DIR = path.join(__dirname);

function ensureWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate provider configs (encrypted API keys, enabled states, models)
 * from a legacy database to the active one. Only copies data that is
 * missing from the target — never overwrites existing keys or states.
 *
 * Also copies secret.key if the target directory doesn't have one,
 * so encrypted keys remain decryptable after migration.
 *
 * @param {string} legacyDir - Path to the legacy data directory (server/)
 * @param {string} activeDir - Path to the active data directory (~/.torque)
 */
function migrateLegacyProviderConfigs(legacyDir, activeDir) {
  const legacyDb = path.join(legacyDir, 'tasks.db');
  const activeDb = path.join(activeDir, 'tasks.db');
  const legacyKey = path.join(legacyDir, 'secret.key');
  const activeKey = path.join(activeDir, 'secret.key');

  // Nothing to migrate if legacy DB doesn't exist
  if (!fs.existsSync(legacyDb)) return;

  // Nothing to migrate TO if active DB doesn't exist yet (will be created later)
  if (!fs.existsSync(activeDb)) {
    // But still copy secret.key if it exists
    if (fs.existsSync(legacyKey) && !fs.existsSync(activeKey)) {
      try {
        fs.copyFileSync(legacyKey, activeKey);
        console.log('[data-dir] Copied secret.key from legacy location');
      } catch (err) {
        console.log(`[data-dir] WARNING: Failed to copy secret.key: ${err.message}`);
      }
    }
    return;
  }

  // Copy secret.key if missing (needed to decrypt migrated keys)
  if (fs.existsSync(legacyKey) && !fs.existsSync(activeKey)) {
    try {
      fs.copyFileSync(legacyKey, activeKey);
      console.log('[data-dir] Copied secret.key from legacy location');
    } catch (err) {
      console.log(`[data-dir] WARNING: Failed to copy secret.key: ${err.message}`);
    }
  }

  // Open both databases and migrate missing provider configs
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.log('[data-dir] better-sqlite3 not available, skipping legacy migration');
    return;
  }

  let legacySql, activeSql;
  try {
    legacySql = new Database(legacyDb, { readonly: true });
    activeSql = new Database(activeDb);
  } catch (err) {
    console.log(`[data-dir] Could not open databases for migration: ${err.message}`);
    if (legacySql) try { legacySql.close(); } catch {}
    if (activeSql) try { activeSql.close(); } catch {}
    return;
  }

  try {
    // Check if provider_config table exists in both
    const legacyHasTable = legacySql.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_config'"
    ).get();
    const activeHasTable = activeSql.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_config'"
    ).get();

    if (!legacyHasTable || !activeHasTable) return;

    // Get providers with encrypted keys from legacy DB
    const legacyProviders = legacySql.prepare(
      'SELECT provider, enabled, api_key_encrypted, default_model FROM provider_config WHERE api_key_encrypted IS NOT NULL'
    ).all();

    if (legacyProviders.length === 0) return;

    let migratedKeys = 0;
    let migratedStates = 0;

    const updateKey = activeSql.prepare(
      "UPDATE provider_config SET api_key_encrypted = ?, updated_at = datetime('now') WHERE provider = ? AND (api_key_encrypted IS NULL OR api_key_encrypted = '')"
    );
    const updateEnabled = activeSql.prepare(
      "UPDATE provider_config SET enabled = 1, updated_at = datetime('now') WHERE provider = ? AND enabled = 0"
    );
    const updateModel = activeSql.prepare(
      "UPDATE provider_config SET default_model = ?, updated_at = datetime('now') WHERE provider = ? AND (default_model IS NULL OR default_model = '')"
    );

    const migrate = activeSql.transaction(() => {
      for (const row of legacyProviders) {
        // Migrate encrypted key (only if target has none)
        if (row.api_key_encrypted) {
          const result = updateKey.run(row.api_key_encrypted, row.provider);
          if (result.changes > 0) migratedKeys++;
        }

        // Migrate enabled state (only enable, never disable)
        if (row.enabled) {
          const result = updateEnabled.run(row.provider);
          if (result.changes > 0) migratedStates++;
        }

        // Migrate default model (only if target has none)
        if (row.default_model) {
          updateModel.run(row.default_model, row.provider);
        }
      }
    });

    migrate();

    if (migratedKeys > 0 || migratedStates > 0) {
      console.log(`[data-dir] Legacy migration: ${migratedKeys} API key(s), ${migratedStates} provider enable(s) migrated from ${legacyDb}`);
    }
  } catch (err) {
    console.log(`[data-dir] Legacy migration error (non-fatal): ${err.message}`);
  } finally {
    try { legacySql.close(); } catch {}
    try { activeSql.close(); } catch {}
  }
}

function resolveDataDir() {
  const envDir = process.env.TORQUE_DATA_DIR;
  const candidates = [
    envDir,
    HOME_DATA_DIR,
    LEGACY_DATA_DIR,
    path.join(os.tmpdir(), 'torque'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (ensureWritableDir(dir)) {
      const source = dir === envDir ? 'TORQUE_DATA_DIR'
        : dir === HOME_DATA_DIR ? 'default (~/.torque)'
        : dir === LEGACY_DATA_DIR ? 'legacy (server dir)'
        : 'tmpdir fallback';
      console.log(`[data-dir] Resolved: ${dir} (via ${source})`);

      // Migrate provider configs from legacy location if we moved away from it
      if (dir !== LEGACY_DATA_DIR) {
        migrateLegacyProviderConfigs(LEGACY_DATA_DIR, dir);
      }

      return dir;
    }
  }

  console.log(`[data-dir] WARNING: No writable candidate found, using HOME_DATA_DIR: ${HOME_DATA_DIR}`);
  return HOME_DATA_DIR;
}

let _dataDir = null;

/** @returns {string} Resolved data directory path */
function getDataDir() {
  if (!_dataDir) _dataDir = resolveDataDir();
  return _dataDir;
}

/** Override the data directory (for tests). */
function setDataDir(dir) {
  _dataDir = dir || null;
}

module.exports = { getDataDir, setDataDir, migrateLegacyProviderConfigs, HOME_DATA_DIR, LEGACY_DATA_DIR, DEFAULT_DATA_DIR: HOME_DATA_DIR };
