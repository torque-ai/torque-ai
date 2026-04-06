'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const KEY_LENGTH_HEX = KEY_LENGTH_BYTES * 2;
const IV_LENGTH_BYTES = 16;

// NOTE: _cachedKey is stored as a hex string. JavaScript strings are immutable
// and not manually zeroable — the GC determines when the memory is freed.
// For stronger key hygiene, a Buffer could be used and zeroed on shutdown.
let _cachedKey = null;

/**
 * Resolve the directory for persisted TORQUE secrets.
 *
 * @returns {string} Secret storage directory path
 */
function resolveDataDir() {
  return require('../data-dir').getDataDir();
}

/**
 * Normalize and validate a supplied hex key.
 *
 * @param {string} key - Key material
 * @param {string} source - Human-readable source label for errors
 * @returns {string} Lower-cased trimmed hex key
 */
function normalizeKey(key, source) {
  const normalized = String(key || '').trim();
  if (normalized.length < KEY_LENGTH_HEX) {
    throw new Error(`Invalid ${source}: expected at least ${KEY_LENGTH_HEX} hex characters`);
  }

  const hexKey = normalized.slice(0, KEY_LENGTH_HEX);
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(`Invalid ${source}: expected a hex-encoded AES-256 key`);
  }

  return hexKey.toLowerCase();
}

/**
 * Load the key from env/file cache or create one if missing.
 *
 * Environment variable `TORQUE_SECRET_KEY` takes precedence, otherwise the key is
 * loaded from `${TORQUE_DATA_DIR}/secret.key` or generated lazily.
 *
 * @returns {string} 64-char hex encryption key
 */
function getOrCreateKey() {
  if (_cachedKey) {
    return _cachedKey;
  }

  const envKey = process.env.TORQUE_SECRET_KEY;
  if (envKey && envKey.trim().length >= KEY_LENGTH_HEX) {
    _cachedKey = normalizeKey(envKey, 'TORQUE_SECRET_KEY');
    return _cachedKey;
  }

  const dataDir = resolveDataDir();
  const keyPath = path.join(dataDir, 'secret.key');

  // TOCTOU note: existsSync + readFileSync is not atomic. If the key file is
  // deleted between the check and the read, readFileSync throws — which is
  // acceptable here because the caller (getOrCreateKey) does not swallow it.
  if (fs.existsSync(keyPath)) {
    _cachedKey = normalizeKey(fs.readFileSync(keyPath, 'utf8'), keyPath);
    try {
      const stat = fs.statSync(keyPath);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        console.error(`WARNING: ${keyPath} has overly permissive permissions (${(stat.mode & 0o777).toString(8)}). Should be 0600.`);
      }
    } catch { /* ignore */ }
    return _cachedKey;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const generatedKey = crypto.randomBytes(KEY_LENGTH_BYTES).toString('hex');

  try {
    fs.writeFileSync(keyPath, generatedKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(keyPath, process.platform === 'win32' ? 'r+' : 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    _cachedKey = generatedKey;
    return _cachedKey;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      _cachedKey = normalizeKey(fs.readFileSync(keyPath, 'utf8'), keyPath);
      return _cachedKey;
    }
    throw error;
  }
}

/**
 * Convert a hex key string into a cipher key buffer.
 *
 * @param {string} key - 64-char hex string
 * @returns {Buffer} AES-256 key buffer
 */
function keyBufferFromHex(key) {
  return Buffer.from(normalizeKey(key, 'encryption key'), 'hex');
}

/**
 * Encrypt a JSON-serializable payload using AES-256-GCM.
 *
 * @param {*} plaintextObj - Value to encrypt
 * @param {string} key - Encryption key hex string
 * @returns {{ encrypted_value: string, iv: string, auth_tag: string }} Encrypted payload fields
 */
function encrypt(plaintextObj, key) {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBufferFromHex(key), iv);
  const plaintext = JSON.stringify(plaintextObj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted_value: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    auth_tag: authTag.toString('hex'),
  };
}

/**
 * Decrypt AES-256-GCM encrypted payload fields.
 *
 * @param {string} encryptedValue - Hex ciphertext
 * @param {string} iv - Hex IV
 * @param {string} authTag - Hex auth tag
 * @param {string} key - Encryption key hex string
 * @returns {*} Parsed decrypted object
 */
function decrypt(encryptedValue, iv, authTag, key) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    keyBufferFromHex(key),
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'hex')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  getOrCreateKey,
  encrypt,
  decrypt,
};
