const BaseProvider = require('../providers/base');
const { registerProviderAdapter, getProviderAdapter, invalidateAdapterCache } = require('../providers/adapter-registry');

// ── Helpers ──────────────────────────────────────────────────────────────────

class HealthyProvider extends BaseProvider {
  constructor(cfg = {}) {
    super({ name: 'healthy-provider', ...cfg });
  }

  async checkHealth() {
    return {
      available: true,
      models: ['model-a', 'model-b'],
    };
  }
}

class RichHealthProvider extends BaseProvider {
  constructor(cfg = {}) {
    super({ name: 'rich-provider', ...cfg });
  }

  async checkHealth() {
    return {
      available: true,
      models: [
        { model_name: 'big-model', sizeBytes: 1_000_000 },
        { model_name: 'small-model', sizeBytes: 500_000 },
      ],
    };
  }
}

class ThrowingProvider extends BaseProvider {
  constructor(cfg = {}) {
    super({ name: 'throwing-provider', ...cfg });
  }

  async checkHealth() {
    throw new Error('network unreachable');
  }
}

// ── BaseProvider.discoverModels() tests ──────────────────────────────────────

describe('BaseProvider.discoverModels()', () => {
  it('exists as a method on BaseProvider', () => {
    const provider = new BaseProvider({ name: 'test' });
    expect(typeof provider.discoverModels).toBe('function');
  });

  it('returns { models: [], provider } when checkHealth() is not implemented (default base)', async () => {
    // BaseProvider.checkHealth() throws — discoverModels() must catch and return empty
    const provider = new BaseProvider({ name: 'bare' });
    const result = await provider.discoverModels();
    expect(result).toEqual({ models: [], provider: 'bare' });
  });

  it('maps string model names from checkHealth() to { model_name } objects', async () => {
    const provider = new HealthyProvider();
    const result = await provider.discoverModels();
    expect(result).toEqual({
      models: [{ model_name: 'model-a' }, { model_name: 'model-b' }],
      provider: 'healthy-provider',
    });
  });

  it('passes through rich model objects from checkHealth() unchanged', async () => {
    const provider = new RichHealthProvider();
    const result = await provider.discoverModels();
    expect(result).toEqual({
      models: [
        { model_name: 'big-model', sizeBytes: 1_000_000 },
        { model_name: 'small-model', sizeBytes: 500_000 },
      ],
      provider: 'rich-provider',
    });
  });

  it('does not throw when checkHealth() throws — returns empty models', async () => {
    const provider = new ThrowingProvider();
    await expect(provider.discoverModels()).resolves.toEqual({
      models: [],
      provider: 'throwing-provider',
    });
  });

  it('returns empty models when checkHealth() returns no models array', async () => {
    class NoModelsProvider extends BaseProvider {
      constructor() { super({ name: 'no-models' }); }
      async checkHealth() { return { available: true }; }
    }
    const provider = new NoModelsProvider();
    const result = await provider.discoverModels();
    expect(result).toEqual({ models: [], provider: 'no-models' });
  });

  it('can be overridden in a subclass', async () => {
    class CustomDiscoverProvider extends BaseProvider {
      constructor() { super({ name: 'custom' }); }
      async checkHealth() { return { available: true, models: [] }; }
      async discoverModels() {
        return { models: [{ model_name: 'custom-model', sizeBytes: 42 }], provider: this.name };
      }
    }
    const provider = new CustomDiscoverProvider();
    const result = await provider.discoverModels();
    expect(result).toEqual({
      models: [{ model_name: 'custom-model', sizeBytes: 42 }],
      provider: 'custom',
    });
  });
});

// ── Adapter registry forwarding tests ────────────────────────────────────────

describe('adapter registry: discoverModels() forwarding', () => {
  const TEST_PROVIDER_ID = '__test-discover-adapter__';

  beforeEach(() => {
    // Clear any cached adapter so each test gets a fresh instance
    invalidateAdapterCache(TEST_PROVIDER_ID);
  });

  afterEach(() => {
    invalidateAdapterCache(TEST_PROVIDER_ID);
  });

  it('wrapper exposes discoverModels() method', () => {
    registerProviderAdapter(TEST_PROVIDER_ID, () => ({
      discoverModels: async () => ({ models: [], provider: TEST_PROVIDER_ID }),
    }));
    const adapter = getProviderAdapter(TEST_PROVIDER_ID);
    expect(typeof adapter.discoverModels).toBe('function');
  });

  it('adapter registered via registerApiAdapter forwards discoverModels() to the provider instance', async () => {
    // Use registerProviderAdapter directly (lower-level) to simulate what
    // registerApiAdapter produces — we inject a provider that has discoverModels().
    const mockProvider = new HealthyProvider({ name: TEST_PROVIDER_ID });

    registerProviderAdapter(TEST_PROVIDER_ID, () => ({
      id: TEST_PROVIDER_ID,
      async discoverModels() {
        return mockProvider.discoverModels();
      },
    }));

    const adapter = getProviderAdapter(TEST_PROVIDER_ID);
    const result = await adapter.discoverModels();

    expect(result).toEqual({
      models: [{ model_name: 'model-a' }, { model_name: 'model-b' }],
      provider: TEST_PROVIDER_ID,
    });
  });

  it('adapter discoverModels() does not throw when underlying provider throws', async () => {
    const throwingProvider = new ThrowingProvider({ name: TEST_PROVIDER_ID });

    registerProviderAdapter(TEST_PROVIDER_ID, () => ({
      id: TEST_PROVIDER_ID,
      async discoverModels() {
        return throwingProvider.discoverModels();
      },
    }));

    const adapter = getProviderAdapter(TEST_PROVIDER_ID);
    const result = await adapter.discoverModels();

    expect(result).toEqual({ models: [], provider: TEST_PROVIDER_ID });
  });
});
