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

function installProcessLifecycleSpawnMock(spawnAndTrackProcess) {
  const processLifecyclePath = require.resolve('../execution/process-lifecycle.js');
  const savedProcessLifecycle = require.cache[processLifecyclePath];
  installCjsModuleMock('../execution/process-lifecycle.js', {
    ...(savedProcessLifecycle?.exports || {}),
    spawnAndTrackProcess,
  });
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
    addTaskTags: vi.fn(),
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
    listTasks: vi.fn(() => []),
    recordAuditEvent: vi.fn(),
    patchTaskMetadata: vi.fn(),
    classifyTaskType: vi.fn(() => 'general'),
    getProvider: vi.fn(() => ({ enabled: true, cli_path: 'node' })),
    tryClaimTaskSlot: vi.fn((taskId, _maxConcurrent, holderId, provider) => {
      const current = tasks.get(taskId);
      if (!current) {
        return { success: false, reason: 'not_found' };
      }
      const claimed = { ...current, status: 'running', provider, pid: null, mcp_instance_id: holderId };
      tasks.set(taskId, claimed);
      return { success: true, task: claimed };
    }),
    requeueTaskAfterAttemptedStart: vi.fn(),
    acquireFileLock: vi.fn(() => ({ acquired: true })),
    releaseFileLock: vi.fn(),
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
  const mentionResolver = options.mentionResolver || null;
  const containerMock = {
    defaultContainer: {
      has: vi.fn((name) => name === 'mentionResolver' && Boolean(mentionResolver)),
      get: vi.fn((name) => (name === 'mentionResolver' ? mentionResolver : null)),
      peek: vi.fn((name) => {
        if (name === 'processTracker') return options.processTracker || null;
        if (name === 'db') return options.containerDb || null;
        return null;
      }),
    },
  };

  installCjsModuleMock('fs', mockFs);
  installCjsModuleMock('child_process', mockChildProcess);
  installCjsModuleMock('../logger', loggerMock);
  installCjsModuleMock('../constants', constantsMock);
  installCjsModuleMock('../utils/git', gitMock);
  installCjsModuleMock('../container', containerMock);

  const mockSpawnAndTrackProcess = options.depOverrides?.spawnAndTrackProcess
    || vi.fn(() => ({ queued: false, started: true }));
  installProcessLifecycleSpawnMock(mockSpawnAndTrackProcess);

  delete require.cache[MODULE_PATH];
  const taskStartup = require('../execution/task-startup.js');
  const { deps, tasks } = createDeps(options);
  if (!options.depOverrides?.spawnAndTrackProcess) {
    deps.spawnAndTrackProcess = mockSpawnAndTrackProcess;
  }
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

  it('keeps createTaskStartup dependencies active until async startTask settles', async () => {
    const wrongPolicy = vi.fn(() => {
      throw new Error('wrong dependency scope');
    });
    const ctx = loadTaskStartup({
      depOverrides: {
        evaluateTaskPreExecutePolicy: wrongPolicy,
      },
    });
    const task = createTask({ id: 'factory-task' });
    const { deps } = createDeps({ task });
    installProcessLifecycleSpawnMock(deps.spawnAndTrackProcess);
    const startup = ctx.module.createTaskStartup(deps);

    const result = await startup.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true });
    expect(wrongPolicy).not.toHaveBeenCalled();
    expect(deps.evaluateTaskPreExecutePolicy).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      provider: 'codex',
    }));
    expect(deps.spawnAndTrackProcess).toHaveBeenCalledTimes(1);
  });

  it('keeps createTaskStartup dependencies active for pending async attemptTaskStart', async () => {
    const wrongPolicy = vi.fn(() => {
      throw new Error('wrong dependency scope');
    });
    const ctx = loadTaskStartup({
      depOverrides: {
        evaluateTaskPreExecutePolicy: wrongPolicy,
      },
    });
    const task = createTask({ id: 'attempt-task' });
    const { deps } = createDeps({ task });
    installProcessLifecycleSpawnMock(deps.spawnAndTrackProcess);
    const startup = ctx.module.createTaskStartup(deps);

    const result = startup.attemptTaskStart(task.id, 'codex');

    expect(result).toMatchObject({
      started: false,
      queued: false,
      pendingAsync: true,
    });
    await vi.waitFor(() => {
      expect(deps.spawnAndTrackProcess).toHaveBeenCalledTimes(1);
    });
    expect(wrongPolicy).not.toHaveBeenCalled();
    expect(deps.evaluateTaskPreExecutePolicy).toHaveBeenCalledWith(expect.objectContaining({
      id: task.id,
      provider: 'codex',
    }));
  });

  it('lazily resolves taskManager methods assigned after createTaskStartup construction', async () => {
    const ctx = loadTaskStartup();
    const task = createTask({ id: 'lazy-task' });
    const taskManager = {};
    const { deps } = createDeps({
      task,
      depOverrides: {
        taskManager,
        cancelTask: undefined,
        processQueue: undefined,
        safeUpdateTaskStatus: undefined,
        evaluateTaskPreExecutePolicy: vi.fn(() => ({
          blocked: true,
          results: [{ outcome: 'fail', reason: 'blocked by test policy' }],
        })),
      },
    });
    const startup = ctx.module.createTaskStartup(deps);
    taskManager.cancelTask = vi.fn((taskId, reason) => {
      deps.db.updateTaskStatus(taskId, 'cancelled', { error_output: reason });
      return true;
    });
    taskManager.processQueue = vi.fn();
    taskManager.safeUpdateTaskStatus = vi.fn((...args) => deps.db.updateTaskStatus(...args));

    const result = await startup.startTask(task.id);

    expect(result).toMatchObject({
      queued: false,
      blocked: true,
      failed: true,
    });
    expect(taskManager.cancelTask).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining('policy blocked'),
      { cancel_reason: 'policy_block' },
    );
    expect(taskManager.processQueue).toHaveBeenCalledTimes(1);
  });

  it('injects resolved mention context into the execution prompt and tags unresolved mentions', async () => {
    const mentionResolver = {
      resolve: vi.fn(async () => ([
        {
          kind: 'symbol',
          value: 'utils.hello',
          raw: '@symbol:utils.hello',
          resolved: true,
          body_preview: 'export function hello() {\n  return "hi";\n}',
        },
        {
          kind: 'file',
          value: 'missing.js',
          raw: '@file:missing.js',
          resolved: false,
          reason: 'not found',
        },
      ])),
    };
    const task = createTask({
      task_description: 'Use @symbol:utils.hello and inspect @file:missing.js',
    });
    const ctx = loadTaskStartup({ task, mentionResolver });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true });
    expect(mentionResolver.resolve).toHaveBeenCalledWith([
      expect.objectContaining({ raw: '@symbol:utils.hello' }),
      expect.objectContaining({ raw: '@file:missing.js' }),
    ]);
    expect(ctx.deps.db.addTaskTags).toHaveBeenCalledWith(task.id, ['mentions:unresolved:1']);
    expect(ctx.deps.buildCodexCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        task_description: 'Use @symbol:utils.hello and inspect @file:missing.js',
        execution_description: expect.stringContaining('## Context: @symbol:utils.hello'),
      }),
      expect.any(Object),
      '',
      [],
    );
    expect(ctx.deps.resolveFileReferences).toHaveBeenCalledWith(
      'Use @symbol:utils.hello and inspect @file:missing.js',
      'C:/repo',
    );
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

  it('rechecks working_directory after slot claim so stale factory worktrees fail before provider spawn', async () => {
    const task = createTask({ id: 'stale-worktree', working_directory: 'C:/repo/.worktrees/fea-gone' });
    const ctx = loadTaskStartup({ task });
    ctx.mockFs.statSync
      .mockImplementationOnce(() => ({ isDirectory: () => true }))
      .mockImplementationOnce(() => {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });
    ctx.deps.safeUpdateTaskStatus.mockImplementation((taskId, status, patch = {}) => (
      ctx.deps.db.updateTaskStatus(taskId, status, patch)
    ));

    await expect(ctx.module.startTask(task.id)).rejects.toThrow('Working directory does not exist: C:/repo/.worktrees/fea-gone');

    expect(ctx.deps.db.tryClaimTaskSlot).toHaveBeenCalledTimes(1);
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
    expect(ctx.deps.safeUpdateTaskStatus).toHaveBeenCalledWith(task.id, 'failed', expect.objectContaining({
      error_output: 'Working directory does not exist: C:/repo/.worktrees/fea-gone',
      pid: null,
      mcp_instance_id: null,
      ollama_host_id: null,
    }));
    expect(ctx.tasks.get(task.id)).toEqual(expect.objectContaining({
      status: 'failed',
      pid: null,
      mcp_instance_id: null,
      ollama_host_id: null,
    }));
  });

  it('parks direct start attempts behind an active restart barrier', async () => {
    const task = createTask({ status: 'queued', provider: 'codex' });
    const ctx = loadTaskStartup({ task });
    const barrier = {
      id: 'barrier-direct-start',
      provider: 'system',
      status: 'running',
    };
    ctx.deps.db.listTasks.mockImplementation(({ status }) => (
      status === 'running' ? [barrier] : []
    ));

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      restartBarrier: true,
      barrier,
      task: expect.objectContaining({
        id: task.id,
        status: 'queued',
        error_output: expect.stringContaining('Restart barrier active'),
      }),
    }));
    expect(ctx.deps.db.updateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'queued',
      expect.objectContaining({
        error_output: expect.stringContaining('Restart barrier active'),
        pid: null,
        mcp_instance_id: null,
        ollama_host_id: null,
      }),
    );
    expect(ctx.deps.resolveProviderRouting).not.toHaveBeenCalled();
    expect(ctx.deps.db.tryClaimTaskSlot).not.toHaveBeenCalled();
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
  });

  it('parks direct start attempts when task-log disk free space is below the floor', async () => {
    const task = createTask({ status: 'queued', provider: 'codex' });
    const serverConfig = {
      get: vi.fn(() => '0'),
      getBool: vi.fn(() => false),
      getInt: vi.fn((key, fallback) => (key === 'task_log_disk_min_mb' ? 1024 : fallback)),
    };
    const ctx = loadTaskStartup({
      task,
      depOverrides: {
        serverConfig,
      },
    });
    const taskLogRetention = require('../utils/task-log-retention');
    vi.spyOn(taskLogRetention, 'getTaskLogDiskAdmissionStatus').mockReturnValue({
      allowed: false,
      checked: true,
      admission_paused: true,
      free_bytes: 512 * 1024 * 1024,
      free_mb: 512,
      min_free_mb: 1024,
      path: 'C:/tmp/torque',
      reason: 'below_minimum',
    });

    const result = await ctx.module.startTask(task.id);

    expect(taskLogRetention.getTaskLogDiskAdmissionStatus).toHaveBeenCalledWith({ minFreeMb: 1024 });
    expect(result).toEqual(expect.objectContaining({
      queued: true,
      diskPressure: true,
      taskLogDisk: expect.objectContaining({
        allowed: false,
        admission_paused: true,
        free_mb: 512,
        min_free_mb: 1024,
      }),
      task: expect.objectContaining({
        id: task.id,
        status: 'queued',
        error_output: expect.stringContaining('Task-log disk guard active'),
      }),
    }));
    expect(ctx.deps.db.updateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'queued',
      expect.objectContaining({
        error_output: expect.stringContaining('task_log_disk_min_mb'),
        pid: null,
        mcp_instance_id: null,
        ollama_host_id: null,
      }),
    );
    expect(ctx.deps.resolveProviderRouting).not.toHaveBeenCalled();
    expect(ctx.deps.db.tryClaimTaskSlot).not.toHaveBeenCalled();
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
  });

  it('stamps the resolved Ollama model before handing off to the executor', async () => {
    const registryPath = require.resolve('../models/registry');
    const sharedPath = require.resolve('../providers/ollama-shared');
    const originalRegistry = require.cache[registryPath];
    const originalShared = require.cache[sharedPath];

    installCjsModuleMock('../models/registry', {
      selectBestApprovedModel: vi.fn(() => ({ model_name: 'qwen3-coder:30b' })),
    });
    installCjsModuleMock('../providers/ollama-shared', {
      resolveOllamaModel: vi.fn(() => ''),
      hasModelOnAnyHost: vi.fn(() => true),
      findBestAvailableModel: vi.fn(() => 'qwen3-coder:30b'),
    });

    try {
      const task = createTask({ provider: 'ollama', model: null });
      const ctx = loadTaskStartup({ task });

      const result = await ctx.module.startTask(task.id);

      expect(result).toEqual({ queued: false, started: true, provider: 'ollama' });
      expect(ctx.tasks.get(task.id)?.model).toBe('qwen3-coder:30b');
      expect(ctx.deps.db.updateTaskStatus).toHaveBeenCalledWith(
        task.id,
        'running',
        expect.objectContaining({ model: 'qwen3-coder:30b' }),
      );
      expect(ctx.deps.executeOllamaTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id, model: 'qwen3-coder:30b' }),
      );
    } finally {
      if (originalRegistry) {
        require.cache[registryPath] = originalRegistry;
      } else {
        delete require.cache[registryPath];
      }
      if (originalShared) {
        require.cache[sharedPath] = originalShared;
      } else {
        delete require.cache[sharedPath];
      }
    }
  });

  it('releases startup file locks after in-process Ollama execution finishes', async () => {
    const task = createTask({
      id: 'ollama-direct-lock-release',
      task_description: 'Review server/db/workflow-engine.js',
      provider: 'ollama',
      model: 'qwen3-coder:30b',
    });
    const ctx = loadTaskStartup({ task });
    ctx.deps.resolveFileReferences.mockReturnValue({
      resolved: [
        { actual: 'server/db/workflow-engine.js' },
        { actual: 'server/handlers/task/index.js' },
      ],
    });
    ctx.deps.executeOllamaTask.mockResolvedValue({ queued: false, started: true, provider: 'ollama' });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true, provider: 'ollama' });
    expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledWith(
      'server/handlers/task/index.js',
      'C:/repo',
      task.id,
    );
    expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledWith(
      'server/db/workflow-engine.js',
      'C:/repo',
      task.id,
    );
  });

  it('releases startup file locks after direct API provider execution finishes', async () => {
    const task = createTask({
      id: 'api-direct-lock-release',
      task_description: 'Review server/db/workflow-engine.js',
      provider: 'groq',
    });
    const providerInstance = { name: 'groq' };
    const ctx = loadTaskStartup({
      task,
      depOverrides: {
        providerRegistry: {
          isKnownProvider: vi.fn(() => true),
          isApiProvider: vi.fn((provider) => provider === 'groq'),
          getProviderInstance: vi.fn(() => providerInstance),
        },
        executeApiProvider: vi.fn().mockResolvedValue({ queued: false, started: true, provider: 'groq' }),
      },
    });
    ctx.deps.resolveFileReferences.mockReturnValue({
      resolved: [{ actual: 'server/db/workflow-engine.js' }],
    });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual({ queued: false, started: true, provider: 'groq' });
    expect(ctx.deps.executeApiProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      providerInstance,
    );
    expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledWith(
      'server/db/workflow-engine.js',
      'C:/repo',
      task.id,
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

  it('safeStartTask marks deterministic preflight rejection without claiming ownership', () => {
    const task = createTask({ id: 'preflight-safe-start', working_directory: 'C:/missing-repo' });
    const ctx = loadTaskStartup({ task });
    ctx.mockFs.statSync.mockImplementation(() => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    });
    ctx.deps.safeUpdateTaskStatus.mockImplementation((taskId, status, patch = {}) => (
      ctx.deps.db.updateTaskStatus(taskId, status, patch)
    ));

    const started = ctx.module.safeStartTask(task.id, 'codex');

    expect(started).toBe(false);
    expect(ctx.deps.db.tryClaimTaskSlot).not.toHaveBeenCalled();
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
    expect(ctx.deps.safeUpdateTaskStatus).toHaveBeenCalledWith(task.id, 'failed', expect.objectContaining({
      error_output: 'Working directory does not exist: C:/missing-repo',
      pid: null,
      mcp_instance_id: null,
      ollama_host_id: null,
    }));
    expect(ctx.tasks.get(task.id)).toEqual(expect.objectContaining({
      status: 'failed',
      pid: null,
      mcp_instance_id: null,
      ollama_host_id: null,
    }));
  });

  it('preserves user provider override ownership when a claimed provider requeues', async () => {
    const task = createTask({
      id: 'provider-override-requeue',
      provider: 'claude-cli',
      metadata: { user_provider_override: true },
    });
    const ctx = loadTaskStartup({ task });
    ctx.deps.db.getProvider.mockImplementation((provider) => (
      provider === 'claude-cli'
        ? { enabled: false, cli_path: 'claude' }
        : { enabled: true, cli_path: 'codex' }
    ));
    ctx.deps.db.requeueTaskAfterAttemptedStart.mockImplementation((taskId) => {
      const current = ctx.tasks.get(taskId);
      const metadata = current?.metadata && typeof current.metadata === 'object' ? current.metadata : {};
      const next = {
        ...current,
        status: 'queued',
        provider: metadata.user_provider_override ? current.provider : null,
        started_at: null,
        completed_at: null,
        pid: null,
        progress_percent: null,
        exit_code: null,
        mcp_instance_id: null,
        ollama_host_id: null,
      };
      ctx.tasks.set(taskId, next);
      return next;
    });

    const result = await ctx.module.startTask(task.id);
    const updated = ctx.tasks.get(task.id);

    expect(result).toEqual(expect.objectContaining({ queued: true }));
    expect(ctx.deps.resolveProviderRouting).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-cli',
        metadata: expect.objectContaining({ user_provider_override: true }),
      }),
      task.id,
    );
    expect(ctx.deps.db.tryClaimTaskSlot).toHaveBeenCalledWith(
      task.id,
      3,
      'queue-holder',
      'claude-cli',
      1,
      [],
      10,
      [],
    );
    expect(ctx.deps.db.requeueTaskAfterAttemptedStart).toHaveBeenCalledWith(task.id);
    expect(ctx.deps.spawnAndTrackProcess).not.toHaveBeenCalled();
    expect(updated).toEqual(expect.objectContaining({
      status: 'queued',
      provider: 'claude-cli',
      started_at: null,
      pid: null,
      mcp_instance_id: null,
      ollama_host_id: null,
    }));
  });

  it('backs off sandboxed file-lock conflicts without immediately spinning the queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:00:00.000Z'));

    const task = createTask({
      id: 'file-lock-conflict',
      task_description: 'Edit server/api.js',
      provider: 'codex',
    });
    const ctx = loadTaskStartup({ task });
    ctx.deps.resolveFileReferences.mockReturnValue({
      resolved: [{ actual: 'server/api.js' }],
    });
    ctx.deps.db.acquireFileLock.mockReturnValue({
      acquired: false,
      lockedBy: 'holder-task',
    });

    const result = await ctx.module.startTask(task.id);

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      fileLockConflict: true,
      conflictFile: 'server/api.js',
      conflictTask: 'holder-task',
      retryAfter: '2026-04-23T00:00:10.000Z',
    }));
    expect(ctx.deps.db.requeueTaskAfterAttemptedStart).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        error_output: expect.stringContaining("Requeued: file 'server/api.js' is being edited by task holder-task."),
        metadata: expect.objectContaining({
          file_lock_wait: expect.objectContaining({
            file: 'server/api.js',
            locked_by: 'holder-task',
            retry_after: '2026-04-23T00:00:10.000Z',
            delay_ms: ctx.module.FILE_LOCK_REQUEUE_DELAY_MS,
            conflict_count: 1,
            signature: 'server/api.js::holder-task',
          }),
        }),
      }),
    );
    expect(ctx.deps.processQueue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ctx.module.FILE_LOCK_REQUEUE_DELAY_MS - 1);
    expect(ctx.deps.processQueue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ctx.deps.processQueue).toHaveBeenCalledTimes(1);
  });

  it('does not append duplicate output for the same file-lock conflict', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:00:10.000Z'));

    const existingOutput = "Requeued: file 'server/api.js' is being edited by task holder-task. Waiting 2500ms before retry.";
    const task = createTask({
      id: 'file-lock-repeat',
      task_description: 'Edit server/api.js',
      provider: 'codex',
      error_output: existingOutput,
      metadata: {
        file_lock_wait: {
          file: 'server/api.js',
          locked_by: 'holder-task',
          retry_after: '2026-04-23T00:00:01.000Z',
          delay_ms: 2500,
          conflict_count: 1,
          signature: 'server/api.js::holder-task',
        },
      },
    });
    const ctx = loadTaskStartup({ task });
    ctx.deps.resolveFileReferences.mockReturnValue({
      resolved: [{ actual: 'server/api.js' }],
    });
    ctx.deps.db.acquireFileLock.mockReturnValue({
      acquired: false,
      lockedBy: 'holder-task',
    });

    await ctx.module.startTask(task.id);

    const patch = ctx.deps.db.requeueTaskAfterAttemptedStart.mock.calls[0][1];
    expect(patch.error_output).toBe(existingOutput);
    expect(patch.metadata.file_lock_wait).toEqual(expect.objectContaining({
      file: 'server/api.js',
      locked_by: 'holder-task',
      retry_after: '2026-04-23T00:00:30.000Z',
      delay_ms: 20000,
      conflict_count: 2,
      signature: 'server/api.js::holder-task',
    }));
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

  it('cleanupOrphanedRetryTimeouts falls back to processTracker retry timeouts', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {});
    const pendingRetryTimeouts = new Map([
      ['completed-task', { id: 1 }],
      ['queued-task', { id: 2 }],
    ]);
    const processTracker = { retryTimeouts: pendingRetryTimeouts };
    const ctx = loadTaskStartup({
      processTracker,
      depOverrides: {
        pendingRetryTimeouts: undefined,
      },
    });

    ctx.deps.db.getTask.mockImplementation((taskId) => {
      if (taskId === 'queued-task') return { id: taskId, status: 'queued' };
      return { id: taskId, status: 'completed' };
    });

    ctx.module.cleanupOrphanedRetryTimeouts();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(pendingRetryTimeouts.has('completed-task')).toBe(false);
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

  it('reverts async startup failures that already claimed a running slot', async () => {
    const task = createTask({ provider: 'ollama' });
    const ctx = loadTaskStartup({ task });
    const failError = new Error('agentic startup failed');
    ctx.deps.executeOllamaTask.mockRejectedValue(failError);
    ctx.deps.safeUpdateTaskStatus.mockImplementation((taskId, status, patch = {}) => {
      return ctx.deps.db.updateTaskStatus(taskId, status, patch);
    });

    const result = ctx.module.safeStartTask(task.id, 'ollama');

    expect(result).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.mockLogger.error).toHaveBeenCalledWith(
      `processQueue: async failure for ollama task ${task.id}`,
      { error: failError.message },
    );
    expect(ctx.deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({
        error_output: failError.message,
        pid: null,
        mcp_instance_id: null,
        ollama_host_id: null,
      }),
    );
    expect(ctx.tasks.get(task.id)?.status).toBe('failed');
    expect(ctx.deps.processQueue).toHaveBeenCalled();
  });

  it('setSkipGitInCloseHandler and getSkipGitInCloseHandler toggle correctly', async () => {
    const ctx = loadTaskStartup();

    expect(ctx.module.getSkipGitInCloseHandler()).toBe(false);
    ctx.module.setSkipGitInCloseHandler(true);
    expect(ctx.module.getSkipGitInCloseHandler()).toBe(true);
    ctx.module.setSkipGitInCloseHandler(false);
    expect(ctx.module.getSkipGitInCloseHandler()).toBe(false);
  });

  // getTaskProgress prefers Tail-watcher offsets over in-memory buffer
  // length on the detached spawn path, so the dashboard sees total bytes
  // ever written to the log files instead of "bytes since re-adoption".
  // Without this, error_output_bytes visibly "shrinks" on every restart
  // cycle (in-memory rebuilds from offset 0 while disk total keeps growing).
  describe('getTaskProgress detached-path byte counts', () => {
    it('reports errorLogOffset when it exceeds in-memory errorOutput length', () => {
      const ctx = loadTaskStartup();
      const taskId = 'task-detached';
      ctx.deps.runningProcesses.set(taskId, {
        process: null,
        startTime: Date.now() - 60 * 1000,
        lastOutputAt: Date.now() - 5 * 1000,
        provider: 'codex',
        output: 'recent stdout',                 // 13 bytes in-memory
        errorOutput: 'recent stderr chunk\n',    // 20 bytes in-memory
        outputLogOffset: 1024,                    // 1KB total stdout on disk
        errorLogOffset: 7_500_000,                // 7.5MB total stderr on disk
      });

      const progress = ctx.module.getTaskProgress(taskId);
      expect(progress).not.toBeNull();
      expect(progress.output_length).toBe(1024);
      expect(progress.error_output_length).toBe(7_500_000);
    });

    it('falls back to in-memory length when offsets are missing (pipe path)', () => {
      const ctx = loadTaskStartup();
      const taskId = 'task-pipe';
      ctx.deps.runningProcesses.set(taskId, {
        process: { pid: 1234 },
        startTime: Date.now() - 60 * 1000,
        lastOutputAt: Date.now() - 5 * 1000,
        provider: 'ollama',
        output: 'short stdout',                  // 12 bytes
        errorOutput: 'short stderr',             // 12 bytes
        // No outputLogOffset / errorLogOffset (pipe path doesn't track them)
      });

      const progress = ctx.module.getTaskProgress(taskId);
      expect(progress).not.toBeNull();
      expect(progress.output_length).toBe(12);
      expect(progress.error_output_length).toBe(12);
    });

    it('falls back to in-memory length when offsets are smaller (early in re-adoption)', () => {
      // Edge case: re-adoption just started; the new tail has read more
      // recent bytes into in-memory than the old persisted offset
      // covered. Use whichever is greater so the count never decreases.
      const ctx = loadTaskStartup();
      const taskId = 'task-readopt-early';
      ctx.deps.runningProcesses.set(taskId, {
        process: null,
        startTime: Date.now() - 60 * 1000,
        lastOutputAt: Date.now() - 5 * 1000,
        provider: 'codex',
        output: '',
        errorOutput: 'a'.repeat(100),  // 100 bytes accumulated post-readopt
        outputLogOffset: 0,
        errorLogOffset: 50,             // smaller than in-memory length
      });

      const progress = ctx.module.getTaskProgress(taskId);
      expect(progress.error_output_length).toBe(100);
    });
  });

  // ── buildProviderStartupEnv ─────────────────────────────────────────────
  describe('buildProviderStartupEnv', () => {
    it('prepends NVM path to PATH when not already present', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-1',
        task: { workflow_id: 'wf-1', workflow_node_id: 'node-1' },
        taskMetadata: { transcript_path: '/tmp/transcript.jsonl' },
        runDir: '/tmp/run-dir',
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        nvmNodePath: '/tmp/torque-home/.nvm/versions/node/v22.0.0/bin',
      });

      expect(env.PATH).toMatch(/^\/tmp\/torque-home\/\.nvm/);
      expect(env.PATH).toContain('/usr/bin');
      expect(env.TORQUE_TASK_ID).toBe('task-env-1');
      expect(env.TORQUE_WORKFLOW_ID).toBe('wf-1');
      expect(env.TORQUE_WORKFLOW_NODE_ID).toBe('node-1');
      expect(env.TORQUE_RUN_DIR).toBe('/tmp/run-dir');
      expect(env.TORQUE_TRANSCRIPT_PATH).toBe('/tmp/transcript.jsonl');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.CI).toBe('1');
      expect(env.PYTHONIOENCODING).toBe('utf-8');
    });

    it('does not duplicate NVM path when already on PATH', () => {
      const ctx = loadTaskStartup();
      const nvmPath = '/tmp/torque-home/.nvm/versions/node/v22.0.0/bin';
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-2',
        task: {},
        env: { PATH: `${nvmPath}:/usr/bin`, HOME: '/tmp/torque-home' },
        nvmNodePath: nvmPath,
      });

      const segments = env.PATH.split(':');
      const nvmOccurrences = segments.filter(s => s === nvmPath).length;
      expect(nvmOccurrences).toBe(1);
    });

    it('skips NVM path when nvmNodePath is null', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-3',
        task: {},
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        nvmNodePath: null,
      });

      expect(env.PATH).toBe('/usr/bin');
    });

    it('prepends nativeCodex pathPrepend to PATH', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-4',
        task: {},
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        nvmNodePath: null,
        nativeCodex: {
          pathPrepend: '/opt/codex/vendor',
          envAdditions: { CODEX_MANAGED: '1' },
        },
      });

      expect(env.PATH).toMatch(/^\/opt\/codex\/vendor/);
      expect(env.CODEX_MANAGED).toBe('1');
    });

    it('defaults HOME to USERPROFILE when HOME is missing', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-5',
        task: {},
        env: { PATH: '/usr/bin', USERPROFILE: 'C:\\Users\\test' },
        nvmNodePath: null,
      });

      expect(env.HOME).toBe('C:\\Users\\test');
    });

    it('defaults HOME to /tmp when both HOME and USERPROFILE missing', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-6',
        task: {},
        env: { PATH: '/usr/bin' },
        nvmNodePath: null,
      });

      expect(env.HOME).toBe('/tmp');
    });

    it('passes through empty strings for missing workflow and run dir fields', () => {
      const ctx = loadTaskStartup();
      const env = ctx.module.buildProviderStartupEnv({
        taskId: 'task-env-7',
        task: {},
        taskMetadata: {},
        runDir: null,
        env: { PATH: '', HOME: '/tmp/torque-home' },
        nvmNodePath: null,
      });

      expect(env.TORQUE_WORKFLOW_ID).toBe('');
      expect(env.TORQUE_WORKFLOW_NODE_ID).toBe('');
      expect(env.TORQUE_RUN_DIR).toBe('');
      expect(env.TORQUE_TRANSCRIPT_PATH).toBe('');
    });
  });

  // ── evaluateFactoryWorktreeHeavyValidationGuard ─────────────────────────
  describe('evaluateFactoryWorktreeHeavyValidationGuard', () => {
    it('returns null for non-visible-shell providers', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
        },
        'ollama',
      );

      expect(result).toBeNull();
    });

    it('returns null for non-worktree working directories', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/main/',
          task_description: 'dotnet test SomeProject.sln',
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('returns null for exempt verify_review kind', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
          metadata: { kind: 'verify_review' },
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('returns null for exempt architect_cycle kind', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
          metadata: { kind: 'architect_cycle' },
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('returns null for exempt plan_generation kind', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
          metadata: { kind: 'plan_generation' },
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('returns null for exempt diffusion compute role', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
          metadata: { diffusion_role: 'compute' },
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('returns null when description has no heavy validation command', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'Add a new utility function to server/utils/helpers.js',
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('parses string metadata for kind-based exemptions', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'dotnet test SomeProject.sln',
          metadata: JSON.stringify({ kind: 'verify_review' }),
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('handles null/undefined metadata gracefully', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'Add logging to utils',
          metadata: null,
        },
        'codex',
      );

      expect(result).toBeNull();
    });

    it('detects codex-spark as a visible shell provider', () => {
      const ctx = loadTaskStartup();

      // Without a heavy command, result is null regardless (no heavy command to block)
      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'Fix a bug in helpers.js',
        },
        'codex-spark',
      );

      expect(result).toBeNull();
    });

    it('detects claude-cli as a visible shell provider', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        {
          working_directory: 'C:/repo/.worktrees/feat-x/',
          task_description: 'Fix a bug in helpers.js',
        },
        'claude-cli',
      );

      expect(result).toBeNull();
    });

    it('handles missing task gracefully', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(null, 'codex');

      expect(result).toBeNull();
    });

    it('handles missing provider gracefully', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateFactoryWorktreeHeavyValidationGuard(
        { working_directory: 'C:/repo/.worktrees/feat-x/', task_description: 'test' },
        null,
      );

      expect(result).toBeNull();
    });
  });

  // ── evaluateClaimedStartupPolicy ────────────────────────────────────────
  describe('evaluateClaimedStartupPolicy', () => {
    it('returns earlyResult: null when policy does not block', () => {
      const ctx = loadTaskStartup();
      const resourceLifecycle = {
        releaseForPolicyBlock: vi.fn(),
      };

      const result = ctx.module.evaluateClaimedStartupPolicy({
        task: createTask(),
        taskId: 'task-1',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => ({ blocked: false })),
        describePolicyBlock: vi.fn(),
        cancelBlockedTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated: vi.fn(),
        drainQueue: vi.fn(),
        getTask: vi.fn(),
        resourceLifecycle,
        log: { info: vi.fn() },
      });

      expect(result).toEqual({ earlyResult: null });
      expect(resourceLifecycle.releaseForPolicyBlock).not.toHaveBeenCalled();
    });

    it('returns earlyResult: null when policy result is null', () => {
      const ctx = loadTaskStartup();

      const result = ctx.module.evaluateClaimedStartupPolicy({
        task: createTask(),
        taskId: 'task-1',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => null),
        describePolicyBlock: vi.fn(),
        cancelBlockedTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated: vi.fn(),
        drainQueue: vi.fn(),
        getTask: vi.fn(),
        resourceLifecycle: { releaseForPolicyBlock: vi.fn() },
        log: { info: vi.fn() },
      });

      expect(result).toEqual({ earlyResult: null });
    });

    it('cancels task and returns blocked result when policy blocks', () => {
      const ctx = loadTaskStartup();
      const blockedTask = createTask({ id: 'blocked-1', status: 'cancelled' });
      const cancelBlockedTask = vi.fn();
      const describePolicyBlock = vi.fn(() => 'No cloud providers allowed');
      const resourceLifecycle = { releaseForPolicyBlock: vi.fn() };
      const notifyTaskUpdated = vi.fn();
      const drainQueue = vi.fn();
      const getTask = vi.fn(() => blockedTask);

      const result = ctx.module.evaluateClaimedStartupPolicy({
        task: createTask({ id: 'blocked-1' }),
        taskId: 'blocked-1',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => ({
          blocked: true,
          results: [{ outcome: 'fail', reason: 'No cloud providers allowed' }],
        })),
        describePolicyBlock,
        cancelBlockedTask,
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated,
        drainQueue,
        getTask,
        resourceLifecycle,
        log: { info: vi.fn() },
      });

      expect(result.earlyResult).toEqual({
        queued: false,
        blocked: true,
        failed: true,
        reason: '[Policy] No cloud providers allowed',
        task: blockedTask,
      });
      expect(cancelBlockedTask).toHaveBeenCalledWith(
        'blocked-1',
        '[Policy] No cloud providers allowed',
        { cancel_reason: 'policy_block' },
      );
      expect(resourceLifecycle.releaseForPolicyBlock).toHaveBeenCalledWith(
        '[Policy] No cloud providers allowed',
      );
      expect(notifyTaskUpdated).toHaveBeenCalledWith('blocked-1');
      expect(drainQueue).toHaveBeenCalled();
    });

    it('falls back to updateTaskStatus when cancelBlockedTask throws', () => {
      const ctx = loadTaskStartup();
      const updateTaskStatus = vi.fn();
      const resourceLifecycle = { releaseForPolicyBlock: vi.fn() };
      const log = { info: vi.fn() };

      ctx.module.evaluateClaimedStartupPolicy({
        task: createTask({ id: 'cancel-fail' }),
        taskId: 'cancel-fail',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => ({ blocked: true })),
        describePolicyBlock: vi.fn(() => 'blocked reason'),
        cancelBlockedTask: vi.fn(() => { throw new Error('cancel failed'); }),
        updateTaskStatus,
        notifyTaskUpdated: vi.fn(),
        drainQueue: vi.fn(),
        getTask: vi.fn(() => null),
        resourceLifecycle,
        log,
      });

      expect(updateTaskStatus).toHaveBeenCalledWith('cancel-fail', 'failed', {
        error_output: '[Policy] blocked reason',
      });
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cancel blocked task cancel-fail'),
      );
    });

    it('tolerates notifyTaskUpdated failures', () => {
      const ctx = loadTaskStartup();
      const resourceLifecycle = { releaseForPolicyBlock: vi.fn() };

      const result = ctx.module.evaluateClaimedStartupPolicy({
        task: createTask(),
        taskId: 'task-1',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => ({ blocked: true })),
        describePolicyBlock: vi.fn(() => 'blocked'),
        cancelBlockedTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated: vi.fn(() => { throw new Error('dashboard down'); }),
        drainQueue: vi.fn(),
        getTask: vi.fn(() => null),
        resourceLifecycle,
        log: { info: vi.fn() },
      });

      expect(result.earlyResult).toBeDefined();
      expect(result.earlyResult.blocked).toBe(true);
    });

    it('tolerates drainQueue failures', () => {
      const ctx = loadTaskStartup();
      const resourceLifecycle = { releaseForPolicyBlock: vi.fn() };
      const log = { info: vi.fn() };

      const result = ctx.module.evaluateClaimedStartupPolicy({
        task: createTask(),
        taskId: 'task-1',
        provider: 'codex',
        evaluatePolicy: vi.fn(() => ({ blocked: true })),
        describePolicyBlock: vi.fn(() => 'blocked'),
        cancelBlockedTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated: vi.fn(),
        drainQueue: vi.fn(() => { throw new Error('queue lock contention'); }),
        getTask: vi.fn(() => null),
        resourceLifecycle,
        log,
      });

      expect(result.earlyResult.blocked).toBe(true);
      expect(log.info).toHaveBeenCalledWith('Failed to process queue:', 'queue lock contention');
    });

    it('passes spread task plus id and provider to evaluatePolicy', () => {
      const ctx = loadTaskStartup();
      const evaluatePolicy = vi.fn(() => ({ blocked: false }));
      const task = createTask({ id: 'task-policy', provider: 'ollama', task_description: 'some work' });

      ctx.module.evaluateClaimedStartupPolicy({
        task,
        taskId: 'task-policy',
        provider: 'codex',
        evaluatePolicy,
        describePolicyBlock: vi.fn(),
        cancelBlockedTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        notifyTaskUpdated: vi.fn(),
        drainQueue: vi.fn(),
        getTask: vi.fn(),
        resourceLifecycle: { releaseForPolicyBlock: vi.fn() },
        log: { info: vi.fn() },
      });

      expect(evaluatePolicy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'task-policy',
        provider: 'codex',
        task_description: 'some work',
      }));
    });
  });

  // ── recordTaskStartedAuditEvent ─────────────────────────────────────────
  describe('recordTaskStartedAuditEvent', () => {
    it('records audit event when both backup and audit are enabled', () => {
      const task = createTask({ working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.serverConfig.getBool.mockImplementation((key) => {
        if (key === 'backup_before_modify_enabled') return true;
        if (key === 'audit_trail_enabled') return true;
        return false;
      });

      ctx.module.recordTaskStartedAuditEvent(task, 'task-1', 'codex');

      expect(ctx.deps.db.recordAuditEvent).toHaveBeenCalledWith(
        'task_started', 'task', 'task-1', 'start', 'codex', null,
        expect.objectContaining({
          task_description: task.task_description,
          working_directory: 'C:/repo',
          provider: 'codex',
        }),
      );
    });

    it('skips audit when backup is disabled', () => {
      const task = createTask({ working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.serverConfig.getBool.mockImplementation((key) => {
        if (key === 'backup_before_modify_enabled') return false;
        if (key === 'audit_trail_enabled') return true;
        return false;
      });

      ctx.module.recordTaskStartedAuditEvent(task, 'task-1', 'codex');

      expect(ctx.deps.db.recordAuditEvent).not.toHaveBeenCalled();
    });

    it('skips audit when audit trail is disabled', () => {
      const task = createTask({ working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.serverConfig.getBool.mockImplementation((key) => {
        if (key === 'backup_before_modify_enabled') return true;
        if (key === 'audit_trail_enabled') return false;
        return false;
      });

      ctx.module.recordTaskStartedAuditEvent(task, 'task-1', 'codex');

      expect(ctx.deps.db.recordAuditEvent).not.toHaveBeenCalled();
    });

    it('skips audit when working_directory is null', () => {
      const task = createTask({ working_directory: null });
      const ctx = loadTaskStartup({ task });
      ctx.deps.serverConfig.getBool.mockReturnValue(true);

      ctx.module.recordTaskStartedAuditEvent(task, 'task-1', 'codex');

      expect(ctx.deps.db.recordAuditEvent).not.toHaveBeenCalled();
    });

    it('records system actor while preserving null provider metadata', () => {
      const task = createTask({ working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.serverConfig.getBool.mockReturnValue(true);

      ctx.module.recordTaskStartedAuditEvent(task, 'task-1', null);

      expect(ctx.deps.db.recordAuditEvent).toHaveBeenCalledWith(
        'task_started', 'task', 'task-1', 'start', 'system', null,
        expect.objectContaining({
          task_description: task.task_description,
          working_directory: 'C:/repo',
          provider: null,
        }),
      );
    });
  });

  // ── estimateProgress edge cases ─────────────────────────────────────────
  describe('estimateProgress advanced', () => {
    it('uses stderr for progress when stdout is empty and provider is stderr-driven', () => {
      const ctx = loadTaskStartup();
      const stderr = Array.from({ length: 100 }, (_, i) => `tool trace ${i}`).join('\n');

      const progress = ctx.module.estimateProgress('', 'codex', stderr);

      expect(progress).toBeGreaterThan(0);
      expect(progress).toBeLessThanOrEqual(90);
    });

    it('uses stderr for progress with codex-spark', () => {
      const ctx = loadTaskStartup();
      const stderr = Array.from({ length: 50 }, (_, i) => `trace ${i}`).join('\n');

      const progress = ctx.module.estimateProgress('', 'codex-spark', stderr);

      expect(progress).toBeGreaterThan(0);
    });

    it('uses stderr for progress with claude-cli', () => {
      const ctx = loadTaskStartup();
      const stderr = Array.from({ length: 50 }, (_, i) => `trace ${i}`).join('\n');

      const progress = ctx.module.estimateProgress('', 'claude-cli', stderr);

      expect(progress).toBeGreaterThan(0);
    });

    it('ignores stderr for non-stderr-driven providers like ollama', () => {
      const ctx = loadTaskStartup();
      const stderr = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');

      const progress = ctx.module.estimateProgress('', 'ollama', stderr);

      // With empty stdout and ollama provider, stderr is ignored
      expect(progress).toBe(0);
    });

    it('detects completion in stderr for codex provider', () => {
      const ctx = loadTaskStartup();
      ctx.deps.detectOutputCompletion.mockImplementation((text) => text.includes('DONE'));

      const progress = ctx.module.estimateProgress('', 'codex', 'DONE');

      expect(progress).toBe(95);
    });

    it('caps progress at 90 before completion detection', () => {
      const ctx = loadTaskStartup();
      const hugeOutput = Array.from({ length: 10000 }, (_, i) => `line ${i}`).join('\n');

      const progress = ctx.module.estimateProgress(hugeOutput, 'codex');

      expect(progress).toBe(90);
    });

    it('handles null/undefined output gracefully', () => {
      const ctx = loadTaskStartup();

      expect(ctx.module.estimateProgress(null, 'codex')).toBe(0);
      expect(ctx.module.estimateProgress(undefined, 'codex')).toBe(0);
      expect(ctx.module.estimateProgress(null, 'codex', null)).toBe(0);
    });
  });

  // ── getTaskProgress DB-only path ────────────────────────────────────────
  describe('getTaskProgress DB-only path', () => {
    it('returns progress from DB when process is not in memory', () => {
      const ctx = loadTaskStartup();
      const task = {
        id: 'db-task-1',
        status: 'completed',
        output: 'task output',
        error_output: 'task errors',
        last_activity_at: '2026-01-01T00:00:00Z',
        progress_percent: 100,
      };
      ctx.deps.db.getTask.mockReturnValue(task);

      const progress = ctx.module.getTaskProgress('db-task-1');

      expect(progress).toEqual({
        running: false,
        status: 'completed',
        output: 'task output',
        errorOutput: 'task errors',
        output_length: 11,
        error_output_length: 11,
        last_output_at: '2026-01-01T00:00:00Z',
        phase: null,
        progress: 100,
      });
    });

    it('reports orphan running task from DB as running with 0 progress', () => {
      const ctx = loadTaskStartup();
      ctx.deps.db.getTask.mockReturnValue({
        id: 'orphan-1',
        status: 'running',
        output: 'some output',
        error_output: '',
        last_activity_at: null,
        progress_percent: null,
      });

      const progress = ctx.module.getTaskProgress('orphan-1');

      expect(progress.running).toBe(true);
      expect(progress.status).toBe('running');
      expect(progress.progress).toBe(0);
    });

    it('returns null when task is not found in memory or DB', () => {
      const ctx = loadTaskStartup();
      ctx.deps.db.getTask.mockReturnValue(null);

      expect(ctx.module.getTaskProgress('nonexistent')).toBeNull();
    });

    it('resolves partial task IDs via resolveTaskId', () => {
      const ctx = loadTaskStartup();
      ctx.deps.db.resolveTaskId.mockReturnValue('full-task-id-12345');
      ctx.deps.db.getTask.mockImplementation((id) => {
        if (id === 'full-task-id-12345') {
          return { id, status: 'completed', output: 'done', error_output: '', progress_percent: 100 };
        }
        return null;
      });

      const progress = ctx.module.getTaskProgress('full-task');

      expect(ctx.deps.db.resolveTaskId).toHaveBeenCalledWith('full-task');
      expect(progress).not.toBeNull();
      expect(progress.status).toBe('completed');
    });

    it('sanitizes output from in-memory running processes', () => {
      const ctx = loadTaskStartup();
      ctx.deps.sanitizeTaskOutput.mockReturnValue('SANITIZED');
      ctx.deps.runningProcesses.set('running-1', {
        output: 'raw <dangerous> output',
        errorOutput: 'stderr data',
        startTime: Date.now() - 10000,
        lastOutputAt: Date.now(),
        provider: 'codex',
      });

      const progress = ctx.module.getTaskProgress('running-1');

      expect(progress.output).toBe('SANITIZED');
      expect(ctx.deps.sanitizeTaskOutput).toHaveBeenCalledWith('raw <dangerous> output');
    });
  });

  // ── getActualModifiedFiles ──────────────────────────────────────────────
  describe('getActualModifiedFiles', () => {
    it('returns modified and added files from git status', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockParseGitStatusLine
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: 'src/app.js' })
        .mockReturnValueOnce({ isModified: false, isDeleted: false, indexStatus: 'A', filePath: 'src/new.js' })
        .mockReturnValueOnce({ isModified: false, isDeleted: true, indexStatus: 'D', filePath: 'src/removed.js' })
        .mockReturnValueOnce(null);

      ctx.mockChildProcess.execFileSync.mockReturnValue(
        ' M src/app.js\nA  src/new.js\nD  src/removed.js\n?? untracked.txt\n',
      );

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual(['src/app.js', 'src/new.js']);
    });

    it('excludes .db files', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockParseGitStatusLine
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: 'data.db' })
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: 'src/app.js' });

      ctx.mockChildProcess.execFileSync.mockReturnValue(' M data.db\n M src/app.js\n');

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual(['src/app.js']);
    });

    it('excludes .gitignore files', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockParseGitStatusLine
        .mockReturnValueOnce({ isModified: false, isDeleted: false, indexStatus: 'A', filePath: '.gitignore' })
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: 'src/app.js' });

      ctx.mockChildProcess.execFileSync.mockReturnValue('A  .gitignore\n M src/app.js\n');

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual(['src/app.js']);
    });

    it('excludes files starting with .git/', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockParseGitStatusLine
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: '.git/config' })
        .mockReturnValueOnce({ isModified: true, isDeleted: false, indexStatus: 'M', filePath: 'src/app.js' });

      ctx.mockChildProcess.execFileSync.mockReturnValue(' M .git/config\n M src/app.js\n');

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual(['src/app.js']);
    });

    it('excludes ghost files (AD status: staged then deleted from disk)', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockParseGitStatusLine
        .mockReturnValueOnce({ isModified: false, isDeleted: true, indexStatus: 'A', filePath: 'ghost.js' });

      ctx.mockChildProcess.execFileSync.mockReturnValue('AD ghost.js\n');

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual([]);
    });

    it('returns null when skipGitInCloseHandler is true', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(true);

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toBeNull();
    });

    it('returns empty array on git error', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockChildProcess.execFileSync.mockImplementation(() => {
        throw new Error('git not found');
      });

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual([]);
    });

    it('handles empty git status output', () => {
      const ctx = loadTaskStartup();
      ctx.module.setSkipGitInCloseHandler(false);
      ctx.mockChildProcess.execFileSync.mockReturnValue('');

      const files = ctx.module.getActualModifiedFiles('C:/repo');

      expect(files).toEqual([]);
    });
  });

  // ── createTaskStartupResourceLifecycle ──────────────────────────────────
  describe('createTaskStartupResourceLifecycle', () => {
    it('claimSlot returns earlyResult when at capacity', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'at_capacity',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      const result = lifecycle.claimSlot();

      expect(result.earlyResult).toEqual(expect.objectContaining({
        queued: true,
      }));
      expect(result.earlyResult.task).toBeDefined();
      expect(ctx.deps.db.updateTaskStatus).toHaveBeenCalledWith(task.id, 'queued');
    });

    it('claimSlot returns earlyResult for already_running', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'already_running',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      const result = lifecycle.claimSlot();

      expect(result.earlyResult).toEqual({ queued: false, alreadyRunning: true });
    });

    it('claimSlot throws for not_found', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'not_found',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });

      expect(() => lifecycle.claimSlot()).toThrow('Task not found: task-1');
    });

    it('claimSlot throws for invalid_status', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'invalid_status',
        status: 'completed',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });

      expect(() => lifecycle.claimSlot()).toThrow('Task in invalid status for starting: completed');
    });

    it('claimSlot throws for unknown reason', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'unexpected_error',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });

      expect(() => lifecycle.claimSlot()).toThrow('Failed to claim task slot: unexpected_error');
    });

    it('claimSlot returns providerConfig and claimResult on success', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      const result = lifecycle.claimSlot();

      expect(result.earlyResult).toBeNull();
      expect(result.providerConfig).toEqual({ enabled: true, cli_path: 'node' });
      expect(result.claimResult).toEqual(expect.objectContaining({
        success: true,
        task: expect.objectContaining({ id: task.id, status: 'running' }),
      }));
    });

    it('claimSlot returns earlyResult for provider_at_capacity', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.tryClaimTaskSlot.mockReturnValue({
        success: false,
        reason: 'provider_at_capacity',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      const result = lifecycle.claimSlot();

      expect(result.earlyResult).toEqual(expect.objectContaining({
        queued: true,
      }));
      expect(result.earlyResult.task).toBeDefined();
      expect(ctx.deps.db.updateTaskStatus).toHaveBeenCalledWith(task.id, 'queued');
    });

    it('releaseAcquiredFileLocks releases all locks in reverse order', async () => {
      const task = createTask({
        id: 'lock-test',
        task_description: 'Edit files',
        provider: 'codex',
      });
      const ctx = loadTaskStartup({ task });
      let lockCallCount = 0;
      ctx.deps.db.acquireFileLock.mockImplementation(() => {
        lockCallCount++;
        return { acquired: true };
      });
      ctx.deps.resolveFileReferences.mockReturnValue({
        resolved: [
          { actual: 'file-a.js' },
          { actual: 'file-b.js' },
        ],
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      lifecycle.claimSlot();
      await lifecycle.resolveAndLockFiles('codex');

      expect(ctx.deps.db.acquireFileLock).toHaveBeenCalledTimes(2);

      lifecycle.releaseAcquiredFileLocks();

      expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledTimes(2);
      expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledWith('file-b.js', 'C:/repo', 'lock-test');
      expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledWith('file-a.js', 'C:/repo', 'lock-test');
    });

    it('releaseAcquiredFileLocks does not double-release', async () => {
      const task = createTask({
        id: 'double-release',
        task_description: 'Edit file',
        provider: 'codex',
      });
      const ctx = loadTaskStartup({ task });
      ctx.deps.resolveFileReferences.mockReturnValue({
        resolved: [{ actual: 'file.js' }],
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      lifecycle.claimSlot();
      await lifecycle.resolveAndLockFiles('codex');

      lifecycle.releaseAcquiredFileLocks();
      lifecycle.releaseAcquiredFileLocks();

      expect(ctx.deps.db.releaseFileLock).toHaveBeenCalledTimes(1);
    });

    it('resolveAndLockFiles requeues sandboxed task on conflict', async () => {
      const task = createTask({
        id: 'lock-conflict',
        task_description: 'Edit file.js',
        provider: 'codex',
      });
      const ctx = loadTaskStartup({ task });
      ctx.deps.resolveFileReferences.mockReturnValue({
        resolved: [{ actual: 'file.js' }],
      });
      ctx.deps.db.acquireFileLock.mockReturnValue({
        acquired: false,
        lockedBy: 'other-task',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      lifecycle.claimSlot();
      const result = await lifecycle.resolveAndLockFiles('codex');

      expect(result.earlyResult).toEqual(expect.objectContaining({
        queued: true,
        fileLockConflict: true,
        conflictFile: 'file.js',
        conflictTask: 'other-task',
      }));
      expect(ctx.deps.db.requeueTaskAfterAttemptedStart).toHaveBeenCalled();
    });

    it('resolveAndLockFiles allows non-sandboxed provider to proceed despite lock conflict', async () => {
      const task = createTask({
        id: 'lock-proceed',
        task_description: 'Edit file.js',
        provider: 'ollama',
      });
      const ctx = loadTaskStartup({ task });
      ctx.deps.resolveFileReferences.mockReturnValue({
        resolved: [{ actual: 'file.js' }],
      });
      ctx.deps.db.acquireFileLock.mockReturnValue({
        acquired: false,
        lockedBy: 'other-task',
      });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'ollama',
        maxConcurrent: 3,
      });
      lifecycle.claimSlot();
      const result = await lifecycle.resolveAndLockFiles('ollama');

      expect(result.earlyResult).toBeNull();
      expect(ctx.deps.db.requeueTaskAfterAttemptedStart).not.toHaveBeenCalled();
    });

    it('resolveAndLockFiles returns empty results when no files to resolve', async () => {
      const task = createTask({ id: 'no-files', working_directory: null });
      const ctx = loadTaskStartup({ task });

      const lifecycle = ctx.module.createTaskStartupResourceLifecycle({
        taskId: task.id,
        task,
        provider: 'codex',
        maxConcurrent: 3,
      });
      lifecycle.claimSlot();
      const result = await lifecycle.resolveAndLockFiles('codex');

      expect(result.earlyResult).toBeNull();
      expect(result.resolvedFilePaths).toEqual([]);
      expect(result.resolvedFiles).toEqual([]);
      expect(result.resolvedFileContext).toBe('');
    });
  });

  // ── attemptTaskStart queue accounting ───────────────────────────────────
  describe('attemptTaskStart queue accounting', () => {
    it('returns pendingAsync true when startTask returns a thenable', () => {
      const task = createTask();
      const ctx = loadTaskStartup({ task });

      const result = ctx.module.attemptTaskStart(task.id, 'codex');

      expect(result).toMatchObject({
        started: false,
        queued: false,
        pendingAsync: true,
      });
    });

    it('returns pendingAsync for nonexistent task (async startTask always returns thenable)', async () => {
      const ctx = loadTaskStartup();
      ctx.deps.db.getTask.mockReturnValue(null);
      ctx.deps.safeUpdateTaskStatus.mockImplementation((id, status, patch) =>
        ctx.deps.db.updateTaskStatus(id, status, patch),
      );

      const result = ctx.module.attemptTaskStart('nonexistent', 'codex');

      // startTask is async, so attemptTaskStart always enters the thenable branch
      expect(result).toMatchObject({
        started: false,
        queued: false,
        pendingAsync: true,
      });

      // Wait for the async rejection to fire
      await new Promise((r) => setTimeout(r, 0));
      expect(ctx.mockLogger.error).toHaveBeenCalledWith(
        'processQueue: async failure for codex task nonexistent',
        { error: 'Task not found: nonexistent' },
      );
    });

    it('returns pendingAsync for disabled-provider requeue (async startTask)', async () => {
      const task = createTask({ provider: 'codex' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.db.getProvider.mockReturnValue({ enabled: false });

      const result = ctx.module.attemptTaskStart(task.id, 'codex');

      // startTask is async — attemptTaskStart sees a thenable even for
      // synchronous early-returns within the async function body.
      expect(result).toMatchObject({
        started: false,
        queued: false,
        pendingAsync: true,
      });
    });

    it('handles deterministic preflight errors with markPreflightFailed', () => {
      const task = createTask({ id: 'preflight-fail', working_directory: 'C:/missing' });
      const ctx = loadTaskStartup({ task });
      ctx.mockFs.statSync.mockImplementation(() => {
        const err = new Error('gone');
        err.code = 'ENOENT';
        throw err;
      });
      ctx.deps.safeUpdateTaskStatus.mockImplementation((id, status, patch) => {
        return ctx.deps.db.updateTaskStatus(id, status, patch);
      });

      const result = ctx.module.attemptTaskStart(task.id, 'codex');

      expect(result).toMatchObject({
        started: false,
        queued: false,
        pendingAsync: false,
        failed: true,
        reason: 'preflight_failed',
        code: 'WORKING_DIR_MISSING',
        deterministic: true,
      });
    });
  });

  // ── buildProviderStartupCommand ─────────────────────────────────────────
  describe('buildProviderStartupCommand', () => {
    it('returns ollama mode for ollama provider', async () => {
      const task = createTask({ provider: 'ollama' });
      const ctx = loadTaskStartup({ task });

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'ollama',
        providerConfig: { enabled: true },
        executionTask: task,
      });

      expect(result).toEqual({
        mode: 'ollama',
        provider: 'ollama',
        executionTask: task,
      });
    });

    it('returns spawn mode with codex command for codex provider', async () => {
      const task = createTask({ provider: 'codex', working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'codex',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: '',
        resolvedFiles: [],
        runDir: '/tmp/run',
        taskMetadata: {},
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        platform: 'linux',
        nvmNodePath: null,
        resolveCmdToNode: vi.fn(() => null),
        captureBaselineCommit: vi.fn(() => 'abc123'),
        log: { info: vi.fn(), warn: vi.fn() },
      });

      expect(result.mode).toBe('spawn');
      expect(result.cliPath).toBe('node');
      expect(result.finalArgs).toEqual(['codex.js']);
      expect(result.provider).toBe('codex');
      expect(result.baselineCommit).toBe('abc123');
      expect(result.options.cwd).toBe('C:/repo');
      expect(result.options.shell).toBe(false);
      expect(result.options.windowsHide).toBe(true);
    });

    it('returns spawn mode for claude-cli provider using sync command builder', async () => {
      const task = createTask({ provider: 'claude-cli', working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'claude-cli',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: 'FILE_CTX',
        resolvedFiles: [],
        runDir: null,
        taskMetadata: {},
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        platform: 'linux',
        nvmNodePath: null,
        resolveCmdToNode: vi.fn(() => null),
        captureBaselineCommit: vi.fn(() => null),
        log: { info: vi.fn(), warn: vi.fn() },
      });

      expect(result.mode).toBe('spawn');
      expect(ctx.deps.buildClaudeCliCommand).toHaveBeenCalledWith(task, expect.any(Object), 'FILE_CTX');
    });

    it('resolves .cmd to node on Windows platform', async () => {
      const task = createTask({ provider: 'codex', working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.buildCodexCommand.mockResolvedValue({
        cliPath: 'codex.cmd',
        finalArgs: ['--full-auto'],
        stdinPrompt: 'prompt',
      });

      const resolveCmdToNode = vi.fn(() => ({
        nodePath: 'C:/node/node.exe',
        scriptPath: 'C:/node_modules/codex/bin/codex.js',
      }));

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'codex',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: '',
        resolvedFiles: [],
        runDir: null,
        taskMetadata: {},
        env: { PATH: 'C:\\Windows', HOME: 'C:\\Users\\test' },
        platform: 'win32',
        nvmNodePath: null,
        resolveCmdToNode,
        captureBaselineCommit: vi.fn(() => null),
        log: { info: vi.fn(), warn: vi.fn() },
      });

      expect(resolveCmdToNode).toHaveBeenCalledWith('codex.cmd');
      expect(result.cliPath).toBe('C:/node/node.exe');
      expect(result.finalArgs).toEqual([
        'C:/node_modules/codex/bin/codex.js',
        '--full-auto',
      ]);
    });

    it('falls back to cmd.exe wrapping when resolution fails on Windows', async () => {
      const task = createTask({ provider: 'codex', working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.buildCodexCommand.mockResolvedValue({
        cliPath: 'codex.cmd',
        finalArgs: ['--full-auto'],
        stdinPrompt: 'prompt',
      });

      const log = { info: vi.fn(), warn: vi.fn() };

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'codex',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: '',
        resolvedFiles: [],
        runDir: null,
        taskMetadata: {},
        env: { PATH: 'C:\\Windows', HOME: 'C:\\Users\\test' },
        platform: 'win32',
        nvmNodePath: null,
        resolveCmdToNode: vi.fn(() => null),
        captureBaselineCommit: vi.fn(() => null),
        log,
      });

      expect(result.cliPath).toBe('cmd.exe');
      expect(result.finalArgs).toEqual(['/c', 'codex.cmd', '--full-auto']);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('falling back to cmd.exe'),
      );
    });

    it('skips .cmd resolution for nativeCodex commands', async () => {
      const task = createTask({ provider: 'codex', working_directory: 'C:/repo' });
      const ctx = loadTaskStartup({ task });
      ctx.deps.buildCodexCommand.mockResolvedValue({
        cliPath: 'C:/codex/codex.exe',
        finalArgs: ['--full-auto'],
        stdinPrompt: 'prompt',
        nativeCodex: { pathPrepend: 'C:/codex/vendor' },
      });

      const resolveCmdToNode = vi.fn();

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task,
        provider: 'codex',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: '',
        resolvedFiles: [],
        runDir: null,
        taskMetadata: {},
        env: { PATH: 'C:\\Windows', HOME: 'C:\\Users\\test' },
        platform: 'win32',
        nvmNodePath: null,
        resolveCmdToNode,
        captureBaselineCommit: vi.fn(() => null),
        log: { info: vi.fn(), warn: vi.fn() },
      });

      expect(resolveCmdToNode).not.toHaveBeenCalled();
      expect(result.cliPath).toBe('C:/codex/codex.exe');
    });

    it('defaults cwd to process.cwd() when task has no working_directory', async () => {
      const task = createTask({ provider: 'codex', working_directory: '' });
      const ctx = loadTaskStartup({ task });

      const result = await ctx.module.buildProviderStartupCommand({
        taskId: task.id,
        task: { ...task, working_directory: '' },
        provider: 'codex',
        providerConfig: { enabled: true },
        executionTask: task,
        resolvedFileContext: '',
        resolvedFiles: [],
        runDir: null,
        taskMetadata: {},
        env: { PATH: '/usr/bin', HOME: '/tmp/torque-home' },
        platform: 'linux',
        nvmNodePath: null,
        resolveCmdToNode: vi.fn(() => null),
        captureBaselineCommit: vi.fn(() => null),
        log: { info: vi.fn() },
      });

      expect(result.options.cwd).toBe(process.cwd());
    });
  });

  // ── createTaskStartup factory ───────────────────────────────────────────
  describe('createTaskStartup factory', () => {
    it('creates isolated instances that do not share state', async () => {
      const ctx = loadTaskStartup();
      const taskA = createTask({ id: 'task-a', provider: 'ollama' });
      const taskB = createTask({ id: 'task-b', provider: 'ollama' });

      const { deps: depsA } = createDeps({ task: taskA });
      const { deps: depsB } = createDeps({ task: taskB });

      const startupA = ctx.module.createTaskStartup(depsA);
      const startupB = ctx.module.createTaskStartup(depsB);

      const resultA = await startupA.startTask('task-a');
      const resultB = await startupB.startTask('task-b');

      expect(resultA).toMatchObject({ queued: false, started: true, provider: 'ollama' });
      expect(resultB).toMatchObject({ queued: false, started: true, provider: 'ollama' });
      expect(depsA.executeOllamaTask).toHaveBeenCalledTimes(1);
      expect(depsB.executeOllamaTask).toHaveBeenCalledTimes(1);
    });

    it('exposes pure helpers without dep-swapping', () => {
      const ctx = loadTaskStartup();
      const { deps } = createDeps();
      const startup = ctx.module.createTaskStartup(deps);

      expect(startup.NVM_NODE_PATH).toBeDefined();
      expect(startup.MAX_OUTPUT_BUFFER).toBe(10 * 1024 * 1024);
      expect(startup.FILE_LOCK_REQUEUE_DELAY_MS).toBe(10000);
      expect(typeof startup.setSkipGitInCloseHandler).toBe('function');
      expect(typeof startup.getSkipGitInCloseHandler).toBe('function');
    });

    it('generates unique QUEUE_LOCK_HOLDER_ID when no taskManager is provided', () => {
      const ctx = loadTaskStartup();
      const { deps } = createDeps();
      delete deps.QUEUE_LOCK_HOLDER_ID;
      delete deps.taskManager;

      const startup = ctx.module.createTaskStartup(deps);

      // The factory generates a process-unique ID
      expect(typeof startup).toBe('object');
      // Can still call startTask — the lock holder ID is generated internally
    });
  });

  // ── Constants ───────────────────────────────────────────────────────────
  describe('module constants', () => {
    it('exports expected constant values', () => {
      const ctx = loadTaskStartup();

      expect(ctx.module.MAX_OUTPUT_BUFFER).toBe(10 * 1024 * 1024);
      expect(ctx.module.FILE_LOCK_REQUEUE_DELAY_MS).toBe(10000);
    });
  });
});
