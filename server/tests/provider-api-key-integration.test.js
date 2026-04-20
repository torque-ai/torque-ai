'use strict';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const TEST_SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('provider API key management integration', () => {
  let db;
  let handleToolCall;
  let config;
  let originalSecretKey;

  beforeAll(() => {
    originalSecretKey = process.env.TORQUE_SECRET_KEY;
    process.env.TORQUE_SECRET_KEY = TEST_SECRET_KEY;

    ({ db, handleToolCall } = setupTestDb('provider-api-key-integration'));

    config = require('../config');
    config.init({ db });
  });

  afterAll(() => {
    teardownTestDb();
    if (originalSecretKey !== undefined) {
      process.env.TORQUE_SECRET_KEY = originalSecretKey;
    } else {
      delete process.env.TORQUE_SECRET_KEY;
    }
  });

  it('set_provider_api_key encrypts and stores key', async () => {
    const result = await handleToolCall('set_provider_api_key', {
      provider: 'groq',
      api_key: 'test-groq-key-12345',
    });
    const text = result?.content?.[0]?.text;
    expect(text).toBeTruthy();

    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('saved');
    expect(parsed.masked).toContain('<redacted>');
    expect(parsed.validating).toBe(true);

    const providerRow = db.getProvider('groq');
    expect(providerRow.api_key_encrypted).toBeTruthy();
    expect(providerRow.api_key_encrypted).not.toBe('test-groq-key-12345');
  });

  it('getApiKey resolves the encrypted key', () => {
    const origKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const key = config.getApiKey('groq');
      expect(key).toBe('test-groq-key-12345');
    } finally {
      if (origKey !== undefined) process.env.GROQ_API_KEY = origKey;
    }
  });

  it('clear_provider_api_key removes the key', async () => {
    const result = await handleToolCall('clear_provider_api_key', { provider: 'groq' });
    const text = result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('cleared');

    const origKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      expect(config.getApiKey('groq')).toBeNull();
    } finally {
      if (origKey !== undefined) process.env.GROQ_API_KEY = origKey;
    }
  });

  it('rejects empty api_key', async () => {
    const result = await handleToolCall('set_provider_api_key', { provider: 'groq', api_key: '' });
    expect(result?.isError).toBe(true);
  });

  it('rejects unknown provider', async () => {
    const result = await handleToolCall('set_provider_api_key', {
      provider: 'nonexistent',
      api_key: 'key',
    });
    expect(result?.isError || result?.content?.[0]?.text?.includes('not found')).toBeTruthy();
  });
});
