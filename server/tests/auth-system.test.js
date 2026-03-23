'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const keyManager = require('../auth/key-manager');
const ticketManager = require('../auth/ticket-manager');
const sessionManager = require('../auth/session-manager');
const userManager = require('../auth/user-manager');
const { resolve } = require('../auth/resolvers');
const { authenticate, extractCredential, parseCookie } = require('../auth/middleware');
const { requireRole } = require('../auth/role-guard');
const { AuthRateLimiter } = require('../auth/rate-limiter');

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
  userManager.init(handle);
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
  userManager.init(handle);
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
      keyManager.createKey({ name: 'keep' });
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
      keyManager.createKey({ name: 'active-key' });
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

// ---------------------------------------------------------------------------
// ticket-manager tests
// ---------------------------------------------------------------------------

describe('ticket-manager', () => {
  beforeEach(() => {
    ticketManager._reset();
  });

  afterEach(() => {
    ticketManager._reset();
    vi.useRealTimers();
  });

  it('createTicket returns a UUID string', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(identity);
    expect(typeof ticket).toBe('string');
    // UUID v4 format
    expect(ticket).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('consumeTicket returns identity and invalidates (single-use)', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(identity);
    const result = ticketManager.consumeTicket(ticket);
    expect(result).toEqual(identity);
    // Ticket is gone now
    expect(ticketManager.getTicketCount()).toBe(0);
  });

  it('consumeTicket returns null on second use', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(identity);
    ticketManager.consumeTicket(ticket);
    const result = ticketManager.consumeTicket(ticket);
    expect(result).toBeNull();
  });

  it('consumeTicket returns null after TTL expires', () => {
    vi.useFakeTimers();
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(identity);
    // Advance past 30s TTL
    vi.advanceTimersByTime(31000);
    const result = ticketManager.consumeTicket(ticket);
    expect(result).toBeNull();
  });

  it('createTicket throws when cap (100) is reached', () => {
    for (let i = 0; i < 100; i++) {
      ticketManager.createTicket({ id: `user-${i}` });
    }
    expect(() => ticketManager.createTicket({ id: 'over-cap' })).toThrow('Ticket cap reached (max 100)');
  });

  it('cleanupExpiredTickets removes old tickets', () => {
    vi.useFakeTimers();
    const identity = { id: 'user-1' };
    ticketManager.createTicket(identity);
    ticketManager.createTicket(identity);
    expect(ticketManager.getTicketCount()).toBe(2);

    // Advance past TTL
    vi.advanceTimersByTime(31000);
    ticketManager.cleanupExpiredTickets();
    expect(ticketManager.getTicketCount()).toBe(0);
  });

  it('_reset clears all tickets', () => {
    ticketManager.createTicket({ id: 'user-1' });
    ticketManager.createTicket({ id: 'user-2' });
    ticketManager._reset();
    expect(ticketManager.getTicketCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// session-manager tests
// ---------------------------------------------------------------------------

describe('session-manager', () => {
  beforeEach(() => {
    sessionManager._reset();
  });

  afterEach(() => {
    sessionManager._reset();
    vi.useRealTimers();
  });

  it('createSession returns sessionId and csrfToken', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    expect(typeof sessionId).toBe('string');
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(typeof csrfToken).toBe('string');
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getSession returns identity for valid session', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(identity);
    const entry = sessionManager.getSession(sessionId);
    expect(entry).toBeTruthy();
    expect(entry.identity).toEqual(identity);
  });

  it('getSession returns null for unknown session', () => {
    const result = sessionManager.getSession('nonexistent-session-id');
    expect(result).toBeNull();
  });

  it('getSession returns null for expired session', () => {
    vi.useFakeTimers();
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(identity);
    // Advance past 24-hour TTL
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    const result = sessionManager.getSession(sessionId);
    expect(result).toBeNull();
  });

  it('getSession updates lastAccess (sliding window)', () => {
    vi.useFakeTimers();
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(identity);

    // First access
    const entry1 = sessionManager.getSession(sessionId);
    const firstAccess = entry1.lastAccess;

    // Advance time a bit and access again
    vi.advanceTimersByTime(5000);
    const entry2 = sessionManager.getSession(sessionId);
    expect(entry2.lastAccess).toBeGreaterThan(firstAccess);
  });

  it('destroySession removes the session', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(identity);
    sessionManager.destroySession(sessionId);
    expect(sessionManager.getSession(sessionId)).toBeNull();
    expect(sessionManager.getSessionCount()).toBe(0);
  });

  it('validateCsrf returns true for matching token', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    expect(sessionManager.validateCsrf(sessionId, csrfToken)).toBe(true);
  });

  it('validateCsrf returns false for mismatched token', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(identity);
    expect(sessionManager.validateCsrf(sessionId, 'wrong-token')).toBe(false);
  });

  it('createSession evicts LRU when cap (50) is reached', () => {
    vi.useFakeTimers();
    const sessions = [];
    // Create 50 sessions, each 10ms apart so we have a clear LRU order
    for (let i = 0; i < 50; i++) {
      const { sessionId } = sessionManager.createSession({ id: `user-${i}` });
      sessions.push(sessionId);
      vi.advanceTimersByTime(10);
    }
    expect(sessionManager.getSessionCount()).toBe(50);

    // Adding one more should evict the oldest (sessions[0])
    sessionManager.createSession({ id: 'user-50' });
    expect(sessionManager.getSessionCount()).toBe(50);

    // The LRU session should be gone
    expect(sessionManager.getSession(sessions[0])).toBeNull();
    // A more recent session should still exist
    expect(sessionManager.getSession(sessions[49])).toBeTruthy();
  });

  it('_reset clears all sessions', () => {
    sessionManager.createSession({ id: 'user-1' });
    sessionManager.createSession({ id: 'user-2' });
    sessionManager._reset();
    expect(sessionManager.getSessionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolvers tests
// ---------------------------------------------------------------------------

describe('resolvers', () => {
  beforeEach(() => {
    ticketManager._reset();
    sessionManager._reset();
  });

  afterEach(() => {
    ticketManager._reset();
    sessionManager._reset();
  });

  it('resolves api_key credential to identity', () => {
    const created = keyManager.createKey({ name: 'resolver-key', role: 'admin' });
    const identity = resolve({ type: 'api_key', value: created.key });
    expect(identity).toBeTruthy();
    expect(identity.id).toBe(created.id);
    expect(identity.name).toBe('resolver-key');
    expect(identity.role).toBe('admin');
  });

  it('resolves session credential to identity', () => {
    const userIdentity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId } = sessionManager.createSession(userIdentity);
    const identity = resolve({ type: 'session', value: sessionId });
    expect(identity).toEqual(userIdentity);
  });

  it('resolves ticket credential to identity (and consumes it)', () => {
    const userIdentity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(userIdentity);
    const identity = resolve({ type: 'ticket', value: ticket });
    expect(identity).toEqual(userIdentity);
    // Ticket is consumed — second resolve returns null
    const second = resolve({ type: 'ticket', value: ticket });
    expect(second).toBeNull();
  });

  it('returns null for unknown credential type', () => {
    const result = resolve({ type: 'oauth', value: 'some-token' });
    expect(result).toBeNull();
  });

  it('returns null for invalid api_key', () => {
    keyManager.createKey({ name: 'some-key' });
    const result = resolve({ type: 'api_key', value: 'torque_sk_nonexistent' });
    expect(result).toBeNull();
  });

  it('returns null for null/undefined credential', () => {
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// middleware tests
// ---------------------------------------------------------------------------

describe('middleware', () => {
  beforeEach(() => {
    sessionManager._reset();
  });

  afterEach(() => {
    sessionManager._reset();
  });

  it('authenticate returns open-mode identity when no keys exist', () => {
    // beforeEach already clears api_keys, so no keys exist
    const req = { headers: {} };
    const identity = authenticate(req);
    expect(identity).toEqual({ id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' });
  });

  it('authenticate extracts Bearer token from Authorization header', () => {
    const created = keyManager.createKey({ name: 'bearer-test', role: 'admin' });
    const req = { headers: { authorization: `Bearer ${created.key}` } };
    const identity = authenticate(req);
    expect(identity).toBeTruthy();
    expect(identity.id).toBe(created.id);
    expect(identity.name).toBe('bearer-test');
  });

  it('authenticate extracts legacy X-Torque-Key header', () => {
    const created = keyManager.createKey({ name: 'legacy-header-test', role: 'admin' });
    const req = { headers: { 'x-torque-key': created.key } };
    const identity = authenticate(req);
    expect(identity).toBeTruthy();
    expect(identity.id).toBe(created.id);
    expect(identity.name).toBe('legacy-header-test');
  });

  it('authenticate extracts session from cookie', () => {
    // Create a key first so we're not in open mode
    keyManager.createKey({ name: 'force-auth-mode' });
    const userIdentity = { id: 'user-1', name: 'Bob', role: 'operator' };
    const { sessionId } = sessionManager.createSession(userIdentity);
    const req = { headers: { cookie: `torque_session=${sessionId}; other=abc` } };
    const identity = authenticate(req);
    expect(identity).toEqual(userIdentity);
  });

  it('authenticate returns null for missing credentials when keys exist', () => {
    keyManager.createKey({ name: 'key-exists' });
    const req = { headers: {} };
    const identity = authenticate(req);
    expect(identity).toBeNull();
  });

  it('requireRole: admin can access everything', () => {
    const admin = { id: 'a', name: 'Admin', role: 'admin' };
    expect(requireRole(admin, 'admin')).toBe(true);
    expect(requireRole(admin, 'operator')).toBe(true);
    expect(requireRole(admin, 'viewer')).toBe(true);
  });

  it('requireRole: operator can access operator endpoints', () => {
    const operator = { id: 'o', name: 'Operator', role: 'operator' };
    expect(requireRole(operator, 'operator')).toBe(true);
  });

  it('requireRole: operator cannot access admin endpoints', () => {
    const operator = { id: 'o', name: 'Operator', role: 'operator' };
    expect(requireRole(operator, 'admin')).toBe(false);
  });

  it('requireRole: returns false for null identity', () => {
    expect(requireRole(null, 'admin')).toBe(false);
    expect(requireRole(undefined, 'operator')).toBe(false);
  });

  it('extractCredential prioritizes Bearer over X-Torque-Key', () => {
    const req = {
      headers: {
        authorization: 'Bearer key-from-bearer',
        'x-torque-key': 'key-from-legacy',
      },
    };
    const cred = extractCredential(req);
    expect(cred).toEqual({ type: 'api_key', value: 'key-from-bearer' });
  });

  it('extractCredential returns null when no credentials present', () => {
    const req = { headers: {} };
    expect(extractCredential(req)).toBeNull();
  });

  it('parseCookie extracts named cookie from header', () => {
    expect(parseCookie('a=1; torque_session=abc123; b=2', 'torque_session')).toBe('abc123');
    expect(parseCookie('torque_session=xyz', 'torque_session')).toBe('xyz');
    expect(parseCookie('other=val', 'torque_session')).toBeNull();
    expect(parseCookie(null, 'torque_session')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rate-limiter tests
// ---------------------------------------------------------------------------

describe('rate-limiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 3, windowMs: 60000 });
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
  });

  it('blocks after exceeding max attempts', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 3, windowMs: 60000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    // 4th attempt exceeds the limit
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 10000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    // At limit
    expect(limiter.isLimited('1.2.3.4')).toBe(true);

    // Advance past window
    vi.advanceTimersByTime(11000);

    // Should be cleared now
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
  });

  it('isLimited returns true when at limit', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
  });

  it('cleanup removes old entries', () => {
    vi.useFakeTimers();
    const limiter = new AuthRateLimiter({ maxAttempts: 5, windowMs: 10000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('5.6.7.8');

    // Advance past window
    vi.advanceTimersByTime(11000);
    limiter.cleanup();

    // Both IPs should be cleaned up
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    expect(limiter.isLimited('5.6.7.8')).toBe(false);
    // Internal map should be empty
    expect(limiter._attempts.size).toBe(0);
  });

  it('tracks different IPs independently', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    // 1.2.3.4 is at limit
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    // 5.6.7.8 should still be fine
    expect(limiter.isLimited('5.6.7.8')).toBe(false);
    expect(limiter.recordFailure('5.6.7.8')).toBe(true);
  });

  it('_reset clears all attempts', () => {
    const limiter = new AuthRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    limiter._reset();
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    expect(limiter._attempts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SSE auth integration tests
// ---------------------------------------------------------------------------

describe('SSE auth integration', () => {
  beforeEach(() => {
    ticketManager._reset();
  });

  afterEach(() => {
    ticketManager._reset();
  });

  /**
   * Helper that replicates the SSE auth logic from mcp-sse.js.
   * This tests the extracted auth flow without needing a full SSE server.
   */
  function sseAuth({ ticket, apiKey }) {
    let identity = null;

    if (ticket) {
      identity = ticketManager.consumeTicket(ticket);
    } else if (apiKey) {
      identity = keyManager.validateKey(apiKey);
    }

    // Open mode: no keys = admin
    if (!identity && !keyManager.hasAnyKeys()) {
      identity = { id: 'open-mode', name: 'Open Mode', role: 'admin' };
    }

    return { isAuthenticated: !!identity, identity };
  }

  it('validates API key from query param', () => {
    const created = keyManager.createKey({ name: 'sse-key-test', role: 'admin' });
    const result = sseAuth({ apiKey: created.key });
    expect(result.isAuthenticated).toBe(true);
    expect(result.identity.id).toBe(created.id);
    expect(result.identity.name).toBe('sse-key-test');
  });

  it('validates ticket from query param', () => {
    const userIdentity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(userIdentity);
    const result = sseAuth({ ticket });
    expect(result.isAuthenticated).toBe(true);
    expect(result.identity).toEqual(userIdentity);
  });

  it('ticket takes precedence over apiKey when both present', () => {
    const created = keyManager.createKey({ name: 'sse-both-test', role: 'operator' });
    const ticketIdentity = { id: 'ticket-user', name: 'TicketUser', role: 'admin' };
    const ticket = ticketManager.createTicket(ticketIdentity);

    const result = sseAuth({ ticket, apiKey: created.key });
    expect(result.isAuthenticated).toBe(true);
    // Should use ticket identity, not the API key identity
    expect(result.identity.id).toBe('ticket-user');
    expect(result.identity.name).toBe('TicketUser');
    expect(result.identity.role).toBe('admin');
  });

  it('open mode allows unauthenticated SSE', () => {
    // No keys created — open mode
    const result = sseAuth({});
    expect(result.isAuthenticated).toBe(true);
    expect(result.identity).toEqual({ id: 'open-mode', name: 'Open Mode', role: 'admin' });
  });

  it('rejects unauthenticated SSE when keys exist', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    const result = sseAuth({});
    expect(result.isAuthenticated).toBe(false);
    expect(result.identity).toBeNull();
  });

  it('rejects invalid API key when keys exist', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    const result = sseAuth({ apiKey: 'torque_sk_bogus-key' });
    expect(result.isAuthenticated).toBe(false);
    expect(result.identity).toBeNull();
  });

  it('rejects expired ticket', () => {
    vi.useFakeTimers();
    keyManager.createKey({ name: 'force-auth-mode' });
    const userIdentity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const ticket = ticketManager.createTicket(userIdentity);
    // Advance past 30s TTL
    vi.advanceTimersByTime(31000);
    const result = sseAuth({ ticket });
    expect(result.isAuthenticated).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Protocol auth integration tests
// ---------------------------------------------------------------------------

describe('Protocol auth integration', () => {
  /**
   * Helper that replicates the protocol auth logic from mcp-protocol.js.
   */
  function protocolAuth({ method, sessionAuthenticated }) {
    if (method !== 'initialize' && !method.startsWith('notifications/') && !sessionAuthenticated) {
      try {
        if (keyManager.hasAnyKeys()) {
          return { blocked: true, code: -32600 };
        }
      } catch (e) {
        if (e.code === -32600) return { blocked: true, code: -32600 };
        // If key-manager fails to load, allow
      }
    }
    return { blocked: false };
  }

  it('allows initialize without auth', () => {
    keyManager.createKey({ name: 'proto-test' });
    const result = protocolAuth({ method: 'initialize', sessionAuthenticated: false });
    expect(result.blocked).toBe(false);
  });

  it('allows notifications without auth', () => {
    keyManager.createKey({ name: 'proto-test' });
    const result = protocolAuth({ method: 'notifications/initialized', sessionAuthenticated: false });
    expect(result.blocked).toBe(false);
  });

  it('blocks unauthenticated tools/call when keys exist', () => {
    keyManager.createKey({ name: 'proto-test' });
    const result = protocolAuth({ method: 'tools/call', sessionAuthenticated: false });
    expect(result.blocked).toBe(true);
    expect(result.code).toBe(-32600);
  });

  it('allows unauthenticated tools/call when no keys exist (open mode)', () => {
    const result = protocolAuth({ method: 'tools/call', sessionAuthenticated: false });
    expect(result.blocked).toBe(false);
  });

  it('allows authenticated tools/call when keys exist', () => {
    keyManager.createKey({ name: 'proto-test' });
    const result = protocolAuth({ method: 'tools/call', sessionAuthenticated: true });
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REST API auth integration tests
// ---------------------------------------------------------------------------

describe('REST API auth', () => {
  const { authenticateRequest, AUTH_OPEN_PATHS } = require('../api/middleware');

  beforeEach(() => {
    sessionManager._reset();
  });

  afterEach(() => {
    sessionManager._reset();
  });

  it('authenticateRequest returns open-mode identity when no keys', () => {
    // No keys created — open mode
    const req = { headers: {} };
    const result = authenticateRequest(req, '/api/tasks');
    expect(result).toEqual({ id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' });
  });

  it('authenticateRequest returns identity for valid bearer token', () => {
    const created = keyManager.createKey({ name: 'rest-auth-test', role: 'admin' });
    const req = { headers: { authorization: `Bearer ${created.key}` } };
    const result = authenticateRequest(req, '/api/tasks');
    expect(result).toBeTruthy();
    expect(result.id).toBe(created.id);
    expect(result.name).toBe('rest-auth-test');
    expect(result.role).toBe('admin');
  });

  it('authenticateRequest returns null for invalid bearer token', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    const req = { headers: { authorization: 'Bearer torque_sk_bogus-key-value' } };
    const result = authenticateRequest(req, '/api/tasks');
    expect(result).toBeNull();
  });

  it('authenticateRequest skips auth for open paths', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    for (const openPath of AUTH_OPEN_PATHS) {
      const req = { headers: {} };
      const result = authenticateRequest(req, openPath);
      expect(result).toEqual({ type: 'open-path' });
    }
  });

  it('authenticateRequest skips auth for paths prefixed with open paths', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    const req = { headers: {} };
    // /api/auth/login/anything should also be open
    const result = authenticateRequest(req, '/api/auth/login/extra');
    expect(result).toEqual({ type: 'open-path' });
  });

  it('authenticateRequest returns null when keys exist and no credential provided', () => {
    keyManager.createKey({ name: 'force-auth-mode' });
    const req = { headers: {} };
    const result = authenticateRequest(req, '/api/tasks');
    expect(result).toBeNull();
  });

  it('CORS allows Authorization header', () => {
    const { sendJson } = require('../api/middleware');
    const headers = {};
    const mockRes = {
      writeHead: (_status, h) => { Object.assign(headers, h); },
      end: () => {},
    };
    sendJson(mockRes, {}, 200, null);
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration tests
// ---------------------------------------------------------------------------

describe('auth integration', () => {
  it('full flow: create key -> validate -> ticket -> consume -> revoke', () => {
    // 1. Create admin key
    const { key, id } = keyManager.createKey({ name: 'integration-test', role: 'admin' });
    expect(key).toMatch(/^torque_sk_/);

    // 2. Validate returns identity
    const identity = keyManager.validateKey(key);
    expect(identity).toBeDefined();
    expect(identity.role).toBe('admin');

    // 3. Create ticket from identity
    const ticket = ticketManager.createTicket(identity);
    expect(ticket).toBeDefined();

    // 4. Consume ticket returns same identity
    const ticketIdentity = ticketManager.consumeTicket(ticket);
    expect(ticketIdentity.id).toBe(identity.id);

    // 5. Consume again fails (single-use)
    expect(ticketManager.consumeTicket(ticket)).toBeNull();

    // 6. Revoke key — need a second admin so we can revoke
    keyManager.createKey({ name: 'keep-alive', role: 'admin' });
    keyManager.revokeKey(id);
    expect(keyManager.validateKey(key)).toBeNull();
  });

  it('full flow: create key -> login -> session -> CSRF -> logout', () => {
    // 1. Create key
    const { key } = keyManager.createKey({ name: 'session-test', role: 'admin' });

    // 2. Validate key -> identity
    const identity = keyManager.validateKey(key);

    // 3. Create session
    const { sessionId, csrfToken } = sessionManager.createSession(identity);

    // 4. Get session
    const session = sessionManager.getSession(sessionId);
    expect(session.identity.id).toBe(identity.id);

    // 5. CSRF validation
    expect(sessionManager.validateCsrf(sessionId, csrfToken)).toBe(true);
    expect(sessionManager.validateCsrf(sessionId, 'wrong')).toBe(false);

    // 6. Logout
    sessionManager.destroySession(sessionId);
    expect(sessionManager.getSession(sessionId)).toBeNull();
  });

  it('open mode -> create first key -> auth enforced', () => {
    // Start with no keys
    expect(keyManager.hasAnyKeys()).toBe(false);

    // Open mode: middleware returns admin identity
    const openIdentity = authenticate({ headers: {} });
    expect(openIdentity.role).toBe('admin');

    // Create first key
    const { key } = keyManager.createKey({ name: 'first-key', role: 'admin' });
    expect(keyManager.hasAnyKeys()).toBe(true);

    // Now middleware requires auth
    expect(authenticate({ headers: {} })).toBeNull();

    // Valid key works
    const authed = authenticate({
      headers: { authorization: `Bearer ${key}` },
    });
    expect(authed.role).toBe('admin');
  });

  it('migration: config.api_key -> api_keys table', () => {
    // Set a "legacy" key in config
    const legacyKey = 'legacy-test-key-12345';
    db.setConfig('api_key', legacyKey);

    // Run migration
    keyManager.migrateConfigApiKey();

    // Config is cleared
    expect(db.getConfig('api_key')).toBeFalsy();

    // Legacy key validates through new system
    const identity = keyManager.validateKey(legacyKey);
    expect(identity).toBeDefined();
    expect(identity.name).toBe('Migrated Legacy Key');
  });
});
