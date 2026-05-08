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
    it('drops malformed tracker entries and continues scanning healthy tasks', async () => {
      const runningProcesses = new Map();
      const stallRecoveryAttempts = new Map([['task-malformed', 1]]);
      const processRef = {
        pid: null,
        exitCode: null,
        killed: false,
        signalCode: null,
        emit: vi.fn(),
      };
      runningProcesses.set('task-malformed', { process: null });
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
        stallRecoveryAttempts,
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      await orphanCleanup.checkZombieProcesses();

      expect(runningProcesses.has('task-malformed')).toBe(false);
      expect(stallRecoveryAttempts.has('task-malformed')).toBe(false);
      expect(processRef.emit).toHaveBeenCalledWith('close', 0);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('malformed process tracker entry'));
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('[Zombie Check] Error:'));
    });

    it('keeps detached subprocess tracker entries with process null', async () => {
      const runningProcesses = new Map();
      const stallRecoveryAttempts = new Map([['task-detached', 1]]);
      const outputTail = { stop: vi.fn() };
      const errorTail = { stop: vi.fn() };
      runningProcesses.set('task-detached', {
        provider: 'codex',
        detached: true,
        subprocessPid: 12345,
        process: null,
        outputTail,
        errorTail,
        startTime: Date.now(),
        lastOutputAt: Date.now(),
      });
      const logger = { info: vi.fn(), warn: vi.fn() };

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn().mockReturnValue({ id: 'task-detached', status: 'running' }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger,
        runningProcesses,
        stallRecoveryAttempts,
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      await orphanCleanup.checkZombieProcesses();

      expect(runningProcesses.has('task-detached')).toBe(true);
      expect(stallRecoveryAttempts.has('task-detached')).toBe(true);
      expect(outputTail.stop).not.toHaveBeenCalled();
      expect(errorTail.stop).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('malformed process tracker entry'));
    });

    it('abandons cancelled detached tracker entries before killing their subprocess', async () => {
      const runningProcesses = new Map();
      const stallRecoveryAttempts = new Map([['task-cancelled-detached', 1]]);
      const outputTail = { stop: vi.fn() };
      const errorTail = { stop: vi.fn() };
      const livenessHandle = setInterval(() => {}, 99999);
      const timeoutHandle = setTimeout(() => {}, 99999);
      const startupTimeoutHandle = setTimeout(() => {}, 99999);
      const completionGraceHandle = setTimeout(() => {}, 99999);
      livenessHandle.unref?.();
      timeoutHandle.unref?.();
      startupTimeoutHandle.unref?.();
      completionGraceHandle.unref?.();
      const proc = {
        provider: 'codex',
        detached: true,
        subprocessPid: 12345,
        process: null,
        outputTail,
        errorTail,
        livenessHandle,
        timeoutHandle,
        startupTimeoutHandle,
        completionGraceHandle,
      };
      runningProcesses.set('task-cancelled-detached', proc);
      const killOrphanByPid = vi.fn();

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn().mockReturnValue({ id: 'task-cancelled-detached', status: 'cancelled' }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses,
        stallRecoveryAttempts,
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: vi.fn(),
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
        killOrphanByPid,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(proc.finalizing).toBe(true);
      expect(proc.stopTailProcessing).toBe(true);
      expect(proc.livenessHandle).toBeNull();
      expect(proc.timeoutHandle).toBeNull();
      expect(proc.startupTimeoutHandle).toBeNull();
      expect(proc.completionGraceHandle).toBeNull();
      expect(outputTail.stop).toHaveBeenCalled();
      expect(errorTail.stop).toHaveBeenCalled();
      expect(killOrphanByPid).toHaveBeenCalledWith(12345, 'task-cancelled-detached', 5000, 'ZombieCheck');
      expect(runningProcesses.has('task-cancelled-detached')).toBe(false);
      expect(stallRecoveryAttempts.has('task-cancelled-detached')).toBe(false);
    });

    it('kills untracked terminal detached subprocesses that remain alive', async () => {
      const runningProcesses = new Map();
      const killOrphanByPid = vi.fn();
      const getProcessCommandLine = vi.fn().mockResolvedValue('node server/utils/process-exit-wrapper.js');
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn(),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
          getTerminalTaskProcessCandidates: vi.fn().mockReturnValue([
            { id: 'terminal-task', status: 'cancelled', provider: 'codex', subprocess_pid: 45678 },
          ]),
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
        killOrphanByPid,
        getProcessCommandLine,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(getProcessCommandLine).toHaveBeenCalledWith(45678);
      expect(killOrphanByPid).toHaveBeenCalledWith(45678, 'terminal-task', 5000, 'ZombieCheck');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Terminal task terminal-task is 'cancelled'"));
    });

    // Regression: shutdown-abandon contract (a8f05279) marks rows
    // cancel_reason='server_restart' so the successor reconciler can
    // re-adopt their detached subprocess. The zombie sweep must not kill
    // those PIDs first, or it defeats re-adoption — every cutover would
    // resurrect the wave of cancellations the abandon path was meant to
    // eliminate. The skip is now bounded by a re-adoption grace window
    // (TORQUE_SERVER_RESTART_REAP_GRACE_MS) — a row whose completed_at is
    // recent stays in the protected window.
    it("skips kills for fresh cancel_reason='server_restart' rows (re-adoption contract)", async () => {
      const runningProcesses = new Map();
      const killOrphanByPid = vi.fn();
      const getProcessCommandLine = vi.fn().mockResolvedValue('node server/utils/process-exit-wrapper.js');
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn(),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
          getTerminalTaskProcessCandidates: vi.fn().mockReturnValue([
            {
              id: 'restart-abandoned',
              status: 'cancelled',
              provider: 'codex',
              subprocess_pid: 45678,
              cancel_reason: 'server_restart',
              completed_at: new Date(Date.now() - 60 * 1000).toISOString(),
            },
          ]),
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
        killOrphanByPid,
        getProcessCommandLine,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(killOrphanByPid).not.toHaveBeenCalled();
      expect(getProcessCommandLine).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("Terminal task restart-abandoned"));
    });

    // Regression: the unbounded skip used to leak wrappers forever — once
    // re-adoption failed, the row sat with cancel_reason='server_restart'
    // and the wrapper PID was never reaped. Re-adoption is an episodic
    // startup event; once the grace expires the wrapper has no remaining
    // owner and must be cleaned up.
    it("kills cancel_reason='server_restart' rows past the re-adoption grace window", async () => {
      const runningProcesses = new Map();
      const killOrphanByPid = vi.fn();
      const getProcessCommandLine = vi.fn().mockResolvedValue('node server/utils/process-exit-wrapper.js');
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn(),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
          getTerminalTaskProcessCandidates: vi.fn().mockReturnValue([
            {
              id: 'restart-leaked',
              status: 'cancelled',
              provider: 'codex',
              subprocess_pid: 45678,
              cancel_reason: 'server_restart',
              // 2 hours ago — well past the 15-min default grace.
              completed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            },
          ]),
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
        killOrphanByPid,
        getProcessCommandLine,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(getProcessCommandLine).toHaveBeenCalledWith(45678);
      expect(killOrphanByPid).toHaveBeenCalledWith(45678, 'restart-leaked', 5000, 'ZombieCheck');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("cancel_reason='server_restart'"));
    });

    // The operator-invoked abandon mode (cancellation-cleanup.md "Abandon
    // mode contract") is a deliberate "TORQUE walks away" — the operator
    // owns subsequent monitoring of the PID. The zombie sweep must never
    // touch these rows, regardless of age.
    it("never kills cancel_reason='abandon' rows (operator-owned contract)", async () => {
      const runningProcesses = new Map();
      const killOrphanByPid = vi.fn();
      const getProcessCommandLine = vi.fn().mockResolvedValue('node server/utils/process-exit-wrapper.js');
      const logger = { info: vi.fn(), warn: vi.fn() };

      vi.spyOn(process, 'kill').mockImplementation(() => {});

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getTask: vi.fn(),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
          getTerminalTaskProcessCandidates: vi.fn().mockReturnValue([
            {
              id: 'operator-abandoned',
              status: 'cancelled',
              provider: 'codex',
              subprocess_pid: 45678,
              cancel_reason: 'abandon',
              // Even ancient: operator still owns this PID.
              completed_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ]),
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
        killOrphanByPid,
        getProcessCommandLine,
      });

      await orphanCleanup.checkZombieProcesses();

      expect(killOrphanByPid).not.toHaveBeenCalled();
      expect(getProcessCommandLine).not.toHaveBeenCalled();
    });

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
    const minuteMs = 60 * 1000;

    function planGenerationMetadata(maxWallClockMinutes = 25) {
      return {
        factory_internal: true,
        kind: 'plan_generation',
        activity_timeout_policy: {
          kind: 'plan_generation',
          timeout_minutes: 10,
          max_wall_clock_minutes: maxWallClockMinutes,
          overrun_intake_problem: 'timeout_overrun_active',
        },
      };
    }

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

    it('does not fail restart barriers at the drain timeout boundary', () => {
      const pastTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'restart-barrier',
          provider: 'system',
          task_description: 'Restart barrier: Cutover to feature',
          started_at: pastTime,
          timeout_minutes: 1,
        },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockReportRuntimeProblem).not.toHaveBeenCalled();
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

    it('does not report active factory plan-generation soft timeout overruns before the hard cap', () => {
      const now = Date.now();
      const pastTime = new Date(now - 12 * minuteMs).toISOString();
      runningProcesses.set('task-plan-active-soft', {
        process: { pid: 123 },
        startTime: now - 12 * minuteMs,
        lastOutputAt: now - 2 * minuteMs,
        metadata: planGenerationMetadata(25),
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-plan-active-soft', started_at: pastTime, timeout_minutes: 10, provider: 'codex' },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockCancelTask).not.toHaveBeenCalled();
      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockReportRuntimeProblem).not.toHaveBeenCalled();
    });

    it('reports and cancels active factory plan-generation tasks at the hard cap', () => {
      const now = Date.now();
      const pastTime = new Date(now - 25 * minuteMs).toISOString();
      runningProcesses.set('task-plan-hard-cap', {
        process: { pid: 123 },
        startTime: now - 25 * minuteMs,
        lastOutputAt: now - 2 * minuteMs,
        metadata: JSON.stringify(planGenerationMetadata(25)),
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        { id: 'task-plan-hard-cap', started_at: pastTime, timeout_minutes: 10, provider: 'codex' },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockReportRuntimeProblem).toHaveBeenCalledWith(expect.objectContaining({
        db: mockDb,
        task: expect.objectContaining({ id: 'task-plan-hard-cap' }),
        problem: 'timeout_overrun_active',
        details: expect.objectContaining({
          hardCapMinutes: 25,
          reason: 'factory_plan_generation_hard_cap',
        }),
      }));
      expect(mockCancelTask).toHaveBeenCalledWith(
        'task-plan-hard-cap',
        expect.stringContaining('Timeout'),
        { cancel_reason: 'timeout' },
      );
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

    it('does not requeue locally tracked tasks whose persisted owner is stale', () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockIsInstanceAlive.mockReturnValue(false);
      runningProcesses.set('task-local-live-dead-owner', {
        process: null,
        detached: true,
        subprocessPid: 12345,
        startTime: Date.now() - 2 * 60 * 1000,
        lastOutputAt: Date.now(),
      });
      mockDb.getRunningTasksLightweight.mockReturnValue([
        {
          id: 'task-local-live-dead-owner',
          started_at: recentTime,
          timeout_minutes: 30,
          retry_count: 0,
          max_retries: 2,
          mcp_instance_id: 'task-startup-dead-owner',
          ollama_host_id: null,
        },
      ]);

      orphanCleanup.checkStaleRunningTasks();

      expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
      expect(mockProcessQueue).not.toHaveBeenCalled();
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

  // ── stall-and-retry.md #4: boot-time stall-detection audit ──────────
  // logStallDetectionAudit() runs once from startTimers() at server boot.
  // The behavior is "log what's disabled so the operator can see it" —
  // no side effects, no mutation. Tests assert on logger.info content
  // through a child-spy mock of the logger module.
  describe('logStallDetectionAudit (stall-and-retry.md #4)', () => {
    // The audit reads `serverConfig.get` / `getBool` and writes to the
    // module-level `logger` ref (which is set via init/ensureDeps).
    // Tests inject a fake logger via init and stub serverConfig methods
    // directly — same pattern as the other orphan-cleanup tests.
    function setupAudit() {
      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      orphanCleanup.init({
        db: { getConfig: vi.fn().mockReturnValue(null) },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: customLogger,
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
      return { mod: orphanCleanup, logger: customLogger, cfg: serverConfig };
    }

    it('names disabled providers when their config is unset', () => {
      const { mod, logger, cfg } = setupAudit();
      // No config set anywhere → every provider is disabled by default
      vi.spyOn(cfg, 'get').mockReturnValue(null);
      vi.spyOn(cfg, 'getBool').mockReturnValue(false);

      mod.logStallDetectionAudit();

      const lines = logger.info.mock.calls.map((c) => c[0]).join('\n');
      expect(lines).toContain('[StallAudit] auto_cancel_stalled=OFF');
      expect(lines).toContain('Stall detection DISABLED');
      // codex/claude-cli/ollama all have NULL default config, so they
      // appear in the disabled list (de-duped by config-key — anthropic
      // shares stall_threshold_claude with claude-cli)
      expect(lines).toContain('codex(stall_threshold_codex)');
      expect(lines).toContain('claude-cli(stall_threshold_claude)');
      expect(lines).toContain('ollama(stall_threshold_ollama)');
    });

    it('reports enabled providers separately when their threshold is set', () => {
      const { mod, logger, cfg } = setupAudit();
      vi.spyOn(cfg, 'get').mockImplementation((key) => {
        if (key === 'stall_threshold_codex') return '180';
        if (key === 'stall_threshold_ollama') return '120';
        return null;
      });
      vi.spyOn(cfg, 'getBool').mockImplementation((key) => key === 'auto_cancel_stalled');

      mod.logStallDetectionAudit();

      const lines = logger.info.mock.calls.map((c) => c[0]).join('\n');
      // No "auto_cancel_stalled=OFF" line because it's ON
      expect(lines).not.toContain('auto_cancel_stalled=OFF');
      // Enabled list contains codex + ollama with their thresholds
      expect(lines).toContain('codex=180s');
      expect(lines).toContain('ollama=120s');
    });

    it("treats 'null' string and '0' as disabled (matches getStallThreshold semantics)", () => {
      const { mod, logger, cfg } = setupAudit();
      vi.spyOn(cfg, 'get').mockImplementation((key) => {
        if (key === 'stall_threshold_codex') return 'null';
        if (key === 'stall_threshold_claude') return '0';
        return null;
      });
      vi.spyOn(cfg, 'getBool').mockReturnValue(false);

      mod.logStallDetectionAudit();

      const lines = logger.info.mock.calls.map((c) => c[0]).join('\n');
      expect(lines).toContain('codex(stall_threshold_codex)');
      expect(lines).toContain('claude-cli(stall_threshold_claude)');
    });

    it('does not throw when serverConfig.get throws', () => {
      const { mod, logger, cfg } = setupAudit();
      vi.spyOn(cfg, 'get').mockImplementation(() => { throw new Error('config not initialized'); });
      vi.spyOn(cfg, 'getBool').mockReturnValue(false);

      expect(() => mod.logStallDetectionAudit()).not.toThrow();
      // Best-effort log of the failure mode
      const lines = logger.info.mock.calls.map((c) => c[0]).join('\n');
      expect(lines).toContain('[StallAudit] Failed to compute stall-detection audit at boot');
    });

    it('de-duplicates providers that share a config key', () => {
      // anthropic and claude-cli both map to 'stall_threshold_claude';
      // groq and ollama both map to 'stall_threshold_ollama'. The audit
      // should not list each twice — once per config key is the contract.
      const { mod, logger, cfg } = setupAudit();
      vi.spyOn(cfg, 'get').mockReturnValue(null);
      vi.spyOn(cfg, 'getBool').mockReturnValue(false);

      mod.logStallDetectionAudit();

      const disabledLine = logger.info.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === 'string' && s.includes('Stall detection DISABLED'));
      expect(disabledLine).toBeTruthy();
      const claudeMatches = (disabledLine.match(/stall_threshold_claude/g) || []).length;
      const ollamaMatches = (disabledLine.match(/stall_threshold_ollama\b/g) || []).length;
      expect(claudeMatches).toBe(1);
      expect(ollamaMatches).toBe(1);
    });
  });
});
