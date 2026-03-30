'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('../../../tests/vitest-setup');
const { createKeyManager } = require('../key-manager');
const { createRoleGuard, ROLE_HIERARCHY } = require('../role-guard');
const { AuthRateLimiter } = require('../rate-limiter');

let keyManager;

beforeAll(() => {
  setupTestDb('auth-plugin-core');

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
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  const handle = rawDb();
  handle.prepare('DELETE FROM api_keys').run();
  handle.prepare("DELETE FROM config WHERE key = 'auth_server_secret'").run();
  handle.prepare("DELETE FROM config WHERE key = 'api_key'").run();
  keyManager = createKeyManager({ db: rawDb() });
});

describe('server/plugins/auth/key-manager', () => {
  it('factory returns expected API shape', () => {
    expect(typeof keyManager.createKey).toBe('function');
    expect(typeof keyManager.validateKey).toBe('function');
    expect(typeof keyManager.revokeKey).toBe('function');
    expect(typeof keyManager.listKeys).toBe('function');
    expect(typeof keyManager.listKeysByUser).toBe('function');
    expect(typeof keyManager.hasAnyKeys).toBe('function');
    expect(typeof keyManager.migrateConfigApiKey).toBe('function');
    expect(typeof keyManager.hashKey).toBe('function');
    expect(typeof keyManager.getServerSecret).toBe('function');
  });

  it('createKey returns torque_sk_ style plaintext key', () => {
    const created = keyManager.createKey({ name: 'test-key', role: 'operator' });

    expect(created.key).toMatch(/^torque_sk_[0-9a-f]{36}$/i);
    expect(created.name).toBe('test-key');
    expect(created.role).toBe('operator');
  });

  it('validateKey succeeds for a valid key', () => {
    const created = keyManager.createKey({ name: 'valid-key', role: 'viewer' });

    expect(keyManager.validateKey(created.key)).toEqual({
      id: created.id,
      name: 'valid-key',
      role: 'viewer',
      type: 'api_key',
      userId: null,
    });
  });

  it('validateKey returns null for invalid key input', () => {
    expect(keyManager.validateKey('torque_sk_invalid')).toBeNull();
    expect(keyManager.validateKey(null)).toBeNull();
    expect(keyManager.validateKey(undefined)).toBeNull();
    expect(keyManager.validateKey('')).toBeNull();
  });

  it('revokeKey revokes keys and invalidates them', () => {
    keyManager.createKey({ name: 'admin-backstop', role: 'admin' });
    const created = keyManager.createKey({ name: 'revoke-me', role: 'viewer' });

    keyManager.revokeKey(created.id);

    const revokedRow = rawDb().prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(created.id);
    expect(revokedRow.revoked_at).toBeTruthy();
    expect(keyManager.validateKey(created.key)).toBeNull();
  });

  it('hasAnyKeys returns false when empty and true after key creation', () => {
    expect(keyManager.hasAnyKeys()).toBe(false);

    keyManager.createKey({ name: 'present', role: 'viewer' });

    expect(keyManager.hasAnyKeys()).toBe(true);
  });
});

describe('server/plugins/auth/role-guard', () => {
  const roleGuard = createRoleGuard();

  it('checks roles against the exported hierarchy', () => {
    expect(ROLE_HIERARCHY).toEqual(['viewer', 'operator', 'manager', 'admin']);
    expect(roleGuard.requireRole({ role: 'admin' }, 'manager')).toBe(true);
    expect(roleGuard.requireRole({ role: 'operator' }, 'viewer')).toBe(true);
    expect(() => roleGuard.requireRole({ role: 'viewer' }, 'operator')).toThrow(/operator/);
  });
});

describe('server/plugins/auth/rate-limiter', () => {
  it('blocks after the configured maximum failures', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 60000, blockMs: 30000 });

    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
    expect(limiter.check('1.2.3.4')).toBe(false);
  });
});
