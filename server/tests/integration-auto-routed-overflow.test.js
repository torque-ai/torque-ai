/**
 * Integration proof: auto_routed tasks overflow to local/free-tier
 * when codex slots are full.
 *
 * Exercises the REAL createTask + processQueue pipeline.
 */

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockReturnValue(null),
}));

describe('auto_routed overflow — proof of integration', () => {
  // ── Part 1: createTask metadata flag ──────────────────────

  describe('createTask sets auto_routed correctly', () => {
    let db;

    beforeEach(() => {
      vi.resetModules();
      delete require.cache[require.resolve('../database')];
      db = require('../database');
      db.init(':memory:');
    });

    afterEach(() => {
      try { db.close(); } catch (_e) { void _e; }
    });

    it('defaults to configured provider when NO provider specified (workflow path)', () => {
      const taskId = 'proof-no-provider-' + Date.now();
      db.createTask({
        id: taskId,
        task_description: 'Write unit tests for parser module',
        working_directory: process.cwd(),
        status: 'pending',
        // NO provider — this is how workflow tasks are created
      });

      const task = db.getTask(taskId);

      // PROOF: Provider is now null (deferred assignment) when no provider specified
      expect(task.provider).toBeNull();
      // No user_provider_override — eligible for overflow
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      expect(meta.user_provider_override).toBeFalsy();
    });

    it('auto_routed is ABSENT when provider is explicitly "codex"', () => {
      const taskId = 'proof-explicit-codex-' + Date.now();
      db.createTask({
        id: taskId,
        task_description: 'Security audit of auth module',
        working_directory: process.cwd(),
        status: 'pending',
        provider: 'codex', // EXPLICIT
      });

      const task = db.getTask(taskId);
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});

      // PROOF: no auto_routed flag — user chose codex deliberately
      expect(meta.auto_routed).toBeUndefined();
      expect(task.provider).toBe('codex');
    });

    it('auto_routed is ABSENT when user_provider_override is set', () => {
      const taskId = 'proof-override-' + Date.now();
      db.createTask({
        id: taskId,
        task_description: 'Deploy pipeline task',
        working_directory: process.cwd(),
        status: 'pending',
        provider: 'codex',
        metadata: JSON.stringify({ user_provider_override: true }),
      });

      const task = db.getTask(taskId);
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});

      // PROOF: user override blocks auto_routed
      expect(meta.auto_routed).toBeUndefined();
      expect(meta.user_provider_override).toBe(true);
    });
  });

  // ── Part 2: Queue scheduler overflow behavior ─────────────

  describe('processQueue overflows auto_routed tasks', () => {
    let scheduler;
    let mockDb;
    let mocks;

    beforeEach(() => {
      vi.resetModules();
      delete require.cache[require.resolve('../execution/queue-scheduler')];
      scheduler = require('../execution/queue-scheduler');

      mockDb = {
        getRunningCount: vi.fn().mockReturnValue(3),
        prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }),
        listTasks: vi.fn().mockReturnValue([]),
        listOllamaHosts: vi.fn().mockReturnValue([]),
        getConfig: vi.fn().mockReturnValue(null),
        selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
        updateTaskStatus: vi.fn(),
        getNextQueuedTask: vi.fn().mockReturnValue(null),
        resetExpiredBudgets: vi.fn(),
        checkApprovalRequired: vi.fn().mockReturnValue({ required: false, status: 'not_required', rule: null }),
      };

      mocks = {
        safeStartTask: vi.fn().mockReturnValue(true),
        safeConfigInt: vi.fn().mockImplementation((key, defaultVal) => {
          if (key === 'max_concurrent') return 10;
          if (key === 'max_per_host') return 2;
          if (key === 'max_codex_concurrent') return 3;
          return defaultVal;
        }),
        isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
        cleanupOrphanedRetryTimeouts: vi.fn(),
      };

      scheduler.init({ db: mockDb, ...mocks });

      // Patch to skip recent-process guard
      const orig = scheduler.processQueueInternal;
      scheduler.processQueueInternal = (opts = {}) => orig({ skipRecentProcessGuard: true, ...opts });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function setupFullCodex(queuedTasks) {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        if (key === 'codex_overflow_to_local') return '1';
        if (key === 'overflow_max_complexity') return 'normal';
        if (key === 'ollama_balanced_model') return 'qwen2.5-coder:32b';
        if (key === 'ollama_fast_model') return 'qwen2.5-coder:32b';
        return null;
      });

      const runningCodex = [
        { id: 'r1', provider: 'codex', status: 'running' },
        { id: 'r2', provider: 'codex', status: 'running' },
        { id: 'r3', provider: 'codex', status: 'running' },
      ];

      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'queued') return queuedTasks;
        if (status === 'running') return runningCodex;
        return [];
      });

      mockDb.listOllamaHosts.mockReturnValue([
        { id: 'remote-gpu-host', name: 'remote-gpu-host', status: 'healthy', running_tasks: 0, max_concurrent: 4, enabled: true },
      ]);
    }

    it('PROOF: auto_routed task overflows to hashline-ollama when codex full', () => {
      setupFullCodex([{
        id: 'workflow-task-1',
        provider: 'codex',
        status: 'queued',
        task_description: 'Create types for InventorySystem',
        metadata: JSON.stringify({ complexity: 'normal', auto_routed: true }),
      }]);

      scheduler.processQueueInternal();

      // Find the updateTaskStatus call that rerouted to hashline-ollama
      const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'workflow-task-1' && c[1] === 'queued' && c[2]?.provider === 'hashline-ollama'
      );

      expect(overflowCalls).toHaveLength(1);
      // Verify overflow metadata
      const overflowMeta = JSON.parse(overflowCalls[0][2].metadata);
      expect(overflowMeta.overflow).toBe(true);
      expect(overflowMeta.original_provider).toBe('codex');
      expect(overflowMeta.auto_routed).toBe(true);
    });

    it('PROOF: smart_routed task also overflows (backwards compatible)', () => {
      setupFullCodex([{
        id: 'smart-task-1',
        provider: 'codex',
        status: 'queued',
        task_description: 'Write docs for API',
        metadata: JSON.stringify({ complexity: 'simple', smart_routing: true }),
      }]);

      scheduler.processQueueInternal();

      const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'smart-task-1' && c[2]?.provider === 'hashline-ollama'
      );
      expect(overflowCalls).toHaveLength(1);
    });

    it('PROOF: task without user_provider_override DOES overflow (default-eligible)', () => {
      setupFullCodex([{
        id: 'default-task-1',
        provider: 'codex',
        status: 'queued',
        task_description: 'Default codex task without explicit override',
        metadata: JSON.stringify({ complexity: 'normal' }),
      }]);

      scheduler.processQueueInternal();

      const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'default-task-1' && c[2]?.provider === 'hashline-ollama'
      );
      // All non-override tasks are overflow-eligible
      expect(overflowCalls).toHaveLength(1);
    });

    it('PROOF: user_provider_override task does NOT overflow even with auto_routed', () => {
      setupFullCodex([{
        id: 'override-task-1',
        provider: 'codex',
        status: 'queued',
        task_description: 'User insists on codex',
        metadata: JSON.stringify({ complexity: 'normal', auto_routed: true, user_provider_override: true }),
      }]);

      scheduler.processQueueInternal();

      const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'override-task-1' && c[2]?.provider === 'hashline-ollama'
      );
      expect(overflowCalls).toHaveLength(0);
    });

    it('PROOF: mixed queue — overflows all non-override, skips user-override', () => {
      setupFullCodex([
        {
          id: 'user-override-codex',
          provider: 'codex',
          status: 'queued',
          task_description: 'User explicitly chose codex',
          metadata: JSON.stringify({ complexity: 'normal', user_provider_override: true }),
        },
        {
          id: 'workflow-default',
          provider: 'codex',
          status: 'queued',
          task_description: 'Workflow step — no override',
          metadata: JSON.stringify({ complexity: 'normal' }),
        },
        {
          id: 'smart-routed',
          provider: 'codex',
          status: 'queued',
          task_description: 'Smart-routed task',
          metadata: JSON.stringify({ complexity: 'simple', smart_routing: true }),
        },
      ]);

      scheduler.processQueueInternal();

      // user-override: NOT overflowed
      const overrideOverflow = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'user-override-codex' && c[2]?.provider === 'hashline-ollama'
      );
      expect(overrideOverflow).toHaveLength(0);

      // workflow-default: OVERFLOWED (no override = eligible)
      const workflowOverflow = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'workflow-default' && c[2]?.provider === 'hashline-ollama'
      );
      expect(workflowOverflow).toHaveLength(1);

      // smart-routed: OVERFLOWED
      const smartOverflow = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'smart-routed' && c[2]?.provider === 'hashline-ollama'
      );
      expect(smartOverflow).toHaveLength(1);
    });
  });
});
