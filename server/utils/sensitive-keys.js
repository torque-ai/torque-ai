/**
 * Sensitive configuration key management.
 * Identifies which config keys contain secrets that should be
 * encrypted at rest and redacted in API responses.
 */

'use strict';

// Config keys that contain sensitive values (API keys, secrets, passwords)
const SENSITIVE_KEY_PATTERNS = [
  /_api_key$/i,
  /_secret$/i,
  /_password$/i,
  /_token$/i,
  /^api_key$/i,
  /^secret_key$/i,
  /^webhook_secret$/i,
];

// Explicit sensitive key names (in addition to pattern matching)
const SENSITIVE_KEY_NAMES = new Set([
  'anthropic_api_key',
  'deepinfra_api_key',
  'hyperbolic_api_key',
  'groq_api_key',
  'cerebras_api_key',
  'google_ai_api_key',
  'openai_api_key',
  'openrouter_api_key',
  'ollama_cloud_api_key',
  'api_key', // TORQUE's own API key
  'auth_server_secret', // HMAC signing secret for API key hashing
  'torque_secret_key',
]);

/**
 * Check if a config key contains sensitive data that should be encrypted/redacted.
 * @param {string} key - Config key name
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  if (!key || typeof key !== 'string') return false;
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_NAMES.has(lower)) return true;
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(lower));
}

/**
 * Redact a config value for API responses.
 * Shows first 4 + last 4 chars for long values, full redaction for short ones.
 * @param {string} value - The sensitive value
 * @returns {string} Redacted representation
 */
function redactValue(value) {
  if (!value || typeof value !== 'string') return '<redacted>';
  if (value.length <= 12) return '<redacted>';
  return `${value.slice(0, 4)}...<redacted>...${value.slice(-4)}`;
}

/**
 * Redact all sensitive keys in a config object.
 * Returns a new object with sensitive values replaced.
 * @param {Object} config - Config key-value pairs
 * @returns {Object} Config with sensitive values redacted
 */
function redactConfigObject(config) {
  if (!config || typeof config !== 'object') return config;
  const redacted = {};
  for (const [key, value] of Object.entries(config)) {
    redacted[key] = isSensitiveKey(key) ? redactValue(value) : value;
  }
  return redacted;
}

module.exports = {
  SENSITIVE_KEY_PATTERNS,
  SENSITIVE_KEY_NAMES,
  isSensitiveKey,
  redactValue,
  redactConfigObject,
};
