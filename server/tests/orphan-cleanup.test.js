/**
 * Unit Tests: maintenance/orphan-cleanup.js
 *
 * Tests stall threshold calculation, timer lifecycle, stalled task detection,
 * host failover cleanup, and stale task timeout handling.
 */

const { TEST_MODELS: BASE_TEST_MODELS } = require('./test-helpers');

const TEST_MODELS = { ...BASE_TEST_MODELS, DEFAULT: 'qwen3-coder:30b' };

describe('Orphan Cleanup', () => {
  let orphanCleanup;
  let serverConfig;

  beforeEach(() => {
    // eslint-disable-next-line torque/no-reset-modules-in-each -- requires orphan-cleanup and config fresh each run
    vi.resetModules();
    orphanCleanup = require('../maintenance/orphan-cleanup');
    serverConfig = require('../config');
    vi.spyOn(serverConfig, 'get').mockReturnValue(null);
    vi.spyOn(serverConfig, 'getBool').mockImplementation((key) => key === 'stall_recovery_enabled');
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
      expect(thresholds['ollama']).toBe(240);
      expect(thresholds['claude-cli']).toBe(600);
      expect(thresholds['codex']).toBe(600);
      expect(thresholds['groq']).toBe(120);
    });

    it('exports PROVIDER_STALL_CONFIG_KEYS mapping', () => {
      const keys = orphanCleanup.PROVIDER_STALL_CONFIG_KEYS;
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
      expect(orphanCleanup.getStallThreshold(null, 'ollama')).toBe(240);
    });

    it('returns 600 for codex (10-minute stall detection)', () => {
      expect(orphanCleanup.getStallThreshold('gpt-4', 'codex')).toBe(600);
    });

    it('returns runtime config override when set', () => {
      serverConfig.get.mockImplementation((key) => {
        if (key === 'stall_threshold_ollama') return '120';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'ollama')).toBe(120);
    });

    it('returns null when config explicitly disabled (value "0")', () => {
      serverConfig.get.mockImplementation((key) => {
        if (key === 'stall_threshold_ollama') return '0';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'ollama')).toBeNull();
    });

    it('scales threshold for 32b models', () => {
      const threshold = orphanCleanup.getStallThreshold(TEST_MODELS.DEFAULT, 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(360);
    });

    it('scales threshold for 14b models', () => {
      const threshold = orphanCleanup.getStallThreshold('qwen2.5:14b', 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(240);
    });

    it('scales threshold for 8b models', () => {
      const threshold = orphanCleanup.getStallThreshold('llama3:8b', 'ollama');
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

    it('handles large models with size suffix via size-based detection', () => {
      // Large coder model with a :Xb suffix matches /:(\d+)b/ → sizeB >= 14 → max(threshold, 240)
      const threshold = orphanCleanup.getStallThreshold(TEST_MODELS.DEFAULT, 'ollama');
      expect(threshold).toBeGreaterThanOrEqual(240);
    });

    it('handles codestral without size suffix via parseModelSizeB range check', () => {
      // No :Xb suffix — parseModelSizeB returns 0, so no size-based scaling applies.
      // Falls through to provider default (ollama = 240).
      const threshold = orphanCleanup.getStallThreshold('codestral', 'ollama');
      expect(threshold).toBe(240);
    });

    it('uses BASE_STALL_THRESHOLD when provider not in lookup', () => {
      const threshold = orphanCleanup.getStallThreshold('some-model', 'unknown-provider');
      expect(threshold).toBe(180);
    });

    it('config value "null" disables stall detection (returns null)', () => {
      // Config value "null" is treated as explicit disable — returns null
      serverConfig.get.mockImplementation((key) => {
        if (key === 'stall_threshold_ollama') return 'null';
        return null;
      });
      expect(orphanCleanup.getStallThreshold('qwen3:8b', 'ollama')).toBeNull();
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
      serverConfig.getBool.mockReturnValue(false);
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
      expect(mockCancelTask).toHaveBeenCalledWith(
        'task-1',
        expect.stringContaining('Stalled'),
        { cancel_reason: 'stall' },
      );
      expect(mockTryStallRecovery).not.toHaveBeenCalled();
    });

    it('extends stall threshold by 50% when the process is still alive', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const activity = { isStalled: true, lastActivitySeconds: 150, stallThreshold: 100 };
      const reportRuntimeTaskProblem = vi.fn(() => ({ reported: true }));
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
        reportRuntimeTaskProblem,
        safeConfigInt: vi.fn(),
      });

      const result = orphanCleanup.checkStalledTasks(true);
      expect(result).toEqual([]);
      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockTryStallRecovery).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still alive'));
      expect(reportRuntimeTaskProblem).toHaveBeenCalledWith(expect.objectContaining({
        task: { id: 'task-1' },
        problem: 'stall_threshold_extended',
        details: expect.objectContaining({
          lastActivitySeconds: 150,
          stallThresholdSeconds: 100,
          aliveThresholdSeconds: 150,
        }),
      }));
    });

    it('cancels stalled tasks when process is not alive', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const activity = { isStalled: true, lastActivitySeconds: 150, stallThreshold: 100 };
      runningProcesses.set('task-2', { process: { pid: 456 } });
      serverConfig.getBool.mockReturnValue(false);
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
      expect(mockCancelTask).toHaveBeenCalledWith(
        'task-2',
        expect.stringContaining('Stalled'),
        { cancel_reason: 'stall' },
      );
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

  describe('checkZombieProcesses', () => {
    it('emits successful close for completed Codex output that outlives completion grace', async () => {
      const runningProcesses = new Map();
      const processRef = {
        pid: null,
        exitCode: null,
        killed: false,
        signalCode: null,
        emit: vi.fn(),
      };
      runningProcesses.set('task-completed-output', {
        provider: 'codex',
        process: processRef,
        completionDetected: true,
        startTime: Date.now() - 3 * 60 * 1000,
        lastOutputAt: Date.now() - 2 * 60 * 1000,
      });
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn().mockReturnValue({ id: 'task-completed-output', status: 'running' }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger,
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      await orphanCleanup.checkZombieProcesses();

      expect(processRef.emit).toHaveBeenCalledWith('close', 0);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('completion detected'));
    });

    it('force-completes idle short Codex patched final answers missed by stream detection', async () => {
      const runningProcesses = new Map();
      const processRef = {
        pid: null,
        exitCode: null,
        killed: false,
        signalCode: null,
        emit: vi.fn(),
      };
      const output = [
        'Patched [server/factory/scorers/debt-ratio.js](C:/workspace/torque-public/.worktrees/fea-08597001/server/factory/scorers/debt-ratio.js:18).',
        '',
        'The scorer now keeps todos.count as the authoritative total when present.'
      ].join('\n');

      runningProcesses.set('task-patched-final', {
        provider: 'codex',
        process: processRef,
        output,
        completionDetected: false,
        startTime: Date.now() - 4 * 60 * 1000,
        lastOutputAt: Date.now() - 3 * 60 * 1000,
      });
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn().mockReturnValue({ id: 'task-patched-final', status: 'running' }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger,
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
        detectOutputCompletion: () => false,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(processRef.emit).toHaveBeenCalledWith('close', 0);
      expect(runningProcesses.get('task-patched-final').completionDetected).toBe(true);
    });
  });

  describe('checkStaleRunningTasks', () => {
    let mockDb, mockCancelTask, mockProcessQueue, mockIsInstanceAlive, mockGetMcpInstanceId, mockGetTaskActivity, mockReportRuntimeProblem, runningProcesses;

    beforeEach(() => {
      runningProcesses = new Map();
      mockCancelTask = vi.fn();
      mockProcessQueue = vi.fn();
      mockIsInstanceAlive = vi.fn().mockReturnValue(true);
      mockGetMcpInstanceId = vi.fn().mockReturnValue('mcp-current');
      mockGetTaskActivity = vi.fn();
      mockReportRuntimeProblem = vi.fn(() => ({ reported: true }));
      mockDb = {
        getConfig: vi.fn().mockReturnValue('0'),
        reconcileHostTaskCounts: vi.fn(),
        getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        updateTaskStatus: vi.fn(),
        decrementHostTasks: vi.fn(),
      };

      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: mockProcessQueue,
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: mockGetTaskActivity,
        tryStallRecovery: vi.fn(),
        isInstanceAlive: mockIsInstanceAlive,
        getMcpInstanceId: mockGetMcpInstanceId,
        reportRuntimeTaskProblem: mockReportRuntimeProblem,
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
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-old', 'failed', expect.objectContaining({
        error_output: expect.stringContaining('exceeded'),
      }));
    });

    it('uses cancelTask for tasks in runningProcesses map', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      runningProcesses.set('task-tracked', {
        process: { pid: 123 },
        startTime: Date.now() - 35 * 60 * 1000,
        lastOutputAt: Date.now() - 31 * 60 * 1000,
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-tracked', started_at: pastTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockCancelTask).toHaveBeenCalledWith(
        'task-tracked',
        expect.stringContaining('Timeout'),
        { cancel_reason: 'timeout' },
      );
    });

    it('leaves tracked tasks running when recent output shows activity beyond wall-clock timeout', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      runningProcesses.set('task-active', {
        process: { pid: 123 },
        startTime: Date.now() - 35 * 60 * 1000,
        lastOutputAt: Date.now() - 2 * 60 * 1000,
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-active', started_at: pastTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockReportRuntimeProblem).toHaveBeenCalledWith(expect.objectContaining({
        db: mockDb,
        task: expect.objectContaining({ id: 'task-active' }),
        problem: 'timeout_overrun_active',
        details: expect.objectContaining({ timeoutMinutes: 30 }),
      }));
    });

    it('lets filesystem or CPU activity rescue a tracked task before stale timeout cancellation', () => {
      const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      const proc = {
        process: { pid: 123 },
        startTime: Date.now() - 35 * 60 * 1000,
        lastOutputAt: Date.now() - 31 * 60 * 1000,
      };
      runningProcesses.set('task-rescued', proc);
      mockGetTaskActivity.mockImplementation(() => {
        proc.lastOutputAt = Date.now();
        return { isStalled: false };
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-rescued', started_at: pastTime, timeout_minutes: 30 },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockGetTaskActivity).toHaveBeenCalledWith('task-rescued');
      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockReportRuntimeProblem).toHaveBeenCalledWith(expect.objectContaining({
        task: expect.objectContaining({ id: 'task-rescued' }),
        problem: 'timeout_overrun_active',
      }));
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

    it('defaults to 480 min safety-ceiling timeout if timeout_minutes is undefined', () => {
      // Task started 35 min ago with no explicit timeout — should NOT be cancelled
      // because the safety-ceiling default is now 480 minutes
      const recentPast = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-default', started_at: recentPast, timeout_minutes: undefined },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('cancels task that exceeds the 480 min safety ceiling', () => {
      const longPast = new Date(Date.now() - 490 * 60 * 1000).toISOString();
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-ancient', started_at: longPast, timeout_minutes: undefined },
      ]);

      orphanCleanup.checkStaleRunningTasks();
      expect(mockDb.updateTaskStatus).toHaveBeenCalled();
    });

    it('requeues tasks owned by dead instances before timeout elapses', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockIsInstanceAlive.mockReturnValue(false);
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-dead-owner',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 0,
          max_retries: 2,
          mcp_instance_id: 'mcp-dead',
          ollama_host_id: 'scan-192-168-1-183',
        },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-dead-owner', 'queued', expect.objectContaining({
        retry_count: 1,
        mcp_instance_id: null,
        provider: null,
        ollama_host_id: null,
        error_output: expect.stringContaining('mcp-dead'),
      }));
      expect(mockDb.decrementHostTasks).toHaveBeenCalledWith('scan-192-168-1-183');
      expect(mockProcessQueue).toHaveBeenCalled();
    });

    it('requeues tasks owned by this instance when no local process is tracked', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-missing-local-proc',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 0,
          max_retries: 2,
          mcp_instance_id: 'mcp-current',
          ollama_host_id: null,
        },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-missing-local-proc', 'queued', expect.objectContaining({
        retry_count: 1,
        mcp_instance_id: null,
        provider: null,
      }));
      expect(mockProcessQueue).toHaveBeenCalled();
    });

    it('skips orphan recovery while finalization marker is active', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const finalizingTasks = new Map([
        ['task-active-finalizer', {
          startedAt: Date.now() - 5 * 60 * 1000,
          lastActivityAt: Date.now() - 10 * 1000,
          stage: 'auto_verify:output',
        }],
      ]);
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-active-finalizer',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 0,
          max_retries: 2,
          mcp_instance_id: 'mcp-current',
          ollama_host_id: null,
        },
      ]);
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        finalizingTasks,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: mockProcessQueue,
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: mockGetTaskActivity,
        tryStallRecovery: vi.fn(),
        isInstanceAlive: mockIsInstanceAlive,
        getMcpInstanceId: mockGetMcpInstanceId,
        reportRuntimeTaskProblem: mockReportRuntimeProblem,
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.checkStaleRunningTasks();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockProcessQueue).not.toHaveBeenCalled();
      expect(finalizingTasks.has('task-active-finalizer')).toBe(true);
    });

    it('recovers a running task whose finalization marker went stale', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const finalizingTasks = new Map([
        ['task-stale-finalizer', {
          startedAt: Date.now() - 30 * 60 * 1000,
          lastActivityAt: Date.now() - 20 * 60 * 1000,
          stage: 'auto_verify_retry',
        }],
      ]);
      mockDb.getConfig.mockImplementation((key) => (
        key === 'finalizing_task_stale_minutes' ? '15' : '0'
      ));
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-stale-finalizer',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 0,
          max_retries: 2,
          mcp_instance_id: 'mcp-current',
          ollama_host_id: null,
        },
      ]);
      orphanCleanup.init({
        db: mockDb,
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        finalizingTasks,
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: mockCancelTask,
        processQueue: mockProcessQueue,
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: mockGetTaskActivity,
        tryStallRecovery: vi.fn(),
        isInstanceAlive: mockIsInstanceAlive,
        getMcpInstanceId: mockGetMcpInstanceId,
        reportRuntimeTaskProblem: mockReportRuntimeProblem,
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.checkStaleRunningTasks();

      expect(finalizingTasks.has('task-stale-finalizer')).toBe(false);
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-stale-finalizer', 'queued', expect.objectContaining({
        retry_count: 1,
        mcp_instance_id: null,
        provider: null,
      }));
      expect(mockProcessQueue).toHaveBeenCalled();
    });

    it('cancels dead-owner tasks when retries are exhausted', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockIsInstanceAlive.mockReturnValue(false);
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-dead-owner-maxed',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 2,
          max_retries: 2,
          mcp_instance_id: 'mcp-dead',
          ollama_host_id: null,
        },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-dead-owner-maxed', 'failed', expect.objectContaining({
        mcp_instance_id: null,
        error_output: expect.stringContaining('max retries exhausted'),
      }));
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
