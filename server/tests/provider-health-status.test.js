'use strict';

const providerRoutingCore = require('../db/provider/routing-core');
const { getProviderHealthStatus } = require('../utils/provider-health-status');

describe('provider-health-status', () => {
  afterEach(() => {
    providerRoutingCore.resetProviderHealth();
  });

  it('returns warning for a healthy provider with recent failures', () => {
    providerRoutingCore.recordProviderOutcome('codex', true);
    providerRoutingCore.recordProviderOutcome('codex', false);

    const result = getProviderHealthStatus(
      { provider: 'codex', enabled: true },
      providerRoutingCore.getProviderHealth('codex'),
    );

    expect(result).toEqual(expect.objectContaining({
      provider: 'codex',
      status: 'warning',
      isHealthy: true,
      isConfigured: true,
    }));
    expect(result.health).toEqual(expect.objectContaining({
      successes: 1,
      failures: 1,
    }));
  });

  it('returns degraded when routing health is unhealthy', () => {
    providerRoutingCore.recordProviderOutcome('ollama', true);
    providerRoutingCore.recordProviderOutcome('ollama', false);
    providerRoutingCore.recordProviderOutcome('ollama', false);

    const result = getProviderHealthStatus(
      { provider: 'ollama', enabled: true },
      providerRoutingCore.getProviderHealth('ollama'),
    );

    expect(result).toEqual(expect.objectContaining({
      provider: 'ollama',
      status: 'degraded',
      isHealthy: false,
      isConfigured: true,
    }));
  });

  it('returns unavailable when a provider is not configured for routing', () => {
    const previous = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;

    try {
      const result = getProviderHealthStatus(
        { provider: 'groq', enabled: true },
        { successes: 0, failures: 0, failureRate: 0 },
      );

      expect(result).toEqual(expect.objectContaining({
        provider: 'groq',
        status: 'unavailable',
        isConfigured: false,
      }));
    } finally {
      if (previous === undefined) {
        delete process.env.GROQ_API_KEY;
      } else {
        process.env.GROQ_API_KEY = previous;
      }
    }
  });

  it('returns disabled when the provider is disabled', () => {
    const result = getProviderHealthStatus(
      { provider: 'codex', enabled: false },
      { successes: 5, failures: 5, failureRate: 0.5 },
    );

    expect(result).toEqual(expect.objectContaining({
      provider: 'codex',
      status: 'disabled',
    }));
  });
});
