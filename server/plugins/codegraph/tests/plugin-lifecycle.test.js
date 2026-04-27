'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodegraphPlugin } = require('../index');

describe('codegraph plugin lifecycle', () => {
  let dataDir;
  let container;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-'));
    container = {
      get(name) {
        if (name === 'db') return { getDataDir: () => dataDir };
        throw new Error(`unknown service: ${name}`);
      },
    };
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

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
      plugin.uninstall();
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });

  it('install creates a dedicated codegraph.db in DATA_DIR', () => {
    process.env.TORQUE_CODEGRAPH_ENABLED = '1';
    try {
      const plugin = createCodegraphPlugin();
      plugin.install(container);
      expect(fs.existsSync(path.join(dataDir, 'codegraph.db'))).toBe(true);
      // Diagnostics surface the path so operators can locate the file.
      expect(plugin.diagnostics().dbPath).toBe(path.join(dataDir, 'codegraph.db'));
      plugin.uninstall();
    } finally {
      delete process.env.TORQUE_CODEGRAPH_ENABLED;
    }
  });

  it('uninstall clears tools and closes the dedicated db', () => {
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
