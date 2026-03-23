'use strict';

/**
 * Unit Tests: discovery-engine - orchestrates model discovery + post-processing
 *
 * Uses:
 *   - In-memory SQLite DB for runPostDiscovery tests (real applyHeuristicCapabilities
 *     and assignRolesForProvider need the actual tables)
 *   - vi.mock for discoverFromAdapter tests against the registry
 */

const Database = require('better-sqlite3');

vi.mock('../models/registry', () => ({
  syncModelsFromHealthCheck: vi.fn(),
  approveModel: vi.fn(),
}));

const { runPostDiscovery, discoverFromAdapter } = require('../discovery/discovery-engine');
const registry = require('../models/registry');

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

describe('runPostDiscovery', () => {
  it('calls applyHeuristicCapabilities for new models with a known family', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', 'qwen3:8b', 8);

    const syncResult = {
      new: [{ model_name: 'qwen3:8b', family: 'qwen3' }],
    };

    const result = runPostDiscovery(db, 'ollama', syncResult);

    const row = db.prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get('qwen3:8b');
    expect(row).toBeDefined();
    expect(row.capability_source).toBe('heuristic');
    expect(row.cap_hashline).toBe(1); // qwen3 has hashline=true
    expect(result.capabilities_set).toBe(1);
  });

  it('returns { capabilities_set, roles_assigned } with correct shape', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', 'qwen3:8b', 8);

    const syncResult = {
      new: [{ model_name: 'qwen3:8b', family: 'qwen3' }],
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
      new: [{ model_name: 'qwen3:8b', family: 'qwen3' }],
    };
    expect(() => runPostDiscovery(brokenDb, 'ollama', syncResult)).not.toThrow();
  });

  it('auto-assigns roles for the provider after processing new models', () => {
    const db = makeDb();
    seedApprovedModel(db, 'ollama', 'qwen3-coder:30b', 30);
    const syncResult = {
      new: [{ model_name: 'qwen3-coder:30b', family: 'qwen3' }],
    };
    const result = runPostDiscovery(db, 'ollama', syncResult);
    expect(Array.isArray(result.roles_assigned)).toBe(true);
    const roles = result.roles_assigned.map(r => r.role);
    expect(roles).toContain('default');
  });

  it('returns roles_assigned=[] when no approved models are in the registry', () => {
    const db = makeDb();
    const syncResult = {
      new: [{ model_name: 'qwen3:8b', family: 'qwen3' }],
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
});

// ---------------------------------------------------------------------------
// discoverFromAdapter - uses mocked registry
// ---------------------------------------------------------------------------

describe('discoverFromAdapter', () => {
  let db;

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      prepare: () => ({
        all: () => [],
        get: () => null,
        run: () => ({}),
      }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: [],
      updated: [],
      removed: [],
    });
  });

  it('calls adapter.discoverModels() and feeds models to registry', async () => {
    const models = [
      { model_name: 'qwen3:8b', family: 'qwen3' },
      { model_name: 'llama3:7b', family: 'llama' },
    ];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models, provider: 'ollama' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: models,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama', 'host-1');
    expect(adapter.discoverModels).toHaveBeenCalledOnce();
    expect(registry.syncModelsFromHealthCheck).toHaveBeenCalledWith('ollama', 'host-1', models);
  });

  it('returns a summary with correct counts', async () => {
    const newModels = [{ model_name: 'qwen3:8b', family: 'qwen3' }];
    const updatedModels = [{ model_name: 'phi3:3b', family: 'phi' }];
    const removedModels = [{ model_name: 'old:7b', family: 'llama' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({
        models: [...newModels, ...updatedModels],
        provider: 'ollama',
      }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
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
    expect(registry.syncModelsFromHealthCheck).not.toHaveBeenCalled();
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
    expect(registry.syncModelsFromHealthCheck).not.toHaveBeenCalled();
  });

  it('returns zero counts when adapter returns null models', async () => {
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: null, provider: 'ollama' }),
    };
    const result = await discoverFromAdapter(db, adapter, 'ollama', null);
    expect(result.discovered).toBe(0);
    expect(result.new).toBe(0);
    expect(registry.syncModelsFromHealthCheck).not.toHaveBeenCalled();
  });

  it('auto-approves new models from cloud providers (deepinfra)', async () => {
    const newModels = [
      { model_name: 'Qwen/Qwen2.5-72B-Instruct', family: 'qwen2.5' },
    ];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'deepinfra' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'deepinfra', null);
    expect(registry.approveModel).toHaveBeenCalledWith(
      'deepinfra',
      'Qwen/Qwen2.5-72B-Instruct',
      null,
    );
  });

  it('does NOT auto-approve new models from ollama (stays pending)', async () => {
    const newModels = [{ model_name: 'qwen3:8b', family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'ollama' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama', 'host-1');
    expect(registry.approveModel).not.toHaveBeenCalled();
  });

  it('does NOT auto-approve new models from ollama-cloud (stays pending)', async () => {
    const newModels = [{ model_name: 'qwen3:8b', family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'ollama-cloud' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'ollama-cloud', null);
    expect(registry.approveModel).not.toHaveBeenCalled();
  });

  it('does NOT auto-approve new models from hashline-ollama (stays pending)', async () => {
    const newModels = [{ model_name: 'qwen3:8b', family: 'qwen3' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'hashline-ollama' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'hashline-ollama', null);
    expect(registry.approveModel).not.toHaveBeenCalled();
  });

  it('auto-approves new models from groq (cloud provider)', async () => {
    const newModels = [{ model_name: 'llama3-70b-8192', family: 'llama' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models: newModels, provider: 'groq' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({
      new: newModels,
      updated: [],
      removed: [],
    });
    await discoverFromAdapter(db, adapter, 'groq', null);
    expect(registry.approveModel).toHaveBeenCalledWith('groq', 'llama3-70b-8192', null);
  });

  it('passes hostId to registry.syncModelsFromHealthCheck', async () => {
    const models = [{ model_name: 'qwen3:8b' }];
    const adapter = {
      discoverModels: vi.fn().mockResolvedValue({ models, provider: 'ollama' }),
    };
    registry.syncModelsFromHealthCheck.mockReturnValue({ new: [], updated: models, removed: [] });
    await discoverFromAdapter(db, adapter, 'ollama', 'my-host-id');
    expect(registry.syncModelsFromHealthCheck).toHaveBeenCalledWith('ollama', 'my-host-id', models);
  });
});
