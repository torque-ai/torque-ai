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
 */
const OPTIONAL_METHODS = [
  { name: 'tierTools', type: 'function' },
  { name: 'classifierRules', type: 'object' },
  { name: 'recoveryStrategies', type: 'object' },
  { name: 'enabled', type: 'function' },
];

const OPTIONAL_ARRAY_FIELDS = [
  'classifierRules',
  'recoveryStrategies',
];

function validatePlugin(plugin) {
  const errors = [];
  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: ['plugin must be an object'] };
  }
  for (const { name, type } of REQUIRED_FIELDS) {
    if (!(name in plugin)) {
      errors.push(`missing required field: ${name}`);
    } else if (typeof plugin[name] !== type) {
      errors.push(`${name} must be a ${type}`);
    }
  }
  for (const { name, type } of OPTIONAL_METHODS) {
    if (name in plugin) {
      if (typeof plugin[name] !== type) {
        errors.push(`optional method ${name} must be a ${type} when provided`);
      } else if ((name === 'classifierRules' || name === 'recoveryStrategies')
                 && !Array.isArray(plugin[name])) {
        errors.push(`optional method ${name} must be an array when provided`);
      }
    }
  }
  for (const name of OPTIONAL_ARRAY_FIELDS) {
    if (name in plugin && !Array.isArray(plugin[name])) {
      errors.push(`${name} must be an array when provided`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validatePlugin, REQUIRED_FIELDS, OPTIONAL_METHODS, OPTIONAL_ARRAY_FIELDS };
