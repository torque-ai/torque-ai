'use strict';

const SUBJECT_PATH = require.resolve('../handlers/discovery-handlers');
const originalModules = new Map();

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  if (!originalModules.has(resolved)) {
    originalModules.set(resolved, require.cache[resolved] || null);
  }
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: [],
  };
}

function restoreCjsModuleMocks() {
  for (const [resolved, original] of originalModules.entries()) {
    if (original) {
      require.cache[resolved] = original;
    } else {
      delete require.cache[resolved];
    }
  }
  originalModules.clear();
}

function loadSubject() {
  delete require.cache[SUBJECT_PATH];
  return require('../handlers/discovery-handlers');
}

describe('discovery handlers', () => {
  let db;
  let facade;
  let resolveDatabaseFacade;
  let registry;
  let adapter;
  let getProviderAdapter;
  let discoverFromAdapter;
  let discoverAllModels;

  beforeEach(() => {
    db = { prepare: vi.fn() };
    facade = { getDbInstance: vi.fn(() => db) };
    resolveDatabaseFacade = vi.fn(() => facade);
    registry = { setDb: vi.fn() };
    adapter = { id: 'ollama' };
    getProviderAdapter = vi.fn(() => adapter);
    discoverFromAdapter = vi.fn(async () => ({
      discovered: 1,
      new: 1,
      updated: 0,
      removed: 0,
      capabilities_set: 1,
      roles_assigned: [],
    }));
    discoverAllModels = vi.fn(async () => ({
      ollama: {
        discovered: 1,
        new: 1,
        updated: 0,
        removed: 0,
        capabilities_set: 1,
        roles_assigned: [],
      },
    }));

    installCjsModuleMock('../db/database-facade-resolver', { resolveDatabaseFacade });
    installCjsModuleMock('../models/registry', registry);
    installCjsModuleMock('../providers/adapter-registry', {
      getProviderAdapter,
      discoverAllModels,
    });
    installCjsModuleMock('../discovery/discovery-engine', { discoverFromAdapter });
  });

  afterEach(() => {
    delete require.cache[SUBJECT_PATH];
    restoreCjsModuleMocks();
    vi.restoreAllMocks();
  });

  it('resolves the database through DI before provider discovery', async () => {
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({ provider: 'ollama' });

    expect(resolveDatabaseFacade).toHaveBeenCalledWith({
      serviceName: 'discovery handlers',
    });
    expect(facade.getDbInstance).toHaveBeenCalledOnce();
    expect(registry.setDb).toHaveBeenCalledWith(db);
    expect(getProviderAdapter).toHaveBeenCalledWith('ollama');
    expect(discoverFromAdapter).toHaveBeenCalledWith(db, adapter, 'ollama', null);
    expect(registry.setDb.mock.invocationCallOrder[0])
      .toBeLessThan(discoverFromAdapter.mock.invocationCallOrder[0]);
    expect(result).toContain('## Discovery: ollama');
  });

  it('accepts a direct database handle from the DI resolver', async () => {
    resolveDatabaseFacade.mockReturnValue(db);
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({});

    expect(registry.setDb).toHaveBeenCalledWith(db);
    expect(discoverAllModels).toHaveBeenCalledWith(db);
    expect(result).toContain('## Model Discovery Results');
  });

  it('formats provider-specific discovery success metrics and roles', async () => {
    discoverFromAdapter.mockResolvedValue({
      discovered: 5,
      new: 2,
      updated: 1,
      removed: 0,
      capabilities_set: 4,
      roles_assigned: [
        { role: 'fast', model: 'llama-fast' },
        { role: 'cheap', model: 'llama-cheap' },
      ],
    });
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({ provider: 'ollama' });

    expect(result).toContain('## Discovery: ollama');
    expect(result).toContain('| Discovered | 5 |');
    expect(result).toContain('| New | 2 |');
    expect(result).toContain('| Updated | 1 |');
    expect(result).toContain('| Removed | 0 |');
    expect(result).toContain('| Capabilities set | 4 |');
    expect(result).toContain('**Roles assigned:** fast=llama-fast, cheap=llama-cheap');
  });

  it('returns an unknown-provider message without invoking discovery', async () => {
    getProviderAdapter.mockReturnValue(null);
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({ provider: 'missing-provider' });

    expect(result).toBe('Unknown provider: missing-provider. Use list_providers to see available providers.');
    expect(discoverFromAdapter).not.toHaveBeenCalled();
  });

  it('formats provider-specific discovery errors', async () => {
    discoverFromAdapter.mockResolvedValue({ error: 'Network timeout' });
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({ provider: 'ollama' });

    expect(result).toBe('## Discovery: ollama\n\nError: Network timeout');
  });

  it('formats all-provider discovery results with multiple providers', async () => {
    discoverAllModels.mockResolvedValue({
      ollama: {
        discovered: 3,
        new: 1,
        updated: 1,
        removed: 0,
        capabilities_set: 2,
        roles_assigned: [{ role: 'local', model: 'llama3' }],
      },
      groq: {
        discovered: 2,
        new: 0,
        updated: 2,
        removed: 1,
        capabilities_set: 2,
        roles_assigned: [],
      },
    });
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({});

    expect(discoverAllModels).toHaveBeenCalledWith(db);
    expect(result).toContain('## Model Discovery Results');
    expect(result).toContain('## Discovery: ollama');
    expect(result).toContain('| Discovered | 3 |');
    expect(result).toContain('**Roles assigned:** local=llama3');
    expect(result).toContain('## Discovery: groq');
    expect(result).toContain('| Removed | 1 |');
  });

  it('formats empty all-provider discovery results', async () => {
    discoverAllModels.mockResolvedValue({});
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({});

    expect(result).toBe(
      '## Model Discovery\n\nNo providers available for discovery. Enable providers with API keys first.',
    );
  });

  it('formats OpenRouter scout details', async () => {
    discoverFromAdapter.mockResolvedValue({
      discovered: 4,
      new: 2,
      updated: 0,
      removed: 0,
      capabilities_set: 4,
      roles_assigned: [],
      openrouter_scout: {
        scored: 3,
        roles_assigned: [{ role: 'reasoning', model: 'deepseek/deepseek-r1' }],
        top_models: [
          { model_name: 'deepseek/deepseek-r1', score: 98 },
          { model_name: 'qwen/qwen3-32b', score: 91 },
        ],
      },
    });
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({ provider: 'openrouter' });

    expect(result).toContain('**OpenRouter scout:** scored 3 model(s); roles reasoning=deepseek/deepseek-r1');
    expect(result).toContain('Top scored: deepseek/deepseek-r1 (98), qwen/qwen3-32b (91)');
  });

  it('propagates errors from discoverFromAdapter when the adapter throws', async () => {
    discoverFromAdapter.mockRejectedValue(new Error('Connection refused'));
    const { handleDiscoverModels } = loadSubject();

    await expect(handleDiscoverModels({ provider: 'ollama' }))
      .rejects.toThrow('Connection refused');
  });

  it('propagates errors from discoverAllModels when the all-provider path throws', async () => {
    discoverAllModels.mockRejectedValue(new Error('Bulk discovery failed'));
    const { handleDiscoverModels } = loadSubject();

    await expect(handleDiscoverModels({}))
      .rejects.toThrow('Bulk discovery failed');
  });

  it('propagates errors when resolveDatabaseFacade throws', () => {
    resolveDatabaseFacade.mockImplementation(() => {
      throw new Error('DB unavailable');
    });
    const { handleDiscoverModels } = loadSubject();

    expect(() => handleDiscoverModels({ provider: 'ollama' }))
      .toThrow('DB unavailable');
  });

  it('handles null results from discoverAllModels gracefully', async () => {
    discoverAllModels.mockResolvedValue(null);
    const { handleDiscoverModels } = loadSubject();

    const result = await handleDiscoverModels({});

    expect(result).toBe(
      '## Model Discovery\n\nNo providers available for discovery. Enable providers with API keys first.',
    );
  });

  it('createDiscoveryHandlers exposes handleDiscoverModels', () => {
    const { createDiscoveryHandlers, handleDiscoverModels } = loadSubject();

    expect(createDiscoveryHandlers()).toEqual({ handleDiscoverModels });
  });
});
