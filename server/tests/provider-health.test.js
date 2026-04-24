'use strict';

describe('Provider Health Scoring', () => {
  let mod;

  beforeAll(() => {
    // provider-routing.js exports functions directly, no DB needed for health scoring
    mod = require('../db/provider-routing-core');
  });

  beforeEach(() => {
    mod.resetProviderHealth();
  });

  afterEach(() => {
    mod.resetProviderHealth();
  });

  describe('recordProviderOutcome', () => {
    it('tracks successes', () => {
      mod.recordProviderOutcome('ollama', true);
      mod.recordProviderOutcome('ollama', true);
      const health = mod.getProviderHealth('ollama');
      expect(health.successes).toBe(2);
      expect(health.failures).toBe(0);
    });

    it('tracks failures', () => {
      mod.recordProviderOutcome('codex', false);
      mod.recordProviderOutcome('codex', false);
      mod.recordProviderOutcome('codex', true);
      const health = mod.getProviderHealth('codex');
      expect(health.successes).toBe(1);
      expect(health.failures).toBe(2);
    });
  });

  describe('getProviderHealth', () => {
    it('returns zero counts for unknown provider', () => {
      const health = mod.getProviderHealth('unknown-provider');
      expect(health.successes).toBe(0);
      expect(health.failures).toBe(0);
      expect(health.failureRate).toBe(0);
    });

    it('computes failure rate correctly', () => {
      mod.recordProviderOutcome('test-provider', true);
      mod.recordProviderOutcome('test-provider', true);
      mod.recordProviderOutcome('test-provider', false);
      const health = mod.getProviderHealth('test-provider');
      expect(health.failureRate).toBeCloseTo(1/3, 2);
    });
  });

  describe('isProviderHealthy', () => {
    it('returns true for unknown providers (default healthy)', () => {
      expect(mod.isProviderHealthy('new-provider')).toBe(true);
    });

    it('returns true with fewer than 3 observations', () => {
      mod.recordProviderOutcome('sparse', false);
      mod.recordProviderOutcome('sparse', false);
      // 2 observations, both failures, but < 3 minimum
      expect(mod.isProviderHealthy('sparse')).toBe(true);
    });

    it('returns true when failure rate below 30%', () => {
      mod.recordProviderOutcome('good', true);
      mod.recordProviderOutcome('good', true);
      mod.recordProviderOutcome('good', true);
      mod.recordProviderOutcome('good', false);
      // 25% failure rate, 4 observations
      expect(mod.isProviderHealthy('good')).toBe(true);
    });

    it('returns false when failure rate above 30%', () => {
      mod.recordProviderOutcome('bad', true);
      mod.recordProviderOutcome('bad', false);
      mod.recordProviderOutcome('bad', false);
      // 66% failure rate, 3 observations
      expect(mod.isProviderHealthy('bad')).toBe(false);
    });
  });

  describe('routing configuration readiness', () => {
    it('treats API providers without keys as unavailable for routing without changing health counters', () => {
      const previous = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      try {
        expect(mod.providerRequiresApiKey('groq')).toBe(true);
        expect(mod.isProviderConfiguredForRouting('groq')).toBe(false);
        expect(mod.isProviderHealthy('groq')).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.GROQ_API_KEY;
        } else {
          process.env.GROQ_API_KEY = previous;
        }
      }
    });

    it('does not require API keys for CLI/local routing providers', () => {
      expect(mod.providerRequiresApiKey('codex')).toBe(false);
      expect(mod.isProviderConfiguredForRouting('codex')).toBe(true);
      expect(mod.providerRequiresApiKey('ollama')).toBe(false);
      expect(mod.isProviderConfiguredForRouting('ollama')).toBe(true);
    });
  });

  describe('resetProviderHealth', () => {
    it('clears all health data', () => {
      mod.recordProviderOutcome('p1', true);
      mod.recordProviderOutcome('p2', false);
      expect(mod.resetProviderHealth()).toEqual({
        scope: 'all',
        reset_count: 2,
      });
      expect(mod.getProviderHealth('p1').successes).toBe(0);
      expect(mod.getProviderHealth('p2').failures).toBe(0);
    });

    it('clears one provider without touching the others', () => {
      mod.recordProviderOutcome('p1', true);
      mod.recordProviderOutcome('p2', false);

      expect(mod.resetProviderHealth('p1')).toEqual({
        scope: 'provider',
        provider: 'p1',
        reset_count: 1,
      });

      expect(mod.getProviderHealth('p1').successes).toBe(0);
      expect(mod.getProviderHealth('p2').failures).toBe(1);
    });
  });
});
