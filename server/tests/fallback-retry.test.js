const { randomUUID } = require('crypto');
const { installMock } = require('./cjs-mock');
const { STALL_REQUEUE_DEBOUNCE_MS } = require('../constants');
const { classifyError, findLargerAvailableModel, BASE_RETRY_DELAY_MS } = require('../execution/fallback-retry');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let testDir;
let origOpenAiKey;
let db;
let taskCore;
let configCore;
let hostManagement;
let providerRoutingCore;
let mod;

let processQueueCalls;
let notifyCalls;
let cancelCalls;
let restartCalls;
let stallRecoveryAttempts;
let runningProcesses;

const FALLBACK_RETRY_MODULE_PATH = require.resolve('../execution/fallback-retry');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const ROUTING_CORE_MODULE_PATH = require.resolve('../db/provider-routing-core');
const ORIGINAL_FALLBACK_RETRY_CACHE = require.cache[FALLBACK_RETRY_MODULE_PATH];
const ORIGINAL_LOGGER_CACHE = require.cache[LOGGER_MODULE_PATH];
const ORIGINAL_ROUTING_CORE_CACHE = require.cache[ROUTING_CORE_MODULE_PATH];

function setup() {
  origOpenAiKey = process.env.OPENAI_API_KEY;

  ({ db, testDir } = setupTestDbOnly('fallback-retry'));
  taskCore = require('../db/task-core');
  configCore = require('../db/config-core');
  hostManagement = require('../db/host-management');
  providerRoutingCore = require('../db/provider-routing-core');

  // Remove auto-created 'default' host to prevent test contamination
  // (migrateToMultiHost creates it from the seeded ollama_host config)
  try {
    const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];
    for (const host of hosts) {
      if (hostManagement.removeOllamaHost) hostManagement.removeOllamaHost(host.id);
    }
  } catch { /* ok */ }

  // Reset in-memory provider health state to prevent cross-test contamination
  if (typeof providerRoutingCore.resetProviderHealth === 'function') providerRoutingCore.resetProviderHealth();

  processQueueCalls = 0;
  notifyCalls = [];
  cancelCalls = [];
  restartCalls = [];
  stallRecoveryAttempts = new Map();
  runningProcesses = new Map();

  mod = require('../execution/fallback-retry');
  mod.init({
    db,
    dashboard: {
      broadcast: () => {},
      notifyTaskUpdated: (taskId) => notifyCalls.push(taskId),
    },
    processQueue: () => { processQueueCalls++; },
    cancelTask: (taskId, reason) => {
      cancelCalls.push({ taskId, reason });
      return { status: 'cancelled' };
    },
    stopTaskForRestart: (taskId, reason) => {
      restartCalls.push({ taskId, reason });
    },
    stallRecoveryAttempts,
    runningProcesses,
  });
  mod.setFreeQuotaTracker(null);
}

function teardown() {
  if (mod && typeof mod.setFreeQuotaTracker === 'function') {
    mod.setFreeQuotaTracker(null);
  }
  teardownTestDb();

  if (origOpenAiKey !== undefined) {
    process.env.OPENAI_API_KEY = origOpenAiKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const status = overrides.status || 'running';
  taskCore.createTask({
    id,
    status,
    task_description: overrides.task_description || 'Fallback retry test task',
    provider: overrides.provider || 'ollama',
    model: overrides.model !== undefined ? overrides.model : TEST_MODELS.DEFAULT,
    working_directory: overrides.working_directory || testDir,
    ollama_host_id: overrides.ollama_host_id || null,
    metadata: overrides.metadata || null,
    resume_context: overrides.resume_context || null,
  });

  const postCreateUpdates = {};
  if (overrides.retry_count !== undefined) postCreateUpdates.retry_count = overrides.retry_count;
  if (overrides.error_output !== undefined) postCreateUpdates.error_output = overrides.error_output;
  if (Object.keys(postCreateUpdates).length > 0) {
    taskCore.updateTaskStatus(id, status, postCreateUpdates);
  }

  return taskCore.getTask(id);
}

function registerHealthyHost(name, modelNames, extraUpdates = {}) {
  const id = `host-${name}-${randomUUID().slice(0, 8)}`;
  hostManagement.addOllamaHost({
    id,
    name,
    url: `http://${name}.local:11434`,
    max_concurrent: 4
  });

  hostManagement.updateOllamaHost(id, {
    status: 'healthy',
    enabled: 1,
    running_tasks: 0,
    models_cache: JSON.stringify(modelNames.map(m => (typeof m === 'string' ? { name: m } : m))),
    models_updated_at: new Date().toISOString(),
    ...extraUpdates
  });

  return id;
}

function withDbMethods(overrides, fn) {
  const originals = {};
  const keys = Object.keys(overrides);
  for (const key of keys) {
    originals[key] = db[key];
    db[key] = overrides[key];
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        db[key] = originals[key];
      }
    }
  }
}

function restoreCacheEntry(modulePath, originalEntry) {
  if (originalEntry) {
    require.cache[modulePath] = originalEntry;
  } else {
    delete require.cache[modulePath];
  }
}

function loadFallbackRetryWithMocks({
  chain = ['deepinfra', 'anthropic'],
  cloudProviders = ['deepinfra', 'anthropic', 'groq'],
  config = {},
  dbOverrides = {},
} = {}) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerModule = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  delete require.cache[FALLBACK_RETRY_MODULE_PATH];
  installMock('../logger', loggerModule);
  installMock('../db/provider-routing-core', {
    CLOUD_PROVIDERS: cloudProviders,
    getProviderFallbackChain: vi.fn(() => chain),
  });

  const subject = require('../execution/fallback-retry');
  const dbMock = {
    getConfig: vi.fn((key) => Object.prototype.hasOwnProperty.call(config, key) ? config[key] : null),
    getProvider: vi.fn(() => ({ enabled: true })),
    isProviderHealthy: vi.fn(() => true),
    recordFailoverEvent: vi.fn(),
    updateTaskStatus: vi.fn(),
    ...dbOverrides,
  };
  const notifyTaskUpdated = vi.fn();
  const processQueue = vi.fn();

  subject.init({
    db: dbMock,
    dashboard: { notifyTaskUpdated },
    processQueue,
    cancelTask: vi.fn(),
    stopTaskForRestart: vi.fn(),
    stallRecoveryAttempts: new Map(),
    runningProcesses: new Map(),
  });

  return {
    subject,
    dbMock,
    logger,
    notifyTaskUpdated,
    processQueue,
  };
}

describe('fallback-retry module', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { teardown(); });

  describe('tryOllamaCloudFallback', () => {
    it('falls back to configured codex provider and requeues task', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama', retry_count: 1 });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'OOM error');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.retry_count).toBe(2);
      expect(updated.error_output).toContain('[Ollama→Cloud] OOM error');
      expect(notifyCalls).toContain(task.id);
      expect(processQueueCalls).toBe(1);
    });

    it('preserves routing-chain metadata when cloud fallback requeues a task', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');
      const routingChain = [
        { provider: 'codex', model: 'gpt-5.4' },
        { provider: 'claude-cli', model: 'claude-sonnet' },
      ];
      const task = createTask({
        provider: 'ollama',
        metadata: {
          _routing_chain: routingChain,
          auto_routed: true,
        },
      });

      const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider unavailable');
      const updated = taskCore.getTask(task.id);

      expect(ok).toBe(true);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.metadata).toEqual(expect.objectContaining({
        _routing_chain: routingChain,
        requested_provider: 'ollama',
        auto_routed: true,
        last_provider_switch: expect.objectContaining({
          from: 'ollama',
          to: 'codex',
          reason: 'runtime_provider_fallback',
        }),
      }));
      expect(updated.metadata.provider_switch_history).toEqual([
        expect.objectContaining({
          from: 'ollama',
          to: 'codex',
          reason: 'runtime_provider_fallback',
        }),
      ]);
    });

    it('auto-selects claude-cli when codex is disabled and no explicit fallback is set', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '1');

      // Only codex and claude-cli are visible cloud providers for this test
      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'model missing');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('falls through to claude-cli when explicit codex fallback is configured but disabled', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider disabled');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('returns false when all cloud providers are disabled', () => {
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn(() => null),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'all disabled');

        expect(ok).toBe(false);
        expect(taskCore.getTask(task.id).status).toBe('running');
        expect(notifyCalls).toHaveLength(0);
        expect(processQueueCalls).toBe(0);
      });
    });

    it('prefers healthy provider over unhealthy one when isProviderHealthy is available', () => {
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['codex', 'claude-cli'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'claude-cli'),
      }, () => {
        // Mark codex as unhealthy
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'OOM');

        expect(ok).toBe(true);
        // Should pick claude-cli (healthy) instead of codex (unhealthy)
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('uses configured fallback provider when it is healthy', () => {
      configCore.setConfig('ollama_fallback_provider', 'claude-cli');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli', 'codex'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'claude-cli'),
      }, () => {
        const task = createTask({ provider: 'ollama', retry_count: 0 });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'model unavailable');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('falls back to a healthy alternative when configured fallback is unhealthy', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn(() => ({ enabled: true })),
        isProviderHealthy: vi.fn((name) => name === 'claude-cli'),
      }, () => {
        const task = createTask({ provider: 'ollama', retry_count: 2 });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider unhealthy');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
        expect(taskCore.getTask(task.id).retry_count).toBe(3);
      });
    });

    it('falls back to codex as first default provider when only local defaults are enabled', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['codex', 'claude-cli'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider missing');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('codex');
      });
    });

    it('falls back to configured default provider when configured fallback is disabled', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli', 'codex'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'fallback disabled');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('falls back to API provider chain when local cloud providers are disabled', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn((name) => ({
          deepinfra: { enabled: false },
          hyperbolic: { enabled: true },
          anthropic: { enabled: false },
          groq: { enabled: false },
        }[name])),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'no local path');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('uses healthy API provider in declared order', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['deepinfra', 'hyperbolic', 'anthropic', 'groq'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'anthropic' || name === 'groq'),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'API chain');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('anthropic');
      });
    });

    it('falls back to first candidate when all providers are unhealthy', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn(() => ({ enabled: true })),
        isProviderHealthy: vi.fn(() => false),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'no healthy provider');

        expect(ok).toBe(true);
        // ollama-cloud is now first in the ollama fallback chain (before deepinfra)
        expect(taskCore.getTask(task.id).provider).toBe('ollama-cloud');
      });
    });

    it('ignores exceptions while probing API provider config', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn((name) => {
          if (name === 'deepinfra') throw new Error('API not reachable');
          if (name === 'hyperbolic') return { enabled: true };
          return { enabled: false };
        }),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'skip bad provider');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('falls back without isProviderHealthy when health tracker is unavailable', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((_name) => ({ enabled: true })),
        isProviderHealthy: undefined,
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'health tracker missing');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('codex');
      });
    });

    it('always increments retry_count when cloud fallback is taken', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama', retry_count: 7 });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'retry count growth');

      expect(ok).toBe(true);
      expect(taskCore.getTask(task.id).retry_count).toBe(8);
      expect(taskCore.getTask(task.id).error_output).toContain('[Ollama→Cloud]');
    });

    it('prepends resume context when cloud fallback requeues a retry prompt', () => {
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');

      const task = createTask({
        provider: 'ollama',
        task_description: 'Complete the original task',
        resume_context: {
          provider: 'ollama',
          durationMs: 1200,
          filesModified: ['server/retry-target.js'],
          progressSummary: 'updated retry target',
          errorDetails: 'OOM',
          approachTaken: 'tried local model',
        },
      });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'OOM error');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.task_description.startsWith('## Previous Attempt (failed)')).toBe(true);
      expect(updated.task_description).toContain('**Files modified:** server/retry-target.js');
      expect(updated.task_description).toContain('Complete the original task');
    });

    it('skips quota-exhausted cloud providers and selects the next available candidate', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');
      mod.setFreeQuotaTracker(() => ({
        getStatus: () => ({
          deepinfra: { cooldown_until: Date.now() + 60_000 },
        }),
        canSubmit: vi.fn((provider) => provider !== 'deepinfra'),
      }));

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['deepinfra', 'hyperbolic'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'free tier cooldown');

        expect(ok).toBe(true);
        expect(taskCore.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('returns false when quota checks block every otherwise-enabled cloud provider', () => {
      configCore.setConfig('ollama_fallback_provider', '');
      configCore.setConfig('codex_enabled', '0');
      configCore.setConfig('claude_cli_enabled', '0');
      mod.setFreeQuotaTracker(() => ({
        getStatus: () => ({
          deepinfra: { cooldown_until: Date.now() + 60_000 },
          hyperbolic: { cooldown_until: Date.now() + 60_000 },
        }),
        canSubmit: vi.fn(() => false),
      }));

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['deepinfra', 'hyperbolic'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'all providers cooling down');

        expect(ok).toBe(false);
        expect(taskCore.getTask(task.id).status).toBe('running');
        expect(processQueueCalls).toBe(0);
      });
    });
  });

  describe('tryLocalFirstFallback', () => {
    it('tries the same model on a different host first', () => {
      configCore.setConfig('max_local_retries', '3');
      const hostA = registerHealthyHost('local-a', [TEST_MODELS.DEFAULT], { running_tasks: 2 });
      const hostB = registerHealthyHost('local-b', [TEST_MODELS.DEFAULT], { running_tasks: 0 });

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        ollama_host_id: hostA,
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'connection reset');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe(TEST_MODELS.DEFAULT);
      expect(updated.ollama_host_id).toBe(hostB);
      const meta = updated.metadata || {};
      expect(meta.original_provider).toBe('ollama');
      expect(updated.error_output).toContain(`[Local-First] Trying ${TEST_MODELS.DEFAULT} on host`);
    });

    it('tries a different coder model when same-host retry is skipped', () => {
      const hostA = registerHealthyHost('model-a', [TEST_MODELS.CODER_DEFAULT, TEST_MODELS.CODER_QUALITY]);
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_DEFAULT,
        ollama_host_id: hostA
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'still failing', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe(TEST_MODELS.CODER_QUALITY);
      expect(updated.ollama_host_id).toBe(hostA);
      expect(updated.error_output).toContain(`[Local-First] Trying model ${TEST_MODELS.CODER_QUALITY}`);
    });

    it('escalates to cloud when no host/model alternative exists', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'provider issue', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.ollama_host_id).toBeNull();
      expect(updated.error_output).toContain('[Local-First] All local options exhausted');
      expect(updated.error_output).toContain('Falling back to codex');
    });

    it('escalates to cloud after max local retries are exhausted', () => {
      configCore.setConfig('max_local_retries', '1');
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');

      const task = createTask({
        provider: 'ollama',
        error_output: '[Local-First] prior local attempt',
        metadata: {
          local_first_attempts: 1,
          original_provider: 'ollama',
        },
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'still failing');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.error_output).toContain('[Local-First] Exhausted 1 local retries');
    });

    it('skips raw ollama when task is greenfield (new file creation)', () => {
      // EXP7: Raw ollama produces instructions instead of code for greenfield tasks
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        task_description: 'Create a new test file for the auth module',
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'hashline parse error', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      // Should skip 'ollama' (greenfield) and escalate to cloud since no other local providers
      expect(updated.error_output).not.toContain('[Local-First] Trying provider ollama');
    });

    it('still escalates to cloud for non-greenfield tasks when no local options remain', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        task_description: 'Fix the auth handler validation bug in auth.ts',
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'provider issue', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.error_output).toContain('[Local-First] All local options exhausted');
    });

    it('keeps moving through the chain when host selection and model enumeration throw', () => {
      configCore.setConfig('max_local_retries', '3');
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        ollama_host_id: 'host-primary'
      });

      withDbMethods({
        selectOllamaHostForModel: vi.fn(() => {
          throw new Error('host probe timeout');
        }),
        getAggregatedModels: vi.fn(() => {
          throw new Error('model registry offline');
        }),
      }, () => {
        const ok = mod.tryLocalFirstFallback(task.id, task, 'network failures everywhere');

        expect(ok).toBe(true);
        const updated = taskCore.getTask(task.id);
        expect(updated.provider).toBe('codex');
        expect(updated.error_output).toContain('[Local-First] All local options exhausted');
      });
    });

    it('escalates to cloud when every local fallback path has already been exhausted', () => {
      configCore.setConfig('max_local_retries', '5');
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '0');

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        error_output: [
          '[Local-First] Trying provider ollama',
        ].join('\n')
      });

      withDbMethods({
        getAggregatedModels: vi.fn(() => []),
      }, () => {
        const ok = mod.tryLocalFirstFallback(task.id, task, 'provider timeout', { skipSameModel: true });

        expect(ok).toBe(true);
        const updated = taskCore.getTask(task.id);
        expect(updated.provider).toBe('codex');
        expect(updated.model).toBeNull();
        expect(updated.error_output).toContain('[Local-First] All local options exhausted');
      });
    });
  });

  describe('tryStallRecovery', () => {
    it('first attempt switches edit format from diff to whole', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        error_output: 'existing error'
      });
      runningProcesses.set(task.id, { editFormat: 'diff' });

      const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 360 });

      expect(ok).toBe(true);
      expect(restartCalls).toHaveLength(1);
      expect(restartCalls[0].reason).toContain('switch_edit_format');

      const recovery = stallRecoveryAttempts.get(task.id);
      expect(recovery.attempts).toBe(1);
      expect(recovery.lastStrategy).toBe('switch_edit_format');

      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('queued');
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
      expect(updated.error_output).toContain('[STALL RECOVERY] Attempt 1: switch_edit_format');
    });

    it('switches to a larger model when task is already using whole edits', () => {
      const largerCoderModel = TEST_MODELS.CODER_QUALITY;
      const hostA = registerHealthyHost('stall-large-host', [TEST_MODELS.CODER_DEFAULT, largerCoderModel]);
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_DEFAULT,
        ollama_host_id: hostA
      });
      runningProcesses.set(task.id, { editFormat: 'whole' });

      const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 280 });

      expect(ok).toBe(true);
      expect(restartCalls).toHaveLength(1);
      expect(restartCalls[0].reason).toContain('switch_model');

      const recovery = stallRecoveryAttempts.get(task.id);
      expect(recovery.attempts).toBe(1);
      expect(recovery.lastStrategy).toBe('switch_model');

      const updated = taskCore.getTask(task.id);
      expect(updated.model).toBe(largerCoderModel);
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
      expect(updated.error_output).toContain('[STALL RECOVERY] Attempt 1: switch_model');
    });

    it('falls back to local-first fallback when no larger model is available', () => {
      const hostA = registerHealthyHost('stall-no-larger', [TEST_MODELS.QUALITY]);
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.QUALITY,
        ollama_host_id: hostA
      });
      runningProcesses.set(task.id, { editFormat: 'whole' });

      withDbMethods({
        getAggregatedModels: vi.fn(() => [{ name: TEST_MODELS.QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] }]),
      }, () => {
        const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 600 });

        expect(ok).toBe(true);
        expect(restartCalls).toHaveLength(1);
        expect(restartCalls[0].reason).toContain('local_first_fallback');
        expect(stallRecoveryAttempts.get(task.id).attempts).toBe(1);
        expect(stallRecoveryAttempts.get(task.id).lastStrategy).toBe('local_first_fallback');
        expect(taskCore.getTask(task.id).provider).toBe('codex');
      });
    });

    it('debounces stall recovery processQueue call via STALL_REQUEUE_DEBOUNCE_MS', () => {
      vi.useFakeTimers();

      try {
        const task = createTask({
          provider: 'ollama',
          model: TEST_MODELS.DEFAULT,
          error_output: 'existing error'
        });
        runningProcesses.set(task.id, { editFormat: 'diff' });

        const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 360 });
        expect(ok).toBe(true);
        expect(processQueueCalls).toBe(0);

        vi.advanceTimersByTime(STALL_REQUEUE_DEBOUNCE_MS - 1);
        expect(processQueueCalls).toBe(0);

        vi.advanceTimersByTime(1);
        expect(processQueueCalls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps stall state across attempts and clears it only when limit is hit', () => {
      configCore.setConfig('stall_recovery_max_attempts', '1');
      const task = createTask({ provider: 'ollama' });
      stallRecoveryAttempts.set(task.id, { attempts: 0, lastStrategy: null });

      const first = mod.tryStallRecovery(task.id, { lastActivitySeconds: 360 });
      expect(first).toBe(true);
      expect(stallRecoveryAttempts.has(task.id)).toBe(true);
      expect(stallRecoveryAttempts.get(task.id).attempts).toBe(1);

      const second = mod.tryStallRecovery(task.id, { lastActivitySeconds: 360 });
      expect(second).toBe(false);
      expect(stallRecoveryAttempts.has(task.id)).toBe(false);
      expect(cancelCalls).toHaveLength(1);
      expect(cancelCalls[0].reason).toContain('Stall recovery exhausted');
    });

    it('handles a missing task by cancelling without adding stall state', () => {
      const ok = mod.tryStallRecovery('nope-task-id', { lastActivitySeconds: 120 });

      expect(ok).toBe(false);
      expect(cancelCalls).toHaveLength(1);
      expect(cancelCalls[0].taskId).toBe('nope-task-id');
      expect(cancelCalls[0].reason).toBe('Task not found');
      expect(stallRecoveryAttempts.has('nope-task-id')).toBe(false);
    });

    it('marks task failed if stall recovery re-queue update throws', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT
      });

      const originalUpdate = db.updateTaskStatus;
      let call = 0;
      db.updateTaskStatus = vi.fn((id, status, updates) => {
        call++;
        if (call === 1 && status === 'queued') {
          throw new Error('Cannot update status');
        }
        return originalUpdate.call(db, id, status, updates);
      });

      try {
        const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 500 });
        expect(ok).toBe(true);
      } finally {
        db.updateTaskStatus = originalUpdate;
      }

      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('failed');
      expect(updated.error_output).toContain('Stall recovery re-queue failed');
    });

    it('second attempt switches to a larger available model', () => {
      const largerCoderModel = TEST_MODELS.CODER_QUALITY;
      registerHealthyHost('stall-models', [TEST_MODELS.CODER_DEFAULT, largerCoderModel]);
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_DEFAULT,
      });
      stallRecoveryAttempts.set(task.id, { attempts: 1, lastStrategy: 'switch_edit_format' });

      const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 420 });

      expect(ok).toBe(true);
      expect(restartCalls).toHaveLength(1);
      expect(restartCalls[0].reason).toContain('switch_model');

      const recovery = stallRecoveryAttempts.get(task.id);
      expect(recovery.attempts).toBe(2);
      expect(recovery.lastStrategy).toBe('switch_model');

      const updated = taskCore.getTask(task.id);
      expect(updated.model).toBe(largerCoderModel);
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
    });

    it('cancels task when maximum stall recovery attempts are exhausted', () => {
      configCore.setConfig('stall_recovery_max_attempts', '2');
      const task = createTask({ provider: 'ollama' });
      stallRecoveryAttempts.set(task.id, { attempts: 2, lastStrategy: 'local_first_fallback' });

      const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 999 });

      expect(ok).toBe(false);
      expect(stallRecoveryAttempts.has(task.id)).toBe(false);
      expect(cancelCalls).toHaveLength(1);
      expect(cancelCalls[0].taskId).toBe(task.id);
      expect(cancelCalls[0].reason).toContain('Stall recovery exhausted');
    });

    it('uses local-first fallback directly on third-and-later stall recovery attempts', () => {
      configCore.setConfig('max_local_retries', '3');
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
      });
      runningProcesses.set(task.id, { editFormat: 'whole' });
      stallRecoveryAttempts.set(task.id, { attempts: 2, lastStrategy: 'switch_model' });

      withDbMethods({
        getAggregatedModels: vi.fn(() => []),
      }, () => {
        const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 480 });

        expect(ok).toBe(true);
        expect(restartCalls).toHaveLength(1);
        expect(restartCalls[0].reason).toContain('local_first_fallback');
        expect(stallRecoveryAttempts.get(task.id)).toEqual({
          attempts: 3,
          lastStrategy: 'local_first_fallback',
        });
        expect(taskCore.getTask(task.id).provider).toBe('codex');
      });
    });
  });

  describe('findLargerAvailableModel', () => {
    it('returns null when getAggregatedModels returns empty array', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => []);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.DEFAULT)).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns null when current model is already the largest available', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.QUALITY)).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns the next larger coder model on a healthy host', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.CODER_BALANCED, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.CODER_DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.CODER_DEFAULT)).toBe(TEST_MODELS.CODER_BALANCED);
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('skips candidates on unhealthy or disabled hosts', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.CODER_BALANCED, hosts: [{ status: 'unhealthy', enabled: 1 }] },
        { name: TEST_MODELS.CODER_DEFAULT, hosts: [{ status: 'healthy', enabled: 0 }] },
        { name: TEST_MODELS.CODER_QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.CODER_DEFAULT)).toBe(TEST_MODELS.CODER_QUALITY);
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('handles models with unsupported sizes without throwing', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(() => findLargerAvailableModel(TEST_MODELS.BALANCED)).not.toThrow();
        expect(findLargerAvailableModel(TEST_MODELS.BALANCED)).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns null when current model size cannot be parsed', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] },
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('ignores non-coder model candidates when selecting escalation target', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.CODER_BALANCED, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] },
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.CODER_DEFAULT)).toBe(TEST_MODELS.CODER_BALANCED);
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('picks the smallest larger model even when model list is unsorted', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.CODER_QUALITY, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.CODER_BALANCED, hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: TEST_MODELS.CODER_DEFAULT, hosts: [{ status: 'healthy', enabled: 1 }] },
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.CODER_DEFAULT)).toBe(TEST_MODELS.CODER_BALANCED);
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('treats models with missing host metadata as available', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: TEST_MODELS.DEFAULT },
        { name: TEST_MODELS.QUALITY, hosts: [] },
      ]);

      try {
        expect(findLargerAvailableModel(TEST_MODELS.DEFAULT)).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns null when larger-model discovery throws', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => {
        throw new Error('aggregated models unavailable');
      });

      try {
        expect(findLargerAvailableModel(TEST_MODELS.DEFAULT)).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });
  });

  describe('hashline model helpers', () => {
    it('isHashlineCapableModel honors allowlist and allow-all behavior', () => {
      configCore.setConfig('hashline_capable_models', `test-coder,${TEST_MODELS.DEFAULT}`);
      expect(mod.isHashlineCapableModel(TEST_MODELS.CODER_SMALL)).toBe(true);
      expect(mod.isHashlineCapableModel(TEST_MODELS.FAST)).toBe(false);

      configCore.setConfig('hashline_capable_models', '');
      expect(mod.isHashlineCapableModel(TEST_MODELS.FAST)).toBe(true);
    });

    it('findNextHashlineModel prefers the smallest larger untried model', () => {
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const hostId = registerHealthyHost('hashline-next', [
        TEST_MODELS.CODER_SMALL,
        TEST_MODELS.CODER_DEFAULT,
        TEST_MODELS.CODER_DEFAULT
      ]);

      const next = mod.findNextHashlineModel(TEST_MODELS.CODER_SMALL, '');
      expect(next).toEqual({ name: TEST_MODELS.CODER_DEFAULT, hostId });
    });

    it('findNextHashlineModel falls back to largest untried capable model when none are larger', () => {
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const hostId = registerHealthyHost('hashline-fallback', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT]);

      const next = mod.findNextHashlineModel(
        TEST_MODELS.CODER_DEFAULT,
        `[Hashline-Local] Trying model ${TEST_MODELS.CODER_DEFAULT}`
      );
      expect(next).toEqual({ name: TEST_MODELS.CODER_SMALL, hostId });
    });

    it('findNextHashlineModel returns null when model discovery throws', () => {
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const originalGetAggregatedModels = hostManagement.getAggregatedModels;
      hostManagement.getAggregatedModels = vi.fn(() => {
        throw new Error('hashline registry offline');
      });

      try {
        expect(mod.findNextHashlineModel(TEST_MODELS.CODER_SMALL, '')).toBeNull();
      } finally {
        hostManagement.getAggregatedModels = originalGetAggregatedModels;
      }
    });
  });

  describe('tryHashlineTieredFallback', () => {
    it('retries same model on a different host before cloud escalation', () => {
      configCore.setConfig('max_hashline_local_retries', '2');
      const hostA = registerHealthyHost('hashline-a', [TEST_MODELS.DEFAULT], { running_tasks: 2 });
      const hostB = registerHealthyHost('hashline-b', [TEST_MODELS.DEFAULT], { running_tasks: 0 });

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        ollama_host_id: hostA
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe(TEST_MODELS.DEFAULT);
      expect(updated.ollama_host_id).toBe(hostB);
      expect(updated.error_output).toContain(`[Hashline-Local] Trying ${TEST_MODELS.DEFAULT} on host`);
    });

    it('skips host switching when the task is already known not hashline-capable', () => {
      configCore.setConfig('max_hashline_local_retries', '2');
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const host = registerHealthyHost('hashline-single', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT]);

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_SMALL,
        ollama_host_id: host
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'not hashline-capable output format invalid');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      expect(updated.model).toBe(TEST_MODELS.CODER_DEFAULT);
      expect(updated.ollama_host_id).toBe(host);
      expect(updated.error_output).toContain(`[Hashline-Local] Trying model ${TEST_MODELS.CODER_DEFAULT}`);
    });

    it('tries an untried larger hashline model when prior model was already attempted', () => {
      configCore.setConfig('max_hashline_local_retries', '2');
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const host = registerHealthyHost('hashline-history', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT, TEST_MODELS.CODER_QUALITY]);

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_SMALL,
        ollama_host_id: host,
        error_output: `[Hashline-Local] Trying model ${TEST_MODELS.CODER_DEFAULT}`
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'stale response');

      expect(ok).toBe(true);
      const updated = taskCore.getTask(task.id);
      // CODER_DEFAULT was already tried, so findNextHashlineModel picks CODER_QUALITY
      expect(updated.model).toBe(TEST_MODELS.CODER_QUALITY);
      expect(updated.provider).toBe('ollama');
      expect(updated.error_output).toContain(`[Hashline-Local] Trying model ${TEST_MODELS.CODER_QUALITY}`);
    });

    it('falls back to a larger model when only one host is available', () => {
      configCore.setConfig('max_hashline_local_retries', '1');
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const host = registerHealthyHost('hashline-alone', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT]);

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_SMALL,
        ollama_host_id: host
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'hashline parsing failed');
      expect(ok).toBe(true);

      const updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe(TEST_MODELS.CODER_DEFAULT);
      expect(updated.error_output).toContain(`[Hashline-Local] Trying model ${TEST_MODELS.CODER_DEFAULT}`);
    });

    it('keeps escalating locally when same-model host selection fails with a timeout', () => {
      configCore.setConfig('max_hashline_local_retries', '2');
      configCore.setConfig('hashline_capable_models', 'test-coder');
      const host = registerHealthyHost('hashline-timeout', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT]);

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_SMALL,
        ollama_host_id: host
      });

      withDbMethods({
        selectOllamaHostForModel: vi.fn((modelName, options) => {
          if (options && Array.isArray(options.excludeHostIds)) {
            throw new Error('provider timeout');
          }
          return { host: { id: host, name: 'hashline-timeout' } };
        }),
      }, () => {
        const ok = mod.tryHashlineTieredFallback(task.id, task, 'network timeout');

        expect(ok).toBe(true);
        const updated = taskCore.getTask(task.id);
        expect(updated.provider).toBe('ollama');
        expect(updated.model).toBe(TEST_MODELS.CODER_DEFAULT);
        expect(updated.error_output).toContain(`[Hashline-Local] Trying model ${TEST_MODELS.CODER_DEFAULT}`);
      });
    });

    it('falls back to codex when cloud escalation is unavailable', () => {
      configCore.setConfig('max_hashline_local_retries', '1');
      configCore.setConfig('hashline_capable_models', 'test-coder');
      providerRoutingCore.getProvider = () => ({ enabled: false });
      delete process.env.OPENAI_API_KEY;

      const host = registerHealthyHost('hashline-no-openai', [TEST_MODELS.CODER_SMALL, TEST_MODELS.CODER_DEFAULT]);
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.CODER_SMALL,
        ollama_host_id: host
      });

      const first = mod.tryHashlineTieredFallback(task.id, task, 'local retry');
      expect(first).toBe(true);
      let updated = taskCore.getTask(task.id);
      expect(updated.model).toBe(TEST_MODELS.CODER_DEFAULT);

      const second = mod.tryHashlineTieredFallback(task.id, taskCore.getTask(task.id), 'still failing');
      expect(second).toBe(true);
      updated = taskCore.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.error_output).toContain('Escalated from ollama: still failing');
    });

    it('skips fallback when task is already cancelled', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.SMALL
      });
      // Manually set task to cancelled state
      taskCore.updateTaskStatus(task.id, 'cancelled', {});

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');

      expect(ok).toBe(false);
      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('cancelled');
      expect(updated.provider).toBe('ollama'); // unchanged
    });

    it('skips fallback when task is already completed', () => {
      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.SMALL
      });
      taskCore.updateTaskStatus(task.id, 'running', {});
      taskCore.updateTaskStatus(task.id, 'completed', { exit_code: 0 });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'stale error');

      expect(ok).toBe(false);
      const updated = taskCore.getTask(task.id);
      expect(updated.status).toBe('completed');
    });
  });

  describe('full triggerFallback flow', () => {
    it('drives local-first fallback through provider switch then cloud escalation', () => {
      // Each call adds one [Local-First] marker to error_output.
      // With max_local_retries=1, the first call gets one local retry,
      // and the second call sees 1 marker >= max(1) and escalates to cloud.
      configCore.setConfig('max_local_retries', '1');
      configCore.setConfig('ollama_fallback_provider', 'codex');
      configCore.setConfig('codex_enabled', '1');
      configCore.setConfig('claude_cli_enabled', '1');
      // Single host, no model alternatives: step 1 (host switch) and step 2 (model switch)
      // both fail, forcing step 3 (provider switch) on the first call.
      const hostA = registerHealthyHost('full-a', [TEST_MODELS.DEFAULT]);

      withDbMethods({
        getAggregatedModels: vi.fn(() => []),
      }, () => {
        const task = createTask({
          provider: 'ollama',
          model: TEST_MODELS.DEFAULT,
          ollama_host_id: hostA
        });

        // Call 1: step 1 fails (only one host). Step 2 fails (no models).
        // With no alternate local provider left, the chain now escalates directly to cloud.
        const first = mod.tryLocalFirstFallback(task.id, taskCore.getTask(task.id), 'first local failure');
        expect(first).toBe(true);
        const afterFirst = taskCore.getTask(task.id);
        expect(afterFirst.provider).toBe('codex');
        expect(afterFirst.error_output).toContain('[Local-First] All local options exhausted');

        // Call 2: once the task is on codex, raw ollama becomes an untried local
        // provider again and the current logic switches back to it.
        const second = mod.tryLocalFirstFallback(task.id, taskCore.getTask(task.id), 'second local failure');
        expect(second).toBe(true);
        const afterSecond = taskCore.getTask(task.id);
        expect(afterSecond.provider).toBe('ollama');
        expect(afterSecond.model).toBeNull();
        expect(afterSecond.error_output).toContain('[Local-First] Trying provider ollama');
      });
    });

  });

  describe('selectHashlineFormat', () => {
    it('uses task metadata override before model config override', () => {
      configCore.setConfig('hashline_model_formats', JSON.stringify({
        [TEST_MODELS.SMALL]: 'hashline-lite',
        qwen2_5_coder: 'hashline-lite'
      }));
      const task = {
        metadata: JSON.stringify({ hashline_format_override: 'hashline' })
      };

      const selected = mod.selectHashlineFormat(TEST_MODELS.SMALL, task);

      expect(selected).toEqual({ format: 'hashline', reason: 'fallback_override' });
    });

    it('uses exact and base-model config overrides before auto-selection', () => {
      configCore.setConfig('hashline_model_formats', JSON.stringify({
        [TEST_MODELS.CODER_DEFAULT]: 'hashline-lite',
        'test-coder': 'hashline-lite'
      }));

      expect(mod.selectHashlineFormat(TEST_MODELS.CODER_DEFAULT, null)).toEqual({
        format: 'hashline-lite',
        reason: 'config_override'
      });
      expect(mod.selectHashlineFormat(TEST_MODELS.CODER_QUALITY, null)).toEqual({
        format: 'hashline-lite',
        reason: 'config_override_base'
      });
    });

    it('forces standard hashline when the model has repeated format failures', () => {
      configCore.setConfig('hashline_model_formats', '{}');
      configCore.setConfig('hashline_format_auto_select', '0');
      const originalGetModelFormatFailures = db.getModelFormatFailures;
      db.getModelFormatFailures = vi.fn(() => ([
        { model_name: 'test-coder', failure_count: 2 },
        { model_name: TEST_MODELS.CODER_DEFAULT, failure_count: 1 },
      ]));

      try {
        expect(mod.selectHashlineFormat(TEST_MODELS.CODER_DEFAULT, null)).toEqual({
          format: 'whole',
          reason: 'auto_learned (3 hashline failures → whole)'
        });
      } finally {
        db.getModelFormatFailures = originalGetModelFormatFailures;
      }
    });

    it('falls back to the default format when auto-learn checks fail', () => {
      configCore.setConfig('hashline_model_formats', '{}');
      configCore.setConfig('hashline_format_auto_select', '0');
      const originalGetModelFormatFailures = db.getModelFormatFailures;
      db.getModelFormatFailures = vi.fn(() => {
        throw new Error('telemetry store unavailable');
      });

      try {
        expect(mod.selectHashlineFormat(TEST_MODELS.DEFAULT, null)).toEqual({
          format: 'hashline',
          reason: 'default'
        });
      } finally {
        db.getModelFormatFailures = originalGetModelFormatFailures;
      }
    });

    it('uses auto-routing when enabled and falls back to default when no recommendation exists', () => {
      configCore.setConfig('hashline_model_formats', '{}');
      configCore.setConfig('hashline_format_auto_select', '1');
      const originalGetBestFormat = db.getBestFormatForModel;
      db.getBestFormatForModel = () => ({ format: 'hashline-lite', reason: 'lite_outperforms' });

      try {
        const auto = mod.selectHashlineFormat(TEST_MODELS.DEFAULT, null);
        expect(auto).toEqual({ format: 'hashline-lite', reason: 'auto_lite_outperforms' });

        db.getBestFormatForModel = () => ({ format: null, reason: 'insufficient_data' });
        const fallback = mod.selectHashlineFormat(TEST_MODELS.DEFAULT, null);
        expect(fallback).toEqual({ format: 'hashline', reason: 'default' });
      } finally {
        db.getBestFormatForModel = originalGetBestFormat;
      }
    });
  });
});

describe('classifyError', () => {
  it('classifies git trust violations as non-retryable', () => {
    const result = classifyError('fatal: not inside a trusted directory');
    expect(result).toEqual({ retryable: false, reason: 'Not a trusted git directory' });
  });

  it('classifies permission denied as non-retryable', () => {
    const result = classifyError('Could not open file: Permission denied');
    expect(result).toEqual({ retryable: false, reason: 'Permission denied' });
  });

  it('classifies access denied as non-retryable', () => {
    const result = classifyError('Device access denied by policy');
    expect(result).toEqual({ retryable: false, reason: 'Access denied' });
  });

  it('classifies syntax error as non-retryable', () => {
    const result = classifyError('syntax error near unexpected token');
    expect(result).toEqual({ retryable: false, reason: 'Syntax error in task' });
  });

  it('classifies command not found as non-retryable', () => {
    const result = classifyError('command not found: llama');
    expect(result).toEqual({ retryable: false, reason: 'Command not found' });
  });

  it('classifies stack trace errors as non-retryable', () => {
    const result = classifyError('Error: Unexpected token\n    at runTask (/app/jobs/runner.js:42:10)\n');
    expect(result).toEqual({ retryable: false, reason: 'Code error detected in output - not retryable' });
  });

  it('classifies ENOENT errors as non-retryable', () => {
    const result = classifyError('ENOENT: open /app/data/input.json');
    expect(result).toEqual({ retryable: false, reason: 'File not found - not retryable' });
  });

  it('classifies ENOSPC errors as non-retryable', () => {
    const result = classifyError('ENOSPC: write failed at /app/output.log');
    expect(result).toEqual({ retryable: false, reason: 'Disk space exhausted - not retryable' });
  });

  it('classifies out of memory errors as retryable', () => {
    const result = classifyError('JavaScript heap out of memory, allocation failed');
    expect(result).toEqual({ retryable: true, reason: 'Out of memory - may recover with smaller input' });
  });

  it('classifies authentication failures as non-retryable', () => {
    const result = classifyError('Authentication failed while contacting service');
    expect(result).toEqual({ retryable: false, reason: 'Authentication failed' });
  });

  it('classifies invalid credentials as non-retryable', () => {
    const result = classifyError('Invalid credentials provided for API access');
    expect(result).toEqual({ retryable: false, reason: 'Invalid credentials' });
  });

  it('classifies unauthorized as non-retryable', () => {
    const result = classifyError('unauthorized: token is invalid');
    expect(result).toEqual({ retryable: false, reason: 'Unauthorized' });
  });

  it('classifies HTTP 401 as non-retryable', () => {
    const result = classifyError('Request failed with status 401: authentication failed or unauthorized');
    expect(result).toEqual({ retryable: false, reason: 'Authentication failed' });
  });

  it('classifies API key issues as non-retryable', () => {
    const result = classifyError('invalid api key value provided');
    expect(result).toEqual({ retryable: false, reason: 'Invalid API key' });
  });

  it('classifies network timeout as retryable', () => {
    const result = classifyError('ETIMEDOUT while calling endpoint');
    expect(result).toEqual({ retryable: true, reason: 'Connection timed out' });
  });

  it('classifies rate limiting (429) as retryable', () => {
    const result = classifyError('Request failed with status 429 retry_after_seconds=30');
    expect(result).toEqual({ retryable: true, reason: 'Too many requests', retryAfterSeconds: 30 });
  });

  it('classifies 429 rate limit errors without retry-after as retryable', () => {
    const result = classifyError('Request failed with status 429');
    expect(result).toEqual({ retryable: true, reason: 'Too many requests' });
  });

  it('classifies service unavailable (503) as retryable', () => {
    const result = classifyError('503 Service Unavailable');
    expect(result).toEqual({ retryable: true, reason: 'Service unavailable' });
  });

  it('marks short unknown exitCode=1 errors as retryable', () => {
    const result = classifyError('short network flap', 1);
    expect(result).toEqual({ retryable: true, reason: 'Unknown short error - may be transient' });
  });

  it('defaults unknown errors without known patterns to non-retryable', () => {
    const result = classifyError('x'.repeat(600), 2);
    expect(result).toEqual({ retryable: false, reason: 'Long unknown error treated as non-retryable' });
  });

  it('treats empty output as retryable', () => {
    const result = classifyError('');
    expect(result.retryable).toBe(true);
  });

  it('matches patterns case-insensitively', () => {
    const result = classifyError('COMMAND NOT FOUND');
    expect(result).toEqual({ retryable: false, reason: 'Command not found' });
  });

  it('classifies signal-terminated subprocess output via the process-exit tag', () => {
    const result = classifyError('some stderr noise\n[process-exit] terminated by signal SIGKILL', -1);
    expect(result).toEqual({ retryable: true, reason: 'Process killed by signal SIGKILL' });
  });

  it('classifies empty output with exit=-1 as premature exit (distinct from unknown)', () => {
    const result = classifyError('', -1);
    expect(result).toEqual({
      retryable: true,
      reason: 'Premature exit with no output - subprocess died before producing diagnostics',
    });
  });

  it('still treats exit=-1 with meaningful output as unknown (not premature)', () => {
    const longEnoughError = 'x'.repeat(80) + ' arbitrary failure message';
    const result = classifyError(longEnoughError, -1);
    expect(result.reason).not.toBe('Premature exit with no output - subprocess died before producing diagnostics');
  });

  it('classifies EXIT_SPAWN_INSTANT_EXIT (-101) as instant-exit', () => {
    const result = classifyError('Process exited immediately with no output (possible spawn failure or crash)', -101);
    expect(result).toEqual({
      retryable: true,
      reason: 'Subprocess spawned but exited before tracking could record it (instant exit)',
    });
  });

  it('classifies EXIT_CLOSE_HANDLER_EXCEPTION (-102) as close-handler exception', () => {
    // Error text must not match any earlier NON_RETRYABLE_PATTERNS (e.g. TypeError,
    // ENOENT) — those run first by design so code bugs and missing files always
    // short-circuit to non-retryable regardless of the exit sentinel.
    const result = classifyError('Internal error: post-close accounting failed', -102);
    expect(result).toEqual({
      retryable: true,
      reason: 'Close-handler internal exception — subprocess exit was observed but post-processing threw',
    });
  });

  it('classifies EXIT_SPAWN_ERROR (-103) as spawn error', () => {
    // Avoid ENOENT / "no such file" strings which match earlier non-retryable
    // patterns; the sentinel path is what we're testing here.
    const result = classifyError('Process error: child exited with spawn failure', -103);
    expect(result).toEqual({
      retryable: true,
      reason: 'Subprocess spawn error (likely ENOENT / EACCES / path or permissions)',
    });
  });
});

describe('scheduleProcessQueue debouncing', () => {
  it('debounces rapid tryHashlineTieredFallback calls into one processQueue run', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      // Full setup with fake timers active so setTimeout is properly intercepted
      setup();

      configCore.setConfig('max_hashline_local_retries', '0');
      providerRoutingCore.getProvider = () => ({ enabled: false });
      delete process.env.OPENAI_API_KEY;

      const task = createTask({
        provider: 'ollama',
        model: TEST_MODELS.SMALL,
      });

      mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');
      mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');
      mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');

      expect(processQueueCalls).toBe(0);
      vi.advanceTimersByTime(BASE_RETRY_DELAY_MS);
      expect(processQueueCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      teardown();
    }
  });
});

describe('fallback-retry isolated dependency mocks', () => {
  afterEach(() => {
    restoreCacheEntry(FALLBACK_RETRY_MODULE_PATH, ORIGINAL_FALLBACK_RETRY_CACHE);
    restoreCacheEntry(LOGGER_MODULE_PATH, ORIGINAL_LOGGER_CACHE);
    restoreCacheEntry(ROUTING_CORE_MODULE_PATH, ORIGINAL_ROUTING_CORE_CACHE);
  });

  it('uses mocked provider routing order and warns through the mocked logger when every provider is unhealthy', () => {
    const { subject, dbMock, logger, notifyTaskUpdated, processQueue } = loadFallbackRetryWithMocks({
      chain: ['groq', 'deepinfra'],
      cloudProviders: ['groq', 'deepinfra', 'anthropic'],
      config: {
        ollama_fallback_provider: '',
        codex_enabled: '0',
        claude_cli_enabled: '0',
      },
      dbOverrides: {
        getProvider: vi.fn((name) => ({ enabled: ['groq', 'deepinfra'].includes(name) })),
        isProviderHealthy: vi.fn(() => false),
      },
    });

    const ok = subject.tryOllamaCloudFallback('task-mocked', { provider: 'ollama', retry_count: 2 }, 'all mocked providers unhealthy');

    expect(ok).toBe(true);
    expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-mocked', 'queued', expect.objectContaining({
      provider: 'groq',
      retry_count: 3,
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('All 2 cloud providers unhealthy'));
    expect(notifyTaskUpdated).toHaveBeenCalledWith('task-mocked');
    expect(processQueue).toHaveBeenCalledTimes(1);
  });

  it('honors mocked configured fallback ordering ahead of the mocked routing chain', () => {
    const { subject, dbMock } = loadFallbackRetryWithMocks({
      chain: ['deepinfra', 'groq'],
      cloudProviders: ['deepinfra', 'groq', 'anthropic'],
      config: {
        ollama_fallback_provider: 'anthropic',
        codex_enabled: '0',
        claude_cli_enabled: '0',
      },
      dbOverrides: {
        getProvider: vi.fn((name) => ({ enabled: ['deepinfra', 'groq', 'anthropic'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'anthropic'),
      },
    });

    const ok = subject.tryOllamaCloudFallback('task-ordered', { provider: 'ollama', retry_count: 0 }, 'provider timeout');

    expect(ok).toBe(true);
    expect(dbMock.updateTaskStatus).toHaveBeenCalledWith('task-ordered', 'queued', expect.objectContaining({
      provider: 'anthropic',
      retry_count: 1,
    }));
  });
});
