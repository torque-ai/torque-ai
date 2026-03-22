/**
 * Tests: Free-tier auto-scale rules
 *
 * Covers:
 * - Auto-scale triggers when queue depth exceeds threshold
 * - Auto-scale respects cooldown
 * - Auto-scale disabled by default
 * - Config CRUD works (MCP handler)
 * - Tasks with explicit provider override bypass auto-scale
 */

const logger = require('../logger');

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.spyOn(logger, 'child').mockReturnValue(mockLogger);

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockReturnValue(null),
}));

describe('Free-tier auto-scale', () => {
  let scheduler;
  let mockDb;
  let mocks;
  let mockTracker;

  beforeEach(() => {
    // Clear module cache for fresh singleton state
    const modPath = require.resolve('../execution/queue-scheduler');
    delete require.cache[modPath];
    scheduler = require('../execution/queue-scheduler');

    mockTracker = {
      getAvailableProviders: vi.fn().mockReturnValue([
        { provider: 'groq', dailyRemainingPct: 0.9 },
        { provider: 'cerebras', dailyRemainingPct: 0.8 },
      ]),
      getAvailableProvidersSmart: vi.fn().mockReturnValue([
        { provider: 'groq', dailyRemainingPct: 0.9 },
        { provider: 'cerebras', dailyRemainingPct: 0.8 },
      ]),
    };

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
      listTasks: vi.fn().mockReturnValue([]),
      listQueuedTasksLightweight: vi.fn().mockReturnValue([]),
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
        if (key === 'max_concurrent') return 20;
        if (key === 'max_per_host') return 4;
        if (key === 'max_codex_concurrent') return 3;
        if (key === 'max_ollama_concurrent') return 8;
        if (key === 'max_api_concurrent') return 4;
        return defaultVal;
      }),
      isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
      getFreeQuotaTracker: vi.fn().mockReturnValue(mockTracker),
      cleanupOrphanedRetryTimeouts: vi.fn(),
    };

    scheduler.init({
      db: mockDb,
      ...mocks,
    });

    // Bypass recent-process guard for tests
    const originalProcess = scheduler.processQueueInternal;
    scheduler.processQueueInternal = (options = {}) => originalProcess({
      skipRecentProcessGuard: true,
      ...options,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  // ── Helper ────────────────────────────────────────────────

  function makeTask(overrides = {}) {
    return {
      id: overrides.id || 'task-' + Math.random().toString(36).slice(2, 10),
      provider: overrides.provider || 'codex',
      model: overrides.model || null,
      task_description: overrides.task_description || 'Test task',
      metadata: overrides.metadata || null,
      ...overrides,
    };
  }

  function setupConfigForAutoScale(overrides = {}) {
    const configValues = {
      codex_enabled: '1',
      free_tier_auto_scale_enabled: overrides.enabled !== undefined ? String(overrides.enabled) : 'true',
      free_tier_queue_depth_threshold: String(overrides.threshold || 3),
      free_tier_cooldown_seconds: String(overrides.cooldown !== undefined ? overrides.cooldown : 60),
      codex_overflow_to_local: '0',
      ...overrides.extraConfig,
    };

    mockDb.getConfig.mockImplementation((key) => configValues[key] || null);
  }

  function setupCodexQueueWithDepth(count, metadataOverrides = {}) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      tasks.push(makeTask({
        id: `codex-task-${i}`,
        provider: 'codex',
        metadata: JSON.stringify({
          smart_routing: true,
          complexity: 'normal',
          ...metadataOverrides,
        }),
      }));
    }
    mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);
    return tasks;
  }

  function setRunningCodexCount(count) {
    const runningCodexTasks = Array.from({ length: count }, (_, index) =>
      makeTask({
        id: `running-codex-${index}`,
        provider: 'codex',
        status: 'running',
        metadata: JSON.stringify({ complexity: 'normal' }),
      })
    );

    mockDb.getRunningCount.mockReturnValue(count);
    mockDb.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return runningCodexTasks;
      return [];
    });
  }

  // ── Auto-scale disabled by default ─────────────────────────

  describe('disabled by default', () => {
    it('does NOT reroute tasks when auto-scale is disabled', () => {
      setupConfigForAutoScale({ enabled: 'false' });
      setupCodexQueueWithDepth(5);

      scheduler.processQueueInternal();

      // No updateTaskStatus calls for free-tier rerouting
      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && JSON.parse(c[2].metadata).free_tier_auto_scale
      );
      expect(rerouteCalls).toHaveLength(0);
    });

    it('does NOT reroute when config is missing (defaults to disabled)', () => {
      // getConfig returns null for all keys
      mockDb.getConfig.mockReturnValue(null);
      setupCodexQueueWithDepth(5);

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && JSON.parse(c[2].metadata).free_tier_auto_scale
      );
      expect(rerouteCalls).toHaveLength(0);
    });
  });

  // ── Auto-scale triggers on queue depth ─────────────────────

  describe('triggers when queue depth exceeds threshold', () => {
    it('reroutes tasks when codex queue depth > threshold', () => {
      setupConfigForAutoScale({ threshold: 2, cooldown: 0 });
      setupCodexQueueWithDepth(4);

      scheduler.processQueueInternal();

      // Should have rerouted at least one task to free-tier
      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.provider === 'groq' && c[2]?.metadata
      );
      expect(rerouteCalls.length).toBeGreaterThan(0);

      // Verify metadata includes auto-scale flag
      const meta = JSON.parse(rerouteCalls[0][2].metadata);
      expect(meta.free_tier_auto_scale).toBe(true);
      expect(meta.free_tier_overflow).toBe(true);
      expect(meta.original_provider).toBe('codex');
    });

    it('does NOT trigger when queue depth <= threshold', () => {
      setupConfigForAutoScale({ threshold: 5, cooldown: 0 });
      setupCodexQueueWithDepth(3); // 3 <= 5

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );
      expect(rerouteCalls).toHaveLength(0);
    });

    it('does NOT reroute complex tasks when Codex slots are full', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setRunningCodexCount(3);

      const tasks = [
        makeTask({
          id: 'complex-1',
          provider: 'codex',
          metadata: JSON.stringify({ smart_routing: true, complexity: 'complex' }),
        }),
        makeTask({
          id: 'normal-1',
          provider: 'codex',
          metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
        }),
      ];
      mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);

      scheduler.processQueueInternal();

      // complex-1 should NOT be rerouted
      const complexReroute = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[0] === 'complex-1' && c[2]?.provider === 'groq'
      );
      expect(complexReroute).toHaveLength(0);

      // normal-1 should be rerouted
      const normalReroute = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[0] === 'normal-1' && c[2]?.provider === 'groq'
      );
      expect(normalReroute).toHaveLength(1);
    });

    it('does NOT trigger when no free-tier providers available', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setupCodexQueueWithDepth(4);

      mockTracker.getAvailableProvidersSmart.mockReturnValue([]);
      mockTracker.getAvailableProviders.mockReturnValue([]);

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );
      expect(rerouteCalls).toHaveLength(0);
    });
  });

  // ── Cooldown respect ───────────────────────────────────────

  describe('respects cooldown', () => {
    it('does NOT trigger again within cooldown period', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));
        setupConfigForAutoScale({ threshold: 1, cooldown: 60 });
        setupCodexQueueWithDepth(4);

        // First activation should succeed
        scheduler.processQueueInternal();
        const firstReroute = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
            c[2].metadata.includes('free_tier_auto_scale')
        );
        expect(firstReroute.length).toBeGreaterThan(0);

        // Reset mocks for second call
        mockDb.updateTaskStatus.mockClear();
        setupCodexQueueWithDepth(4);

        // Advance only 30 seconds — should be within cooldown
        vi.advanceTimersByTime(30000);
        scheduler.processQueueInternal();

        const secondReroute = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
            c[2].metadata.includes('free_tier_auto_scale')
        );
        expect(secondReroute).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('triggers again after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));
        setupConfigForAutoScale({ threshold: 1, cooldown: 60 });
        setupCodexQueueWithDepth(4);

        // First activation
        scheduler.processQueueInternal();

        // Reset mocks
        mockDb.updateTaskStatus.mockClear();
        setupCodexQueueWithDepth(4);

        // Advance past cooldown
        vi.advanceTimersByTime(61000);
        scheduler.processQueueInternal();

        const secondReroute = mockDb.updateTaskStatus.mock.calls.filter(
          (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
            c[2].metadata.includes('free_tier_auto_scale')
        );
        expect(secondReroute.length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('_resetAutoScaleCooldown clears the cooldown timer', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 9999 });
      setupCodexQueueWithDepth(4);

      // First activation sets cooldown
      scheduler.processQueueInternal();
      expect(scheduler._getLastAutoScaleActivation()).toBeGreaterThan(0);

      // Reset cooldown
      scheduler._resetAutoScaleCooldown();
      expect(scheduler._getLastAutoScaleActivation()).toBe(0);

      // Should activate again immediately
      mockDb.updateTaskStatus.mockClear();
      setupCodexQueueWithDepth(4);
      scheduler.processQueueInternal();

      const reroutes = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );
      expect(reroutes.length).toBeGreaterThan(0);
    });
  });

  // ── Provider override bypass ───────────────────────────────

  describe('explicit provider override bypass', () => {
    it('does NOT reroute user-specified provider tasks', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });

      const tasks = [
        makeTask({
          id: 'user-override-1',
          provider: 'codex',
          metadata: JSON.stringify({
            user_provider_override: true,
            complexity: 'normal',
          }),
        }),
        makeTask({
          id: 'user-override-2',
          provider: 'codex',
          metadata: JSON.stringify({
            user_provider_override: true,
            complexity: 'simple',
          }),
        }),
      ];
      mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => (c[0] === 'user-override-1' || c[0] === 'user-override-2') &&
          c[2]?.provider === 'groq'
      );
      expect(rerouteCalls).toHaveLength(0);
    });

    it('does NOT reroute tasks without smart_routing or auto_routed', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });

      const tasks = [
        makeTask({
          id: 'explicit-1',
          provider: 'codex',
          metadata: JSON.stringify({ complexity: 'normal' }),
        }),
        makeTask({
          id: 'explicit-2',
          provider: 'codex',
          metadata: JSON.stringify({ complexity: 'simple' }),
        }),
      ];
      mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );
      expect(rerouteCalls).toHaveLength(0);
    });

    it('reroutes smart-routed tasks but skips explicit ones in the same queue once Codex is full', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setRunningCodexCount(3);

      const tasks = [
        makeTask({
          id: 'explicit-task',
          provider: 'codex',
          metadata: JSON.stringify({ complexity: 'normal' }),
        }),
        makeTask({
          id: 'smart-task',
          provider: 'codex',
          metadata: JSON.stringify({ smart_routing: true, complexity: 'normal' }),
        }),
        makeTask({
          id: 'auto-task',
          provider: 'codex',
          metadata: JSON.stringify({ auto_routed: true, complexity: 'simple' }),
        }),
      ];
      mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);

      scheduler.processQueueInternal();

      // explicit-task: NOT rerouted
      const explicitReroute = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[0] === 'explicit-task' && c[2]?.provider === 'groq'
      );
      expect(explicitReroute).toHaveLength(0);

      // smart-task: rerouted
      const smartReroute = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[0] === 'smart-task' && c[2]?.provider === 'groq'
      );
      expect(smartReroute).toHaveLength(1);

      // auto-task: rerouted
      const autoReroute = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[0] === 'auto-task' && c[2]?.provider === 'groq'
      );
      expect(autoReroute).toHaveLength(1);
    });
  });

  // ── Config CRUD (MCP handler) ──────────────────────────────

  describe('configure_free_tier_auto_scale handler', () => {
    let handler;
    let configCoreModule;
    let setConfigSpy;
    let getConfigSpy;

    beforeEach(() => {
      configCoreModule = require('../db/config-core');

      const configStore = {};
      setConfigSpy = vi.spyOn(configCoreModule, 'setConfig').mockImplementation((key, value) => {
        configStore[key] = value;
      });
      getConfigSpy = vi.spyOn(configCoreModule, 'getConfig').mockImplementation((key) => configStore[key] || null);

      handler = require('../handlers/automation-handlers');
    });

    afterEach(() => {
      setConfigSpy.mockRestore();
      getConfigSpy.mockRestore();
    });

    it('sets enabled config', () => {
      const result = handler.handleConfigureFreeTierAutoScale({ enabled: true });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_auto_scale_enabled', 'true');
      expect(result.content[0].text).toContain('enabled');
    });

    it('sets queue_depth_threshold config', () => {
      handler.handleConfigureFreeTierAutoScale({ queue_depth_threshold: 5 });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_queue_depth_threshold', '5');
    });

    it('sets cooldown_seconds config', () => {
      handler.handleConfigureFreeTierAutoScale({ cooldown_seconds: 120 });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_cooldown_seconds', '120');
    });

    it('clamps threshold to minimum of 1', () => {
      handler.handleConfigureFreeTierAutoScale({ queue_depth_threshold: 0 });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_queue_depth_threshold', '1');
    });

    it('clamps cooldown to minimum of 0', () => {
      handler.handleConfigureFreeTierAutoScale({ cooldown_seconds: -10 });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_cooldown_seconds', '0');
    });

    it('returns current settings when no args provided', () => {
      const result = handler.handleConfigureFreeTierAutoScale({});

      expect(result.content[0].text).toContain('Free-Tier Auto-Scale Configuration');
      expect(result.content[0].text).toContain('Current Settings');
    });

    it('sets all three configs at once', () => {
      handler.handleConfigureFreeTierAutoScale({
        enabled: true,
        queue_depth_threshold: 10,
        cooldown_seconds: 30,
      });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_auto_scale_enabled', 'true');
      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_queue_depth_threshold', '10');
      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_cooldown_seconds', '30');
    });

    it('disabling auto-scale sets config to false', () => {
      handler.handleConfigureFreeTierAutoScale({ enabled: false });

      expect(setConfigSpy).toHaveBeenCalledWith('free_tier_auto_scale_enabled', 'false');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles tasks with null metadata gracefully', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });

      const tasks = [
        makeTask({ id: 'null-meta', provider: 'codex', metadata: null }),
        makeTask({ id: 'no-meta', provider: 'codex' }),
      ];
      mockDb.listQueuedTasksLightweight.mockReturnValue(tasks);

      // Should not throw
      expect(() => scheduler.processQueueInternal()).not.toThrow();
    });

    it('handles missing getFreeQuotaTracker gracefully', () => {
      // Re-init without getFreeQuotaTracker
      const modPath = require.resolve('../execution/queue-scheduler');
      delete require.cache[modPath];
      scheduler = require('../execution/queue-scheduler');

      scheduler.init({
        db: mockDb,
        ...mocks,
        getFreeQuotaTracker: undefined,
      });

      const original = scheduler.processQueueInternal;
      scheduler.processQueueInternal = (opts = {}) =>
        original({ skipRecentProcessGuard: true, ...opts });

      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setupCodexQueueWithDepth(4);

      // Should not throw — auto-scale guard checks typeof
      expect(() => scheduler.processQueueInternal()).not.toThrow();
    });

    it('clears model when rerouting to free-tier', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setupCodexQueueWithDepth(3);
      setRunningCodexCount(3); // Fill Codex slots to trigger overflow rerouting

      scheduler.processQueueInternal();

      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );

      expect(rerouteCalls.length).toBeGreaterThan(0);
      expect(rerouteCalls[0][2].model).toBeNull();
    });

    it('falls back to getAvailableProviders when Codex is full and getAvailableProvidersSmart is absent', () => {
      setupConfigForAutoScale({ threshold: 1, cooldown: 0 });
      setupCodexQueueWithDepth(3);
      setRunningCodexCount(3);

      // Remove the smart method
      delete mockTracker.getAvailableProvidersSmart;

      scheduler.processQueueInternal();

      expect(mockTracker.getAvailableProviders).toHaveBeenCalled();
    });
  });

  // ── Schema seed defaults ───────────────────────────────────

  describe('schema seed defaults', () => {
    it('seeds free_tier_auto_scale_enabled as false', () => {
      // This tests that the default config values are correct
      // by verifying the feature is disabled by default in the scheduler
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_enabled') return '1';
        // Return actual default values
        if (key === 'free_tier_auto_scale_enabled') return 'false';
        if (key === 'free_tier_queue_depth_threshold') return '3';
        if (key === 'free_tier_cooldown_seconds') return '60';
        return null;
      });

      setupCodexQueueWithDepth(10);
      scheduler.processQueueInternal();

      // With enabled=false, no auto-scale should happen despite deep queue
      const rerouteCalls = mockDb.updateTaskStatus.mock.calls.filter(
        (c) => c[2]?.metadata && typeof c[2].metadata === 'string' &&
          c[2].metadata.includes('free_tier_auto_scale')
      );
      expect(rerouteCalls).toHaveLength(0);
    });
  });
});
