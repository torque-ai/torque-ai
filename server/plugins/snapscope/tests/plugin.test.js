const { validatePlugin } = require('../../plugin-contract');
const { createSnapScopePlugin } = require('../index');

describe('snapscope plugin contract', () => {
  it('passes contract validation', () => {
    const plugin = createSnapScopePlugin();
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
  });

  it('has correct name and version', () => {
    const plugin = createSnapScopePlugin();
    expect(plugin.name).toBe('snapscope');
    expect(plugin.version).toBe('1.0.0');
  });

  it('mcpTools returns empty before install', () => {
    const plugin = createSnapScopePlugin();
    expect(plugin.mcpTools()).toEqual([]);
  });

  it('install and uninstall lifecycle works', () => {
    const plugin = createSnapScopePlugin();
    const container = {
      get(key) {
        if (key === 'db') return { getDbInstance: () => ({}) };
        if (key === 'serverConfig') return { get: () => '' };
        if (key === 'eventBus') return { on: () => {} };
        return null;
      },
    };
    plugin.install(container);
    plugin.uninstall();
  });

  it('configSchema returns valid schema', () => {
    const plugin = createSnapScopePlugin();
    const schema = plugin.configSchema();
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('peek_server_url');
    expect(schema.properties).toHaveProperty('snapscope_cli_project');
  });
});
