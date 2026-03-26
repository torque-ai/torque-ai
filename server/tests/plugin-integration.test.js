'use strict';
const { describe, it, expect } = require('vitest');
const { validatePlugin } = require('../plugins/plugin-contract');
const { loadPlugins } = require('../plugins/loader');

describe('plugin-integration', () => {
  describe('local mode', () => {
    it('loads zero plugins in local mode', () => {
      expect(loadPlugins({ authMode: 'local' })).toEqual([]);
    });
    it('loads zero plugins with no auth_mode set', () => {
      expect(loadPlugins({})).toEqual([]);
    });
  });
  describe('enterprise mode', () => {
    it('loads auth plugin in enterprise mode', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('auth');
    });
    it('auth plugin passes contract validation', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      expect(validatePlugin(plugins[0]).valid).toBe(true);
    });
    it('auth plugin exposes MCP tools', () => {
      const plugins = loadPlugins({ authMode: 'enterprise' });
      const tools = plugins[0].mcpTools();
      expect(tools.length).toBe(3);
      expect(tools.map(t => t.name)).toEqual(['create_api_key', 'list_api_keys', 'revoke_api_key']);
    });
  });
});
