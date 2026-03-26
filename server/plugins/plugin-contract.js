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
  return { valid: errors.length === 0, errors };
}

module.exports = { validatePlugin, REQUIRED_FIELDS };
