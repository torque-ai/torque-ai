'use strict';

/**
 * Tests: registry family + parameter_size_b population on registration
 *
 * Verifies that registerModel() populates the family and parameter_size_b
 * columns after INSERT, and that updateModelLastSeen() backfills those
 * columns for pre-migration rows where they are NULL.
 */

const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { TEST_MODELS: BASE_TEST_MODELS } = require('./test-helpers');
const registry = require('../models/registry');

const TEST_MODELS = { ...BASE_TEST_MODELS, DEFAULT: 'qwen3-coder:30b' };

describe('registry — family + parameter_size_b on registration', () => {
  beforeAll(() => {
    setupTestDbOnly('registry-family-extension');
    registry.setDb(rawDb());
  });

  afterAll(() => {
    registry.setDb(null);
    teardownTestDb();
  });

  beforeEach(() => {
    registry.setDb(rawDb());
    resetTables(['model_registry']);
  });

  it(`registerModel populates family=qwen3 and parameter_size_b≈30 for ${TEST_MODELS.DEFAULT}`, () => {
    const result = registry.registerModel({
      provider: 'ollama',
      hostId: 'host-1',
      modelName: TEST_MODELS.DEFAULT,
      sizeBytes: 18556700761,
    });

    expect(result.inserted).toBe(true);
    const model = result.model;
    expect(model.family).toBe('qwen3');
    expect(model.parameter_size_b).toBeCloseTo(30, 0);
  });

  it('registerModel populates family=qwen3 and parameter_size_b≈235 for Qwen/Qwen3-235B-A22B', () => {
    const result = registry.registerModel({
      provider: 'deepinfra',
      hostId: null,
      modelName: 'Qwen/Qwen3-235B-A22B',
    });

    expect(result.inserted).toBe(true);
    const model = result.model;
    expect(model.family).toBe('qwen3');
    expect(model.parameter_size_b).toBeCloseTo(235, 0);
  });

  it('registerModel populates family=unknown for an unrecognized model name', () => {
    const result = registry.registerModel({
      provider: 'ollama',
      hostId: 'host-1',
      modelName: 'my-custom-model:latest',
    });

    expect(result.inserted).toBe(true);
    expect(result.model.family).toBe('unknown');
  });

  it('updateModelLastSeen backfills family and parameter_size_b when they are NULL on existing rows', () => {
    // Insert a model directly into DB bypassing registry (simulating pre-migration row)
    const { randomUUID } = require('crypto');
    const id = randomUUID();
    const now = new Date().toISOString();

    rawDb().prepare(`
      INSERT INTO model_registry (
        id, provider, host_id, model_name, size_bytes,
        status, first_seen_at, last_seen_at,
        family, parameter_size_b
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
    `).run(id, 'ollama', 'host-1', TEST_MODELS.DEFAULT, 18556700761, now, now);

    // Confirm columns are NULL before backfill
    const before = rawDb().prepare('SELECT family, parameter_size_b FROM model_registry WHERE id = ?').get(id);
    expect(before.family).toBeNull();
    expect(before.parameter_size_b).toBeNull();

    // updateModelLastSeen should backfill family + parameter_size_b
    const updated = registry.updateModelLastSeen(id, new Date().toISOString(), 18556700761);

    expect(updated.family).toBe('qwen3');
    expect(updated.parameter_size_b).toBeCloseTo(30, 0);
  });
});
