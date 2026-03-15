'use strict';

const http = require('http');
const os = require('os');
function makeQueuedTask(overrides = {}) {
  return {
    id: overrides.id || 'queued-task-1',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'mistral:7b',
    task_description: overrides.task_description || 'Queued task',
    priority: overrides.priority || 0,
    metadata: overrides.metadata || null,
    ...overrides,
  };
}

function loadQueueSchedulerHarness({
  underPressure = false,
  pressureLevel = underPressure ? 'high' : 'none',
  resourceGatingEnabled = true,
} = {}) {
  vi.resetModules();
  const loggerModule = require('../logger');
  const warnSpy = vi.spyOn(loggerModule.Logger.prototype, 'warn').mockImplementation(() => {});

  vi.doMock('../providers/registry', () => ({
    getProviderInstance: vi.fn(() => ({})),
    getCategory(provider) {
      if (['codex', 'claude-cli'].includes(provider)) return 'codex';
      if (['anthropic', 'groq', 'hyperbolic', 'deepinfra', 'hashline-openai', 'ollama-cloud', 'cerebras', 'google-ai', 'openrouter'].includes(provider)) {
        return 'api';
      }
      return 'ollama';
    },
  }));

  const scheduler = require('../execution/queue-scheduler');
  const gpuMetrics = require('../scripts/gpu-metrics-server');
  vi.spyOn(gpuMetrics, 'isUnderPressure').mockReturnValue(underPressure);
  vi.spyOn(gpuMetrics, 'getPressureLevel').mockReturnValue(pressureLevel);
  const queuedTask = makeQueuedTask();
  const mockDb = {
    getRunningCount: vi.fn(() => 0),
    getConfig: vi.fn((key) => {
      if (key === 'resource_gating_enabled') return resourceGatingEnabled ? '1' : '0';
      return null;
    }),
    prepare: vi.fn(),
    listTasks: vi.fn((options = {}) => {
      if (options.status === 'queued') return [queuedTask];
      if (options.status === 'running') return [];
      return [];
    }),
    selectOllamaHostForModel: vi.fn(() => ({
      host: { id: 'host-1', name: 'host-1', running_tasks: 0 },
      atCapacity: false,
    })),
    updateTaskStatus: vi.fn(),
    getNextQueuedTask: vi.fn(() => queuedTask),
    resetExpiredBudgets: vi.fn(),
    checkApprovalRequired: vi.fn(() => ({ required: false, status: 'not_required' })),
  };
  const safeStartTask = vi.fn(() => true);

  scheduler.init({
    db: mockDb,
    safeStartTask,
    safeConfigInt: vi.fn((key, defaultValue) => {
      if (key === 'max_concurrent') return 10;
      if (key === 'max_ollama_concurrent') return 8;
      if (key === 'max_codex_concurrent') return 6;
      if (key === 'max_api_concurrent') return 4;
      if (key === 'max_per_host') return 4;
      return defaultValue;
    }),
    isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    getProviderInstance: vi.fn(() => ({})),
    cleanupOrphanedRetryTimeouts: vi.fn(),
  });

  return {
    scheduler,
    safeStartTask,
    warnSpy,
    processQueue(options = {}) {
      return scheduler.processQueueInternal({ skipRecentProcessGuard: true, ...options });
    },
  };
}

async function setupTaskManagerHarness({
  pressureLevel = 'none',
  underPressure = pressureLevel === 'high' || pressureLevel === 'critical',
  resourceGatingEnabled = true,
} = {}) {
  vi.resetModules();
  const loggerModule = require('../logger');
  const warnSpy = vi.spyOn(loggerModule.Logger.prototype, 'warn').mockImplementation(() => {});
  const actualDelegations = await vi.importActual('../task-manager-delegations');
  const executeOllamaTaskMock = vi.fn((task) => ({ queued: false, task }));
  vi.doMock('../task-manager-delegations', () => ({
    ...actualDelegations,
    executeOllamaTask: executeOllamaTaskMock,
  }));

  const helpers = require('./e2e-helpers');
  const ctx = helpers.setupE2eDb('resource-gating');
  const gpuMetrics = require('../scripts/gpu-metrics-server');
  vi.spyOn(gpuMetrics, 'isUnderPressure').mockReturnValue(underPressure);
  vi.spyOn(gpuMetrics, 'getPressureLevel').mockReturnValue(pressureLevel);
  ctx.db.setConfig('max_concurrent', '10');
  ctx.db.setConfig('resource_gating_enabled', resourceGatingEnabled ? '1' : '0');
  ctx.tm._testing.resetForTest();
  ctx.tm._testing.skipGitInCloseHandler = true;

  return {
    ...ctx,
    helpers,
    executeOllamaTaskMock,
    warnSpy,
  };
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
  });
}

describe('resource gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    delete process.env.OPENAI_API_KEY;
  });

  describe('queue scheduler', () => {
    it('defers tasks when under pressure', () => {
      const harness = loadQueueSchedulerHarness({ underPressure: true, pressureLevel: 'high' });

      harness.processQueue();

      expect(harness.safeStartTask).not.toHaveBeenCalled();
      expect(harness.warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Deferring queued task starts due to high resource pressure')
      );

      harness.scheduler.stop();
    });

    it('starts tasks normally when not under pressure', () => {
      const harness = loadQueueSchedulerHarness({ underPressure: false, pressureLevel: 'none' });

      harness.processQueue();

      expect(harness.safeStartTask).toHaveBeenCalledWith('queued-task-1', 'ollama');
      harness.scheduler.stop();
    });

    it('allows queued task starts when resource gating is disabled', () => {
      const harness = loadQueueSchedulerHarness({
        underPressure: true,
        pressureLevel: 'critical',
        resourceGatingEnabled: false,
      });

      harness.processQueue();

      expect(harness.safeStartTask).toHaveBeenCalledWith('queued-task-1', 'ollama');
      expect(harness.warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Deferring queued task starts due to')
      );

      harness.scheduler.stop();
    });
  });

  describe('startTask', () => {
    let ctx = null;

    afterEach(async () => {
      try {
        require('../execution/queue-scheduler').stop();
      } catch { /* ignore */ }
      if (ctx) {
        await ctx.helpers.teardownE2eDb(ctx);
        ctx = null;
      }
    });

    it('rejects task starts at critical pressure', async () => {
      process.env.OPENAI_API_KEY = 'test-openai-key';
      ctx = await setupTaskManagerHarness({ pressureLevel: 'critical' });
      const taskId = ctx.helpers.createTestTask(ctx.db, {
        description: 'Critical pressure task',
        provider: 'ollama',
        workingDirectory: ctx.testDir,
      });

      expect(() => ctx.tm.startTask(taskId)).toThrow(/critical/i);
      expect(ctx.executeOllamaTaskMock).not.toHaveBeenCalled();
    });

    it('proceeds with a warning at high pressure', async () => {
      ctx = await setupTaskManagerHarness({ pressureLevel: 'high' });
      const taskId = ctx.helpers.createTestTask(ctx.db, {
        description: 'High pressure task',
        provider: 'ollama',
        workingDirectory: ctx.testDir,
      });

      expect(() => ctx.tm.startTask(taskId)).not.toThrow();
      expect(ctx.warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Starting task ${taskId} under high resource pressure`)
      );
      expect(ctx.db.getTask(taskId).status).not.toBe('pending');
    });
  });

  describe('/metrics', () => {
    let mod;
    let originalCpus;
    let originalLoadavg;
    let originalTotalmem;
    let originalFreemem;
    let originalMemoryUsage;
    let cpuSampleIndex;
    let cpuSamples;

    beforeEach(() => {
      originalCpus = os.cpus;
      originalLoadavg = os.loadavg;
      originalTotalmem = os.totalmem;
      originalFreemem = os.freemem;
      originalMemoryUsage = process.memoryUsage;

      cpuSampleIndex = 0;
      cpuSamples = [
        [
          { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
          { times: { user: 200, nice: 0, sys: 0, idle: 800, irq: 0 } },
        ],
        [
          { times: { user: 130, nice: 0, sys: 0, idle: 970, irq: 0 } },
          { times: { user: 260, nice: 0, sys: 0, idle: 840, irq: 0 } },
        ],
      ];

      os.cpus = () => {
        const index = Math.min(cpuSampleIndex, cpuSamples.length - 1);
        cpuSampleIndex += 1;
        return cpuSamples[index];
      };
      os.loadavg = () => [1.25, 0.75, 0.5];
      os.totalmem = () => 16 * 1024;
      os.freemem = () => 4 * 1024;
      process.memoryUsage = () => ({
        rss: 512 * 1024,
        heapUsed: 128 * 1024,
        heapTotal: 256 * 1024,
      });

      mod = require('../scripts/gpu-metrics-server');
    });

    afterEach(() => {
      os.cpus = originalCpus;
      os.loadavg = originalLoadavg;
      os.totalmem = originalTotalmem;
      os.freemem = originalFreemem;
      process.memoryUsage = originalMemoryUsage;
      mod.stop();
    });

    it('includes the current pressure level in the metrics response', async () => {
      await mod.refreshMetrics();
      const server = mod.createServer();

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const address = server.address();
        const { statusCode, body } = await getJson(address.port, '/metrics');

        expect(statusCode).toBe(200);
        expect(body.pressureLevel).toBe('moderate');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
