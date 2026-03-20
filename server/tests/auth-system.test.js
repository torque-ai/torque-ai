'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const keyManager = require('../auth/key-manager');

let db;

beforeAll(() => {
  ({ db } = setupTestDb('auth-system'));

  // Create api_keys table in test DB (mirrors schema-tables.js definition)
  const handle = rawDb();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  handle.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');

  // Initialize key-manager with the raw DB handle (supports prepare())
  keyManager.init(handle);
});

afterAll(() => {
  keyManager._resetForTest();
  teardownTestDb();
});

beforeEach(() => {
  // Clear api_keys and auth_server_secret between tests for isolation
  const handle = rawDb();
  handle.prepare('DELETE FROM api_keys').run();
  handle.prepare("DELETE FROM config WHERE key = 'auth_server_secret'").run();
  handle.prepare("DELETE FROM config WHERE key = 'api_key'").run();
  // Reset cached secret so each test starts fresh
  keyManager._resetForTest();
  keyManager.init(handle);
});

describe('key-manager', () => {
  describe('getServerSecret', () => {
    it('generates and caches a 64-char hex string', () => {
      const secret = keyManager.getServerSecret();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      // Calling again returns the same cached value
      const secret2 = keyManager.getServerSecret();
      expect(secret2).toBe(secret);
    });

    it('persists the secret to the config table', () => {
      const secret = keyManager.getServerSecret();
      const handle = rawDb();
      const row = handle.prepare("SELECT value FROM config WHERE key = 'auth_server_secret'").get();
      expect(row).toBeTruthy();
      expect(row.value).toBe(secret);
    });

    it('reads an existing secret from config if present', () => {
      const handle = rawDb();
      handle.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auth_server_secret', ?)").run('a'.repeat(64));
      // Re-init to clear cache
      keyManager._resetForTest();
      keyManager.init(handle);

      const secret = keyManager.getServerSecret();
      expect(secret).toBe('a'.repeat(64));
    });
  });

  describe('createKey', () => {
    it('returns plaintext with torque_sk_ prefix', () => {
      const result = keyManager.createKey({ name: 'test-key' });
      expect(result.key).toMatch(/^torque_sk_/);
      expect(result.name).toBe('test-key');
      expect(result.role).toBe('admin');
      expect(result.id).toBeTruthy();
    });

    it('stores HMAC hash, not plaintext, in the database', () => {
      const result = keyManager.createKey({ name: 'hash-test' });
      const handle = rawDb();
      const row = handle.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(result.id);
      expect(row).toBeTruthy();

      // key_hash should NOT be the plaintext
      expect(row.key_hash).not.toBe(result.key);

      // key_hash should be the HMAC of the plaintext
      const expectedHash = keyManager.hashKey(result.key);
      expect(row.key_hash).toBe(expectedHash);

      // Hash should be a 64-char hex string (SHA-256 output)
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('defaults role to admin', () => {
      const result = keyManager.createKey({ name: 'default-role' });
      expect(result.role).toBe('admin');
    });

    it('accepts a custom role', () => {
      const result = keyManager.createKey({ name: 'viewer-key', role: 'viewer' });
      expect(result.role).toBe('viewer');
    });

    it('throws if name is not provided', () => {
      expect(() => keyManager.createKey({})).toThrow('name is required');
    });
  });

  describe('validateKey', () => {
    it('returns identity for a valid key', () => {
      const created = keyManager.createKey({ name: 'valid-key', role: 'admin' });
      const identity = keyManager.validateKey(created.key);
      expect(identity).toBeTruthy();
      expect(identity.id).toBe(created.id);
      expect(identity.name).toBe('valid-key');
      expect(identity.role).toBe('admin');
    });

    it('returns null for an invalid key', () => {
      keyManager.createKey({ name: 'some-key' });
      const identity = keyManager.validateKey('torque_sk_invalid-key-that-does-not-exist');
      expect(identity).toBeNull();
    });

    it('returns null for a revoked key', () => {
      const created = keyManager.createKey({ name: 'revoke-test-1' });
      // Create a second key so we can revoke the first
      keyManager.createKey({ name: 'revoke-test-2' });
      keyManager.revokeKey(created.id);
      const identity = keyManager.validateKey(created.key);
      expect(identity).toBeNull();
    });

    it('returns null for null/undefined/empty input', () => {
      expect(keyManager.validateKey(null)).toBeNull();
      expect(keyManager.validateKey(undefined)).toBeNull();
      expect(keyManager.validateKey('')).toBeNull();
    });

    it('updates last_used_at on validation', () => {
      const created = keyManager.createKey({ name: 'usage-tracking' });
      keyManager.validateKey(created.key);

      const handle = rawDb();
      const row = handle.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id);
      expect(row.last_used_at).toBeTruthy();
    });

    it('does not update last_used_at more than once per minute', () => {
      const created = keyManager.createKey({ name: 'throttle-test' });

      // First validation sets last_used_at
      keyManager.validateKey(created.key);
      const handle = rawDb();
      const row1 = handle.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id);

      // Second validation within same second should not update
      keyManager.validateKey(created.key);
      const row2 = handle.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id);
      expect(row2.last_used_at).toBe(row1.last_used_at);
    });
  });

  describe('revokeKey', () => {
    it('revokes a key successfully', () => {
      const key1 = keyManager.createKey({ name: 'keep-key' });
      const key2 = keyManager.createKey({ name: 'revoke-me' });
      keyManager.revokeKey(key2.id);

      const handle = rawDb();
      const row = handle.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(key2.id);
      expect(row.revoked_at).toBeTruthy();

      // key1 should still be active
      const row1 = handle.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(key1.id);
      expect(row1.revoked_at).toBeNull();
    });

    it('throws when trying to revoke the last admin key', () => {
      const onlyAdmin = keyManager.createKey({ name: 'sole-admin', role: 'admin' });
      expect(() => keyManager.revokeKey(onlyAdmin.id)).toThrow('Cannot revoke the last admin key');
    });

    it('allows revoking a non-admin key even if it is the only key', () => {
      // Create an admin key (so there's at least one admin)
      keyManager.createKey({ name: 'admin-key', role: 'admin' });
      const viewerKey = keyManager.createKey({ name: 'viewer-key', role: 'viewer' });
      // Revoking the viewer should work fine
      keyManager.revokeKey(viewerKey.id);
      const handle = rawDb();
      const row = handle.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(viewerKey.id);
      expect(row.revoked_at).toBeTruthy();
    });

    it('throws for non-existent key', () => {
      expect(() => keyManager.revokeKey('nonexistent-id')).toThrow('Key not found');
    });

    it('throws for already-revoked key', () => {
      const key1 = keyManager.createKey({ name: 'keep' });
      const key2 = keyManager.createKey({ name: 'revoke-twice' });
      keyManager.revokeKey(key2.id);
      expect(() => keyManager.revokeKey(key2.id)).toThrow('Key already revoked');
    });
  });

  describe('listKeys', () => {
    it('never contains key_hash', () => {
      keyManager.createKey({ name: 'list-test-1' });
      keyManager.createKey({ name: 'list-test-2' });
      const keys = keyManager.listKeys();
      expect(keys.length).toBe(2);
      for (const k of keys) {
        expect(k).not.toHaveProperty('key_hash');
        expect(k).toHaveProperty('id');
        expect(k).toHaveProperty('name');
        expect(k).toHaveProperty('role');
        expect(k).toHaveProperty('created_at');
      }
    });

    it('returns empty array when no keys exist', () => {
      const keys = keyManager.listKeys();
      expect(keys).toEqual([]);
    });

    it('includes revoked keys', () => {
      const key1 = keyManager.createKey({ name: 'active-key' });
      const key2 = keyManager.createKey({ name: 'revoked-key' });
      keyManager.revokeKey(key2.id);
      const keys = keyManager.listKeys();
      expect(keys.length).toBe(2);
      const revokedEntry = keys.find(k => k.id === key2.id);
      expect(revokedEntry.revoked_at).toBeTruthy();
    });
  });

  describe('hasAnyKeys', () => {
    it('returns false when empty', () => {
      expect(keyManager.hasAnyKeys()).toBe(false);
    });

    it('returns true after createKey', () => {
      keyManager.createKey({ name: 'exists-test' });
      expect(keyManager.hasAnyKeys()).toBe(true);
    });

    it('returns false when all keys are revoked', () => {
      // Use viewer roles so revoking doesn't hit the "last admin" guard
      const k1 = keyManager.createKey({ name: 'viewer-1', role: 'viewer' });
      const k2 = keyManager.createKey({ name: 'viewer-2', role: 'viewer' });
      keyManager.revokeKey(k1.id);
      keyManager.revokeKey(k2.id);
      expect(keyManager.hasAnyKeys()).toBe(false);
    });
  });

  describe('migrateConfigApiKey', () => {
    it('moves existing config.api_key and clears config', () => {
      const handle = rawDb();
      // Simulate a legacy api_key in the config table
      const legacyKey = 'legacy-secret-key-value';
      handle.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('api_key', ?)").run(legacyKey);

      const migratedId = keyManager.migrateConfigApiKey();
      expect(migratedId).toBeTruthy();

      // Verify the key was inserted into api_keys
      const row = handle.prepare('SELECT * FROM api_keys WHERE id = ?').get(migratedId);
      expect(row).toBeTruthy();
      expect(row.name).toBe('Migrated Legacy Key');
      expect(row.role).toBe('admin');

      // Verify the hash matches the legacy key
      const expectedHash = keyManager.hashKey(legacyKey);
      expect(row.key_hash).toBe(expectedHash);

      // Verify config.api_key was cleared
      const configRow = handle.prepare("SELECT value FROM config WHERE key = 'api_key'").get();
      expect(configRow).toBeFalsy();
    });

    it('returns null if api_keys already has entries', () => {
      keyManager.createKey({ name: 'already-exists' });
      const handle = rawDb();
      handle.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('api_key', 'some-key')").run();

      const result = keyManager.migrateConfigApiKey();
      expect(result).toBeNull();
    });

    it('returns null if config.api_key is empty', () => {
      const result = keyManager.migrateConfigApiKey();
      expect(result).toBeNull();
    });
  });

  describe('hashKey', () => {
    it('produces consistent hashes for the same input', () => {
      const hash1 = keyManager.hashKey('test-input');
      const hash2 = keyManager.hashKey('test-input');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different inputs', () => {
      const hash1 = keyManager.hashKey('input-a');
      const hash2 = keyManager.hashKey('input-b');
      expect(hash1).not.toBe(hash2);
    });

    it('returns a 64-char hex string (SHA-256)', () => {
      const hash = keyManager.hashKey('any-value');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
