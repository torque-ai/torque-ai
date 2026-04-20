import { describe, test, expect } from 'vitest';
const { PreflightError, isPreflightError } = require('../execution/preflight-error');

describe('PreflightError', () => {
  test('exposes code, deterministic, and retryable fields', () => {
    const err = new PreflightError('working directory missing', {
      code: 'WORKING_DIR_MISSING',
      deterministic: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.name).toBe('PreflightError');
    expect(err.message).toBe('working directory missing');
    expect(err.code).toBe('WORKING_DIR_MISSING');
    expect(err.deterministic).toBe(true);
    expect(err.retryable).toBe(false);
  });

  test('defaults retryable based on deterministic=false', () => {
    const err = new PreflightError('transient failure', {
      code: 'TRANSIENT_FS',
      deterministic: false,
    });
    expect(err.retryable).toBe(true);
  });

  test('isPreflightError recognises our error and rejects others', () => {
    expect(isPreflightError(new PreflightError('x', { code: 'A', deterministic: true }))).toBe(true);
    expect(isPreflightError(new Error('plain'))).toBe(false);
    expect(isPreflightError(null)).toBe(false);
    expect(isPreflightError(undefined)).toBe(false);
    expect(isPreflightError('not an error')).toBe(false);
  });

  test('preserves cause chain when passed', () => {
    const cause = new Error('ENOENT');
    cause.code = 'ENOENT';
    const err = new PreflightError('wd missing', {
      code: 'WORKING_DIR_MISSING',
      deterministic: true,
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});
