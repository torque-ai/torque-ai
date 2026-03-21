'use strict';
/* global describe, it, expect, beforeEach, afterEach */

const Database = require('better-sqlite3');
const userManager = require('../auth/user-manager');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      last_login_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      user_id TEXT
    )
  `);
  userManager.init(db);
});

afterEach(() => {
  userManager._resetForTest();
  if (db) {
    db.close();
    db = null;
  }
});

describe('createUser', () => {
  it('creates a user with hashed password and returns safe fields', () => {
    const result = userManager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'operator',
      displayName: 'Alice Smith',
    });

    expect(result).toHaveProperty('id');
    expect(result.username).toBe('alice');
    expect(result.role).toBe('operator');
    expect(result.displayName).toBe('Alice Smith');
    // Must never return password_hash
    expect(result).not.toHaveProperty('password_hash');
    expect(result).not.toHaveProperty('passwordHash');

    // Verify password is hashed in the DB
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('alice');
    expect(row.password_hash).not.toBe('password123');
    expect(row.password_hash.startsWith('$2a$') || row.password_hash.startsWith('$2b$')).toBe(true);
  });

  it('normalizes username to lowercase and trims whitespace', () => {
    const result = userManager.createUser({
      username: '  Alice  ',
      password: 'password123',
    });
    expect(result.username).toBe('alice');
  });

  it('defaults role to viewer', () => {
    const result = userManager.createUser({
      username: 'bob',
      password: 'password123',
    });
    expect(result.role).toBe('viewer');
  });

  it('rejects duplicate usernames', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    expect(() => {
      userManager.createUser({ username: 'alice', password: 'password456' });
    }).toThrow(/already exists/);
  });

  it('rejects duplicate usernames case-insensitively', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    expect(() => {
      userManager.createUser({ username: 'ALICE', password: 'password456' });
    }).toThrow(/already exists/);
  });

  it('rejects username shorter than 3 characters', () => {
    expect(() => {
      userManager.createUser({ username: 'ab', password: 'password123' });
    }).toThrow(/3-64 characters/);
  });

  it('rejects username longer than 64 characters', () => {
    const longName = 'a'.repeat(65);
    expect(() => {
      userManager.createUser({ username: longName, password: 'password123' });
    }).toThrow(/3-64 characters/);
  });

  it('rejects username with spaces', () => {
    expect(() => {
      userManager.createUser({ username: 'alice bob', password: 'password123' });
    }).toThrow(/3-64 characters/);
  });

  it('rejects username with special characters', () => {
    expect(() => {
      userManager.createUser({ username: 'alice@bob', password: 'password123' });
    }).toThrow(/3-64 characters/);
  });

  it('accepts valid usernames with hyphens and underscores', () => {
    const result = userManager.createUser({
      username: 'alice-bob_123',
      password: 'password123',
    });
    expect(result.username).toBe('alice-bob_123');
  });

  it('rejects password shorter than 8 characters', () => {
    expect(() => {
      userManager.createUser({ username: 'alice', password: 'short' });
    }).toThrow(/at least 8/);
  });

  it('rejects password longer than 72 characters', () => {
    const longPassword = 'a'.repeat(73);
    expect(() => {
      userManager.createUser({ username: 'alice', password: longPassword });
    }).toThrow(/at most 72/);
  });

  it('rejects blank password', () => {
    expect(() => {
      userManager.createUser({ username: 'alice', password: '        ' });
    }).toThrow(/required/);
  });

  it('rejects invalid role', () => {
    expect(() => {
      userManager.createUser({ username: 'alice', password: 'password123', role: 'superadmin' });
    }).toThrow(/Invalid role/);
  });

  it('accepts all valid roles', () => {
    const roles = ['admin', 'manager', 'operator', 'viewer'];
    roles.forEach((role, i) => {
      const result = userManager.createUser({
        username: `user${i}`,
        password: 'password123',
        role,
      });
      expect(result.role).toBe(role);
    });
  });
});

describe('validatePassword', () => {
  it('returns identity for correct password', () => {
    const created = userManager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'operator',
      displayName: 'Alice Smith',
    });

    const identity = userManager.validatePassword('alice', 'password123');
    expect(identity).not.toBeNull();
    expect(identity.id).toBe(created.id);
    expect(identity.name).toBe('Alice Smith');
    expect(identity.username).toBe('alice');
    expect(identity.role).toBe('operator');
    expect(identity.type).toBe('user');
  });

  it('uses username as name when displayName is null', () => {
    userManager.createUser({
      username: 'alice',
      password: 'password123',
    });

    const identity = userManager.validatePassword('alice', 'password123');
    expect(identity.name).toBe('alice');
  });

  it('returns null for wrong password', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    const result = userManager.validatePassword('alice', 'wrongpassword');
    expect(result).toBeNull();
  });

  it('returns null for nonexistent user', () => {
    const result = userManager.validatePassword('nonexistent', 'password123');
    expect(result).toBeNull();
  });

  it('is case-insensitive on username lookup', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    const identity = userManager.validatePassword('ALICE', 'password123');
    expect(identity).not.toBeNull();
    expect(identity.username).toBe('alice');
  });

  it('updates last_login_at on successful login', () => {
    const created = userManager.createUser({ username: 'alice', password: 'password123' });

    // Before login, last_login_at should be null
    const before = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);
    expect(before.last_login_at).toBeNull();

    userManager.validatePassword('alice', 'password123');

    const after = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);
    expect(after.last_login_at).not.toBeNull();
  });

  it('does not update last_login_at on failed login', () => {
    const created = userManager.createUser({ username: 'alice', password: 'password123' });
    userManager.validatePassword('alice', 'wrongpassword');

    const row = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);
    expect(row.last_login_at).toBeNull();
  });

  it('never returns password_hash in identity', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    const identity = userManager.validatePassword('alice', 'password123');
    expect(identity).not.toHaveProperty('password_hash');
    expect(identity).not.toHaveProperty('passwordHash');
  });
});

describe('hasAnyUsers', () => {
  it('returns false when no users exist', () => {
    expect(userManager.hasAnyUsers()).toBe(false);
  });

  it('returns true after creating a user', () => {
    userManager.createUser({ username: 'alice', password: 'password123' });
    expect(userManager.hasAnyUsers()).toBe(true);
  });
});

describe('listUsers', () => {
  it('returns empty array when no users exist', () => {
    expect(userManager.listUsers()).toEqual([]);
  });

  it('returns array of users without password_hash', () => {
    userManager.createUser({ username: 'alice', password: 'password123', role: 'admin' });
    userManager.createUser({ username: 'bob', password: 'password456', role: 'viewer' });

    const users = userManager.listUsers();
    expect(users).toHaveLength(2);
    expect(users[0].username).toBe('alice');
    expect(users[1].username).toBe('bob');

    // No password_hash in any user
    for (const user of users) {
      expect(user).not.toHaveProperty('password_hash');
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).toHaveProperty('id');
      expect(user).toHaveProperty('username');
      expect(user).toHaveProperty('role');
      expect(user).toHaveProperty('created_at');
    }
  });

  it('returns users ordered by created_at', () => {
    userManager.createUser({ username: 'bob', password: 'password123' });
    userManager.createUser({ username: 'alice', password: 'password123' });

    const users = userManager.listUsers();
    // bob was created first
    expect(users[0].username).toBe('bob');
    expect(users[1].username).toBe('alice');
  });
});

describe('getUserById', () => {
  it('returns user without password_hash', () => {
    const created = userManager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'admin',
      displayName: 'Alice',
    });

    const user = userManager.getUserById(created.id);
    expect(user).not.toBeNull();
    expect(user.id).toBe(created.id);
    expect(user.username).toBe('alice');
    expect(user.role).toBe('admin');
    expect(user.displayName).toBe('Alice');
    expect(user).not.toHaveProperty('password_hash');
  });

  it('returns null for nonexistent id', () => {
    expect(userManager.getUserById('nonexistent')).toBeNull();
  });
});

describe('updateUser', () => {
  it('updates role', () => {
    const created = userManager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'viewer',
    });

    userManager.updateUser(created.id, { role: 'admin' });

    const user = userManager.getUserById(created.id);
    expect(user.role).toBe('admin');
    expect(user.updated_at).not.toBeNull();
  });

  it('updates display_name', () => {
    const created = userManager.createUser({ username: 'alice', password: 'password123' });
    userManager.updateUser(created.id, { displayName: 'Alice Smith' });

    const user = userManager.getUserById(created.id);
    expect(user.displayName).toBe('Alice Smith');
  });

  it('updates password — old stops working, new works', () => {
    const created = userManager.createUser({ username: 'alice', password: 'oldpassword1' });

    userManager.updateUser(created.id, { password: 'newpassword1' });

    // Old password no longer works
    expect(userManager.validatePassword('alice', 'oldpassword1')).toBeNull();

    // New password works
    const identity = userManager.validatePassword('alice', 'newpassword1');
    expect(identity).not.toBeNull();
    expect(identity.id).toBe(created.id);
  });

  it('rejects invalid role on update', () => {
    const created = userManager.createUser({ username: 'alice', password: 'password123' });
    expect(() => {
      userManager.updateUser(created.id, { role: 'superadmin' });
    }).toThrow(/Invalid role/);
  });

  it('rejects invalid password on update', () => {
    const created = userManager.createUser({ username: 'alice', password: 'password123' });
    expect(() => {
      userManager.updateUser(created.id, { password: 'short' });
    }).toThrow(/at least 8/);
  });

  it('throws for nonexistent user', () => {
    expect(() => {
      userManager.updateUser('nonexistent', { role: 'admin' });
    }).toThrow(/not found/i);
  });
});

describe('deleteUser', () => {
  it('deletes user by id', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });
    const viewer = userManager.createUser({ username: 'viewer1', password: 'password123', role: 'viewer' });

    userManager.deleteUser(viewer.id);

    expect(userManager.getUserById(viewer.id)).toBeNull();
    expect(userManager.getUserById(admin.id)).not.toBeNull();
  });

  it('throws when deleting last admin with no orphan admin API keys', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });

    expect(() => {
      userManager.deleteUser(admin.id);
    }).toThrow(/last admin/);
  });

  it('allows deleting admin when another admin user exists', () => {
    const admin1 = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });
    userManager.createUser({ username: 'admin2', password: 'password123', role: 'admin' });

    // Should not throw
    userManager.deleteUser(admin1.id);
    expect(userManager.getUserById(admin1.id)).toBeNull();
  });

  it('allows deleting admin when orphan admin API keys exist', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });

    // Insert an orphan admin API key (user_id IS NULL, not revoked)
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('key-1', 'hash1', 'Orphan Key', 'admin', new Date().toISOString(), null);

    // Should not throw - orphan admin key counts as an admin
    userManager.deleteUser(admin.id);
    expect(userManager.getUserById(admin.id)).toBeNull();
  });

  it('does not count revoked orphan admin API keys', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });

    // Insert a revoked orphan admin API key
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('key-1', 'hash1', 'Revoked Key', 'admin', new Date().toISOString(), null, new Date().toISOString());

    expect(() => {
      userManager.deleteUser(admin.id);
    }).toThrow(/last admin/);
  });

  it('does not count non-admin orphan API keys', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });

    // Insert a non-admin orphan API key
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('key-1', 'hash1', 'Viewer Key', 'viewer', new Date().toISOString(), null);

    expect(() => {
      userManager.deleteUser(admin.id);
    }).toThrow(/last admin/);
  });

  it('does not count user-owned admin API keys', () => {
    const admin = userManager.createUser({ username: 'admin1', password: 'password123', role: 'admin' });

    // Insert an admin API key owned by a user (not orphan)
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('key-1', 'hash1', 'User Key', 'admin', new Date().toISOString(), 'some-user-id');

    expect(() => {
      userManager.deleteUser(admin.id);
    }).toThrow(/last admin/);
  });

  it('throws for nonexistent user', () => {
    expect(() => {
      userManager.deleteUser('nonexistent');
    }).toThrow(/not found/i);
  });

  it('allows deleting non-admin users freely', () => {
    const viewer = userManager.createUser({ username: 'viewer1', password: 'password123', role: 'viewer' });
    userManager.deleteUser(viewer.id);
    expect(userManager.getUserById(viewer.id)).toBeNull();
  });
});

describe('VALID_ROLES', () => {
  it('exports the valid roles array', () => {
    expect(userManager.VALID_ROLES).toEqual(['admin', 'manager', 'operator', 'viewer']);
  });
});
