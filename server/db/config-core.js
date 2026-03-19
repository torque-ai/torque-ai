'use strict';

/**
 * db/config-core.js — Configuration key/value store (getConfig, setConfig, etc.)
 *
 * Extracted from database.js Phase 3.1 decomposition.
 * Manages the config table with an in-process TTL cache and optional
 * AES-256-GCM encryption for sensitive keys.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const logger = require('../logger').child({ component: 'config-core' });
const { isSensitiveKey } = require('../utils/sensitive-keys');
const { VALID_CONFIG_KEYS } = require('./config-keys');

// ============================================================
// Protected config keys — changes are audit-logged
// ============================================================

const PROTECTED_CONFIG_KEYS = new Set([
  'api_key', 'v2_auth_mode', 'scheduling_mode', 'max_concurrent',
]);

// ============================================================
// Dependency injection
// ============================================================

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

// ============================================================
// Config cache
// ============================================================

const configCache = new Map();
const CONFIG_CACHE_TTL = 30000;

/**
 * Clear all cached config entries.
 * Called by database.js init() and resetForTest().
 */
function clearConfigCache() {
  configCache.clear();
}

// ============================================================
// Config operations
// ============================================================

/**
 * Get configuration value.
 * @param {string} key
 * @returns {string|null}
 */
function getConfig(key) {
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) {
    return cached.value;
  }
  if (!db) return null;
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key);
  let value = row ? row.value : null;

  // SECURITY: decrypt sensitive values stored with ENC: prefix
  if (value && isSensitiveKey(key) && value.startsWith('ENC:')) {
    try {
      const credCrypto = require('../utils/credential-crypto');
      const encKey = credCrypto.loadOrCreateKey();
      const parts = value.slice(4).split(':');
      if (parts.length === 3) {
        value = credCrypto.decrypt(parts[0], parts[1], parts[2], encKey);
      }
    } catch (err) {
      logger.warn(`Failed to decrypt config key ${key}: ${err.message}`);
      // Return raw value as fallback (may be plaintext from before encryption was enabled)
    }
  }

  configCache.set(key, { value, ts: Date.now() });
  return value;
}

/**
 * Set configuration value.
 * @param {string} key
 * @param {string} value
 */
function setConfig(key, value) {
  if (!VALID_CONFIG_KEYS.has(key)) {
    logger.warn(`setConfig called with unknown key: ${key}`);
  }

  if (PROTECTED_CONFIG_KEYS.has(key)) {
    logger.info(`Protected config key changed: ${key}`);
  }

  let storedValue = String(value);

  // SECURITY: encrypt sensitive values before storing
  if (isSensitiveKey(key) && storedValue && !storedValue.startsWith('ENC:')) {
    try {
      const credCrypto = require('../utils/credential-crypto');
      const encKey = credCrypto.loadOrCreateKey();
      const { encrypted_value, iv, auth_tag } = credCrypto.encrypt(storedValue, encKey);
      storedValue = `ENC:${encrypted_value}:${iv}:${auth_tag}`;
    } catch (err) {
      logger.warn(`Failed to encrypt config key ${key}: ${err.message}. Storing plaintext.`);
    }
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, storedValue);
  configCache.delete(key);
}

/**
 * Set configuration default — only sets if key does not already exist.
 * Used by schema seeding to avoid overwriting user customizations on restart.
 * @param {string} key
 * @param {string} value
 */
function setConfigDefault(key, value) {
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  const result = stmt.run(key, String(value));
  // Clear cache if row was inserted (changes > 0) so reads pick up new value
  if (result.changes > 0) {
    configCache.delete(key);
  }
}

/**
 * Get all configuration entries as a plain object.
 * @returns {object}
 */
function getAllConfig() {
  const stmt = db.prepare('SELECT key, value FROM config');
  const rows = stmt.all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Get provider rate limits for free-tier providers.
 * @returns {Array}
 */
function getProviderRateLimits() {
  try {
    return db.prepare('SELECT * FROM provider_rate_limits WHERE is_free_tier = 1').all();
  } catch {
    return [];
  }
}

/**
 * Ensure an API key exists in the config.
 * Generates and stores a UUID key on first call if none is configured.
 * Subsequent calls return the existing key.
 * @returns {string|null} The API key if newly generated, null if it already existed.
 */
function ensureApiKey() {
  const existing = getConfig('api_key');
  if (existing) return null;
  const crypto = require('crypto');
  const key = crypto.randomUUID();
  setConfig('api_key', key);
  return key;
}

module.exports = {
  setDb,
  clearConfigCache,
  getConfig,
  setConfig,
  setConfigDefault,
  getAllConfig,
  getProviderRateLimits,
  ensureApiKey,
};
