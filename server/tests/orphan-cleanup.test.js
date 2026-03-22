/**
 * Unit Tests: maintenance/orphan-cleanup.js
 *
 * Tests stall threshold calculation, timer lifecycle, stalled task detection,
 * host failover cleanup, and stale task timeout handling.
 */

describe('Orphan Cleanup', () => {
  let orphanCleanup;

  beforeEach(() => {
    orphanCleanup = require('../maintenance/orphan-cleanup');
  });

  afterEach(() => {
    orphanCleanup.stopTimers();
    vi.restoreAllMocks();
  });

  // ── Constants ─────────────────────────────────────────────

  describe('constants', () => {
    it('exports BASE_STALL_THRESHOLD_SECONDS = 180', () => {
      expect(orphanCleanup.BASE_STALL_THRESHOLD_SECONDS).toBe(180);
    });

    it('exports PROVIDER_STALL_THRESHOLDS with all expected providers', () => {
      const thresholds = orphanCleanup.PROVIDER_STALL_THRESHOLDS;
      expect(thresholds['hashline-ollama']).toBe(300);
      expect(thresholds['ollama']).toBe(240);
      expect(thresholds['claude-cli']).toBe(600);
      expect(thresholds['codex']).toBe(600);
      expect(thresholds['groq']).toBe(120);
    });

    it('exports PROVIDER_STALL_CONFIG_KEYS mapping', () => {
      const keys = orphanCleanup.PROVIDER_STALL_CONFIG_KEYS;
      expect(keys['hashline-ollama']).toBe('stall_threshold_hashline');
      expect(keys['ollama']).toBe('stall_threshold_ollama');
      expect(keys['codex']).toBe('stall_threshold_codex');
    });
  });

  // ── getStallThreshold ─────────────────────────────────────

  describe('getStallThreshold', () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        getConfig: vi.fn().mockReturnValue(null),
      };
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses: new Map(),
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });
    });

    it('returns provider default for unknown model', () => {
      expect(orphanCleanup.getStallThreshold(null, 'hashline-ollama')).toBe(300);
      expect(orphanCleanup.getStallThreshold(null, 'ollama')).toBe(240);
    });

    it('returns 600 for codex (10-minute stall detection)', () => {
      expect(orphanCleanup.getStallThreshold('gpt-4', 'codex')).toBe(600);
    });

    it('returns runtime config override when set', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'stall_threshold_ollama') return '120';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'ollama')).toBe(120);
    });

    it('returns null when config explicitly disabled (value "0")', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'stall_threshold_hashline') return '0';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'hashline-ollama')).toBeNull();
    });

    it('scales threshold for 32b models', () => {
      const threshold = orphanCleanup.getStallThreshold('qwen2.5-coder:32b', 'hashline-ollama');
      expect(threshold).toBeGreaterThanOrEqual(360);
    });

    it('scales threshold for 14b models', () => {
      const threshold = orphanCleanup.getStallThreshold('qwen2.5:14b', 'hashline-ollama');
      expect(threshold).toBeGreaterThanOrEqual(240);
    });

    it('scales threshold for 8b models', () => {
      const threshold = orphanCleanup.getStallThreshold('llama3:8b', 'hashline-ollama');
      expect(threshold).toBeGreaterThanOrEqual(210);
    });

    it('applies 1.5x thinking multiplier for qwen3 models', () => {
      const baseThreshold = orphanCleanup.getStallThreshold('gemma3:4b', 'ollama');
      const thinkingThreshold = orphanCleanup.getStallThreshold('qwen3:8b', 'ollama');
      // qwen3:8b is a thinking model AND 8b, so threshold >= 210 * 1.5 = 315
      expect(thinkingThreshold).toBeGreaterThan(baseThreshold);
    });

    it('applies 1.5x thinking multiplier for deepseek-r1 models', () => {
      const threshold = orphanCleanup.getStallThreshold('deepseek-r1:14b', 'ollama');
      // deepseek-r1:14b = 14b threshold (240) * 1.5 = 360
      expect(threshold).toBe(360);
    });

    it('handles codestral with size suffix via size-based detection', () => {
      // codestral:22b matches /:(\d+)b/ → sizeB=22 >= 14 → max(threshold, 240)
      const threshold = orphanCleanup.getStallThreshold('codestral:22b', 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(240);
    });

    it('handles codestral without size suffix via name-based detection', () => {
      // No :Xb suffix, falls through to name-based checks
      const threshold = orphanCleanup.getStallThreshold('codestral', 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(300);
    });

    it('uses BASE_STALL_THRESHOLD when provider not in lookup', () => {
      const threshold = orphanCleanup.getStallThreshold('some-model', 'unknown-provider');
      expect(threshold).toBe(180);
    });

    it('config value "null" disables stall detection (returns null)', () => {
      // Config value "null" is treated as explicit disable — returns null
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'stall_threshold_hashline') return 'null';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'hashline-ollama')).toBeNull();
    });
  });

  // ── startTimers / stopTimers ──────────────────────────────

  describe('startTimers / stopTimers', () => {
    beforeEach(() => {
      orphanCleanup.init({
        db: { getConfig: vi.fn().mockReturnValue('0'), reconcileHostTaskCounts: vi.fn(), getRunningTasksLightweight: vi.fn().mockReturnValue([]) },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses: new Map(),
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });
    });

    it('starts without throwing', () => {
      expect(() => orphanCleanup.startTimers()).not.toThrow();
    });

    it('stops without throwing (even if never started)', () => {
      expect(() => orphanCleanup.stopTimers()).not.toThrow();
    });

    it('starts then stops without throwing', () => {
      orphanCleanup.startTimers();
      expect(() => orphanCleanup.stopTimers()).not.toThrow();
    });
  });

  // ── checkStalledTasks ─────────────────────────────────────

  describe('checkStalledTasks', () => {
    let mockDb, mockCancelTask, mockTryStallRecovery, runningProcesses;

    beforeEach(() => {
      runningProcesses = new Map();
      mockCancelTask = vi.fn();
      mockTryStallRecovery = vi.fn();

      mockDb = {
        getConfig: vi.fn().mockReturnValue('1'),
        reconcileHostTaskCounts: vi.fn(),
        getRunningTasksLightweight: vi.fn().mockReturnValue([]),
      };

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue(null),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });
    });

    it('returns empty array when no running processes', () => {
      const result = orphanCleanup.checkStalledTasks();
      expect(result).toEqual([]);
    });

    it('returns stalled tasks when activity.isStalled is true', () => {
      runningProcesses.set('task-1', { process: { pid: 1 } });
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue({ isStalled: true, lastActivitySeconds: 300 }),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      const result = orphanCleanup.checkStalledTasks();
      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-1');
      expect(result[0].lastActivitySeconds).toBe(300);
    });

    it('calls tryStallRecovery when autoCancel=true and recovery enabled', () => {
      runningProcesses.set('task-1', { process: { pid: 1 } });
      const activity = { isStalled: true, lastActivitySeconds: 300 };
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue(activity),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.checkStalledTasks(true);
      expect(mockTryStallRecovery).toHaveBeenCalledWith('task-1', activity);
    });

    it('calls cancelTask when autoCancel=true but recovery disabled', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'stall_recovery_enabled') return '0';
        return '1';
      });
      runningProcesses.set('task-1', { process: { pid: 1 } });
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue({ isStalled: true, lastActivitySeconds: 400 }),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.checkStalledTasks(true);
      expect(mockCancelTask).toHaveBeenCalledWith('task-1', expect.stringContaining('Stalled'));
      expect(mockTryStallRecovery).not.toHaveBeenCalled();
    });

    it('extends stall threshold by 50% when the process is still alive', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const activity = { isStalled: true, lastActivitySeconds: 150, stallThreshold: 100 };
      runningProcesses.set('task-1', { process: { pid: 123 } });
      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger,
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue(activity),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      const result = orphanCleanup.checkStalledTasks(true);
      expect(result).toEqual([]);
      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockTryStallRecovery).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still alive'));
    });

    it('cancels stalled tasks when process is not alive', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const activity = { isStalled: true, lastActivitySeconds: 150, stallThreshold: 100 };
      runningProcesses.set('task-2', { process: { pid: 456 } });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'stall_recovery_enabled') return '0';
        return '1';
      });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('process missing');
        err.code = 'ESRCH';
        throw err;
      });

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger,
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue(activity),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.checkStalledTasks(true);
      expect(mockCancelTask).toHaveBeenCalledWith('task-2', expect.stringContaining('Stalled'));
    });

    it('skips tasks where activity is null', () => {
      runningProcesses.set('task-1', { process: { pid: 1 } });
      // getTaskActivity returns null by default
      const result = orphanCleanup.checkStalledTasks(true);
      expect(result).toEqual([]);
      expect(mockCancelTask).not.toHaveBeenCalled();
    });

    it('skips tasks where activity.isStalled is false', () => {
      runningProcesses.set('task-1', { process: { pid: 1 } });
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn().mockReturnValue({ isStalled: false, lastActivitySeconds: 10 }),
        tryStallRecovery: mockTryStallRecovery,
        safeConfigInt: vi.fn(),
      });

      const result = orphanCleanup.checkStalledTasks();
      expect(result).toEqual([]);
    });
  });

  // ── checkStaleRunningTasks ────────────────────────────────

  describe('checkStaleRunningTasks', () => {
    let mockDb, mockCancelTask, runningProcesses;

    beforeEach(() => {
      runningProcesses = new Map();
      mockCancelTask = vi.fn();
      mockDb = {
        getConfig: vi.fn().mockReturnValue('0'),
        reconcileHostTaskCounts: vi.fn(),
        getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        updateTaskStatus: vi.fn(),
      };

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });
    });

    it('reconciles host task counts on each check', () => {
      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.reconcileHostTaskCounts).toHaveBeenCalled();
    });

    it('cancels tasks that exceeded their timeout', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString(); // 35 min ago
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-old', started_at: pastTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      // Not in runningProcesses, so should update DB directly
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-old', 'cancelled', expect.objectContaining({
        error_output: expect.stringContaining('exceeded'),
      }));
    });

    it('uses cancelTask for tasks in runningProcesses map', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      runningProcesses.set('task-tracked', { process: { pid: 123 } });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-tracked', started_at: pastTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockCancelTask).toHaveBeenCalledWith('task-tracked', expect.stringContaining('Timeout'));
    });

    it('skips tasks without started_at', () => {
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'no-start', started_at: null, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockCancelTask).not.toHaveBeenCalled();
    });

    it('skips tasks still within timeout', () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-fresh', started_at: recentTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('defaults to 30 min timeout if timeout_minutes is undefined', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-default', started_at: pastTime, timeout_minutes: undefined },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.updateTaskStatus).toHaveBeenCalled();
    });
  });

  // ── cleanupOrphanedHostTasks ──────────────────────────────

  describe('cleanupOrphanedHostTasks', () => {
    let mockDb, mockCancelTask, mockProcessQueue, mockTryLocalFirst, runningProcesses, stallRecoveryAttempts;

    beforeEach(() => {
      runningProcesses = new Map();
      stallRecoveryAttempts = new Map();
      mockCancelTask = vi.fn();
      mockProcessQueue = vi.fn();
      mockTryLocalFirst = vi.fn();

      mockDb = {
        getConfig: vi.fn().mockReturnValue('0'),
        getRunningTasksForHost: vi.fn().mockReturnValue([]),
        updateTaskStatus: vi.fn(),
        incrementRetry: vi.fn().mockReturnValue({ shouldRetry: false }),
        reconcileHostTaskCounts: vi.fn(),
        getRunningTasksLightweight: vi.fn().mockReturnValue([]),
      };

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts,
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: mockProcessQueue,
        tryLocalFirstFallback: mockTryLocalFirst,
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });
    });

    it('does nothing when no running tasks on host', () => {
      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'TestHost');
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('marks running tasks as failed when host goes down', () => {
      mockDb.getRunningTasksForHost.mockReturnValue([
        { id: 'task-1', error_output: '' },
      ]);

      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'TestHost');

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-1', 'failed', expect.objectContaining({
        error_output: expect.stringContaining('HOST FAILOVER'),
      }));
    });

    it('removes tracked processes from runningProcesses map', () => {
      const mockProc = { process: { pid: 123 }, timeoutHandle: null, startupTimeoutHandle: null };
      runningProcesses.set('task-1', mockProc);
      stallRecoveryAttempts.set('task-1', 2);

      mockDb.getRunningTasksForHost.mockReturnValue([
        { id: 'task-1', error_output: '' },
      ]);

      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'TestHost');

      expect(runningProcesses.has('task-1')).toBe(false);
      expect(stallRecoveryAttempts.has('task-1')).toBe(false);
    });

    it('triggers local-first retry when incrementRetry allows it', () => {
      mockDb.getRunningTasksForHost.mockReturnValue([
        { id: 'task-1', error_output: '' },
      ]);
      mockDb.incrementRetry.mockReturnValue({ shouldRetry: true });

      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'FailedHost');

      expect(mockTryLocalFirst).toHaveBeenCalledWith('task-1', expect.any(Object), expect.stringContaining('FailedHost'));
    });

    it('calls processQueue after cleanup to pick up retried tasks', () => {
      mockDb.getRunningTasksForHost.mockReturnValue([
        { id: 'task-1', error_output: '' },
      ]);

      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'TestHost');
      expect(mockProcessQueue).toHaveBeenCalled();
    });

    it('clears timeout handles on orphaned processes', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const timeoutHandle = setTimeout(() => {}, 99999);
      const startupHandle = setTimeout(() => {}, 99999);
      runningProcesses.set('task-1', {
        process: { pid: 1 },
        timeoutHandle,
        startupTimeoutHandle: startupHandle,
      });

      mockDb.getRunningTasksForHost.mockReturnValue([{ id: 'task-1', error_output: '' }]);
      orphanCleanup.cleanupOrphanedHostTasks('host-1', 'TestHost');

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(startupHandle);

      clearTimeout(timeoutHandle);
      clearTimeout(startupHandle);
      clearTimeoutSpy.mockRestore();
    });
  });
});
