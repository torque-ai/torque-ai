const { randomUUID } = require('crypto');

let db;
let mod;
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

function setup() {
  ({ db } = setupTestDbOnly('tier-pref-'));
  const taskCore = require('../db/task-core');
  mod = require('../db/host-management');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  mod.setGetTask((id) => taskCore.getTask(id));
  mod.setGetProjectRoot((dir) => dir);
}

function teardown() {
  teardownTestDb();
}

function resetTables() {
  const conn = db.getDb ? db.getDb() : db.getDbInstance();
  conn.prepare('DELETE FROM ollama_hosts').run();
}

function makeHost(overrides = {}) {
  const payload = {
    id: overrides.id || `synth-host-${Math.random()}`,
    name: overrides.name || 'TierHost',
    url: overrides.url || `http://synth-tier-host-${randomUUID()}.local:11434`,
    max_concurrent: overrides.max_concurrent != null ? overrides.max_concurrent : 4,
    memory_limit_mb: overrides.memory_limit_mb || 8192,
  };
  return mod.addOllamaHost(payload);
}

function setHostModels(hostId, models, status = 'healthy') {
  mod.updateOllamaHost(hostId, {
    models_cache: JSON.stringify(models.map(m => typeof m === 'string' ? { name: m } : m)),
    models_updated_at: new Date().toISOString(),
    status,
    consecutive_failures: 0,
  });
}

function registerModelSize(modelName, parameterSizeB) {
  const conn = db.getDb ? db.getDb() : db.getDbInstance();
  conn.prepare('DELETE FROM model_registry WHERE model_name = ?').run(modelName);
  conn.prepare(`
    INSERT INTO model_registry (
      id, provider, host_id, model_name, status, first_seen_at, last_seen_at, family, parameter_size_b, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `registry-${modelName}`,
    'ollama',
    null,
    modelName,
    'approved',
    new Date().toISOString(),
    new Date().toISOString(),
    modelName.split(':')[0],
    parameterSizeB,
    'test'
  );
}

describe('tier-aware host selection', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
    const conn = db.getDb ? db.getDb() : db.getDbInstance();
    conn.prepare('DELETE FROM model_registry').run();
  });

  it('prefers quality-tier host for a quality model', () => {
    const qualityHost = makeHost({ id: 'quality-host' });
    const fastHost = makeHost({ id: 'fast-host' });

    setHostModels(qualityHost.id, [TEST_MODELS.DEFAULT]);
    setHostModels(fastHost.id, [TEST_MODELS.DEFAULT]);
    registerModelSize(TEST_MODELS.DEFAULT, 32);
    mod.setHostTierHint(qualityHost.id, 'quality');
    mod.setHostTierHint(fastHost.id, 'fast');
    mod.updateOllamaHost(qualityHost.id, { running_tasks: 1 });
    mod.updateOllamaHost(fastHost.id, { running_tasks: 0 });

    const result = mod.selectOllamaHostForModel(TEST_MODELS.DEFAULT);

    expect(result.modelTier).toBe('quality');
    expect(result.host.id).toBe('quality-host');
  });

  it('prefers fast-tier host for a fast model', () => {
    const fastHost = makeHost({ id: 'fast-selected-host' });
    const qualityHost = makeHost({ id: 'quality-avoided-host' });

    setHostModels(fastHost.id, [TEST_MODELS.FAST]);
    setHostModels(qualityHost.id, [TEST_MODELS.FAST]);
    registerModelSize(TEST_MODELS.FAST, 4);
    mod.setHostTierHint(fastHost.id, 'fast');
    mod.setHostTierHint(qualityHost.id, 'quality');
    mod.updateOllamaHost(fastHost.id, { running_tasks: 0 });
    mod.updateOllamaHost(qualityHost.id, { running_tasks: 2 });

    const result = mod.selectOllamaHostForModel(TEST_MODELS.FAST);

    expect(result.modelTier).toBe('fast');
    expect(result.host.id).toBe('fast-selected-host');
  });

  it('falls back to least-loaded host when no host matches the model tier hint', () => {
    const candidateA = makeHost({ id: 'nonmatching-tier-a' });
    const candidateB = makeHost({ id: 'nonmatching-tier-b' });

    setHostModels(candidateA.id, [TEST_MODELS.FAST]);
    setHostModels(candidateB.id, [TEST_MODELS.FAST]);
    registerModelSize(TEST_MODELS.FAST, 4);
    mod.setHostTierHint(candidateA.id, 'balanced');
    mod.setHostTierHint(candidateB.id, 'quality');
    mod.updateOllamaHost(candidateA.id, { running_tasks: 2 });
    mod.updateOllamaHost(candidateB.id, { running_tasks: 0 });

    const result = mod.selectOllamaHostForModel(TEST_MODELS.FAST);

    expect(result.host.id).toBe('nonmatching-tier-b');
    expect(result.modelTier).toBe('fast');
  });

  it('works normally when no tier hint exists for model', () => {
    const lowLoadHost = makeHost({ id: 'normal-low-load' });
    const highLoadHost = makeHost({ id: 'normal-high-load' });

    setHostModels(lowLoadHost.id, ['unlisted-model:7b']);
    setHostModels(highLoadHost.id, ['unlisted-model:7b']);
    mod.updateOllamaHost(lowLoadHost.id, { running_tasks: 0 });
    mod.updateOllamaHost(highLoadHost.id, { running_tasks: 4 });

    const result = mod.selectOllamaHostForModel('unlisted-model:7b');

    expect(result.host.id).toBe('normal-low-load');
    expect(result.modelTier).toBeNull();
  });
});
