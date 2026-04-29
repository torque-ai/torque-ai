'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSharedFactoryStore } = require('../db/shared-factory-store');

const SCHEDULER_PATH = require.resolve('../execution/slot-pull-scheduler');
const FINALIZER_PATH = require.resolve('../execution/task-finalizer');

function createMockDb({ providers, tasks, maxConcurrent = 8 }) {
  const providerRows = providers.map(provider => ({
    provider,
    enabled: true,
    max_concurrent: maxConcurrent,
    max_retries: 2,
    capability_tags: JSON.stringify(['file_creation', 'file_edit', 'multi_file', 'reasoning', 'code_review']),
    quality_band: 'A',
  }));

  return {
    listProviders: vi.fn(() => providerRows),
    getProvider: vi.fn(provider => providerRows.find(row => row.provider === provider) || null),
    getRunningCountByProvider: vi.fn(provider => tasks.filter(task => task.status === 'running' && task.provider === provider).length),
    listQueuedTasksLightweight: vi.fn(limit => tasks
      .filter(task => task.status === 'queued')
      .sort((left, right) => (right.workflow_priority || 0) - (left.workflow_priority || 0)
        || (right.priority || 0) - (left.priority || 0)
        || String(left.created_at).localeCompare(String(right.created_at)))
      .slice(0, limit)),
    claimSlotAtomic: vi.fn((taskId, provider) => {
      const task = tasks.find(row => row.id === taskId);
      if (!task || task.status !== 'queued') return false;
      task.provider = provider;
      return true;
    }),
    getTask: vi.fn(taskId => {
      const task = tasks.find(row => row.id === taskId);
      return task ? { ...task } : null;
    }),
    clearProviderIfNotRunning: vi.fn(taskId => {
      const task = tasks.find(row => row.id === taskId);
      if (!task || task.status === 'running') return false;
      task.provider = null;
      return true;
    }),
    listOllamaHosts: vi.fn(() => []),
    getConfig: vi.fn(() => null),
  };
}

function makeTasks(prefix, count, priority, eligibleProvider = 'codex') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    status: 'queued',
    provider: null,
    priority,
    workflow_priority: 0,
    metadata: JSON.stringify({
      eligible_providers: [eligibleProvider],
      capability_requirements: [],
      quality_tier: 'normal',
    }),
    created_at: new Date(2026, 3, 29, 10, index).toISOString(),
  }));
}

function loadScheduler({ db, store, projectId, projectName, startTask }) {
  delete require.cache[SCHEDULER_PATH];
  const scheduler = require('../execution/slot-pull-scheduler');
  scheduler.init({
    db,
    sharedFactoryStore: store,
    projectId,
    projectName,
    startTask,
  });
  return scheduler;
}

describe('shared Codex resource arbitration', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-shared-arbitration-'));
    store = createSharedFactoryStore({ dbPath: path.join(tempDir, 'shared.db') });
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    vi.restoreAllMocks();
  });

  it('distributes repeated Codex starts by queued priority demand', () => {
    const torqueTasks = makeTasks('torque', 8, 10);
    const spudgetTasks = makeTasks('spudget', 4, 10);
    const torqueDb = createMockDb({ providers: ['codex'], tasks: torqueTasks, maxConcurrent: 12 });
    const spudgetDb = createMockDb({ providers: ['codex'], tasks: spudgetTasks, maxConcurrent: 12 });
    const torqueStarts = [];
    const spudgetStarts = [];

    let scheduler = loadScheduler({
      db: torqueDb,
      store,
      projectId: 'torque-public',
      projectName: 'torque-public',
      startTask: vi.fn(taskId => {
        torqueStarts.push(taskId);
        torqueTasks.find(task => task.id === taskId).status = 'running';
        return { status: 'running' };
      }),
    });
    scheduler.publishLocalCodexDemand();

    scheduler = loadScheduler({
      db: spudgetDb,
      store,
      projectId: 'SpudgetBooks',
      projectName: 'SpudgetBooks',
      startTask: vi.fn(taskId => {
        spudgetStarts.push(taskId);
        spudgetTasks.find(task => task.id === taskId).status = 'running';
        return { status: 'running' };
      }),
    });
    scheduler.publishLocalCodexDemand();

    for (let pass = 0; pass < 8; pass++) {
      loadScheduler({
        db: torqueDb,
        store,
        projectId: 'torque-public',
        projectName: 'torque-public',
        startTask: vi.fn(taskId => {
          torqueStarts.push(taskId);
          torqueTasks.find(task => task.id === taskId).status = 'running';
          return { status: 'running' };
        }),
      }).runSlotPullPass();

      loadScheduler({
        db: spudgetDb,
        store,
        projectId: 'SpudgetBooks',
        projectName: 'SpudgetBooks',
        startTask: vi.fn(taskId => {
          spudgetStarts.push(taskId);
          spudgetTasks.find(task => task.id === taskId).status = 'running';
          return { status: 'running' };
        }),
      }).runSlotPullPass();
    }

    expect(torqueStarts).toHaveLength(8);
    expect(spudgetStarts).toHaveLength(4);
    expect(store.listActiveResourceClaims({ provider: 'codex' })).toHaveLength(12);
  });

  it('lets a lone project use every open local Codex slot', () => {
    const tasks = makeTasks('solo', 4, 10);
    const db = createMockDb({ providers: ['codex'], tasks, maxConcurrent: 4 });
    const starts = [];

    const scheduler = loadScheduler({
      db,
      store,
      projectId: 'torque-public',
      projectName: 'torque-public',
      startTask: vi.fn(taskId => {
        starts.push(taskId);
        tasks.find(task => task.id === taskId).status = 'running';
        return { status: 'running' };
      }),
    });

    expect(scheduler.runSlotPullPass()).toEqual({ assigned: 4, skipped: 0 });
    expect(starts).toHaveLength(4);
  });

  it('does not arbitrate explicit non-Codex providers', () => {
    store.upsertProjectDemand({
      project_id: 'other-project',
      project_name: 'Other Project',
      provider: 'codex',
      queued_count: 10,
      priority_sum: 1000,
    });
    store.claimResource({
      project_id: 'other-project',
      provider: 'codex',
      task_id: 'other-active-1',
    });

    const tasks = makeTasks('ollama', 1, 10, 'ollama');
    const db = createMockDb({ providers: ['codex', 'ollama'], tasks, maxConcurrent: 1 });
    const starts = [];

    const scheduler = loadScheduler({
      db,
      store,
      projectId: 'torque-public',
      projectName: 'torque-public',
      startTask: vi.fn(taskId => {
        starts.push(taskId);
        tasks.find(task => task.id === taskId).status = 'running';
        return { status: 'running' };
      }),
    });

    expect(scheduler.runSlotPullPass()).toEqual({ assigned: 1, skipped: 0 });
    expect(starts).toEqual(['ollama-1']);
    expect(store.listActiveResourceClaims({ provider: 'ollama' })).toHaveLength(0);
  });

  it('releases shared Codex claims when finalization reaches a terminal status', async () => {
    const taskId = 'finalize-me';
    store.claimResource({
      project_id: 'torque-public',
      provider: 'codex',
      task_id: taskId,
    });

    const task = {
      id: taskId,
      status: 'running',
      provider: 'codex',
      task_description: 'Finalize shared claim',
      metadata: JSON.stringify({ project_id: 'torque-public' }),
      output: '',
      error_output: '',
      started_at: new Date(Date.now() - 1000).toISOString(),
    };
    const db = {
      getTask: vi.fn(() => ({ ...task })),
      updateTaskStatus: vi.fn((_id, status, fields) => {
        Object.assign(task, fields, { status, completed_at: new Date().toISOString() });
        return { ...task };
      }),
    };

    delete require.cache[FINALIZER_PATH];
    const finalizer = require('../execution/task-finalizer');
    finalizer.init({
      db,
      sharedFactoryStore: store,
      sanitizeTaskOutput: value => value || '',
      extractModifiedFiles: () => [],
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleNoFileChangeDetection: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(),
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
    });

    await finalizer.finalizeTask(taskId, { exitCode: 0, output: 'done' });

    const claim = store.getResourceClaim({
      project_id: 'torque-public',
      provider: 'codex',
      task_id: taskId,
    });
    expect(claim.status).toBe('released');
    expect(claim.release_reason).toBe('completed');
    finalizer._testing.resetForTest();
  });
});
