import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = require.resolve('../execution/task-startup.js');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    status: 'pending',
    task_description: 'Implement startup tests',
    working_directory: 'C:/repo',
    provider: 'codex',
    metadata: {},
    context: '',
    model: null,
    error_output: '',
    ...overrides,
  };
}

function createDeps({ task = createTask(), depOverrides = {} } = {}) {
  const tasks = new Map([[task.id, task]]);

  const db = {
    getTask: vi.fn((taskId) => tasks.get(taskId) ?? null),
    getDefaultProvider: vi.fn(() => 'codex'),
    updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
      const current = tasks.get(taskId) ?? { id: taskId };
      const updated = { ...current, status, ...patch };
      tasks.set(taskId, updated);
      return updated;
    }),
    checkRateLimit: vi.fn(() => ({ allowed: true })),
    checkDuplicateTask: vi.fn(() => ({ isDuplicate: false })),
    recordTaskFingerprint: vi.fn(),
    isBudgetExceeded: vi.fn(() => ({ exceeded: false, warning: false })),
    recordAuditEvent: vi.fn(),
    patchTaskMetadata: vi.fn(),
    classifyTaskType: vi.fn(() => 'general'),
    getProvider: vi.fn(() => ({ enabled: true, cli_path: 'node' })),
    tryClaimTaskSlot: vi.fn((taskId, _maxConcurrent, _holderId, provider) => {
      const current = tasks.get(taskId);
      if (!current) {
        return { success: false, reason: 'not_found' };
      }
      const claimed = { ...current, status: 'running', provider, pid: null };
      tasks.set(taskId, claimed);
      return { success: true, task: claimed };
    }),
    requeueTaskAfterAttemptedStart: vi.fn(),
    acquireFileLock: vi.fn(() => ({ acquired: true })),
    resolveTaskId: vi.fn((taskId) => taskId),
  };

  const dashboard = {
    notifyTaskUpdated: vi.fn(),
  };

  const serverConfig = {
    get: vi.fn(() => '0'),
    getBool: vi.fn(() => false),
  };

  const providerRegistry = {
    isKnownProvider: vi.fn(() => true),
    isApiProvider: vi.fn(() => false),
    getProviderInstance: vi.fn(() => null),
  };

  const gpuMetrics = {
    getPressureLevel: vi.fn(() => 'normal'),
  };

  const runningProcesses = new Map();
  const pendingRetryTimeouts = new Map();

  const deps = {
    db,
    dashboard,
    serverConfig,
    providerRegistry,
    gpuMetrics,
    runningProcesses,
    pendingRetryTimeouts,
    parseTaskMetadata: vi.fn((metadata) => {
      if (metadata && typeof metadata === 'object') {
        return { ...metadata };
      }
      return {};
    }),
    getTaskContextTokenEstimate: vi.fn(() => 0),
    safeUpdateTaskStatus: vi.fn(),
    resolveProviderRouting: vi.fn((taskToRoute) => ({ provider: taskToRoute.provider || 'codex' })),
    failTaskForInvalidProvider: vi.fn(() => 'Unknown provider'),
    getProviderSlotLimits: vi.fn(() => ({
      providerLimit: 1,
      providerGroup: [],
      categoryLimit: 10,
      categoryProviderGroup: [],
    })),
    getEffectiveGlobalMaxConcurrent: vi.fn(() => 3),
    spawnAndTrackProcess: vi.fn(() => ({ queued: false, started: true })),
    buildClaudeCliCommand: vi.fn(() => ({
      cliPath: 'node',
      finalArgs: ['claude-cli.js'],
      stdinPrompt: 'claude prompt',
    })),
    buildCodexCommand: vi.fn().mockResolvedValue({
      cliPath: 'node',
      finalArgs: ['codex.js'],
      stdinPrompt: 'codex prompt',
    }),
    buildFileContext: vi.fn(async () => 'FILE_CONTEXT'),
    resolveFileReferences: vi.fn(() => ({ resolved: [] })),
    executeOllamaTask: vi.fn(() => ({ queued: false, started: true, provider: 'ollama' })),
    executeApiProvider: vi.fn(() => ({ queued: false, started: true, provider: 'api' })),
    evaluateTaskPreExecutePolicy: vi.fn(() => ({ blocked: false })),
    getPolicyBlockReason: vi.fn(() => 'policy blocked'),
    cancelTask: vi.fn(),
    processQueue: vi.fn(),
    sanitizeTaskOutput: vi.fn((value) => value),
    detectOutputCompletion: vi.fn(() => false),
    QUEUE_LOCK_HOLDER_ID: 'queue-holder',
  };

  for (const [key, value] of Object.entries(depOverrides)) {
    deps[key] = value;
  }

  return { deps, tasks };
}

function loadTaskStartup(options = {}) {
  vi.stubEnv('CODEX_NODE_PATH', '');
  vi.stubEnv('NVM_BIN', '');
  vi.stubEnv('NVM_DIR', '');

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockFs = {
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    accessSync: vi.fn(() => {
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    }),
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => false),
  };

  const mockChildProcess = {
    execFileSync: vi.fn((command) => {
      if (command === 'git') return 'abc123\n';
      return '';
    }),
  };

  const mockParseGitStatusLine = vi.fn(() => null);

  if (options.fsOverrides) {
    Object.assign(mockFs, options.fsOverrides);
  }
  if (options.childProcessOverrides) {
    Object.assign(mockChildProcess, options.childProcessOverrides);
  }

  const loggerMock = { child: vi.fn(() => mockLogger) };
  const constantsMock = { TASK_TIMEOUTS: { GIT_STATUS: 1000 } };
  const gitMock = { parseGitStatusLine: mockParseGitStatusLine };

  installCjsModuleMock('fs', mockFs);
  installCjsModuleMock('child_process', mockChildProcess);
  installCjsModuleMock('../logger', loggerMock);
  installCjsModuleMock('../constants', constantsMock);
  installCjsModuleMock('../utils/git', gitMock);

  delete require.cache[MODULE_PATH];
  const taskStartup = require('../execution/task-startup.js');
  const { deps, tasks } = createDeps(options);
  taskStartup.init(deps);

  return {
    module: taskStartup,
    deps,
    tasks,
    mockFs,
    mockChildProcess,
    mockLogger,
    mockParseGitStatusLine,
  };
}

describe('task-startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('init stores injected dependencies correctly', async () => {
    const runningProcesses = new Map([
      ['task-1', { output: '', provider: 'codex', startTime: Date.now() }],
      ['task-2', { output: '', provider: 'codex', startTime: Date.now() }],
    ]);
    const task = createTask();
    const ctx = loadTaskStartup({
      task,
      depOverrides: {
        runningProcesses,
      },
    });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true });
    expect(ctx.deps.resolveProviderRouting).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      task_description: task.task_description,
    }), task.id);
    expect(ctx.deps.parseTaskMetadata).toHaveBeenCalled();
    expect(ctx.deps.getTaskContextTokenEstimate).toHaveBeenCalled();
    expect(ctx.deps.getProviderSlotLimits).toHaveBeenCalledWith('codex', expect.objectContaining({ enabled: true }));
    expect(ctx.deps.buildCodexCommand).toHaveBeenCalled();
    expect(ctx.deps.spawnAndTrackProcess).toHaveBeenCalledTimes(1);
    expect(ctx.module.getRunningTaskCount()).toBe(2);
  });

  it('startTask calls runPreflightChecks and proceeds to execution on success', async () => {
    const task = createTask({ working_directory: 'C:/valid-repo' });
    const ctx = loadTaskStartup({ task });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true });
    expect(ctx.mockFs.statSync).toHaveBeenCalledWith('C:/valid-repo');
    expect(ctx.deps.db.tryClaimTaskSlot).toHaveBeenCalledTimes(1);
    expect(ctx.deps.spawnAndTrackProcess).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ id: task.id, status: 'running' }),
      expect.objectContaining({
        cliPath: 'node',
        finalArgs: ['codex.js'],
        stdinPrompt: 'codex prompt',
        provider: 'codex',
        baselineCommit: 'abc123',
      }),
    );
  });

  it('startTask fails gracefully when runPreflightChecks rejects the task', async () => {
    const task = createTask({ working_directory: 'C:/missing-repo' });
    const ctx = loadTaskStartup({ task });
    ctx.mockFs.statSync.mockImplementation(() => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    });

    await expect(ctx.module.startTask(task.id)).rejects.toThrow('Working directory does not exist: C:/missing-repo');
    expect(ctx.deps.resolveProviderRouting).not.toHaveBeenCalled();
    expect(ctx.deps.db.tryClaimTaskSlot).not.toHaveBeenCalled();
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
  });

  it('runPreflightChecks validates description and working_directory', async () => {
    const ctx = loadTaskStartup();

    ctx.mockFs.statSync.mockImplementation(() => {
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => ctx.module.runPreflightChecks({
      task_description: 'Build feature',
      working_directory: 'C:/missing',
    })).toThrow('Working directory does not exist: C:/missing');

    ctx.mockFs.statSync.mockReturnValue({ isDirectory: () => true });
    expect(() => ctx.module.runPreflightChecks({
      task_description: '   ',
      working_directory: 'C:/repo',
    })).toThrow('Task description cannot be empty');
  });

  it('estimateProgress returns bounded progress from output heuristics', async () => {
    const ctx = loadTaskStartup();
    const largeOutput = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');

    expect(ctx.module.estimateProgress('', 'codex')).toBe(0);
    expect(ctx.module.estimateProgress(largeOutput, 'codex')).toBe(90);

    ctx.deps.detectOutputCompletion.mockReturnValue(true);
    expect(ctx.module.estimateProgress('done', 'codex')).toBe(95);
  });

  it('getRunningTaskCount returns the size of the injected runningProcesses map', async () => {
    const runningProcesses = new Map([
      ['task-1', {}],
      ['task-2', {}],
      ['task-3', {}],
    ]);
    const ctx = loadTaskStartup({
      depOverrides: {
        runningProcesses,
      },
    });

    expect(ctx.module.getRunningTaskCount()).toBe(3);
  });

  it('hasRunningProcess returns true and false correctly', async () => {
    const runningProcesses = new Map([
      ['task-1', {}],
    ]);
    const ctx = loadTaskStartup({
      depOverrides: {
        runningProcesses,
      },
    });

    expect(ctx.module.hasRunningProcess('task-1')).toBe(true);
    expect(ctx.module.hasRunningProcess('task-2')).toBe(false);
  });

  it('cleanupOrphanedRetryTimeouts clears timeouts for completed and missing tasks', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {});
    const pendingRetryTimeouts = new Map([
      ['completed-task', { id: 1 }],
      ['missing-task', { id: 2 }],
      ['queued-task', { id: 3 }],
    ]);
    const ctx = loadTaskStartup({
      depOverrides: {
        pendingRetryTimeouts,
      },
    });

    ctx.deps.db.getTask.mockImplementation((taskId) => {
      if (taskId === 'completed-task') return { id: taskId, status: 'completed' };
      if (taskId === 'queued-task') return { id: taskId, status: 'queued' };
      return null;
    });

    ctx.module.cleanupOrphanedRetryTimeouts();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(pendingRetryTimeouts.has('completed-task')).toBe(false);
    expect(pendingRetryTimeouts.has('missing-task')).toBe(false);
    expect(pendingRetryTimeouts.has('queued-task')).toBe(true);
  });

  it('safeStartTask catches and logs startTask errors without throwing', async () => {
    const ctx = loadTaskStartup();
    ctx.deps.db.getTask.mockReturnValue(null);

    let result;
    expect(() => {
      result = ctx.module.safeStartTask('missing-task', 'codex');
    }).not.toThrow();

    expect(result).toBe(false);
    // Flush microtask queue so the .catch() handler in attemptTaskStart fires
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.mockLogger.error).toHaveBeenCalledWith(
      'processQueue: async failure for codex task missing-task',
      { error: 'Task not found: missing-task' },
    );
  });

  it('setSkipGitInCloseHandler and getSkipGitInCloseHandler toggle correctly', async () => {
    const ctx = loadTaskStartup();

    expect(ctx.module.getSkipGitInCloseHandler()).toBe(false);
    ctx.module.setSkipGitInCloseHandler(true);
    expect(ctx.module.getSkipGitInCloseHandler()).toBe(true);
    ctx.module.setSkipGitInCloseHandler(false);
    expect(ctx.module.getSkipGitInCloseHandler()).toBe(false);
  });
});
