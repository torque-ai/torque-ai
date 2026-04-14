'use strict';

const { randomUUID } = require('crypto');
const {
  resolveDbHandle,
  ensureManagedOAuthTables,
  encryptSecret,
  decryptSecret,
  parseMetadata,
} = require('./store-utils');

function normalizeSafeRow(row) {
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    user_id: row.user_id,
    toolkit: row.toolkit,
    auth_config_id: row.auth_config_id,
    expires_at: row.expires_at,
    status: row.status,
    metadata: parseMetadata(row.metadata_json),
    has_refresh_token: Boolean(row.refresh_token_enc),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeDecryptedRow(row, crypto) {
  if (!row) {
    return undefined;
  }

  return {
    ...normalizeSafeRow(row),
    access_token: crypto && typeof crypto.decrypt === 'function'
      ? crypto.decrypt(row.access_token_enc)
      : decryptSecret(row.access_token_enc),
    refresh_token: crypto && typeof crypto.decrypt === 'function'
      ? crypto.decrypt(row.refresh_token_enc)
      : decryptSecret(row.refresh_token_enc),
  };
}

function createConnectedAccountStore({ db, crypto = null }) {
  const dbHandle = resolveDbHandle(db);
  if (!dbHandle) {
    throw new Error('Managed OAuth requires a database handle');
  }

  ensureManagedOAuthTables(dbHandle);

  return {
    create({ user_id, toolkit, auth_config_id, access_token, refresh_token, expires_at, metadata = {} }) {
      const id = `ca_${randomUUID().slice(0, 12)}`;
      const now = Date.now();

      dbHandle.prepare(`
        INSERT INTO connected_accounts (
          id,
          user_id,
          toolkit,
          auth_config_id,
          access_token_enc,
          refresh_token_enc,
          expires_at,
          status,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        id,
        String(user_id || '').trim(),
        String(toolkit || '').trim(),
        auth_config_id,
        typeof access_token === 'string' && access_token.length > 0
          ? (crypto && typeof crypto.encrypt === 'function'
            ? crypto.encrypt(access_token)
            : encryptSecret(access_token))
          : null,
        typeof refresh_token === 'string' && refresh_token.length > 0
          ? (crypto && typeof crypto.encrypt === 'function'
            ? crypto.encrypt(refresh_token)
            : encryptSecret(refresh_token))
          : null,
        expires_at || null,
        JSON.stringify(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        now,
        now,
      );

      return id;
    },

    get(id) {
      const row = dbHandle.prepare('SELECT * FROM connected_accounts WHERE id = ?').get(id);
      return normalizeDecryptedRow(row, crypto);
    },

    list({ user_id, toolkit } = {}) {
      const filters = ['user_id = ?'];
      const params = [String(user_id || '').trim()];

      if (toolkit) {
        filters.push('toolkit = ?');
        params.push(String(toolkit).trim());
      }

      return dbHandle.prepare(`
        SELECT *
        FROM connected_accounts
        WHERE ${filters.join(' AND ')}
        ORDER BY updated_at DESC, rowid DESC
      `).all(...params).map(normalizeSafeRow);
    },

    findActive({ user_id, toolkit }) {
      const row = dbHandle.prepare(`
        SELECT *
        FROM connected_accounts
        WHERE user_id = ?
          AND toolkit = ?
          AND status = 'active'
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 1
      `).get(String(user_id || '').trim(), String(toolkit || '').trim());

      return normalizeDecryptedRow(row, crypto);
    },

    disable(id) {
      const result = dbHandle.prepare(`
        UPDATE connected_accounts
        SET status = 'disabled', updated_at = ?
        WHERE id = ?
      `).run(Date.now(), id);

      return result.changes > 0;
    },

    delete(id) {
      const result = dbHandle.prepare('DELETE FROM connected_accounts WHERE id = ?').run(id);
      return result.changes > 0;
    },
  };
}

module.exports = { createConnectedAccountStore };
