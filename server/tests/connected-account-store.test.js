'use strict';

const { beforeAll, beforeEach, afterAll, describe, it, expect } = require('vitest');
const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const { createAuthConfigStore } = require('../auth/auth-config-store');
const { createConnectedAccountStore } = require('../auth/connected-account-store');

const testCrypto = {
  encrypt(value) {
    return `enc:${value}`;
  },
  decrypt(value) {
    return value && value.startsWith('enc:') ? value.slice(4) : value;
  },
};

describe('connectedAccountStore', () => {
  let dbModule;
  let db;
  let configs;
  let accounts;

  beforeAll(() => {
    ({ db: dbModule } = setupTestDbOnly('connected-account-store'));
  });

  beforeEach(() => {
    resetTables(['connected_accounts', 'auth_configs']);
    db = dbModule.getDbInstance();
    configs = createAuthConfigStore({ db, crypto: testCrypto });
    configs.upsert({ toolkit: 'github', auth_type: 'oauth2', client_id: 'cid' });
    accounts = createConnectedAccountStore({ db, crypto: testCrypto });
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('create + find by user + toolkit', () => {
    const config = configs.getByToolkit('github');
    accounts.create({
      user_id: 'alice',
      toolkit: 'github',
      auth_config_id: config.id,
      access_token: 'tok1',
      expires_at: Date.now() + 3600e3,
    });

    const account = accounts.findActive({ user_id: 'alice', toolkit: 'github' });
    expect(account.status).toBe('active');
    expect(account.access_token).toBe('tok1');
  });

  it('findActive returns most recent when multiple exist', () => {
    const config = configs.getByToolkit('github');
    accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: config.id, access_token: 'old' });
    accounts.create({ user_id: 'alice', toolkit: 'github', auth_config_id: config.id, access_token: 'new' });

    expect(accounts.findActive({ user_id: 'alice', toolkit: 'github' }).access_token).toBe('new');
  });

  it('disable flips status without deleting tokens', () => {
    const config = configs.getByToolkit('github');
    const id = accounts.create({
      user_id: 'alice',
      toolkit: 'github',
      auth_config_id: config.id,
      access_token: 'tok',
    });

    accounts.disable(id);

    expect(accounts.findActive({ user_id: 'alice', toolkit: 'github' })).toBeUndefined();
    expect(accounts.get(id).status).toBe('disabled');
    expect(accounts.get(id).access_token).toBe('tok');
  });

  it('delete removes the row', () => {
    const config = configs.getByToolkit('github');
    const id = accounts.create({
      user_id: 'alice',
      toolkit: 'github',
      auth_config_id: config.id,
      access_token: 'tok',
    });

    accounts.delete(id);

    expect(accounts.get(id)).toBeUndefined();
  });
});
