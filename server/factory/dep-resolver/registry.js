'use strict';

const adapters = new Map();

function registerAdapter(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('registerAdapter requires a string name');
  if (!adapter || typeof adapter.detect !== 'function') throw new Error('adapter must have a detect() function');
  adapters.set(name, adapter);
}

function getAdapter(name) {
  return adapters.get(name) || null;
}

function listManagers() {
  return Array.from(adapters.keys());
}

function detect(errorOutput) {
  if (typeof errorOutput !== 'string' || errorOutput.length === 0) return null;
  for (const adapter of adapters.values()) {
    let result;
    try {
      result = adapter.detect(errorOutput);
    } catch (_e) {
      continue;
    }
    if (result && result.detected === true) {
      return { adapter, ...result };
    }
  }
  return null;
}

function clearAdaptersForTests() {
  adapters.clear();
}

module.exports = {
  registerAdapter,
  getAdapter,
  listManagers,
  detect,
  clearAdaptersForTests,
};
