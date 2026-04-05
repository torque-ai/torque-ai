import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  createUserManager,
  normalizeUsername,
  validateRole,
  VALID_ROLES,
} = require('../plugins/auth/user-manager.js');

const USERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    display_name TEXT,
    role TEXT,
    created_at TEXT,
    updated_at TEXT,
    last_login_at TEXT
  );
`;

describe('server/plugins/auth/user-manager', () => {
  let dbModule;
  let dbHandle;
  let manager;

  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('user-manager'));
    dbHandle = dbModule.getDbInstance();
    dbHandle.exec(USERS_TABLE_SQL);
    manager = createUserManager({ db: dbHandle });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('createUserManager throws without db', () => {
    expect(() => createUserManager()).toThrow('createUserManager requires a valid database handle');
  });

  it('createUser creates a user with a hashed password', () => {
    const created = manager.createUser({
      username: '  Admin_User  ',
      password: 'password123',
      role: 'admin',
      displayName: 'Admin User',
    });

    const row = dbHandle.prepare('SELECT * FROM users WHERE id = ?').get(created.id);

    expect(created).toEqual({
      id: expect.any(String),
      username: 'admin_user',
      role: 'admin',
      displayName: 'Admin User',
    });
    expect(row.username).toBe('admin_user');
    expect(row.display_name).toBe('Admin User');
    expect(row.password_hash).not.toBe('password123');
    expect(bcrypt.compareSync('password123', row.password_hash)).toBe(true);
    expect(row.created_at).toEqual(expect.any(String));
    expect(row.updated_at).toBeNull();
    expect(row.last_login_at).toBeNull();
  });

  it('createUser rejects duplicate usernames after normalization', () => {
    manager.createUser({
      username: 'Alice',
      password: 'password123',
      role: 'viewer',
    });

    expect(() =>
      manager.createUser({
        username: '  alice  ',
        password: 'password456',
        role: 'operator',
      })
    ).toThrow('Username "alice" already exists');

    const countRow = dbHandle.prepare('SELECT COUNT(*) AS count FROM users').get();
    expect(countRow.count).toBe(1);
  });

  it('createUser rejects invalid username format', () => {
    expect(() =>
      manager.createUser({
        username: 'bad name',
        password: 'password123',
      })
    ).toThrow(
      'Username must be 3-64 characters and contain only lowercase letters, numbers, hyphens, and underscores'
    );
  });

  it('createUser rejects passwords shorter than 8 characters', () => {
    expect(() =>
      manager.createUser({
        username: 'alice',
        password: 'short',
      })
    ).toThrow('Password must be at least 8 characters');
  });

  it('validatePassword returns user info for the correct password', () => {
    const created = manager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'manager',
      displayName: 'Alice Example',
    });

    const validated = manager.validatePassword('  ALICE  ', 'password123');
    const row = dbHandle.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);

    expect(validated).toEqual({
      id: created.id,
      name: 'Alice Example',
      username: 'alice',
      role: 'manager',
      type: 'user',
    });
    expect(row.last_login_at).toEqual(expect.any(String));
  });

  it('validatePassword returns null for the wrong password', () => {
    const created = manager.createUser({
      username: 'alice',
      password: 'password123',
      displayName: 'Alice Example',
    });

    const validated = manager.validatePassword('alice', 'wrong-password');
    const row = dbHandle.prepare('SELECT last_login_at FROM users WHERE id = ?').get(created.id);

    expect(validated).toBeNull();
    expect(row.last_login_at).toBeNull();
  });

  it('hasAnyUsers returns false before creation and true after creating a user', () => {
    expect(manager.hasAnyUsers()).toBe(false);

    manager.createUser({
      username: 'alice',
      password: 'password123',
    });

    expect(manager.hasAnyUsers()).toBe(true);
  });

  it('getUserById returns the stored user record', () => {
    const created = manager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'operator',
      displayName: 'Alice Example',
    });

    expect(manager.getUserById(created.id)).toEqual({
      id: created.id,
      username: 'alice',
      displayName: 'Alice Example',
      role: 'operator',
      created_at: expect.any(String),
      updated_at: null,
      last_login_at: null,
    });
  });

  it('updateUser updates role and displayName', () => {
    const created = manager.createUser({
      username: 'alice',
      password: 'password123',
      role: 'viewer',
      displayName: 'Old Name',
    });

    const updated = manager.updateUser(created.id, {
      role: 'manager',
      displayName: 'New Name',
    });

    expect(updated).toEqual({
      id: created.id,
      username: 'alice',
      displayName: 'New Name',
      role: 'manager',
      created_at: expect.any(String),
      updated_at: expect.any(String),
      last_login_at: null,
    });
  });

  it('deleteUser removes a user record', () => {
    const created = manager.createUser({
      username: 'alice',
      password: 'password123',
      displayName: 'Alice Example',
    });

    expect(manager.listUsers()).toHaveLength(1);
    expect(manager.deleteUser(created.id)).toBe(true);
    expect(manager.getUserById(created.id)).toBeNull();
    expect(manager.listUsers()).toEqual([]);
    expect(manager.hasAnyUsers()).toBe(false);
  });

  it('deleteUser prevents deleting the last admin', () => {
    const admin = manager.createUser({
      username: 'admin',
      password: 'password123',
      role: 'admin',
      displayName: 'Admin User',
    });

    expect(() => manager.deleteUser(admin.id)).toThrow('Cannot delete the last admin');
    expect(manager.getUserById(admin.id)).not.toBeNull();
  });

  it('normalizeUsername trims and lowercases the username', () => {
    expect(normalizeUsername('  Mixed_CASE-User  ')).toBe('mixed_case-user');
  });

  it('validateRole throws for an invalid role', () => {
    expect(VALID_ROLES).toEqual(['viewer', 'operator', 'manager', 'admin']);
    expect(() => validateRole('owner')).toThrow(
      'Invalid role: owner. Must be one of: viewer, operator, manager, admin'
    );
  });
});
