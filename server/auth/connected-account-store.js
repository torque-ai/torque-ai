'use strict';

const { randomUUID } = require('crypto');
const {
  resolveDbHandle,
  ensureManagedOAuthTables,
  encryptSecret,
  decryptSecret,
  parseMetadata,
  normalizeRequiredString,
  normalizeRequiredSecret,
  normalizeOptionalSecret,
  normalizeOptionalTimestamp,
  normalizeMetadataObject,
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
      const normalizedUserId = normalizeRequiredString(user_id, 'user_id');
      const normalizedToolkit = normalizeRequiredString(toolkit, 'toolkit');
      const normalizedAuthConfigId = normalizeRequiredString(auth_config_id, 'auth_config_id');
      const normalizedAccessToken = normalizeRequiredSecret(access_token, 'access_token');
      const normalizedRefreshToken = normalizeOptionalSecret(refresh_token, 'refresh_token');
      const normalizedExpiresAt = normalizeOptionalTimestamp(expires_at, 'expires_at');
      const normalizedMetadata = normalizeMetadataObject(metadata);
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
        normalizedUserId,
        normalizedToolkit,
        normalizedAuthConfigId,
        normalizedAccessToken
          ? (crypto && typeof crypto.encrypt === 'function'
            ? crypto.encrypt(normalizedAccessToken)
            : encryptSecret(normalizedAccessToken))
          : null,
        normalizedRefreshToken
          ? (crypto && typeof crypto.encrypt === 'function'
            ? crypto.encrypt(normalizedRefreshToken)
            : encryptSecret(normalizedRefreshToken))
          : null,
        normalizedExpiresAt,
        JSON.stringify(normalizedMetadata),
        now,
        now,
      );

      return id;
    },

    get(id) {
      const row = dbHandle.prepare('SELECT * FROM connected_accounts WHERE id = ?').get(
        normalizeRequiredString(id, 'id'),
      );
      return normalizeDecryptedRow(row, crypto);
    },

    list({ user_id, toolkit } = {}) {
      const filters = ['user_id = ?'];
      const params = [normalizeRequiredString(user_id, 'user_id')];

      if (toolkit) {
        filters.push('toolkit = ?');
        params.push(normalizeRequiredString(toolkit, 'toolkit'));
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
      `).get(
        normalizeRequiredString(user_id, 'user_id'),
        normalizeRequiredString(toolkit, 'toolkit'),
      );

      return normalizeDecryptedRow(row, crypto);
    },

    disable(id) {
      const result = dbHandle.prepare(`
        UPDATE connected_accounts
        SET status = 'disabled', updated_at = ?
        WHERE id = ?
      `).run(Date.now(), normalizeRequiredString(id, 'id'));

      return result.changes > 0;
    },

    delete(id) {
      const result = dbHandle.prepare('DELETE FROM connected_accounts WHERE id = ?').run(
        normalizeRequiredString(id, 'id'),
      );
      return result.changes > 0;
    },
  };
}

module.exports = { createConnectedAccountStore };
