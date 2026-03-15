'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const providerCapabilities = require('../db/provider-capabilities');
const providerPerformance = require('../db/provider-performance');

const MODULE_PATH = require.resolve('../execution/slot-pull-scheduler');

let ctx;
let db;
let slotPull;
let startTask;

function rawDb() {
  return db.getDbInstance();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadSlotPullScheduler() {
  delete require.cache[MODULE_PATH];
  slotPull = require('../execution/slot-pull-scheduler');
  startTask = vi.fn(() => ({ started: true }));
  slotPull.init({ db, startTask });
}

function setProviderConfig(provider, overrides = {}) {
  const current = db.getProvider(provider);
  if (!current) {
    throw new Error(`Missing provider config for ${provider}`);
  }

  const capabilityTags = overrides.capabilityTags ?? parseJson(current.capability_tags, []);
  const qualityBand = overrides.qualityBand ?? current.quality_band;
  const enabled = overrides.enabled ?? current.enabled;
  const priority = overrides.priority ?? current.priority;
  const maxConcurrent = overrides.maxConcurrent ?? current.max_concurrent;

  rawDb().prepare(`
    UPDATE provider_config
    SET enabled = ?,
        priority = ?,
        max_concurrent = ?,
        capability_tags = ?,
        quality_band = ?
    WHERE provider = ?
  `).run(
    enabled ? 1 : 0,
    priority,
    maxConcurrent,
    JSON.stringify(capabilityTags),
    qualityBand,
    provider,
  );
}

function configureProviders(configByProvider) {
  const enabledProviders = new Set(Object.keys(configByProvider));
  for (const provider of db.listProviders()) {
    if (enabledProviders.has(provider.provider)) {
      setProviderConfig(provider.provider, { enabled: true, ...configByProvider[provider.provider] });
      continue;
    }

    setProviderConfig(provider.provider, { enabled: false });
  }
}

function createSlotPullTask(overrides = {}) {
  const {
    id,
    priority = 0,
    createdAt = null,
    metadata = {},
  } = overrides;

  db.createTask({
    id,
    status: 'queued',
    task_description: `Slot-pull integration task ${id}`,
    working_directory: ctx.testDir,
    provider: 'codex',
    priority,
    metadata,
  });

  rawDb().prepare(`
    UPDATE tasks
    SET provider = NULL,
        status = 'queued',
        priority = ?,
        metadata = ?,
        created_at = COALESCE(?, created_at)
    WHERE id = ?
  `).run(
    priority,
    JSON.stringify(metadata),
    createdAt,
    id,
  );

  return id;
}

function createPresetProviderTask(overrides = {}) {
  const {
    id,
    provider,
    status = 'queued',
    priority = 0,
    createdAt = null,
    metadata = {},
  } = overrides;

  db.createTask({
    id,
    status,
    task_description: `Preset provider integration task ${id}`,
    working_directory: ctx.testDir,
    provider,
    priority,
    metadata,
  });

  rawDb().prepare(`
    UPDATE tasks
    SET provider = ?,
        status = ?,
        priority = ?,
        metadata = ?,
        created_at = COALESCE(?, created_at)
    WHERE id = ?
  `).run(
    provider,
    status,
    priority,
    JSON.stringify(metadata),
    createdAt,
    id,
  );

  return id;
}

function listAssignmentsByPrefix(prefix) {
  return rawDb().prepare(`
    SELECT id, provider, status
    FROM tasks
    WHERE id LIKE ?
    ORDER BY id ASC
  `).all(`${prefix}%`);
}

function countByProvider(rows) {
  return rows.reduce((counts, row) => {
    const key = row.provider === null ? 'unassigned' : row.provider;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

describe('slot-pull scheduler integration', () => {
  beforeEach(() => {
    ctx = setupE2eDb('slot-pull-integ');
    db = ctx.db;
    db.setConfig('scheduling_mode', 'slot-pull');
    loadSlotPullScheduler();
  });

  afterEach(async () => {
    if (slotPull) {
      slotPull.stopHeartbeat();
    }
    providerCapabilities.setDb(null);
    providerPerformance.setDb(null);
    delete require.cache[MODULE_PATH];
    vi.restoreAllMocks();
    if (ctx) {
      await teardownE2eDb(ctx);
    }
    ctx = null;
    db = null;
    slotPull = null;
    startTask = null;
  });

  it('spreads broadly eligible tasks across multiple providers in a single pass', () => {
    configureProviders({
      codex: {
        priority: 1,
        maxConcurrent: 4,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      },
      deepinfra: {
        priority: 2,
        maxConcurrent: 3,
        capabilityTags: ['reasoning', 'large_context', 'code_review'],
        qualityBand: 'B',
      },
      ollama: {
        priority: 3,
        maxConcurrent: 3,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      },
    });

    const taskIds = [];
    for (let index = 1; index <= 10; index += 1) {
      const id = `spread-${String(index).padStart(2, '0')}`;
      taskIds.push(id);
      createSlotPullTask({
        id,
        priority: 100 - index,
        metadata: {
          eligible_providers: ['codex', 'deepinfra', 'ollama'],
          capability_requirements: [],
          quality_tier: 'normal',
        },
      });
    }

    expect(slotPull.runSlotPullPass()).toEqual({ assigned: 10, skipped: 0 });

    const assignments = listAssignmentsByPrefix('spread-');
    const counts = countByProvider(assignments);

    expect(assignments).toHaveLength(10);
    expect(counts).toEqual({
      codex: 4,
      deepinfra: 3,
      ollama: 3,
    });
    expect(startTask).toHaveBeenCalledTimes(10);
    expect(startTask.mock.calls.map(([taskId]) => taskId).sort()).toEqual(taskIds.sort());
  });

  it('keeps complex tasks on band A/B providers and leaves excess work unassigned instead of using band C', () => {
    configureProviders({
      codex: {
        priority: 1,
        maxConcurrent: 2,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      },
      deepinfra: {
        priority: 2,
        maxConcurrent: 2,
        capabilityTags: ['reasoning', 'large_context', 'code_review'],
        qualityBand: 'B',
      },
      ollama: {
        priority: 3,
        maxConcurrent: 5,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      },
    });

    for (let index = 1; index <= 5; index += 1) {
      createSlotPullTask({
        id: `complex-${String(index).padStart(2, '0')}`,
        priority: 100 - index,
        metadata: {
          eligible_providers: ['codex', 'deepinfra', 'ollama'],
          capability_requirements: ['reasoning'],
          quality_tier: 'complex',
        },
      });
    }

    expect(slotPull.runSlotPullPass()).toEqual({ assigned: 4, skipped: 0 });

    const assignments = listAssignmentsByPrefix('complex-');
    const counts = countByProvider(assignments);

    expect(assignments).toHaveLength(5);
    expect(counts).toEqual({
      codex: 2,
      deepinfra: 2,
      unassigned: 1,
    });
    expect(assignments.some((task) => task.provider === 'ollama')).toBe(false);
    expect(startTask).toHaveBeenCalledTimes(4);
  });

  it('does not reroute preset user-override tasks', () => {
    configureProviders({
      codex: {
        priority: 1,
        maxConcurrent: 1,
        capabilityTags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
        qualityBand: 'A',
      },
      deepinfra: {
        priority: 2,
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'large_context', 'code_review'],
        qualityBand: 'B',
      },
      ollama: {
        priority: 3,
        maxConcurrent: 1,
        capabilityTags: ['reasoning', 'code_review'],
        qualityBand: 'C',
      },
    });

    createPresetProviderTask({
      id: 'override-locked',
      provider: 'codex',
      metadata: {
        eligible_providers: ['codex'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
        user_provider_override: true,
      },
    });

    createSlotPullTask({
      id: 'regular-deepinfra',
      metadata: {
        eligible_providers: ['deepinfra'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
      },
    });

    createSlotPullTask({
      id: 'regular-ollama',
      metadata: {
        eligible_providers: ['ollama'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
      },
    });

    // All 3 tasks get assigned: override stays on codex, others go to their providers
    expect(slotPull.runSlotPullPass()).toEqual({ assigned: 3, skipped: 0 });

    const overrideTask = db.getTask('override-locked');
    const regularDeepinfra = db.getTask('regular-deepinfra');
    const regularOllama = db.getTask('regular-ollama');

    // Override task stays on its explicitly requested provider (codex)
    expect(overrideTask.provider).toBe('codex');
    expect(overrideTask.metadata.user_provider_override).toBe(true);
    expect(regularDeepinfra.provider).toBe('deepinfra');
    expect(regularOllama.provider).toBe('ollama');
    expect(startTask).toHaveBeenCalledTimes(3);
    expect(startTask.mock.calls.map(([taskId]) => taskId).sort()).toEqual([
      'override-locked',
      'regular-deepinfra',
      'regular-ollama',
    ]);
  });

  it('requeues failed tasks with retry tracking and keeps provider eligible until retries exhausted', () => {
    // Set deepinfra max_retries to 2
    rawDb().prepare('UPDATE provider_config SET max_retries = 2 WHERE provider = ?').run('deepinfra');

    const taskId = createPresetProviderTask({
      id: 'requeue-after-failure',
      provider: 'deepinfra',
      status: 'running',
      metadata: {
        eligible_providers: ['codex', 'deepinfra', 'ollama'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
      },
    });

    // First failure: provider still eligible (1/2 retries used)
    const result1 = slotPull.requeueAfterFailure(taskId, 'deepinfra');
    expect(result1.requeued).toBe(true);
    expect(result1.providerExhausted).toBe(false);

    let task = db.getTask(taskId);
    expect(task.provider).toBeNull();
    expect(task.status).toBe('queued');
    expect(task.metadata.eligible_providers).toEqual(['codex', 'deepinfra', 'ollama']);
    expect(task.metadata._provider_retry_counts).toEqual({ deepinfra: 1 });

    // Simulate second run on deepinfra
    rawDb().prepare("UPDATE tasks SET provider = 'deepinfra', status = 'running' WHERE id = ?").run(taskId);

    // Second failure: retries exhausted, provider removed
    const result2 = slotPull.requeueAfterFailure(taskId, 'deepinfra');
    expect(result2.requeued).toBe(true);
    expect(result2.providerExhausted).toBe(true);

    task = db.getTask(taskId);
    expect(task.provider).toBeNull();
    expect(task.status).toBe('queued');
    expect(task.metadata.eligible_providers).toEqual(['codex', 'ollama']);
    expect(task.metadata._failed_providers).toEqual(['deepinfra']);
    expect(task.metadata._provider_retry_counts).toEqual({ deepinfra: 2 });
  });
});
