'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const childProcess = require('child_process');

const finalizer = require('../execution/task-finalizer');
const { createAdversarialReviewStage } = require('../execution/adversarial-review-stage');
const providerScoring = require('../db/provider/scoring');
const budgetWatcher = require('../db/budget-watcher');
const modelCapabilities = require('../db/model-capabilities');
const providerPerformance = require('../db/provider/performance');
const resumeContext = require('../utils/resume-context');
const { createMockChild } = require('./mocks/process-mock');
const { TEST_MODELS } = require('./test-helpers');

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
    rawDb: overrides.rawDb,
    handleAdversarialReview: overrides.handleAdversarialReview,
    handleProviderFailover: overrides.handleProviderFailover || vi.fn(),
    handlePostCompletion: overrides.handlePostCompletion || vi.fn(),
    logFactoryDecision: overrides.logFactoryDecision,
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

function createAdversarialReviewHarness(overrides = {}) {
  const taskCore = overrides.taskCore || {
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
  };
  const taskManager = overrides.taskManager || {
    startTask: vi.fn(),
  };
  const stage = createAdversarialReviewStage({
    adversarialReviews: { insertReview: vi.fn() },
    verificationLedger: { updateVerificationStatus: vi.fn() },
    fileRiskAdapter: overrides.fileRiskAdapter || { scoreAndPersist: vi.fn(() => []) },
    taskCore,
    taskManager,
    projectConfigCore: overrides.projectConfigCore || {
      getProjectConfig: vi.fn(() => ({ adversarial_review: 'always' })),
    },
  });

  return { stage, taskCore, taskManager };
}

async function flushMicrotasksUntil(predicate, attempts = 100) {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await Promise.resolve();
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

  it('clears Codex exhaustion after a successful Codex task', async () => {
    const dbBundle = createTaskDb({ provider: 'codex' });
    dbBundle.db.setCodexExhausted = vi.fn();
    dbBundle.db.setConfig = vi.fn();
    initFinalizer({ dbBundle });

    const result = await finalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'codex succeeded',
      errorOutput: '',
    });

    expect(result.finalized).toBe(true);
    expect(dbBundle.db.setCodexExhausted).toHaveBeenCalledWith(false);
    expect(dbBundle.db.setConfig).toHaveBeenCalledWith('codex_exhaustion_retry_at', '');
  });

  it('keeps createTaskFinalizer dependencies active across async finalization awaits', async () => {
    const dbBundle = createTaskDb();
    const { db } = dbBundle;
    const safeUpdateTaskStatus = vi.fn((...args) => db.updateTaskStatus(...args));
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus,
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleNoFileChangeDetection: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'done after await',
      errorOutput: '',
    });

    expect(result.finalized).toBe(true);
    expect(dbBundle.getStoredTask().status).toBe('completed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      dbBundle.taskId,
      'completed',
      expect.objectContaining({ output: 'done after await' })
    );
  });

  it('keeps scoped dependencies isolated across overlapping finalizations', async () => {
    const dbBundleA = createTaskDb({ id: 'task-a' });
    const dbBundleB = createTaskDb({ id: 'task-b' });
    let releaseA;
    let releaseB;

    const makeScopedFinalizer = (dbBundle, releaseSetter) => {
      const { db } = dbBundle;
      return finalizer.createTaskFinalizer({
        db,
        safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
        sanitizeTaskOutput: (value) => value || '',
        extractModifiedFiles: vi.fn(() => []),
        handleRetryLogic: vi.fn(),
        handleSafeguardChecks: vi.fn(),
        handleFuzzyRepair: vi.fn(),
        handleNoFileChangeDetection: vi.fn(),
        handleAutoValidation: vi.fn(() => new Promise((resolve) => { releaseSetter(resolve); })),
        handleBuildTestStyleCommit: vi.fn(),
        handleAutoVerifyRetry: vi.fn(async () => {}),
        handleProviderFailover: vi.fn(),
        handlePostCompletion: vi.fn(),
      });
    };

    const scopedFinalizerA = makeScopedFinalizer(dbBundleA, (resolve) => { releaseA = resolve; });
    const scopedFinalizerB = makeScopedFinalizer(dbBundleB, (resolve) => { releaseB = resolve; });

    const first = scopedFinalizerA.finalizeTask(dbBundleA.taskId, {
      exitCode: 0,
      output: 'done a',
      errorOutput: '',
    });
    await vi.waitFor(() => {
      if (typeof releaseA !== 'function') throw new Error('first finalizer not waiting');
    });

    const second = scopedFinalizerB.finalizeTask(dbBundleB.taskId, {
      exitCode: 0,
      output: 'done b',
      errorOutput: '',
    });
    await vi.waitFor(() => {
      if (typeof releaseB !== 'function') throw new Error('second finalizer not waiting');
    });

    releaseA();
    await expect(first).resolves.toMatchObject({ finalized: true, status: 'completed' });
    expect(dbBundleA.getStoredTask()).toMatchObject({
      status: 'completed',
      output: 'done a',
    });

    releaseB();
    await expect(second).resolves.toMatchObject({ finalized: true, status: 'completed' });
    expect(dbBundleB.getStoredTask()).toMatchObject({
      status: 'completed',
      output: 'done b',
    });
  });

  it('resolves retry logic with scoped dependencies when no explicit retry handler is provided', async () => {
    const classifyError = vi.fn(() => ({ retryable: false, reason: 'synthetic_nonretryable' }));
    const dbBundle = createTaskDb();
    const { db } = dbBundle;
    const safeUpdateTaskStatus = vi.fn((...args) => db.updateTaskStatus(...args));
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus,
      classifyError,
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleNoFileChangeDetection: vi.fn(),
      handleSandboxRevertDetection: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 1,
      output: '',
      errorOutput: 'synthetic failure',
    });

    expect(result.finalized).toBe(true);
    expect(result.status).toBe('failed');
    expect(classifyError).toHaveBeenCalledWith('synthetic failure', 1);
    expect(result.validationStages.retry_logic).toMatchObject({
      outcome: 'no_change',
    });
    expect(result.validationStages.retry_logic).not.toHaveProperty('error');
    expect(dbBundle.getStoredTask().error_output).not.toContain('deps.classifyError is not a function');
  });

  it('uses the DI completion pipeline service for post-completion hooks', async () => {
    const dbBundle = createTaskDb();
    const { db } = dbBundle;
    const safeUpdateTaskStatus = vi.fn((...args) => db.updateTaskStatus(...args));
    const handlePostCompletion = vi.fn(async () => {});
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus,
      completionPipeline: { handlePostCompletion },
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleNoFileChangeDetection: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'done through DI pipeline',
      errorOutput: '',
    });

    expect(result.finalized).toBe(true);
    expect(handlePostCompletion).toHaveBeenCalledTimes(1);
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      taskId: dbBundle.taskId,
    }));
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

  it('reclassifies Codex phantom success as failed before post-completion hooks', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-663',
        'factory:work_item_id=663',
      ],
    });
    const handlePostCompletion = vi.fn();
    const logFactoryDecision = vi.fn();
    const { safeUpdateTaskStatus } = initFinalizer({
      dbBundle,
      handlePostCompletion,
      logFactoryDecision,
    });

    const result = await finalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: '(no output)',
      errorOutput: "ERROR: Reconnecting... 1/5\nERROR: We're currently experiencing high demand",
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('failed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      dbBundle.taskId,
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('[phantom-success]'),
        progress_percent: 0,
      })
    );
    expect(storedTask.metadata.finalization.raw_exit_code).toBe(0);
    expect(storedTask.metadata.finalization.final_status).toBe('failed');
    expect(storedTask.metadata.finalization.validation_stage_outcomes.phantom_success_detection.outcome).toBe('status:failed');
    expect(logFactoryDecision).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'a3df749a-7869-486f-9896-64d38d25d39b',
      stage: 'execute',
      actor: 'executor',
      action: 'phantom_completion_detected',
      batch_id: 'factory-a3df749a-7869-486f-9896-64d38d25d39b-663',
    }));
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', code: 1 }));
  });

  it('schedules retry after Codex phantom success reclassification', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      max_retries: 2,
      retry_count: 0,
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-664',
        'factory:work_item_id=664',
      ],
    });
    const handlePostCompletion = vi.fn();
    const handleRetryLogic = vi.fn((ctx) => {
      dbBundle.db.updateTaskStatus(ctx.taskId, 'retry_scheduled', {
        exit_code: ctx.code,
        error_output: `[Retry 1/2] ${ctx.errorOutput}`,
      });
      ctx.earlyExit = true;
    });
    initFinalizer({
      dbBundle,
      handlePostCompletion,
      handleRetryLogic,
      logFactoryDecision: vi.fn(),
    });

    const result = await finalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: '',
      errorOutput: "ERROR: Reconnecting... 1/5\nERROR: We're currently experiencing high demand",
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result).toMatchObject({
      finalized: false,
      queueManaged: true,
      status: 'retry_scheduled',
      reason: 'early_exit',
    });
    expect(storedTask.status).toBe('retry_scheduled');
    expect(handleRetryLogic).toHaveBeenCalledTimes(1);
    expect(handlePostCompletion).not.toHaveBeenCalled();
    expect(result.validationStages.retry_logic_after_phantom).toMatchObject({
      outcome: 'early_exit',
      status_before: 'failed',
      status_after: 'failed',
      code_before: 1,
      code_after: 1,
      early_exit: true,
    });
  });

  it('reclassifies completed factory execution tasks with no file changes as failed', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      max_retries: 2,
      retry_count: 2,
      task_description: 'Plan: Memory work\nTask 1: Add the Chroma collection adapter',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-227',
        'factory:work_item_id=227',
        'factory:plan_task_number=1',
      ],
    });
    const { db } = dbBundle;
    const safeUpdateTaskStatus = vi.fn((...args) => db.updateTaskStatus(...args));
    const handlePostCompletion = vi.fn();
    const handleRetryLogic = vi.fn();
    const logFactoryDecision = vi.fn();
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus,
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic,
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion,
      logFactoryDecision,
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'I inspected the files.',
      errorOutput: '',
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('failed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      dbBundle.taskId,
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('[no-file-change]'),
        progress_percent: 0,
      })
    );
    expect(handleRetryLogic).toHaveBeenCalledTimes(1);
    expect(storedTask.metadata.finalization.raw_exit_code).toBe(0);
    expect(storedTask.metadata.finalization.final_status).toBe('failed');
    expect(storedTask.metadata.finalization.validation_stage_outcomes.no_file_change_detection.outcome).toBe('status:failed');
    expect(logFactoryDecision).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'a3df749a-7869-486f-9896-64d38d25d39b',
      stage: 'execute',
      actor: 'executor',
      action: 'empty_execution_task_detected',
      batch_id: 'factory-a3df749a-7869-486f-9896-64d38d25d39b-227',
    }));
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', code: 1 }));
  });

  it('uses actual factory worktree changes before no-file-change reclassification', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      working_directory: 'C:/repo/.worktrees/feature',
      task_description: 'Plan: Workflow work\nTask 1: Add workflow DAG validation',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-194',
        'factory:work_item_id=194',
        'factory:plan_task_number=1',
      ],
    });
    const { db } = dbBundle;
    const handlePostCompletion = vi.fn();
    const logFactoryDecision = vi.fn();
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      getActualModifiedFilesForNoFileDetection: vi.fn(() => [
        'server/workflow-spec/schema.js',
        'server/workflow-spec/dag-validator.js',
        'server/tests/workflow-dag-validation.test.js',
      ]),
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion,
      logFactoryDecision,
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'All tasks complete. Files created are described in prose.',
      errorOutput: 'git status --short\n M server/workflow-spec/schema.js\n?? server/workflow-spec/dag-validator.js',
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('completed');
    expect(storedTask.exit_code).toBe(0);
    expect(storedTask.files_modified).toEqual([
      'server/workflow-spec/schema.js',
      'server/workflow-spec/dag-validator.js',
      'server/tests/workflow-dag-validation.test.js',
    ]);
    expect(storedTask.error_output).not.toContain('[no-file-change]');
    expect(logFactoryDecision).not.toHaveBeenCalled();
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      code: 0,
      filesModified: expect.arrayContaining(['server/workflow-spec/dag-validator.js']),
    }));
  });

  it('restores unscoped dirty factory worktree files before auto-verify', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      working_directory: 'C:/repo/.worktrees/feature',
      task_description: [
        'Plan: Add ACL wildcard mask edge-case tests',
        'Task 1: Add ACL wildcard mask edge-case test suite covering host, any, and unusual mask patterns',
        '## Target Files',
        '- `src/engine/protocols/acl.ts`',
        '- `tests/engine/protocols/acl.test.ts`',
      ].join('\n'),
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-2530',
        'factory:work_item_id=2530',
        'factory:plan_task_number=1',
      ],
    });
    const { db } = dbBundle;
    const restoreFactoryWorktreeFiles = vi.fn();
    const handleAutoVerifyRetry = vi.fn(async (ctx) => {
      expect(ctx.filesModified).toEqual(['tests/engine/protocols/acl.test.ts']);
    });
    const logFactoryDecision = vi.fn();
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => ['tests/engine/protocols/acl.test.ts']),
      getActualModifiedFilesForFactoryHygiene: vi.fn(() => [
        'tests/engine/protocols/acl.test.ts',
        'tests/engine/protocols/bgp-route-reflector.test.ts',
        'tests/engine/protocols/ospf-multi-area.test.ts',
      ]),
      restoreFactoryWorktreeFiles,
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry,
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
      logFactoryDecision,
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'Updated tests/engine/protocols/acl.test.ts',
      errorOutput: '',
      filesModified: ['tests/engine/protocols/acl.test.ts'],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('completed');
    expect(storedTask.files_modified).toEqual(['tests/engine/protocols/acl.test.ts']);
    expect(restoreFactoryWorktreeFiles).toHaveBeenCalledWith(
      'C:/repo/.worktrees/feature',
      [
        'tests/engine/protocols/bgp-route-reflector.test.ts',
        'tests/engine/protocols/ospf-multi-area.test.ts',
      ],
    );
    expect(handleAutoVerifyRetry).toHaveBeenCalledTimes(1);
    expect(logFactoryDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restored_unscoped_worktree_changes',
      work_item_id: '2530',
      outcome: expect.objectContaining({
        restored_files: [
          'tests/engine/protocols/bgp-route-reflector.test.ts',
          'tests/engine/protocols/ospf-multi-area.test.ts',
        ],
      }),
    }));
    expect(storedTask.metadata.finalization.validation_stage_outcomes.factory_worktree_hygiene)
      .toEqual(expect.objectContaining({ outcome: 'no_change' }));
  });

  it('schedules retry after factory no-file-change reclassification', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      max_retries: 2,
      retry_count: 0,
      task_description: 'Plan: Memory work\nTask 2: Route task-cache semantic lookup through Chroma',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-228',
        'factory:work_item_id=228',
        'factory:plan_task_number=2',
      ],
    });
    const { db } = dbBundle;
    const handlePostCompletion = vi.fn();
    const handleRetryLogic = vi.fn((ctx) => {
      db.updateTaskStatus(ctx.taskId, 'retry_scheduled', {
        exit_code: ctx.code,
        error_output: `[Retry 1/2] ${ctx.errorOutput}`,
      });
      ctx.earlyExit = true;
    });
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic,
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion,
      logFactoryDecision: vi.fn(),
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'done',
      errorOutput: '',
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result).toMatchObject({
      finalized: false,
      queueManaged: true,
      status: 'retry_scheduled',
      reason: 'early_exit',
    });
    expect(storedTask.status).toBe('retry_scheduled');
    expect(storedTask.error_output).toContain('[no-file-change]');
    expect(handleRetryLogic).toHaveBeenCalledTimes(1);
    expect(handlePostCompletion).not.toHaveBeenCalled();
    expect(result.validationStages.retry_logic_after_no_file_change).toMatchObject({
      outcome: 'early_exit',
      status_before: 'failed',
      status_after: 'failed',
      code_before: 1,
      code_after: 1,
      early_exit: true,
    });
  });

  it('allows already-in-place factory no-op completions to reach post-completion hooks', async () => {
    const dbBundle = createTaskDb({
      provider: 'claude-cli',
      max_retries: 2,
      retry_count: 0,
      task_description: 'Plan: Factory Lane Policy Editor Implementation Plan\nTask 2: Create Approvals.test.jsx coverage',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-2274',
        'factory:work_item_id=2274',
        'factory:plan_task_number=2',
      ],
    });
    const { db } = dbBundle;
    const handleRetryLogic = vi.fn();
    const handlePostCompletion = vi.fn();
    const logFactoryDecision = vi.fn();
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic,
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion,
      logFactoryDecision,
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'The task is already complete. The requested tests already exist in ProjectSettings.test.jsx and pass.',
      errorOutput: '',
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('completed');
    expect(storedTask.exit_code).toBe(0);
    expect(storedTask.error_output || '').not.toContain('[no-file-change]');
    expect(storedTask.metadata.finalization.validation_stage_outcomes.no_file_change_detection.outcome).toBe('no_change');
    expect(handleRetryLogic).not.toHaveBeenCalled();
    expect(logFactoryDecision).not.toHaveBeenCalled();
    expect(handlePostCompletion).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      code: 0,
    }));
  });

  it('allows explicit read-only factory tasks to complete without file changes', async () => {
    const dbBundle = createTaskDb({
      provider: 'codex',
      task_description: 'Plan: Audit work\nTask 1: Read-only review of cache behavior',
      tags: [
        'factory:batch_id=factory-a3df749a-7869-486f-9896-64d38d25d39b-229',
        'factory:work_item_id=229',
        'factory:plan_task_number=1',
      ],
      metadata: JSON.stringify({ read_only: true }),
    });
    const { db } = dbBundle;
    const scopedFinalizer = finalizer.createTaskFinalizer({
      db,
      safeUpdateTaskStatus: vi.fn((...args) => db.updateTaskStatus(...args)),
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(async () => {}),
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
      logFactoryDecision: vi.fn(),
    });

    const result = await scopedFinalizer.finalizeTask(dbBundle.taskId, {
      exitCode: 0,
      output: 'review complete',
      errorOutput: '',
      filesModified: [],
    });

    const storedTask = dbBundle.getStoredTask();
    expect(result.finalized).toBe(true);
    expect(storedTask.status).toBe('completed');
    expect(storedTask.metadata.finalization.validation_stage_outcomes.no_file_change_detection.outcome).toBe('no_change');
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

  it('fails the task when a finalizer stage exceeds its configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const dbBundle = createTaskDb({
        task_description: 'Finalize task with hung validation stage',
      });
      dbBundle.db.getConfig = vi.fn((key) => (
        key === 'finalizer_stage_build_test_style_commit_timeout_ms' ? '25' : null
      ));
      const hangingBuildStage = vi.fn(() => new Promise(() => {}));
      initFinalizer({
        dbBundle,
        handleBuildTestStyleCommit: hangingBuildStage,
        handlePostCompletion: vi.fn(),
      });

      const finalizePromise = finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
      });

      await vi.advanceTimersByTimeAsync(30);
      const result = await finalizePromise;
      const storedTask = dbBundle.getStoredTask();

      expect(result.finalized).toBe(true);
      expect(storedTask.status).toBe('failed');
      expect(storedTask.error_output).toContain('[FINALIZER build_test_style_commit TIMEOUT]');
      expect(storedTask.metadata.finalization.validation_stage_outcomes.build_test_style_commit.outcome)
        .toBe('timeout');
      expect(storedTask.metadata.finalization.validation_stage_outcomes.build_test_style_commit.timeout_ms)
        .toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows auto_verify_retry to run longer than the old six-minute ceiling', async () => {
    vi.useFakeTimers();
    try {
      const dbBundle = createTaskDb({
        task_description: 'Finalize task with slow auto verify',
      });
      dbBundle.db.getConfig = vi.fn(() => null);
      const slowAutoVerify = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 370000));
      });
      initFinalizer({
        dbBundle,
        handleAutoVerifyRetry: slowAutoVerify,
        handlePostCompletion: vi.fn(),
      });

      const finalizePromise = finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
      });

      await vi.advanceTimersByTimeAsync(370000);
      const result = await finalizePromise;
      const storedTask = dbBundle.getStoredTask();

      expect(result.finalized).toBe(true);
      expect(storedTask.status).toBe('completed');
      expect(storedTask.error_output || '').not.toContain('[FINALIZER auto_verify_retry TIMEOUT]');
      expect(storedTask.metadata.finalization.validation_stage_outcomes.auto_verify_retry.outcome)
        .toBe('no_change');
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
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
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
        TEST_MODELS.DEFAULT,
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
    const scoringInitSpy = vi.spyOn(providerScoring, 'init').mockImplementation(() => {});
    const scoringRecordSpy = vi.spyOn(providerScoring, 'recordTaskCompletion').mockImplementation(() => {});
    const budgetInitSpy = vi.spyOn(budgetWatcher, 'init').mockImplementation(() => {});
    const budgetCheckSpy = vi.spyOn(budgetWatcher, 'checkBudgetThresholds').mockReturnValue(null);

    try {
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle, rawDb: scoringDb });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'all good',
        errorOutput: '',
      });

      expect(result.finalized).toBe(true);
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

  it('uses provider scoring cost and quality overrides from task metadata', async () => {
    const dbBundle = createTaskDb({
      provider: 'deepinfra',
      metadata: JSON.stringify({
        estimated_cost_usd: 0.42,
        provider_scoring: { quality_score: 82 },
      }),
    });
    const scoringDb = { prepare: vi.fn() };
    vi.spyOn(providerScoring, 'init').mockImplementation(() => {});
    const scoringRecordSpy = vi.spyOn(providerScoring, 'recordTaskCompletion').mockImplementation(() => {});
    vi.spyOn(budgetWatcher, 'init').mockImplementation(() => {});
    vi.spyOn(budgetWatcher, 'checkBudgetThresholds').mockReturnValue(null);

    try {
      const { safeUpdateTaskStatus } = initFinalizer({ dbBundle, rawDb: scoringDb });

      const result = await finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'all good',
        errorOutput: '',
      });

      expect(result.finalized).toBe(true);
      expect(scoringRecordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'deepinfra',
          success: true,
          costUsd: 0.42,
          qualityScore: 0.82,
        })
      );
      expect(safeUpdateTaskStatus.mock.invocationCallOrder[0]).toBeLessThan(scoringRecordSpy.mock.invocationCallOrder[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('stores resume context for failed tasks in the terminal DB write', async () => {
    const dbBundle = createTaskDb();
    const resumeCtx = { summary: 'resume me' };
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
      expect(buildResumeContextSpy).toHaveBeenCalledWith(
        'stdout text',
        'stderr text',
        expect.objectContaining({ task_description: 'Finalize task', provider: 'codex' })
      );
      // durationMs is computed from started_at — verify it's a positive number
      const callArgs = buildResumeContextSpy.mock.calls[0][2];
      expect(callArgs.durationMs).toBeGreaterThanOrEqual(0);
      expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
        dbBundle.taskId,
        'failed',
        expect.objectContaining({ resume_context: resumeCtx })
      );
      expect(buildResumeContextSpy.mock.invocationCallOrder[0]).toBeLessThan(safeUpdateTaskStatus.mock.invocationCallOrder[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('awaits asynchronous adversarial diff capture without execFileSync', async () => {
    let execFileCallback = null;
    const diff = 'diff --git a/server/app.js b/server/app.js\n+async review diff\n';
    const execFileSpy = vi.spyOn(childProcess, 'execFile').mockImplementation((cmd, args, opts, cb) => {
      execFileCallback = cb;
      expect(cmd).toBe('git');
      expect(args).toEqual(['diff', 'HEAD~1']);
      expect(opts).toEqual(expect.objectContaining({
        cwd: process.cwd(),
        windowsHide: true,
        maxBuffer: (50 * 1024) + 1024,
      }));
      return { pid: 1234 };
    });
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('sync git diff should not be called');
    });

    try {
      const dbBundle = createTaskDb({
        working_directory: process.cwd(),
        metadata: '{}',
      });
      const { stage, taskCore, taskManager } = createAdversarialReviewHarness();
      const { safeUpdateTaskStatus } = initFinalizer({
        dbBundle,
        handleAdversarialReview: stage,
      });

      const finalizePromise = finalizer.finalizeTask(dbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
        filesModified: ['server/app.js'],
      });

      await flushMicrotasksUntil(() => execFileCallback !== null);
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      expect(safeUpdateTaskStatus).not.toHaveBeenCalled();

      execFileCallback(null, diff, '');
      const result = await finalizePromise;

      expect(result.finalized).toBe(true);
      expect(taskCore.createTask).toHaveBeenCalledTimes(1);
      expect(taskCore.createTask.mock.calls[0][0].task_description).toContain('+async review diff');
      expect(taskManager.startTask).toHaveBeenCalledWith(taskCore.createTask.mock.calls[0][0].id);
      expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
        dbBundle.taskId,
        'completed',
        expect.any(Object)
      );
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps finalization non-blocking for oversized and failed adversarial git diff', async () => {
    const maxBytes = 50 * 1024;
    const oversizedDiff = 'x'.repeat(maxBytes + 500);
    const maxBufferError = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const execFileSpy = vi.spyOn(childProcess, 'execFile').mockImplementation((_cmd, _args, _opts, cb) => {
      cb(maxBufferError, oversizedDiff, '');
      return { pid: 1234 };
    });
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('sync git diff should not be called');
    });

    try {
      const oversizedDbBundle = createTaskDb({
        id: 'task-oversized-diff',
        working_directory: process.cwd(),
        metadata: '{}',
      });
      const oversizedHarness = createAdversarialReviewHarness();
      initFinalizer({
        dbBundle: oversizedDbBundle,
        handleAdversarialReview: oversizedHarness.stage,
      });

      const oversizedResult = await finalizer.finalizeTask(oversizedDbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
        filesModified: ['server/app.js'],
      });

      expect(oversizedResult.finalized).toBe(true);
      expect(oversizedHarness.taskCore.createTask).toHaveBeenCalledTimes(1);
      const reviewPrompt = oversizedHarness.taskCore.createTask.mock.calls[0][0].task_description;
      const capturedDiff = reviewPrompt.split('Diff:\n')[1].split('\n\nRespond with ONLY')[0];
      expect(Buffer.byteLength(capturedDiff, 'utf8')).toBe(maxBytes);

      execFileSpy.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(new Error('bad revision'), '', 'fatal: bad revision HEAD~1');
        return { pid: 5678 };
      });

      const failedDbBundle = createTaskDb({
        id: 'task-failed-diff',
        working_directory: process.cwd(),
        metadata: '{}',
      });
      const failedHarness = createAdversarialReviewHarness();
      const { safeUpdateTaskStatus } = initFinalizer({
        dbBundle: failedDbBundle,
        handleAdversarialReview: failedHarness.stage,
      });

      const failedResult = await finalizer.finalizeTask(failedDbBundle.taskId, {
        exitCode: 0,
        output: 'done',
        errorOutput: '',
        filesModified: ['server/app.js'],
      });

      expect(failedResult.finalized).toBe(true);
      expect(failedHarness.taskCore.createTask).not.toHaveBeenCalled();
      expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
        failedDbBundle.taskId,
        'completed',
        expect.any(Object)
      );
      expect(execFileSyncSpy).not.toHaveBeenCalled();
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
    // This case drives execute-cli's legacy pipe-path body to verify the
    // exit-vs-close race interlock. Phase G's default-on flip would
    // otherwise route 'codex' through the detached wrapper-spawn path,
    // which has its own different finalize flow. Pin flag off for the
    // duration of this test.
    const ORIG_DETACH_FLAG = process.env.TORQUE_DETACHED_SUBPROCESSES;
    process.env.TORQUE_DETACHED_SUBPROCESSES = '0';
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
      if (ORIG_DETACH_FLAG === undefined) delete process.env.TORQUE_DETACHED_SUBPROCESSES;
      else process.env.TORQUE_DETACHED_SUBPROCESSES = ORIG_DETACH_FLAG;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
