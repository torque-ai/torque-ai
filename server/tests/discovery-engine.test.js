'use strict';

/**
 * Unit Tests: discovery-engine - orchestrates model discovery + post-processing
 *
 * Uses:
 *   - In-memory SQLite DB for runPostDiscovery tests (real applyHeuristicCapabilities
 *     and assignRolesForProvider need the actual tables)
 *   - require.cache manipulation for discoverFromAdapter tests (CJS mock pattern
 *     used throughout this codebase — vi.mock cannot reliably intercept modules
 *     already loaded in pool:forks mode)
 */

// NOTE: require.cache manipulation is intentionally used here rather than vi.mock().
// In pool:forks + CJS mode, vi.mock() factory functions run once at module load time,
// but modules already in the cache before the first test file loads are not replaced.
// The installMock / require fresh pattern ensures each test suite sees clean mocks.

const Database = require('better-sqlite3');
const { TEST_MODELS } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Mock infrastructure — require.cache based
// ---------------------------------------------------------------------------

const REGISTRY_PATH = require.resolve('../models/registry');
const ENGINE_PATH = require.resolve('../discovery/discovery-engine');
const OPENROUTER_SCOUT_PATH = require.resolve('../discovery/openrouter-scout');
const CONFIG_PATH = require.resolve('../config');

function installMock(resolvedPath, exportsValue) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(resolvedPath) {
  delete require.cache[resolvedPath];
}

function makeRegistryMock() {
  return {
    syncModelsFromHealthCheck: vi.fn().mockReturnValue({ new: [], updated: [], removed: [] }),
    approveModel: vi.fn(),
  };
}

function loadEngine(registryMock, extraMocks = {}) {
  clearModule(ENGINE_PATH);
  installMock(REGISTRY_PATH, registryMock);
  if (extraMocks.openrouterScout) {
    installMock(OPENROUTER_SCOUT_PATH, extraMocks.openrouterScout);
  }
  if (extraMocks.config) {
    installMock(CONFIG_PATH, extraMocks.config);
  }
  return require('../discovery/discovery-engine');
}

// ---------------------------------------------------------------------------
// Helpers - minimal in-memory SQLite for runPostDiscovery (real DB modules)
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_capabilities (
      model_name TEXT PRIMARY KEY,
      cap_hashline INTEGER NOT NULL DEFAULT 0,
      cap_agentic INTEGER NOT NULL DEFAULT 0,
      cap_file_creation INTEGER NOT NULL DEFAULT 0,
      cap_multi_file INTEGER NOT NULL DEFAULT 0,
      capability_source TEXT NOT NULL DEFAULT 'heuristic'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      parameter_size_b REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_roles (
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      model_name TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (provider, role)
    )
  `);
  return db;
}

function seedApprovedModel(db, provider, modelName, parameterSizeB) {
  db.prepare(
    "INSERT INTO model_registry (provider, model_name, parameter_size_b, status, updated_at) VALUES (?, ?, ?, 'approved', datetime('now'))",
  ).run(provider, modelName, parameterSizeB);
}

// ---------------------------------------------------------------------------
// runPostDiscovery - uses real heuristic-capabilities + auto-role-assigner
// ---------------------------------------------------------------------------

// Load a fresh discovery-engine for runPostDiscovery tests (real registry OK here
// because runPostDiscovery does not use the registry — it only uses db directly)
const { runPostDiscovery } = require('../discovery/discovery-engine');

describe('runPostDiscovery', () => {
  it('calls applyHeuristicCapabilities for new models with a known family', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', TEST_MODELS.SMALL, 8);

    const syncResult = {
      new: [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }],
    };

    const result = runPostDiscovery(db, 'ollama', syncResult);

    const row = db.prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get(TEST_MODELS.SMALL);
    expect(row).toBeDefined();
    expect(row.capability_source).toBe('heuristic');
    expect(row.cap_hashline).toBe(1); // qwen3 has hashline=true
    expect(result.capabilities_set).toBe(1);
  });

  it('returns { capabilities_set, roles_assigned } with correct shape', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', TEST_MODELS.SMALL, 8);

    const syncResult = {
      new: [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }],
    };

    const result = runPostDiscovery(db, 'ollama', syncResult);

    expect(result).toHaveProperty('capabilities_set');
    expect(result).toHaveProperty('roles_assigned');
    expect(typeof result.capabilities_set).toBe('number');
    expect(Array.isArray(result.roles_assigned)).toBe(true);
  });

  it('returns capabilities_set=0 when syncResult.new is empty', () => {
    const db = makeDb();
    const result = runPostDiscovery(db, 'ollama', { new: [] });
    expect(result.capabilities_set).toBe(0);
  });

  it('skips capability application for new models missing family', () => {
    const db = makeDb();
    const syncResult = {
      new: [{ model_name: 'mystery:7b' }],
    };
    const result = runPostDiscovery(db, 'ollama', syncResult);
    expect(result.capabilities_set).toBe(0);
    const row = db.prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get('mystery:7b');
    expect(row).toBeUndefined();
  });

  it('gracefully handles errors in applyHeuristicCapabilities without throwing', () => {
    const brokenDb = {
      prepare: () => { throw new Error('DB exploded'); },
    };
    const syncResult = {
      new: [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }],
    };
    expect(() => runPostDiscovery(brokenDb, 'ollama', syncResult)).not.toThrow();
  });

  it('auto-assigns roles for the provider after processing new models', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', TEST_MODELS.DEFAULT, 30);
    const syncResult = {
      new: [{ model_name: TEST_MODELS.DEFAULT, family: 'qwen3' }],
    };
    const result = runPostDiscovery(db, 'ollama', syncResult);
    expect(Array.isArray(result.roles_assigned)).toBe(true);
    const roles = result.roles_assigned.map(r => r.role);
    expect(roles).toContain('default');
  });

  it('returns roles_assigned=[] when no approved models are in the registry', () => {
    const db = makeDb();
    const syncResult = {
      new: [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }],
    };
    const result = runPostDiscovery(db, 'ollama', syncResult);
    expect(result.roles_assigned).toEqual([]);
  });

  it('handles undefined syncResult gracefully', () => {
    const db = makeDb();
    expect(() => runPostDiscovery(db, 'ollama', undefined)).not.toThrow();
    const result = runPostDiscovery(db, 'ollama', undefined);
    expect(result.capabilities_set).toBe(0);
    expect(result.roles_assigned).toEqual([]);
  });

  it('skips generic auto-role assignment for openrouter so scout policy owns role updates', () => {
    const db = makeDb();
    seedApprovedModel(db, 'openrouter', 'minimax/minimax-m2.5:free', 28);
    const syncResult = {
      new: [{ model_name: 'minimax/minimax-m2.5:free', family: 'qwen3' }],
    };

    const result = runPostDiscovery(db, 'openrouter', syncResult);
    expect(result.roles_assigned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverFromAdapter - uses require.cache-replaced registry mock
// ---------------------------------------------------------------------------

describe('discoverFromAdapter', () => {
  let db;
  let registryMock;
  let discoverFromAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    registryMock = makeRegistryMock();
    const engine = loadEngine(registryMock);
    discoverFromAdapter = engine.discoverFromAdapter;

    db = {
      prepare: () => ({
        all: () => [],
        get: () => null,
        run: () => ({}),
      }),
    };
  });

  afterEach(() => {
    // Restore real registry in cache so other test files are not affected
    clearModule(ENGINE_PATH);
    clearModule(REGISTRY_PATH);
    clearModule(OPENROUTER_SCOUT_PATH);
    clearModule(CONFIG_PATH);
  });

  it('calls adapter.discoverModels() and feeds models to registry', async () => {
    const models = [
      { model_name: TEST_MODELS.SMALL, family: 'qwen3' },
      { model_name: 'llama3:7b', family: 'llama' },
    ];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models, provider: 'ollama' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: models,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama', 'host-1');
    expect(adapter.discoverModels).toHaveBeenCalledOnce();
    expect(registryMock.syncModelsFromHealthCheck).toHaveBeenCalledWith('ollama', 'host-1', models);
  });

  it('returns a summary with correct counts', async () => {
    const newModels = [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }];
    const updatedModels = [{ model_name: 'phi3:3b', family: 'phi' }];
    const removedModels = [{ model_name: 'old:7b', family: 'llama' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({
        models: [...newModels, ...updatedModels],
        provider: 'ollama',
      }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: updatedModels,
      removed: removedModels,
    });
    const result = await discoverFromAdapter(db, adapter, 'ollama', null);
    expect(result.discovered).toBe(2);
    expect(result.new).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);
    expect(typeof result.roles_assigned).not.toBe('undefined');
    expect(typeof result.capabilities_set).not.toBe('undefined');
  });

  it('returns zero counts when adapter throws, without throwing itself', async () => {
    const adapter = {
      discoverModels: vi.fn().mockRejectedValue(new Error('Network timeout')),
    };
    const result = await discoverFromAdapter(db, adapter, 'ollama', 'host-1');
    expect(result).toEqual({
      discovered: 0,
      new: 0,
      updated: 0,
      removed: 0,
      roles_assigned: [],
      capabilities_set: 0,
    });
    expect(registryMock.syncModelsFromHealthCheck).not.toHaveBeenCalled();
  });

  it('returns zero counts when adapter returns empty models array', async () => {
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: [], provider: 'ollama' }),
    };
    const result = await discoverFromAdapter(db, adapter, 'ollama', null);
    expect(result).toEqual({
      discovered: 0,
      new: 0,
      updated: 0,
      removed: 0,
      roles_assigned: [],
      capabilities_set: 0,
    });
    expect(registryMock.syncModelsFromHealthCheck).not.toHaveBeenCalled();
  });

  it('returns zero counts when adapter returns null models', async () => {
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: null, provider: 'ollama' }),
    };
    const result = await discoverFromAdapter(db, adapter, 'ollama', null);
    expect(result.discovered).toBe(0);
    expect(result.new).toBe(0);
    expect(registryMock.syncModelsFromHealthCheck).not.toHaveBeenCalled();
  });

  it('auto-approves new models from cloud providers (deepinfra)', async () => {
    const newModels = [
      { model_name: 'Qwen/Qwen2.5-72B-Instruct', family: 'qwen2.5' },
    ];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'deepinfra' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'deepinfra', null);
    expect(registryMock.approveModel).toHaveBeenCalledWith(
      'deepinfra',
      'Qwen/Qwen2.5-72B-Instruct',
      null,
    );
  });

  it('does NOT auto-approve new models from ollama (stays pending)', async () => {
    const newModels = [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'ollama' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama', 'host-1');
    expect(registryMock.approveModel).not.toHaveBeenCalled();
  });

  it('does NOT auto-approve new models from ollama-cloud (stays pending)', async () => {
    const newModels = [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'ollama-cloud' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama-cloud', null);
    expect(registryMock.approveModel).not.toHaveBeenCalled();
  });

  it('does NOT auto-approve new models from ollama (stays pending)', async () => {
    const newModels = [{ model_name: TEST_MODELS.SMALL, family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'ollama' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama', null);
    expect(registryMock.approveModel).not.toHaveBeenCalled();
  });

  it('auto-approves new models from groq (cloud provider)', async () => {
    const newModels = [{ model_name: 'llama3-70b-8192', family: 'llama' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'groq' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'groq', null);
    expect(registryMock.approveModel).toHaveBeenCalledWith('groq', 'llama3-70b-8192', null);
  });

  it('passes hostId to registry.syncModelsFromHealthCheck', async () => {
    const models = [{ model_name: TEST_MODELS.SMALL }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models, provider: 'ollama' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({ new: [], updated: models, removed: [] });
    await discoverFromAdapter(db, adapter, 'ollama', 'my-host-id');
    expect(registryMock.syncModelsFromHealthCheck).toHaveBeenCalledWith('ollama', 'my-host-id', models);
  });

  it('uses OpenRouter scout roles with live-pass config for openrouter discovery', async () => {
    const openrouterScoutMock = {
      runOpenRouterScout: vi.fn().mockResolvedValue({
        provider: 'openrouter',
        scored: 1,
        roles_assigned: [{ role: 'default', model: 'scouted/default:free' }],
        top_models: [],
      }),
    };
    const configMock = {
      getInt: vi.fn((key, fallback) => (key === 'openrouter_discovery_smoke_limit' ? 5 : fallback)),
      getBool: vi.fn((key, fallback) => (key === 'openrouter_role_require_live_pass' ? true : fallback)),
    };
    const engine = loadEngine(registryMock, {
      openrouterScout: openrouterScoutMock,
      config: configMock,
    });
    discoverFromAdapter = engine.discoverFromAdapter;

    const models = [{ model_name: 'minimax/minimax-m2.5:free', family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models, provider: 'openrouter' }),
    };
    registryMock.syncModelsFromHealthCheck.mockReturnValue({
      new: models,
      updated: [],
      removed: [],
    });

    const result = await discoverFromAdapter(db, adapter, 'openrouter', null);

    expect(openrouterScoutMock.runOpenRouterScout).toHaveBeenCalledWith(expect.objectContaining({
      db,
      models,
      smokeLimit: 5,
      requireLivePass: true,
    }));
    expect(result.roles_assigned).toEqual([{ role: 'default', model: 'scouted/default:free' }]);
  });
});
