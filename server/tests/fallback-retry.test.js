const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { installMock } = require('./cjs-mock');
const { STALL_REQUEUE_DEBOUNCE_MS } = require('../constants');
const { classifyError, findLargerAvailableModel, BASE_RETRY_DELAY_MS } = require('../execution/fallback-retry');

let testDir;
let origDataDir;
let origOpenAiKey;
let db;
let hostManagement;
let providerRoutingCore;
let eventTracking;
let mod;

let processQueueCalls;
let notifyCalls;
let cancelCalls;
let restartCalls;
let stallRecoveryAttempts;
let runningProcesses;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

const FALLBACK_RETRY_MODULE_PATH = require.resolve('../execution/fallback-retry');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const ROUTING_CORE_MODULE_PATH = require.resolve('../db/provider-routing-core');
const ORIGINAL_FALLBACK_RETRY_CACHE = require.cache[FALLBACK_RETRY_MODULE_PATH];
const ORIGINAL_LOGGER_CACHE = require.cache[LOGGER_MODULE_PATH];
const ORIGINAL_ROUTING_CORE_CACHE = require.cache[ROUTING_CORE_MODULE_PATH];

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-fallback-retry-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  origOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  hostManagement = require('../db/host-management');
  providerRoutingCore = require('../db/provider-routing-core');
  eventTracking = require('../db/event-tracking');

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
  if (db) {
    try { db.close(); } catch {}
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }

  if (origOpenAiKey !== undefined) {
    process.env.OPENAI_API_KEY = origOpenAiKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const status = overrides.status || 'running';
  db.createTask({
    id,
    status,
    task_description: overrides.task_description || 'Fallback retry test task',
    provider: overrides.provider || 'ollama',
    model: overrides.model !== undefined ? overrides.model : 'qwen2.5-coder:14b',
    working_directory: overrides.working_directory || testDir,
    ollama_host_id: overrides.ollama_host_id || null,
    metadata: overrides.metadata || null,
  });

  const postCreateUpdates = {};
  if (overrides.retry_count !== undefined) postCreateUpdates.retry_count = overrides.retry_count;
  if (overrides.error_output !== undefined) postCreateUpdates.error_output = overrides.error_output;
  if (Object.keys(postCreateUpdates).length > 0) {
    db.updateTaskStatus(id, status, postCreateUpdates);
  }

  return db.getTask(id);
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
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama', retry_count: 1 });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'OOM error');

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.retry_count).toBe(2);
      expect(updated.error_output).toContain('[Ollama→Cloud] OOM error');
      expect(notifyCalls).toContain(task.id);
      expect(processQueueCalls).toBe(1);
    });

    it('auto-selects claude-cli when codex is disabled and no explicit fallback is set', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama' });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'model missing');

      expect(ok).toBe(true);
      expect(db.getTask(task.id).provider).toBe('claude-cli');
    });

    it('falls through to claude-cli when explicit codex fallback is configured but disabled', () => {
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama' });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider disabled');

      expect(ok).toBe(true);
      expect(db.getTask(task.id).provider).toBe('claude-cli');
    });

    it('returns false when all cloud providers are disabled', () => {
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');

      const task = createTask({ provider: 'ollama' });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'all disabled');

      expect(ok).toBe(false);
      expect(db.getTask(task.id).status).toBe('running');
      expect(notifyCalls).toHaveLength(0);
      expect(processQueueCalls).toBe(0);
    });

    it('prefers healthy provider over unhealthy one when isProviderHealthy is available', () => {
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');
      // Mark codex as unhealthy by recording many failures
      for (let i = 0; i < 10; i++) providerRoutingCore.recordProviderOutcome('codex', false);

      const task = createTask({ provider: 'ollama' });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'OOM');

      expect(ok).toBe(true);
      // Should pick claude-cli (healthy) instead of codex (unhealthy)
      expect(db.getTask(task.id).provider).toBe('claude-cli');

      // Clean up in-memory health state to avoid leaking into other tests
      if (typeof providerRoutingCore.resetProviderHealth === 'function') providerRoutingCore.resetProviderHealth();
    });

    it('uses configured fallback provider when it is healthy', () => {
      db.setConfig('ollama_fallback_provider', 'claude-cli');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli', 'codex'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'claude-cli'),
      }, () => {
        const task = createTask({ provider: 'ollama', retry_count: 0 });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'model unavailable');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('falls back to a healthy alternative when configured fallback is unhealthy', () => {
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn(() => ({ enabled: true })),
        isProviderHealthy: vi.fn((name) => name === 'claude-cli'),
      }, () => {
        const task = createTask({ provider: 'ollama', retry_count: 2 });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider unhealthy');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('claude-cli');
        expect(db.getTask(task.id).retry_count).toBe(3);
      });
    });

    it('falls back to codex as first default provider when only local defaults are enabled', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['codex', 'claude-cli'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'provider missing');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('codex');
      });
    });

    it('falls back to configured default provider when configured fallback is disabled', () => {
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['claude-cli', 'codex'].includes(name) })),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'fallback disabled');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('claude-cli');
      });
    });

    it('falls back to API provider chain when local cloud providers are disabled', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');

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
        expect(db.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('uses healthy API provider in declared order', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn((name) => ({ enabled: ['deepinfra', 'hyperbolic', 'anthropic', 'groq'].includes(name) })),
        isProviderHealthy: vi.fn((name) => name === 'anthropic' || name === 'groq'),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'API chain');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('anthropic');
      });
    });

    it('falls back to first candidate when all providers are unhealthy', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');

      withDbMethods({
        getProvider: vi.fn(() => ({ enabled: true })),
        isProviderHealthy: vi.fn(() => false),
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'no healthy provider');

        expect(ok).toBe(true);
        // ollama-cloud is now first in the ollama fallback chain (before deepinfra)
        expect(db.getTask(task.id).provider).toBe('ollama-cloud');
      });
    });

    it('ignores exceptions while probing API provider config', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');

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
        expect(db.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('falls back without isProviderHealthy when health tracker is unavailable', () => {
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      withDbMethods({
        getProvider: vi.fn((_name) => ({ enabled: true })),
        isProviderHealthy: undefined,
      }, () => {
        const task = createTask({ provider: 'ollama' });
        const ok = mod.tryOllamaCloudFallback(task.id, task, 'health tracker missing');

        expect(ok).toBe(true);
        expect(db.getTask(task.id).provider).toBe('codex');
      });
    });

    it('always increments retry_count when cloud fallback is taken', () => {
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');

      const task = createTask({ provider: 'ollama', retry_count: 7 });
      const ok = mod.tryOllamaCloudFallback(task.id, task, 'retry count growth');

      expect(ok).toBe(true);
      expect(db.getTask(task.id).retry_count).toBe(8);
      expect(db.getTask(task.id).error_output).toContain('[Ollama→Cloud]');
    });

    it('skips quota-exhausted cloud providers and selects the next available candidate', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');
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
        expect(db.getTask(task.id).provider).toBe('hyperbolic');
      });
    });

    it('returns false when quota checks block every otherwise-enabled cloud provider', () => {
      db.setConfig('ollama_fallback_provider', '');
      db.setConfig('codex_enabled', '0');
      db.setConfig('claude_cli_enabled', '0');
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
        expect(db.getTask(task.id).status).toBe('running');
        expect(processQueueCalls).toBe(0);
      });
    });
  });

  describe('tryLocalFirstFallback', () => {
    it('tries the same model on a different host first', () => {
      db.setConfig('max_local_retries', '3');
      const hostA = registerHealthyHost('local-a', ['qwen2.5-coder:14b'], { running_tasks: 2 });
      const hostB = registerHealthyHost('local-b', ['qwen2.5-coder:14b'], { running_tasks: 0 });

      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        ollama_host_id: hostA,
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'connection reset');

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('queued');
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe('qwen2.5-coder:14b');
      expect(updated.ollama_host_id).toBe(hostB);
      const meta = updated.metadata || {};
      expect(meta.original_provider).toBe('ollama');
      expect(updated.error_output).toContain('[Local-First] Trying qwen2.5-coder:14b on host');
    });

    it('tries a different coder model when same-host retry is skipped', () => {
      const hostA = registerHealthyHost('model-a', ['qwen2.5-coder:14b', 'deepseek-coder:33b']);
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        ollama_host_id: hostA
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'still failing', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.provider).toBe('ollama');
      expect(updated.model).toBe('deepseek-coder:33b');
      expect(updated.ollama_host_id).toBe(hostA);
      expect(updated.error_output).toContain('[Local-First] Trying model deepseek-coder:33b');
    });

    it('switches to a different local provider when no host/model alternative exists', () => {
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'provider issue', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.provider).toBe('hashline-ollama');
      expect(updated.model).toBe('qwen2.5-coder:14b');
      expect(updated.ollama_host_id).toBeNull();
      expect(updated.error_output).toContain('[Local-First] Trying provider hashline-ollama');
    });

    it('escalates to cloud after max local retries are exhausted', () => {
      db.setConfig('max_local_retries', '1');
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');

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
      const updated = db.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.error_output).toContain('[Local-First] Exhausted 1 local retries');
    });

    it('skips raw ollama when task is greenfield (new file creation)', () => {
      // EXP7: Raw ollama produces instructions instead of code for greenfield tasks
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:14b',
        task_description: 'Create a new test file for the auth module',
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'hashline parse error', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      // Should skip 'ollama' (greenfield) and escalate to cloud since no other local providers
      expect(updated.error_output).not.toContain('[Local-First] Trying provider ollama');
    });

    it('allows raw ollama for non-greenfield tasks', () => {
      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:14b',
        task_description: 'Fix the auth handler validation bug in auth.ts',
        ollama_host_id: null
      });

      const ok = mod.tryLocalFirstFallback(task.id, task, 'provider issue', { skipSameModel: true });

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      // Non-greenfield task should be able to use raw ollama
      expect(updated.provider).toBe('ollama');
    });

    it('keeps moving through the chain when host selection and model enumeration throw', () => {
      db.setConfig('max_local_retries', '3');
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
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
        const updated = db.getTask(task.id);
        expect(updated.provider).toBe('hashline-ollama');
        expect(updated.error_output).toContain('[Local-First] Trying provider hashline-ollama');
      });
    });

    it('escalates to cloud when every local fallback path has already been exhausted', () => {
      db.setConfig('max_local_retries', '5');
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '0');

      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        error_output: [
          '[Local-First] Trying provider hashline-ollama',
        ].join('\n')
      });

      withDbMethods({
        getAggregatedModels: vi.fn(() => []),
      }, () => {
        const ok = mod.tryLocalFirstFallback(task.id, task, 'provider timeout', { skipSameModel: true });

        expect(ok).toBe(true);
        const updated = db.getTask(task.id);
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
        model: 'qwen2.5-coder:14b',
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

      const updated = db.getTask(task.id);
      expect(updated.status).toBe('queued');
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
      expect(updated.error_output).toContain('[STALL RECOVERY] Attempt 1: switch_edit_format');
    });

    it('switches to a larger model when task is already using whole edits', () => {
      const hostA = registerHealthyHost('stall-large-host', ['qwen2.5-coder:14b', 'qwen2.5-coder:32b']);
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
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

      const updated = db.getTask(task.id);
      expect(updated.model).toBe('qwen2.5-coder:32b');
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
      expect(updated.error_output).toContain('[STALL RECOVERY] Attempt 1: switch_model');
    });

    it('falls back to local-first fallback when no larger model is available', () => {
      const hostA = registerHealthyHost('stall-no-larger', ['qwen2.5-coder:70b']);
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:70b',
        ollama_host_id: hostA
      });
      runningProcesses.set(task.id, { editFormat: 'whole' });

      withDbMethods({
        getAggregatedModels: vi.fn(() => [{ name: 'qwen2.5-coder:70b', hosts: [{ status: 'healthy', enabled: 1 }] }]),
      }, () => {
        const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 600 });

        expect(ok).toBe(true);
        expect(restartCalls).toHaveLength(1);
        expect(restartCalls[0].reason).toContain('local_first_fallback');
        expect(stallRecoveryAttempts.get(task.id).attempts).toBe(1);
        expect(stallRecoveryAttempts.get(task.id).lastStrategy).toBe('local_first_fallback');
        expect(db.getTask(task.id).provider).toBe('hashline-ollama');
      });
    });

    it('debounces stall recovery processQueue call via STALL_REQUEUE_DEBOUNCE_MS', () => {
      vi.useFakeTimers();

      try {
        const task = createTask({
          provider: 'ollama',
          model: 'qwen2.5-coder:14b',
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
      db.setConfig('stall_recovery_max_attempts', '1');
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
        model: 'qwen2.5-coder:14b'
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

      const updated = db.getTask(task.id);
      expect(updated.status).toBe('failed');
      expect(updated.error_output).toContain('Stall recovery re-queue failed');
    });

    it('second attempt switches to a larger available model', () => {
      registerHealthyHost('stall-models', ['qwen2.5-coder:14b', 'qwen2.5-coder:32b']);
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
      });
      stallRecoveryAttempts.set(task.id, { attempts: 1, lastStrategy: 'switch_edit_format' });

      const ok = mod.tryStallRecovery(task.id, { lastActivitySeconds: 420 });

      expect(ok).toBe(true);
      expect(restartCalls).toHaveLength(1);
      expect(restartCalls[0].reason).toContain('switch_model');

      const recovery = stallRecoveryAttempts.get(task.id);
      expect(recovery.attempts).toBe(2);
      expect(recovery.lastStrategy).toBe('switch_model');

      const updated = db.getTask(task.id);
      expect(updated.model).toBe('qwen2.5-coder:32b');
      const meta = updated.metadata || {};
      expect(meta.stallRecoveryEditFormat).toBe('whole');
    });

    it('cancels task when maximum stall recovery attempts are exhausted', () => {
      db.setConfig('stall_recovery_max_attempts', '2');
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
      db.setConfig('max_local_retries', '3');
      const task = createTask({
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
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
        expect(db.getTask(task.id).provider).toBe('hashline-ollama');
      });
    });
  });

  describe('findLargerAvailableModel', () => {
    it('returns null when db.getAggregatedModels returns empty array', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => []);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns null when current model is already the largest available', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:70b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:70b')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns the next larger coder model on a healthy host', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:22b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBe('qwen2.5-coder:22b');
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('skips candidates on unhealthy or disabled hosts', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:22b', hosts: [{ status: 'unhealthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 0 }] },
        { name: 'qwen2.5-coder:70b', hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBe('qwen2.5-coder:70b');
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('handles models with unsupported sizes without throwing', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:14b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] }
      ]);

      try {
        expect(() => findLargerAvailableModel('qwen2.5-coder:18b')).not.toThrow();
        expect(findLargerAvailableModel('qwen2.5-coder:18b')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('returns null when current model size cannot be parsed', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] },
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
        { name: 'llama3:70b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:22b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'deepseek-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] },
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBe('qwen2.5-coder:22b');
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('picks the smallest larger model even when model list is unsorted', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:70b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:22b', hosts: [{ status: 'healthy', enabled: 1 }] },
        { name: 'qwen2.5-coder:32b', hosts: [{ status: 'healthy', enabled: 1 }] },
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBe('qwen2.5-coder:22b');
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });

    it('treats models with missing host metadata as available', () => {
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => [
        { name: 'qwen2.5-coder:14b' },
        { name: 'qwen2.5-coder:32b', hosts: [] },
      ]);

      try {
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBe('qwen2.5-coder:32b');
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
        expect(findLargerAvailableModel('qwen2.5-coder:14b')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });
  });

  describe('hashline model helpers', () => {
    it('isHashlineCapableModel honors allowlist and allow-all behavior', () => {
      db.setConfig('hashline_capable_models', 'qwen2.5-coder,codestral:22b');
      expect(mod.isHashlineCapableModel('qwen2.5-coder:7b')).toBe(true);
      expect(mod.isHashlineCapableModel('phi3:3b')).toBe(false);

      db.setConfig('hashline_capable_models', '');
      expect(mod.isHashlineCapableModel('phi3:3b')).toBe(true);
    });

    it('findNextHashlineModel prefers the smallest larger untried model', () => {
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const hostId = registerHealthyHost('hashline-next', [
        'qwen2.5-coder:7b',
        'qwen2.5-coder:14b',
        'qwen2.5-coder:32b'
      ]);

      const next = mod.findNextHashlineModel('qwen2.5-coder:7b', '');
      expect(next).toEqual({ name: 'qwen2.5-coder:14b', hostId });
    });

    it('findNextHashlineModel falls back to largest untried capable model when none are larger', () => {
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const hostId = registerHealthyHost('hashline-fallback', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']);

      const next = mod.findNextHashlineModel(
        'qwen2.5-coder:32b',
        '[Hashline-Local] Trying model qwen2.5-coder:14b'
      );
      expect(next).toEqual({ name: 'qwen2.5-coder:7b', hostId });
    });

    it('findNextHashlineModel returns null when model discovery throws', () => {
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const originalGetAggregatedModels = db.getAggregatedModels;
      db.getAggregatedModels = vi.fn(() => {
        throw new Error('hashline registry offline');
      });

      try {
        expect(mod.findNextHashlineModel('qwen2.5-coder:7b', '')).toBeNull();
      } finally {
        db.getAggregatedModels = originalGetAggregatedModels;
      }
    });
  });

  describe('tryHashlineTieredFallback', () => {
    it('retries same model on a different host before cloud escalation', () => {
      db.setConfig('max_hashline_local_retries', '2');
      const hostA = registerHealthyHost('hashline-a', ['qwen2.5-coder:14b'], { running_tasks: 2 });
      const hostB = registerHealthyHost('hashline-b', ['qwen2.5-coder:14b'], { running_tasks: 0 });

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:14b',
        ollama_host_id: hostA
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.provider).toBe('hashline-ollama');
      expect(updated.model).toBe('qwen2.5-coder:14b');
      expect(updated.ollama_host_id).toBe(hostB);
      expect(updated.error_output).toContain('[Hashline-Local] Trying qwen2.5-coder:14b on host');
    });

    it('skips host switching when the task is already known not hashline-capable', () => {
      db.setConfig('max_hashline_local_retries', '2');
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const host = registerHealthyHost('hashline-single', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']);

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        ollama_host_id: host
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'not hashline-capable output format invalid');

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.model).toBe('qwen2.5-coder:14b');
      expect(updated.ollama_host_id).toBe(host);
      expect(updated.error_output).toContain('[Hashline-Local] Trying model qwen2.5-coder:14b');
    });

    it('tries an untried larger hashline model when prior model was already attempted', () => {
      db.setConfig('max_hashline_local_retries', '2');
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const host = registerHealthyHost('hashline-history', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen2.5-coder:32b']);

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        ollama_host_id: host,
        error_output: '[Hashline-Local] Trying model qwen2.5-coder:14b'
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'stale response');

      expect(ok).toBe(true);
      const updated = db.getTask(task.id);
      expect(updated.model).toBe('qwen2.5-coder:32b');
      expect(updated.error_output).toContain('[Hashline-Local] Trying model qwen2.5-coder:32b');
    });

    it('falls back to a larger model when only one host is available', () => {
      db.setConfig('max_hashline_local_retries', '1');
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const host = registerHealthyHost('hashline-alone', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']);

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        ollama_host_id: host
      });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'hashline parsing failed');
      expect(ok).toBe(true);

      const updated = db.getTask(task.id);
      expect(updated.provider).toBe('hashline-ollama');
      expect(updated.model).toBe('qwen2.5-coder:14b');
      expect(updated.error_output).toContain('[Hashline-Local] Trying model qwen2.5-coder:14b');
    });

    it('keeps escalating locally when same-model host selection fails with a timeout', () => {
      db.setConfig('max_hashline_local_retries', '2');
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      const host = registerHealthyHost('hashline-timeout', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']);

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
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
        const updated = db.getTask(task.id);
        expect(updated.provider).toBe('hashline-ollama');
        expect(updated.model).toBe('qwen2.5-coder:14b');
        expect(updated.error_output).toContain('[Hashline-Local] Trying model qwen2.5-coder:14b');
      });
    });

    it('falls back to codex when cloud escalation is unavailable', () => {
      db.setConfig('max_hashline_local_retries', '1');
      db.setConfig('hashline_capable_models', 'qwen2.5-coder');
      db.getProvider = () => ({ enabled: false });
      delete process.env.OPENAI_API_KEY;

      const host = registerHealthyHost('hashline-no-openai', ['qwen2.5-coder:7b', 'qwen2.5-coder:14b']);
      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        ollama_host_id: host
      });

      const first = mod.tryHashlineTieredFallback(task.id, task, 'local retry');
      expect(first).toBe(true);
      let updated = db.getTask(task.id);
      expect(updated.model).toBe('qwen2.5-coder:14b');

      const second = mod.tryHashlineTieredFallback(task.id, db.getTask(task.id), 'still failing');
      expect(second).toBe(true);
      updated = db.getTask(task.id);
      expect(updated.provider).toBe('codex');
      expect(updated.model).toBeNull();
      expect(updated.error_output).toContain('Escalated from hashline-ollama: still failing');
    });

    it('skips fallback when task is already cancelled', () => {
      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b'
      });
      // Manually set task to cancelled state
      db.updateTaskStatus(task.id, 'cancelled', {});

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'connection timeout');

      expect(ok).toBe(false);
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('cancelled');
      expect(updated.provider).toBe('hashline-ollama'); // unchanged
    });

    it('skips fallback when task is already completed', () => {
      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b'
      });
      db.updateTaskStatus(task.id, 'running', {});
      db.updateTaskStatus(task.id, 'completed', { exit_code: 0 });

      const ok = mod.tryHashlineTieredFallback(task.id, task, 'stale error');

      expect(ok).toBe(false);
      const updated = db.getTask(task.id);
      expect(updated.status).toBe('completed');
    });
  });

  describe('full triggerFallback flow', () => {
    it('drives local-first fallback through provider switch then cloud escalation', () => {
      // Each call adds one [Local-First] marker to error_output.
      // With max_local_retries=1, the first call gets one local retry,
      // and the second call sees 1 marker >= max(1) and escalates to cloud.
      db.setConfig('max_local_retries', '1');
      db.setConfig('ollama_fallback_provider', 'codex');
      db.setConfig('codex_enabled', '1');
      db.setConfig('claude_cli_enabled', '1');
      // Single host, no model alternatives: step 1 (host switch) and step 2 (model switch)
      // both fail, forcing step 3 (provider switch) on the first call.
      const hostA = registerHealthyHost('full-a', ['qwen2.5-coder:14b']);

      withDbMethods({
        getAggregatedModels: vi.fn(() => []),
      }, () => {
        const task = createTask({
          provider: 'ollama',
          model: 'qwen2.5-coder:14b',
          ollama_host_id: hostA
        });

        // Call 1: step 1 fails (only one host). Step 2 fails (no models).
        // Step 3: switch to different local provider (hashline-ollama).
        const first = mod.tryLocalFirstFallback(task.id, db.getTask(task.id), 'first local failure');
        expect(first).toBe(true);
        const afterFirst = db.getTask(task.id);
        expect(afterFirst.provider).toBe('hashline-ollama');
        expect(afterFirst.error_output).toContain('[Local-First] Trying provider hashline-ollama');

        // Call 2: 1 [Local-First] marker >= max_local_retries(1), escalates to cloud.
        const second = mod.tryLocalFirstFallback(task.id, db.getTask(task.id), 'second local failure');
        expect(second).toBe(true);
        const afterSecond = db.getTask(task.id);
        expect(afterSecond.provider).toBe('codex');
        expect(afterSecond.model).toBeNull();
        expect(afterSecond.error_output).toContain('[Local-First] Exhausted 1 local retries');
      });
    });

  });

  describe('selectHashlineFormat', () => {
    it('uses task metadata override before model config override', () => {
      db.setConfig('hashline_model_formats', JSON.stringify({
        'qwen2.5-coder:7b': 'hashline-lite',
        qwen2_5_coder: 'hashline-lite'
      }));
      const task = {
        metadata: JSON.stringify({ hashline_format_override: 'hashline' })
      };

      const selected = mod.selectHashlineFormat('qwen2.5-coder:7b', task);

      expect(selected).toEqual({ format: 'hashline', reason: 'fallback_override' });
    });

    it('uses exact and base-model config overrides before auto-selection', () => {
      db.setConfig('hashline_model_formats', JSON.stringify({
        'qwen2.5-coder:14b': 'hashline-lite',
        'deepseek-coder': 'hashline-lite'
      }));

      expect(mod.selectHashlineFormat('qwen2.5-coder:14b', null)).toEqual({
        format: 'hashline-lite',
        reason: 'config_override'
      });
      expect(mod.selectHashlineFormat('deepseek-coder:33b', null)).toEqual({
        format: 'hashline-lite',
        reason: 'config_override_base'
      });
    });

    it('forces standard hashline when the model has repeated format failures', () => {
      db.setConfig('hashline_model_formats', '{}');
      db.setConfig('hashline_format_auto_select', '0');
      db.getModelFormatFailures = vi.fn(() => ([
        { model_name: 'qwen2.5-coder', failure_count: 2 },
        { model_name: 'qwen2.5-coder:14b', failure_count: 1 },
      ]));

      expect(mod.selectHashlineFormat('qwen2.5-coder:14b', null)).toEqual({
        format: 'whole',
        reason: 'auto_learned (3 hashline failures → whole)'
      });
    });

    it('falls back to the default format when auto-learn checks fail', () => {
      db.setConfig('hashline_model_formats', '{}');
      db.setConfig('hashline_format_auto_select', '0');
      db.getModelFormatFailures = vi.fn(() => {
        throw new Error('telemetry store unavailable');
      });

      expect(mod.selectHashlineFormat('qwen2.5-coder:14b', null)).toEqual({
        format: 'hashline',
        reason: 'default'
      });
    });

    it('uses auto-routing when enabled and falls back to default when no recommendation exists', () => {
      db.setConfig('hashline_model_formats', '{}');
      db.setConfig('hashline_format_auto_select', '1');
      db.getBestFormatForModel = () => ({ format: 'hashline-lite', reason: 'lite_outperforms' });

      const auto = mod.selectHashlineFormat('qwen2.5-coder:14b', null);
      expect(auto).toEqual({ format: 'hashline-lite', reason: 'auto_lite_outperforms' });

      db.getBestFormatForModel = () => ({ format: null, reason: 'insufficient_data' });
      const fallback = mod.selectHashlineFormat('qwen2.5-coder:14b', null);
      expect(fallback).toEqual({ format: 'hashline', reason: 'default' });
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
});

describe('scheduleProcessQueue debouncing', () => {
  it('debounces rapid tryHashlineTieredFallback calls into one processQueue run', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      // Full setup with fake timers active so setTimeout is properly intercepted
      setup();

      db.setConfig('max_hashline_local_retries', '0');
      db.getProvider = () => ({ enabled: false });
      delete process.env.OPENAI_API_KEY;

      const task = createTask({
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
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
