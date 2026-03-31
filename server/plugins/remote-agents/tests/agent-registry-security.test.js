'use strict';

describe('agent-registry secret hashing', () => {
  it('hashSecret produces a scrypt-prefixed hash', () => {
    const { hashSecret } = require('../agent-registry');
    const hash = hashSecret('my-secret');
    expect(hash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(hash).not.toContain('my-secret');
  });

  it('verifySecret correctly verifies a hashed secret', () => {
    const { hashSecret, verifySecret } = require('../agent-registry');
    const hash = hashSecret('test-password');
    expect(verifySecret(hash, 'test-password')).toBe(true);
    expect(verifySecret(hash, 'wrong-password')).toBe(false);
  });

  it('verifySecret handles backward-compatible plaintext secrets', () => {
    const { verifySecret } = require('../agent-registry');
    expect(verifySecret('plaintext-secret', 'plaintext-secret')).toBe(true);
    expect(verifySecret('plaintext-secret', 'wrong')).toBe(false);
  });

  it('different calls to hashSecret produce different hashes (unique salt)', () => {
    const { hashSecret } = require('../agent-registry');
    const h1 = hashSecret('same-secret');
    const h2 = hashSecret('same-secret');
    expect(h1).not.toBe(h2); // different salts
  });
});
