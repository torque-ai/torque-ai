'use strict';

const fs = require('fs');
const Module = require('module');

const DATABASE_MODULE_PATH = require.resolve('../database');
const DIRECT_DATABASE_IMPORT = /require\s*\(\s*['"](?:\.\.\/)+database(?:\.js)?['"]\s*\)/;

const cacheBackups = new Map();

function rememberCacheEntry(modulePath) {
  const resolved = require.resolve(modulePath);
  if (!cacheBackups.has(resolved)) {
    cacheBackups.set(resolved, require.cache[resolved] || null);
  }
  return resolved;
}

function clearModule(modulePath) {
  const resolved = rememberCacheEntry(modulePath);
  delete require.cache[resolved];
  return resolved;
}

function installMock(modulePath, exportsValue) {
  const resolved = rememberCacheEntry(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return exportsValue;
}

function restoreCacheEntries() {
  for (const [resolved, entry] of cacheBackups.entries()) {
    if (entry) {
      require.cache[resolved] = entry;
    } else {
      delete require.cache[resolved];
    }
  }
  cacheBackups.clear();
}

function createLoggerMock() {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    child: vi.fn(() => childLogger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createConfigMock() {
  return {
    init: vi.fn(),
    get: vi.fn((_key, fallback = null) => fallback),
    getInt: vi.fn((_key, fallback = 0) => fallback),
    getBool: vi.fn(() => false),
    isOptIn: vi.fn(() => false),
    hasApiKey: vi.fn(() => false),
  };
}

function createContainerMock() {
  return {
    getModule: vi.fn(() => null),
    defaultContainer: {
      has: vi.fn(() => false),
      get: vi.fn(() => null),
      peek: vi.fn(() => null),
    },
  };
}

function installCommonBoundaryMocks() {
  return {
    logger: installMock('../logger', createLoggerMock()),
    config: installMock('../config', createConfigMock()),
    container: installMock('../container', createContainerMock()),
  };
}

function createInitModuleMock(extra = {}) {
  return {
    init: vi.fn(),
    ...extra,
  };
}

function createTaskManagerDelegationsMock() {
  const names = [
    'computeLineHash', 'lineSimilarity',
    'isShellSafe', 'extractTargetFilesFromDescription',
    'buildFileIndex', 'extractFileReferencesExpanded', 'resolveFileReferences',
    'isValidFilePath', 'extractModifiedFiles',
    'isModelLoadedOnHost', 'getHostActivity', 'pollHostActivity',
    'probeLocalGpuMetrics', 'probeRemoteGpuMetrics',
    'getTaskActivity', 'getAllTaskActivity', 'canAcceptTask',
    'registerInstance', 'startInstanceHeartbeat', 'stopInstanceHeartbeat',
    'unregisterInstance', 'updateInstanceInfo', 'isInstanceAlive', 'getMcpInstanceId',
    'cleanupJunkFiles', 'getFileChangesForValidation', 'findPlaceholderArtifacts',
    'checkFileQuality', 'checkDuplicateFiles', 'checkSyntax', 'runLLMSafeguards',
    'runBuildVerification', 'runTestVerification', 'runStyleCheck',
    'rollbackTaskChanges', 'revertScopedFiles', 'scopedRollback',
    'detectTaskTypes', 'getInstructionTemplate', 'wrapWithInstructions',
    'executeApiProvider', 'executeOllamaTask',
    'tryOllamaCloudFallback', 'tryLocalFirstFallback', 'classifyError',
    'handlePipelineStepCompletion', 'handleWorkflowTermination',
    'evaluateWorkflowDependencies', 'unblockTask', 'applyFailureAction',
    'cancelDependentTasks', 'checkWorkflowCompletion',
    'runOutputSafeguards',
    'handleSandboxRevertDetection',
    'handleAutoValidation', 'handleBuildTestStyleCommit', 'handleProviderFailover',
    'recordModelOutcome', 'recordProviderHealth', 'handlePostCompletion',
    'finalizeTask',
    'categorizeQueuedTasks', 'processQueueInternal',
    'cleanupOrphanedHostTasks', 'getStallThreshold',
  ];

  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
}

function createProcessTrackerMock() {
  return class ProcessTracker extends Map {
    constructor() {
      super();
      this.abortControllers = new Map();
      this.retryTimeouts = new Map();
      this.stallAttempts = new Map();
      this.cleanupGuard = new Map();
    }

    resetAll() {
      this.clear();
      this.abortControllers.clear();
      this.retryTimeouts.clear();
      this.stallAttempts.clear();
      this.cleanupGuard.clear();
    }

    markCleanedUp() {
      return true;
    }
  };
}

function installTaskManagerBoundaryMocks() {
  const db = {
    isReady: vi.fn(() => false),
    addTaskStatusTransitionListener: vi.fn(),
    onClose: vi.fn(),
    getProviderRateLimits: vi.fn(() => []),
    recordDailySnapshot: vi.fn(),
    resolveTaskId: vi.fn((taskId) => taskId),
    getTask: vi.fn(() => null),
    updateTaskStatus: vi.fn(),
    getRunningTasksForHost: vi.fn(() => []),
  };

  const container = {
    getModule: vi.fn((name) => (name === 'db' ? db : null)),
    defaultContainer: {
      has: vi.fn(() => false),
      get: vi.fn(() => null),
      peek: vi.fn(() => null),
    },
  };

  const providerRegistry = {
    init: vi.fn(),
    registerProviderClass: vi.fn(),
    resetInstances: vi.fn(),
    getProviderInstance: vi.fn(() => null),
  };
  const providerCfg = { init: vi.fn() };
  const serverConfig = createConfigMock();
  const taskCore = {
    getTask: vi.fn(() => null),
    updateTaskStatus: vi.fn(),
  };
  const coordination = {
    acquireLock: vi.fn(() => ({ acquired: true })),
    releaseLock: vi.fn(),
  };
  const providerRoutingCore = {
    analyzeTaskForRouting: vi.fn(),
  };

  const taskExecutionHooks = createInitModuleMock({
    buildPolicyTaskData: vi.fn(),
    getPolicyBlockReason: vi.fn(),
    evaluateTaskSubmissionPolicy: vi.fn(),
    evaluateTaskPreExecutePolicy: vi.fn(),
    fireTaskCompletionPolicyHook: vi.fn(),
  });
  const executionModule = createInitModuleMock({
    executeApiProvider: vi.fn(),
    executeOllamaTask: vi.fn(),
  });
  const executeApi = { setFreeQuotaTracker: vi.fn() };
  const postTask = createInitModuleMock();
  const fallbackRetry = createInitModuleMock({
    tryOllamaCloudFallback: vi.fn(),
    tryLocalFirstFallback: vi.fn(),
    tryStallRecovery: vi.fn(),
  });
  const workflowRuntime = createInitModuleMock({
    handlePipelineStepCompletion: vi.fn(),
    handleWorkflowTermination: vi.fn(),
    evaluateWorkflowDependencies: vi.fn(),
    unblockTask: vi.fn(),
    applyFailureAction: vi.fn(),
    cancelDependentTasks: vi.fn(),
    checkWorkflowCompletion: vi.fn(),
  });
  const outputSafeguards = createInitModuleMock({ runOutputSafeguards: vi.fn() });
  const orphanCleanup = createInitModuleMock({
    startTimers: vi.fn(),
    stopTimers: vi.fn(),
    getStallThreshold: vi.fn(() => 600),
    checkStalledTasks: vi.fn(),
    cleanupOrphanedHostTasks: vi.fn(),
  });
  const instanceManager = createInitModuleMock({
    registerInstance: vi.fn(),
    startInstanceHeartbeat: vi.fn(),
    stopInstanceHeartbeat: vi.fn(),
    unregisterInstance: vi.fn(),
    updateInstanceInfo: vi.fn(),
    isInstanceAlive: vi.fn(() => true),
    getMcpInstanceId: vi.fn(() => 'mcp-test'),
  });
  const prompts = createInitModuleMock({
    DEFAULT_INSTRUCTION_TEMPLATES: { default: '{TASK_DESCRIPTION}' },
    detectTaskTypes: vi.fn(() => []),
    getInstructionTemplate: vi.fn(() => '{TASK_DESCRIPTION}'),
    wrapWithInstructions: vi.fn((task) => task),
  });
  const closePhases = createInitModuleMock({
    handleAutoValidation: vi.fn(),
    handleBuildTestStyleCommit: vi.fn(),
    handleProviderFailover: vi.fn(),
  });
  const autoVerifyRetry = createInitModuleMock({ handleAutoVerifyRetry: vi.fn() });
  const retryFramework = createInitModuleMock({ handleRetryLogic: vi.fn() });
  const safeguardGates = createInitModuleMock({ handleSafeguardChecks: vi.fn() });
  const completionDetection = {
    detectSuccessFromOutput: vi.fn(() => false),
    detectOutputCompletion: vi.fn(() => false),
    COMPLETION_OUTPUT_THRESHOLDS: {},
    SHARED_COMPLETION_PATTERNS: [],
    PROVIDER_COMPLETION_PATTERNS: {},
  };
  const queueScheduler = createInitModuleMock({
    stop: vi.fn(),
    resolveCodexPendingTasks: vi.fn(),
    categorizeQueuedTasks: vi.fn(() => ({ ready: [] })),
    processQueueInternal: vi.fn(),
  });
  const taskFinalizer = createInitModuleMock({ finalizeTask: vi.fn() });
  const sandboxRevertDetection = { detectSandboxReverts: vi.fn() };
  const completionPipeline = createInitModuleMock({
    recordModelOutcome: vi.fn(),
    recordProviderHealth: vi.fn(),
    fireTerminalTaskHook: vi.fn(),
    handlePostCompletion: vi.fn(),
  });
  const fileContextBuilder = createInitModuleMock({
    extractJsFunctionBoundaries: vi.fn(),
    ensureTargetFilesExist: vi.fn(),
    buildFileContext: vi.fn(() => ''),
  });
  const providerRouter = createInitModuleMock({
    tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
    tryCreateAutoPR: vi.fn(),
    safeConfigInt: vi.fn((_key, fallback) => fallback),
    resolveProviderRouting: vi.fn(() => ({})),
    normalizeProviderOverride: vi.fn((provider) => provider || null),
    failTaskForInvalidProvider: vi.fn(),
    getProviderSlotLimits: vi.fn(() => ({})),
    getEffectiveGlobalMaxConcurrent: vi.fn(() => 1),
  });
  const taskUtils = {
    parseTaskMetadata: vi.fn(() => ({})),
    getTaskContextTokenEstimate: vi.fn(() => 0),
    shellEscape: vi.fn((value) => value),
    sanitizeTaskOutput: vi.fn((value) => value),
  };
  const planProjectResolver = createInitModuleMock({
    handleProjectDependencyResolution: vi.fn(),
    handlePlanProjectTaskCompletion: vi.fn(),
    handlePlanProjectTaskFailure: vi.fn(),
  });
  const processLifecycle = createInitModuleMock({
    safeDecrementHostSlot: vi.fn(),
    killProcessGraceful: vi.fn(),
    safeTriggerWebhook: vi.fn(),
    cleanupProcessTracking: vi.fn(),
    cleanupChildProcessListeners: vi.fn(),
    handleCloseCleanup: vi.fn(),
    spawnAndTrackProcess: vi.fn(),
  });
  const debugLifecycle = createInitModuleMock({
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    checkBreakpoints: vi.fn(),
    pauseTaskForDebug: vi.fn(),
    stepExecution: vi.fn(),
  });
  const processStreams = createInitModuleMock({
    setupStdoutHandler: vi.fn(),
    setupStderrHandler: vi.fn(),
  });
  const commandBuilders = createInitModuleMock({
    buildClaudeCliCommand: vi.fn(),
    buildCodexCommand: vi.fn(),
  });
  const taskStartup = createInitModuleMock({
    cleanupOrphanedRetryTimeouts: vi.fn(),
    MAX_OUTPUT_BUFFER: 1024,
    NVM_NODE_PATH: null,
    resolveWindowsCmdToNode: vi.fn((value) => value),
    recordTaskStartedAuditEvent: vi.fn(),
    createTaskStartupResourceLifecycle: vi.fn(),
    evaluateClaimedStartupPolicy: vi.fn(),
    buildProviderStartupCommand: vi.fn(),
    startTask: vi.fn(() => ({ status: 'running' })),
    attemptTaskStart: vi.fn(() => ({ started: true })),
    safeStartTask: vi.fn(() => ({ started: true })),
    estimateProgress: vi.fn(() => 0),
    getActualModifiedFiles: vi.fn(() => null),
    getTaskProgress: vi.fn(() => null),
    getRunningTaskCount: vi.fn(() => 0),
    hasRunningProcess: vi.fn(() => false),
    setSkipGitInCloseHandler: vi.fn(),
  });
  const hostMonitoring = createInitModuleMock({
    startTimers: vi.fn(),
    stopTimers: vi.fn(),
    isModelLoadedOnHost: vi.fn(() => false),
    getHostActivity: vi.fn(() => ({})),
    pollHostActivity: vi.fn(),
    probeLocalGpuMetrics: vi.fn(),
    probeRemoteGpuMetrics: vi.fn(),
  });
  const activityMonitoring = createInitModuleMock({
    getTaskActivity: vi.fn(() => null),
    getAllTaskActivity: vi.fn(() => []),
    canAcceptTask: vi.fn(() => true),
    checkFilesystemActivity: vi.fn(() => null),
  });

  installMock('../container', container);
  installMock('../db/task-core', taskCore);
  installMock('../db/coordination', coordination);
  installMock('../db/provider-routing-core', providerRoutingCore);
  installMock('../logger', createLoggerMock());
  installMock('../providers/registry', providerRegistry);
  installMock('../providers/config', providerCfg);
  installMock('../config', serverConfig);
  installMock('../free-quota-tracker', class FreeQuotaTracker {
    constructor(limits) {
      this.limits = limits;
      this.setDb = vi.fn();
    }
  });
  installMock('../scripts/gpu-metrics-server', {});
  installMock('../event-bus', { emitTaskUpdated: vi.fn() });
  installMock('../constants', {
    TASK_TIMEOUTS: {},
    PROVIDER_DEFAULT_TIMEOUTS: { codex: 600, ollama: 180 },
  });
  installMock('../utils/sanitize', { sanitizeLLMOutput: vi.fn((value) => value) });
  installMock('../utils/model', {
    parseModelSizeB: vi.fn(() => 0),
    isSmallModel: vi.fn(() => false),
    getModelSizeCategory: vi.fn(() => 'unknown'),
    isThinkingModel: vi.fn(() => false),
  });
  installMock('../utils/git', {
    parseGitStatusLine: vi.fn(),
    getModifiedFiles: vi.fn(() => []),
  });
  installMock('../utils/file-resolution', {});
  installMock('../utils/host-monitoring', hostMonitoring);
  installMock('../utils/context-enrichment', {});
  installMock('../utils/tsserver-client', createInitModuleMock());
  installMock('../utils/activity-monitoring', activityMonitoring);
  installMock('../policy-engine/task-execution-hooks', taskExecutionHooks);
  installMock('../providers/execution', executionModule);
  installMock('../providers/execute-api', executeApi);
  installMock('../validation/post-task', postTask);
  installMock('../execution/task-cancellation', vi.fn(() => ({
    cancelTask: vi.fn(),
    triggerCancellationWebhook: vi.fn(),
  })));
  installMock('../execution/stall-detection', vi.fn(() => ({
    isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    checkStalledTasks: vi.fn(),
    tryStallRecovery: vi.fn(),
  })));
  installMock('../execution/fallback-retry', fallbackRetry);
  installMock('../execution/workflow-runtime', workflowRuntime);
  installMock('../validation/output-safeguards', outputSafeguards);
  installMock('../maintenance/orphan-cleanup', orphanCleanup);
  installMock('../coordination/instance-manager', instanceManager);
  installMock('../providers/prompts', prompts);
  installMock('../validation/close-phases', closePhases);
  installMock('../validation/auto-verify-retry', autoVerifyRetry);
  installMock('../execution/retry-framework', retryFramework);
  installMock('../validation/safeguard-gates', safeguardGates);
  installMock('../validation/completion-detection', completionDetection);
  installMock('../execution/queue-scheduler', queueScheduler);
  installMock('../execution/task-finalizer', taskFinalizer);
  installMock('../execution/sandbox-revert-detection', sandboxRevertDetection);
  installMock('../execution/completion-pipeline', completionPipeline);
  installMock('../execution/file-context-builder', fileContextBuilder);
  installMock('../execution/provider-router', providerRouter);
  installMock('../execution/task-utils', taskUtils);
  installMock('../execution/plan-project-resolver', planProjectResolver);
  installMock('../execution/process-lifecycle', processLifecycle);
  installMock('../execution/debug-lifecycle', debugLifecycle);
  installMock('../execution/process-streams', processStreams);
  installMock('../execution/command-builders', commandBuilders);
  installMock('../execution/process-tracker', createProcessTrackerMock());
  installMock('../execution/task-startup', taskStartup);
  installMock('../providers/codex-intelligence', createInitModuleMock());
  installMock('../task-manager-delegations', createTaskManagerDelegationsMock());
  installMock('../maintenance/sleep-watchdog', {
    start: vi.fn(),
    stop: vi.fn(),
  });

  return {
    db,
    executionModule,
    fallbackRetry,
    workflowRuntime,
    completionPipeline,
    taskFinalizer,
    taskStartup,
    queueScheduler,
  };
}

function withDatabaseModuleBlocked(callback) {
  const originalLoad = Module._load;
  const databaseLoads = [];

  Module._load = function blockedDatabaseLoad(request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return originalLoad.call(this, request, parent, isMain);
    }

    if (resolved === DATABASE_MODULE_PATH) {
      databaseLoads.push({
        request,
        parent: parent?.filename || null,
      });
      throw new Error(`execution boundary must not load server/database.js via ${request}`);
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const result = callback();
    expect(databaseLoads).toEqual([]);
    return result;
  } finally {
    Module._load = originalLoad;
  }
}

function expectNoDirectDatabaseImport(modulePath) {
  const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
  expect(source).not.toMatch(DIRECT_DATABASE_IMPORT);
}

function stopQueueSchedulerIfLoaded() {
  const modulePath = require.resolve('../execution/queue-scheduler');
  const subject = require.cache[modulePath]?.exports;
  if (subject && typeof subject.stop === 'function') {
    subject.stop();
  }
}

describe('execution database import boundary', () => {
  afterEach(() => {
    stopQueueSchedulerIfLoaded();
    vi.restoreAllMocks();
    restoreCacheEntries();
  });

  it('loads queue-scheduler with injected dependencies without loading database.js', () => {
    const modulePath = '../execution/queue-scheduler';
    expectNoDirectDatabaseImport(modulePath);
    const mocks = installCommonBoundaryMocks();
    const db = {
      isReady: vi.fn(() => true),
      listTasks: vi.fn(() => []),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject.init({
        db,
        attemptTaskStart: vi.fn(() => ({ started: true })),
        notifyDashboard: vi.fn(),
      });
      subject.resolveCodexPendingTasks();

      expect(mocks.config.init).toHaveBeenCalledWith({ db });
      expect(db.listTasks).toHaveBeenCalledWith({ status: 'queued', limit: 100 });
    });
  });

  it('loads task-finalizer with injected services without loading database.js', () => {
    const modulePath = '../execution/task-finalizer';
    expectNoDirectDatabaseImport(modulePath);
    installCommonBoundaryMocks();
    const perfTracker = installMock('../db/provider-performance', {
      setDb: vi.fn(),
      recordTaskOutcome: vi.fn(),
      inferTaskType: vi.fn(() => 'general'),
    });
    const rawDb = {
      prepare: vi.fn(),
    };
    const db = {
      getDbInstance: vi.fn(() => rawDb),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject._testing.resetForTest();
      subject.init({ db });

      expect(perfTracker.setDb).toHaveBeenCalledWith(db);
      expect(typeof subject.createTaskFinalizer({}).finalizeTask).toBe('function');
    });
  });

  it('loads workflow-runtime with injected dependencies without loading database.js', () => {
    const modulePath = '../execution/workflow-runtime';
    expectNoDirectDatabaseImport(modulePath);
    const mocks = installCommonBoundaryMocks();
    const db = {
      getTaskDependencies: vi.fn(() => [{
        depends_on_task_id: 'dependency-task',
        depends_on_output: 'dependency output',
        depends_on_error_output: '',
        depends_on_exit_code: 0,
        depends_on_status: 'completed',
      }]),
      getWorkflowTasks: vi.fn(() => [{
        id: 'dependency-task',
        workflow_node_id: 'build',
      }]),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject.init({
        db,
        startTask: vi.fn(),
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        dashboard: { notifyTaskUpdated: vi.fn() },
      });
      const depTasks = subject.buildDepTasksMap('workflow-1', 'task-1');

      expect(mocks.config.init).toHaveBeenCalledWith({ db });
      expect(mocks.container.getModule).not.toHaveBeenCalled();
      expect(mocks.container.defaultContainer.has).not.toHaveBeenCalled();
      expect(depTasks).toEqual({
        build: {
          output: 'dependency output',
          error_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });
    });
  });

  it('refreshes blocked workflow snapshots through workflow-runtime without loading database.js', () => {
    const modulePath = '../handlers/workflow/dag';
    expectNoDirectDatabaseImport(modulePath);
    installCommonBoundaryMocks();
    const workflow = { id: 'workflow-1', name: 'Runtime Boundary Workflow' };
    const shared = {
      ErrorCodes: {},
      makeError: vi.fn(),
      requireTask: vi.fn(),
      requireWorkflow: vi.fn(() => ({ workflow })),
    };
    const workflowEngine = {
      getBlockedTasks: vi.fn(() => []),
    };
    const workflowRuntime = {
      refreshWorkflowBlockerSnapshots: vi.fn(),
    };

    installMock('../handlers/shared', shared);
    installMock('../db/task-core', {});
    installMock('../db/workflow-engine', workflowEngine);
    installMock('../execution/workflow-runtime', workflowRuntime);

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      const result = subject.handleBlockedTasks({ workflow_id: workflow.id });

      expect(shared.requireWorkflow).toHaveBeenCalledWith(workflow.id);
      expect(workflowRuntime.refreshWorkflowBlockerSnapshots).toHaveBeenCalledWith(workflow.id, { workflow });
      expect(workflowEngine.getBlockedTasks).toHaveBeenCalledWith(workflow.id);
      expect(result.content[0].text).toContain('No blocked tasks found');
    });
  });

  it('initializes task-manager runtime dependencies once against the injected db proxy', () => {
    const modulePath = '../task-manager';
    expectNoDirectDatabaseImport(modulePath);
    const mocks = installTaskManagerBoundaryMocks();

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject.initSubModules();
      subject.initSubModules();

      expect(mocks.workflowRuntime.init).toHaveBeenCalledTimes(1);
      expect(mocks.fallbackRetry.init).toHaveBeenCalledTimes(1);
      expect(mocks.taskStartup.init).toHaveBeenCalledTimes(1);
      expect(mocks.completionPipeline.init).toHaveBeenCalledTimes(1);
      expect(mocks.taskFinalizer.init).toHaveBeenCalledTimes(1);
      expect(mocks.queueScheduler.init).toHaveBeenCalledTimes(1);
      expect(mocks.db.addTaskStatusTransitionListener).toHaveBeenCalledTimes(1);

      const runtimeDeps = mocks.workflowRuntime.init.mock.calls[0][0];
      const fallbackDeps = mocks.fallbackRetry.init.mock.calls[0][0];
      const startupDeps = mocks.taskStartup.init.mock.calls[0][0];
      const executionDeps = mocks.executionModule.init.mock.calls[0][0];

      expect(runtimeDeps.db.__isTaskManagerDbProxy).toBe(true);
      expect(fallbackDeps.db).toBe(runtimeDeps.db);
      expect(startupDeps.db).toBe(runtimeDeps.db);
      expect(runtimeDeps.startTask).toBe(subject.startTask);
      expect(runtimeDeps.cancelTask).toBe(subject.cancelTask);
      expect(runtimeDeps.processQueue).toBe(subject.processQueue);
      expect(fallbackDeps.processQueue).toBe(subject.processQueue);
      expect(fallbackDeps.runningProcesses).toBe(startupDeps.runningProcesses);
      expect(fallbackDeps.stallRecoveryAttempts).toBe(startupDeps.stallRecoveryAttempts);
      expect(executionDeps.tryLocalFirstFallback).toBe(mocks.fallbackRetry.tryLocalFirstFallback);
      expect(executionDeps.tryOllamaCloudFallback).toBe(mocks.fallbackRetry.tryOllamaCloudFallback);
    });
  });
});
