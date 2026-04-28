'use strict';

const { validatePlugin } = require('../../plugin-contract');

vi.mock('../../../logger', () => ({ child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

describe('remote-agents plugin', () => {
  let plugin;

  beforeAll(() => {
    // Tests inspect read-only plugin properties (name, contract shape,
    // empty mcpTools()) — no shared mutable state to reset between cases.
    // Move from beforeEach to beforeAll: avoid per-test module cache clear,
    // which the perf rule (torque/no-reset-modules-in-each) flags as a
    // 100x+ overhead since createPlugin() pulls in the whole DI graph.
    const { createPlugin } = require('../index');
    plugin = createPlugin();
  });

  it('should satisfy the plugin contract', () => {
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('remote-agents');
  });

  it('should return empty mcpTools before install', () => {
    expect(plugin.mcpTools()).toEqual([]);
  });
});
