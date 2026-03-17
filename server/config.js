'use strict';

/**
 * server/config.js — Unified configuration resolution layer.
 *
 * Phase 7: Centralizes access to config values from DB, environment variables,
 * and constants.js. Provides type-safe accessors with defaults.
 *
 * Does NOT replace db.getConfig() — wraps it with consistent semantics.
 * Existing code can migrate incrementally.
 *
 * Resolution order:  env var override → DB config table → registered default → fallback arg
 */

const _baseLogger = require('./logger');
const logger = typeof _baseLogger.child === 'function'
  ? _baseLogger.child({ component: 'config' })
  : _baseLogger;

let db = null;

// ── Config Registry ──────────────────────────────────────────────────────
// Maps config keys to { default, type, envVar, description }
// Not exhaustive — unregistered keys still work via get() with explicit defaults.

const REGISTRY = {
  // Ports
  dashboard_port:          { default: 3456,  type: 'int',  envVar: 'TORQUE_DASHBOARD_PORT' },
  api_port:                { default: 3457,  type: 'int',  envVar: 'TORQUE_API_PORT' },
  mcp_sse_port:            { default: 3458,  type: 'int',  envVar: 'TORQUE_MCP_SSE_PORT' },
  gpu_metrics_port:        { default: 9394,  type: 'int',  envVar: 'TORQUE_GPU_METRICS_PORT' },
  mcp_gateway_port:        { default: 3460,  type: 'int',  envVar: 'TORQUE_MCP_GATEWAY_PORT' },

  // Concurrency
  max_concurrent:          { default: 20,    type: 'int' },
  auto_compute_max_concurrent: { default: true, type: 'bool' },
  max_ollama_concurrent:   { default: 8,     type: 'int' },
  max_codex_concurrent:    { default: 6,     type: 'int' },
  max_api_concurrent:      { default: 4,     type: 'int' },
  max_per_host:            { default: 4,     type: 'int' },

  // Provider control (opt-in: require explicit '1')
  codex_enabled:           { default: false, type: 'bool-optin' },
  codex_spark_enabled:     { default: false, type: 'bool-optin' },
  deepinfra_enabled:       { default: false, type: 'bool-optin' },
  hyperbolic_enabled:      { default: false, type: 'bool-optin' },

  // Feature flags (opt-out: enabled unless explicitly '0')
  smart_routing_enabled:   { default: true,  type: 'bool' },
  context_enrichment_enabled: { default: true, type: 'bool' },
  build_check_enabled:     { default: true,  type: 'bool' },
  cost_tracking_enabled:   { default: true,  type: 'bool' },
  adaptive_retry_enabled:  { default: true,  type: 'bool' },
  tsserver_enabled:        { default: false, type: 'bool-optin' },

  // Free-tier auto-scale
  free_tier_auto_scale_enabled:    { default: false, type: 'bool-optin' },
  free_tier_queue_depth_threshold: { default: 3,     type: 'int' },
  free_tier_cooldown_seconds:      { default: 60,    type: 'int' },

  // Maintenance
  auto_archive_days:       { default: 30,    type: 'int' },
  cleanup_log_days:        { default: 7,     type: 'int' },
  queue_task_ttl_minutes:  { default: 0,     type: 'int' },

  // Timeouts
  default_timeout:         { default: 30,    type: 'int' },

  // Ollama defaults
  ollama_num_ctx:          { default: 8192,  type: 'int' },
  ollama_temperature:      { default: 0.2,   type: 'float' },
};

// API key env var mappings (provider → env var name)
const API_KEY_ENV_VARS = {
  anthropic:        'ANTHROPIC_API_KEY',
  groq:             'GROQ_API_KEY',
  cerebras:         'CEREBRAS_API_KEY',
  'google-ai':      'GOOGLE_AI_API_KEY',
  'ollama-cloud':   'OLLAMA_CLOUD_API_KEY',
  openrouter:       'OPENROUTER_API_KEY',
  deepinfra:        'DEEPINFRA_API_KEY',
  hyperbolic:       'HYPERBOLIC_API_KEY',
  codex:            'OPENAI_API_KEY',
};

// ── Core Accessors ───────────────────────────────────────────────────────

/**
 * Get a config value with resolution: env var → DB → registry default → fallback.
 * @param {string} key - Config key name
 * @param {*} [fallback] - Fallback if not found anywhere
 * @returns {string|null}
 */
function get(key, fallback) {
  // 1. Check env var override if registered
  const entry = REGISTRY[key];
  if (entry && entry.envVar) {
    const envVal = process.env[entry.envVar];
    if (envVal !== undefined && envVal !== '') return envVal;
  }

  // 2. Check DB config table
  if (db && typeof db.getConfig === 'function') {
    const dbVal = db.getConfig(key);
    if (dbVal !== null && dbVal !== undefined) return dbVal;
  }

  // 3. Registry default
  if (entry && entry.default !== undefined) return String(entry.default);

  // 4. Explicit fallback
  return fallback !== undefined ? fallback : null;
}

/**
 * Get a config value as integer.
 */
function getInt(key, fallback) {
  const entry = REGISTRY[key];
  const defaultVal = (entry && entry.default !== undefined) ? entry.default : fallback;
  const raw = get(key);
  if (raw === null || raw === undefined) return defaultVal !== undefined ? defaultVal : 0;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? (defaultVal !== undefined ? defaultVal : 0) : parsed;
}

/**
 * Get a config value as float.
 */
function getFloat(key, fallback) {
  const entry = REGISTRY[key];
  const defaultVal = (entry && entry.default !== undefined) ? entry.default : fallback;
  const raw = get(key);
  if (raw === null || raw === undefined) return defaultVal !== undefined ? defaultVal : 0;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? (defaultVal !== undefined ? defaultVal : 0) : parsed;
}

/**
 * Get a config value as boolean (opt-out: enabled unless '0' or 'false').
 * For opt-in semantics, use isOptIn() instead.
 */
function getBool(key, fallback) {
  const entry = REGISTRY[key];
  const defaultVal = entry ? entry.default : fallback;
  const raw = get(key);
  if (raw === null || raw === undefined) return defaultVal !== undefined ? defaultVal : true;
  return raw !== '0' && raw !== 'false';
}

/**
 * Check if a feature is opt-in enabled (requires explicit '1' or 'true').
 * Use for features requiring setup (API keys, external services).
 */
function isOptIn(key) {
  const raw = get(key);
  return raw === '1' || raw === 'true';
}

/**
 * Get a config value parsed as JSON. Returns fallback on parse error.
 */
function getJson(key, fallback) {
  const raw = get(key);
  if (raw === null || raw === undefined) return fallback !== undefined ? fallback : null;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback !== undefined ? fallback : null;
  }
}

// ── API Key Resolution ───────────────────────────────────────────────────

/**
 * Resolve API key for a provider: env var → DB config → null.
 * Centralizes the scattered `process.env.X_API_KEY || db.getConfig('x_api_key')` pattern.
 *
 * @param {string} provider - Provider name (e.g., 'anthropic', 'deepinfra')
 * @returns {string|null}
 */
function getApiKey(provider) {
  const envVar = API_KEY_ENV_VARS[provider];

  // 1. Environment variable (highest priority)
  if (envVar) {
    const envVal = process.env[envVar];
    if (envVal) return envVal;
  }

  // 2. provider_config.api_key_encrypted (decrypt)
  try {
    const database = db || require('./database');
    const rawDb = typeof database.getDbInstance === 'function' ? database.getDbInstance()
      : typeof database.getDb === 'function' ? database.getDb()
      : null;
    if (rawDb && typeof rawDb.prepare === 'function') {
      const row = rawDb.prepare('SELECT api_key_encrypted FROM provider_config WHERE provider = ?').get(provider);
      if (row && row.api_key_encrypted) {
        const { decryptApiKey } = require('./handlers/provider-crud-handlers');
        const decrypted = decryptApiKey(row.api_key_encrypted);
        if (decrypted) return decrypted;
      }
    }
  } catch {
    // decryption failed, db not ready, or module not loaded — fall through
  }

  // 3. DB config table (legacy)
  const dbKey = `${provider.replace(/-/g, '_')}_api_key`;
  if (db && typeof db.getConfig === 'function') {
    const dbVal = db.getConfig(dbKey);
    if (dbVal) return dbVal;
  }

  return null;
}

/**
 * Check if a provider has a configured API key (env or DB).
 */
function hasApiKey(provider) {
  return !!getApiKey(provider);
}

// ── Port Resolution ──────────────────────────────────────────────────────

const PORT_KEYS = {
  dashboard: 'dashboard_port',
  api:       'api_port',
  mcp:       'mcp_sse_port',
  gpu:       'gpu_metrics_port',
  gateway:   'mcp_gateway_port',
};

/**
 * Get port for a service. Centralizes the 4 files that each parse port config.
 * @param {string} service - 'dashboard' | 'api' | 'mcp' | 'gpu' | 'gateway'
 * @returns {number}
 */
function getPort(service) {
  const key = PORT_KEYS[service];
  if (!key) {
    logger.warn(`Unknown service for port resolution: ${service}`);
    return 0;
  }
  return getInt(key);
}

// ── Lifecycle ────────────────────────────────────────────────────────────

function init(deps) {
  if (deps.db !== undefined) db = deps.db;
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  init,
  get,
  getInt,
  getFloat,
  getBool,
  isOptIn,
  getJson,
  getApiKey,
  hasApiKey,
  getPort,
  REGISTRY,
  API_KEY_ENV_VARS,
};
