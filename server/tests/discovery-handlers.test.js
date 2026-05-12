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
});
