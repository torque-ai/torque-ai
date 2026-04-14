'use strict';

const credentialCrypto = require('../utils/credential-crypto');

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  return null;
}

function ensureManagedOAuthTables(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS auth_configs (
      id TEXT PRIMARY KEY,
      toolkit TEXT NOT NULL UNIQUE,
      auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2', 'api_key', 'basic', 'bearer')),
      client_id TEXT,
      client_secret_enc TEXT,
      authorize_url TEXT,
      token_url TEXT,
      scopes TEXT,
      redirect_uri TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connected_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      toolkit TEXT NOT NULL,
      auth_config_id TEXT NOT NULL REFERENCES auth_configs(id),
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked', 'expired')),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conn_accounts_user_toolkit
    ON connected_accounts(user_id, toolkit);

    CREATE INDEX IF NOT EXISTS idx_conn_accounts_status
    ON connected_accounts(status);
  `);
}

function encryptSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    return null;
  }

  const key = credentialCrypto.getOrCreateKey();
  return JSON.stringify(credentialCrypto.encrypt({ value: secret }, key));
}

function decryptSecret(encryptedSecret) {
  if (typeof encryptedSecret !== 'string' || encryptedSecret.trim().length === 0) {
    return null;
  }

  try {
    const payload = JSON.parse(encryptedSecret);
    const key = credentialCrypto.getOrCreateKey();
    const decrypted = credentialCrypto.decrypt(payload.encrypted_value, payload.iv, payload.auth_tag, key);
    return typeof decrypted?.value === 'string' ? decrypted.value : null;
  } catch {
    return null;
  }
}

function parseMetadata(metadataJson) {
  if (typeof metadataJson !== 'string' || metadataJson.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  resolveDbHandle,
  ensureManagedOAuthTables,
  encryptSecret,
  decryptSecret,
  parseMetadata,
};
