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
    },
  };

  installCjsModuleMock('fs', mockFs);
  installCjsModuleMock('child_process', mockChildProcess);
  installCjsModuleMock('../logger', loggerMock);
  installCjsModuleMock('../constants', constantsMock);
  installCjsModuleMock('../utils/git', gitMock);
  installCjsModuleMock('../container', containerMock);

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
});
