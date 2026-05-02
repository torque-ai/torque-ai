import { describe, it, expect } from 'vitest';

const { normalizeTestName, verifySignature } = require('../factory/verify-signature');

describe('verifySignature', () => {
  it('returns the same signature for identical vitest failures in different orders', () => {
    const a = `
 FAIL foo.test.ts > rejects null
 FAIL foo.test.ts > handles empty array
`;
    const b = `
 FAIL foo.test.ts > handles empty array
 FAIL foo.test.ts > rejects null
`;
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('normalizes equivalent absolute and relative test-name paths', () => {
    const a = 'FAIL C:\\repo\\server\\tests\\foo.test.js > rejects null';
    const b = 'FAIL C:/repo/server/tests/foo.test.js > rejects null';
    const c = 'FAIL /repo/server/tests/foo.test.js > rejects null';
    expect(normalizeTestName('C:\\repo\\server\\tests\\foo.test.js > rejects null')).toBe(
      normalizeTestName('/repo/server/tests/foo.test.js > rejects null'),
    );
    expect(normalizeTestName('C:/repo/server/tests/foo.test.js > rejects null')).toBe(
      normalizeTestName('/repo/server/tests/foo.test.js > rejects null'),
    );
    expect(verifySignature(a)).toBe(verifySignature(b));
    expect(verifySignature(b)).toBe(verifySignature(c));
  });

  it('preserves relative path context while normalizing separators', () => {
    const a = 'FAIL server\\tests\\foo.test.js > rejects null';
    const b = 'FAIL server/tests/foo.test.js > rejects null';
    expect(normalizeTestName('server\\tests\\foo.test.js > rejects null')).toBe(
      'server/tests/foo.test.js > rejects null',
    );
    expect(normalizeTestName('server\\tests\\foo.test.js > rejects null')).toBe(
      normalizeTestName('server/tests/foo.test.js > rejects null'),
    );
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('ignores timestamps and absolute paths in test names', () => {
    const a = ' FAIL C:/path/to/foo.test.ts > rejects null  (15:00:01.123)';
    const b = ' FAIL /other/abs/path/foo.test.ts > rejects null  (16:22:44.901)';
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('returns different signatures for disjoint failure sets', () => {
    const a = ' FAIL foo.test.ts > A';
    const b = ' FAIL bar.test.ts > B';
    expect(verifySignature(a)).not.toBe(verifySignature(b));
  });

  it('returns a signature for jest-style FAIL lines', () => {
    const a = 'FAIL  tests/x.test.js\n  should do thing (15ms)';
    const sig = verifySignature(a);
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });

  it('falls back to normalized stderr tail when no test markers are present', () => {
    const a = 'arbitrary error at 2026-04-20T12:00Z in C:/tmp/proc/123/file.ts';
    const b = 'arbitrary error at 2026-04-21T13:00Z in C:/tmp/proc/456/file.ts';
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('returns empty string for empty input', () => {
    expect(verifySignature('')).toBe('');
    expect(verifySignature(null)).toBe('');
  });
});
