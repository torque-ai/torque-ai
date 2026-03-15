const {
  setupTestDb,
  teardownTestDb,
} = require('./vitest-setup');

let db;
let hostCreds;

beforeAll(() => {
  const env = setupTestDb('host-credentials');
  db = env.db;
  hostCreds = require('../db/host-management');
  db.registerPeekHost('test-omen', 'http://192.168.1.100:9876', null, true, 'windows');
});

afterAll(() => {
  teardownTestDb();
});

describe('host-credentials', () => {
  it('exports expected functions', () => {
    expect(typeof hostCreds.saveCredential).toBe('function');
    expect(typeof hostCreds.getCredential).toBe('function');
    expect(typeof hostCreds.listCredentials).toBe('function');
    expect(typeof hostCreds.deleteCredential).toBe('function');
    expect(typeof hostCreds.deleteAllHostCredentials).toBe('function');
    expect(typeof db.saveCredential).toBe('function');
    expect(typeof db.getCredential).toBe('function');
    expect(typeof db.listCredentials).toBe('function');
    expect(typeof db.deleteCredential).toBe('function');
  });

  it('saves and retrieves a credential', () => {
    hostCreds.saveCredential('test-omen', 'peek', 'ssh', 'SSH for Omen', {
      user: 'testuser',
      key_path: '~/.ssh/id_rsa',
      port: 22,
    });
    const cred = hostCreds.getCredential('test-omen', 'peek', 'ssh');

    expect(cred).not.toBeNull();
    expect(cred.user).toBe('testuser');
    expect(cred.key_path).toBe('~/.ssh/id_rsa');
    expect(cred.port).toBe(22);
  });

  it('upserts on duplicate', () => {
    hostCreds.saveCredential('test-omen', 'peek', 'ssh', 'Updated SSH', {
      user: 'admin',
      key_path: '/keys/id',
      port: 2222,
    });
    const cred = hostCreds.getCredential('test-omen', 'peek', 'ssh');

    expect(cred.user).toBe('admin');
    expect(cred.port).toBe(2222);
  });

  it('listCredentials returns metadata only', () => {
    hostCreds.saveCredential('test-omen', 'peek', 'http_auth', 'API token', {
      scheme: 'bearer',
      token: 'secret-xyz',
    });
    const list = hostCreds.listCredentials('test-omen', 'peek');

    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const item of list) {
      expect(item).toHaveProperty('credential_type');
      expect(item).toHaveProperty('label');
      expect(item).not.toHaveProperty('user');
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('password');
    }
  });

  it('deletes a credential', () => {
    hostCreds.saveCredential('test-omen', 'peek', 'windows', 'Win creds', {
      username: 'admin',
      password: 'pass',
      domain: '',
    });
    const deleted = hostCreds.deleteCredential('test-omen', 'peek', 'windows');

    expect(deleted).toBe(true);
    const cred = hostCreds.getCredential('test-omen', 'peek', 'windows');
    expect(cred).toBeNull();
  });

  it('returns null for nonexistent credential', () => {
    const cred = hostCreds.getCredential('nonexistent', 'peek', 'ssh');

    expect(cred).toBeNull();
  });

  it('handles multiple credential types per host', () => {
    hostCreds.saveCredential('test-omen', 'peek', 'ssh', 'SSH', {
      user: 'a',
      key_path: '/b',
      port: 22,
    });
    hostCreds.saveCredential('test-omen', 'peek', 'http_auth', 'HTTP', {
      scheme: 'bearer',
      token: 'tok',
    });
    hostCreds.saveCredential('test-omen', 'peek', 'windows', 'Win', {
      username: 'u',
      password: 'p',
      domain: '',
    });
    const list = hostCreds.listCredentials('test-omen', 'peek');
    const types = list.map((c) => c.credential_type).sort();

    expect(types).toEqual(['http_auth', 'ssh', 'windows']);
  });
});
