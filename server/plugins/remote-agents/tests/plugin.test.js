'use strict';

const { validatePlugin } = require('../../plugin-contract');

vi.mock('../../../logger', () => ({ child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

describe('remote-agents plugin', () => {
  let plugin;

  beforeEach(() => {
    vi.resetModules();
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
