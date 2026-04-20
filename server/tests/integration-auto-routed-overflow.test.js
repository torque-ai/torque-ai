/**
 * Integration proof: auto_routed tasks overflow to local/quota
 * when codex slots are full.
 *
 * Exercises the REAL createTask + processQueue pipeline.
 */

const { TEST_MODELS } = require('./test-helpers');

const mockProviderRegistry = {
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockImplementation((provider) => {
    if (provider === 'codex') return 'codex';
    if (provider === 'ollama') return 'ollama';
    return 'api';
  }),
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

vi.mock('../providers/registry', () => mockProviderRegistry);

const mockServerConfig = {
  init: vi.fn(),
  isOptIn: vi.fn(),
  getBool: vi.fn(),
  getInt: vi.fn(),
  get: vi.fn(),
  getEpoch: vi.fn().mockReturnValue(1),
};

vi.mock('../config', () => mockServerConfig);

describe('auto_routed overflow — proof of integration', () => {
  // ── Part 1: createTask metadata flag ──────────────────────

  describe('createTask sets auto_routed correctly', () => {
    let dbHandle;
    let taskCore;

    beforeEach(() => {
      const Database = require('better-sqlite3');
      // Monkey-patch config.getEpoch before createTask uses it
      const serverConfig = require('../config');
      if (!serverConfig.getEpoch) {
        serverConfig.getEpoch = () => 1;
      }
      taskCore = require('../db/task-core');
      dbHandle = new Database(':memory:');
      dbHandle.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT,
          task_description TEXT,
          working_directory TEXT,
          timeout_minutes INTEGER,
          auto_approve INTEGER,
          priority INTEGER,
          context TEXT,
          created_at TEXT,
          max_retries INTEGER,
          depends_on TEXT,
          template_name TEXT,
          isolated_workspace TEXT,
          tags TEXT,
          project TEXT,
          provider TEXT,
          model TEXT,
          complexity TEXT,
          review_status TEXT,
          ollama_host_id TEXT,
          original_provider TEXT,
          provider_switched_at TEXT,
          metadata TEXT,
          workflow_id TEXT,
          workflow_node_id TEXT,
          stall_timeout_seconds INTEGER,
          approval_status TEXT,
          server_epoch INTEGER,
          resume_context TEXT
        );
      `);
      taskCore.setDb(dbHandle);
      taskCore.setDbClosed(false);
      taskCore.setExternalFns({
        getProjectFromPath: () => null,
        recordEvent: () => undefined,
        escapeLikePattern: (value) => value,
        recordTaskFileWrite: () => undefined,
        notifyTaskStatusTransition: () => undefined,
        getConfig: () => 'codex',
      });
    });

    afterEach(() => {
      taskCore.setDb(null);
      dbHandle.close();
    });

    it('defaults to configured provider when NO provider specified (workflow path)', () => {
      const taskId = 'proof-no-provider-' + Date.now();
      taskCore.createTask({
        id: taskId,
        task_description: 'Write unit tests for parser module',
        working_directory: process.cwd(),
        status: 'pending',
        // NO provider — this is how workflow tasks are created
      });

      const task = taskCore.getTask(taskId);
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});

      // PROOF: Provider is now null (deferred assignment) when no provider specified
      expect(task.provider).toBeNull();
      expect(meta.auto_routed).toBe(true);
      expect(meta.requested_provider).toBe('codex');
      expect(meta.user_provider_override).toBeFalsy();
    });

    it('auto_routed is ABSENT when provider is explicitly "codex"', () => {
      const taskId = 'proof-explicit-codex-' + Date.now();
      taskCore.createTask({
        id: taskId,
        task_description: 'Security audit of auth module',
        working_directory: process.cwd(),
        status: 'pending',
        provider: 'codex', // EXPLICIT
      });

      const task = taskCore.getTask(taskId);
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});

      // PROOF: no auto_routed flag — user chose codex deliberately
      expect(meta.auto_routed).toBeUndefined();
      expect(meta.requested_provider).toBe('codex');
      expect(task.provider).toBe('codex');
    });

    it('auto_routed is ABSENT when user_provider_override is set', () => {
      const taskId = 'proof-override-' + Date.now();
      taskCore.createTask({
        id: taskId,
        task_description: 'Deploy pipeline task',
        working_directory: process.cwd(),
        status: 'pending',
        provider: 'codex',
        metadata: JSON.stringify({ user_provider_override: true }),
      });

      const task = taskCore.getTask(taskId);
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});

      // PROOF: user override blocks auto_routed
      expect(meta.auto_routed).toBeUndefined();
      expect(meta.requested_provider).toBe('codex');
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
      installCjsModuleMock('../providers/registry', mockProviderRegistry);
      installCjsModuleMock('../config', mockServerConfig);
      delete require.cache[require.resolve('../execution/queue-scheduler')];
      scheduler = require('../execution/queue-scheduler');

      mockDb = {
        getRunningCount: vi.fn().mockReturnValue(3),
        prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }),
        listTasks: vi.fn().mockReturnValue([]),
        listOllamaHosts: vi.fn().mockReturnValue([]),
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

      mockServerConfig.init.mockReset();
      mockServerConfig.isOptIn.mockReset();
      mockServerConfig.getBool.mockReset();
      mockServerConfig.getInt.mockReset();
      mockServerConfig.get.mockReset();
      mockServerConfig.isOptIn.mockImplementation((key) => {
        if (key === 'codex_enabled') return true;
        if (key === 'quota_auto_scale_enabled') return false;
        return false;
      });
      mockServerConfig.getBool.mockImplementation((key) => {
        if (key === 'codex_overflow_to_local') return true;
        if (key === 'auto_compute_max_concurrent') return false;
        return false;
      });
      mockServerConfig.getInt.mockImplementation((_key, fallback) => fallback);
      mockServerConfig.get.mockImplementation((key) => {
        if (key === 'overflow_max_complexity') return 'normal';
        if (key === 'ollama_balanced_model') return TEST_MODELS.DEFAULT;
        if (key === 'ollama_fast_model') return TEST_MODELS.DEFAULT;
        return null;
      });

      scheduler.init({ db: mockDb, ...mocks });

      // Patch to skip recent-process guard
      const orig = scheduler.processQueueInternal;
      scheduler.processQueueInternal = (opts = {}) => orig({ skipRecentProcessGuard: true, ...opts });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function setupFullCodex(queuedTasks) {
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

    it('PROOF: auto_routed task overflows to ollama when codex full', () => {
      setupFullCodex([{
        id: 'workflow-task-1',
        provider: 'codex',
        status: 'queued',
        task_description: 'Create types for InventorySystem',
        metadata: JSON.stringify({ complexity: 'normal', auto_routed: true }),
      }]);

      scheduler.processQueueInternal();

      // Find the updateTaskStatus call that rerouted to ollama
      const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'workflow-task-1' && c[1] === 'queued' && c[2]?.provider === 'ollama'
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
        c => c[0] === 'smart-task-1' && c[2]?.provider === 'ollama'
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
        c => c[0] === 'default-task-1' && c[2]?.provider === 'ollama'
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
        c => c[0] === 'override-task-1' && c[2]?.provider === 'ollama'
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
        c => c[0] === 'user-override-codex' && c[2]?.provider === 'ollama'
      );
      expect(overrideOverflow).toHaveLength(0);

      // workflow-default: OVERFLOWED (no override = eligible)
      const workflowOverflow = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'workflow-default' && c[2]?.provider === 'ollama'
      );
      expect(workflowOverflow).toHaveLength(1);

      // smart-routed: OVERFLOWED
      const smartOverflow = mockDb.updateTaskStatus.mock.calls.filter(
        c => c[0] === 'smart-routed' && c[2]?.provider === 'ollama'
      );
      expect(smartOverflow).toHaveLength(1);
    });
  });
});
