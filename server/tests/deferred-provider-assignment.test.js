'use strict';

/**
 * Tests for deferred provider assignment in legacy mode.
 *
 * When tasks are submitted via legacy path, provider is set to NULL at creation
 * time and intended_provider is stored in metadata. The actual provider is only
 * assigned atomically by tryClaimTaskSlot when a run slot becomes available.
 *
 * This prevents premature provider lock-in and ensures provider assignment
 * happens only when a real slot is claimed.
 */

const { TEST_MODELS } = require('./test-helpers');

// Provider registry mock
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

describe('Deferred Provider Assignment', () => {
  let scheduler;
  let mockDb;
  let mocks;

  beforeEach(() => {
    const modPath = require.resolve('../execution/queue-scheduler');
    delete require.cache[modPath];
    scheduler = require('../execution/queue-scheduler');

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      prepare: vi.fn(),
      listTasks: vi.fn().mockReturnValue([]),
      listOllamaHosts: vi.fn().mockReturnValue([]),
      getConfig: vi.fn().mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        return null;
      }),
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
        if (key === 'max_api_concurrent') return 4;
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

    const serverConfig = require('../config');
    vi.spyOn(serverConfig, 'isOptIn').mockImplementation((key) => {
      const value = mockDb.getConfig(key);
      if (value === null || value === undefined) return false;
      const normalized = String(value).toLowerCase().trim();
      return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── resolveEffectiveProvider ─────────────────────────────

  describe('resolveEffectiveProvider', () => {
    it('returns task.provider when set', () => {
      const result = scheduler.resolveEffectiveProvider({ provider: 'codex' });
      expect(result).toBe('codex');
    });

    it('falls back to intended_provider from metadata string', () => {
      const result = scheduler.resolveEffectiveProvider({
        provider: null,
        metadata: JSON.stringify({ intended_provider: 'groq' }),
      });
      expect(result).toBe('groq');
    });

    it('falls back to intended_provider from metadata object', () => {
      const result = scheduler.resolveEffectiveProvider({
        provider: null,
        metadata: { intended_provider: 'deepinfra' },
      });
      expect(result).toBe('deepinfra');
    });

    it('returns empty string when no provider or intended_provider', () => {
      const result = scheduler.resolveEffectiveProvider({ provider: null, metadata: null });
      expect(result).toBe('');
    });

    it('normalizes provider to lowercase', () => {
      const result = scheduler.resolveEffectiveProvider({ provider: 'CODEX' });
      expect(result).toBe('codex');
    });

    it('normalizes intended_provider to lowercase', () => {
      const result = scheduler.resolveEffectiveProvider({
        provider: null,
        metadata: JSON.stringify({ intended_provider: 'DeepInfra' }),
      });
      expect(result).toBe('deepinfra');
    });

    it('handles malformed metadata JSON gracefully', () => {
      const result = scheduler.resolveEffectiveProvider({
        provider: null,
        metadata: '{broken json',
      });
      expect(result).toBe('');
    });

    it('prefers task.provider over metadata intended_provider', () => {
      const result = scheduler.resolveEffectiveProvider({
        provider: 'ollama',
        metadata: JSON.stringify({ intended_provider: 'codex' }),
      });
      expect(result).toBe('ollama');
    });
  });

  // ── categorizeQueuedTasks with deferred provider ────────

  describe('categorizeQueuedTasks with null provider', () => {
    it('categorizes task with null provider using intended_provider from metadata', () => {
      const tasks = [{
        id: 'deferred-1',
        provider: null,
        model: TEST_MODELS.DEFAULT,
        metadata: JSON.stringify({ intended_provider: 'ollama' }),
      }];

      const result = scheduler.categorizeQueuedTasks(tasks, true);
      expect(result.ollamaTasks).toHaveLength(1);
      expect(result.ollamaTasks[0]._effectiveProvider).toBe('ollama');
    });

    it('categorizes null-provider codex task correctly', () => {
      const tasks = [{
        id: 'deferred-2',
        provider: null,
        metadata: JSON.stringify({ intended_provider: 'codex' }),
      }];

      const result = scheduler.categorizeQueuedTasks(tasks, true);
      expect(result.codexTasks).toHaveLength(1);
      expect(result.codexTasks[0]._effectiveProvider).toBe('codex');
    });

    it('categorizes null-provider API task correctly', () => {
      const tasks = [{
        id: 'deferred-3',
        provider: null,
        metadata: JSON.stringify({ intended_provider: 'groq' }),
      }];

      const result = scheduler.categorizeQueuedTasks(tasks, true);
      expect(result.apiTasks).toHaveLength(1);
      expect(result.apiTasks[0]._effectiveProvider).toBe('groq');
    });

    it('marks task as invalid when neither provider nor intended_provider is set', () => {
      const tasks = [{
        id: 'orphan-1',
        provider: null,
        metadata: null,
      }];

      const result = scheduler.categorizeQueuedTasks(tasks, true);
      expect(result.invalidTasks).toHaveLength(1);
    });

    it('stamps _effectiveProvider on tasks with explicit provider too', () => {
      const tasks = [{
        id: 'explicit-1',
        provider: 'anthropic',
        metadata: null,
      }];

      const result = scheduler.categorizeQueuedTasks(tasks, true);
      expect(result.apiTasks).toHaveLength(1);
      expect(result.apiTasks[0]._effectiveProvider).toBe('anthropic');
    });
  });

  // ── Queue processing with deferred providers ─────────────

  describe('processQueueInternal with deferred providers', () => {
    it('starts an API task that has null provider but intended_provider in metadata', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      const _listFn = mockDb.listQueuedTasksLightweight = vi.fn().mockReturnValue([{
        id: 'api-deferred-1',
        provider: null,
        model: null,
        task_description: 'Test deferred API task',
        metadata: JSON.stringify({ intended_provider: 'groq' }),
        created_at: new Date().toISOString(),
      }]);

      mocks.safeStartTask.mockReturnValue(true);

      scheduler.processQueueInternal({ skipRecentProcessGuard: true });

      expect(mocks.safeStartTask).toHaveBeenCalledWith('api-deferred-1', expect.anything());
    });

    it('starts a codex task that has null provider but intended_provider in metadata', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      mockDb.listQueuedTasksLightweight = vi.fn().mockReturnValue([{
        id: 'codex-deferred-1',
        provider: null,
        model: null,
        task_description: 'Test deferred codex task',
        metadata: JSON.stringify({ intended_provider: 'codex' }),
        created_at: new Date().toISOString(),
      }]);

      mocks.safeStartTask.mockReturnValue(true);

      scheduler.processQueueInternal({ skipRecentProcessGuard: true });

      expect(mocks.safeStartTask).toHaveBeenCalledWith('codex-deferred-1', expect.anything());
    });

    it('starts an ollama task that has null provider but intended_provider in metadata', () => {
      mockDb.getRunningCount.mockReturnValue(0);
      mockDb.listTasks.mockReturnValue([]);

      const host = { id: 'h1', name: 'TestHost', running_tasks: 0, url: 'http://localhost:11434' };
      mockDb.selectOllamaHostForModel.mockReturnValue({ host });

      mockDb.listQueuedTasksLightweight = vi.fn().mockReturnValue([{
        id: 'ollama-deferred-1',
        provider: null,
        model: TEST_MODELS.DEFAULT,
        task_description: 'Test deferred ollama task',
        metadata: JSON.stringify({ intended_provider: 'ollama' }),
        created_at: new Date().toISOString(),
      }]);

      mocks.safeStartTask.mockReturnValue(true);

      scheduler.processQueueInternal({ skipRecentProcessGuard: true });

      expect(mocks.safeStartTask).toHaveBeenCalledWith('ollama-deferred-1', expect.anything());
    });
  });
});
