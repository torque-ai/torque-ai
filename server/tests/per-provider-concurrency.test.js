'use strict';

const CORE_MODULE_PATH = require.resolve('../db/provider/routing-core');
const SCHEDULER_MODULE_PATH = require.resolve('../execution/queue-scheduler');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const CONFIG_MODULE_PATH = require.resolve('../config');
const PROVIDER_REGISTRY_MODULE_PATH = require.resolve('../providers/registry');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || 'task-1',
    provider: overrides.provider || 'groq',
    status: overrides.status || 'queued',
    task_description: overrides.task_description || 'Test task',
    created_at: overrides.created_at || new Date().toISOString(),
    ...overrides,
  };
}

function createDbHarness(overrides = {}) {
  const state = {
    config: new Map(Object.entries({
      max_concurrent: '10',
      auto_compute_max_concurrent: '1',
      ...overrides.config,
    })),
    providers: new Map(Object.entries({
      codex: {
        provider: 'codex',
        enabled: 1,
        priority: 10,
        max_concurrent: 6,
        transport: 'hybrid',
        quota_error_patterns: '[]',
      },
      ollama: {
        provider: 'ollama',
        enabled: 1,
        priority: 20,
        max_concurrent: 8,
        transport: 'api',
        quota_error_patterns: '[]',
      },
      groq: {
        provider: 'groq',
        enabled: 1,
        priority: 30,
        max_concurrent: 4,
        transport: 'api',
        quota_error_patterns: '[]',
      },
      ...overrides.providers,
    })),
  };

  const db = {
    prepare(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql === 'SELECT value FROM config WHERE key = ?') {
        return {
          get(key) {
            return state.config.has(key) ? { value: state.config.get(key) } : undefined;
          },
        };
      }

      if (normalizedSql === 'SELECT * FROM provider_config ORDER BY priority ASC') {
        return {
          all() {
            return Array.from(state.providers.values())
              .sort((left, right) => (left.priority || 0) - (right.priority || 0))
              .map((provider) => cloneValue(provider));
          },
        };
      }

      throw new Error(`Unhandled SQL in per-provider-concurrency test double: ${normalizedSql}`);
    },
    getConfig(key) {
      return state.config.get(key) || null;
    },
  };

  return { db };
}

function resetModuleCache() {
  delete require.cache[CORE_MODULE_PATH];
  delete require.cache[SCHEDULER_MODULE_PATH];
  delete require.cache[LOGGER_MODULE_PATH];
  delete require.cache[CONFIG_MODULE_PATH];
  delete require.cache[PROVIDER_REGISTRY_MODULE_PATH];
}

function loadCore(overrides = {}) {
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const { db } = createDbHarness(overrides);

  vi.resetModules();
  resetModuleCache();
  installCjsModuleMock('../logger', { child: vi.fn(() => loggerChild) });

  const serverConfig = require('../config');
  serverConfig.init({ db });
  installCjsModuleMock('../config', serverConfig);

  const core = require('../db/provider/routing-core');
  core.setDb(db);

  return { core, loggerChild };
}

function loadScheduler(overrides = {}) {
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const safeStartTask = vi.fn().mockReturnValue(true);
  const queuedTasks = overrides.queuedTasks || [
    makeTask({
      id: 'api-task-1',
      provider: 'groq',
      task_description: 'Test API task',
    }),
  ];
  const runningTasks = overrides.runningTasks || [];
  const providerConfigs = new Map(Object.entries({
    codex: { provider: 'codex', enabled: 1, max_concurrent: 6, transport: 'hybrid', quota_error_patterns: '[]' },
    'claude-cli': { provider: 'claude-cli', enabled: 1, max_concurrent: 6, transport: 'cli', quota_error_patterns: '[]' },
    ollama: { provider: 'ollama', enabled: 1, max_concurrent: 8, transport: 'api', quota_error_patterns: '[]' },
    groq: { provider: 'groq', enabled: 1, max_concurrent: 4, transport: 'api', quota_error_patterns: '[]' },
    anthropic: { provider: 'anthropic', enabled: 1, max_concurrent: 4, transport: 'api', quota_error_patterns: '[]' },
    deepinfra: { provider: 'deepinfra', enabled: 1, max_concurrent: 4, transport: 'api', quota_error_patterns: '[]' },
    hyperbolic: { provider: 'hyperbolic', enabled: 1, max_concurrent: 4, transport: 'api', quota_error_patterns: '[]' },
    ...overrides.providerConfigs,
  }));
  const providerRunningCounts = new Map(Object.entries(overrides.providerRunningCounts || {}));
  const db = {
    getRunningCount: vi.fn().mockReturnValue(overrides.runningCount ?? runningTasks.length),
    prepare: vi.fn(),
    listTasks: vi.fn(({ status }) => {
      if (status === 'running') return cloneValue(runningTasks);
      return [];
    }),
    listQueuedTasksLightweight: vi.fn().mockReturnValue(cloneValue(queuedTasks)),
    listOllamaHosts: vi.fn().mockReturnValue([]),
    getConfig: vi.fn((key) => {
      if (key === 'auto_compute_max_concurrent') return overrides.autoCompute === false ? '0' : '1';
      return null;
    }),
    selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
    updateTaskStatus: vi.fn(),
    getNextQueuedTask: vi.fn().mockReturnValue(null),
    resetExpiredBudgets: vi.fn(),
    checkApprovalRequired: vi.fn().mockReturnValue({ required: false, status: 'not_required', rule: null }),
    getEffectiveMaxConcurrent: vi.fn().mockReturnValue({
      effectiveMaxConcurrent: overrides.effectiveMaxConcurrent ?? 18,
    }),
    getProvider: vi.fn((provider) => cloneValue(providerConfigs.get(provider) || null)),
    getRunningCountByProvider: vi.fn((provider) => {
      if (providerRunningCounts.has(provider)) {
        return providerRunningCounts.get(provider);
      }
      return runningTasks.filter((task) => task.provider === provider && task.status === 'running').length;
    }),
  };

  vi.resetModules();
  resetModuleCache();
  installCjsModuleMock('../logger', { child: vi.fn(() => loggerChild) });
  installCjsModuleMock('../providers/registry', {
    getProviderInstance: vi.fn().mockReturnValue({}),
    getCategory: vi.fn((provider) => {
      if (['groq', 'anthropic', 'deepinfra', 'hyperbolic', 'ollama-cloud', 'cerebras', 'google-ai', 'openrouter'].includes(provider)) return 'api';
      if (provider === 'codex' || provider === 'claude-cli') return 'codex';
      if (overrides.providerCategories && provider in overrides.providerCategories) return overrides.providerCategories[provider];
      return 'ollama';
    }),
  });

  const scheduler = require('../execution/queue-scheduler');
  scheduler.init({
    db,
    safeStartTask,
    safeConfigInt: vi.fn((key, defaultVal) => {
      if (key === 'max_concurrent') return 10;
      if (key === 'max_ollama_concurrent') return 8;
      if (key === 'max_codex_concurrent') return 6;
      if (key === 'max_api_concurrent') return 4;
      if (key === 'max_per_host') return 4;
      return defaultVal;
    }),
    isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
    getProviderInstance: vi.fn().mockReturnValue({}),
    cleanupOrphanedRetryTimeouts: vi.fn(),
  });

  return { scheduler, db, safeStartTask };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  resetModuleCache();
});

describe('per-provider effective max_concurrent', () => {
  it('keeps the configured max_concurrent as the effective global cap', () => {
    const { core } = loadCore();

    expect(core.getEnabledProviderMaxConcurrentSum()).toBe(18);
    expect(core.getEffectiveMaxConcurrent().effectiveMaxConcurrent).toBe(10);
  });

  it('honors the configured global cap when auto_compute_max_concurrent is false', () => {
    const { core } = loadCore({
      config: {
        auto_compute_max_concurrent: '0',
      },
    });

    const result = core.getEffectiveMaxConcurrent();

    expect(result.autoComputeMaxConcurrent).toBe(false);
    expect(result.providerLimitSum).toBe(18);
    expect(result.effectiveMaxConcurrent).toBe(10);
  });

  it('respects only enabled providers when auto-computing the sum', () => {
    const { core } = loadCore({
      providers: {
        'claude-cli': {
          provider: 'claude-cli',
          enabled: 1,
          priority: 15,
          max_concurrent: 3,
          transport: 'cli',
          quota_error_patterns: '[]',
        },
        anthropic: {
          provider: 'anthropic',
          enabled: 1,
          priority: 25,
          max_concurrent: 5,
          transport: 'api',
          quota_error_patterns: '[]',
        },
        disabledHuge: {
          provider: 'disabledHuge',
          enabled: 0,
          priority: 99,
          max_concurrent: 500,
          transport: 'api',
          quota_error_patterns: '[]',
        },
      },
    });

    const result = core.getEffectiveMaxConcurrent();

    expect(result.providerLimitSum).toBe(26);
    expect(result.effectiveMaxConcurrent).toBe(10);
  });

  it('does not count disabled providers toward the effective cap', () => {
    const { core } = loadCore({
      providers: {
        groq: {
          provider: 'groq',
          enabled: 0,
          priority: 30,
          max_concurrent: 40,
          transport: 'api',
          quota_error_patterns: '[]',
        },
      },
    });

    const result = core.getEffectiveMaxConcurrent();

    expect(result.providerLimitSum).toBe(14);
    expect(result.effectiveMaxConcurrent).toBe(10);
  });

  it('logs a warning when enabled provider limits exceed the configured global cap', () => {
    const { core, loggerChild } = loadCore();

    const result = core.getEffectiveMaxConcurrent({ logger: loggerChild });

    expect(result.effectiveMaxConcurrent).toBe(10);
    expect(loggerChild.warn).toHaveBeenCalledWith(
      '[Concurrency] Enabled provider limits sum to 18, but configured max_concurrent=10 is enforced as the global cap.',
    );
  });
});

describe('queue-scheduler integration', () => {
  it('uses the effective max_concurrent before the global capacity early return', () => {
    const { scheduler, db, safeStartTask } = loadScheduler({
      runningCount: 12,
      effectiveMaxConcurrent: 18,
    });

    scheduler.processQueueInternal({ skipRecentProcessGuard: true });

    expect(db.getEffectiveMaxConcurrent).toHaveBeenCalled();
    expect(safeStartTask).toHaveBeenCalledWith('api-task-1', 'API');
    scheduler.stop();
  });

  it('respects individual provider max_concurrent even when the category has capacity', () => {
    const { scheduler, db, safeStartTask } = loadScheduler({
      runningTasks: [
        makeTask({ id: 'run-anthropic-1', provider: 'anthropic', status: 'running' }),
      ],
      queuedTasks: [
        makeTask({ id: 'anthropic-task-1', provider: 'anthropic' }),
        makeTask({ id: 'groq-task-1', provider: 'groq' }),
      ],
      providerConfigs: {
        anthropic: { provider: 'anthropic', enabled: 1, max_concurrent: 1, transport: 'api', quota_error_patterns: '[]' },
        groq: { provider: 'groq', enabled: 1, max_concurrent: 2, transport: 'api', quota_error_patterns: '[]' },
      },
      providerRunningCounts: {
        anthropic: 1,
        groq: 0,
      },
      runningCount: 1,
      effectiveMaxConcurrent: 10,
    });

    scheduler.processQueueInternal({ skipRecentProcessGuard: true });

    expect(db.getRunningCountByProvider).toHaveBeenCalledWith('anthropic');
    expect(db.getRunningCountByProvider).toHaveBeenCalledWith('groq');
    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith('groq-task-1', 'API');
    scheduler.stop();
  });

  it('keeps the category cap as an upper bound', () => {
    const { scheduler, safeStartTask } = loadScheduler({
      runningTasks: [
        makeTask({ id: 'run-groq-1', provider: 'groq', status: 'running' }),
        makeTask({ id: 'run-groq-2', provider: 'groq', status: 'running' }),
        makeTask({ id: 'run-anthropic-1', provider: 'anthropic', status: 'running' }),
        makeTask({ id: 'run-anthropic-2', provider: 'anthropic', status: 'running' }),
      ],
      queuedTasks: [
        makeTask({ id: 'groq-task-1', provider: 'groq' }),
      ],
      providerConfigs: {
        anthropic: { provider: 'anthropic', enabled: 1, max_concurrent: 10, transport: 'api', quota_error_patterns: '[]' },
        groq: { provider: 'groq', enabled: 1, max_concurrent: 10, transport: 'api', quota_error_patterns: '[]' },
      },
      providerRunningCounts: {
        anthropic: 2,
        groq: 2,
      },
      runningCount: 4,
      effectiveMaxConcurrent: 10,
    });

    scheduler.processQueueInternal({ skipRecentProcessGuard: true });

    expect(safeStartTask).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('allows providers in the same category to run concurrently up to their own limits', () => {
    const { scheduler, safeStartTask } = loadScheduler({
      queuedTasks: [
        makeTask({ id: 'groq-task-1', provider: 'groq' }),
        makeTask({ id: 'groq-task-2', provider: 'groq' }),
        makeTask({ id: 'anthropic-task-1', provider: 'anthropic' }),
      ],
      providerConfigs: {
        anthropic: { provider: 'anthropic', enabled: 1, max_concurrent: 1, transport: 'api', quota_error_patterns: '[]' },
        groq: { provider: 'groq', enabled: 1, max_concurrent: 1, transport: 'api', quota_error_patterns: '[]' },
      },
      providerRunningCounts: {
        anthropic: 0,
        groq: 0,
      },
      runningCount: 0,
      effectiveMaxConcurrent: 10,
    });

    scheduler.processQueueInternal({ skipRecentProcessGuard: true });

    expect(safeStartTask.mock.calls).toEqual([
      ['groq-task-1', 'API'],
      ['anthropic-task-1', 'API'],
    ]);
    scheduler.stop();
  });
});
