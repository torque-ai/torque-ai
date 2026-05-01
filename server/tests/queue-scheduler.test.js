/**
 * Unit Tests: execution/queue-scheduler.js
 *
 * Tests task categorization and the processQueueInternal scheduler logic
 * including VRAM-aware scheduling, P71/P92 fallback, and provider routing.
 * All dependencies are mocked via init().
 */
const { TEST_MODELS } = require('./test-helpers');

// Provider registry mock — getCategory is used by categorizeQueuedTasks, not hoisted
vi.mock('../providers/registry', () => {
  const cats = {
    ollama: 'ollama',
    codex: 'codex', 'claude-cli': 'codex',
    anthropic: 'api', groq: 'api', hyperbolic: 'api',
    deepinfra: 'api', 'ollama-cloud': 'api', cerebras: 'api', 'google-ai': 'api', openrouter: 'api',
  };
  return {
    getProviderInstance: vi.fn().mockReturnValue({}),
    getCategory: (p) => cats[p] || null,
    listProviders: vi.fn().mockReturnValue([]),
    getProviderConfig: vi.fn(),
  };
});

describe('Queue Scheduler', () => {
  let scheduler;
  let mockDb;
  let mocks;

  beforeEach(() => {
    // Clear module cache for fresh singleton state
    const modPath = require.resolve('../execution/queue-scheduler');
    delete require.cache[modPath];
    scheduler = require('../execution/queue-scheduler');

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      prepare: vi.fn().mockImplementation((sql) => {
        // Wire configCore.getConfig() to use mockDb.getConfig()
        if (sql.includes('SELECT value FROM config')) {
          return { get: (key) => {
            const val = mockDb.getConfig(key);
            return val != null ? { value: val } : undefined;
          }};
        }
        return { all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() };
      }),
      getExpiredQueuedTasks: vi.fn().mockReturnValue([]),
      listTasks: vi.fn().mockReturnValue([]),
      listOllamaHosts: vi.fn().mockReturnValue([]),
      getConfig: vi.fn().mockReturnValue(null),
      selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
      updateTaskStatus: vi.fn(),
      getNextQueuedTask: vi.fn().mockReturnValue(null),
      resetExpiredBudgets: vi.fn(),
      checkApprovalRequired: vi.fn().mockReturnValue({ required: false, status: 'not_required', rule: null }),
    };

    // Wire configCore to use mockDb so serverConfig.get() can read test config values
    const configCore = require('../db/config-core');
    configCore.setDb(mockDb);
    configCore.clearConfigCache();

    mocks = {
      safeStartTask: vi.fn().mockReturnValue(true),
      safeConfigInt: vi.fn().mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        return defaultVal;
      }),
      isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
      getProviderInstance: vi.fn().mockReturnValue({}),
      cleanupOrphanedRetryTimeouts: vi.fn(),
      notifyDashboard: vi.fn(),
    };

    scheduler.init({
      db: mockDb,
      ...mocks,
    });

    const originalProcessQueueInternal = scheduler.processQueueInternal;
    scheduler.processQueueInternal = (options = {}) => originalProcessQueueInternal({
      skipRecentProcessGuard: true,
      ...options,
    });
  });

  afterEach(() => {
    const configCore = require('../db/config-core');
    configCore.clearConfigCache();
    configCore.setDb(null);
    vi.restoreAllMocks();
  });

  describe('event-driven processing', () => {
    it('triggers processQueueInternal from torque:queue-changed event after debounce', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(mockDb, 'listTasks');
      try {
        mockDb.getRunningCount.mockReturnValue(0);
        mockDb.listTasks.mockReturnValue([]);

        process.emit('torque:queue-changed');
        process.emit('torque:queue-changed');
        vi.advanceTimersByTime(100);

        expect(spy.mock.calls.filter(([args]) => args?.status === 'queued')).toHaveLength(1);

        process.emit('torque:queue-changed');
        vi.advanceTimersByTime(100);
        expect(spy.mock.calls.filter(([args]) => args?.status === 'queued')).toHaveLength(2);
      } finally {
        spy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('bypasses the recent-process guard for torque:queue-changed passes', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(mockDb, 'listTasks');
      try {
        mockDb.getRunningCount.mockReturnValue(0);
        mockDb.listTasks.mockReturnValue([]);

        process.emit('torque:queue-changed');
        vi.advanceTimersByTime(60);
        scheduler.processQueueInternal();
        vi.advanceTimersByTime(40);

        expect(spy.mock.calls.filter(([args]) => args?.status === 'queued')).toHaveLength(2);
      } finally {
        spy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('replaces stale torque:queue-changed listeners across module reloads', () => {
      const baselineListenerCount = process.listenerCount('torque:queue-changed');
      const modPath = require.resolve('../execution/queue-scheduler');

      delete require.cache[modPath];
      const reloadedScheduler = require('../execution/queue-scheduler');

      reloadedScheduler.init({
        db: mockDb,
        ...mocks,
      });

      expect(process.listenerCount('torque:queue-changed')).toBe(baselineListenerCount);
      reloadedScheduler.stop();
    });
  });

  // ── Helper ────────────────────────────────────────────────

  function makeTask(overrides = {}) {
    return {
      id: overrides.id || 'task-' + Math.random().toString(36).slice(2, 10),
      provider: overrides.provider || 'ollama',
      model: overrides.model || 'mistral:7b',
      task_description: overrides.task_description || 'Test task',
      metadata: overrides.metadata || null,
      ...overrides,
    };
  }

  // ── categorizeQueuedTasks ─────────────────────────────────

  describe('categorizeQueuedTasks', () => {
    it('maps all ollama aliases to ollamaTasks', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'ollama' }),
        makeTask({ id: '2', provider: 'ollama' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks.map((t) => t.id)).toEqual(['1', '2']);
      expect(result.ollamaTasks).toHaveLength(2);
    });

    it('maps all API providers to apiTasks', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'anthropic' }),
        makeTask({ id: '2', provider: 'groq' }),
        makeTask({ id: '3', provider: 'hyperbolic' }),
        makeTask({ id: '4', provider: 'deepinfra' }),
        makeTask({ id: '5', provider: 'ollama-cloud' }),
        makeTask({ id: '6', provider: 'cerebras' }),
        makeTask({ id: '7', provider: 'google-ai' }),
        makeTask({ id: '8', provider: 'openrouter' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.apiTasks.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      expect(result.apiTasks).toHaveLength(8);
    });

    it('preserves original queue order in each category', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'ollama' }),
        makeTask({ id: '2', provider: 'anthropic' }),
        makeTask({ id: '3', provider: 'codex' }),
        makeTask({ id: '4', provider: 'groq' }),
        makeTask({ id: '5', provider: 'ollama' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks.map((t) => t.id)).toEqual(['1', '5']);
      expect(result.apiTasks.map((t) => t.id)).toEqual(['2', '4']);
      expect(result.codexTasks.map((t) => t.id)).toEqual(['3']);
    });

    it('ignores codex-pending tasks even when codex is enabled', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex-pending' }),
        makeTask({ id: '2', provider: 'codex' }),
        makeTask({ id: '3', provider: 'claude-cli' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks).toHaveLength(0);
      expect(result.codexTasks.map((t) => t.id)).toEqual(['2', '3']);
      expect(result.apiTasks).toHaveLength(0);
    });

    it('returns empty buckets for empty input', () => {
      const result = scheduler.categorizeQueuedTasks([], true);

      expect(result.ollamaTasks).toEqual([]);
      expect(result.codexTasks).toEqual([]);
      expect(result.apiTasks).toEqual([]);
    });

    it('separates ollama/codex/api tasks correctly', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'ollama' }),
        makeTask({ id: '2', provider: 'ollama' }),
        makeTask({ id: '3', provider: 'codex' }),
        makeTask({ id: '4', provider: 'claude-cli' }),
        makeTask({ id: '5', provider: 'anthropic' }),
        makeTask({ id: '6', provider: 'groq' }),
        makeTask({ id: '7', provider: 'hyperbolic' }),
        makeTask({ id: '8', provider: 'deepinfra' }),
        makeTask({ id: '9', provider: 'ollama-cloud' }),
        makeTask({ id: '10', provider: 'cerebras' }),
        makeTask({ id: '11', provider: 'google-ai' }),
        makeTask({ id: '12', provider: 'openrouter' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks).toHaveLength(2);
      expect(result.ollamaTasks.map((t) => t.id)).toEqual(['1', '2']);

      expect(result.codexTasks).toHaveLength(2);
      expect(result.codexTasks.map((t) => t.id)).toEqual(['3', '4']);

      expect(result.apiTasks).toHaveLength(8);
      expect(result.apiTasks.map((t) => t.id)).toEqual(['5', '6', '7', '8', '9', '10', '11', '12']);
    });

    it('filters codex-pending tasks', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex-pending' }),
        makeTask({ id: '2', provider: 'ollama' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks).toHaveLength(1);
      expect(result.codexTasks).toHaveLength(0);
      expect(result.apiTasks).toHaveLength(0);
    });

    it('claude-cli goes to codexTasks', () => {
      const tasks = [makeTask({ id: '1', provider: 'claude-cli' })];
      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.codexTasks).toHaveLength(1);
      expect(result.codexTasks[0].id).toBe('1');
    });

    it('codex tasks excluded when codexEnabled=false', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex' }),
        makeTask({ id: '2', provider: 'claude-cli' }),
        makeTask({ id: '3', provider: 'ollama' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, false);

      // codex excluded, but claude-cli is always included
      expect(result.codexTasks).toHaveLength(1);
      expect(result.codexTasks[0].id).toBe('2');
      expect(result.ollamaTasks).toHaveLength(1);
    });

    it('surfaces unknown providers as invalidTasks', () => {
      const tasks = [makeTask({ id: '1', provider: 'mystery-provider' })];
      const result = scheduler.categorizeQueuedTasks(tasks, true);

      expect(result.ollamaTasks).toHaveLength(0);
      expect(result.invalidTasks).toHaveLength(1);
      expect(result.invalidTasks[0].id).toBe('1');
    });

    it('user-override codex tasks kept in codexTasks when codex disabled (BUG-001)', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex', metadata: JSON.stringify({ user_provider_override: true }) }),
        makeTask({ id: '2', provider: 'codex' }), // no override — should be dropped
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, false);

      // User-override task kept, non-override dropped
      expect(result.codexTasks).toHaveLength(1);
      expect(result.codexTasks[0].id).toBe('1');
    });

    it('template-bound codex tasks kept in codexTasks when codex disabled', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex', metadata: JSON.stringify({ _routing_template: 'dlphone-template' }) }),
        makeTask({ id: '2', provider: 'codex' }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, false);

      expect(result.codexTasks).toHaveLength(1);
      expect(result.codexTasks[0].id).toBe('1');
    });

    it('codex tasks without user_provider_override are dropped when codex disabled', () => {
      const tasks = [
        makeTask({ id: '1', provider: 'codex', metadata: JSON.stringify({ requested_provider: 'codex' }) }),
      ];

      const result = scheduler.categorizeQueuedTasks(tasks, false);

      // requested_provider alone does NOT keep tasks — only user_provider_override does
      expect(result.codexTasks).toHaveLength(0);
    });
  });

  describe('prioritizeCodexProjectWork', () => {
    it('keeps active factory plan work ahead of architect and scout maintenance', () => {
      const ordered = scheduler.prioritizeCodexProjectWork([
        makeTask({
          id: 'architect',
          provider: 'codex',
          tags: JSON.stringify(['factory:internal', 'factory:architect_cycle']),
        }),
        makeTask({
          id: 'scout',
          provider: 'codex',
          tags: JSON.stringify(['factory:internal', 'factory:scout', 'factory:starvation_recovery']),
        }),
        makeTask({
          id: 'plan-generation',
          provider: 'codex',
          tags: JSON.stringify(['factory:internal', 'factory:plan_generation']),
        }),
        makeTask({
          id: 'project-exec',
          provider: 'codex',
          tags: JSON.stringify(['factory:batch_id=batch-1', 'project:NetSim']),
        }),
      ]);

      expect(ordered.map(task => task.id)).toEqual([
        'project-exec',
        'plan-generation',
        'architect',
        'scout',
      ]);
    });
  });

  describe('filterSupersededFactoryInternalTasks', () => {
    it('defers stale same-project architect work behind newer plan generation', () => {
      const queued = [
        makeTask({
          id: 'old-architect',
          status: 'queued',
          created_at: '2026-05-01T20:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=project-a',
          ]),
        }),
        makeTask({
          id: 'new-plan',
          status: 'queued',
          created_at: '2026-05-01T21:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:plan_generation',
            'factory:project_id=project-a',
          ]),
        }),
      ];

      const filtered = scheduler.filterSupersededFactoryInternalTasks(queued, []);

      expect(filtered.map(task => task.id)).toEqual(['new-plan']);
    });

    it('defers stale same-project architect work behind active project execution parsed from batch id', () => {
      const projectId = 'a1e8a728-c98c-46ad-b34f-772cd149572a';
      const queued = [
        makeTask({
          id: 'old-architect',
          status: 'queued',
          created_at: '2026-05-01T20:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            `factory:project_id=${projectId}`,
          ]),
        }),
      ];
      const running = [
        makeTask({
          id: 'active-execute',
          status: 'running',
          created_at: '2026-05-01T21:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            `factory:batch_id=factory-${projectId}-2190`,
            'factory:work_item_id=2190',
            'project:NetSim',
          ]),
        }),
      ];

      const filtered = scheduler.filterSupersededFactoryInternalTasks(queued, running);

      expect(filtered).toEqual([]);
    });

    it('keeps replan work after a newer plan-generation task is already terminal', () => {
      const queued = [
        makeTask({
          id: 'replan',
          status: 'queued',
          created_at: '2026-05-01T20:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:replan_rewrite',
            'factory:project_id=project-a',
          ]),
        }),
      ];
      const completedPlan = [
        makeTask({
          id: 'completed-plan',
          status: 'completed',
          created_at: '2026-05-01T21:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:plan_generation',
            'factory:project_id=project-a',
          ]),
        }),
      ];

      const filtered = scheduler.filterSupersededFactoryInternalTasks(queued, completedPlan);

      expect(filtered.map(task => task.id)).toEqual(['replan']);
    });

    it('keeps only the newest queued same-project maintenance task of a kind', () => {
      const queued = [
        makeTask({
          id: 'old-architect',
          status: 'queued',
          created_at: '2026-05-01T20:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=project-a',
          ]),
        }),
        makeTask({
          id: 'new-architect',
          status: 'queued',
          created_at: '2026-05-01T21:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=project-a',
          ]),
        }),
      ];

      const filtered = scheduler.filterSupersededFactoryInternalTasks(queued, []);

      expect(filtered.map(task => task.id)).toEqual(['new-architect']);
    });

    it('defers queued same-project maintenance when one of the same kind is already running', () => {
      const queued = [
        makeTask({
          id: 'queued-architect',
          status: 'queued',
          created_at: '2026-05-01T21:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=project-a',
          ]),
        }),
      ];
      const running = [
        makeTask({
          id: 'running-architect',
          status: 'running',
          created_at: '2026-05-01T20:00:00.000Z',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=project-a',
          ]),
        }),
      ];

      const filtered = scheduler.filterSupersededFactoryInternalTasks(queued, running);

      expect(filtered).toEqual([]);
    });
  });

  describe('filterPausedFactoryProjectTasks', () => {
    it('defers queued factory tasks for paused projects', () => {
      mockDb.getDbInstance = vi.fn(() => ({
        prepare: vi.fn(() => ({
          get: vi.fn((projectId) => (
            projectId === 'paused-project'
              ? { status: 'paused' }
              : { status: 'running' }
          )),
        })),
      }));

      const queued = [
        makeTask({
          id: 'paused-architect',
          status: 'queued',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=paused-project',
          ]),
        }),
        makeTask({
          id: 'running-architect',
          status: 'queued',
          provider: 'codex',
          tags: JSON.stringify([
            'factory:internal',
            'factory:architect_cycle',
            'factory:project_id=running-project',
          ]),
        }),
      ];

      const filtered = scheduler.filterPausedFactoryProjectTasks(queued);

      expect(filtered.map(task => task.id)).toEqual(['running-architect']);
    });
  });

  // ── processQueueInternal ──────────────────────────────────

  describe('processQueueInternal', () => {
    it('delegates queue processing to slot-pull scheduler when scheduling_mode is slot-pull', () => {
      const slotPullPath = require.resolve('../execution/slot-pull-scheduler');
      const queueSchedulerPath = require.resolve('../execution/queue-scheduler');
      const originalSlotPullModule = require.cache[slotPullPath];
      const onSlotFreed = vi.fn();

      try {
        require.cache[slotPullPath] = {
          id: slotPullPath,
          filename: slotPullPath,
          loaded: true,
          exports: { onSlotFreed },
        };

        delete require.cache[queueSchedulerPath];
        const gatedScheduler = require('../execution/queue-scheduler');
        gatedScheduler.init({
          db: {
            ...mockDb,
            getConfig: vi.fn((key) => (key === 'scheduling_mode' ? 'slot-pull' : null)),
          },
          ...mocks,
        });

        gatedScheduler.processQueueInternal({ skipRecentProcessGuard: true });

        expect(onSlotFreed).toHaveBeenCalledTimes(1);
      } finally {
        delete require.cache[queueSchedulerPath];
        if (originalSlotPullModule) {
          require.cache[slotPullPath] = originalSlotPullModule;
        } else {
          delete require.cache[slotPullPath];
        }
      }

      expect(mockDb.listTasks).not.toHaveBeenCalled();
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('does not start a stale queued architect task when a newer completed plan-generation signal exists', () => {
      const staleArchitect = makeTask({
        id: 'old-architect',
        status: 'queued',
        provider: 'codex',
        created_at: '2026-05-01T20:00:00.000Z',
        tags: JSON.stringify([
          'factory:internal',
          'factory:architect_cycle',
          'factory:project_id=project-a',
        ]),
      });
      const completedPlan = {
        id: 'new-plan',
        status: 'completed',
        created_at: '2026-05-01T21:00:00.000Z',
        tags: JSON.stringify([
          'factory:internal',
          'factory:plan_generation',
          'factory:project_id=project-a',
        ]),
        metadata: null,
      };

      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [staleArchitect];
        if (status === 'running') return [];
        return [];
      });
      mockDb.getNextQueuedTask.mockReturnValue(staleArchitect);
      mockDb.prepare.mockImplementation((sql) => {
        if (sql.includes('SELECT value FROM config')) {
          return { get: (key) => {
            const val = mockDb.getConfig(key);
            return val != null ? { value: val } : undefined;
          }};
        }
        if (sql.includes('FROM tasks') && sql.includes('factory:plan_generation')) {
          return { all: vi.fn().mockReturnValue([completedPlan]) };
        }
        return { all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() };
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'old-architect',
        'cancelled',
        expect.objectContaining({
          cancel_reason: 'superseded_factory_internal',
          error_output: expect.stringContaining('newer same-project work'),
        }),
      );
    });

    it('fails tasks older than queue TTL', () => {
      const now = 2000000;
      const expiredTask = { id: 'expired-task', provider: 'ollama', created_at: new Date(now - 20 * 60000).toISOString() };
      const expectedCutoff = new Date(now - 10 * 60000).toISOString();

      const selectRow = vi.spyOn(Date, 'now').mockReturnValue(now);
      mockDb.getExpiredQueuedTasks.mockReturnValue([expiredTask]);

      const eventBus = require('../event-bus');
      const emitSpy = vi.spyOn(eventBus, 'emitTaskEvent');
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        if (key === 'max_api_concurrent') return 4;
        if (key === 'queue_task_ttl_minutes') return 10;
        return defaultVal;
      });

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();

      // Source uses db.updateTaskStatus instead of raw prepare/run
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('expired-task', 'failed', {
        error_output: 'Expired: exceeded queue TTL',
      });
      expect(mocks.notifyDashboard).toHaveBeenCalledWith('expired-task', {
        status: 'failed',
        error_output: 'Expired: exceeded queue TTL',
      });
      expect(mockDb.getExpiredQueuedTasks).toHaveBeenCalledWith(expectedCutoff);
      expect(emitSpy).toHaveBeenCalledWith({
        taskId: 'expired-task',
        type: 'failed',
        reason: 'queue_ttl_expired',
      });

      selectRow.mockRestore();
      emitSpy.mockRestore();
    });

    it('does not expire tasks when queue TTL is zero', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        if (key === 'max_api_concurrent') return 4;
        if (key === 'queue_task_ttl_minutes') return 0;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mockDb.getExpiredQueuedTasks).not.toHaveBeenCalled();
    });

    it('excludes workflow tasks from queue TTL cleanup', () => {
      mockDb.getExpiredQueuedTasks.mockReturnValue([]);

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        if (key === 'max_api_concurrent') return 4;
        if (key === 'queue_task_ttl_minutes') return 15;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mockDb.getExpiredQueuedTasks).toHaveBeenCalledTimes(1);
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('calls periodic budget reset when due and tracks interval', () => {
      const now = 200000;
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(now + 61000);

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();

      expect(mockDb.resetExpiredBudgets).toHaveBeenCalledTimes(1);
      nowSpy.mockRestore();
    });

    it('does not reset budgets again within 60 seconds', () => {
      const now = 200000;
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(now);

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();

      nowSpy.mockReturnValue(now + 30000);
      scheduler.processQueueInternal();

      expect(mockDb.resetExpiredBudgets).toHaveBeenCalledTimes(1);
      nowSpy.mockRestore();
    });

    it('resets budgets again after interval expiry', () => {
      const now = 500000;
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(now);

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();

      nowSpy.mockReturnValue(now + 10000);
      scheduler.processQueueInternal();

      nowSpy.mockReturnValue(now + 70001);
      scheduler.processQueueInternal();

      expect(mockDb.resetExpiredBudgets).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });

    it('calls orphaned retry cleanup on each invocation', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();
      scheduler.processQueueInternal();

      expect(mocks.cleanupOrphanedRetryTimeouts).toHaveBeenCalledTimes(2);
    });

    it('calls cleanup before queue reads when returning early due capacity', () => {
      const callLog = [];
      mockDb.resetExpiredBudgets.mockImplementation(() => {
        callLog.push('resetExpiredBudgets');
      });
      mocks.cleanupOrphanedRetryTimeouts.mockImplementation(() => {
        callLog.push('cleanup');
      });
      mockDb.getRunningCount.mockImplementation(() => {
        callLog.push('runningCount');
        return 20; // must exceed providerSum (8+6+4=18) to trigger early return
      });
      mockDb.listTasks.mockImplementation(() => {
        callLog.push('listTasks');
        return [];
      });

      scheduler.processQueueInternal();

      expect(callLog).toEqual(['listTasks', 'resetExpiredBudgets', 'cleanup', 'runningCount']);
    });

    it('does not invoke VRAM guard when host has no running tasks', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'ot-free', provider: 'ollama', model: 'mistral:7b' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });
      mockDb.getConfig.mockReturnValue(null);

      scheduler.processQueueInternal();

      expect(mocks.isLargeModelBlockedOnHost).not.toHaveBeenCalled();
      expect(mocks.safeStartTask).toHaveBeenCalledWith('ot-free', 'ollama');
    });

    it('does not start task when host at max_per_host capacity', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({ id: 'ot-cap', provider: 'ollama', model: 'mistral:7b' })];
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 2 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 2 },
        reason: 'at host cap',
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'max_per_host') return 2;
        return null;
      });
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('does not fallback-start codex tasks when the provider limit is full', () => {
      const queuedTask = makeTask({ id: 'codex-wait', provider: 'codex', model: null });
      const runningCodexTasks = Array.from({ length: 6 }, (_, index) => makeTask({
        id: `codex-run-${index}`,
        provider: 'codex',
        status: 'running',
      }));

      mockDb.getRunningCount.mockReturnValue(6);
      mockDb.getProvider = vi.fn((provider) => (
        provider === 'codex' ? { provider: 'codex', enabled: 1, max_concurrent: 6 } : null
      ));
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        if (status === 'running') return runningCodexTasks;
        return [];
      });
      mockDb.getNextQueuedTask.mockReturnValue(queuedTask);
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 20;
        if (key === 'max_codex_concurrent') return 10;
        if (key === 'max_ollama_concurrent') return 8;
        if (key === 'max_api_concurrent') return 4;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('starts non-blocked task when another queued model is VRAM-blocked on host', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'vram-blocked', provider: 'ollama', model: TEST_MODELS.DEFAULT }),
            makeTask({ id: 'vram-open', provider: 'ollama', model: 'mistral:7b' }),
          ];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 1 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 1 },
        reason: 'available',
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.isLargeModelBlockedOnHost.mockImplementation((model) => {
        if (model === TEST_MODELS.DEFAULT) return { blocked: true, reason: `${TEST_MODELS.DEFAULT} blocked` };
        return { blocked: false };
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledTimes(1);
      expect(mocks.safeStartTask).toHaveBeenCalledWith('vram-open', 'ollama');
    });

    it('does not apply fallback when user provided model and provider task is at capacity', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'user-fallback-block',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({}),
        task_description: 'Build report',
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: null,
        atCapacity: true,
        reason: 'all hosts at capacity',
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.BALANCED;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalledWith(
        'user-fallback-block',
        'queued',
        expect.objectContaining({ model: TEST_MODELS.DEFAULT }),
      );
      const fallbackCalls = mocks.safeStartTask.mock.calls.filter((c) => c[0] === 'user-fallback-block' && c[1] === 'P71-fallback');
      expect(fallbackCalls).toHaveLength(0);
    });

    it('uses simple-tier fallback model for simple complexity', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'fall-simple',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ smart_routing: true, complexity: 'simple' }),
        task_description: 'Generate short note',
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === TEST_MODELS.DEFAULT) return { host: null, atCapacity: true, reason: 'capacity' };
        return { host: { id: 'h2', name: 'fallback-host', running_tasks: 0 }, reason: 'fallback' };
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_fast_model_fallback') return TEST_MODELS.FAST;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'fall-simple',
        'queued',
        expect.objectContaining({ model: TEST_MODELS.FAST }),
      );
      expect(mocks.notifyDashboard).toHaveBeenCalledWith('fall-simple', {
        status: 'queued',
        model: TEST_MODELS.FAST,
      });
      expect(mocks.safeStartTask).toHaveBeenCalledWith('fall-simple', 'P71-fallback');
    });

    it('uses quality fallback model for complex tasks', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'fall-complex',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ smart_routing: true, complexity: 'complex' }),
        task_description: 'Refactor architecture',
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === TEST_MODELS.DEFAULT) return { host: null, atCapacity: true, reason: 'capacity' };
        return { host: { id: 'h2', name: 'fallback-host', running_tasks: 0 }, reason: 'fallback' };
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_quality_model_fallback') return 'phi4:14b';
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'fall-complex',
        'queued',
        expect.objectContaining({ model: 'phi4:14b' }),
      );
      expect(mocks.safeStartTask).toHaveBeenCalledWith('fall-complex', 'P71-fallback');
    });

    it('does not fallback async-heavy task due P77 guard', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'fall-async',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
        task_description: 'Run this with await and promise chaining',
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null, atCapacity: true, reason: 'capacity' });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.BALANCED;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalledWith(
        'fall-async',
        'queued',
        expect.objectContaining({ model: TEST_MODELS.DEFAULT }),
      );
      const fallbackCalls = mocks.safeStartTask.mock.calls.filter((c) => c[0] === 'fall-async' && c[1] === 'P71-fallback');
      expect(fallbackCalls).toHaveLength(0);
    });

    it('reverts model when fallback start fails', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'fall-fail',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === TEST_MODELS.DEFAULT) return { host: null, atCapacity: true, reason: 'capacity' };
        return { host: { id: 'h2', name: 'fallback-host', running_tasks: 0 }, reason: 'fallback' };
      });
      mocks.safeStartTask.mockImplementation((id, source) => source !== 'P71-fallback');
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.BALANCED;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('fall-fail', 'queued', { model: TEST_MODELS.BALANCED });
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('fall-fail', 'queued', { model: TEST_MODELS.DEFAULT });
      expect(mocks.notifyDashboard).toHaveBeenNthCalledWith(1, 'fall-fail', {
        status: 'queued',
        model: TEST_MODELS.BALANCED,
      });
      expect(mocks.notifyDashboard).toHaveBeenNthCalledWith(2, 'fall-fail', {
        status: 'queued',
        model: TEST_MODELS.DEFAULT,
      });
    });
    it('does not call fallback when fallback model equals selected model', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'fall-match',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
      });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null, atCapacity: true, reason: 'capacity' });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.DEFAULT;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalledWith(
        'fall-match',
        'queued',
        expect.objectContaining({ model: TEST_MODELS.DEFAULT }),
      );
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('does not start fallback task when API provider already at per-provider cap', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({ id: 'api-first', provider: 'anthropic', task_description: 'Refactor' })];
        if (status === 'running') return [makeTask({ id: 'api-run', provider: 'anthropic', status: 'running' })];
        return [];
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.getProviderInstance.mockReturnValue({ enabled: true });
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_api_concurrent') return 1;
        return defaultVal;
      });
      mockDb.getNextQueuedTask.mockReturnValue({ id: 'api-first', provider: 'anthropic' });

      scheduler.processQueueInternal();

      const startCalls = mocks.safeStartTask.mock.calls.filter((c) => c[0] === 'api-first' && c[1] === 'API');
      expect(startCalls).toHaveLength(0);
      const fallbackCalls = mocks.safeStartTask.mock.calls.filter((c) => c[0] === 'api-first' && c[1] === 'fallback');
      expect(fallbackCalls).toHaveLength(0);
    });

    it('caps ollama startup at max_ollama_concurrent', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'o1', provider: 'ollama', model: 'mistral:7b' }),
            makeTask({ id: 'o2', provider: 'ollama', model: 'mistral:7b' }),
            makeTask({ id: 'o3', provider: 'ollama', model: 'mistral:7b' }),
          ];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 10;
        if (key === 'max_ollama_concurrent') return 2;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      const calls = mocks.safeStartTask.mock.calls.filter((c) => c[1] === 'ollama');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(['o1', 'ollama']);
    });

    it('caps Codex startup at max_codex_concurrent', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const runningCodex = [makeTask({ id: 'r-c1', provider: 'codex', status: 'running' })];
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'c1', provider: 'codex', metadata: JSON.stringify({ complexity: 'normal' }) }),
            makeTask({ id: 'c2', provider: 'codex', metadata: JSON.stringify({ complexity: 'normal' }) }),
          ];
        }
        if (status === 'running') return runningCodex;
        return [];
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        if (key === 'codex_overflow_to_local') return '0';
        return null;
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'local', status: 'healthy', running_tasks: 0, max_concurrent: 4 }]);
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_codex_concurrent') return 2;
        return defaultVal;
      });
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null, reason: 'none' });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('c1', 'codex');
      expect(mocks.safeStartTask).toHaveBeenCalledTimes(1);
    });

    it('caps API startup at max_api_concurrent', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'a1', provider: 'anthropic' }),
            makeTask({ id: 'a2', provider: 'groq' }),
            makeTask({ id: 'a3', provider: 'groq' }),
          ];
        }
        return [];
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_api_concurrent') return 2;
        return defaultVal;
      });
      mocks.getProviderInstance.mockReturnValue({ enabled: true });

      scheduler.processQueueInternal();

      const apiCalls = mocks.safeStartTask.mock.calls.filter((c) => c[1] === 'API');
      expect(apiCalls).toHaveLength(2);
    });

    it('does not consume exact-provider capacity for pending async starts in the same pass', () => {
      const attemptTaskStart = vi.fn()
        .mockReturnValueOnce({ pendingAsync: true })
        .mockReturnValueOnce({ started: true });

      scheduler.init({
        db: mockDb,
        ...mocks,
        attemptTaskStart,
      });

      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.getProvider = vi.fn((provider) => ({
        provider,
        enabled: 1,
        max_concurrent: 1,
      }));
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'a1', provider: 'anthropic' }),
            makeTask({ id: 'a2', provider: 'anthropic' }),
          ];
        }
        return [];
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.getProviderInstance.mockReturnValue({ enabled: true });

      scheduler.processQueueInternal();

      expect(attemptTaskStart).toHaveBeenNthCalledWith(1, 'a1', 'API');
      expect(attemptTaskStart).toHaveBeenNthCalledWith(2, 'a2', 'API');
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('keeps provider pools independent: codex full still allows ollama startup', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const runningCodex = [
        makeTask({ id: 'r-c1', provider: 'codex', status: 'running' }),
        makeTask({ id: 'r-c2', provider: 'codex', status: 'running' }),
        makeTask({ id: 'r-c3', provider: 'codex', status: 'running' }),
      ];
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'c1', provider: 'codex', metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }) }),
            makeTask({ id: 'o1', provider: 'ollama', model: 'mistral:7b' }),
          ];
        }
        if (status === 'running') return runningCodex;
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0, max_concurrent: 4 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        if (key === 'codex_overflow_to_local') return '0';
        return null;
      });
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 12;
        if (key === 'max_codex_concurrent') return 3;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('o1', 'ollama');
      const codexCalls = mocks.safeStartTask.mock.calls.filter((c) => c[1] === 'codex');
      expect(codexCalls).toHaveLength(0);
    });

    it('returns early at capacity', () => {
      mockDb.getRunningCount.mockReturnValue(20); // must exceed providerSum (8+6+4=18)

      scheduler.processQueueInternal();

      expect(mockDb.listTasks).toHaveBeenCalledTimes(1);
      expect(mockDb.listTasks).toHaveBeenCalledWith({ status: 'pending', limit: 100 });
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('returns early with no queued tasks', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('starts ollama tasks on available hosts', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'ot-1', provider: 'ollama', model: 'mistral:7b' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([
        { id: 'h1', name: 'host1', status: 'up', running_tasks: 0 },
      ]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });
      mockDb.getConfig.mockReturnValue(null);

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('ot-1', 'ollama');
    });

    it('VRAM guard blocks large models on busy hosts', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'ot-big', provider: 'ollama', model: TEST_MODELS.DEFAULT })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([
        { id: 'h1', name: 'host1', status: 'up', running_tasks: 1 },
      ]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 1 },
        reason: 'available',
      });
      mockDb.getConfig.mockReturnValue(null);
      mocks.isLargeModelBlockedOnHost.mockReturnValue({
        blocked: true,
        reason: `${TEST_MODELS.DEFAULT} (20GB) would exceed VRAM on host1`,
      });

      scheduler.processQueueInternal();

      // safeStartTask should NOT be called for the VRAM-blocked ollama task
      const ollamaCalls = mocks.safeStartTask.mock.calls.filter(
        (c) => c[0] === 'ot-big' && c[1] === 'ollama'
      );
      expect(ollamaCalls).toHaveLength(0);
    });

    it('P71 fallback to different model when at capacity', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'ot-fall',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        task_description: 'Write tests for module',
        metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
      });

      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([
        { id: 'h1', name: 'host1', status: 'up', running_tasks: 2 },
      ]);
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === TEST_MODELS.DEFAULT) {
          return { host: null, atCapacity: true, reason: 'all hosts at capacity' };
        }
        // Fallback model has a host available
        return { host: { id: 'h2', name: 'host2', running_tasks: 0 }, reason: 'available' };
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.BALANCED;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      // Should update task model to fallback and start it
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'ot-fall',
        'queued',
        expect.objectContaining({ model: TEST_MODELS.BALANCED })
      );
      expect(mocks.safeStartTask).toHaveBeenCalledWith('ot-fall', 'P71-fallback');
    });

    it('P92 skips fallback for user-specified models', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      const queuedTask = makeTask({
        id: 'ot-user',
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        task_description: 'Write tests for module',
        metadata: JSON.stringify({}), // no smart_routing flag => user-specified
      });

      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [queuedTask];
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([
        { id: 'h1', name: 'host1', status: 'up', running_tasks: 2 },
      ]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: null,
        atCapacity: true,
        reason: 'all hosts at capacity',
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_balanced_model_fallback') return TEST_MODELS.BALANCED;
        if (key === 'codex_enabled') return '0';
        return null;
      });

      scheduler.processQueueInternal();

      // safeStartTask should NOT be called with P71-fallback for user-specified model
      const fallbackCalls = mocks.safeStartTask.mock.calls.filter(
        (c) => c[1] === 'P71-fallback'
      );
      expect(fallbackCalls).toHaveLength(0);
    });

    it('starts codex tasks independently', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'ct-1', provider: 'codex', task_description: 'Build feature' })];
        }
        if (status === 'running') return []; // no running codex tasks
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([]);
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('ct-1', 'codex');
    });

    it('starts project codex work before factory-internal codex work', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({
              id: 'factory-plan',
              provider: 'codex',
              task_description: 'Generate a factory plan',
              tags: JSON.stringify(['factory:internal', 'factory:plan_generation']),
            }),
            makeTask({
              id: 'project-exec',
              provider: 'codex',
              task_description: 'Implement the selected project task',
              tags: JSON.stringify(['factory:batch_id=batch-1', 'project:bitsy']),
            }),
          ];
        }
        if (status === 'running') return [];
        return [];
      });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mocks.safeConfigInt.mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_codex_concurrent') return 1;
        return defaultVal;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledTimes(1);
      expect(mocks.safeStartTask).toHaveBeenCalledWith('project-exec', 'codex');
    });

    it('starts API provider tasks', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'at-1', provider: 'anthropic', task_description: 'Review code' })];
        }
        if (status === 'running') return [];
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([]);
      mockDb.getConfig.mockReturnValue(null);

      scheduler.processQueueInternal();
      expect(mocks.safeStartTask).toHaveBeenCalledWith('at-1', 'API');
    });

    it('fails queued tasks with unknown providers instead of treating them as ollama', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'bad-provider', provider: 'mystery-provider' })];
        }
        return [];
      });

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'bad-provider',
        'failed',
        expect.objectContaining({ error_output: 'Unknown provider: mystery-provider' }),
      );
      expect(mocks.notifyDashboard).toHaveBeenCalledWith('bad-provider', {
        status: 'failed',
        error_output: 'Unknown provider: mystery-provider',
      });
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('skips API tasks whose own provider instance is unavailable', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'api-missing-instance', provider: 'anthropic', task_description: 'Review code' }),
            makeTask({ id: 'api-ready', provider: 'groq', task_description: 'Answer question' }),
          ];
        }
        return [];
      });
      mocks.getProviderInstance.mockImplementation((provider) => (
        provider === 'groq' ? { enabled: true } : null
      ));

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mocks.safeStartTask).not.toHaveBeenCalledWith('api-missing-instance', 'API');
      expect(mocks.safeStartTask).toHaveBeenCalledWith('api-ready', 'API');
    });

    it('fallback does not start API tasks when their provider instance is unavailable', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'api-fallback-missing', provider: 'anthropic', task_description: 'Review code' })];
        }
        return [];
      });
      mockDb.getNextQueuedTask.mockReturnValue({ id: 'api-fallback-missing', provider: 'anthropic' });
      mocks.getProviderInstance.mockReturnValue(null);

      scheduler.processQueueInternal();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('fallback: starts first queued task when nothing else works', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      // Return tasks that won't match any provider start logic
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'fb-1', provider: 'ollama', model: 'exotic:99b' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([]);
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null, reason: 'no host' });
      mockDb.getConfig.mockReturnValue(null);
      mockDb.getNextQueuedTask.mockReturnValue({ id: 'fb-1', provider: 'ollama' });

      // safeStartTask fails for ollama (no host) but succeeds for fallback
      mocks.safeStartTask.mockImplementation((id, source) => {
        if (source === 'ollama') return false;
        return true;
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('fb-1', 'fallback');
    });

    it('fallback: skips a queue head that re-queues and tries the next task', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'fb-head', provider: 'ollama', model: 'exotic:99b' }),
            makeTask({ id: 'fb-next', provider: 'ollama', model: 'exotic:99b' }),
          ];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([]);
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null, reason: 'no host' });
      mockDb.getConfig.mockReturnValue(null);
      mockDb.getNextQueuedTask.mockReturnValue({ id: 'fb-head', provider: 'ollama' });
      mocks.safeStartTask.mockImplementation((id, source) => source === 'fallback' && id === 'fb-next');

      scheduler.processQueueInternal();

      const fallbackCalls = mocks.safeStartTask.mock.calls.filter((c) => c[1] === 'fallback');
      expect(fallbackCalls).toEqual([
        ['fb-head', 'fallback'],
        ['fb-next', 'fallback'],
      ]);
    });

    it('skips queued tasks blocked by approval gate status', () => {
      mockDb.checkApprovalRequired.mockReturnValue({ required: true, status: 'pending' });
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'approval-pending', provider: 'ollama' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });

      scheduler.processQueueInternal();

      expect(mockDb.checkApprovalRequired).toHaveBeenCalledWith('approval-pending');
      expect(mocks.safeStartTask).not.toHaveBeenCalled();
    });

    it('starts queued tasks when approval is approved', () => {
      mockDb.checkApprovalRequired.mockReturnValue({ required: true, status: 'approved' });
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'approval-approved', provider: 'ollama' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('approval-approved', 'ollama');
    });

    it('starts queued tasks when no approval rule matches', () => {
      mockDb.checkApprovalRequired.mockReturnValue({ required: false, status: 'not_required' });
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [makeTask({ id: 'approval-none', provider: 'ollama' })];
        }
        return [];
      });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'h1', name: 'host1', status: 'up', running_tasks: 0 }]);
      mockDb.selectOllamaHostForModel.mockReturnValue({
        host: { id: 'h1', name: 'host1', running_tasks: 0 },
        reason: 'available',
      });

      scheduler.processQueueInternal();

      expect(mocks.safeStartTask).toHaveBeenCalledWith('approval-none', 'ollama');
    });

    // ── Codex overflow rerouting ────────────────────────────────

    describe('Codex overflow to local LLM', () => {
      function setupCodexOverflow({ runningCodexCount, queuedTask, hostStatus, hostRunning, hostMaxConcurrent, configOverrides }) {
        // 3 running codex tasks = at max (max_codex_concurrent defaults to 3 in mocks)
        const runningCodexTasks = Array.from({ length: runningCodexCount }, (_, i) =>
          makeTask({ id: `running-codex-${i}`, provider: 'codex', status: 'running' })
        );

        mockDb.listTasks.mockImplementation(({ status }) => {
          if (status === 'queued') return [queuedTask];
          if (status === 'running') return runningCodexTasks;
          return [];
        });

        mockDb.listOllamaHosts.mockReturnValue([
          {
            id: 'h1',
            name: 'local-host',
            status: hostStatus || 'healthy',
            running_tasks: hostRunning != null ? hostRunning : 0,
            max_concurrent: hostMaxConcurrent != null ? hostMaxConcurrent : 4,
          },
        ]);

        mockDb.getConfig.mockImplementation((key) => {
          if (configOverrides && key in configOverrides) return configOverrides[key];
          if (key === 'codex_enabled') return '1';
          if (key === 'codex_overflow_to_local') return '1';
          if (key === 'ollama_balanced_model') return TEST_MODELS.SMALL;
          if (key === 'ollama_fast_model') return TEST_MODELS.FAST;
          return null;
        });
      }

      it('reroutes normal-complexity Codex task to ollama when slots full and local healthy', () => {
        const queuedTask = makeTask({
          id: 'overflow-1',
          provider: 'codex',
          task_description: 'Write unit tests',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
          'overflow-1',
          'queued',
          expect.objectContaining({
            provider: 'ollama',
            model: TEST_MODELS.SMALL,
          })
        );
        expect(mocks.notifyDashboard).toHaveBeenCalledWith(
          'overflow-1',
          expect.objectContaining({
            status: 'queued',
            provider: 'ollama',
            model: TEST_MODELS.SMALL,
          }),
        );
        // Verify metadata includes overflow flag and original provider
        const updateCall = mockDb.updateTaskStatus.mock.calls.find(
          (c) => c[0] === 'overflow-1' && c[2]?.provider === 'ollama'
        );
        expect(updateCall).toBeTruthy();
        const updatedMeta = JSON.parse(updateCall[2].metadata);
        expect(updatedMeta.overflow).toBe(true);
        expect(updatedMeta.original_provider).toBe('codex');
      });

      it('does NOT reroute complex-complexity tasks', () => {
        const queuedTask = makeTask({
          id: 'overflow-complex',
          provider: 'codex',
          task_description: 'Refactor architecture',
          metadata: JSON.stringify({ complexity: 'complex', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        // updateTaskStatus should NOT be called with ollama provider
        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('does NOT reroute when local LLM hosts are down', () => {
        const queuedTask = makeTask({
          id: 'overflow-down',
          provider: 'codex',
          task_description: 'Write tests',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'down',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('does NOT reroute when overflow is disabled via config', () => {
        const queuedTask = makeTask({
          id: 'overflow-disabled',
          provider: 'codex',
          task_description: 'Write tests',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            codex_overflow_to_local: '0',
          },
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(0);
      });

      // ── P-overflow: Protect explicit provider choices ──────

      it('does NOT overflow user-override Codex tasks', () => {
        const queuedTask = makeTask({
          id: 'overflow-user-override',
          provider: 'codex',
          task_description: 'Build feature',
          metadata: JSON.stringify({ complexity: 'normal', user_provider_override: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('does NOT overflow template-bound Codex tasks', () => {
        const queuedTask = makeTask({
          id: 'overflow-template',
          provider: 'codex',
          task_description: 'Build template workflow',
          metadata: JSON.stringify({ complexity: 'normal', _routing_template: 'dlphone-template', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'overflow-template' && (c[2]?.provider === 'ollama' || c[2]?.provider === 'anthropic')
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('DOES overflow default Codex tasks without user_provider_override', () => {
        const queuedTask = makeTask({
          id: 'overflow-default',
          provider: 'codex',
          task_description: 'Workflow task',
          metadata: JSON.stringify({ complexity: 'normal' }), // no override
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'overflow-default' && c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(1);
      });

      it('overflows smart-routed Codex tasks when slots full (explicit smart_routing)', () => {
        const queuedTask = makeTask({
          id: 'overflow-smart',
          provider: 'codex',
          task_description: 'Write tests',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'overflow-smart' && c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(1);
      });

      it('mixed queue: skips user-override, overflows default behind it', () => {
        const userTask = makeTask({
          id: 'user-codex',
          provider: 'codex',
          task_description: 'Important feature',
          metadata: JSON.stringify({ complexity: 'normal', user_provider_override: true }),
        });
        const smartTask = makeTask({
          id: 'smart-codex',
          provider: 'codex',
          task_description: 'Write docs',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        const runningCodexTasks = Array.from({ length: 3 }, (_, i) =>
          makeTask({ id: `running-codex-${i}`, provider: 'codex', status: 'running' })
        );

        mockDb.listTasks.mockImplementation(({ status }) => {
          if (status === 'queued') return [userTask, smartTask]; // user-specified first
          if (status === 'running') return runningCodexTasks;
          return [];
        });

        mockDb.listOllamaHosts.mockReturnValue([
          { id: 'h1', name: 'local-host', status: 'healthy', running_tasks: 0, max_concurrent: 4 },
        ]);

        mockDb.getConfig.mockImplementation((key) => {
          if (key === 'codex_enabled') return '1';
          if (key === 'codex_overflow_to_local') return '1';
          if (key === 'ollama_balanced_model') return TEST_MODELS.SMALL;
          if (key === 'ollama_fast_model') return TEST_MODELS.FAST;
          return null;
        });

        scheduler.processQueueInternal();

        // user-specified task should NOT be overflowed
        const userOverflow = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'user-codex' && c[2]?.provider === 'ollama'
        );
        expect(userOverflow).toHaveLength(0);

        // smart-routed task behind it SHOULD be overflowed
        const smartOverflow = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'smart-codex' && c[2]?.provider === 'ollama'
        );
        expect(smartOverflow).toHaveLength(1);
      });

      it('starts Codex tasks normally when slots are available', () => {
        const queuedTask = makeTask({
          id: 'codex-normal',
          provider: 'codex',
          task_description: 'Build feature normally',
          metadata: JSON.stringify({ complexity: 'normal' }),
        });

        // Only 2 running, max is 3 — slots available
        setupCodexOverflow({
          runningCodexCount: 2,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        expect(mocks.safeStartTask).toHaveBeenCalledWith('codex-normal', 'codex');
        // No overflow should have occurred
        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('does not trigger quota auto-assignment while Codex still has capacity', () => {
        const queuedTask = makeTask({
          id: 'quota-open-slot',
          provider: 'codex',
          task_description: 'Write docs',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });
        const tracker = {
          getAvailableProvidersSmart: vi.fn().mockReturnValue([{ provider: 'anthropic' }]),
        };
        const getFreeQuotaTracker = vi.fn().mockReturnValue(tracker);

        setupCodexOverflow({
          runningCodexCount: 2,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            quota_auto_scale_enabled: '1',
          },
        });

        scheduler.init({
          db: mockDb,
          ...mocks,
          getFreeQuotaTracker,
        });

        scheduler.processQueueInternal();

        expect(mocks.safeStartTask).toHaveBeenCalledWith('quota-open-slot', 'codex');
        expect(getFreeQuotaTracker).not.toHaveBeenCalled();
        expect(tracker.getAvailableProvidersSmart).not.toHaveBeenCalled();

        const quotaUpdates = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'quota-open-slot' && c[2]?.provider === 'anthropic'
        );
        expect(quotaUpdates).toHaveLength(0);
      });

      it('does not quota auto-scale Codex tasks awaiting approval', () => {
        mockDb.checkApprovalRequired.mockReturnValue({ required: true, status: 'pending' });
        const queuedTask = makeTask({
          id: 'approval-pending-codex',
          provider: 'codex',
          task_description: 'Review queued change',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });
        const tracker = {
          getAvailableProvidersSmart: vi.fn().mockReturnValue([{ provider: 'anthropic' }]),
        };
        const getFreeQuotaTracker = vi.fn().mockReturnValue(tracker);

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            quota_auto_scale_enabled: '1',
          },
        });

        scheduler.init({
          db: mockDb,
          ...mocks,
          getFreeQuotaTracker,
        });

        scheduler.processQueueInternal();

        expect(mockDb.checkApprovalRequired).toHaveBeenCalledWith('approval-pending-codex');
        expect(mocks.safeStartTask).not.toHaveBeenCalled();
        expect(getFreeQuotaTracker).not.toHaveBeenCalled();

        const quotaUpdates = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'approval-pending-codex' && c[2]?.provider === 'anthropic'
        );
        expect(quotaUpdates).toHaveLength(0);
      });

      it('does not quota auto-scale top-level user-override Codex tasks', () => {
        const queuedTask = makeTask({
          id: 'quota-top-level-override',
          provider: 'codex',
          user_provider_override: true,
          task_description: 'Pinned Codex task',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });
        const tracker = {
          getAvailableProvidersSmart: vi.fn().mockReturnValue([{ provider: 'anthropic' }]),
        };
        const getFreeQuotaTracker = vi.fn().mockReturnValue(tracker);

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            quota_auto_scale_enabled: '1',
          },
        });

        scheduler.init({
          db: mockDb,
          ...mocks,
          getFreeQuotaTracker,
        });

        scheduler.processQueueInternal();

        expect(tracker.getAvailableProvidersSmart).not.toHaveBeenCalled();

        const quotaUpdates = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'quota-top-level-override' && c[2]?.provider === 'anthropic'
        );
        expect(quotaUpdates).toHaveLength(0);
      });

      it('does not overflow when local LLM host has no available capacity', () => {
        const queuedTask = makeTask({
          id: 'overflow-full-host',
          provider: 'codex',
          task_description: 'Write unit tests',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 4,
          hostMaxConcurrent: 4,
          configOverrides: { codex_enabled: '1' },
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'overflow-full-host' && c[2]?.provider === 'ollama',
        );
        expect(overflowCalls).toHaveLength(0);
      });

      it('does not burn the quota auto-scale cooldown on a no-op pass', () => {
        const queuedTask = makeTask({
          id: 'quota-cooldown-noop',
          provider: 'codex',
          task_description: 'Write docs',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });
        const tracker = {
          getAvailableProvidersSmart: vi.fn()
            .mockReturnValueOnce([])
            .mockReturnValueOnce([{ provider: 'anthropic' }]),
        };
        const getFreeQuotaTracker = vi.fn().mockReturnValue(tracker);

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            codex_overflow_to_local: '0',
            quota_auto_scale_enabled: '1',
          },
        });

        scheduler.init({
          db: mockDb,
          ...mocks,
          getFreeQuotaTracker,
        });

        scheduler.processQueueInternal();

        expect(scheduler._getLastAutoScaleActivation()).toBe(0);
        expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();

        mockDb.updateTaskStatus.mockClear();

        scheduler.processQueueInternal();

        expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
          'quota-cooldown-noop',
          'queued',
          expect.objectContaining({
            provider: 'anthropic',
            model: null,
          }),
        );
        expect(mocks.notifyDashboard).toHaveBeenCalledWith(
          'quota-cooldown-noop',
          expect.objectContaining({
            status: 'queued',
            provider: 'anthropic',
            model: null,
          }),
        );
        expect(scheduler._getLastAutoScaleActivation()).toBeGreaterThan(0);
      });

      it('uses balanced local model for normal-complexity overflow', () => {
        const queuedTask = makeTask({
          id: 'overflow-normal',
          provider: 'codex',
          task_description: 'Write docs',
          metadata: JSON.stringify({ complexity: 'normal', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            ollama_balanced_model: TEST_MODELS.SMALL,
          },
        });

        scheduler.processQueueInternal();

        expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
          'overflow-normal',
          'queued',
          expect.objectContaining({ provider: 'ollama', model: TEST_MODELS.SMALL }),
        );
      });

      it('uses fast local model for simple-complexity overflow', () => {
        const queuedTask = makeTask({
          id: 'overflow-simple',
          provider: 'codex',
          task_description: 'Quick check',
          metadata: JSON.stringify({ complexity: 'simple', smart_routing: true }),
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
          configOverrides: {
            codex_enabled: '1',
            ollama_fast_model: TEST_MODELS.FAST,
          },
        });

        scheduler.processQueueInternal();

        expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
          'overflow-simple',
          'queued',
          expect.objectContaining({ provider: 'ollama', model: TEST_MODELS.FAST }),
        );
      });
      it('overflows tasks with null metadata (workflow default path)', () => {
        const queuedTask = makeTask({
          id: 'overflow-null-meta',
          provider: 'codex',
          task_description: 'Workflow task with null metadata',
          metadata: null,
        });

        setupCodexOverflow({
          runningCodexCount: 3,
          queuedTask,
          hostStatus: 'healthy',
          hostRunning: 0,
          hostMaxConcurrent: 4,
        });

        scheduler.processQueueInternal();

        const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[0] === 'overflow-null-meta' && c[2]?.provider === 'ollama'
        );
        expect(overflowCalls).toHaveLength(1);
      });
    });
  });

  describe('resolveCodexPendingTasks', () => {
    it('reroutes codex-pending tasks to codex when codex is enabled', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: true });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({ id: 'pending-1', provider: 'codex-pending' })];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      expect(mockDb.getProvider).toHaveBeenCalledWith('codex');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('pending-1', 'queued', { provider: 'codex' });
      expect(mocks.notifyDashboard).toHaveBeenCalledWith('pending-1', {
        status: 'queued',
        provider: 'codex',
      });
    });

    it('fails codex-pending tasks when codex is disabled and no intended_provider', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '0';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: true });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({ id: 'pending-2', provider: 'codex-pending' })];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      // Should fail (not silently re-route to ollama-cloud)
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'pending-2',
        'failed',
        expect.objectContaining({
          error_output: expect.stringContaining('[codex-pending]'),
          completed_at: expect.any(String),
        }),
      );
    });

    it('respects user_provider_override intended_provider when codex is disabled', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '0';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: true });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({
          id: 'pending-2b',
          provider: 'codex-pending',
          metadata: JSON.stringify({ user_provider_override: true, intended_provider: 'codex' }),
        })];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      // Should route to intended_provider 'codex', NOT ollama-cloud
      expect(mockDb.getProvider).toHaveBeenCalledWith('codex');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('pending-2b', 'queued', { provider: 'codex' });
    });

    it('respects template intent intended_provider when codex is disabled', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '0';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: true });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({
          id: 'pending-2c',
          provider: 'codex-pending',
          metadata: JSON.stringify({ _routing_template: 'dlphone-template', intended_provider: 'cerebras' }),
        })];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      expect(mockDb.getProvider).toHaveBeenCalledWith('cerebras');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('pending-2c', 'queued', { provider: 'cerebras' });
    });

    it('fails stuck codex-pending task when no provider exists', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue(null);
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [makeTask({ id: 'pending-3', provider: 'codex-pending' })];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith(
        'pending-3',
        'failed',
        expect.objectContaining({
          error_output: expect.stringContaining('[codex-pending]'),
          completed_at: expect.any(String),
        }),
      );
      expect(mocks.notifyDashboard).toHaveBeenCalledWith(
        'pending-3',
        expect.objectContaining({
          status: 'failed',
          error_output: expect.stringContaining('[codex-pending]'),
          completed_at: expect.any(String),
        }),
      );
    });

    it('does nothing when no codex-pending tasks are present', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: true });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return [];
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockDb.getProvider).not.toHaveBeenCalled();
    });

    it('fails codex-pending tasks when provider is disabled', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      });
      mockDb.getProvider = vi.fn().mockReturnValue({ enabled: false });
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') {
          return [
            makeTask({ id: 'pending-4', provider: 'codex-pending' }),
            makeTask({ id: 'pending-5', provider: 'codex-pending' }),
          ];
        }
        return [];
      });

      scheduler.resolveCodexPendingTasks();

      const failed = mockDb.updateTaskStatus.mock.calls.filter((c) => c[1] === 'failed');
      expect(failed).toHaveLength(2);
    });
  });
});
