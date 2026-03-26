'use strict';
/* global describe, it, expect, beforeAll, afterAll, beforeEach, afterEach */

let testHelpers;
try {
  testHelpers = require('../../../../tests/vitest-setup');
} catch (_err) {
  testHelpers = require('../../../tests/vitest-setup');
}
const { createUserManager } = require('../user-manager');
const { createSessionManager } = require('../session-manager');
const { setupTestDb, teardownTestDb, rawDb } = testHelpers;

let userManager;
beforeAll(() => {
  setupTestDb('auth-plugin-user-session');

  const handle = rawDb();
  handle.exec(`
    DROP TABLE IF EXISTS users;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'viewer',
      created_at TEXT,
      updated_at TEXT,
      last_login_at TEXT
    )
  `);

  userManager = createUserManager({ db: handle });
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  const handle = rawDb();
  handle.prepare('DELETE FROM users').run();
  userManager = createUserManager({ db: handle });
});

describe('user-manager', () => {
  it('creates users and normalizes usernames', () => {
    const created = userManager.createUser({
      username: '  Alice ',
      password: 'password123',
      role: 'operator',
      displayName: 'Alice',
    });

    expect(created.username).toBe('alice');
    expect(created.role).toBe('operator');
    expect(created.displayName).toBe('Alice');

    const row = rawDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('alice');
    expect(row.password_hash).toBeDefined();
    expect(row.password_hash).not.toBe('password123');
  });

  it('prevents duplicate usernames', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    expect(() => {
      userManager.createUser({ username: 'ALICE', password: 'password456' });
    }).toThrow(/already exists/);
  });

  it('validates role', () => {
    expect(() => {
      userManager.createUser({ username: 'alice', password: 'password123', role: 'superadmin' });
    }).toThrow(/Invalid role/);

    const created = userManager.createUser({ username: 'alice', password: 'password123', role: 'manager' });
    expect(created.role).toBe('manager');
  });

  it('validates password input length requirements', () => {
    expect(() => {
      userManager.createUser({ username: 'alice', password: 'short' });
    }).toThrow(/at least 8/);

    expect(() => {
      userManager.createUser({ username: 'alice', password: 'a'.repeat(73) });
    }).toThrow(/at most 72/);
  });

  it('validates password correctly and tracks last_login_at', () => {
    const created = userManager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'viewer',
      displayName: 'Alice',
    });

    expect(userManager.validatePassword('alice', 'password123')).toEqual({
      id: created.id,
      name: 'Alice',
      username: 'alice',
      role: 'viewer',
      type: 'user',
    });
    const afterLogin = rawDb().prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);
    expect(afterLogin.last_login_at).toBeTruthy();

    expect(userManager.validatePassword('alice', 'wrong-password')).toBeNull();
    expect(rawDb().prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id).last_login_at).toBeTruthy();
  });

  it('protects the last admin from deletion', () => {
    const firstAdmin = userManager.createUser({
      username: 'admin1',
      password: 'password123',
      role: 'admin',
    });
    const secondAdmin = userManager.createUser({
      username: 'admin2',
      password: 'password123',
      role: 'admin',
    });

    userManager.deleteUser(firstAdmin.id);
    expect(userManager.getUserById(firstAdmin.id)).toBeNull();

    expect(() => {
      userManager.deleteUser(secondAdmin.id);
    }).toThrow(/last admin/);
  });
});

describe('session-manager', () => {
  it('creates and returns a session with CSRF token', () => {
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId, csrfToken } = createSessionManager().createSession(identity);

    expect(typeof sessionId).toBe('string');
    expect(typeof csrfToken).toBe('string');
  });

  it('retrieves active sessions and returns null after expiry', () => {
    vi.useFakeTimers();
    const manager = createSessionManager({ sessionTtlMs: 1000 });
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId, csrfToken } = manager.createSession(identity);

    const active = manager.getSession(sessionId);
    expect(active).toBeTruthy();
    expect(active.identity).toEqual(identity);
    expect(active.csrfToken).toBe(csrfToken);

    vi.advanceTimersByTime(1001);
    expect(manager.getSession(sessionId)).toBeNull();
    vi.useRealTimers();
  });

  it('validates CSRF tokens safely', () => {
    const manager = createSessionManager();
    const { sessionId, csrfToken } = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });

    expect(manager.validateCsrf(sessionId, csrfToken)).toBe(true);
    expect(manager.validateCsrf(sessionId, 'not-the-token')).toBe(false);
  });

  it('evicts least-recently-used sessions when cap is reached', () => {
    const manager = createSessionManager({ maxSessions: 2 });
    const first = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' }).sessionId;
    manager.createSession({ id: 'user-2', name: 'Bob', role: 'admin' });
    manager.createSession({ id: 'user-3', name: 'Cara', role: 'admin' });

    expect(manager.getSessionCount()).toBe(2);
    expect(manager.getSession(first)).toBeNull();
  });

  it('destroys sessions by id and by identity', () => {
    const manager = createSessionManager();
    const { sessionId } = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });
    const second = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });
    const third = manager.createSession({ id: 'user-2', name: 'Bob', role: 'viewer' });

    manager.destroySession(sessionId);
    expect(manager.getSessionCount()).toBe(2);
    expect(manager.getSession(sessionId)).toBeNull();

    manager.destroySessionsByIdentityId('user-1');
    expect(manager.getSessionCount()).toBe(1);
    expect(manager.getSession(second.sessionId)).toBeNull();
    expect(manager.getSession(third.sessionId)).toBeTruthy();
  });
});
