'use strict';

/**
 * Unit Tests: validation/output-safeguards.js — sanitizeOutputForCondition
 *
 * Tests the secret-redaction pipeline that sanitizes LLM output before
 * it reaches condition checks or user-facing surfaces.
 *
 * Covers:
 * 1. sanitizeOutputForCondition — secret redaction, ReDoS protection, edge cases
 * 2. SECRET_PATTERNS — pattern correctness and bounded matching
 * 3. MAX_SANITIZE_LENGTH — truncation behavior
 */

const {
  sanitizeOutputForCondition,
  truncateOptionalText,
  shouldSkipOutputSafeguards,
  SECRET_PATTERNS,
  MAX_SANITIZE_LENGTH,
} = require('../validation/output-safeguards');

// ─── sanitizeOutputForCondition ────────────────────────────────────────────

describe('sanitizeOutputForCondition', () => {
  describe('basic behavior', () => {
    it('returns empty string for non-string input', () => {
      expect(sanitizeOutputForCondition(null)).toBe('');
      expect(sanitizeOutputForCondition(undefined)).toBe('');
      expect(sanitizeOutputForCondition(42)).toBe('');
      expect(sanitizeOutputForCondition({})).toBe('');
      expect(sanitizeOutputForCondition([])).toBe('');
    });

    it('returns empty string for empty string input', () => {
      expect(sanitizeOutputForCondition('')).toBe('');
    });

    it('leaves clean text unchanged', () => {
      const text = 'This is a normal log message with no secrets.';
      expect(sanitizeOutputForCondition(text)).toBe(text);
    });

    it('preserves code that does not match secret patterns', () => {
      const code = `
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`.trim();
      expect(sanitizeOutputForCondition(code)).toBe(code);
    });

    it('preserves multiline output without secrets', () => {
      const output = [
        'Building project...',
        'Compiled 42 files in 1.2s',
        'All tests passed (15/15)',
        'Coverage: 87.3%',
      ].join('\n');
      expect(sanitizeOutputForCondition(output)).toBe(output);
    });
  });

  describe('API key redaction', () => {
    it('redacts api_key=value patterns', () => {
      const text = 'Using api_key=abcdefghijklmnopqrst1234 for auth';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abcdefghijklmnopqrst1234');
    });

    it('redacts api-key: value patterns', () => {
      const text = 'api-key: "sk-proj-abcdefghijklmnopqrst"';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('sk-proj-abcdefghijklmnopqrst');
    });

    it('redacts apikey with space separator', () => {
      const text = 'apikey abcdef01234567890123456789';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('secret value redaction', () => {
    it('redacts secret=value patterns', () => {
      const text = 'client secret=MyS3cr3tV4lu3Th4t1sL0ng';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('MyS3cr3tV4lu3Th4t1sL0ng');
    });

    it('redacts secret: "quoted" patterns', () => {
      const text = 'secret: "a1b2c3d4e5f6g7h8i9j0"';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('password redaction', () => {
    it('redacts password=value patterns', () => {
      const text = 'password=MyP@ssw0rd!';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('MyP@ssw0rd!');
    });

    it('redacts password: "quoted" patterns', () => {
      const text = 'password: "hunter2abc"';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('hunter2abc');
    });
  });

  describe('bearer token redaction', () => {
    it('redacts Bearer token in auth headers', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('redacts bearer token with lowercase', () => {
      const text = 'bearer abcdefghij-token_value.xyz';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('authorization header redaction', () => {
    it('redacts authorization=value with continuous token (10+ safe chars)', () => {
      // Pattern requires [\w\-_.=+/]{10,500} — no spaces allowed in value
      const text = 'authorization=dXNlcjpwYXNzd29yZA==';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('dXNlcjpwYXNzd29yZA==');
    });

    it('does not redact authorization with short value', () => {
      // Value under 10 chars should not match
      const text = 'authorization=abc';
      const result = sanitizeOutputForCondition(text);
      expect(result).not.toContain('[REDACTED]');
    });

    it('redacts authorization: quoted value', () => {
      const text = 'authorization: "Bearer_eyJhbGciOi.abc123"';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('generic token redaction', () => {
    it('redacts token=value patterns', () => {
      const text = 'refresh token=abcdefghijklmnopqrstuvwx';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abcdefghijklmnopqrstuvwx');
    });
  });

  describe('private key redaction', () => {
    it('redacts RSA private key headers', () => {
      const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    });

    it('redacts generic private key headers', () => {
      const text = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('-----BEGIN PRIVATE KEY-----');
    });
  });

  describe('AWS credential redaction', () => {
    it('redacts AWS access key patterns', () => {
      const text = 'aws_access_key=AKIAIOSFODNN7EXAMPLE';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('redacts AWS secret key patterns', () => {
      const text = 'aws-secret=wJalrXUtnFEMI_K7MDENG_bPxRfiCYEXAMPLEKEY';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('wJalrXUtnFEMI');
    });

    it('redacts AWS access-key with space separator', () => {
      const text = 'aws_access_key AKIAIOSFODNN7EXAMPLE';
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('multiple secrets in one output', () => {
    it('redacts all secret types in a single string', () => {
      const text = [
        'Config loaded:',
        '  api_key=sk-proj-abcdefghijklmnopqrst',
        '  password: "SuperSecret123"',
        '  token=ghp_abcdefghijklmnopqrstuvwxyz',
        '  aws_secret=AKIAIOSFODNN7EXAMPLEKEY',
      ].join('\n');
      const result = sanitizeOutputForCondition(text);
      expect(result).toContain('Config loaded:');
      // All secrets should be redacted
      expect(result).not.toContain('sk-proj-abcdefghijklmnopqrst');
      expect(result).not.toContain('SuperSecret123');
      expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLEKEY');
      // Count redaction markers
      const redactedCount = (result.match(/\[REDACTED\]/g) || []).length;
      expect(redactedCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe('short values not matched', () => {
    it('does not redact short api_key values (under min length)', () => {
      // API key pattern requires 20+ chars
      const text = 'api_key=short';
      const result = sanitizeOutputForCondition(text);
      expect(result).not.toContain('[REDACTED]');
      expect(result).toBe(text);
    });

    it('does not redact short password values (under 8 chars)', () => {
      const text = 'password=abc';
      const result = sanitizeOutputForCondition(text);
      expect(result).not.toContain('[REDACTED]');
    });

    it('does not redact short token values (under 20 chars)', () => {
      const text = 'token=abc123';
      const result = sanitizeOutputForCondition(text);
      expect(result).not.toContain('[REDACTED]');
    });
  });

  describe('ReDoS protection — truncation', () => {
    it('truncates input exceeding MAX_SANITIZE_LENGTH', () => {
      const longText = 'a'.repeat(MAX_SANITIZE_LENGTH + 1000);
      const result = sanitizeOutputForCondition(longText);
      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain('[OUTPUT TRUNCATED FOR SECURITY SCANNING]');
    });

    it('does not truncate input at exactly MAX_SANITIZE_LENGTH', () => {
      const exactText = 'x'.repeat(MAX_SANITIZE_LENGTH);
      const result = sanitizeOutputForCondition(exactText);
      expect(result).not.toContain('[OUTPUT TRUNCATED FOR SECURITY SCANNING]');
      expect(result).toBe(exactText);
    });

    it('does not truncate input shorter than MAX_SANITIZE_LENGTH', () => {
      const shortText = 'hello world';
      const result = sanitizeOutputForCondition(shortText);
      expect(result).toBe(shortText);
    });

    it('still redacts secrets in the non-truncated portion of long text', () => {
      const secret = 'api_key=abcdefghijklmnopqrstuvwxyz';
      const padding = 'x'.repeat(MAX_SANITIZE_LENGTH);
      const longText = secret + padding;
      const result = sanitizeOutputForCondition(longText);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz');
    });
  });
});

describe('truncateOptionalText', () => {
  it('returns empty string for null or non-string smoke-test output', () => {
    expect(truncateOptionalText(null, 500)).toBe('');
    expect(truncateOptionalText(undefined, 500)).toBe('');
    expect(truncateOptionalText({ error: 'boom' }, 500)).toBe('');
  });

  it('truncates string smoke-test output', () => {
    expect(truncateOptionalText('abcdef', 3)).toBe('abc');
  });
});

describe('shouldSkipOutputSafeguards', () => {
  it('skips non-mutating factory plan-generation tasks', () => {
    expect(shouldSkipOutputSafeguards({
      metadata: JSON.stringify({
        factory_internal: true,
        kind: 'plan_generation',
      }),
      tags: JSON.stringify(['factory:internal', 'factory:plan_generation']),
    })).toBe(true);
  });

  it('skips factory plan-review tasks that have no metadata kind', () => {
    expect(shouldSkipOutputSafeguards({
      metadata: JSON.stringify({
        factory_internal: true,
        factory_plan_review: true,
      }),
      tags: JSON.stringify(['factory:internal', 'factory:plan_review']),
    })).toBe(true);
  });

  it('does not skip factory execute tasks', () => {
    expect(shouldSkipOutputSafeguards({
      metadata: JSON.stringify({
        factory_internal: true,
        kind: 'execute',
      }),
      tags: JSON.stringify(['factory:internal']),
    })).toBe(false);
  });

  it('does not skip regular completed tasks', () => {
    expect(shouldSkipOutputSafeguards({
      metadata: '{}',
      tags: '[]',
    })).toBe(false);
  });
});

// ─── SECRET_PATTERNS ────────────────────────────────────────────────────────

describe('SECRET_PATTERNS', () => {
  it('contains 12 patterns', () => {
    expect(SECRET_PATTERNS).toHaveLength(12);
  });

  it('all patterns are RegExp instances with global flag', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.flags).toContain('g');
    }
  });

  it('patterns have bounded quantifiers (no unbounded .* or .+)', () => {
    for (const pattern of SECRET_PATTERNS) {
      const source = pattern.source;
      // Should not contain .* or .+ without bounded quantifiers nearby
      // This is a heuristic — presence of {n,m} or specific char classes is good
      // Absence of unqualified .* or .+ is what we check
      const unboundedDotStar = /\.\*(?!\?)/.test(source) && !/\{/.test(source);
      const unboundedDotPlus = /\.\+(?!\?)/.test(source) && !/\{/.test(source);
      expect(unboundedDotStar).toBe(false);
      expect(unboundedDotPlus).toBe(false);
    }
  });
});

// ─── MAX_SANITIZE_LENGTH ────────────────────────────────────────────────────

describe('MAX_SANITIZE_LENGTH', () => {
  it('is a positive number', () => {
    expect(typeof MAX_SANITIZE_LENGTH).toBe('number');
    expect(MAX_SANITIZE_LENGTH).toBeGreaterThan(0);
  });

  it('is set to 100KB (100000)', () => {
    expect(MAX_SANITIZE_LENGTH).toBe(100000);
  });
});
