const fs = require('fs');

const {
  setupTestDbOnly,
  teardownTestDb,
} = require('./vitest-setup');

let db;
let hostCreds;

beforeAll(() => {
  // On Windows, fs.fsyncSync on certain temp-dir paths fails with EPERM.
  // Mock it to a no-op since fsync is a durability hint used by getOrCreateKey().
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
  vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

  const env = setupTestDbOnly('host-credentials');
  db = env.db;
  hostCreds = require('../db/host-management');
  db.registerPeekHost('test-omen', 'http://192.0.2.100:9876', null, true, 'windows');
});

afterAll(() => {
  vi.restoreAllMocks();
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

  it('listCredentials redacts sensitive fields even when rows contain them', () => {
    const hostName = 'test-omen-unsafe';
    const originalPrepare = db.prepare;
    const unsafeRows = [{
      id: 'unsafe-id',
      host_name: hostName,
      host_type: 'peek',
      credential_type: 'ssh',
      label: 'Unsafe credentials',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      encrypted_value: 'ciphertext',
      iv: 'iv-bytes',
      auth_tag: 'auth-tag',
      value: {
        token: 'unsafe-token',
        password: 'unsafe-password',
      },
      token: 'unsafe-token',
      password: 'unsafe-password',
      secret: 'unsafe-secret',
      username: 'unsafe-user',
      user: 'unsafe-user',
      key_path: '/unsafe/key',
      private_key: 'unsafe-private-key',
    }];

    const unsafePrepare = vi.spyOn(db, 'prepare').mockImplementation((query) => {
      if (typeof query === 'string' && query.includes('SELECT * FROM host_credentials WHERE host_name = ? AND host_type = ?')) {
        return {
          all: () => unsafeRows,
        };
      }

      return originalPrepare(query);
    });

    try {
      const list = hostCreds.listCredentials(hostName, 'peek');

      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        id: 'unsafe-id',
        host_name: hostName,
        host_type: 'peek',
        credential_type: 'ssh',
        label: 'Unsafe credentials',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });

      for (const field of [
        'encrypted_value',
        'iv',
        'auth_tag',
        'value',
        'token',
        'password',
        'secret',
        'username',
        'user',
        'key_path',
        'private_key',
      ]) {
        expect(list[0]).not.toHaveProperty(field);
      }
    } finally {
      unsafePrepare.mockRestore();
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
