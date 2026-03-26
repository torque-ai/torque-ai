'use strict';
const { validatePlugin } = require('../plugins/plugin-contract');

describe('plugin-contract', () => {
  it('accepts a valid plugin', () => {
    const plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      install: () => {},
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({ type: 'object', properties: {} }),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects plugin missing required fields', () => {
    const result = validatePlugin({ name: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects plugin with non-function lifecycle methods', () => {
    const plugin = {
      name: 'bad',
      version: '1.0.0',
      install: 'not-a-function',
      uninstall: () => {},
      middleware: () => [],
      mcpTools: () => [],
      eventHandlers: () => ({}),
      configSchema: () => ({}),
    };
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('install must be a function');
  });
});
