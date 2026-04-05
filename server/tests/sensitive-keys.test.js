'use strict';

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  SENSITIVE_KEY_PATTERNS,
  SENSITIVE_KEY_NAMES,
  isSensitiveKey,
  redactValue,
  redactConfigObject,
} = require('../utils/sensitive-keys');

describe('sensitive-keys helpers', () => {
  it('isSensitiveKey returns true for explicit names', () => {
    expect(SENSITIVE_KEY_NAMES.has('anthropic_api_key')).toBe(true);
    expect(SENSITIVE_KEY_NAMES.has('api_key')).toBe(true);
    expect(isSensitiveKey('anthropic_api_key')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
  });

  it('isSensitiveKey returns true for pattern matches', () => {
    expect(SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test('my_custom_api_key'))).toBe(true);
    expect(SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test('db_password'))).toBe(true);
    expect(SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test('auth_token'))).toBe(true);
    expect(isSensitiveKey('my_custom_api_key')).toBe(true);
    expect(isSensitiveKey('db_password')).toBe(true);
    expect(isSensitiveKey('auth_token')).toBe(true);
  });

  it('isSensitiveKey returns false for non-sensitive keys and nullish inputs', () => {
    expect(isSensitiveKey('provider_name')).toBe(false);
    expect(isSensitiveKey('max_concurrent')).toBe(false);
    expect(isSensitiveKey(null)).toBe(false);
    expect(isSensitiveKey(undefined)).toBe(false);
  });

  it('redactValue shows first and last four chars for long values and fully redacts short or falsy values', () => {
    expect(redactValue('abcdefghijklmnop')).toBe('abcd...<redacted>...mnop');
    expect(redactValue('short-value')).toBe('<redacted>');
    expect(redactValue('')).toBe('<redacted>');
    expect(redactValue(null)).toBe('<redacted>');
    expect(redactValue(undefined)).toBe('<redacted>');
  });

  it('redactConfigObject redacts sensitive keys only and preserves non-sensitive values', () => {
    const config = {
      anthropic_api_key: 'abcdefghijklmnop',
      auth_server_secret: 'short-value',
      provider_name: 'anthropic',
      max_concurrent: 3,
      enabled: true,
    };

    const result = redactConfigObject(config);

    expect(result).not.toBe(config);
    expect(result).toEqual({
      anthropic_api_key: 'abcd...<redacted>...mnop',
      auth_server_secret: '<redacted>',
      provider_name: 'anthropic',
      max_concurrent: 3,
      enabled: true,
    });
    expect(config.anthropic_api_key).toBe('abcdefghijklmnop');
    expect(config.auth_server_secret).toBe('short-value');
  });
});
