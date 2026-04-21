'use strict';

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const registry = require('../models/registry');

describe('models/registry persistence boundaries', () => {
  beforeAll(() => {
    setupTestDbOnly('model-registry-core');
    registry.setDb(rawDb());
  });

  afterAll(() => {
    registry.setDb(null);
    teardownTestDb();
  });

  beforeEach(() => {
    registry.setDb(rawDb());
    resetTables(['model_registry', 'model_roles']);
    vi.restoreAllMocks();
  });

  it('listModelSummaries treats SQL-like provider filters as exact data', () => {
    const maliciousProvider = "ollama' OR 1=1 --";
    registry.registerModel({
      provider: 'ollama',
      modelName: 'test-model-registry-core-unrelated',
      sizeBytes: 100,
    });
    registry.registerModel({
      provider: maliciousProvider,
      modelName: 'test-model-registry-core-provider-data',
      sizeBytes: 200,
    });

    const rows = registry.listModelSummaries({ provider: maliciousProvider });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: maliciousProvider,
      model_name: 'test-model-registry-core-provider-data',
    });
  });

  it('assignModelRole stores SQL-like model names as data without altering registry rows', () => {
    const maliciousModelName = "test-model-registry-core-target'; DELETE FROM model_registry; --";
    registry.registerModel({
      provider: 'ollama',
      modelName: maliciousModelName,
      sizeBytes: 300,
    });
    registry.registerModel({
      provider: 'ollama',
      modelName: 'test-model-registry-core-still-present',
      sizeBytes: 100,
    });

    registry.assignModelRole('ollama', 'quality', maliciousModelName);

    const roleRow = rawDb()
      .prepare('SELECT provider, role, model_name FROM model_roles WHERE provider = ? AND role = ?')
      .get('ollama', 'quality');
    const registryCount = rawDb().prepare('SELECT COUNT(*) AS count FROM model_registry').get().count;
    const assigned = registry
      .listModelSummaries({ provider: 'ollama' })
      .find((row) => row.model_name === maliciousModelName);

    expect(roleRow).toEqual({
      provider: 'ollama',
      role: 'quality',
      model_name: maliciousModelName,
    });
    expect(registryCount).toBe(2);
    expect(assigned).toMatchObject({
      model_name: maliciousModelName,
      role: 'quality',
    });
  });
});
