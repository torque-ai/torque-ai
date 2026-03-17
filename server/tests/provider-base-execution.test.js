'use strict';

const BASE_PROVIDER_PATH = require.resolve('../providers/base');
const EXECUTION_PATH = require.resolve('../providers/execution');
const LOGGER_PATH = require.resolve('../logger');
const EXECUTE_API_PATH = require.resolve('../providers/execute-api');
const EXECUTE_OLLAMA_PATH = require.resolve('../providers/execute-ollama');
const EXECUTE_HASHLINE_PATH = require.resolve('../providers/execute-hashline');
const EXECUTE_CLI_PATH = require.resolve('../providers/execute-cli');

const TRACKED_CACHE_PATHS = [
  BASE_PROVIDER_PATH,
  EXECUTION_PATH,
  LOGGER_PATH,
  EXECUTE_API_PATH,
  EXECUTE_OLLAMA_PATH,
  EXECUTE_HASHLINE_PATH,
  EXECUTE_CLI_PATH,
];

const ORIGINAL_CACHE_ENTRIES = new Map(
  TRACKED_CACHE_PATHS.map((resolvedPath) => [resolvedPath, require.cache[resolvedPath]])
);

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

function loadBaseProvider() {
  const loggerInstance = {
    debug: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerInstance),
  };

  installMock(LOGGER_PATH, loggerMock);
  delete require.cache[BASE_PROVIDER_PATH];

  return {
    BaseProvider: require('../providers/base'),
    loggerInstance,
    loggerMock,
  };
}

function createExecutionSubmoduleMocks() {
  const apiMock = {
    init: vi.fn(),
    executeApiProvider: vi.fn((...args) => ({ source: 'api', args })),
  };
  const ollamaMock = {
    init: vi.fn(),
    estimateRequiredContext: vi.fn((...args) => ({ source: 'ollama:estimate', args })),
    executeOllamaTask: vi.fn((...args) => ({ source: 'ollama:execute', args })),
  };
  const hashlineMock = {
    init: vi.fn(),
    executeHashlineOllamaTask: vi.fn((...args) => ({ source: 'hashline:ollama', args })),
    runOllamaGenerate: vi.fn((...args) => ({ source: 'hashline:generate', args })),
    parseAndApplyEdits: vi.fn((...args) => ({ source: 'hashline:edits', args })),
    runErrorFeedbackLoop: vi.fn((...args) => ({ source: 'hashline:feedback', args })),
  };
  const cliMock = {
    init: vi.fn(),
    buildAiderOllamaCommand: vi.fn((...args) => ({ source: 'cli:aider', args })),
    buildClaudeCliCommand: vi.fn((...args) => ({ source: 'cli:claude', args })),
    buildCodexCommand: vi.fn((...args) => ({ source: 'cli:codex', args })),
    spawnAndTrackProcess: vi.fn((...args) => ({ source: 'cli:spawn', args })),
  };

  return { apiMock, ollamaMock, hashlineMock, cliMock };
}

function loadExecutionModule() {
  const mocks = createExecutionSubmoduleMocks();

  installMock(EXECUTE_API_PATH, mocks.apiMock);
  installMock(EXECUTE_OLLAMA_PATH, mocks.ollamaMock);
  installMock(EXECUTE_HASHLINE_PATH, mocks.hashlineMock);
  installMock(EXECUTE_CLI_PATH, mocks.cliMock);
  delete require.cache[EXECUTION_PATH];

  return {
    mod: require('../providers/execution'),
    ...mocks,
  };
}

function makeExecutionDeps(overrides = {}) {
  return {
    db: { kind: 'db' },
    dashboard: { kind: 'dashboard' },
    apiAbortControllers: new Map([['task-1', 'abort-controller']]),
    processQueue: vi.fn(),
    recordTaskStartedAuditEvent: vi.fn(),
    safeUpdateTaskStatus: vi.fn(),
    tryReserveHostSlotWithFallback: vi.fn(),
    tryOllamaCloudFallback: vi.fn(),
    isLargeModelBlockedOnHost: vi.fn(),
    buildFileContext: vi.fn(),
    tryHashlineTieredFallback: vi.fn(),
    selectHashlineFormat: vi.fn(),
    isHashlineCapableModel: vi.fn(),
    hashlineOllamaSystemPrompt: 'hashline ollama prompt',
    hashlineLiteSystemPrompt: 'hashline lite prompt',
    handleWorkflowTermination: vi.fn(),
    runningProcesses: new Map(),
    markTaskCleanedUp: vi.fn(),
    tryLocalFirstFallback: vi.fn(),
    attemptFuzzySearchRepair: vi.fn(),
    shellEscape: vi.fn((value) => value),
    helpers: { helperGroup: 'helpers' },
    NVM_NODE_PATH: 'C:/nvm/node.exe',
    QUEUE_LOCK_HOLDER_ID: 'queue-lock-id',
    MAX_OUTPUT_BUFFER: 16384,
    pendingRetryTimeouts: new Map(),
    taskCleanupGuard: new Map(),
    finalizeTask: vi.fn(),
    stallRecoveryAttempts: new Map(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreModuleCache();
});

describe('BaseProvider', () => {
  it('defaults the provider name to unknown', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider();

    expect(provider.name).toBe('unknown');
  });

  it('uses the configured provider name', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'codex' });

    expect(provider.name).toBe('codex');
  });

  it('enables providers by default', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider();

    expect(provider.enabled).toBe(true);
  });

  it('respects an explicit disabled flag', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ enabled: false });

    expect(provider.enabled).toBe(false);
  });

  it('defaults maxConcurrent to three', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider();

    expect(provider.maxConcurrent).toBe(3);
  });

  it('uses the configured maxConcurrent value', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ maxConcurrent: 8 });

    expect(provider.maxConcurrent).toBe(8);
  });

  it('starts with no active tasks', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider();

    expect(provider.activeTasks).toBe(0);
  });

  it('throws from submit when the base class implementation is used', async () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'abstract-provider' });

    await expect(provider.submit('task', 'model')).rejects.toThrow('abstract-provider: submit() not implemented');
  });

  it('throws from checkHealth when the base class implementation is used', async () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'abstract-provider' });

    await expect(provider.checkHealth()).rejects.toThrow('abstract-provider: checkHealth() not implemented');
  });

  it('returns an empty model list by default', async () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'abstract-provider' });

    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('supports concrete subclasses that implement the provider contract', async () => {
    const { BaseProvider } = loadBaseProvider();

    class ConcreteProvider extends BaseProvider {
      constructor() {
        super({ name: 'concrete-provider', maxConcurrent: 5 });
      }

      async submit(task, model, options = {}) {
        return {
          output: `${task}:${model}:${options.mode || 'default'}`,
          status: 'completed',
          usage: {
            tokens: 42,
            cost: 0.12,
            duration_ms: 128,
          },
        };
      }

      async checkHealth() {
        return {
          available: true,
          models: ['model-a', 'model-b'],
        };
      }

      async listModels() {
        return ['model-a', 'model-b'];
      }
    }

    const provider = new ConcreteProvider();

    await expect(provider.submit('task', 'model-a', { mode: 'strict' })).resolves.toEqual({
      output: 'task:model-a:strict',
      status: 'completed',
      usage: {
        tokens: 42,
        cost: 0.12,
        duration_ms: 128,
      },
    });
    await expect(provider.checkHealth()).resolves.toEqual({
      available: true,
      models: ['model-a', 'model-b'],
    });
    await expect(provider.listModels()).resolves.toEqual(['model-a', 'model-b']);
    expect(provider.maxConcurrent).toBe(5);
  });

  it('exposes the expected submit result shape for concrete providers', async () => {
    const { BaseProvider } = loadBaseProvider();

    class ContractProvider extends BaseProvider {
      async submit() {
        return {
          output: 'ok',
          status: 'completed',
          usage: {
            tokens: 1,
            cost: 0,
            duration_ms: 2,
          },
        };
      }

      async checkHealth() {
        return { available: true, models: [] };
      }
    }

    const provider = new ContractProvider({ name: 'contract-provider' });
    const result = await provider.submit('task', 'model');

    expect(result).toEqual({
      output: expect.any(String),
      status: expect.any(String),
      usage: {
        tokens: expect.any(Number),
        cost: expect.any(Number),
        duration_ms: expect.any(Number),
      },
    });
  });

  it('reports capacity when enabled and below the concurrency limit', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ maxConcurrent: 2 });
    provider.activeTasks = 1;

    expect(provider.hasCapacity()).toBe(true);
  });

  it('reports no capacity when active tasks equals maxConcurrent', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ maxConcurrent: 2 });
    provider.activeTasks = 2;

    expect(provider.hasCapacity()).toBe(false);
  });

  it('reports no capacity when active tasks exceeds maxConcurrent', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ maxConcurrent: 2 });
    provider.activeTasks = 3;

    expect(provider.hasCapacity()).toBe(false);
  });

  it('reports no capacity when the provider is disabled', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ enabled: false, maxConcurrent: 4 });
    provider.activeTasks = 0;

    expect(provider.hasCapacity()).toBe(false);
  });

  it('returns null when Retry-After is requested from a missing response', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });

    expect(provider.getRetryAfterSeconds(null)).toBeNull();
  });

  it('returns null when headers do not expose get()', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });

    expect(provider.getRetryAfterSeconds({ headers: {} })).toBeNull();
  });

  it('parses the Retry-After header', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });
    const response = {
      headers: {
        get: vi.fn((headerName) => headerName === 'Retry-After' ? '60' : null),
      },
    };

    expect(provider.getRetryAfterSeconds(response)).toBe(60);
  });

  it('falls back to the lowercase retry-after header', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });
    const response = {
      headers: {
        get: vi.fn((headerName) => headerName === 'retry-after' ? '90' : null),
      },
    };

    expect(provider.getRetryAfterSeconds(response)).toBe(90);
  });

  it('returns null when no Retry-After header is present', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });
    const response = {
      headers: {
        get: vi.fn(() => null),
      },
    };

    expect(provider.getRetryAfterSeconds(response)).toBeNull();
  });

  it('returns null for non-numeric Retry-After values', () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'retry-test' });
    const response = {
      headers: {
        get: vi.fn(() => 'Wed, 21 Oct 2026 07:28:00 GMT'),
      },
    };

    expect(provider.getRetryAfterSeconds(response)).toBeNull();
  });

  it('does nothing when cancelStreamReaderForCleanup is called without a reader', async () => {
    const { BaseProvider, loggerInstance } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });

    await expect(provider.cancelStreamReaderForCleanup(null)).resolves.toBeUndefined();
    expect(loggerInstance.debug).not.toHaveBeenCalled();
  });

  it('does nothing when the reader does not implement cancel', async () => {
    const { BaseProvider, loggerInstance } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });

    await expect(provider.cancelStreamReaderForCleanup({})).resolves.toBeUndefined();
    expect(loggerInstance.debug).not.toHaveBeenCalled();
  });

  it('awaits reader.cancel during cleanup', async () => {
    const { BaseProvider, loggerInstance } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });
    const reader = {
      cancel: vi.fn(async () => 'cancelled'),
    };

    await provider.cancelStreamReaderForCleanup(reader, 'provider shutdown');

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(loggerInstance.debug).not.toHaveBeenCalled();
  });

  it('swallows reader cancel failures during cleanup', async () => {
    const { BaseProvider } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });
    const reader = {
      cancel: vi.fn(async () => {
        throw new Error('stream already closed');
      }),
    };

    await expect(provider.cancelStreamReaderForCleanup(reader, 'provider shutdown')).resolves.toBeUndefined();
  });

  it('logs a debug breadcrumb when cleanup cancellation fails', async () => {
    const { BaseProvider, loggerInstance } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });
    const reader = {
      cancel: vi.fn(async () => {
        throw new Error('stream already closed');
      }),
    };

    await provider.cancelStreamReaderForCleanup(reader, 'provider shutdown');

    expect(loggerInstance.debug).toHaveBeenCalledWith(
      '[cleanup-test] Failed to cancel stream reader during provider shutdown: stream already closed'
    );
  });

  it('uses the default cleanup phase label when none is provided', async () => {
    const { BaseProvider, loggerInstance } = loadBaseProvider();
    const provider = new BaseProvider({ name: 'cleanup-test' });
    const reader = {
      cancel: vi.fn(async () => {
        throw new Error('transport ended');
      }),
    };

    await provider.cancelStreamReaderForCleanup(reader);

    expect(loggerInstance.debug).toHaveBeenCalledWith(
      '[cleanup-test] Failed to cancel stream reader during stream cleanup: transport ended'
    );
  });
});

describe('providers/execution.js', () => {
  it('initializes execute-api with the API execution dependencies', () => {
    const { mod, apiMock } = loadExecutionModule();
    const deps = makeExecutionDeps();

    mod.init(deps);

    expect(apiMock.init).toHaveBeenCalledTimes(1);
    expect(apiMock.init).toHaveBeenCalledWith({
      db: deps.db,
      dashboard: deps.dashboard,
      apiAbortControllers: deps.apiAbortControllers,
      handleWorkflowTermination: deps.handleWorkflowTermination,
      processQueue: deps.processQueue,
      recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
    });
  });

  it('initializes execute-ollama with its orchestration dependencies', () => {
    const { mod, ollamaMock } = loadExecutionModule();
    const deps = makeExecutionDeps();

    mod.init(deps);

    expect(ollamaMock.init).toHaveBeenCalledTimes(1);
    expect(ollamaMock.init).toHaveBeenCalledWith({
      db: deps.db,
      dashboard: deps.dashboard,
      safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
      recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
      tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
      tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
      isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
      buildFileContext: deps.buildFileContext,
      processQueue: deps.processQueue,
    });
  });

  it('initializes execute-hashline with hashline dependencies and the ollama fallback executor', () => {
    const { mod, hashlineMock, ollamaMock } = loadExecutionModule();
    const deps = makeExecutionDeps();

    mod.init(deps);

    expect(hashlineMock.init).toHaveBeenCalledTimes(1);
    expect(hashlineMock.init).toHaveBeenCalledWith({
      db: deps.db,
      dashboard: deps.dashboard,
      safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
      tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
      tryHashlineTieredFallback: deps.tryHashlineTieredFallback,
      selectHashlineFormat: deps.selectHashlineFormat,
      isHashlineCapableModel: deps.isHashlineCapableModel,
      isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
      processQueue: deps.processQueue,
      hashlineOllamaSystemPrompt: deps.hashlineOllamaSystemPrompt,
      hashlineLiteSystemPrompt: deps.hashlineLiteSystemPrompt,
      handleWorkflowTermination: deps.handleWorkflowTermination,
      executeOllamaTask: ollamaMock.executeOllamaTask,
    });
  });

  it('initializes execute-cli with process execution dependencies', () => {
    const { mod, cliMock } = loadExecutionModule();
    const deps = makeExecutionDeps();

    mod.init(deps);

    expect(cliMock.init).toHaveBeenCalledTimes(1);
    expect(cliMock.init).toHaveBeenCalledWith({
      db: deps.db,
      dashboard: deps.dashboard,
      runningProcesses: deps.runningProcesses,
      safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
      tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
      markTaskCleanedUp: deps.markTaskCleanedUp,
      tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
      tryLocalFirstFallback: deps.tryLocalFirstFallback,
      attemptFuzzySearchRepair: deps.attemptFuzzySearchRepair,
      tryHashlineTieredFallback: deps.tryHashlineTieredFallback,
      shellEscape: deps.shellEscape,
      processQueue: deps.processQueue,
      isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
      helpers: deps.helpers,
      NVM_NODE_PATH: deps.NVM_NODE_PATH,
      QUEUE_LOCK_HOLDER_ID: deps.QUEUE_LOCK_HOLDER_ID,
      MAX_OUTPUT_BUFFER: deps.MAX_OUTPUT_BUFFER,
      pendingRetryTimeouts: deps.pendingRetryTimeouts,
      taskCleanupGuard: deps.taskCleanupGuard,
      finalizeTask: deps.finalizeTask,
      stallRecoveryAttempts: deps.stallRecoveryAttempts,
    });
  });

  it('passes through missing optional dependencies as undefined instead of throwing', () => {
    const { mod, apiMock, ollamaMock, hashlineMock, cliMock } = loadExecutionModule();

    expect(() => mod.init({ db: { kind: 'db' } })).not.toThrow();
    expect(apiMock.init).toHaveBeenCalledWith(expect.objectContaining({ db: { kind: 'db' } }));
    expect(ollamaMock.init).toHaveBeenCalledWith(expect.objectContaining({ db: { kind: 'db' } }));
    expect(hashlineMock.init).toHaveBeenCalledWith(expect.objectContaining({ db: { kind: 'db' } }));
    expect(cliMock.init).toHaveBeenCalledWith(expect.objectContaining({ db: { kind: 'db' } }));
  });

  it('exports only the known provider execution entrypoints', () => {
    const { mod } = loadExecutionModule();

    const exportedKeys = Object.keys(mod);

    expect(exportedKeys).toEqual(expect.arrayContaining([
      'buildAiderOllamaCommand',
      'buildClaudeCliCommand',
      'buildCodexCommand',
      'estimateRequiredContext',
      'executeApiProvider',
      'executeHashlineOllamaTask',
      'executeOllamaTask',
      'init',
      'parseAndApplyEdits',
      'runErrorFeedbackLoop',
      'runOllamaGenerate',
      'spawnAndTrackProcess',
    ]));
  });

  it('does not expose an unknown-provider execution export', () => {
    const { mod } = loadExecutionModule();

    expect(mod.executeUnknownProvider).toBeUndefined();
    expect(mod['not-a-real-provider']).toBeUndefined();
  });

  // Async-wrapped exports (agentic wrappers) — only pass task, await result
  it.each([
    ['executeOllamaTask', 'ollamaMock', 'executeOllamaTask', [{ id: 'task-1' }]],
    ['executeApiProvider', 'apiMock', 'executeApiProvider', [{ id: 'task-2' }]],
  ])('dispatches %s through the agentic wrapper to the correct provider implementation', async (exportName, mockContainerName, mockFnName, args) => {
    const loaded = loadExecutionModule();
    const { mod } = loaded;

    const result = await mod[exportName](...args);

    expect(loaded[mockContainerName][mockFnName]).toHaveBeenCalledWith(...args);
    expect(result).toEqual({
      source: expect.any(String),
      args,
    });
  });

  // Synchronous pass-through exports
  it.each([
    ['estimateRequiredContext', 'ollamaMock', 'estimateRequiredContext', ['Review the whole repo', ['a.js']]],
    ['executeHashlineOllamaTask', 'hashlineMock', 'executeHashlineOllamaTask', [{ id: 'task-3' }]],
    ['runOllamaGenerate', 'hashlineMock', 'runOllamaGenerate', ['prompt', { signal: true }]],
    ['parseAndApplyEdits', 'hashlineMock', 'parseAndApplyEdits', ['diff body', ['file.js']]],
    ['runErrorFeedbackLoop', 'hashlineMock', 'runErrorFeedbackLoop', [{ id: 'task-5' }, { error: 'boom' }]],
    ['buildAiderOllamaCommand', 'cliMock', 'buildAiderOllamaCommand', [{ id: 'task-6' }, 'CTX', ['a.js']]],
    ['buildClaudeCliCommand', 'cliMock', 'buildClaudeCliCommand', [{ id: 'task-7' }, 'CTX', { cli_path: 'claude' }]],
    ['buildCodexCommand', 'cliMock', 'buildCodexCommand', [{ id: 'task-8' }, 'CTX', { cli_path: 'codex' }]],
    ['spawnAndTrackProcess', 'cliMock', 'spawnAndTrackProcess', ['task-9', { id: 'task-9' }, { cliPath: 'node' }, 'codex']],
  ])('dispatches %s to the correct provider implementation', (exportName, mockContainerName, mockFnName, args) => {
    const loaded = loadExecutionModule();
    const { mod } = loaded;

    const result = mod[exportName](...args);

    expect(loaded[mockContainerName][mockFnName]).toHaveBeenCalledWith(...args);
    expect(result).toEqual({
      source: expect.any(String),
      args,
    });
  });
});
