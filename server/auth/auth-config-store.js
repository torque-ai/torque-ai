'use strict';

const { randomUUID } = require('crypto');
const {
  resolveDbHandle,
  ensureManagedOAuthTables,
  encryptSecret,
  decryptSecret,
} = require('./store-utils');

function normalizeAuthConfigRow(row, crypto) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    client_secret: crypto && typeof crypto.decrypt === 'function'
      ? crypto.decrypt(row.client_secret_enc)
      : decryptSecret(row.client_secret_enc),
  };
}

function createAuthConfigStore({ db, crypto = null }) {
  const dbHandle = resolveDbHandle(db);
  if (!dbHandle) {
    throw new Error('Managed OAuth requires a database handle');
  }

  ensureManagedOAuthTables(dbHandle);

  return {
    upsert({
      toolkit,
      auth_type,
      client_id,
      client_secret,
      authorize_url,
      token_url,
      scopes,
      redirect_uri,
    }) {
      const normalizedToolkit = String(toolkit || '').trim();
      const now = Date.now();
      const existing = dbHandle.prepare('SELECT id, created_at FROM auth_configs WHERE toolkit = ?').get(normalizedToolkit);
      const id = existing?.id || `ac_${randomUUID().slice(0, 12)}`;
      const createdAt = existing?.created_at || now;

      dbHandle.prepare(`
        INSERT INTO auth_configs (
          id,
          toolkit,
          auth_type,
          client_id,
          client_secret_enc,
          authorize_url,
          token_url,
          scopes,
          redirect_uri,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(toolkit) DO UPDATE SET
          auth_type = excluded.auth_type,
          client_id = excluded.client_id,
          client_secret_enc = excluded.client_secret_enc,
          authorize_url = excluded.authorize_url,
          token_url = excluded.token_url,
          scopes = excluded.scopes,
          redirect_uri = excluded.redirect_uri
      `).run(
        id,
        normalizedToolkit,
        auth_type,
        client_id || null,
        typeof client_secret === 'string' && client_secret.length > 0
          ? (crypto && typeof crypto.encrypt === 'function'
            ? crypto.encrypt(client_secret)
            : encryptSecret(client_secret))
          : null,
        authorize_url || null,
        token_url || null,
        scopes || null,
        redirect_uri || null,
        createdAt,
      );

      return id;
    },

    getByToolkit(toolkit) {
      const row = dbHandle.prepare('SELECT * FROM auth_configs WHERE toolkit = ?').get(String(toolkit || '').trim());
      return normalizeAuthConfigRow(row, crypto);
    },

    list() {
      return dbHandle
        .prepare('SELECT * FROM auth_configs ORDER BY toolkit')
        .all()
        .map((row) => normalizeAuthConfigRow(row, crypto));
    },
  };
}

module.exports = { createAuthConfigStore };
