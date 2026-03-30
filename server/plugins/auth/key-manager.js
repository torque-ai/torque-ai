'use strict';

const crypto = require('crypto');

function createKeyManager({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createKeyManager requires a db object with prepare()');
  }

  let cachedServerSecret = null;
  let supportsUsersTable = null;

  function hasUsersTable() {
    if (supportsUsersTable !== null) {
      return supportsUsersTable;
    }

    const row = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    ).get();
    supportsUsersTable = Boolean(row);
    return supportsUsersTable;
  }

  function getServerSecret() {
    if (cachedServerSecret) {
      return cachedServerSecret;
    }

    const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auth_server_secret');
    if (row && row.value) {
      cachedServerSecret = row.value;
      return cachedServerSecret;
    }

    const secret = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('auth_server_secret', secret);
    cachedServerSecret = secret;
    return cachedServerSecret;
  }

  function hashKey(key) {
    return crypto.createHmac('sha256', getServerSecret()).update(String(key)).digest('hex');
  }

  function createKey({ name, role = 'admin', userId = null } = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required');
    }

    const id = crypto.randomUUID();
    const key = `torque_sk_${crypto.randomBytes(18).toString('hex')}`;
    const keyHash = hashKey(key);
    const createdAt = new Date().toISOString();

    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, keyHash, name, role, createdAt, userId);

    return { id, key, name, role, userId };
  }

  function validateKey(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
      return null;
    }

    const keyHash = hashKey(plaintext);
    const row = db.prepare(
      'SELECT id, name, role, last_used_at, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
    ).get(keyHash);
    if (!row) {
      return null;
    }

    const now = new Date();
    const lastUsed = row.last_used_at ? new Date(row.last_used_at) : null;
    if (!lastUsed || now.getTime() - lastUsed.getTime() >= 60000) {
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    }

    let effectiveRole = row.role;
    if (row.user_id && hasUsersTable()) {
      const userRow = db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id);
      if (userRow && userRow.role) {
        effectiveRole = userRow.role;
      }
    }

    return {
      id: row.id,
      name: row.name,
      role: effectiveRole,
      type: 'api_key',
      userId: row.user_id || null,
    };
  }

  function revokeKey(id) {
    const key = db.prepare('SELECT id, role, revoked_at FROM api_keys WHERE id = ?').get(id);
    if (!key) {
      throw new Error('Key not found');
    }
    if (key.revoked_at) {
      throw new Error('Key already revoked');
    }

    if (key.role === 'admin') {
      const { count } = db.prepare(
        "SELECT COUNT(*) AS count FROM api_keys WHERE role = 'admin' AND revoked_at IS NULL AND user_id IS NULL AND id != ?"
      ).get(id);

      let adminUsers = 0;
      if (hasUsersTable()) {
        const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
        adminUsers = row ? row.count : 0;
      }

      if (count + adminUsers === 0) {
        throw new Error('Cannot revoke the last admin key');
      }
    }

    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  function listKeys() {
    return db.prepare(
      'SELECT id, name, role, created_at, last_used_at, revoked_at, user_id FROM api_keys ORDER BY created_at DESC'
    ).all();
  }

  function listKeysByUser(userId) {
    return db.prepare(
      'SELECT id, name, role, created_at, last_used_at, revoked_at, user_id FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
  }

  function hasAnyKeys() {
    const row = db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE revoked_at IS NULL').get();
    return row.count > 0;
  }

  function migrateConfigApiKey() {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get();
    if (existing.count > 0) {
      return null;
    }

    const configRow = db.prepare('SELECT value FROM config WHERE key = ?').get('api_key');
    if (!configRow || !configRow.value) {
      return null;
    }

    const id = crypto.randomUUID();
    const keyHash = hashKey(configRow.value);
    const createdAt = new Date().toISOString();

    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, keyHash, 'Migrated Legacy Key', 'admin', createdAt);

    db.prepare("DELETE FROM config WHERE key = 'api_key'").run();
    return id;
  }

  return {
    createKey,
    validateKey,
    revokeKey,
    listKeys,
    listKeysByUser,
    hasAnyKeys,
    migrateConfigApiKey,
    hashKey,
    getServerSecret,
  };
}

module.exports = { createKeyManager };
