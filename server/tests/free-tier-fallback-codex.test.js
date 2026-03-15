'use strict';

const EXECUTE_API_PATH = require.resolve('../providers/execute-api');
const V2_TASK_HANDLERS_PATH = require.resolve('../api/v2-task-handlers');
const LOGGER_PATH = require.resolve('../logger');
const SANITIZE_PATH = require.resolve('../utils/sanitize');
const CONTEXT_STUFFING_PATH = require.resolve('../utils/context-stuffing');
const UUID_PATH = require.resolve('uuid');
const DB_PATH = require.resolve('../database');
const CONFIG_PATH = require.resolve('../config');
const CONSTANTS_PATH = require.resolve('../constants');
const CONTROL_PLANE_PATH = require.resolve('../api/v2-control-plane');
const MIDDLEWARE_PATH = require.resolve('../api/middleware');
const PIPELINE_PATH = require.resolve('../handlers/task/pipeline');

const ORIGINAL_CACHE_ENTRIES = new Map([
  [EXECUTE_API_PATH, require.cache[EXECUTE_API_PATH]],
  [V2_TASK_HANDLERS_PATH, require.cache[V2_TASK_HANDLERS_PATH]],
  [LOGGER_PATH, require.cache[LOGGER_PATH]],
  [SANITIZE_PATH, require.cache[SANITIZE_PATH]],
  [CONTEXT_STUFFING_PATH, require.cache[CONTEXT_STUFFING_PATH]],
  [UUID_PATH, require.cache[UUID_PATH]],
  [DB_PATH, require.cache[DB_PATH]],
  [CONFIG_PATH, require.cache[CONFIG_PATH]],
  [CONSTANTS_PATH, require.cache[CONSTANTS_PATH]],
  [CONTROL_PLANE_PATH, require.cache[CONTROL_PLANE_PATH]],
  [MIDDLEWARE_PATH, require.cache[MIDDLEWARE_PATH]],
  [PIPELINE_PATH, require.cache[PIPELINE_PATH]],
]);

let nextTaskId = 0;

function installMock(resolvedPath, exportsValue) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModuleCache() {
  for (const [resolvedPath, originalEntry] of ORIGINAL_CACHE_ENTRIES.entries()) {
    if (originalEntry) require.cache[resolvedPath] = originalEntry;
    else delete require.cache[resolvedPath];
  }
}

function makeTask(overrides = {}) {
  nextTaskId += 1;
  return {
    id: `task-${nextTaskId}`,
    task_description: 'Retry overflowed task',
    provider: 'openrouter',
    status: 'pending',
    model: null,
    metadata: null,
    timeout_minutes: null,
    working_directory: 'C:/repo',
    ...overrides,
  };
}

function makeExecuteDeps(initialTasks = [], options = {}) {
  const tasks = new Map(initialTasks.map(task => [task.id, { ...task }]));
  const providerConfigs = new Map(Object.entries(options.providerConfigs || { codex: { enabled: true } }));
  const providerHealth = options.providerHealth || { codex: true };

  const db = {
    updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
      const current = tasks.get(taskId) || { id: taskId };
      const next = { ...current, ...patch, status };
      tasks.set(taskId, next);
      return next;
    }),
    updateTask: vi.fn((taskId, patch = {}) => {
      const current = tasks.get(taskId) || { id: taskId };
      const next = { ...current, ...patch };
      tasks.set(taskId, next);
      return next;
    }),
    getTask: vi.fn((taskId) => tasks.get(taskId) || null),
    getProvider: vi.fn((providerName) => providerConfigs.get(providerName) || null),
    isProviderHealthy: vi.fn((providerName) => providerHealth[providerName] !== false),
    getOrCreateTaskStream: vi.fn((taskId, streamType) => `${taskId}:${streamType}`),
    addStreamChunk: vi.fn(),
    recordUsage: vi.fn(),
  };

  return {
    db,
    dashboard: {
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    apiAbortControllers: new Map(),
    processQueue: vi.fn(),
    readTask(taskId) {
      return tasks.get(taskId);
    },
  };
}

function loadExecuteApiSubject() {
  const loggerInstance = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerInstance),
  };
  const sanitizeMock = {
    redactSecrets: vi.fn((text) => {
      if (text == null) return '';
      return `redacted:${text}`;
    }),
  };
  const contextStuffingMock = {
    stuffContext: vi.fn(async ({ taskDescription }) => ({ enrichedDescription: taskDescription })),
    CONTEXT_STUFFING_PROVIDERS: new Set(['openrouter', 'groq', 'cerebras', 'google-ai', 'ollama-cloud']),
  };

  installMock(LOGGER_PATH, loggerMock);
  installMock(SANITIZE_PATH, sanitizeMock);
  installMock(CONTEXT_STUFFING_PATH, contextStuffingMock);
  delete require.cache[EXECUTE_API_PATH];

  return {
    mod: require('../providers/execute-api'),
    loggerInstance,
    sanitizeMock,
  };
}

function stubImmediateTimeouts() {
  const delays = [];
  const spy = vi.spyOn(global, 'setTimeout').mockImplementation((callback, ms) => {
    delays.push(ms);
    callback();
    return 0;
  });
  return {
    delays,
    restore() {
      spy.mockRestore();
    },
  };
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadV2TaskHandlers() {
  const mockDb = {
    countTasks: vi.fn(() => 0),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    getDefaultProvider: vi.fn(() => 'codex'),
    getProvider: vi.fn(() => ({ enabled: true })),
    getTask: vi.fn(),
    getTaskFileChanges: vi.fn(() => []),
    listTasks: vi.fn(() => []),
  };
  const mockConfig = {
    getInt: vi.fn((key, fallback) => fallback),
  };
  const mockUuidV4 = vi.fn(() => 'retry-clone-1');
  const mockControlPlane = {
    sendSuccess: vi.fn(),
    sendError: vi.fn(),
    sendList: vi.fn(),
    resolveRequestId: vi.fn((req) => req?.requestId || 'req-1'),
    buildTaskResponse: vi.fn((task) => ({
      id: task.id,
      status: task.status,
      provider: task.provider || null,
      metadata: parseMetadata(task.metadata),
    })),
    buildTaskDetailResponse: vi.fn((task) => task),
  };
  const mockMiddleware = {
    parseBody: vi.fn(async () => ({})),
  };
  const mockPipeline = {
    handleCommitTask: vi.fn(),
  };
  const mockConstants = {
    PROVIDER_DEFAULT_TIMEOUTS: {
      codex: 45,
      openrouter: 30,
    },
  };
  const taskManager = {
    startTask: vi.fn(() => ({ queued: true })),
    cancelTask: vi.fn(),
    getTaskProgress: vi.fn(),
    approveProviderSwitch: vi.fn(),
    rejectProviderSwitch: vi.fn(),
    evaluateTaskSubmissionPolicy: vi.fn(() => null),
  };

  installMock(UUID_PATH, { v4: mockUuidV4 });
  installMock(DB_PATH, mockDb);
  installMock(CONFIG_PATH, mockConfig);
  installMock(CONSTANTS_PATH, mockConstants);
  installMock(CONTROL_PLANE_PATH, mockControlPlane);
  installMock(MIDDLEWARE_PATH, mockMiddleware);
  installMock(PIPELINE_PATH, mockPipeline);
  delete require.cache[V2_TASK_HANDLERS_PATH];

  const handlers = require('../api/v2-task-handlers');
  handlers.init(taskManager);

  return {
    handlers,
    mockDb,
    mockControlPlane,
    taskManager,
  };
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    requestId: 'req-1',
    headers: {},
    ...overrides,
  };
}

function createRes() {
  return {};
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreModuleCache();
});

describe('free-tier Codex fallback', () => {
  it('requeues a failed free-tier overflow task back to codex', async () => {
    const { mod, loggerInstance } = loadExecuteApiSubject();
    const task = makeTask({
      provider: 'openrouter',
      metadata: JSON.stringify({
        free_tier_overflow: true,
        original_provider: 'codex',
      }),
    });
    const deps = makeExecuteDeps([task], {
      providerConfigs: { codex: { enabled: true } },
      providerHealth: { codex: true },
    });
    const providerError = Object.assign(new Error('API error (429): rate_limit retry_after_seconds=42'), { status: 429 });
    const provider = {
      name: 'openrouter',
      submit: vi.fn(async () => {
        throw providerError;
      }),
    };
    const timeoutStub = stubImmediateTimeouts();

    mod.init(deps);

    try {
      await mod.executeApiProvider(task, provider);
    } finally {
      timeoutStub.restore();
    }

    expect(provider.submit).toHaveBeenCalledTimes(3);
    expect(timeoutStub.delays).toEqual([75, 150]);
    // requeueTaskAfterAttemptedStart calls updateTaskStatus(id, 'queued', patch)
    expect(deps.db.updateTaskStatus).toHaveBeenLastCalledWith(task.id, 'queued', expect.objectContaining({
      provider: 'codex',
      model: null,
      output: null,
      error_output: null,
      metadata: expect.objectContaining({
        free_tier_fallback_attempted: true,
      }),
    }));
    expect(deps.readTask(task.id)).toMatchObject({
      status: 'queued',
      provider: 'codex',
    });
    expect(deps.readTask(task.id).metadata.free_tier_fallback_attempted).toBe(true);
    expect(deps.readTask(task.id).metadata.free_tier_overflow).toBeUndefined();
    expect(deps.readTask(task.id).metadata.original_provider).toBeUndefined();
    expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
    expect(deps.processQueue).toHaveBeenCalledTimes(1);
    expect(loggerInstance.info).toHaveBeenCalledWith(
      expect.stringContaining(`API provider task ${task.id} free-tier overflow failed, requeued to original provider codex`),
      expect.objectContaining({
        taskId: task.id,
        failedProvider: 'openrouter',
        fallbackProvider: 'codex',
      }),
    );
  });

  it('does not attempt fallback again when free_tier_fallback_attempted is already set', async () => {
    const { mod } = loadExecuteApiSubject();
    const task = makeTask({
      provider: 'openrouter',
      metadata: JSON.stringify({
        free_tier_overflow: true,
        original_provider: 'codex',
        free_tier_fallback_attempted: true,
      }),
    });
    const deps = makeExecuteDeps([task]);
    const provider = {
      name: 'openrouter',
      submit: vi.fn(async () => {
        throw new Error('hard failure');
      }),
    };

    mod.init(deps);
    await mod.executeApiProvider(task, provider);

    expect(deps.db.updateTask).not.toHaveBeenCalled();
    expect(deps.readTask(task.id)).toMatchObject({
      status: 'failed',
      output: 'Provider openrouter error: redacted:hard failure',
    });
    expect(deps.processQueue).toHaveBeenCalledTimes(1);
  });

  it('does not attempt fallback when the original provider is disabled', async () => {
    const { mod } = loadExecuteApiSubject();
    const task = makeTask({
      provider: 'openrouter',
      metadata: JSON.stringify({
        free_tier_overflow: true,
        original_provider: 'codex',
      }),
    });
    const deps = makeExecuteDeps([task], {
      providerConfigs: { codex: { enabled: false } },
      providerHealth: { codex: true },
    });
    const provider = {
      name: 'openrouter',
      submit: vi.fn(async () => {
        throw new Error('disabled fallback target');
      }),
    };

    mod.init(deps);
    await mod.executeApiProvider(task, provider);

    expect(deps.db.updateTask).not.toHaveBeenCalled();
    expect(deps.readTask(task.id).status).toBe('failed');
  });

  it('does not attempt fallback when the original provider is unhealthy', async () => {
    const { mod } = loadExecuteApiSubject();
    const task = makeTask({
      provider: 'openrouter',
      metadata: JSON.stringify({
        free_tier_overflow: true,
        original_provider: 'codex',
      }),
    });
    const deps = makeExecuteDeps([task], {
      providerConfigs: { codex: { enabled: true } },
      providerHealth: { codex: false },
    });
    const provider = {
      name: 'openrouter',
      submit: vi.fn(async () => {
        throw new Error('unhealthy fallback target');
      }),
    };

    mod.init(deps);
    await mod.executeApiProvider(task, provider);

    expect(deps.db.updateTask).not.toHaveBeenCalled();
    expect(deps.readTask(task.id).status).toBe('failed');
  });

  it('uses original_provider for v2 retry clones when present', async () => {
    const { handlers, mockDb, mockControlPlane, taskManager } = loadV2TaskHandlers();

    mockDb.getTask
      .mockReturnValueOnce({
        id: 'failed-task',
        status: 'failed',
        task_description: 'Retry me',
        working_directory: '/repo',
        timeout_minutes: 20,
        auto_approve: true,
        priority: 2,
        provider: 'openrouter',
        model: null,
        metadata: JSON.stringify({
          original_provider: 'codex',
          free_tier_overflow: true,
        }),
      })
      .mockReturnValueOnce({
        id: 'retry-clone-1',
        status: 'queued',
        task_description: 'Retry me',
        provider: 'codex',
        model: null,
        metadata: '{"retry_of":"failed-task"}',
      });

    await handlers.handleRetryTask(
      createReq({ params: { task_id: 'failed-task' }, requestId: 'req-retry' }),
      createRes(),
    );

    expect(taskManager.evaluateTaskSubmissionPolicy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'retry-clone-1',
      provider: 'codex',
      metadata: expect.objectContaining({
        retry_of: 'failed-task',
      }),
    }));
    expect(mockDb.createTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'retry-clone-1',
      provider: 'codex',
      metadata: expect.stringContaining('"retry_of":"failed-task"'),
    }));
    expect(mockControlPlane.sendSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      'req-retry',
      expect.objectContaining({
        task_id: 'retry-clone-1',
        original_task_id: 'failed-task',
        provider: 'codex',
      }),
      201,
      expect.objectContaining({ requestId: 'req-retry' }),
    );
  });
});
