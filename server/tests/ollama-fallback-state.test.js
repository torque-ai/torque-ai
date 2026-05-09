'use strict';

const {
  buildOllamaFallbackState,
  mergeProviderHealthStatus,
} = require('../utils/ollama-fallback-state');

const serverConfig = {
  get: (key) => (key === 'ollama_fallback_provider' ? 'codex' : undefined),
  getBool: (key, fallback) => fallback,
};

describe('ollama-fallback-state', () => {
  it('marks fallback active when all enabled Ollama hosts are down', () => {
    const state = buildOllamaFallbackState({
      serverConfig,
      hosts: [{
        id: 'remote',
        name: 'Remote GPU',
        url: 'http://192.0.2.183:11434',
        enabled: 1,
        status: 'down',
      }],
    });

    expect(state).toEqual(expect.objectContaining({
      preferred_provider: 'ollama',
      fallback_provider: 'codex',
      fallback_active: true,
      preferred_available: false,
      remote_preferred: true,
      state: 'fallback_active',
      health_status: 'degraded',
      healthy_count: 0,
      total_count: 1,
    }));
  });

  it('marks partial degradation when at least one enabled host remains healthy', () => {
    const state = buildOllamaFallbackState({
      serverConfig,
      hosts: [
        { id: 'remote-a', url: 'http://192.0.2.183:11434', enabled: 1, status: 'healthy' },
        { id: 'remote-b', url: 'http://192.0.2.184:11434', enabled: 1, status: 'down' },
      ],
    });

    expect(state).toEqual(expect.objectContaining({
      fallback_active: false,
      preferred_available: true,
      remote_preferred: true,
      state: 'partial_degradation',
      health_status: 'warning',
      healthy_count: 1,
      total_count: 2,
    }));
  });

  it('keeps single-host availability unknown when no cached health exists', () => {
    const state = buildOllamaFallbackState({
      serverConfig,
      providerRoutingCore: { isOllamaHealthy: () => null },
    });

    expect(state).toEqual(expect.objectContaining({
      fallback_active: false,
      preferred_available: false,
      remote_preferred: false,
      state: 'unknown',
      health_status: 'unknown',
      healthy_count: 0,
      total_count: 1,
    }));
  });

  it('does not override disabled provider status', () => {
    const merged = mergeProviderHealthStatus('disabled', {
      health_status: 'degraded',
    });

    expect(merged).toBe('disabled');
  });
});
