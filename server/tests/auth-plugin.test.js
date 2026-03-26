'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const { validatePlugin } = require('../plugins/plugin-contract');
const { createAuthPlugin } = require('../plugins/auth/index');

let plugin;
let tmpDir;

beforeAll(() => {
  setupTestDb('auth-plugin-entry');

  const handle = rawDb();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT,
      user_id TEXT
    )
  `);
  handle.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      last_login_at TEXT
    )
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
  handle.prepare("DELETE FROM config WHERE key = 'auth_server_secret'").run();
  handle.prepare("DELETE FROM config WHERE key = 'api_key'").run();
  handle.prepare('DELETE FROM users').run();

  plugin = createAuthPlugin();
});

function makeContainer() {
  return {
    get: (name) => {
      if (name === 'db') return { getDbInstance: () => rawDb(), getDataDir: () => tmpDir };
      if (name === 'serverConfig') return { getInt: () => 3458 };
      if (name === 'eventBus') return { on: () => {} };
      return null;
    },
  };
}

describe('server/plugins/auth/index — plugin contract', () => {
  it('passes plugin contract validation', () => {
    const result = validatePlugin(plugin);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct name and version', () => {
    expect(plugin.name).toBe('auth');
    expect(plugin.version).toBe('1.0.0');
  });
});

describe('server/plugins/auth/index — install', () => {
  it('install() runs without error', () => {
    const container = makeContainer();
    expect(() => plugin.install(container)).not.toThrow();
  });

  it('install() creates bootstrap admin key when none exist', () => {
    const container = makeContainer();
    plugin.install(container);

    const handle = rawDb();
    const keys = handle.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL').all();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0].role).toBe('admin');
    expect(keys[0].name).toBe('Bootstrap Admin Key');
  });

  it('install() writes key to .torque-api-key file', () => {
    const container = makeContainer();
    plugin.install(container);

    const keyPath = path.join(tmpDir, '.torque-api-key');
    expect(fs.existsSync(keyPath)).toBe(true);
    const key = fs.readFileSync(keyPath, 'utf-8');
    expect(key).toMatch(/^torque_sk_/);
  });

  it('install() does not create bootstrap key if keys already exist', () => {
    const handle = rawDb();
    // Pre-create a key manually
    handle.prepare(
      "INSERT INTO api_keys (id, key_hash, name, role, created_at) VALUES ('pre-existing', 'hash123', 'Existing Key', 'admin', datetime('now'))"
    ).run();

    const container = makeContainer();
    plugin.install(container);

    const keys = handle.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL').all();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe('pre-existing');
  });
});

describe('server/plugins/auth/index — middleware', () => {
  it('middleware() returns empty array before install', () => {
    const result = plugin.middleware();
    expect(result).toEqual([]);
  });

  it('middleware() returns authenticate function after install', () => {
    plugin.install(makeContainer());
    const result = plugin.middleware();
    expect(typeof result).toBe('function');
  });
});

describe('server/plugins/auth/index — mcpTools', () => {
  it('mcpTools() returns empty array before install', () => {
    const result = plugin.mcpTools();
    expect(result).toEqual([]);
  });

  it('mcpTools() returns 3 tools with correct names after install', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_api_key', 'list_api_keys', 'revoke_api_key']);
  });

  it('each tool has description, inputSchema, and handler', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();

    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe('object');
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('create_api_key tool creates a key', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    const createTool = tools.find((t) => t.name === 'create_api_key');

    const result = createTool.handler({ name: 'test-tool-key', role: 'operator' });
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('test-tool-key');
    expect(parsed.role).toBe('operator');
    expect(parsed.key).toMatch(/^torque_sk_/);
  });

  it('list_api_keys tool lists keys', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    const listTool = tools.find((t) => t.name === 'list_api_keys');

    const result = listTool.handler();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    // Bootstrap key should be in the list
    expect(parsed.length).toBeGreaterThanOrEqual(1);
  });

  it('revoke_api_key tool revokes a key', () => {
    plugin.install(makeContainer());
    const tools = plugin.mcpTools();
    const createTool = tools.find((t) => t.name === 'create_api_key');
    const revokeTool = tools.find((t) => t.name === 'revoke_api_key');

    // Create an extra key so we can revoke the bootstrap one
    const created = JSON.parse(createTool.handler({ name: 'to-revoke' }).content[0].text);

    const result = revokeTool.handler({ id: created.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.revoked).toBe(true);
    expect(parsed.id).toBe(created.id);
  });
});

describe('server/plugins/auth/index — eventHandlers', () => {
  it('eventHandlers() returns an object', () => {
    const result = plugin.eventHandlers();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });
});

describe('server/plugins/auth/index — configSchema', () => {
  it('configSchema() returns a valid JSON schema', () => {
    const schema = plugin.configSchema();
    expect(typeof schema).toBe('object');
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.auth_mode).toBeDefined();
    expect(schema.properties.auth_mode.type).toBe('string');
    expect(schema.properties.auth_mode.enum).toContain('open');
    expect(schema.properties.auth_mode.enum).toContain('api_key');
  });
});

describe('server/plugins/auth/index — uninstall', () => {
  it('uninstall() runs without error', () => {
    plugin.install(makeContainer());
    expect(() => plugin.uninstall()).not.toThrow();
  });

  it('middleware() returns empty array after uninstall', () => {
    plugin.install(makeContainer());
    plugin.uninstall();
    const result = plugin.middleware();
    expect(result).toEqual([]);
  });

  it('mcpTools() returns empty array after uninstall', () => {
    plugin.install(makeContainer());
    plugin.uninstall();
    const result = plugin.mcpTools();
    expect(result).toEqual([]);
  });
});
