'use strict';

describe('provider API key encryption helpers', () => {
  let encryptApiKey, decryptApiKey;

  beforeAll(() => {
    const handlers = require('../handlers/provider-crud-handlers');
    encryptApiKey = handlers.encryptApiKey;
    decryptApiKey = handlers.decryptApiKey;
  });

  it('round-trips a key through encrypt and decrypt', () => {
    const key = 'sk-test-abc123-very-secret-key';
    const encrypted = encryptApiKey(key);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toBe(key);
    expect(encrypted).toContain(':');
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(key);
  });

  it('produces different ciphertext for same input (random IV)', () => {
    const key = 'sk-test-same-key';
    const a = encryptApiKey(key);
    const b = encryptApiKey(key);
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe(key);
    expect(decryptApiKey(b)).toBe(key);
  });

  it('returns null for tampered ciphertext', () => {
    const encrypted = encryptApiKey('sk-test-tamper');
    const parts = encrypted.split(':');
    parts[2] = parts[2].slice(0, -2) + 'ff';
    const tampered = parts.join(':');
    expect(decryptApiKey(tampered)).toBeNull();
  });

  it('returns null for plaintext (no colon separator)', () => {
    expect(decryptApiKey('just-a-plaintext-key')).toBeNull();
  });

  it('returns null for empty or null input', () => {
    expect(decryptApiKey('')).toBeNull();
    expect(decryptApiKey(null)).toBeNull();
    expect(decryptApiKey(undefined)).toBeNull();
  });

  it('returns null for malformed packed value', () => {
    expect(decryptApiKey('part1:part2')).toBeNull();
    expect(decryptApiKey('a:b:c:d')).toBeNull();
  });
});

describe('config.js getApiKey() with encrypted keys', () => {
  const { setupTestDb, teardownTestDb } = require('./vitest-setup');
  let db;
  let config;
  let encryptApiKey;

  beforeAll(() => {
    ({ db } = setupTestDb('provider-api-key-config'));
    config = require('../config');
    config.init({ db });
    ({ encryptApiKey } = require('../handlers/provider-crud-handlers'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('resolves encrypted key from provider_config', () => {
    const encrypted = encryptApiKey('sk-from-db-encrypted');
    const rawDb = db.getDbInstance ? db.getDbInstance() : db.getDb ? db.getDb() : db;
    const now = new Date().toISOString();
    try {
      rawDb.prepare("INSERT OR IGNORE INTO provider_config (provider, enabled, max_concurrent, transport, created_at) VALUES ('test-enc-provider', 1, 3, 'api', ?)").run(now);
    } catch { /* may already exist */ }
    rawDb.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'test-enc-provider'").run(encrypted);

    const resolved = config.getApiKey('test-enc-provider');
    expect(resolved).toBe('sk-from-db-encrypted');
  });

  it('falls through when decryption fails', () => {
    const rawDb = db.getDbInstance ? db.getDbInstance() : db.getDb ? db.getDb() : db;
    const now = new Date().toISOString();
    try {
      rawDb.prepare("INSERT OR IGNORE INTO provider_config (provider, enabled, max_concurrent, transport, created_at) VALUES ('bad-enc-provider', 1, 3, 'api', ?)").run(now);
    } catch { /* may already exist */ }
    rawDb.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'bad-enc-provider'").run('not-encrypted');

    const resolved = config.getApiKey('bad-enc-provider');
    // Should not throw, falls through to config table (null)
    expect(resolved).toBeNull();
  });

  it('env var takes precedence over encrypted DB value', () => {
    const orig = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'env-groq-key';

    const encrypted = encryptApiKey('db-groq-key');
    const rawDb = db.getDbInstance ? db.getDbInstance() : db.getDb ? db.getDb() : db;
    rawDb.prepare("UPDATE provider_config SET api_key_encrypted = ? WHERE provider = 'groq'").run(encrypted);

    expect(config.getApiKey('groq')).toBe('env-groq-key');

    if (orig) process.env.GROQ_API_KEY = orig;
    else delete process.env.GROQ_API_KEY;
  });
});
