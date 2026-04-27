'use strict';

const Database = require('better-sqlite3');
const { createCodegraphPlugin } = require('../index');

describe('codegraph plugin lifecycle', () => {
  let db;
  let container;

  beforeEach(() => {
    db = new Database(':memory:');
    container = {
      get(name) {
        if (name === 'db') return { getDbInstance: () => db };
        throw new Error(`unknown service: ${name}`);
      },
    };
  });

  afterEach(() => db.close());

  it('reports plugin metadata', () => {
    const plugin = createCodegraphPlugin();
    expect(plugin.name).toBe('codegraph');
    expect(typeof plugin.version).toBe('string');
  });

  it('returns no MCP tools before install', () => {
    const plugin = createCodegraphPlugin();
    expect(plugin.mcpTools()).toEqual([]);
  });

  it('install is a no-op when feature flag is off', () => {
    const prev = process.env.TORQUE_CODEGRAPH_ENABLED;
    delete process.env.TORQUE_CODEGRAPH_ENABLED;
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      expect(plugin.mcpTools()).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.TORQUE_CODEGRAPH_ENABLED = prev;
    }
  });

  it('install registers tools when feature flag is on', () => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      const tools = plugin.mcpTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((t) => typeof t.name === 'string')).toBe(true);
      expect(tools.every((t) => typeof t.handler === 'function')).toBe(true);
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });

  it('uninstall clears tools', () => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      plugin.uninstall();
      expect(plugin.mcpTools()).toEqual([]);
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });
});
