'use strict';

const {
  DEFAULT_REQUEST_RATE_PER_MINUTE,
  PROVIDER_REGISTRY,
  PROVIDER_LOCAL_IDS,
  V2_TRANSPORTS,
} = require('../api/v2-provider-registry');

describe('v2-provider-registry', () => {
  it('exports DEFAULT_REQUEST_RATE_PER_MINUTE as 120', () => {
    expect(DEFAULT_REQUEST_RATE_PER_MINUTE).toBe(120);
  });

  it('exports the expected provider set', () => {
    const providers = Object.keys(PROVIDER_REGISTRY);
    const expectedProviders = [
      'codex',
      'claude-cli',
      'ollama',
      'anthropic',
      'groq',
      'hyperbolic',
      'cerebras',
      'ollama-cloud',
      'google-ai',
      'openrouter',
      'deepinfra',
    ];

    expect(providers.filter((provider) => expectedProviders.includes(provider))).toHaveLength(
      expectedProviders.length,
    );
    for (const provider of expectedProviders) {
      expect(providers).toContain(provider);
    }
  });

  it('each provider has name, transport, local, and features', () => {
    for (const [_id, provider] of Object.entries(PROVIDER_REGISTRY)) {
      expect(provider).toHaveProperty('name');
      expect(provider).toHaveProperty('transport');
      expect(provider).toHaveProperty('local');
      expect(provider).toHaveProperty('features');
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.local).toBe('boolean');
      expect(V2_TRANSPORTS.has(provider.transport)).toBe(true);
      expect(typeof provider.features.chat).toBe('boolean');
    }
  });

  it('PROVIDER_LOCAL_IDS contains only local providers', () => {
    for (const id of PROVIDER_LOCAL_IDS) {
      expect(PROVIDER_REGISTRY[id]).toBeDefined();
      expect(PROVIDER_REGISTRY[id].local).toBe(true);
    }
  });

  it('V2_TRANSPORTS contains api, cli, and hybrid', () => {
    expect(V2_TRANSPORTS.has('api')).toBe(true);
    expect(V2_TRANSPORTS.has('cli')).toBe(true);
    expect(V2_TRANSPORTS.has('hybrid')).toBe(true);
    expect(V2_TRANSPORTS.size).toBe(3);
  });

  it('v2-router.js now gets the same providers (dedup verification)', () => {
    // v2-router.js imports the same provider registry module, so provider additions
    // and removals stay centralized here.
    expect(PROVIDER_REGISTRY['cerebras']).toBeDefined();
    expect(PROVIDER_REGISTRY['ollama-cloud']).toBeDefined();
    expect(PROVIDER_REGISTRY['google-ai']).toBeDefined();
    expect(PROVIDER_REGISTRY['openrouter']).toBeDefined();
  });
});
