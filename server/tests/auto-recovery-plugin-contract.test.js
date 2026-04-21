'use strict';
const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../plugins/plugin-contract');

function baseValid() {
  return {
    name: 'p', version: '1', install: () => {}, uninstall: () => {},
    middleware: () => null, mcpTools: () => [],
    eventHandlers: () => ({}), configSchema: () => null,
  };
}

describe('plugin-contract auto-recovery fields', () => {
  it('accepts classifierRules as an array', () => {
    const r = validatePlugin({ ...baseValid(), classifierRules: [] });
    expect(r.valid).toBe(true);
  });
  it('accepts recoveryStrategies as an array', () => {
    const r = validatePlugin({ ...baseValid(), recoveryStrategies: [] });
    expect(r.valid).toBe(true);
  });
  it('rejects classifierRules that is not an array', () => {
    const r = validatePlugin({ ...baseValid(), classifierRules: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /classifierRules/.test(e))).toBe(true);
  });
  it('rejects recoveryStrategies that is not an array', () => {
    const r = validatePlugin({ ...baseValid(), recoveryStrategies: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /recoveryStrategies/.test(e))).toBe(true);
  });
  it('accepts plugins that omit both fields', () => {
    expect(validatePlugin(baseValid()).valid).toBe(true);
  });
});
