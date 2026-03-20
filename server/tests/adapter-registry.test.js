'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// Each beforeEach call to installProviderMocks() creates fresh vi.fn() instances
// for each provider so that test assertions on mock state (e.g. instances, call
// counts) start clean. vi.mock() factory functions run once at module load time
// and cannot be cheaply re-created per-test without a full vi.resetModules() +
// dynamic import cycle, which would complicate the test structure significantly.
// The registry itself is also evicted from require.cache each time so it picks up
// the freshly installed provider mocks.

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function createMockProviderClass(providerId, options = {}) {
  const state = {
    instances: [],
    submit: vi.fn(async (task, model, submitOptions = {}) => ({
      provider: providerId,
      method: 'submit',
      task,
      model,
      options: submitOptions,
    })),
    stream: vi.fn(async (task, model, streamOptions = {}) => ({
      provider: providerId,
      method: 'stream',
      task,
      model,
      options: streamOptions,
    })),
    cancel: vi.fn(async () => ({
      cancelled: true,
      provider: providerId,
      supported: true,
    })),
    checkHealth: vi.fn(async () => ({
      available: true,
      models: [`${providerId}-model`],
    })),
    listModels: vi.fn(async () => [`${providerId}-model`]),
  };

  class MockProvider {
    constructor() {
      this.providerId = providerId;
      this.supportsStreaming = options.supportsStreaming !== false;
      this.submit = state.submit;
      this.stream = state.stream;
      this.submitStream = state.stream;
      this.cancel = state.cancel;
      this.checkHealth = state.checkHealth;
      this.listModels = state.listModels;
      state.instances.push(this);
    }
  }

  return { MockProvider, state };
}

function createCustomAdapter(id, version, capabilities = {}) {
  return {
    id,
    version,
    capabilities,
    supportsStream: Boolean(capabilities.supportsStream),
    supportsAsync: Boolean(capabilities.supportsAsync),
    supportsCancellation: Boolean(capabilities.supportsCancellation),
    submit: vi.fn(async () => ({ id, version, method: 'submit' })),
    stream: vi.fn(async () => ({ id, version, method: 'stream' })),
    submitAsync: vi.fn(async () => ({ id, version, method: 'submitAsync' })),
    cancel: vi.fn(async () => ({ cancelled: true, provider: id, supported: true })),
    normalizeResult: vi.fn((value) => value),
    checkHealth: vi.fn(async () => ({ available: true, models: [`${id}-model`] })),
    listModels: vi.fn(async () => [`${id}-model`]),
  };
}

function installProviderMocks() {
  const providers = {
    anthropic: createMockProviderClass('anthropic'),
    groq: createMockProviderClass('groq'),
    hyperbolic: createMockProviderClass('hyperbolic'),
    deepinfra: createMockProviderClass('deepinfra'),
    'ollama-strategic': createMockProviderClass('ollama-strategic', { supportsStreaming: false }),
    codex: createMockProviderClass('codex', { supportsStreaming: false }),
    'claude-cli': createMockProviderClass('claude-cli', { supportsStreaming: false }),
    ollama: createMockProviderClass('ollama'),
    'aider-ollama': createMockProviderClass('aider-ollama'),
    'hashline-ollama': createMockProviderClass('hashline-ollama'),
  };

  installMock('../providers/anthropic', providers.anthropic.MockProvider);
  installMock('../providers/groq', providers.groq.MockProvider);
  installMock('../providers/hyperbolic', providers.hyperbolic.MockProvider);
  installMock('../providers/deepinfra', providers.deepinfra.MockProvider);
  installMock('../providers/ollama-strategic', providers['ollama-strategic'].MockProvider);
  installMock('../providers/v2-cli-providers', {
    CodexCliProvider: providers.codex.MockProvider,
    ClaudeCliProvider: providers['claude-cli'].MockProvider,
  });
  installMock('../providers/v2-local-providers', {
    OllamaProvider: providers.ollama.MockProvider,
    AiderOllamaProvider: providers['aider-ollama'].MockProvider,
    HashlineOllamaProvider: providers['hashline-ollama'].MockProvider,
  });

  return providers;
}

function loadRegistry() {
  delete require.cache[require.resolve('../providers/adapter-registry')];
  return require('../providers/adapter-registry');
}

const expectedBuiltInProviderIds = [
  'aider-ollama',
  'anthropic',
  'claude-cli',
  'codex',
  'deepinfra',
  'groq',
  'hashline-ollama',
  'hyperbolic',
  'ollama',
  'ollama-strategic',
];

describe('adapter-registry.js', () => {
  let providerMocks;
  let registry;

  beforeEach(() => {
    providerMocks = installProviderMocks();
    registry = loadRegistry();
  });

  it('createProviderAdapter builds API-backed adapters with the registered capabilities', async () => {
    const adapter = registry.createProviderAdapter('anthropic');
    const onChunk = vi.fn();

    expect(adapter).toMatchObject({
      id: 'anthropic',
      supportsStream: true,
      supportsAsync: true,
      supportsCancellation: false,
      capabilities: {
        supportsStream: true,
        supportsAsync: true,
        supportsCancellation: false,
      },
    });
    expect(providerMocks.anthropic.state.instances).toHaveLength(0);

    const submitResult = await adapter.submit('write tests', 'claude-sonnet', { temperature: 0.1 });
    const streamResult = await adapter.stream('write tests', 'claude-sonnet', { onChunk });
    const asyncResult = await adapter.submitAsync('write tests', 'claude-sonnet', { priority: 'high' });
    const cancelResult = await adapter.cancel();
    const healthResult = await adapter.checkHealth();
    const modelsResult = await adapter.listModels();

    expect(providerMocks.anthropic.state.instances).toHaveLength(1);
    expect(providerMocks.anthropic.state.submit).toHaveBeenNthCalledWith(
      1,
      'write tests',
      'claude-sonnet',
      { temperature: 0.1 }
    );
    expect(providerMocks.anthropic.state.stream).toHaveBeenCalledWith(
      'write tests',
      'claude-sonnet',
      { onChunk }
    );
    expect(providerMocks.anthropic.state.submit).toHaveBeenNthCalledWith(
      2,
      'write tests',
      'claude-sonnet',
      { priority: 'high' }
    );
    expect(submitResult).toMatchObject({ provider: 'anthropic', method: 'submit' });
    expect(streamResult).toMatchObject({ provider: 'anthropic', method: 'stream' });
    expect(asyncResult).toMatchObject({ provider: 'anthropic', method: 'submit' });
    expect(cancelResult).toEqual({
      cancelled: false,
      provider: 'anthropic',
      supported: false,
    });
    expect(healthResult).toEqual({
      available: true,
      models: ['anthropic-model'],
    });
    expect(modelsResult).toEqual(['anthropic-model']);
    expect(adapter.normalizeResult({ ok: true })).toEqual({ ok: true });
  });

  it('createProviderAdapter returns null for unknown providers and exposes fallback behavior for unsupported adapters', async () => {
    expect(registry.createProviderAdapter('missing-provider')).toBeNull();

    const codexAdapter = registry.createProviderAdapter('codex');
    expect(codexAdapter).toMatchObject({
      id: 'codex',
      supportsStream: false,
      supportsAsync: true,
      supportsCancellation: false,
    });

    const submitResult = await codexAdapter.submit('lint', 'gpt-5-codex');
    expect(submitResult).toMatchObject({ provider: 'codex', method: 'submit' });
    await expect(codexAdapter.stream('lint', 'gpt-5-codex')).rejects.toThrow(
      'codex streaming is not implemented for v2'
    );
    // codex supportsAsync: true — submitAsync delegates to submit() and resolves
    const asyncResult = await codexAdapter.submitAsync('lint', 'gpt-5-codex');
    expect(asyncResult).toMatchObject({ provider: 'codex', method: 'submit' });
    await expect(codexAdapter.cancel()).resolves.toEqual({
      cancelled: false,
      provider: 'codex',
      supported: false,
    });

  });

  it('registerProviderAdapter registers custom factories and overwrites existing definitions', async () => {
    const customId = 'custom-provider';
    const firstFactory = vi.fn(() =>
      createCustomAdapter(customId, 'first', {
        supportsStream: false,
        supportsAsync: false,
        supportsCancellation: false,
      })
    );
    const secondFactory = vi.fn(() =>
      createCustomAdapter(customId, 'second', {
        supportsStream: true,
        supportsAsync: true,
        supportsCancellation: true,
      })
    );
    const replacementFactory = vi.fn(() =>
      createCustomAdapter('groq-replacement', 'replacement', {
        supportsStream: false,
        supportsAsync: false,
        supportsCancellation: true,
      })
    );

    registry.registerProviderAdapter(customId, firstFactory);
    registry.registerProviderAdapter(customId, secondFactory);

    const customAdapter = registry.createProviderAdapter(customId);
    expect(customAdapter.version).toBe('second');
    expect(firstFactory).not.toHaveBeenCalled();
    expect(secondFactory).toHaveBeenCalledTimes(1);
    await expect(customAdapter.submitAsync()).resolves.toMatchObject({
      id: customId,
      version: 'second',
      method: 'submitAsync',
    });

    const originalGroq = registry.createProviderAdapter('groq');
    expect(originalGroq.id).toBe('groq');

    registry.registerProviderAdapter('groq', replacementFactory);
    const replacedGroq = registry.createProviderAdapter('groq');

    expect(replacementFactory).toHaveBeenCalledTimes(1);
    expect(replacedGroq).toMatchObject({
      id: 'groq-replacement',
      version: 'replacement',
      supportsCancellation: true,
    });
  });

  it('getProviderAdapter returns the cached adapter instance and null for unregistered providers', () => {
    const first = registry.getProviderAdapter('ollama');
    const second = registry.getProviderAdapter('ollama');
    const created = registry.createProviderAdapter('ollama');

    expect(first).toBeTruthy();
    expect(first).toBe(second);
    expect(created).not.toBe(first);
    expect(first.id).toBe('ollama');
    expect(registry.getProviderAdapter('missing-provider')).toBeNull();
  });

  it('getRegisteredProviderIds returns the full sorted provider list', () => {
    registry.registerProviderAdapter('zz-custom', () =>
      createCustomAdapter('zz-custom', 'one', {
        supportsStream: false,
        supportsAsync: false,
        supportsCancellation: false,
      })
    );

    const providerIds = registry.getRegisteredProviderIds();

    expect(providerIds).toEqual(expect.arrayContaining([
      ...expectedBuiltInProviderIds,
      'zz-custom',
    ]));
    expect(providerIds).toContain('zz-custom');
  });

  it('isAdapterRegistered reports built-in, custom, and missing providers', () => {
    expect(registry.isAdapterRegistered('anthropic')).toBe(true);
    expect(registry.isAdapterRegistered('custom-check')).toBe(false);

    registry.registerProviderAdapter('custom-check', () =>
      createCustomAdapter('custom-check', 'one', {
        supportsStream: false,
        supportsAsync: true,
        supportsCancellation: false,
      })
    );

    expect(registry.isAdapterRegistered('custom-check')).toBe(true);
    expect(registry.isAdapterRegistered('missing-provider')).toBe(false);
  });

  it('getProviderCapabilityMatrix returns capability flags for every registered provider', () => {
    registry.registerProviderAdapter('custom-capabilities', () =>
      createCustomAdapter('custom-capabilities', 'matrix', {
        supportsStream: 1,
        supportsAsync: 0,
        supportsCancellation: 'yes',
        extraMetadata: 'retained',
      })
    );

    const matrix = registry.getProviderCapabilityMatrix();
    const matrixKeys = Object.keys(matrix);

    expect(matrixKeys).toEqual(expect.arrayContaining([
      ...expectedBuiltInProviderIds,
      'custom-capabilities',
    ]));
    expect(matrixKeys).toContain('custom-capabilities');
    expect(matrix.anthropic).toEqual({
      supportsStream: true,
      supportsAsync: true,
      supportsCancellation: false,
    });
    expect(matrix.codex).toEqual({
      supportsStream: false,
      supportsAsync: true,
      supportsCancellation: false,
    });
    expect(matrix['ollama-strategic']).toEqual({
      supportsStream: false,
      supportsAsync: false,
      supportsCancellation: false,
    });
    expect(matrix['custom-capabilities']).toEqual({
      supportsStream: true,
      supportsAsync: false,
      supportsCancellation: true,
      extraMetadata: 'retained',
    });
  });
});
