import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const taskCore = require('../db/task-core');
const taskStartup = require('../execution/task-startup');

let originalStatSync;

beforeEach(() => {
  setupTestDbOnly('preflight-fail-fast');
  originalStatSync = fs.statSync;
  let acceptedSyntheticMissingDir = false;
  vi.spyOn(fs, 'statSync').mockImplementation((target) => {
    if (String(target).includes('sched-missing-')) {
      if (!acceptedSyntheticMissingDir) {
        acceptedSyntheticMissingDir = true;
        return { isDirectory: () => true };
      }
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    }
    return originalStatSync.call(fs, target);
  });
  taskStartup.init({
    db: taskCore,
    dashboard: { notifyTaskUpdated: vi.fn() },
    serverConfig: {
      get: vi.fn(() => '0'),
      getBool: vi.fn(() => false),
    },
    providerRegistry: {
      isKnownProvider: vi.fn(() => true),
      isApiProvider: vi.fn(() => false),
      getProviderInstance: vi.fn(() => null),
    },
    gpuMetrics: { getPressureLevel: vi.fn(() => 'normal') },
    runningProcesses: new Map(),
    pendingRetryTimeouts: new Map(),
    parseTaskMetadata: vi.fn((metadata) => metadata || {}),
    getTaskContextTokenEstimate: vi.fn(() => 0),
    safeUpdateTaskStatus: taskCore.updateTaskStatus,
    resolveProviderRouting: vi.fn((task) => ({ provider: task.provider || 'codex' })),
    failTaskForInvalidProvider: vi.fn(() => 'Unknown provider'),
    getProviderSlotLimits: vi.fn(() => ({
      providerLimit: 1,
      providerGroup: [],
      categoryLimit: 10,
      categoryProviderGroup: [],
    })),
    getEffectiveGlobalMaxConcurrent: vi.fn(() => 10),
    spawnAndTrackProcess: vi.fn(() => ({ queued: false, started: true })),
    buildClaudeCliCommand: vi.fn(),
    buildCodexCommand: vi.fn(),
    buildFileContext: vi.fn(),
    resolveFileReferences: vi.fn(() => ({ resolved: [] })),
    executeOllamaTask: vi.fn(),
    executeApiProvider: vi.fn(),
    evaluateTaskPreExecutePolicy: vi.fn(() => ({ blocked: false })),
    getPolicyBlockReason: vi.fn(() => 'policy blocked'),
    cancelTask: vi.fn(),
    processQueue: vi.fn(),
    sanitizeTaskOutput: vi.fn((value) => value),
    detectOutputCompletion: vi.fn(() => false),
    QUEUE_LOCK_HOLDER_ID: 'queue-holder',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('scheduler does not silently re-try deterministic preflight failures', () => {
  test('after attemptTaskStart fails, task is no longer in queued list', async () => {
    const id = randomUUID();
    const missing = path.join(os.tmpdir(), 'sched-missing-' + Date.now());
    taskCore.createTask({
      id,
      status: 'queued',
      task_description: 'do something',
      working_directory: missing,
      provider: 'codex',
      metadata: {},
    });

    taskStartup.attemptTaskStart(id, 'codex');

    const stillQueued = taskCore.listQueuedTasksLightweight(100).some(t => t.id === id);
    expect(stillQueued).toBe(false);

    const after = taskCore.getTask(id);
    expect(after.status).toBe('failed');
  });
});

describe('attemptTaskStart preflight fail-fast — extended coverage', () => {
  test('keeps queued task queued when preflight error is non-deterministic', () => {
    const id = randomUUID();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-trans-'));
    taskCore.createTask({
      id,
      status: 'queued',
      task_description: 'do something',
      working_directory: tmpDir,
      provider: 'codex',
      metadata: {},
    });

    const origStat = fs.statSync;
    fs.statSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
    let outcome;
    try {
      outcome = taskStartup.attemptTaskStart(id, 'codex');
    } finally {
      fs.statSync = origStat;
      fs.rmdirSync(tmpDir);
    }

    expect(outcome.failed).toBe(true);
    expect(outcome.reason).toBe('preflight_failed');
    expect(outcome.deterministic).toBe(false);

    const after = taskCore.getTask(id);
    expect(after.status).toBe('queued');
  });

  test('error_output includes the preflight error code', () => {
    const id = randomUUID();
    // Use the sched-missing- prefix so the beforeEach statSync spy reports
    // the directory as present for createTask's upfront validation but then
    // ENOENT for attemptTaskStart's preflight — mirrors a WD that vanished
    // between submission and scheduling.
    const missing = path.join(os.tmpdir(), 'sched-missing-err-' + Date.now());
    taskCore.createTask({
      id,
      status: 'queued',
      task_description: 'do something',
      working_directory: missing,
      provider: 'codex',
      metadata: {},
    });

    taskStartup.attemptTaskStart(id, 'codex');
    const after = taskCore.getTask(id);
    expect(after.status).toBe('failed');
    expect(after.error_output).toMatch(/working directory does not exist/i);
  });

  test('empty task_description is treated as deterministic preflight failure', () => {
    const id = randomUUID();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-empty-desc-'));
    taskCore.createTask({
      id,
      status: 'queued',
      task_description: '   ',
      working_directory: tmpDir,
      provider: 'codex',
      metadata: {},
    });

    try {
      const outcome = taskStartup.attemptTaskStart(id, 'codex');
      expect(outcome.failed).toBe(true);
      expect(outcome.reason).toBe('preflight_failed');
      expect(outcome.deterministic).toBe(true);
      const after = taskCore.getTask(id);
      expect(after.status).toBe('failed');
    } finally {
      fs.rmdirSync(tmpDir);
    }
  });
});

describe('runPreflightChecks is only invoked once per attemptTaskStart', () => {
  test('preflight runs exactly once on the happy path', () => {
    const id = randomUUID();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-once-'));
    taskCore.createTask({
      id,
      status: 'queued',
      task_description: 'do something',
      working_directory: tmpDir,
      provider: 'codex',
      metadata: {},
    });

    const origStat = fs.statSync;
    let callCount = 0;
    fs.statSync = (target) => {
      if (String(target) === tmpDir) callCount++;
      return origStat.call(fs, target);
    };

    try {
      taskStartup.attemptTaskStart(id, 'codex');
    } finally {
      fs.statSync = origStat;
      fs.rmdirSync(tmpDir);
    }

    expect(callCount).toBe(1);
  });
});
