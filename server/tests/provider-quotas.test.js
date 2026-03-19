'use strict';

const { createQuotaStore } = require('../db/provider-quotas');

describe('provider-quotas', () => {
  let store;

  beforeEach(() => {
    store = createQuotaStore();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('updateFromHeaders', () => {
    it('parses groq-style headers with relative reset durations', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '25',
        'x-ratelimit-reset-requests': '6s',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '5200',
        'x-ratelimit-reset-tokens': '1m30s',
      });

      const quota = store.getQuota('groq');

      expect(quota).not.toBeNull();
      expect(quota.limits.rpm).toEqual({
        limit: 30,
        remaining: 25,
        resetsAt: '2026-03-19T12:00:06.000Z',
      });
      expect(quota.limits.tpm).toEqual({
        limit: 6000,
        remaining: 5200,
        resetsAt: '2026-03-19T12:01:30.000Z',
      });
      expect(quota.source).toBe('headers');
    });

    it('parses cerebras-style headers with ISO resets', () => {
      const resetTime = '2026-03-19T12:05:00.000Z';

      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '200',
        'x-ratelimit-remaining-requests': '142',
        'x-ratelimit-reset-requests': resetTime,
      });

      const quota = store.getQuota('cerebras');

      expect(quota.limits.rpm).toEqual({
        limit: 200,
        remaining: 142,
        resetsAt: resetTime,
      });
    });

    it('parses openrouter-style headers with epoch resets', () => {
      store.updateFromHeaders('openrouter', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '88',
        'x-ratelimit-reset': '1773921960',
      });

      const quota = store.getQuota('openrouter');

      expect(quota.limits.rpm).toEqual({
        limit: 100,
        remaining: 88,
        resetsAt: '2026-03-19T12:06:00.000Z',
      });
    });

    it('last-write-wins when the same limit is updated again', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '10',
      });
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '22',
      });

      expect(store.getQuota('groq').limits.rpm.remaining).toBe(22);
    });

    it('preserves existing limit fields when a later update omits them', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '20',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '5000',
      });
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '19',
      });

      const quota = store.getQuota('groq');

      expect(quota.limits.rpm.remaining).toBe(19);
      expect(quota.limits.tpm).toEqual({
        limit: 6000,
        remaining: 5000,
      });
    });
  });

  describe('status computation', () => {
    it('marks green when all remaining percentages are above 50', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '80',
      });

      expect(store.getQuota('cerebras').status).toBe('green');
    });

    it('marks yellow when remaining is exactly 50 percent', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
      });

      expect(store.getQuota('cerebras').status).toBe('yellow');
    });

    it('marks yellow when remaining is exactly 10 percent', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '10',
      });

      expect(store.getQuota('cerebras').status).toBe('yellow');
    });

    it('marks red when any remaining percentage is below 10', () => {
      store.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '9',
      });

      expect(store.getQuota('cerebras').status).toBe('red');
    });
  });

  describe('updateFromInference', () => {
    it('tracks inferred limits and status for headerless providers', () => {
      store.updateFromInference(
        'google-ai',
        { tasksLastHour: 4, tokensLastHour: 100 },
        { rpm: 10, tpd: 5000 },
      );

      expect(store.getQuota('google-ai')).toMatchObject({
        provider: 'google-ai',
        source: 'inference',
        status: 'green',
        limits: {
          rpm: { limit: 10, remaining: 6 },
          daily: { limit: 5000, remaining: 2600 },
        },
      });
    });
  });

  describe('accessors', () => {
    it('returns null for unknown providers', () => {
      expect(store.getQuota('missing')).toBeNull();
    });

    it('returns all known quotas', () => {
      store.updateFromHeaders('groq', { 'x-ratelimit-remaining-requests': '10' });
      store.updateFromHeaders('cerebras', { 'x-ratelimit-remaining-requests': '20' });

      expect(Object.keys(store.getAllQuotas()).sort()).toEqual(['cerebras', 'groq']);
    });
  });

  describe('record429', () => {
    it('sets provider status to red', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '5',
      });

      store.record429('groq');

      expect(store.getQuota('groq').status).toBe('red');
    });
  });

  describe('isExhausted', () => {
    it('returns false when no quota data exists', () => {
      expect(store.isExhausted('groq')).toBe(false);
    });

    it('returns true when any tracked limit has zero remaining', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '0',
      });

      expect(store.isExhausted('groq')).toBe(true);
    });

    it('returns false when all tracked limits still have quota remaining', () => {
      store.updateFromHeaders('groq', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '5',
      });

      expect(store.isExhausted('groq')).toBe(false);
    });
  });

  describe('getQuotaStore', () => {
    it('returns the same singleton instance on repeated calls', () => {
      vi.resetModules();

      const quotaModule = require('../db/provider-quotas');
      const first = quotaModule.getQuotaStore();

      first.updateFromHeaders('groq', { 'x-ratelimit-remaining-requests': '12' });

      const second = quotaModule.getQuotaStore();

      expect(second).toBe(first);
      expect(second.getQuota('groq').limits.rpm.remaining).toBe(12);
    });
  });
});
