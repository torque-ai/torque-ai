'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb, rawDb } = require('../../../tests/vitest-setup');
const { validatePlugin } = require('../../plugin-contract');
const authPlugin = require('../index');

const { createAuthPlugin } = authPlugin;

let plugin;
let tmpDir;

beforeAll(() => {
  setupTestDb('auth-plugin-entry');

  const handle = rawDb();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT,
      user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      last_login_at TEXT
    );
  `);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-plugin-test-'));
});

afterAll(() => {
  teardownTestDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

beforeEach(() => {
  const handle = rawDb();
  handle.prepare('DELETE FROM api_keys').run();
  handle.prepare('DELETE FROM config').run();
  handle.prepare('DELETE FROM users').run();

  authPlugin.uninstall();
  plugin = createAuthPlugin();
});

function makeContainer(overrides = {}) {
  const logger = overrides.logger || { info() {}, warn() {} };
  return {
    get(name) {
      if (name === 'db') {
        return {
          getDbInstance: () => rawDb(),
          getDataDir: () => tmpDir,
        };
      }
      if (name === 'serverConfig') {
        return {
          getInt: () => 3458,
        };
      }
      if (name === 'eventBus') {
        return {
          on() {},
          emit() {},
        };
      }
      if (name === 'logger') {
        return logger;
      }
      return null;
    },
  };
}

describe('server/plugins/auth/index — plugin contract', () => {
  it('passes plugin contract validation', () => {
    const result = validatePlugin(authPlugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct name and version', () => {
    expect(authPlugin.name).toBe('auth');
    expect(authPlugin.version).toBe('1.0.0');
  });
});

describe('server/plugins/auth/index — install', () => {
  it('install() initializes without error', () => {
    expect(() => plugin.install(makeContainer())).not.toThrow();
  });

  it('install() creates bootstrap admin key when none exist', () => {
    plugin.install(makeContainer());

    const keys = rawDb().prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL').all();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0].role).toBe('admin');
    expect(keys[0].name).toBe('Bootstrap Admin Key');
  });

  it('install() logs the bootstrap admin key', () => {
    const messages = [];
    plugin.install(makeContainer({
      logger: {
        info(message) {
          messages.push(message);
        },
        warn() {},
      },
    }));

    expect(messages.some((message) => /^\[auth-plugin\] Bootstrap admin API key created: torque_sk_/.test(message)))
      .toBe(true);
  });

  it('install() writes key to .torque-api-key file', () => {
    plugin.install(makeContainer());

    const keyPath = path.join(tmpDir, '.torque-api-key');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath, 'utf8')).toMatch(/^torque_sk_/);
  });
});

describe('server/plugins/auth/index — middleware', () => {
  it('middleware() returns a function or array', () => {
    const beforeInstall = plugin.middleware();
    expect(Array.isArray(beforeInstall) || typeof beforeInstall === 'function').toBe(true);

    plugin.install(makeContainer());
    const afterInstall = plugin.middleware();
    expect(Array.isArray(afterInstall) || typeof afterInstall === 'function').toBe(true);
  });
});

describe('server/plugins/auth/index — mcpTools', () => {
  it('mcpTools() returns 3 tool definitions after install', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_api_key',
      'list_api_keys',
      'revoke_api_key',
    ]);
  });

  it('create_api_key returns the raw key and list_api_keys omits hashes', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    const createTool = tools.find((tool) => tool.name === 'create_api_key');
    const listTool = tools.find((tool) => tool.name === 'list_api_keys');

    const created = JSON.parse(createTool.handler({ name: 'test-tool-key', role: 'operator' }).content[0].text);
    expect(created.name).toBe('test-tool-key');
    expect(created.role).toBe('operator');
    expect(created.key).toMatch(/^torque_sk_/);

    const listed = JSON.parse(listTool.handler({}).content[0].text);
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.some((entry) => Object.prototype.hasOwnProperty.call(entry, 'key_hash'))).toBe(false);
    expect(listed.some((entry) => entry.id === created.id)).toBe(true);
  });

  it('revoke_api_key accepts key_id', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    const createTool = tools.find((tool) => tool.name === 'create_api_key');
    const revokeTool = tools.find((tool) => tool.name === 'revoke_api_key');

    const created = JSON.parse(createTool.handler({ name: 'to-revoke' }).content[0].text);
    const revoked = JSON.parse(revokeTool.handler({ key_id: created.id }).content[0].text);

    expect(revoked).toEqual({ revoked: true, key_id: created.id });
  });
});

describe('server/plugins/auth/index — eventHandlers', () => {
  it('eventHandlers() returns an object', () => {
    expect(plugin.eventHandlers()).toEqual({});
  });
});

describe('server/plugins/auth/index — configSchema', () => {
  it('configSchema() returns valid schema', () => {
    const schema = plugin.configSchema();
    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
    });
    expect(schema.properties.auth_mode).toBeDefined();
    expect(schema.properties.auth_mode.type).toBe('string');
    expect(schema.properties.auth_mode.enum).toContain('api_key');
  });
});

describe('server/plugins/auth/index — uninstall', () => {
  it('uninstall() cleans up without error', () => {
    plugin.install(makeContainer());
    expect(() => plugin.uninstall()).not.toThrow();
  });

  it('middleware() and mcpTools() reset after uninstall', () => {
    plugin.install(makeContainer());
    plugin.uninstall();

    expect(plugin.middleware()).toEqual([]);
    expect(plugin.mcpTools()).toEqual([]);
  });
});

module.exports = { makeContainer };
