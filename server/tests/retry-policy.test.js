'use strict';

const { computeBackoff, shouldRetry } = require('../activities/retry-policy');

describe('computeBackoff', () => {
  it('returns 0 for the first attempt', () => {
    expect(computeBackoff({ attempt: 1, initial_ms: 100 })).toBe(0);
  });

  it('exponential: doubles each attempt up to max', () => {
    const policy = { initial_ms: 100, max_ms: 10000, multiplier: 2 };

    expect(computeBackoff({ attempt: 2, ...policy })).toBe(100);
    expect(computeBackoff({ attempt: 3, ...policy })).toBe(200);
    expect(computeBackoff({ attempt: 4, ...policy })).toBe(400);
    expect(computeBackoff({ attempt: 10, ...policy })).toBe(10000);
  });

  it('fixed: same backoff every attempt', () => {
    expect(computeBackoff({ attempt: 5, initial_ms: 250, multiplier: 1 })).toBe(250);
  });
});

describe('shouldRetry', () => {
  it('returns true while attempt < max_attempts and error is retriable', () => {
    expect(shouldRetry({ attempt: 1, max_attempts: 3, error: { retriable: true } })).toBe(true);
    expect(shouldRetry({ attempt: 3, max_attempts: 3, error: { retriable: true } })).toBe(false);
  });

  it('returns false when error is non-retriable regardless of attempts', () => {
    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { retriable: false, name: 'ValidationError' } })).toBe(false);
  });

  it('non_retryable_errors list short-circuits', () => {
    const policy = { non_retryable_errors: ['ValidationError', 'AuthError'] };

    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { name: 'ValidationError' }, policy })).toBe(false);
    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { name: 'NetworkError' }, policy })).toBe(true);
  });
});
