const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = require.resolve('../utils/credential-crypto');

const originalDataDir = process.env.TORQUE_DATA_DIR;
const originalSecretKey = process.env.TORQUE_SECRET_KEY;

let testDir = null;

function loadCredentialCrypto() {
  delete require.cache[MODULE_PATH];
  return require('../utils/credential-crypto');
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-credential-crypto-'));
  process.env.TORQUE_DATA_DIR = testDir;
  delete process.env.TORQUE_SECRET_KEY;
  delete require.cache[MODULE_PATH];
  // On Windows, fsyncSync on certain temp-dir paths fails with EPERM.
  // Mock it to a no-op since fsync is a durability hint, not a correctness
  // requirement for tests. closeSync is mocked for symmetry.
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
  vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[MODULE_PATH];

  if (testDir) {
    fs.rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }

  if (originalDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = originalDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }

  if (originalSecretKey !== undefined) {
    process.env.TORQUE_SECRET_KEY = originalSecretKey;
  } else {
    delete process.env.TORQUE_SECRET_KEY;
  }
});

describe('credential-crypto utility', () => {
  it('encrypts and decrypts a round-trip', () => {
    const { getOrCreateKey, encrypt, decrypt } = loadCredentialCrypto();
    const key = getOrCreateKey();
    const plaintext = { user: 'testuser', key_path: '~/.ssh/id_rsa', port: 22 };

    const encrypted = encrypt(plaintext, key);

    expect(encrypted.encrypted_value).not.toContain('testuser');
    expect(decrypt(encrypted.encrypted_value, encrypted.iv, encrypted.auth_tag, key)).toEqual(plaintext);
  });

  it('rejects decryption with wrong key', () => {
    const { getOrCreateKey, encrypt, decrypt } = loadCredentialCrypto();
    const key = getOrCreateKey();
    const encrypted = encrypt({ user: 'testuser', port: 22 }, key);
    const wrongKey = crypto.randomBytes(32).toString('hex');

    expect(() => decrypt(encrypted.encrypted_value, encrypted.iv, encrypted.auth_tag, wrongKey)).toThrow();
  });

  it('detects tampered ciphertext', () => {
    const { getOrCreateKey, encrypt, decrypt } = loadCredentialCrypto();
    const key = getOrCreateKey();
    const encrypted = encrypt({ user: 'testuser', port: 22 }, key);
    const tamperedPrefix = encrypted.encrypted_value.startsWith('00') ? 'ff' : '00';
    const tamperedCiphertext = tamperedPrefix + encrypted.encrypted_value.slice(2);

    expect(() => decrypt(tamperedCiphertext, encrypted.iv, encrypted.auth_tag, key)).toThrow();
  });

  it('auto-generates key file when none exists', () => {
    const { getOrCreateKey } = loadCredentialCrypto();
    const key = getOrCreateKey();
    const keyPath = path.join(testDir, 'secret.key');

    expect(key).toHaveLength(64);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(key);
  });

  it('reads key from TORQUE_SECRET_KEY env var', () => {
    const envKey = crypto.randomBytes(32).toString('hex');
    process.env.TORQUE_SECRET_KEY = envKey;

    const { getOrCreateKey } = loadCredentialCrypto();

    expect(getOrCreateKey()).toBe(envKey);
  });

  it('reuses existing key file on subsequent calls', () => {
    const firstKey = loadCredentialCrypto().getOrCreateKey();
    const secondKey = loadCredentialCrypto().getOrCreateKey();

    expect(secondKey).toBe(firstKey);
  });
});
