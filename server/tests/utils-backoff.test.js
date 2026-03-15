'use strict';

const {
  failoverBackoffMs,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
  factorial
} = require('../utils/backoff');

describe('utils/backoff', () => {
  describe('factorial', () => {
    it('returns 1 for 0!', () => {
      expect(factorial(0)).toBe(1);
    });

    it('returns 1 for 1!', () => {
      expect(factorial(1)).toBe(1);
    });

    it('returns 120 for 5!', () => {
      expect(factorial(5)).toBe(120);
    });

    it('handles a larger valid integer input', () => {
      expect(factorial(10)).toBe(3628800);
    });

    it('throws for negative numbers', () => {
      expect(() => factorial(-1)).toThrow('factorial expects a non-negative integer');
      expect(() => factorial(-5)).toThrow('factorial expects a non-negative integer');
    });

    it('throws for non-integer edge cases', () => {
      expect(() => factorial(1.5)).toThrow('factorial expects a non-negative integer');
      expect(() => factorial(NaN)).toThrow('factorial expects a non-negative integer');
      expect(() => factorial(Infinity)).toThrow('factorial expects a non-negative integer');
    });
  });

  describe('failoverBackoffMs', () => {
    it('uses the base delay for attempt 0', () => {
      expect(failoverBackoffMs(0)).toBe(BASE_BACKOFF_MS);
    });

    it('uses the base delay for attempt 1', () => {
      expect(failoverBackoffMs(1)).toBe(BASE_BACKOFF_MS);
    });

    it('scales linearly for attempts 2 and higher', () => {
      expect(failoverBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
      expect(failoverBackoffMs(3)).toBe(BASE_BACKOFF_MS * 3);
    });

    it('increases with each attempt until the cap is reached', () => {
      const first = failoverBackoffMs(1);
      const second = failoverBackoffMs(2);
      const third = failoverBackoffMs(3);

      expect(first).toBeLessThan(second);
      expect(second).toBeLessThan(third);
    });

    it('caps the delay at MAX_BACKOFF_MS', () => {
      const cappedAttempt = Math.ceil(MAX_BACKOFF_MS / BASE_BACKOFF_MS);

      expect(failoverBackoffMs(cappedAttempt)).toBe(MAX_BACKOFF_MS);
      expect(failoverBackoffMs(cappedAttempt + 20)).toBe(MAX_BACKOFF_MS);
    });
  });

  describe('exports', () => {
    it('exports numeric backoff constants', () => {
      expect(BASE_BACKOFF_MS).toBe(5000);
      expect(MAX_BACKOFF_MS).toBe(60000);
      expect(typeof BASE_BACKOFF_MS).toBe('number');
      expect(typeof MAX_BACKOFF_MS).toBe('number');
    });
  });
});
