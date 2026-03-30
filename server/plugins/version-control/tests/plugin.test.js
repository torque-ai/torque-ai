'use strict';

const Database = require('better-sqlite3');

const { validatePlugin } = require('../../plugin-contract');
const versionControlPlugin = require('../index');
const toolDefs = require('../tool-defs');

const { createVersionControlPlugin } = versionControlPlugin;

function makeContainer(db) {
  return {
    get(name) {
      if (name === 'db') {
        return {
          getDbInstance: () => db,
        };
      }

      return null;
    },
  };
}

describe('version-control plugin contract', () => {
  let db;
  let plugin;

  beforeEach(() => {
    db = new Database(':memory:');
    plugin = createVersionControlPlugin();
  });

  afterEach(() => {
    if (plugin) {
      plugin.uninstall();
    }

    if (db) {
      db.close();
    }
  });

  it('has correct name and version', () => {
    expect(plugin.name).toBe('version-control');
    expect(plugin.version).toBe('1.0.0');
  });

  it('passes plugin contract validation', () => {
    const result = validatePlugin(plugin);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('install() initializes without error and creates required tables', () => {
    expect(() => plugin.install(makeContainer(db))).not.toThrow();

    const tableNames = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('vc_worktrees', 'vc_commits')
      ORDER BY name
    `).all().map((row) => row.name);

    expect(tableNames).toEqual(['vc_commits', 'vc_worktrees']);
  });

  it('mcpTools() returns 8 tools after install', () => {
    plugin.install(makeContainer(db));

    const tools = plugin.mcpTools();

    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name).sort()).toEqual(toolDefs.map((tool) => tool.name).sort());
    expect(tools.every((tool) => typeof tool.handler === 'function')).toBe(true);
  });

  it('uninstall() cleans up lifecycle state', () => {
    plugin.install(makeContainer(db));

    expect(() => plugin.uninstall()).not.toThrow();
    expect(plugin.middleware()).toEqual([]);
    expect(plugin.eventHandlers()).toEqual({});
  });

  it('mcpTools() returns empty after uninstall', () => {
    plugin.install(makeContainer(db));
    plugin.uninstall();

    expect(plugin.mcpTools()).toEqual([]);
  });
});
