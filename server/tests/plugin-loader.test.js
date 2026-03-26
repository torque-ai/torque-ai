'use strict';
const { loadPlugins } = require('../plugins/loader');
const path = require('path');

describe('plugin-loader', () => {
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
});
