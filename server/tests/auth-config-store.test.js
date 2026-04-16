'use strict';

const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const { createAuthConfigStore } = require('../auth/auth-config-store');

const testCrypto = {
  encrypt(value) {
    return `enc:${value}`;
  },
  decrypt(value) {
    return value && value.startsWith('enc:') ? value.slice(4) : value;
  },
};

describe('authConfigStore', () => {
  let dbModule;
  let db;
  let store;

  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('auth-config-store'));
  });

  beforeEach(() => {
    resetTables('auth_configs');
    db = dbModule.getDbInstance();
    store = createAuthConfigStore({ db, crypto: testCrypto });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('upsert + get', () => {
    store.upsert({
      toolkit: 'github',
      auth_type: 'oauth2',
      client_id: 'cid',
      authorize_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      scopes: 'repo user',
    });

    const config = store.getByToolkit('github');
    expect(config.auth_type).toBe('oauth2');
    expect(config.scopes).toBe('repo user');
  });

  it('upsert replaces on same toolkit', () => {
    store.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'v1' });
    store.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'v2' });

    expect(store.getByToolkit('github').client_id).toBe('v2');
  });

  it('decrypts stored client secrets on read', () => {
    const id = store.upsert({
      toolkit: 'github',
      auth_type: 'oauth2',
      client_id: 'cid',
      client_secret: 'super-secret',
    });

    expect(id).toMatch(/^ac_/);
    expect(store.getByToolkit('github').client_secret).toBe('super-secret');
  });

  it('rejects invalid config input before hitting sqlite constraints', () => {
    expect(() => store.upsert({ toolkit: '   ', auth_type: 'oauth2' })).toThrow('toolkit is required');
    expect(() => store.upsert({ toolkit: 'github', auth_type: 'saml' })).toThrow(
      'auth_type must be one of: oauth2, api_key, basic, bearer',
    );
    expect(() => store.upsert({
      toolkit: 'github',
      auth_type: 'oauth2',
      client_id: { bad: true },
    })).toThrow('client_id must be a string');
  });
});
