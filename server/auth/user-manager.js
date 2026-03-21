'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const VALID_ROLES = ['admin', 'manager', 'operator', 'viewer'];
const BCRYPT_ROUNDS = 12;
const USERNAME_PATTERN = /^[a-z0-9_-]{3,64}$/;

let _db = null;

/**
 * Initialize the user manager with a database reference.
 * @param {object} db - The database object with prepare() for raw SQL
 */
function init(db) {
  _db = db;
}

/**
 * Normalize and validate a username.
 * Trims whitespace, lowercases, and validates against the allowed pattern.
 * @param {string} username - Raw username input
 * @returns {string} Normalized username
 * @throws {Error} If username is invalid
 */
function normalizeUsername(username) {
  if (!username || typeof username !== 'string') {
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

/**
 * Validate password input meets requirements.
 * @param {string} password - Raw password input
 * @throws {Error} If password is invalid
 */
function validatePasswordInput(password) {
  if (!password || typeof password !== 'string' || password.trim().length === 0) {
    throw new Error('Password is required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (password.length > 72) {
    throw new Error('Password must be at most 72 characters');
  }
}

/**
 * Validate that a role is one of the allowed values.
 * @param {string} role - Role to validate
 * @throws {Error} If role is invalid
 */
function validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  }
}

/**
 * Create a new user with a hashed password.
 * @param {object} options
 * @param {string} options.username - Username (will be normalized)
 * @param {string} options.password - Plaintext password (8-72 chars)
 * @param {string} [options.role='viewer'] - User role
 * @param {string|null} [options.displayName=null] - Display name
 * @returns {{ id: string, username: string, role: string, displayName: string|null }}
 */
function createUser({ username, password, role = 'viewer', displayName = null } = {}) {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');

  const normalized = normalizeUsername(username);
  validatePasswordInput(password);
  validateRole(role);

  // Check for duplicate username
  const existing = _db.prepare('SELECT id FROM users WHERE username = ?').get(normalized);
  if (existing) {
    throw new Error(`Username "${normalized}" already exists`);
  }

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();

  _db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, normalized, passwordHash, displayName, role, now);

  return { id, username: normalized, role, displayName };
}

/**
 * Validate a username/password combination.
 * Returns an identity object on success, null on failure.
 * Updates last_login_at on successful validation.
 * @param {string} username - Username (case-insensitive)
 * @param {string} password - Plaintext password
 * @returns {{ id: string, name: string, username: string, role: string, type: 'user' } | null}
 */
function validatePassword(username, password) {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');
  if (!username || typeof username !== 'string') return null;
  if (!password || typeof password !== 'string') return null;

  let normalized;
  try {
    normalized = normalizeUsername(username);
  } catch {
    return null;
  }

  const row = _db.prepare(
    'SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?'
  ).get(normalized);

  if (!row) return null;

  const match = bcrypt.compareSync(password, row.password_hash);
  if (!match) return null;

  // Update last_login_at
  const now = new Date().toISOString();
  _db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);

  return {
    id: row.id,
    name: row.display_name || row.username,
    username: row.username,
    role: row.role,
    type: 'user',
  };
}

/**
 * Check if any users exist in the database.
 * @returns {boolean}
 */
function hasAnyUsers() {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');
  const row = _db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row.count > 0;
}

/**
 * Get a user by ID. Never returns password_hash.
 * @param {string} id - User ID
 * @returns {{ id: string, username: string, displayName: string|null, role: string, created_at: string, updated_at: string|null, last_login_at: string|null } | null}
 */
function getUserById(id) {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');
  const row = _db.prepare(
    'SELECT id, username, display_name, role, created_at, updated_at, last_login_at FROM users WHERE id = ?'
  ).get(id);
  if (!row) return null;
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

/**
 * List all users. Never returns password_hash.
 * @returns {Array<{ id: string, username: string, displayName: string|null, role: string, created_at: string, updated_at: string|null, last_login_at: string|null }>}
 */
function listUsers() {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');
  const rows = _db.prepare(
    'SELECT id, username, display_name, role, created_at, updated_at, last_login_at FROM users ORDER BY created_at'
  ).all();
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  }));
}

/**
 * Update a user's profile.
 * @param {string} id - User ID
 * @param {object} updates
 * @param {string} [updates.role] - New role
 * @param {string} [updates.displayName] - New display name
 * @param {string} [updates.password] - New password (will be hashed)
 */
function updateUser(id, { role, displayName, password } = {}) {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');

  const existing = _db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) throw new Error('User not found');

  const sets = [];
  const params = [];

  if (role !== undefined) {
    validateRole(role);
    sets.push('role = ?');
    params.push(role);
  }

  if (displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(displayName);
  }

  if (password !== undefined) {
    validatePasswordInput(password);
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    sets.push('password_hash = ?');
    params.push(passwordHash);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  _db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Delete a user by ID.
 * Prevents deleting the last admin (counts admin users + orphan admin API keys).
 * @param {string} id - User ID
 */
function deleteUser(id) {
  if (!_db) throw new Error('user-manager not initialized — call init(db) first');

  const user = _db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  if (user.role === 'admin') {
    // Count other admin users
    const { count: otherAdminUsers } = _db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE role = ? AND id != ?'
    ).get('admin', id);

    // Count orphan admin API keys (not tied to a user, not revoked)
    const { count: orphanAdminKeys } = _db.prepare(
      'SELECT COUNT(*) as count FROM api_keys WHERE role = ? AND user_id IS NULL AND revoked_at IS NULL'
    ).get('admin');

    if (otherAdminUsers + orphanAdminKeys === 0) {
      throw new Error('Cannot delete the last admin');
    }
  }

  _db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/**
 * Reset internal state. For testing only.
 */
function _resetForTest() {
  _db = null;
}

module.exports = {
  VALID_ROLES,
  init,
  normalizeUsername,
  validatePasswordInput,
  validateRole,
  createUser,
  validatePassword,
  hasAnyUsers,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  _resetForTest,
};
