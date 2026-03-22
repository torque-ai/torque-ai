/**
 * Runtime fallback regression coverage for user_provider_override.
 *
 * Focuses on execution-time branches that must not silently reroute when the
 * user explicitly selected a provider.
 */
const { randomUUID } = require('crypto');

const mockState = vi.hoisted(() => ({
  spawnAndTrackProcess: vi.fn(),
}));

let helpers;
let ctx;
let db;
let tm;

function resetRuntimeMocks() {
  mockState.spawnAndTrackProcess.mockReset().mockImplementation((taskId, task, config) => ({
    started: true,
    taskId,
    task,
    config,
  }));
}

async function setup(options = {}) {
  vi.resetModules();
  resetRuntimeMocks();

  const actualDb = await vi.importActual('../database');
  const actualProcessLifecycle = await vi.importActual('../execution/process-lifecycle');
  const actualProviderRegistry = await vi.importActual('../providers/registry');
  const mockedProcessLifecycle = {
    ...actualProcessLifecycle,
    spawnAndTrackProcess: (...args) => mockState.spawnAndTrackProcess(...args),
  };
  const mockedProviderRegistry = {
    ...actualProviderRegistry,
    getProviderInstance: typeof options.getProviderInstanceOverride === 'function'
      ? (name) => options.getProviderInstanceOverride(actualProviderRegistry, name)
      : actualProviderRegistry.getProviderInstance,
  };

  const dbPath = require.resolve('../database');
  const processLifecyclePath = require.resolve('../execution/process-lifecycle');
  const providerRegistryPath = require.resolve('../providers/registry');
  const helpersPath = require.resolve('./e2e-helpers');
  const taskManagerPath = require.resolve('../task-manager');

  vi.doMock('../database', () => actualDb);
  vi.doMock('../execution/process-lifecycle', () => mockedProcessLifecycle);
  vi.doMock('../providers/registry', () => mockedProviderRegistry);

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: actualDb };
  require.cache[processLifecyclePath] = {
    id: processLifecyclePath,
    filename: processLifecyclePath,
    loaded: true,
    exports: mockedProcessLifecycle,
  };
  require.cache[providerRegistryPath] = {
    id: providerRegistryPath,
    filename: providerRegistryPath,
    loaded: true,
    exports: mockedProviderRegistry,
  };
  delete require.cache[helpersPath];
  delete require.cache[taskManagerPath];

  helpers = require('./e2e-helpers');
  ctx = helpers.setupE2eDb('provider-override-runtime');
  db = ctx.db;
  tm = ctx.tm;

  db.setConfig('max_concurrent', '10');
  db.setConfig('rate_limit_enabled', '0');
  db.setConfig('duplicate_check_enabled', '0');
  db.setConfig('budget_check_enabled', '0');

  if (tm._testing && tm._testing.resetForTest) {
    tm._testing.resetForTest();
    tm._testing.skipGitInCloseHandler = true;
  }
}

async function cleanup() {
  vi.restoreAllMocks();

  if (ctx && helpers) {
    await helpers.teardownE2eDb(ctx);
  }

  helpers = null;
  ctx = null;
  db = null;
  tm = null;
  resetRuntimeMocks();
  vi.resetModules();
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
    id,
    status: overrides.status || 'pending',
    task_description: overrides.task_description || 'Test task for runtime fallback guards',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'codellama:latest',
    working_directory: overrides.working_directory !== undefined ? overrides.working_directory : process.cwd(),
    max_retries: overrides.max_retries !== undefined ? overrides.max_retries : 0,
    retry_count: overrides.retry_count !== undefined ? overrides.retry_count : 0,
    metadata: overrides.metadata || null,
  });
  return id;
}

describe('runtime fallback guards respect user_provider_override', () => {
  afterEach(cleanup);

  it('keeps hashline-ollama review tasks on hashline-ollama when user_provider_override is set', async () => {
    await setup();

    db.updateProvider('hashline-ollama', { enabled: 1 });
    helpers.registerMockHost(db, 'http://127.0.0.1:19816', ['codellama:latest'], { name: 'override-review-runtime' });

    const taskId = createTask({
      provider: 'hashline-ollama',
      task_description: 'review the code and report any bugs found',
      metadata: JSON.stringify({ user_provider_override: true }),
    });

    const result = tm.startTask(taskId);

    expect(result).toEqual(expect.objectContaining({ started: true, taskId }));
    expect(db.getTask(taskId).provider).toBe('hashline-ollama');
    expect(mockState.spawnAndTrackProcess).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ provider: 'hashline-ollama' }),
      expect.objectContaining({ provider: 'hashline-ollama' }),
    );
  });

  it('does not trigger local-first retry on no-file-change when user_provider_override is set', async () => {
    await setup();
    const fallbackRetry = require('../execution/fallback-retry');
    const tryLocalFirstFallbackSpy = vi.spyOn(fallbackRetry, 'tryLocalFirstFallback');

    const taskId = createTask({
      provider: 'hashline-ollama',
      task_description: 'implement the login flow',
      metadata: JSON.stringify({ user_provider_override: true }),
      max_retries: 2,
      retry_count: 0,
    });

    const ctxState = {
      taskId,
      task: db.getTask(taskId),
      proc: { output: '' },
      status: 'completed',
      code: 0,
      errorOutput: '',
      earlyExit: false,
    };

    tm.handleNoFileChangeDetection(ctxState);

    expect(ctxState.status).toBe('failed');
    expect(ctxState.errorOutput).toContain('NO FILES MODIFIED');
    expect(ctxState.earlyExit).toBe(false);
    expect(tryLocalFirstFallbackSpy).not.toHaveBeenCalled();
  });

  it('throws instead of falling back when an overridden API provider has no registered instance', async () => {
    await setup({
      getProviderInstanceOverride: (actualProviderRegistry, name) => {
        if (name === 'anthropic') return null;
        return actualProviderRegistry.getProviderInstance(name);
      },
    });

    db.updateProvider('anthropic', { enabled: 1 });

    const taskId = createTask({
      provider: 'anthropic',
      model: 'claude-3-haiku',
      task_description: 'review the API integration for edge cases',
      metadata: JSON.stringify({ user_provider_override: true }),
    });

    expect(() => tm.startTask(taskId)).toThrow(/no registered instance/);

    const task = db.getTask(taskId);
    expect(task.provider).toBe('anthropic');
    expect(mockState.spawnAndTrackProcess).not.toHaveBeenCalled();
  });
});
