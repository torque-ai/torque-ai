'use strict';

// Uses require.cache injection to mock discovery-engine and config modules
// so we can test discoverAllModels without hitting real provider APIs.

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function evict(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // module was never required — safe to ignore
  }
}

// ── Mock factories ────────────────────────────────────────────────────────

function makeDiscoveryEngineMock() {
  const discoverFromAdapter = vi.fn(async (_db, _adapter, providerId, _hostId) => ({
    discovered: 3,
    new: 1,
    updated: 1,
    removed: 0,
    roles_assigned: [],
    capabilities_set: 0,
    _provider: providerId,
  }));
  return { discoverFromAdapter };
}

function makeConfigMock(keyMap = {}) {
  return {
    getApiKey: vi.fn((providerId) => keyMap[providerId] || null),
  };
}

function makeProviderMock(providerId, opts = {}) {
  const discoverModels = vi.fn(async () => ({
    models: [{ model_name: `${providerId}-model`, family: 'test' }],
    provider: providerId,
  }));
  const MockClass = class {
    constructor() {
      this.providerId = providerId;
      this.supportsStreaming = opts.supportsStreaming !== false;
      this.discoverModels = discoverModels;
      this.listModels = vi.fn(async () => [`${providerId}-model`]);
      this.checkHealth = vi.fn(async () => ({ available: true }));
      this.submit = vi.fn(async () => ({}));
    }
  };
  return { MockClass, discoverModels };
}

// ── Install provider mocks so adapter-registry can be loaded ─────────────

function installAllProviderMocks() {
  const providers = {
    anthropic: makeProviderMock('anthropic'),
    groq: makeProviderMock('groq'),
    hyperbolic: makeProviderMock('hyperbolic'),
    deepinfra: makeProviderMock('deepinfra'),
    cerebras: makeProviderMock('cerebras'),
    'google-ai': makeProviderMock('google-ai'),
    'ollama-cloud': makeProviderMock('ollama-cloud'),
    openrouter: makeProviderMock('openrouter'),
    'ollama-strategic': makeProviderMock('ollama-strategic', { supportsStreaming: false }),
    codex: makeProviderMock('codex', { supportsStreaming: false }),
    'claude-cli': makeProviderMock('claude-cli', { supportsStreaming: false }),
    'claude-code-sdk': makeProviderMock('claude-code-sdk'),
    ollama: makeProviderMock('ollama'),
  };

  installMock('../providers/anthropic', providers.anthropic.MockClass);
  installMock('../providers/groq', providers.groq.MockClass);
  installMock('../providers/hyperbolic', providers.hyperbolic.MockClass);
  installMock('../providers/deepinfra', providers.deepinfra.MockClass);
  installMock('../providers/cerebras', providers.cerebras.MockClass);
  installMock('../providers/google-ai', providers['google-ai'].MockClass);
  installMock('../providers/ollama-cloud', providers['ollama-cloud'].MockClass);
  installMock('../providers/openrouter', providers.openrouter.MockClass);
  installMock('../providers/ollama-strategic', providers['ollama-strategic'].MockClass);
  installMock('../providers/claude-code-sdk', providers['claude-code-sdk'].MockClass);
  installMock('../providers/v2-cli-providers', {
    CodexCliProvider: providers.codex.MockClass,
    ClaudeCliProvider: providers['claude-cli'].MockClass,
  });
  installMock('../providers/v2-local-providers', {
    OllamaProvider: providers.ollama.MockClass,
  });

  return providers;
}

// ── Load registry fresh each time ────────────────────────────────────────

function loadRegistry() {
  evict('../providers/adapter-registry');
  return require('../providers/adapter-registry');
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('adapter-registry discoverAllModels', () => {
  let registry;
  let discoveryMock;
  let configMock;

  beforeEach(() => {
    installAllProviderMocks();

    discoveryMock = makeDiscoveryEngineMock();
    installMock('../discovery/discovery-engine', discoveryMock);

    // Default: no API keys configured for cloud providers
    configMock = makeConfigMock({});
    installMock('../config', configMock);

    registry = loadRegistry();
  });

  afterEach(() => {
    evict('../providers/adapter-registry');
    evict('../discovery/discovery-engine');
    evict('../config');
  });

  it('discoverAllModels is exported from adapter-registry', () => {
    expect(typeof registry.discoverAllModels).toBe('function');
  });

  it('returns an object keyed by provider ID', async () => {
    // Give all local providers a pass (no key check for them)
    const result = await registry.discoverAllModels(null);

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    // Local/CLI-discovered providers run unconditionally
    expect(result).toHaveProperty('claude-code-sdk');
    expect(result).toHaveProperty('ollama');
    expect(result).toHaveProperty('ollama-strategic');
  });

  it('skips cloud providers that have no API key configured', async () => {
    // configMock returns null for every provider → all cloud providers skipped
    const result = await registry.discoverAllModels(null);

    // These are cloud/API providers — should be absent when key is missing
    expect(result).not.toHaveProperty('anthropic');
    expect(result).not.toHaveProperty('groq');
    expect(result).not.toHaveProperty('deepinfra');
    expect(result).not.toHaveProperty('hyperbolic');
    expect(result).not.toHaveProperty('cerebras');
    expect(result).not.toHaveProperty('google-ai');
    expect(result).not.toHaveProperty('openrouter');
    expect(result).not.toHaveProperty('ollama-cloud');
  });

  it('includes cloud providers when they have API keys', async () => {
    configMock = makeConfigMock({
      anthropic: 'sk-ant-test',
      groq: 'gsk_test',
    });
    installMock('../config', configMock);
    evict('../providers/adapter-registry');
    registry = loadRegistry();

    const result = await registry.discoverAllModels(null);

    expect(result).toHaveProperty('anthropic');
    expect(result).toHaveProperty('groq');
    // Other cloud providers still absent (no keys)
    expect(result).not.toHaveProperty('deepinfra');
  });

  it('includes local and CLI-backed providers even without API keys', async () => {
    // configMock has no keys at all — local/CLI providers must still run
    const result = await registry.discoverAllModels(null);

    expect(result).toHaveProperty('claude-code-sdk');
    expect(result).toHaveProperty('ollama');
    expect(result).toHaveProperty('ollama-strategic');
  });

  it('catches per-provider errors without failing the whole batch', async () => {
    discoveryMock.discoverFromAdapter = vi.fn(async (_db, _adapter, providerId, _hostId) => {
      if (providerId === 'ollama') throw new Error('ollama connection refused');
      return { discovered: 2, new: 1, updated: 0, removed: 0, roles_assigned: [], capabilities_set: 0 };
    });
    installMock('../discovery/discovery-engine', discoveryMock);
    evict('../providers/adapter-registry');
    registry = loadRegistry();

    const result = await registry.discoverAllModels(null);

    // ollama errored — but it must still appear as an error entry, not crash
    expect(result).toHaveProperty('ollama');
    expect(result.ollama).toHaveProperty('error');
    expect(result.ollama.error).toMatch(/ollama connection refused/);

    // Other local/CLI providers still run fine
    expect(result).toHaveProperty('claude-code-sdk');
    expect(result['claude-code-sdk']).not.toHaveProperty('error');
    expect(result).toHaveProperty('ollama-strategic');
    expect(result['ollama-strategic']).not.toHaveProperty('error');
  });

  it('discoverFromAdapter is called with the correct arguments (db, adapter, providerId, null)', async () => {
    configMock = makeConfigMock({ anthropic: 'sk-ant-test' });
    installMock('../config', configMock);
    evict('../providers/adapter-registry');
    registry = loadRegistry();

    const mockDb = { name: 'mock-db' };
    await registry.discoverAllModels(mockDb);

    const calls = discoveryMock.discoverFromAdapter.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe(mockDb);          // db argument
      expect(typeof call[1]).toBe('object'); // adapter object
      expect(typeof call[2]).toBe('string'); // providerId string
      expect(call[3]).toBeNull();            // hostId is null
    }
  });

  it('the adapter wrapper forwards discoverModels correctly (Task 1 contract)', async () => {
    // Verify that getProviderAdapter(id).discoverModels() reaches the provider class method
    // This validates the adapter wrapping added in Task 1.
    const ollamaAdapter = registry.getProviderAdapter('ollama');
    expect(ollamaAdapter).not.toBeNull();
    expect(typeof ollamaAdapter.discoverModels).toBe('function');

    const result = await ollamaAdapter.discoverModels();
    expect(result).toBeDefined();
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('provider', 'ollama');
  });

  it('passes the db argument through to discoverFromAdapter', async () => {
    const fakeDb = { _tag: 'fake-sqlite-db' };
    await registry.discoverAllModels(fakeDb);

    const calls = discoveryMock.discoverFromAdapter.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Every call must pass fakeDb as first argument
    for (const call of calls) {
      expect(call[0]).toBe(fakeDb);
    }
  });

  it('returns summary results from discoverFromAdapter for each included provider', async () => {
    configMock = makeConfigMock({ groq: 'gsk_test' });
    installMock('../config', configMock);
    evict('../providers/adapter-registry');
    registry = loadRegistry();

    const result = await registry.discoverAllModels(null);

    // groq should have discovery results
    expect(result.groq).toMatchObject({
      discovered: 3,
      new: 1,
      updated: 1,
      removed: 0,
    });

    // Local providers also have results
    expect(result.ollama).toMatchObject({
      discovered: 3,
      new: 1,
      updated: 1,
    });
  });
});
