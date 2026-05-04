import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const HOST_CAPACITY_MODULE = '../db/host/capacity';
const WORKSTATION_MODEL_MODULE = '../workstation/model';
const MODULE_PATHS = [
  HOST_CAPACITY_MODULE,
  WORKSTATION_MODEL_MODULE,
];

let dbModule;
let db;
let hostCapacity;
let hostFns;
let workstationModelMock;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were not loaded in this test process.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function parseModels(modelsCache) {
  if (!modelsCache) return [];
  try {
    const parsed = JSON.parse(modelsCache);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readHost(hostId) {
  const row = db.prepare('SELECT * FROM ollama_hosts WHERE id = ?').get(hostId);
  if (!row) return undefined;
  return {
    ...row,
    models: parseModels(row.models_cache),
  };
}

function createHostFns() {
  const getOllamaHost = vi.fn((hostId) => readHost(hostId));
  const listOllamaHosts = vi.fn(() => db.prepare('SELECT id FROM ollama_hosts').all().map((row) => readHost(row.id)));
  const updateOllamaHost = vi.fn((hostId, updates) => {
    const keys = Object.keys(updates || {});
    if (keys.length === 0) return readHost(hostId);

    const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE ollama_hosts SET ${assignments} WHERE id = @id`).run({
      id: hostId,
      ...updates,
    });
    return readHost(hostId);
  });
  const getRunningTasksForHost = vi.fn(() => []);
  const getDatabaseConfig = vi.fn(() => null);

  return {
    getOllamaHost,
    listOllamaHosts,
    updateOllamaHost,
    getRunningTasksForHost,
    getDatabaseConfig,
  };
}

function createWorkstationModelMock(workstations = [], overrides = {}) {
  const byId = new Map(workstations.map((ws) => [ws.id, ws]));

  return {
    listWorkstations: vi.fn(() => workstations),
    getWorkstation: vi.fn((id) => byId.get(id) || null),
    tryReserveSlot: vi.fn(() => ({ acquired: true, currentLoad: 1, maxCapacity: 3 })),
    releaseSlot: vi.fn(),
    ...overrides,
  };
}

function loadHostCapacity() {
  clearModules();
  installCjsModuleMock(WORKSTATION_MODEL_MODULE, workstationModelMock);
  hostCapacity = require(HOST_CAPACITY_MODULE);
  hostCapacity.setDb(db);
  hostCapacity.setHostFns(hostFns);
}

function insertHost(overrides = {}) {
  const values = {
    id: 'host1',
    name: 'TestHost',
    url: 'http://localhost:11434',
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    max_concurrent: 3,
    models_cache: '[]',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, models_cache, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.id,
    values.name,
    values.url,
    values.enabled,
    values.status,
    values.running_tasks,
    values.max_concurrent,
    values.models_cache,
    new Date().toISOString(),
  );

  const extraUpdates = {};
  for (const [key, value] of Object.entries(values)) {
    if (['id', 'name', 'url', 'enabled', 'status', 'running_tasks', 'max_concurrent', 'models_cache'].includes(key)) {
      continue;
    }
    extraUpdates[key] = value;
  }

  if (Object.keys(extraUpdates).length > 0) {
    hostFns.updateOllamaHost(values.id, extraUpdates);
  }

  return readHost(values.id);
}

describe('db/host/capacity', () => {
  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('host-capacity'));
    db = dbModule.getDbInstance();
    workstationModelMock = createWorkstationModelMock();
    hostFns = createHostFns();
    loadHostCapacity();
    insertHost();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    teardownTestDb();
    clearModules();
  });

  it('returns the default VRAM overhead factor and accepts a valid configured value', () => {
    expect(hostCapacity.getVramOverheadFactor()).toBe(0.95);
    expect(hostFns.getDatabaseConfig).toHaveBeenCalledWith('vram_overhead_factor');

    hostFns.getDatabaseConfig.mockReturnValue('0.8');

    expect(hostCapacity.getVramOverheadFactor()).toBe(0.8);
  });

  it('acquires a slot under capacity and rejects reservations at max_concurrent', () => {
    db.prepare('UPDATE ollama_hosts SET running_tasks = 1 WHERE id = ?').run('host1');

    const acquired = hostCapacity.tryReserveHostSlot('host1');

    expect(acquired).toEqual({ acquired: true, currentLoad: 2, maxCapacity: 3 });
    expect(readHost('host1').running_tasks).toBe(2);

    db.prepare('UPDATE ollama_hosts SET running_tasks = 3 WHERE id = ?').run('host1');

    const rejected = hostCapacity.tryReserveHostSlot('host1');

    expect(rejected).toEqual({ acquired: false, currentLoad: 3, maxCapacity: 3 });
    expect(readHost('host1').running_tasks).toBe(3);
  });

  it('blocks reservation when VRAM budget would be exceeded', () => {
    workstationModelMock = createWorkstationModelMock([{
      id: 'ws1',
      name: 'GPU Workstation',
      host: 'localhost',
      gpu_vram_mb: 4096,
    }]);
    hostFns = createHostFns();
    loadHostCapacity();

    hostFns.getRunningTasksForHost.mockReturnValue([{ id: 'task-1', model: 'loaded-model:7b' }]);
    hostFns.getDatabaseConfig.mockReturnValue('0.95');
    hostFns.updateOllamaHost.mockClear();
    db.prepare(`
      UPDATE ollama_hosts
      SET running_tasks = 1, models_cache = ?
      WHERE id = ?
    `).run(JSON.stringify([
      { name: 'loaded-model:7b', size: 3 * 1024 * 1024 * 1024 },
      { name: 'requested-model:7b', size: 2 * 1024 * 1024 * 1024 },
    ]), 'host1');

    const result = hostCapacity.tryReserveHostSlot('host1', 'requested-model:7b');

    expect(result.acquired).toBe(false);
    expect(result.vramGated).toBe(true);
    expect(result.currentLoad).toBe(1);
    expect(result.maxCapacity).toBe(3);
    expect(result.loadedModels).toEqual(['loaded-model:7b']);
    expect(result.vramReason).toContain('VRAM budget exceeded');
    expect(workstationModelMock.tryReserveSlot).not.toHaveBeenCalled();
    expect(readHost('host1').running_tasks).toBe(1);
  });

  it('releases host slots and clamps running_tasks at zero', () => {
    db.prepare('UPDATE ollama_hosts SET running_tasks = 2 WHERE id = ?').run('host1');

    hostCapacity.releaseHostSlot('host1');
    expect(readHost('host1').running_tasks).toBe(1);

    hostCapacity.releaseHostSlot('host1');
    hostCapacity.releaseHostSlot('host1');

    expect(readHost('host1').running_tasks).toBe(0);
  });

  it('increments the running task count in the database', () => {
    hostCapacity.incrementHostTasks('host1');

    expect(readHost('host1').running_tasks).toBe(1);
  });

  it('records host model usage and reports warmth until the warm window expires', () => {
    vi.useFakeTimers();
    const now = new Date('2026-04-05T12:00:00.000Z');
    vi.setSystemTime(now);

    hostCapacity.recordHostModelUsage('host1', 'llama3:8b');

    const stored = readHost('host1');
    const warm = hostCapacity.isHostModelWarm('host1', 'llama3:8b');

    expect(stored.last_model_used).toBe('llama3:8b');
    expect(stored.model_loaded_at).toBe(now.toISOString());
    expect(warm).toMatchObject({ isWarm: true, lastUsedSeconds: 0 });

    vi.advanceTimersByTime(6 * 60 * 1000);

    const cold = hostCapacity.isHostModelWarm('host1', 'llama3:8b');

    expect(cold.isWarm).toBe(false);
    expect(cold.lastUsedSeconds).toBeGreaterThanOrEqual(360);
  });

  it('records a healthy host check and persists status fields plus model cache', () => {
    vi.useFakeTimers();
    const now = new Date('2026-04-05T13:30:00.000Z');
    vi.setSystemTime(now);

    db.prepare('UPDATE ollama_hosts SET status = ?, consecutive_failures = ? WHERE id = ?')
      .run('degraded', 2, 'host1');

    const result = hostCapacity.recordHostHealthCheck('host1', true, [{ name: 'phi4-mini' }]);

    expect(hostFns.updateOllamaHost).toHaveBeenCalledWith('host1', expect.objectContaining({
      last_health_check: now.toISOString(),
      status: 'healthy',
      consecutive_failures: 0,
      last_healthy: now.toISOString(),
      models_cache: JSON.stringify([{ name: 'phi4-mini' }]),
      models_updated_at: now.toISOString(),
    }));
    expect(result).toMatchObject({
      id: 'host1',
      status: 'healthy',
      consecutive_failures: 0,
      last_health_check: now.toISOString(),
      last_healthy: now.toISOString(),
      models: [{ name: 'phi4-mini' }],
    });
  });

  it('reports healthy host availability based on enabled healthy hosts with spare capacity', () => {
    expect(hostCapacity.hasHealthyOllamaHost()).toBe(true);

    db.prepare('UPDATE ollama_hosts SET status = ? WHERE id = ?').run('down', 'host1');

    expect(hostCapacity.hasHealthyOllamaHost()).toBe(false);
  });
});
