const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-tier-pref-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  }
  db.resetForTest(templateBuffer);
  mod = require('../db/host-management');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  mod.setGetTask((id) => db.getTask(id));
  mod.setGetProjectRoot((dir) => dir);
}

function teardown() {
  if (db) {
    try { db.close(); } catch {}
  }
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
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

describe('tier-aware host selection', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
  });

  it('prefers quality-tier host for a quality model', () => {
    const qualityHost = makeHost({ id: 'quality-host' });
    const fastHost = makeHost({ id: 'fast-host' });

    setHostModels(qualityHost.id, ['qwen2.5-coder:32b']);
    setHostModels(fastHost.id, ['qwen2.5-coder:32b']);
    mod.setHostTierHint(qualityHost.id, 'quality');
    mod.setHostTierHint(fastHost.id, 'fast');
    mod.updateOllamaHost(qualityHost.id, { running_tasks: 1 });
    mod.updateOllamaHost(fastHost.id, { running_tasks: 0 });

    const result = mod.selectOllamaHostForModel('qwen2.5-coder:32b');

    expect(result.modelTier).toBe('quality');
    expect(result.host.id).toBe('quality-host');
  });

  it('prefers fast-tier host for a fast model', () => {
    const fastHost = makeHost({ id: 'fast-selected-host' });
    const qualityHost = makeHost({ id: 'quality-avoided-host' });

    setHostModels(fastHost.id, ['gemma3:4b']);
    setHostModels(qualityHost.id, ['gemma3:4b']);
    mod.setHostTierHint(fastHost.id, 'fast');
    mod.setHostTierHint(qualityHost.id, 'quality');
    mod.updateOllamaHost(fastHost.id, { running_tasks: 0 });
    mod.updateOllamaHost(qualityHost.id, { running_tasks: 2 });

    const result = mod.selectOllamaHostForModel('gemma3:4b');

    expect(result.modelTier).toBe('fast');
    expect(result.host.id).toBe('fast-selected-host');
  });

  it('falls back to least-loaded host when no host matches the model tier hint', () => {
    const candidateA = makeHost({ id: 'nonmatching-tier-a' });
    const candidateB = makeHost({ id: 'nonmatching-tier-b' });

    setHostModels(candidateA.id, ['gemma3:4b']);
    setHostModels(candidateB.id, ['gemma3:4b']);
    mod.setHostTierHint(candidateA.id, 'balanced');
    mod.setHostTierHint(candidateB.id, 'quality');
    mod.updateOllamaHost(candidateA.id, { running_tasks: 2 });
    mod.updateOllamaHost(candidateB.id, { running_tasks: 0 });

    const result = mod.selectOllamaHostForModel('gemma3:4b');

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
