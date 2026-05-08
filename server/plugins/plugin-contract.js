'use strict';

const REQUIRED_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'install', type: 'function' },
  { name: 'uninstall', type: 'function' },
  { name: 'middleware', type: 'function' },
  { name: 'mcpTools', type: 'function' },
  { name: 'eventHandlers', type: 'function' },
  { name: 'configSchema', type: 'function' },
];

/**
 * Optional plugin methods. Validated only when present.
 * - tierTools(): Returns { tier1: string[], tier2: string[] } mapping tool names to visibility tiers.
 *   Tools not listed are only visible after unlock_all_tools (Tier 3).
 * - enabled(): Returns boolean. plugin-contract.md #7 — when false, the loader
 *   skips this plugin entirely (does NOT call install/middleware/mcpTools).
 *   Use this for env-var-gated plugins (e.g. codegraph's TORQUE_CODEGRAPH_ENABLED=0,
 *   future enterprise-feature gates) instead of returning a no-op stub from
 *   the factory. Missing enabled() means "always enabled" (back-compat).
 * - health(): plugin-contract.md #9 — returns
 *   { status: 'ok'|'degraded'|'down', details?: string }. Aggregated by
 *   boot-helpers.aggregatePluginHealth() and surfaced via /healthz.
 *   Missing health() means "no per-plugin health signal" (back-compat).
 * - migrate(prevVersion, currVersion): plugin-contract.md #11 — runs once
 *   per (pluginName, version) pair via the plugin_migrations table.
 *   Used by model-freshness etc. to migrate persisted state across
 *   plugin versions. prevVersion is null on first install of a given
 *   plugin name. Throwing aborts the migration and the row is NOT
 *   recorded; next boot retries.
 */
const OPTIONAL_METHODS = [
  { name: 'tierTools', type: 'function' },
  { name: 'classifierRules', type: 'object' },
  { name: 'recoveryStrategies', type: 'object' },
  { name: 'enabled', type: 'function' },
  { name: 'health', type: 'function' },
  { name: 'migrate', type: 'function' },
];

const OPTIONAL_ARRAY_FIELDS = [
  'classifierRules',
  'recoveryStrategies',
];

/**
 * plugin-contract.md #10 — structured validation errors. Pre-this-batch,
 * `errors` was a flat string array; consumers couldn't programmatically
 * distinguish "this plugin is structurally broken" (missing required field)
 * from "this plugin has a typo" (type mismatch). The structured shape lets
 * tests and dashboards triage by `kind`.
 *
 * Error object: { field, expected, actual, kind, message }
 *   kind ∈ 'missing' | 'type-mismatch' | 'required-array' | 'malformed-input'
 *   message is a pre-formatted string preserved for back-compat with any
 *   consumer that joined the array (the loader's log line formats via
 *   formatValidationErrors below).
 */
/**
 * Build a validation error with a hidden toString() that returns the
 * message. Lets back-compat consumers do `/x/.test(err)` or
 * `errors.includes('x must be a y')` against the array — they still
 * see the message string. Programmatic consumers walk the structured
 * fields. Property is non-enumerable so JSON.stringify keeps the
 * structured shape.
 */
function makeErr(field, expected, actual, kind, message) {
  const err = { field, expected, actual, kind, message };
  Object.defineProperty(err, 'toString', {
    value() { return this.message; },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return err;
}

function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') {
    return {
      valid: false,
      errors: [makeErr(
        '$root', 'object',
        plugin === null ? 'null' : typeof plugin,
        'malformed-input',
        'plugin must be an object',
      )],
    };
  }
  const errors = [];
  for (const { name, type } of REQUIRED_FIELDS) {
    if (!(name in plugin)) {
      errors.push(makeErr(name, type, 'undefined', 'missing', `missing required field: ${name}`));
    } else if (typeof plugin[name] !== type) {
      errors.push(makeErr(name, type, typeof plugin[name], 'type-mismatch', `${name} must be a ${type}`));
    }
  }
  for (const { name, type } of OPTIONAL_METHODS) {
    if (name in plugin) {
      if (typeof plugin[name] !== type) {
        errors.push(makeErr(
          name, type, typeof plugin[name], 'type-mismatch',
          `optional method ${name} must be a ${type} when provided`,
        ));
      } else if ((name === 'classifierRules' || name === 'recoveryStrategies')
                 && !Array.isArray(plugin[name])) {
        errors.push(makeErr(
          name, 'array', typeof plugin[name], 'required-array',
          `optional method ${name} must be an array when provided`,
        ));
      }
    }
  }
  for (const name of OPTIONAL_ARRAY_FIELDS) {
    if (name in plugin && !Array.isArray(plugin[name])) {
      errors.push(makeErr(
        name, 'array', typeof plugin[name], 'required-array',
        `${name} must be an array when provided`,
      ));
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Format structured validation errors back into a human-readable string.
 * Used by the loader's warn log so operators see the same surface as
 * before. Programmatic consumers should walk the structured array.
 */
function formatValidationErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors.map((e) => {
    if (typeof e === 'string') return e; // accept legacy string entries
    return e && typeof e.message === 'string' ? e.message : JSON.stringify(e);
  }).join(', ');
}

module.exports = {
  validatePlugin,
  formatValidationErrors,
  REQUIRED_FIELDS,
  OPTIONAL_METHODS,
  OPTIONAL_ARRAY_FIELDS,
};
