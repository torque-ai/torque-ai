'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const finalizer = require('../execution/task-finalizer');
const database = require('../database');
const providerScoring = require('../db/provider-scoring');
const budgetWatcher = require('../db/budget-watcher');
const modelCapabilities = require('../db/model-capabilities');
const providerPerformance = require('../db/provider-performance');
const resumeContext = require('../utils/resume-context');
const { createMockChild } = require('./mocks/process-mock');

function createTaskDb(overrides = {}) {
  const taskId = overrides.id || 'task-001';
  const tasks = new Map([
    [taskId, {
      id: taskId,
      status: 'running',
      provider: 'codex',
      task_description: 'Finalize task',
      metadata: null,
      output: '',
      error_output: '',
      started_at: new Date(Date.now() - 1000).toISOString(),
      ...overrides,
    }],
  ]);

  const db = {
    getTask: vi.fn((id) => {
      const task = tasks.get(id);
      return task ? { ...task } : null;
    }),
    updateTaskStatus: vi.fn((id, status, fields = {}) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, status, ...fields };
      if (['completed', 'failed', 'cancelled', 'skipped'].includes(status)) {
        next.completed_at = next.completed_at || new Date().toISOString();
      }
      tasks.set(id, next);
      return { ...next };
    }),
  };

  return {
    db,
    taskId,
    getStoredTask: () => {
      const task = tasks.get(taskId);
      return task ? { ...task } : null;
    },
  };
}

function initFinalizer(overrides = {}) {
  const { db } = overrides.dbBundle;
  const safeUpdateTaskStatus = overrides.safeUpdateTaskStatus || vi.fn((...args) => db.updateTaskStatus(...args));

  finalizer.init({
    db,
    safeUpdateTaskStatus,
    sanitizeTaskOutput: overrides.sanitizeTaskOutput || ((value) => value || ''),
    extractModifiedFiles: overrides.extractModifiedFiles || vi.fn(() => []),
    handleRetryLogic: overrides.handleRetryLogic || vi.fn(),
    handleSafeguardChecks: overrides.handleSafeguardChecks || vi.fn(),
    handleFuzzyRepair: overrides.handleFuzzyRepair || vi.fn(),
    handleNoFileChangeDetection: overrides.handleNoFileChangeDetection || vi.fn(),
    handleAutoValidation: overrides.handleAutoValidation || vi.fn(),
    handleBuildTestStyleCommit: overrides.handleBuildTestStyleCommit || vi.fn(),
    handleAutoVerifyRetry: overrides.handleAutoVerifyRetry || vi.fn(async () => {}),
    handleProviderFailover: overrides.handleProviderFailover || vi.fn(),
    handlePostCompletion: overrides.handlePostCompletion || vi.fn(),
  });

  return { safeUpdateTaskStatus };
}

function defaultCliHelpers(overrides = {}) {
  return {
    detectTaskTypes: () => [],
    wrapWithInstructions: (desc) => desc,
    estimateProgress: () => 50,
    detectOutputCompletion: (output) => /DONE/.test(output),
    checkBreakpoints: () => null,
    pauseTaskForDebug: vi.fn(),
    pauseTask: vi.fn(),
    classifyError: () => ({ retryable: false, reason: 'not used' }),
    sanitizeTaskOutput: (value) => value || '',
    getActualModifiedFiles: () => [],
    runLLMSafeguards: () => ({ passed: true, issues: [] }),
    scopedRollback: vi.fn(),
    checkFileQuality: () => ({ issues: [] }),
    runBuildVerification: () => ({ skipped: true }),
    runTestVerification: () => ({ skipped: true }),
    runStyleCheck: () => ({ skipped: true }),
    tryCreateAutoPR: vi.fn(),
    isValidFilePath: () => true,
    isShellSafe: () => true,
    handlePlanProjectTaskCompletion: vi.fn(),
    handlePlanProjectTaskFailure: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    handleWorkflowTermination: vi.fn(),
    runOutputSafeguards: vi.fn(async () => {}),
    cancelTask: vi.fn(),
    resolveWindowsCmdToNode: () => null,
    ensureTargetFilesExist: (_wd, files) => files,
    extractTargetFilesFromDescription: () => [],
    isLargeModelBlockedOnHost: () => ({ blocked: false }),
    startTask: vi.fn(),
    ...overrides,
  };
}

function createExecuteCliDb(task) {
  const tasks = new Map([[task.id, { ...task }]]);
  return {
    getTask: vi.fn((id) => {
      const current = tasks.get(id);
      return current ? { ...current } : null;
    }),
    updateTaskStatus: vi.fn((id, status, fields = {}) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, status, ...fields };
      tasks.set(id, next);
      return { ...next };
    }),
    getConfig: vi.fn(() => '1'),
    getOrCreateTaskStream: vi.fn(() => 'stream-001'),
    addStreamChunk: vi.fn(),
    updateTaskProgress: vi.fn(),
    decrementHostTasks: vi.fn(),
    invalidateOllamaHealth: vi.fn(),
  };
}

function loadExecuteCliWithMockedSpawn(spawnMock) {
  const cp = require('child_process');
  const originalSpawn = cp.spawn;
  cp.spawn = spawnMock;
  try {
    const modPath = require.resolve('../providers/execute-cli');
    delete require.cache[modPath];
    return require('../providers/execute-cli');
  } finally {
    cp.spawn = originalSpawn;
  }
}

describe('task-finalizer', () => {
  beforeEach(() => {
    finalizer._testing.resetForTest();
  });

  it('finalizes a running task to completed', async () => {
    const dbBundle = createTaskDb();
    const handlePostCompletion = vi.fn();
    const { safeUpdateTaskStatus } = initFinalizer({
      dbBundle,
      handlePostCompletion,
    });

    const result = await finalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'all good',
      errorOutput: '',
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('completed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      dbBundle.taskId,
      'completed',
      expect.objectContaining({
        exit_code: 0,
        output: 'all good',
        progress_percent: 100,
      })
    );
    expect(storedTask.metadata.finalization.validation_stage_outcomes).toBeTruthy();
    expect(handlePostCompletion).toHaveBeenCalledTimes(1);
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('marks the task failed when validation flips a successful exit', async () => {
    const dbBundle = createTaskDb();
    const handlePostCompletion = vi.fn();
    const { safeUpdateTaskStatus } = initFinalizer({
      dbBundle,
      handleAutoValidation: vi.fn((ctx) => {
        ctx.status = 'failed';
        ctx.errorOutput = 'validation failed';
      }),
      handlePostCompletion,
    });

    const result = await finalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'process said success',
      errorOutput: '',
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('failed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      dbBundle.taskId,
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: 'validation failed',
        progress_percent: 0,
      })
    );
    expect(storedTask.metadata.finalization.raw_exit_code).toBe(0);
    expect(storedTask.metadata.finalization.final_exit_code).toBe(1);
    expect(storedTask.metadata.finalization.validation_stage_outcomes.auto_validation.outcome).toBe('status:failed');
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', code: 1 }));
  });

  it('is idempotent when finalizeTask is called twice concurrently', async () => {
    vi.useFakeTimers();
    try {
      const dbBundle = createTaskDb();
      const handlePostCompletion = vi.fn();
      const { safeUpdateTaskStatus } = initFinalizer({
        dbBundle,
        handleBuildTestStyleCommit: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
        handlePostCompletion,
      });

      const first = finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done once',
        errorOutput: '',
      });
      const second = finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done twice',
        errorOutput: '',
      });

      await vi.advanceTimersByTimeAsync(500);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.finalized).toBe(true);
      expect(secondResult.finalized).toBe(false);
      expect(dbBundle.getStoredTask().status).toBe('completed');
      expect(safeUpdateTaskStatus).toHaveBeenCalledTimes(1);
      expect(handlePostCompletion).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records categorized outcomes for local providers before the terminal DB write', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-03-07T18:00:00.000Z');
      vi.setSystemTime(now);

      const dbBundle = createTaskDb({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:32b',
        task_description: 'Write unit tests for src/app.ts',
        started_at: new Date(now.getTime() - 45_000).toISOString(),
      });
      const outcomeRun = vi.fn();
      modelCapabilities.setDb({
        prepare: vi.fn(() => ({ run: outcomeRun })),
      });
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 1,
        output: '',
        errorOutput: 'SEARCH/REPLACE failed because of format mismatch',
        filesModified: ['src/app.ts'],
      });

      expect(result.finalized).toBe(true);
      expect(outcomeRun).toHaveBeenCalledWith(
        'qwen2.5-coder:32b',
        'testing',
        'typescript',
        0,
        45,
        'format_mismatch'
      );
      expect(outcomeRun.mock.invocationCallOrder[0]).toBeLessThan(safeUpdateTaskStatus.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records provider performance before the terminal DB write', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-03-07T18:00:00.000Z');
      vi.setSystemTime(now);

      const dbBundle = createTaskDb({
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        task_description: 'Implement queue scheduler gate',
        started_at: new Date(now.getTime() - 30_000).toISOString(),
      });
      const perfSpy = vi.spyOn(providerPerformance, 'recordTaskOutcome').mockImplementation(() => {});
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
      });

      expect(result.finalized).toBe(true);
      expect(perfSpy).toHaveBeenCalledWith({
        provider: 'codex',
        taskType: 'general',
        durationSeconds: 30,
        success: true,
        resubmitted: false,
        autoCheckPassed: true,
      });
      expect(perfSpy.mock.invocationCallOrder[0]).toBeLessThan(safeUpdateTaskStatus.mock.invocationCallOrder[0]);
      perfSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records provider scoring and budget checks after the terminal DB write', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      cost_usd: '1.25',
    });
    const scoringDb = { prepare: vi.fn() };
    const getDbInstanceSpy = vi.spyOn(database, 'getDbInstance').mockReturnValue(scoringDb);
    const scoringInitSpy = vi.spyOn(providerScoring, 'init').mockImplementation(() => {});
    const scoringRecordSpy = vi.spyOn(providerScoring, 'recordTaskCompletion').mockImplementation(() => {});
    const budgetInitSpy = vi.spyOn(budgetWatcher, 'init').mockImplementation(() => {});
    const budgetCheckSpy = vi.spyOn(budgetWatcher, 'checkBudgetThresholds').mockReturnValue(null);

    try {
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'all good',
        errorOutput: '',
      });

      expect(result.finalized).toBe(true);
      expect(getDbInstanceSpy).toHaveBeenCalled();
      expect(scoringInitSpy).toHaveBeenCalledWith(scoringDb);
      expect(scoringRecordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex',
          success: true,
          costUsd: 1.25,
          qualityScore: 0.7,
        })
      );
      // durationMs is computed from started_at — verify it's a non-negative number
      expect(scoringRecordSpy.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
      expect(budgetInitSpy).toHaveBeenCalledWith(scoringDb);
      expect(budgetCheckSpy).toHaveBeenCalledWith('codex');
      expect(safeUpdateTaskStatus.mock.invocationCallOrder[0]).toBeLessThan(scoringRecordSpy.mock.invocationCallOrder[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('stores resume context for failed tasks after the terminal DB write', async () => {
    const dbBundle = createTaskDb();
    const resumeCtx = { summary: 'resume me' };
    const runSpy = vi.fn();
    const scoringDb = {
      prepare: vi.fn(() => ({ run: runSpy })),
    };
    const getDbInstanceSpy = vi.spyOn(database, 'getDbInstance').mockReturnValue(scoringDb);
    vi.spyOn(providerScoring, 'init').mockImplementation(() => {});
    vi.spyOn(providerScoring, 'recordTaskCompletion').mockImplementation(() => {});
    vi.spyOn(budgetWatcher, 'init').mockImplementation(() => {});
    vi.spyOn(budgetWatcher, 'checkBudgetThresholds').mockReturnValue(null);
    const buildResumeContextSpy = vi.spyOn(resumeContext, 'buildResumeContext').mockReturnValue(resumeCtx);

    try {
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 1,
        output: 'stdout text',
        errorOutput: 'stderr text',
      });

      expect(result.finalized).toBe(true);
      expect(getDbInstanceSpy).toHaveBeenCalled();
      expect(buildResumeContextSpy).toHaveBeenCalledWith(
        'stdout text',
        'stderr text',
        expect.objectContaining({ description: 'Finalize task', provider: 'codex' })
      );
      // durationMs is computed from started_at — verify it's a positive number
      const callArgs = buildResumeContextSpy.mock.calls[0][2];
      expect(callArgs.durationMs).toBeGreaterThanOrEqual(0);
      expect(scoringDb.prepare).toHaveBeenCalledWith('UPDATE tasks SET resume_context = ? WHERE id = ?');
      expect(runSpy).toHaveBeenCalledWith(JSON.stringify(resumeCtx), dbBundle.taskId);
      expect(safeUpdateTaskStatus.mock.invocationCallOrder[0]).toBeLessThan(buildResumeContextSpy.mock.invocationCallOrder[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe('Cloud provider outcome recording', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('records outcome for codex provider', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-03-07T18:00:00.000Z');
        vi.setSystemTime(now);

        const dbBundle = createTaskDb({
          provider: 'codex',
          model: 'gpt-5.3-codex-spark',
          started_at: new Date(now.getTime() - 30_000).toISOString(),
        });
        const recordTaskOutcomeSpy = vi.spyOn(modelCapabilities, 'recordTaskOutcome').mockImplementation(() => {});
        const { safeUpdateTaskStatus } = initFinalizer({ dbBundle });

        const result = await finalizer.finalizeTask(dbBundle.taskId, {
          exitCode: 0,
          output: 'done',
          errorOutput: '',
        });

        expect(result.finalized).toBe(true);
        expect(recordTaskOutcomeSpy).toHaveBeenCalledWith(
          'gpt-5.3-codex-spark',
          expect.any(String),
          expect.any(String),
          true,
          30,
          null
        );
        expect(recordTaskOutcomeSpy.mock.invocationCallOrder[0]).toBeLessThan(safeUpdateTaskStatus.mock.invocationCallOrder[0]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records outcome for claude-cli provider', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-03-07T18:00:00.000Z');
        vi.setSystemTime(now);

        const dbBundle = createTaskDb({
          provider: 'claude-cli',
          model: 'claude-opus-4-6',
          started_at: new Date(now.getTime() - 20_000).toISOString(),
        });
        const recordTaskOutcomeSpy = vi.spyOn(modelCapabilities, 'recordTaskOutcome').mockImplementation(() => {});
        initFinalizer({ dbBundle });

        const result = await finalizer.finalizeTask(dbBundle.taskId, {
          exitCode: 1,
          output: '',
          errorOutput: 'TypeError: undefined is not a function',
        });

        expect(result.finalized).toBe(true);
        expect(recordTaskOutcomeSpy).toHaveBeenCalledWith(
          'claude-opus-4-6',
          expect.any(String),
          expect.any(String),
          false,
          20,
          'type_error'
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('records outcome for deepinfra provider', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-03-07T18:00:00.000Z');
        vi.setSystemTime(now);

        const dbBundle = createTaskDb({
          provider: 'deepinfra',
          model: 'Qwen/Qwen2.5-72B-Instruct',
          started_at: new Date(now.getTime() - 15_000).toISOString(),
        });
        const recordTaskOutcomeSpy = vi.spyOn(modelCapabilities, 'recordTaskOutcome').mockImplementation(() => {});
        initFinalizer({ dbBundle });

        const result = await finalizer.finalizeTask(dbBundle.taskId, {
          exitCode: 0,
          output: 'done',
          errorOutput: '',
        });

        expect(result.finalized).toBe(true);
        expect(recordTaskOutcomeSpy).toHaveBeenCalledWith(
          'Qwen/Qwen2.5-72B-Instruct',
          expect.any(String),
          expect.any(String),
          true,
          15,
          null
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses provider name as model fallback when model is null', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-03-07T18:00:00.000Z');
        vi.setSystemTime(now);

        const dbBundle = createTaskDb({
          provider: 'codex',
          model: null,
          started_at: new Date(now.getTime() - 10_000).toISOString(),
        });
        const recordTaskOutcomeSpy = vi.spyOn(modelCapabilities, 'recordTaskOutcome').mockImplementation(() => {});
        initFinalizer({ dbBundle });

        const result = await finalizer.finalizeTask(dbBundle.taskId, {
          exitCode: 0,
          output: 'done',
          errorOutput: '',
        });

        expect(result.finalized).toBe(true);
        expect(recordTaskOutcomeSpy).toHaveBeenCalledWith(
          'codex',
          expect.any(String),
          expect.any(String),
          true,
          10,
          null
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('prevents stream-based force completion from bypassing the finalizer', async () => {
    vi.useFakeTimers();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalizer-stream-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const spawnMock = vi.fn();
      const executeCli = loadExecuteCliWithMockedSpawn(spawnMock);
      const child = createMockChild();
      spawnMock.mockReturnValue(child);

      const taskId = randomUUID();
      const task = {
        id: taskId,
        status: 'running',
        provider: 'codex',
        task_description: 'stream completion test',
        working_directory: tmpDir,
      };
      const db = createExecuteCliDb(task);
      const finalizeTaskSpy = vi.fn(async () => ({ finalized: true, queueManaged: false }));
      const safeUpdateTaskStatus = vi.fn();

      executeCli.init({
        db,
        dashboard: {
          broadcast: vi.fn(),
          broadcastTaskUpdate: vi.fn(),
          notifyTaskUpdated: vi.fn(),
          notifyTaskOutput: vi.fn(),
        },
        runningProcesses: new Map(),
        safeUpdateTaskStatus,
        finalizeTask: finalizeTaskSpy,
        tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
        markTaskCleanedUp: vi.fn(() => true),
        tryOllamaCloudFallback: vi.fn(),
        shellEscape: (value) => value,
        processQueue: vi.fn(),
        isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
        helpers: defaultCliHelpers(),
        NVM_NODE_PATH: null,
        QUEUE_LOCK_HOLDER_ID: 'test-lock',
        MAX_OUTPUT_BUFFER: 1024 * 1024,
        pendingRetryTimeouts: new Map(),
        taskCleanupGuard: new Map(),
        stallRecoveryAttempts: new Map(),
      });

      executeCli.spawnAndTrackProcess(taskId, task, {
        cliPath: 'node',
        finalArgs: ['-e', 'console.log("DONE")'],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      }, 'codex');

      child.stdout.write('DONE');
      await vi.advanceTimersByTimeAsync(40000);
      await Promise.resolve();

      expect(finalizeTaskSpy).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          exitCode: 0,
          output: expect.stringContaining('DONE'),
        })
      );
      expect(safeUpdateTaskStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
