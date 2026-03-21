'use strict';
const crypto = require('crypto');

let _db = null;
let _serverSecret = null;

/**
 * Initialize the key manager with a database reference.
 * The db object must support prepare() for raw SQL and
 * getConfig()/setConfig() via the config table.
 * @param {object} db - The database module (or object with prepare/getConfig/setConfig)
 */
function init(db) {
  _db = db;
  _serverSecret = null;
}

/**
 * Get or generate the server-wide HMAC secret.
 * Reads `auth_server_secret` from the config table.
 * If missing, generates a 256-bit random hex string, stores it, and returns it.
 * The value is cached in-process after first retrieval.
 * @returns {string} 64-character hex string (256-bit secret)
 */
function getServerSecret() {
  if (_serverSecret) return _serverSecret;
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');

  // Try reading from config table
  const row = _db.prepare('SELECT value FROM config WHERE key = ?').get('auth_server_secret');
  if (row && row.value) {
    _serverSecret = row.value;
    return _serverSecret;
  }

  // Generate a new 256-bit secret
  const secret = crypto.randomBytes(32).toString('hex');
  _db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('auth_server_secret', secret);
  _serverSecret = secret;
  return _serverSecret;
}

/**
 * Hash a plaintext API key using HMAC-SHA-256 with the server secret.
 * @param {string} plaintext - The raw API key
 * @returns {string} Hex-encoded HMAC hash
 */
function hashKey(plaintext) {
  return crypto.createHmac('sha256', getServerSecret()).update(plaintext).digest('hex');
}

/**
 * Create a new API key.
 * @param {object} options
 * @param {string} options.name - Human-readable name for the key
 * @param {string} [options.role='admin'] - Role assigned to this key
 * @param {string|null} [options.userId=null] - Optional owning user ID
 * @returns {{ id: string, key: string, name: string, role: string, userId: string|null }}
 */
function createKey({ name, role = 'admin', userId = null } = {}) {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');
  if (!name) throw new Error('name is required');

  const id = crypto.randomUUID();
  const plaintext = `torque_sk_${crypto.randomUUID()}`;
  const keyHash = hashKey(plaintext);
  const now = new Date().toISOString();

  _db.prepare(
    'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, keyHash, name, role, now, userId);

  return { id, key: plaintext, name, role, userId };
}

/**
 * Validate a plaintext API key.
 * Returns the key identity if valid and not revoked, or null.
 * For user-owned keys, the user's current role is used (key's own role is ignored).
 * Updates last_used_at at most once per minute.
 * @param {string} plaintext - The raw API key to validate
 * @returns {{ id: string, name: string, role: string, type: 'api_key', userId: string|null } | null}
 */
function validateKey(plaintext) {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');
  if (!plaintext || typeof plaintext !== 'string') return null;

  const keyHash = hashKey(plaintext);
  const row = _db.prepare(
    'SELECT id, name, role, last_used_at, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(keyHash);

  if (!row) return null;

  // Update last_used_at at most once per minute
  const now = new Date();
  const lastUsed = row.last_used_at ? new Date(row.last_used_at) : null;
  if (!lastUsed || (now.getTime() - lastUsed.getTime()) >= 60000) {
    _db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }

  let effectiveRole = row.role;
  let userId = row.user_id || null;

  if (row.user_id) {
    try {
      const userManager = require('./user-manager');
      const user = userManager.getUserById(row.user_id);
      if (!user) return null; // User deleted but cascade missed
      effectiveRole = user.role;
    } catch {}
  }

  return { id: row.id, name: row.name, role: effectiveRole, type: 'api_key', userId };
}

/**
 * Revoke an API key by ID.
 * Prevents revoking the last admin key (throws Error).
 * @param {string} id - The key ID to revoke
 */
function revokeKey(id) {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');

  // Check if this key exists and is an admin key
  const key = _db.prepare('SELECT id, role, revoked_at FROM api_keys WHERE id = ?').get(id);
  if (!key) throw new Error('Key not found');
  if (key.revoked_at) throw new Error('Key already revoked');

  if (key.role === 'admin') {
    // Count remaining active orphan admin keys (no user_id) excluding this one
    const { count: otherAdminKeys } = _db.prepare(
      "SELECT COUNT(*) as count FROM api_keys WHERE role = 'admin' AND revoked_at IS NULL AND id != ? AND user_id IS NULL"
    ).get(id);

    let adminUsers = 0;
    try {
      const userManager = require('./user-manager');
      adminUsers = _db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    } catch {}

    if (otherAdminKeys + adminUsers === 0) {
      throw new Error('Cannot revoke the last admin key — at least one admin user or orphan admin key must remain');
    }
  }

  _db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/**
 * List all API keys (active and revoked).
 * NEVER returns key_hash for security.
 * @returns {Array<{ id: string, name: string, role: string, created_at: string, last_used_at: string|null, revoked_at: string|null, user_id: string|null }>}
 */
function listKeys() {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');
  return _db.prepare(
    'SELECT id, name, role, created_at, last_used_at, revoked_at, user_id FROM api_keys ORDER BY created_at DESC'
  ).all();
}

/**
 * List API keys belonging to a specific user.
 * NEVER returns key_hash for security.
 * @param {string} userId - The user ID to filter by
 * @returns {Array<{ id: string, name: string, role: string, created_at: string, last_used_at: string|null, revoked_at: string|null, user_id: string }>}
 */
function listKeysByUser(userId) {
  if (!_db) throw new Error('key-manager not initialized');
  return _db.prepare(
    'SELECT id, name, role, created_at, last_used_at, revoked_at, user_id FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

/**
 * Check if any non-revoked API keys exist.
 * @returns {boolean}
 */
function hasAnyKeys() {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');
  const row = _db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE revoked_at IS NULL').get();
  return row.count > 0;
}

/**
 * Migrate the legacy config.api_key to the new api_keys table.
 * If config.api_key has a value and api_keys is empty, hashes the existing key
 * and inserts it as an admin key. Clears config.api_key afterward.
 * @returns {string|null} The migrated key's ID, or null if no migration needed
 */
function migrateConfigApiKey() {
  if (!_db) throw new Error('key-manager not initialized — call init(db) first');

  // Check if api_keys table is empty
  const existing = _db.prepare('SELECT COUNT(*) as count FROM api_keys').get();
  if (existing.count > 0) return null;

  // Check if config.api_key has a value
  const configRow = _db.prepare('SELECT value FROM config WHERE key = ?').get('api_key');
  if (!configRow || !configRow.value) return null;

  const legacyKey = configRow.value;
  const id = crypto.randomUUID();
  const keyHash = hashKey(legacyKey);
  const now = new Date().toISOString();

  _db.prepare(
    'INSERT INTO api_keys (id, key_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, keyHash, 'Migrated Legacy Key', 'admin', now);

  // Clear the legacy config key
  _db.prepare('DELETE FROM config WHERE key = ?').run('api_key');

  return id;
}

/**
 * Reset internal state. For testing only.
 */
function _resetForTest() {
  _db = null;
  _serverSecret = null;
}

module.exports = {
  init,
  getServerSecret,
  hashKey,
  createKey,
  validateKey,
  revokeKey,
  listKeys,
  listKeysByUser,
  hasAnyKeys,
  migrateConfigApiKey,
  _resetForTest,
};
