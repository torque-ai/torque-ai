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

const REJECT_RECOVERY_CONFIG_DEFAULTS = Object.freeze({
  reject_recovery_enabled: '0',
  reject_recovery_sweep_interval_ms: String(60 * 60 * 1000),
  reject_recovery_age_threshold_ms: String(24 * 60 * 60 * 1000),
  reject_recovery_max_reopens: '1',
});

function parseBooleanConfigValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveIntegerConfigValue(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfigWithDefault(key) {
  const value = getConfig(key);
  if (value === undefined || value === null || value === '') {
    return REJECT_RECOVERY_CONFIG_DEFAULTS[key] ?? null;
  }
  return value;
}

function getRejectRecoveryConfig() {
  return {
    enabled: parseBooleanConfigValue(
      readConfigWithDefault('reject_recovery_enabled'),
      parseBooleanConfigValue(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_enabled),
    ),
    sweepIntervalMs: parsePositiveIntegerConfigValue(
      readConfigWithDefault('reject_recovery_sweep_interval_ms'),
      Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_sweep_interval_ms, 10),
    ),
    ageThresholdMs: parsePositiveIntegerConfigValue(
      readConfigWithDefault('reject_recovery_age_threshold_ms'),
      Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_age_threshold_ms, 10),
    ),
    maxReopens: parsePositiveIntegerConfigValue(
      readConfigWithDefault('reject_recovery_max_reopens'),
      Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_max_reopens, 10),
    ),
  };
}

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
    logger.info(`Protected config changed: ${key} (value redacted)`);
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
 * Ensure a TORQUE API key exists, generating one on first startup.
 * @returns {string}
 */
function ensureApiKey() {
  const existing = getConfig('api_key');
  if (existing) return existing;

  const crypto = require('crypto');
  const key = crypto.randomUUID();
  setConfig('api_key', key);
  logger.info(`Generated API key: ${key}`);
  logger.info('Add to .mcp.json headers or set TORQUE_API_KEY env var');
  return key;
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
 * Get provider rate limits for quota providers.
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
 * Factory: create a config-core instance with injected db.
 * @param {{ db: object }} deps
 */
function createConfigCore({ db: dbInstance }) {
  setDb(dbInstance);
  return {
    clearConfigCache,
    getConfig,
    setConfig,
    setConfigDefault,
    ensureApiKey,
    getAllConfig,
    getProviderRateLimits,
    getRejectRecoveryConfig,
  };
}

module.exports = {
  setDb,
  clearConfigCache,
  getConfig,
  setConfig,
  setConfigDefault,
  ensureApiKey,
  getAllConfig,
  getProviderRateLimits,
  REJECT_RECOVERY_CONFIG_DEFAULTS,
  parseBooleanConfigValue,
  parsePositiveIntegerConfigValue,
  getRejectRecoveryConfig,
  createConfigCore,
};
