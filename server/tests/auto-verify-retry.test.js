/**
 * Unit tests for auto-verify-retry close-handler phase.
 *
 * Uses manual dependency injection + fresh module loading per test to
 * control test-runner-registry/context-enrichment bindings captured at require time.
 *
 * The module now uses the shared test runner registry instead of execSync
 * directly, so we mock the test-runner-registry module.
 *
 * The source has a scoped error check: it only proceeds to retry logic if
 * the verify errors are in files that this task actually modified. Tests that
 * expect retry/failure behavior must set ctx.filesModified and use verify
 * error output that includes parseable file paths (TypeScript error format).
 */

const crypto = require('crypto');
const contextEnrichment = require('../utils/context-enrichment');

const MODULE_PATH = '../validation/auto-verify-retry';
const MODULE_RESOLVED = require.resolve(MODULE_PATH);
const LOGGER_MODULE_PATH = '../logger';
const LOGGER_MODULE_RESOLVED = require.resolve(LOGGER_MODULE_PATH);
const TEST_RUNNER_REGISTRY_MODULE_PATH = '../test-runner-registry';
const TEST_RUNNER_REGISTRY_MODULE_RESOLVED = require.resolve(TEST_RUNNER_REGISTRY_MODULE_PATH);
const HOST_MONITORING_MODULE_PATH = '../utils/host-monitoring';
const HOST_MONITORING_MODULE_RESOLVED = require.resolve(HOST_MONITORING_MODULE_PATH);

const ORIGINAL_RANDOM_UUID = crypto.randomUUID;
const ORIGINAL_BUILD_PROMPT = contextEnrichment.buildErrorFeedbackPrompt;

// Shared mock for runVerifyCommand — configurable per test
let mockRunVerifyCommand;
let mockLogger;
let mockLoggerChild;
let mockHostMonitoring;

function restorePatchedDeps() {
  crypto.randomUUID = ORIGINAL_RANDOM_UUID;
  contextEnrichment.buildErrorFeedbackPrompt = ORIGINAL_BUILD_PROMPT;
  delete require.cache[MODULE_RESOLVED];
  delete require.cache[LOGGER_MODULE_RESOLVED];
  // Restore real test runner registry module
  delete require.cache[TEST_RUNNER_REGISTRY_MODULE_RESOLVED];
  delete require.cache[HOST_MONITORING_MODULE_RESOLVED];
}

function installLoggerMock() {
  mockLoggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLogger = {
    child: vi.fn(() => mockLoggerChild),
  };

  require.cache[LOGGER_MODULE_RESOLVED] = {
    id: LOGGER_MODULE_RESOLVED,
    filename: LOGGER_MODULE_RESOLVED,
    loaded: true,
    exports: mockLogger,
  };
}

function installTestRunnerRegistryMock() {
  // Install mock for createTestRunnerRegistry before loading the module
  mockRunVerifyCommand = vi.fn().mockResolvedValue({
    success: true,
    output: '',
    error: '',
    exitCode: 0,
    durationMs: 100,
    remote: false,
  });

  require.cache[TEST_RUNNER_REGISTRY_MODULE_RESOLVED] = {
    id: TEST_RUNNER_REGISTRY_MODULE_RESOLVED,
    filename: TEST_RUNNER_REGISTRY_MODULE_RESOLVED,
    loaded: true,
    exports: {
      createTestRunnerRegistry: vi.fn(() => ({
        runVerifyCommand: mockRunVerifyCommand,
        runRemoteOrLocal: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
      })),
    },
  };
}

function installHostMonitoringMock(entries = []) {
  mockHostMonitoring = {
    hostActivityCache: new Map(entries),
  };

  require.cache[HOST_MONITORING_MODULE_RESOLVED] = {
    id: HOST_MONITORING_MODULE_RESOLVED,
    filename: HOST_MONITORING_MODULE_RESOLVED,
    loaded: true,
    exports: mockHostMonitoring,
  };
}

function createMockDb({ project = 'test-project', initialConfig = {}, projectExists = true } = {}) {
  const configs = new Map([[project, initialConfig]]);
  const createdTasks = [];
  return {
    getProjectFromPath: vi.fn((workingDirectory) => {
      if (!projectExists || !workingDirectory) return null;
      return project;
    }),
    getProjectConfig: vi.fn((projectName) => configs.get(projectName) || {}),
    createTask: vi.fn((task) => {
      createdTasks.push(task);
    }),
    updateTaskStatus: vi.fn(),
    _setConfig: (config, projectName = project) => {
      configs.set(projectName, config);
    },
    _getCreatedTasks: () => createdTasks.slice(),
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    task_description: 'Fix compile errors',
    working_directory: 'C:/repo/project',
    provider: 'codex',
    model: 'gpt-5-codex',
    retry_count: 0,
    max_retries: 1,
    priority: 4,
    timeout_minutes: 30,
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  const hasTask = Object.prototype.hasOwnProperty.call(overrides, 'task');
  return {
    taskId: 'task-1',
    status: 'completed',
    task: hasTask ? overrides.task : makeTask(),
    output: 'Prior output from task',
    errorOutput: '',
    earlyExit: false,
    ...overrides,
  };
}

/**
 * Create a verify result with errors that include parseable file paths.
 * The scoped error check in the source needs TypeScript-format error lines
 * (e.g., "src/foo.ts(10,5): error TS2339: ...") so that extractBuildErrorFiles
 * can parse them.
 */
function makeVerifyResult({ exitCode = 1, output = '', error = 'src/foo.ts(10,5): error TS2339: Property does not exist' } = {}) {
  return {
    success: exitCode === 0,
    output,
    error,
    exitCode,
    durationMs: 150,
    remote: false,
  };
}

/**
 * Create a ctx that the scoped error check will NOT short-circuit.
 * Sets filesModified to overlap with the error file path in the verify output.
 */
function makeCtxWithModifiedFiles(overrides = {}) {
  return makeCtx({
    filesModified: ['src/foo.ts'],
    ...overrides,
  });
}

function loadModuleWithMocks(options = {}) {
  const mockRandomUUID = options.mockRandomUUID || vi.fn(() => 'fix-task-uuid');
  const mockBuildErrorFeedbackPrompt = options.mockBuildErrorFeedbackPrompt ||
    vi.fn((desc, output, errors) => `${desc}\n\n[errors]\n${errors}`);

  crypto.randomUUID = mockRandomUUID;
  contextEnrichment.buildErrorFeedbackPrompt = options.promptMissing
    ? undefined
    : mockBuildErrorFeedbackPrompt;

  installLoggerMock();
  // Install test-runner-registry mock before loading the module
  installTestRunnerRegistryMock();
  installHostMonitoringMock(options.hostActivityEntries);

  delete require.cache[MODULE_RESOLVED];
  const mod = require(MODULE_PATH);

  const db = options.db || createMockDb();
  const startTask = Object.prototype.hasOwnProperty.call(options, 'startTask')
    ? options.startTask
    : vi.fn();
  const processQueue = Object.prototype.hasOwnProperty.call(options, 'processQueue')
    ? options.processQueue
    : vi.fn();
  const testRunnerRegistry = Object.prototype.hasOwnProperty.call(options, 'testRunnerRegistry')
    ? options.testRunnerRegistry
    : undefined;

  mod.init({ db, startTask, processQueue, testRunnerRegistry });

  return {
    ...mod,
    db,
    startTask,
    processQueue,
    mockRunVerifyCommand,
    mockLogger,
    mockLoggerChild,
    mockHostMonitoring,
    mockRandomUUID,
    mockBuildErrorFeedbackPrompt,
  };
}

afterEach(() => {
  restorePatchedDeps();
  vi.clearAllMocks();
});

afterAll(() => {
  restorePatchedDeps();
});

describe('handleAutoVerifyRetry — guards and init', () => {
  it('init() stores dependencies correctly', async () => {
    const firstDb = createMockDb({ initialConfig: {} });
    const secondDb = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });

    // First load + init with DB that has no verify command
    loadModuleWithMocks({ db: firstDb });
    const mod = require(MODULE_PATH);
    const ctx = makeCtx();
    await mod.handleAutoVerifyRetry(ctx);
    expect(mockRunVerifyCommand).not.toHaveBeenCalled();

    // Re-init with DB that has verify command and confirm it is used
    mod.init({ db: secondDb, startTask: vi.fn(), processQueue: vi.fn() });
    await mod.handleAutoVerifyRetry(makeCtx({ taskId: 'task-2', task: makeTask({ id: 'task-2' }) }));
    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
  });

  it('skips when task status is not completed', async () => {
    const { handleAutoVerifyRetry } = loadModuleWithMocks();
    const ctx = makeCtx({ status: 'failed' });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
  });

  it('skips when task is null', async () => {
    const { handleAutoVerifyRetry } = loadModuleWithMocks();
    const ctx = makeCtx({ task: null });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
  });

  it('skips when provider is not in AUTO_VERIFY_PROVIDERS and no explicit opt-in', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx({ task: makeTask({ provider: 'claude-cli' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
    expect(ctx.status).toBe('completed');
  });

  it.each(['ollama'])(
    'runs by default for expanded auto-verify provider %s',
    async (provider) => {
      const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
      const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
      const ctx = makeCtx({ task: makeTask({ provider }) });

      await handleAutoVerifyRetry(ctx);

      expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
      expect(ctx.status).toBe('completed');
    },
  );

  it('runs for non-default providers when auto_verify_on_completion is explicitly enabled', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        auto_verify_on_completion: 1,
      },
    });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx({ task: makeTask({ provider: 'claude-cli' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
    expect(ctx.status).toBe('completed');
  });

  it('skips when no working_directory on task', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx({ task: makeTask({ working_directory: '' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
  });

  it('skips when project lookup fails', async () => {
    const db = createMockDb({
      initialConfig: { verify_command: 'npx tsc --noEmit' },
      projectExists: false,
    });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx();

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
  });

  it('skips when project has no verify_command configured', async () => {
    const db = createMockDb({ initialConfig: {} });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx();

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
    expect(ctx.status).toBe('completed');
  });

  it.each(['codex', 'codex-spark', 'ollama', 'claude-cli'])(
    'skips when auto_verify_on_completion is explicitly disabled for provider %s',
    async (provider) => {
      const db = createMockDb({
        initialConfig: {
          verify_command: 'npx tsc --noEmit',
          auto_verify_on_completion: 0,
        },
      });
      const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
      const ctx = makeCtx({ task: makeTask({ provider }) });

      await handleAutoVerifyRetry(ctx);

      expect(mockRunVerifyCommand).not.toHaveBeenCalled();
      expect(ctx.status).toBe('completed');
    },
  );
});

describe('handleAutoVerifyRetry — verify execution', () => {
  it('runs verify_command via router.runVerifyCommand with correct args', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx({ task: makeTask({ working_directory: 'C:/repo/my-app' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).toHaveBeenCalledWith(
      'npx tsc --noEmit',
      'C:/repo/my-app',
      expect.objectContaining({ timeout: 300000 }),
    );
  });

  it('skips verify when the resource gate blocks an overloaded host', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, mockLoggerChild } = loadModuleWithMocks({
      db,
      hostActivityEntries: [[
        'host-1',
        { gpuMetrics: { cpuPercent: 92, ramPercent: 62 } },
      ]],
    });
    const ctx = makeCtx({ task: makeTask({ ollama_host_id: 'host-1' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
    expect(mockLoggerChild.info).toHaveBeenCalledWith(
      expect.stringContaining('resource gate blocked verify'),
    );
    expect(mockLoggerChild.info).toHaveBeenCalledWith(
      expect.stringContaining('Host overloaded: CPU at 92%'),
    );
    expect(ctx.status).toBe('completed');
  });

  it('runs verify when host is below threshold', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({
      db,
      hostActivityEntries: [[
        'host-1',
        { gpuMetrics: { cpuPercent: 72, ramPercent: 61 } },
      ]],
    });
    const ctx = makeCtx({ task: makeTask({ ollama_host_id: 'host-1' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
    expect(ctx.status).toBe('completed');
  });

  it('skips verify when only non-code files were modified', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb, mockLoggerChild } = loadModuleWithMocks({ db });
    const ctx = makeCtx({
      filesModified: ['README.md', 'docs/notes.txt', 'config/settings.json', 'data/report.csv'],
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.status).toBe('completed');
    expect(mockLoggerChild.info).toHaveBeenCalledWith(
      expect.stringContaining('skipping verify'),
    );
    expect(mockLoggerChild.info).toHaveBeenCalledWith(
      expect.stringContaining('only non-code files modified'),
    );
  });

  it('runs verify when filesModified mixes code and non-code files', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    const ctx = makeCtx({
      filesModified: ['src/app.ts', 'README.md'],
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.status).toBe('completed');
  });

  it('does nothing when verify_command succeeds (exit code 0)', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    const ctx = makeCtx();

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBe(false);
    expect(mockDb.createTask).not.toHaveBeenCalled();
  });

  it('handles empty verify_command output', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'echo ok' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx();

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(ctx.errorOutput).toBe('');
  });

  it('handles codex-spark provider', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtx({ task: makeTask({ provider: 'codex-spark' }) });

    await handleAutoVerifyRetry(ctx);

    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
    expect(ctx.status).toBe('completed');
  });
});

describe('handleAutoVerifyRetry — failure and retry behavior', () => {
  it('handles verify failure (non-zero exit) when retries exhausted', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        verify_max_fix_attempts: '1',
      },
    });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 1, max_retries: 99 }),
      errorOutput: 'existing failure',
    });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ exitCode: 2, error: 'src/foo.ts(10,5): error TS1005: ; expected' }),
    );

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.errorOutput).toContain('[auto-verify] Verification failed');
  });

  it('when verify fails: creates a new fix task with error feedback prompt', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb, mockBuildErrorFeedbackPrompt } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2339: Property foo does not exist' }),
    );

    const ctx = makeCtxWithModifiedFiles({
      taskId: 'task-main',
      task: makeTask({
        id: 'task-main',
        task_description: 'Implement feature',
        retry_count: 0,
        max_retries: 2,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockDb.createTask).toHaveBeenCalledTimes(1);
    expect(mockBuildErrorFeedbackPrompt).toHaveBeenCalledTimes(1);
  });

  it('when verify fails: sets earlyExit on ctx', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2554: Expected 1 arguments' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(ctx.earlyExit).toBe(true);
  });

  it('when verify fails: includes compiler errors in fix task description', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2304: Cannot find name Widget' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        task_description: 'Refactor widgets',
        retry_count: 0,
        max_retries: 1,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    const fixTask = mockDb.createTask.mock.calls[0][0];
    expect(fixTask.task_description).toContain('TS2304');
    expect(ctx.errorOutput).toContain('Verification failed, fix task');
  });

  it('defaults verify_max_fix_attempts to 2 when config is missing', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(makeVerifyResult());

    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        max_retries: undefined,
        retry_count: 1,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockDb.createTask).toHaveBeenCalledTimes(1);
    expect(ctx.earlyExit).toBe(true);
  });

  it('uses verify_max_fix_attempts from project config instead of task.max_retries', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        verify_max_fix_attempts: '1',
      },
    });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(makeVerifyResult());

    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        retry_count: 1,
        max_retries: 99,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.status).toBe('failed');
    expect(ctx.earlyExit).toBe(false);
  });

  it('uses verify_max_fix_attempts project config as the retry budget boundary', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        verify_max_fix_attempts: '3',
      },
    });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(makeVerifyResult());

    const withinBudgetCtx = makeCtxWithModifiedFiles({
      taskId: 'task-within-budget',
      task: makeTask({
        id: 'task-within-budget',
        retry_count: 2,
        max_retries: 99,
      }),
    });

    await handleAutoVerifyRetry(withinBudgetCtx);

    expect(mockDb.createTask).toHaveBeenCalledTimes(1);
    expect(withinBudgetCtx.earlyExit).toBe(true);

    mockDb.createTask.mockClear();

    const exhaustedBudgetCtx = makeCtxWithModifiedFiles({
      taskId: 'task-exhausted-budget',
      task: makeTask({
        id: 'task-exhausted-budget',
        retry_count: 3,
        max_retries: 99,
      }),
    });

    await handleAutoVerifyRetry(exhaustedBudgetCtx);

    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(exhaustedBudgetCtx.status).toBe('failed');
    expect(exhaustedBudgetCtx.earlyExit).toBe(false);
  });

  it('does not retry if task already has retry_of set', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS9999: Retry loop guard' }),
    );

    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        retry_of: 'original-task-id',
        retry_count: 0,
        max_retries: 2,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(ctx.earlyExit).toBe(false);
    expect(mockDb.createTask).not.toHaveBeenCalled();
  });

  it('does not retry if task metadata indicates auto_verify_fix_for', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS7006: Implicit any' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        retry_count: 0,
        max_retries: 2,
        metadata: JSON.stringify({ auto_verify_fix_for: 'task-parent' }),
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.status).toBe('failed');
  });

  it('respects auto_fix project setting (skip retry when disabled)', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        auto_fix_enabled: 0,
      },
    });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS1005: Missing token' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 2 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.status).toBe('failed');
    expect(ctx.earlyExit).toBe(false);
  });

  it('fix task gets correct provider assignment', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npm run verify' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2307: Cannot find module' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        provider: 'codex-spark',
        retry_count: 0,
        max_retries: 1,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    const fixTask = mockDb.createTask.mock.calls[0][0];
    expect(fixTask.provider).toBeNull();
  });

  it('fix task gets correct working_directory', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npm run verify' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS1117: Duplicate property name' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        working_directory: 'C:/workspace/my-service',
        retry_count: 0,
        max_retries: 1,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    const fixTask = mockDb.createTask.mock.calls[0][0];
    expect(fixTask.working_directory).toBe('C:/workspace/my-service');
  });

  it('handles missing buildErrorFeedbackPrompt gracefully', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db, promptMissing: true });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2741: Property is missing' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 2 }),
    });

    await expect(handleAutoVerifyRetry(ctx)).resolves.not.toThrow();

    const fixTask = mockDb.createTask.mock.calls[0][0];
    expect(fixTask.task_description).toContain('Verification failed. Fix these errors');
    expect(fixTask.task_description).toContain('TS2741');
  });

  it('handles verify_command timeout', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        verify_max_fix_attempts: '1',
      },
    });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ exitCode: 1, error: 'src/foo.ts(10,5): error TS0000: Timed out after 120000ms' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({
        retry_count: 1,
        max_retries: 99,
      }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(ctx.errorOutput).toContain('Timed out');
    expect(mockDb.createTask).not.toHaveBeenCalled();
  });

  it('calls processQueue after fix task creation when startTask throws', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const startTask = vi.fn(() => { throw new Error('worker busy'); });
    const processQueue = vi.fn();
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db, startTask, processQueue });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2552: Cannot find name' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(processQueue).toHaveBeenCalledTimes(1);
  });

  it('calls processQueue when startTask dependency is missing', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const processQueue = vi.fn();
    const harness = loadModuleWithMocks({ db, startTask: undefined, processQueue });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2345: Argument type mismatch' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await harness.handleAutoVerifyRetry(ctx);

    expect(processQueue).toHaveBeenCalledTimes(1);
  });

  it('handles createTask failure gracefully', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    db.createTask.mockImplementation(() => {
      throw new Error('DB locked');
    });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/foo.ts(10,5): error TS2322: Type is not assignable' }),
    );
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await expect(handleAutoVerifyRetry(ctx)).resolves.not.toThrow();
    expect(ctx.status).toBe('failed');
    // createTask threw but the code falls through to the terminal status write block
    // (lines 275-291), which sets ctx.status='failed' and calls updateTaskStatus.
    // Since updateTaskStatus mock succeeds, earlyExit is set to true.
    expect(ctx.earlyExit).toBe(true);
  });

  it('scoped check passes task when no modified files are detected', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/other.ts(10,5): error TS2339: Property does not exist' }),
    );
    // No filesModified set — scoped check detects no modified files, considers errors pre-existing
    const ctx = makeCtx({
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.output).toContain('pre-existing errors');
  });

  it('scoped check passes task when errors are in unmodified files', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const { handleAutoVerifyRetry, db: mockDb } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ error: 'src/other.ts(10,5): error TS2339: Property does not exist' }),
    );
    // filesModified contains a different file than the error file
    const ctx = makeCtx({
      filesModified: ['src/bar.ts'],
      task: makeTask({ retry_count: 0, max_retries: 1 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(mockDb.createTask).not.toHaveBeenCalled();
    expect(ctx.output).toContain('pre-existing errors');
  });
});

describe('auto-verify-retry exported helpers', () => {
  it('exports expected entry points', () => {
    const { init, handleAutoVerifyRetry } = loadModuleWithMocks();
    expect(typeof init).toBe('function');
    expect(typeof handleAutoVerifyRetry).toBe('function');
  });

  it('re-initializing with different dependencies is respected', async () => {
    const dbA = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const dbB = createMockDb({ initialConfig: { verify_command: 'npm run verify' } });
    const mockStartTask = vi.fn();
    const mockProcessQueue = vi.fn();

    const { init, handleAutoVerifyRetry, mockRunVerifyCommand } = loadModuleWithMocks({
      db: dbA,
      startTask: mockStartTask,
      processQueue: mockProcessQueue,
    });
    mockRunVerifyCommand.mockResolvedValue(
      makeVerifyResult({ exitCode: 0, error: '' }),
    );
    await handleAutoVerifyRetry(makeCtx({ task: makeTask({ max_retries: 0 }) }));

    init({ db: dbB, startTask: mockStartTask, processQueue: mockProcessQueue });
    await handleAutoVerifyRetry(makeCtx({ task: makeTask({ max_retries: 0 }) }));

    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(2);
  });
});

describe('handleAutoVerifyRetry — test runner registry', () => {
  it('creates the fallback test runner registry lazily', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    loadModuleWithMocks({ db });

    const { createTestRunnerRegistry } = require(TEST_RUNNER_REGISTRY_MODULE_PATH);

    const mod = require(MODULE_PATH);
    await mod.handleAutoVerifyRetry(makeCtx());

    expect(createTestRunnerRegistry).toHaveBeenCalledTimes(1);
  });

  it('prefers an injected testRunnerRegistry when provided', async () => {
    const db = createMockDb({ initialConfig: { verify_command: 'npx tsc --noEmit' } });
    const injectedRegistry = {
      runVerifyCommand: vi.fn().mockResolvedValue(makeVerifyResult({ exitCode: 0, error: '' })),
    };
    const { handleAutoVerifyRetry } = loadModuleWithMocks({
      db,
      testRunnerRegistry: injectedRegistry,
    });
    const ctx = makeCtx();

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('completed');
    expect(injectedRegistry.runVerifyCommand).toHaveBeenCalledTimes(1);
    expect(mockRunVerifyCommand).not.toHaveBeenCalled();
  });

  it('includes remote flag in verify result processing', async () => {
    const db = createMockDb({
      initialConfig: {
        verify_command: 'npx tsc --noEmit',
        verify_max_fix_attempts: '1',
      },
    });
    const { handleAutoVerifyRetry } = loadModuleWithMocks({ db });
    mockRunVerifyCommand.mockResolvedValue({
      success: false,
      output: '',
      error: 'src/foo.ts(10,5): error TS2339: remote failure',
      exitCode: 1,
      durationMs: 500,
      remote: true,
    });
    const ctx = makeCtxWithModifiedFiles({
      task: makeTask({ retry_count: 1, max_retries: 99 }),
    });

    await handleAutoVerifyRetry(ctx);

    expect(ctx.status).toBe('failed');
    expect(ctx.errorOutput).toContain('remote failure');
  });
});
