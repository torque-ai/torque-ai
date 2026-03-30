'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const Database = require('better-sqlite3');

const { createUserManager } = require('../user-manager');
const { createSessionManager } = require('../session-manager');

let db;
let userManager;

function createUsersTable(handle) {
  handle.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT,
      updated_at TEXT,
      last_login_at TEXT
    )
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  createUsersTable(db);
  userManager = createUserManager({ db });
});

afterEach(() => {
  vi.useRealTimers();

  if (db) {
    db.close();
    db = null;
  }
});

describe('user-manager', () => {
  it('creates users and retrieves them', () => {
    expect(userManager.hasAnyUsers()).toBe(false);

    const created = userManager.createUser({
      username: '  Alice ',
      password: 'password123',
      role: 'operator',
      displayName: 'Alice',
    });

    expect(created).toMatchObject({
      username: 'alice',
      role: 'operator',
      displayName: 'Alice',
    });
    expect(userManager.hasAnyUsers()).toBe(true);
    expect(userManager.normalizeUsername('  Alice ')).toBe('alice');

    const fetched = userManager.getUserById(created.id);
    expect(fetched).toMatchObject({
      id: created.id,
      username: 'alice',
      displayName: 'Alice',
      role: 'operator',
    });

    const listed = userManager.listUsers();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      username: 'alice',
      displayName: 'Alice',
      role: 'operator',
    });

    const stored = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('alice');
    expect(stored.password_hash).toBeDefined();
    expect(stored.password_hash).not.toBe('password123');
  });

  it('validates passwords for correct and incorrect credentials', () => {
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

    const afterLogin = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);
    expect(afterLogin.last_login_at).toBeTruthy();
    expect(userManager.validatePassword('alice', 'wrong-password')).toBeNull();
  });

  it('rejects duplicate usernames after normalization', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });

    expect(() => {
      userManager.createUser({ username: ' ALICE ', password: 'password456' });
    }).toThrow(/already exists/);
  });

  it('rejects invalid roles', () => {
    expect(userManager.VALID_ROLES).toEqual(['viewer', 'operator', 'manager', 'admin']);

    expect(() => {
      userManager.validateRole('superadmin');
    }).toThrow(/Invalid role/);
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

    expect(userManager.deleteUser(firstAdmin.id)).toBe(true);
    expect(userManager.getUserById(firstAdmin.id)).toBeNull();

    expect(() => {
      userManager.deleteUser(secondAdmin.id);
    }).toThrow(/last admin/);
  });
});

describe('session-manager', () => {
  it('creates and retrieves sessions', () => {
    const manager = createSessionManager();
    const identity = { id: 'user-1', name: 'Alice', role: 'admin' };
    const { sessionId, csrfToken } = manager.createSession(identity);

    expect(typeof sessionId).toBe('string');
    expect(typeof csrfToken).toBe('string');
    expect(manager.getSession(sessionId)).toEqual({
      identity,
      csrfToken,
      lastAccess: expect.any(Number),
    });
  });

  it('expires sessions after the configured TTL', () => {
    vi.useFakeTimers();

    const manager = createSessionManager({ sessionTtlMs: 1000 });
    const { sessionId } = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });

    expect(manager.getSession(sessionId)).toBeTruthy();

    vi.advanceTimersByTime(1001);
    expect(manager.getSession(sessionId)).toBeNull();
  });

  it('validates csrf tokens', () => {
    const manager = createSessionManager();
    const { sessionId, csrfToken } = manager.createSession({
      id: 'user-1',
      name: 'Alice',
      role: 'admin',
    });

    expect(manager.validateCsrf(sessionId, csrfToken)).toBe(true);
    expect(manager.validateCsrf(sessionId, 'not-the-token')).toBe(false);
    expect(manager.validateCsrf('missing-session', csrfToken)).toBe(false);
  });

  it('evicts the least recently used session when the cap is reached', () => {
    const manager = createSessionManager({ maxSessions: 2 });
    const first = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' }).sessionId;
    const second = manager.createSession({ id: 'user-2', name: 'Bob', role: 'operator' }).sessionId;

    expect(manager.getSession(first)).toBeTruthy();

    const third = manager.createSession({ id: 'user-3', name: 'Cara', role: 'viewer' }).sessionId;

    expect(manager.getSessionCount()).toBe(2);
    expect(manager.getSession(first)).toBeTruthy();
    expect(manager.getSession(second)).toBeNull();
    expect(manager.getSession(third)).toBeTruthy();
  });

  it('destroys sessions by id and by identity', () => {
    const manager = createSessionManager();
    const first = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });
    const second = manager.createSession({ id: 'user-1', name: 'Alice', role: 'admin' });
    const third = manager.createSession({ id: 'user-2', name: 'Bob', role: 'viewer' });

    expect(manager.destroySession(first.sessionId)).toBe(true);
    expect(manager.getSession(first.sessionId)).toBeNull();
    expect(manager.getSessionCount()).toBe(2);

    expect(manager.destroySessionsByIdentityId('user-1')).toBe(1);
    expect(manager.getSession(second.sessionId)).toBeNull();
    expect(manager.getSession(third.sessionId)).toBeTruthy();
    expect(manager.getSessionCount()).toBe(1);
  });
});
