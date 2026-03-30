'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const VALID_ROLES = ['viewer', 'operator', 'manager', 'admin'];
const BCRYPT_ROUNDS = 10;
const USERNAME_PATTERN = /^[a-z0-9_-]{3,64}$/;

function normalizeUsername(username) {
  if (typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }

  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error(
      'Username must be 3-64 characters and contain only lowercase letters, numbers, hyphens, and underscores'
    );
  }

  return normalized;
}

function validatePasswordInput(password) {
  if (typeof password !== 'string' || password.trim().length === 0) {
    throw new Error('Password is required');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  if (password.length > 72) {
    throw new Error('Password must be at most 72 characters');
  }
}

function validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  }
}

function toUserRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

function createUserManager({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createUserManager requires a valid database handle');
  }

  function createUser({ username, password, role = 'viewer', displayName = null } = {}) {
    const normalized = normalizeUsername(username);
    validatePasswordInput(password);
    validateRole(role);

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalized);
    if (existing) {
      throw new Error(`Username "${normalized}" already exists`);
    }

    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const createdAt = new Date().toISOString();

    db.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)'
    ).run(id, normalized, passwordHash, displayName, role, createdAt);

    return {
      id,
      username: normalized,
      role,
      displayName,
    };
  }

  function validatePassword(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') {
      return null;
    }

    let normalized;
    try {
      normalized = normalizeUsername(username);
    } catch {
      return null;
    }

    const row = db.prepare(
      'SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?'
    ).get(normalized);

    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return null;
    }

    const lastLoginAt = new Date().toISOString();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(lastLoginAt, row.id);

    return {
      id: row.id,
      name: row.display_name || row.username,
      username: row.username,
      role: row.role,
      type: 'user',
    };
  }

  function hasAnyUsers() {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
    return row.count > 0;
  }

  function getUserById(id) {
    const row = db.prepare(
      'SELECT id, username, display_name, role, created_at, updated_at, last_login_at FROM users WHERE id = ?'
    ).get(id);

    return toUserRecord(row);
  }

  function listUsers() {
    const rows = db.prepare(
      'SELECT id, username, display_name, role, created_at, updated_at, last_login_at FROM users ORDER BY created_at ASC'
    ).all();

    return rows.map(toUserRecord);
  }

  function updateUser(id, { role, displayName, password } = {}) {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('User not found');
    }

    const updates = [];
    const params = [];

    if (role !== undefined) {
      validateRole(role);
      updates.push('role = ?');
      params.push(role);
    }

    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(displayName);
    }

    if (password !== undefined) {
      validatePasswordInput(password);
      updates.push('password_hash = ?');
      params.push(bcrypt.hashSync(password, BCRYPT_ROUNDS));
    }

    if (updates.length === 0) {
      return getUserById(id);
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString(), id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return getUserById(id);
  }

  function deleteUser(id) {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.role === 'admin') {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?")
        .get(id);

      if (row.count === 0) {
        throw new Error('Cannot delete the last admin');
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return true;
  }

  return {
    createUser,
    validatePassword,
    hasAnyUsers,
    getUserById,
    listUsers,
    updateUser,
    deleteUser,
    normalizeUsername,
    validateRole,
    VALID_ROLES,
  };
}

module.exports = {
  createUserManager,
  normalizeUsername,
  validateRole,
  VALID_ROLES,
};
