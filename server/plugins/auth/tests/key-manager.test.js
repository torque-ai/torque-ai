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
    expect(typeof keyManager.getServerSecret).toBe('function');
    expect(typeof keyManager.hashKey).toBe('function');
    expect(typeof keyManager.createKey).toBe('function');
    expect(typeof keyManager.validateKey).toBe('function');
    expect(typeof keyManager.revokeKey).toBe('function');
    expect(typeof keyManager.listKeys).toBe('function');
    expect(typeof keyManager.listKeysByUser).toBe('function');
    expect(typeof keyManager.hasAnyKeys).toBe('function');
    expect(typeof keyManager.migrateConfigApiKey).toBe('function');
  });

  it('createKey returns torque_sk_ style plaintext key', () => {
    const created = keyManager.createKey({ name: 'test-key', role: 'operator' });
    expect(created.key).toMatch(/^torque_sk_[0-9a-f-]{36}$/i);
    expect(created.name).toBe('test-key');
    expect(created.role).toBe('operator');
  });

  it('validateKey succeeds/fails correctly', () => {
    const created = keyManager.createKey({ name: 'valid-key', role: 'viewer' });
    const identity = keyManager.validateKey(created.key);
    expect(identity).toEqual({
      id: created.id,
      name: 'valid-key',
      role: 'viewer',
      type: 'api_key',
      userId: null,
    });

    expect(keyManager.validateKey('torque_sk_invalid')).toBeNull();
    expect(keyManager.validateKey(null)).toBeNull();
    expect(keyManager.validateKey(undefined)).toBeNull();
    expect(keyManager.validateKey('')).toBeNull();
  });

  it('validates last_used_at updates no more than once per minute', () => {
    const created = keyManager.createKey({ name: 'usage-tracking' });
    const handle = rawDb();

    keyManager.validateKey(created.key);
    const first = handle.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id).last_used_at;
    expect(first).toBeTruthy();

    keyManager.validateKey(created.key);
    const second = handle.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id).last_used_at;
    expect(second).toBe(first);
  });

  it('revokeKey revokes keys and blocks revoking last admin key', () => {
    const admin = keyManager.createKey({ name: 'keep', role: 'admin' });
    const admin2 = keyManager.createKey({ name: 'extra-admin', role: 'admin' });
    const viewer = keyManager.createKey({ name: 'revoke-me', role: 'viewer' });
    keyManager.revokeKey(viewer.id);

    const revokedRow = rawDb().prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(viewer.id);
    expect(revokedRow.revoked_at).toBeTruthy();

    keyManager.revokeKey(admin.id);
    expect(keyManager.hasAnyKeys()).toBe(true);

    expect(() => keyManager.revokeKey(admin2.id)).toThrow('Cannot revoke the last admin key');
  });

  it('hasAnyKeys reflects active keys', () => {
    expect(keyManager.hasAnyKeys()).toBe(false);

    const first = keyManager.createKey({ name: 'a', role: 'viewer' });
    expect(keyManager.hasAnyKeys()).toBe(true);

    keyManager.revokeKey(first.id);
    expect(keyManager.hasAnyKeys()).toBe(false);
  });

  it('listKeysByUser returns only matching keys', () => {
    const handle = rawDb();
    handle.exec(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES ('user-1', 'user-1', 'hash1', 'viewer', datetime('now'))"
    );
    handle.exec(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES ('user-2', 'user-2', 'hash2', 'viewer', datetime('now'))"
    );

    keyManager.createKey({ name: 'u1-a', userId: 'user-1' });
    keyManager.createKey({ name: 'u1-b', userId: 'user-1' });
    keyManager.createKey({ name: 'u2-a', userId: 'user-2' });

    const userOneKeys = keyManager.listKeysByUser('user-1');
    const userTwoKeys = keyManager.listKeysByUser('user-2');
    expect(userOneKeys).toHaveLength(2);
    expect(userTwoKeys).toHaveLength(1);
    expect(userOneKeys.every((key) => !('key_hash' in key))).toBe(true);
    expect(userTwoKeys[0].name).toBe('u2-a');
  });
});

describe('server/plugins/auth/role-guard', () => {
  const roleGuard = createRoleGuard();

  it('exports role hierarchy in expected order', () => {
    expect(ROLE_HIERARCHY).toEqual(['viewer', 'operator', 'manager', 'admin']);
  });

  it('checks roles against hierarchy', () => {
    const admin = { role: 'admin' };
    const manager = { role: 'manager' };
    const operator = { role: 'operator' };
    const viewer = { role: 'viewer' };
    const unknown = { role: 'superuser' };

    expect(roleGuard.requireRole(admin, 'viewer')).toBe(true);
    expect(roleGuard.requireRole(admin, 'operator')).toBe(true);
    expect(roleGuard.requireRole(admin, 'manager')).toBe(true);
    expect(roleGuard.requireRole(admin, 'admin')).toBe(true);

    expect(roleGuard.requireRole(manager, 'viewer')).toBe(true);
    expect(roleGuard.requireRole(manager, 'operator')).toBe(true);
    expect(roleGuard.requireRole(manager, 'manager')).toBe(true);
    expect(roleGuard.requireRole(manager, 'admin')).toBe(false);

    expect(roleGuard.requireRole(operator, 'viewer')).toBe(true);
    expect(roleGuard.requireRole(operator, 'operator')).toBe(true);
    expect(roleGuard.requireRole(operator, 'manager')).toBe(false);
    expect(roleGuard.requireRole(operator, 'admin')).toBe(false);

    expect(roleGuard.requireRole(viewer, 'viewer')).toBe(true);
    expect(roleGuard.requireRole(viewer, 'operator')).toBe(false);
    expect(roleGuard.requireRole(viewer, 'manager')).toBe(false);
    expect(roleGuard.requireRole(viewer, 'admin')).toBe(false);

    expect(roleGuard.requireRole(null, 'viewer')).toBe(false);
    expect(roleGuard.requireRole(undefined, 'operator')).toBe(false);
    expect(roleGuard.requireRole(unknown, 'viewer')).toBe(false);
    expect(roleGuard.requireRole(admin, 'superuser')).toBe(false);
  });
});

describe('server/plugins/auth/rate-limiter', () => {
  it('records failures and enforces limit', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
  });

  it('isLimited does not mutate state', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 1, windowMs: 60000 });
    expect(limiter.isLimited('1.1.1.1')).toBe(false);
    limiter.recordFailure('1.1.1.1');
    expect(limiter.isLimited('1.1.1.1')).toBe(true);
  });

  it('cleans up old attempts', () => {
    vi.useFakeTimers();
    const limiter = new AuthRateLimiter({ maxAttempts: 1, windowMs: 10000 });
    limiter.recordFailure('1.1.1.1');
    vi.advanceTimersByTime(11000);
    limiter.cleanup();
    expect(limiter.isLimited('1.1.1.1')).toBe(false);
    vi.useRealTimers();
  });
});
