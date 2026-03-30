'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPlugins } = require('../plugins/loader');

describe('plugin-loader', () => {
  let pluginDir;

  function writePluginModule(name, source) {
    const dir = path.join(pluginDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), source, 'utf8');
  }

  beforeEach(() => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-plugin-loader-'));
  });

  afterEach(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it('returns empty array when auth_mode is local', () => {
    const plugins = loadPlugins({ authMode: 'local' });
    expect(plugins).toEqual([]);
  });

  it('returns empty array when auth_mode is not set', () => {
    const plugins = loadPlugins({});
    expect(plugins).toEqual([]);
  });

  it('returns empty array when plugin dir does not exist', () => {
    const plugins = loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
    });
    expect(plugins).toEqual([]);
  });

  it('logs warning on missing plugin', () => {
    const warnings = [];
    loadPlugins({
      authMode: 'enterprise',
      pluginDir: path.join(__dirname, 'nonexistent-plugins'),
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('test_loads_named_plugin', () => {
    writePluginModule('test', `
module.exports = {
  createPlugin() {
    return {
      name: 'test',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['test'],
      pluginDir,
      logger: { warn: () => {}, info: () => {} },
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('test');
    expect(plugins[0].version).toBe('1.0.0');
  });

  it('test_auth_and_named_plugins_both_load', () => {
    writePluginModule('test', `
module.exports = {
  createPlugin() {
    return {
      name: 'test',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    writePluginModule('auth', `
module.exports = {
  createAuthPlugin() {
    return {
      name: 'auth',
      version: '1.0.0',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['test'],
      authMode: 'enterprise',
      pluginDir,
      logger: { warn: () => {}, info: () => {} },
    });

    expect(plugins).toHaveLength(2);
    expect(plugins.map((plugin) => plugin.name)).toEqual(['test', 'auth']);
  });

  it('test_invalid_plugin_skipped', () => {
    const warnings = [];

    writePluginModule('invalid', `
module.exports = {
  createPlugin() {
    return {
      name: 'invalid',
      install() {},
      uninstall() {},
      middleware() { return []; },
      mcpTools() { return []; },
      eventHandlers() { return {}; },
      configSchema() { return {}; },
    };
  },
};
`);

    const plugins = loadPlugins({
      plugins: ['invalid'],
      pluginDir,
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    });

    expect(plugins).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed validation');
  });
});
