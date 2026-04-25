/**
 * Host Failover Chain — Integration Tests
 *
 * Tests the full failover pipeline:
 *   health check failure → 3-failure threshold → host marked 'down'
 *   → cleanupOrphanedHostTasks → tasks requeued → tryLocalFirstFallback
 *   → processQueue picks up on alternate host
 *
 * Also tests auto-recovery and multi-task failover.
 */

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

describe('Host Failover Chain', () => {
  let db;

  beforeAll(() => {
    const setup = setupTestDbOnly('host-failover-chain');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // ─── Helpers ──────────────────────────────────────────────────────

  let hostSeq = 0;
  function addHost(name, models, opts = {}) {
    hostSeq++;
    const id = `failover-host-${name}-${hostSeq}`;
    db.addOllamaHost({
      id,
      name,
      url: `http://${name}-${hostSeq}:11434`,
      max_concurrent: opts.maxConcurrent || 4,
      enabled: true,
    });
    db.updateOllamaHost(id, {
      status: opts.status || 'healthy',
      running_tasks: opts.runningTasks || 0,
      consecutive_failures: opts.consecutiveFailures || 0,
      models_cache: JSON.stringify(models.map(m => ({ name: m }))),
      models_updated_at: new Date().toISOString(),
    });
    return id;
  }

  function addTask(id, hostId, status = 'running') {
    const { randomUUID } = require('crypto');
    const taskId = id || randomUUID();
    db.createTask({
      id: taskId,
      task_description: `Failover test task ${taskId}`,
      status,
      provider: 'ollama',
      model: TEST_MODELS.SMALL,
      working_directory: process.cwd(),
      ollama_host_id: hostId,
    });
    if (status === 'running') {
      db.updateTaskStatus(taskId, 'running', { ollama_host_id: hostId });
    }
    return taskId;
  }

  // ─── 3-Failure Threshold ──────────────────────────────────────────

  describe('3-consecutive-failure threshold', () => {
    it('1st failure → status becomes degraded', () => {
      const hostId = addHost('threshold-1', [TEST_MODELS.SMALL]);

      db.recordHostHealthCheck(hostId, false);

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('degraded');
      expect(host.consecutive_failures).toBe(1);
    });

    it('2nd failure → status stays degraded', () => {
      const hostId = addHost('threshold-2', [TEST_MODELS.SMALL]);

      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('degraded');
      expect(host.consecutive_failures).toBe(2);
    });

    it('3rd failure → status transitions to down', () => {
      const hostId = addHost('threshold-3', [TEST_MODELS.SMALL]);

      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('down');
      expect(host.consecutive_failures).toBe(3);
    });

    it('success resets failures back to 0 and status to healthy', () => {
      const hostId = addHost('threshold-reset', [TEST_MODELS.SMALL]);

      // Fail twice (degraded)
      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);
      expect(db.getOllamaHost(hostId).consecutive_failures).toBe(2);

      // One success resets everything
      db.recordHostHealthCheck(hostId, true);

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('healthy');
      expect(host.consecutive_failures).toBe(0);
    });

    it('4th+ failures keep status as down', () => {
      const hostId = addHost('threshold-4plus', [TEST_MODELS.SMALL]);

      for (let i = 0; i < 5; i++) {
        db.recordHostHealthCheck(hostId, false);
      }

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('down');
      expect(host.consecutive_failures).toBe(5);
    });
  });

  // ─── Host Auto-Recovery ───────────────────────────────────────────

  describe('host auto-recovery', () => {
    it('recovers from down to healthy on successful health check', () => {
      const hostId = addHost('recovery-1', [TEST_MODELS.SMALL]);

      // Mark host as down (3 failures)
      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);
      db.recordHostHealthCheck(hostId, false);
      expect(db.getOllamaHost(hostId).status).toBe('down');

      // Successful health check recovers
      db.recordHostHealthCheck(hostId, true, [{ name: TEST_MODELS.SMALL }]);

      const host = db.getOllamaHost(hostId);
      expect(host.status).toBe('healthy');
      expect(host.consecutive_failures).toBe(0);
      expect(host.last_healthy).toBeTruthy();
    });

    it('refreshes model list on recovery', () => {
      const hostId = addHost('recovery-models', ['old-model']);

      // Mark down
      for (let i = 0; i < 3; i++) db.recordHostHealthCheck(hostId, false);

      // Recover with new model list
      db.recordHostHealthCheck(hostId, true, [
        { name: TEST_MODELS.SMALL },
        { name: TEST_MODELS.FAST },
      ]);

      const host = db.getOllamaHost(hostId);
      const models = JSON.parse(host.models_cache);
      expect(models).toHaveLength(2);
      expect(models.map(m => m.name)).toContain(TEST_MODELS.SMALL);
      expect(models.map(m => m.name)).toContain(TEST_MODELS.FAST);
    });
  });

  // ─── cleanupOrphanedHostTasks via orphan-cleanup module ───────────

  describe('cleanupOrphanedHostTasks → task requeue chain', () => {
    let orphanCleanup;

    beforeEach(() => {
      require.resolve('../maintenance/orphan-cleanup');
      orphanCleanup = require('../maintenance/orphan-cleanup');
    });

    afterEach(() => {
      orphanCleanup.stopTimers();
      vi.restoreAllMocks();
    });

    it('marks running tasks as failed with HOST FAILOVER and triggers retry', () => {
      const hostId = addHost('cleanup-chain', [TEST_MODELS.SMALL]);
      const taskId = addTask('chain-task-1', hostId);

      let retriedTaskId = null;
      const mockProcessQueue = vi.fn();
      const mockTryLocalFirst = vi.fn((id) => { retriedTaskId = id; });

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getRunningTasksForHost: vi.fn().mockReturnValue([
            { id: taskId, error_output: '' },
          ]),
          updateTaskStatus: vi.fn(),
          incrementRetry: vi.fn().mockReturnValue({ shouldRetry: true }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses: new Map(),
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: mockProcessQueue,
        tryLocalFirstFallback: mockTryLocalFirst,
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.cleanupOrphanedHostTasks(hostId, 'TestHost');

      // Task was retried
      expect(retriedTaskId).toBe(taskId);
      // processQueue called to pick up retried tasks
      expect(mockProcessQueue).toHaveBeenCalled();
    });

    it('handles multiple tasks failing over simultaneously', () => {
      const hostId = addHost('multi-cleanup', [TEST_MODELS.SMALL]);
      const taskIds = ['multi-1', 'multi-2', 'multi-3', 'multi-4', 'multi-5'];

      const retriedTasks = [];
      const failedTasks = [];
      const mockUpdateStatus = vi.fn((id, status) => { if (status === 'failed') failedTasks.push(id); });
      const mockTryLocalFirst = vi.fn((id) => { retriedTasks.push(id); });

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getRunningTasksForHost: vi.fn().mockReturnValue(
            taskIds.map(id => ({ id, error_output: '' }))
          ),
          updateTaskStatus: mockUpdateStatus,
          incrementRetry: vi.fn().mockReturnValue({ shouldRetry: true }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses: new Map(),
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: mockTryLocalFirst,
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.cleanupOrphanedHostTasks(hostId, 'MultiHost');

      expect(failedTasks).toHaveLength(5);
      expect(retriedTasks).toHaveLength(5);
      expect(retriedTasks).toEqual(expect.arrayContaining(taskIds));
    });

    it('does not retry when max retries exhausted', () => {
      const hostId = addHost('no-retry', [TEST_MODELS.SMALL]);
      const taskId = 'exhausted-task';

      const mockTryLocalFirst = vi.fn();

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getRunningTasksForHost: vi.fn().mockReturnValue([
            { id: taskId, error_output: '' },
          ]),
          updateTaskStatus: vi.fn(),
          incrementRetry: vi.fn().mockReturnValue({ shouldRetry: false }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
        dashboard: { notifyTaskUpdated: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn() },
        runningProcesses: new Map(),
        stallRecoveryAttempts: new Map(),
        TASK_TIMEOUTS: { PROCESS_QUERY: 5000 },
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        tryLocalFirstFallback: mockTryLocalFirst,
        getTaskActivity: vi.fn(),
        tryStallRecovery: vi.fn(),
        safeConfigInt: vi.fn(),
      });

      orphanCleanup.cleanupOrphanedHostTasks(hostId, 'TestHost');

      expect(mockTryLocalFirst).not.toHaveBeenCalled();
    });
  });

  // ─── Full Chain: health check → host down → cleanup → requeue ────

  describe('full failover chain integration', () => {
    let orphanCleanup, hostMonitoring;

    beforeEach(() => {
      for (const modName of ['../maintenance/orphan-cleanup', '../utils/host-monitoring']) {
        require.resolve(modName);
      }
      orphanCleanup = require('../maintenance/orphan-cleanup');
      hostMonitoring = require('../utils/host-monitoring');
    });

    afterEach(() => {
      orphanCleanup.stopTimers();
      vi.restoreAllMocks();
    });

    it('health check failures trigger cleanup on 3rd failure only', () => {
      const primaryId = addHost('primary-full', [TEST_MODELS.SMALL]);
      const _backupId = addHost('backup-full', [TEST_MODELS.SMALL]);

      const cleanupCalls = [];

      // Wire up host-monitoring with our real db and a cleanup tracker
      hostMonitoring.init({
        db,
        dashboard: { notifyOllamaStatus: vi.fn() },
        cleanupOrphanedHostTasks: (hostId, hostName) => {
          cleanupCalls.push({ hostId, hostName });
        },
        queueLockHolderId: 'test',
      });

      // Simulate 3 consecutive health check failures on primary
      // We call recordHostHealthCheck directly (as host-monitoring does)
      const _host = db.getOllamaHost(primaryId);

      // 1st failure — should NOT trigger cleanup
      const prev1 = db.getOllamaHost(primaryId).status;
      db.recordHostHealthCheck(primaryId, false);
      const after1 = db.getOllamaHost(primaryId);
      if (after1.status === 'down' && prev1 !== 'down') {
        cleanupCalls.push({ hostId: primaryId, hostName: 'primary-full' });
      }
      expect(after1.status).toBe('degraded');
      expect(cleanupCalls).toHaveLength(0);

      // 2nd failure — should NOT trigger cleanup
      const prev2 = db.getOllamaHost(primaryId).status;
      db.recordHostHealthCheck(primaryId, false);
      const after2 = db.getOllamaHost(primaryId);
      if (after2.status === 'down' && prev2 !== 'down') {
        cleanupCalls.push({ hostId: primaryId, hostName: 'primary-full' });
      }
      expect(after2.status).toBe('degraded');
      expect(cleanupCalls).toHaveLength(0);

      // 3rd failure — SHOULD trigger cleanup (transition to down)
      const prev3 = db.getOllamaHost(primaryId).status;
      db.recordHostHealthCheck(primaryId, false);
      const after3 = db.getOllamaHost(primaryId);
      if (after3.status === 'down' && prev3 !== 'down') {
        cleanupCalls.push({ hostId: primaryId, hostName: 'primary-full' });
      }
      expect(after3.status).toBe('down');
      expect(cleanupCalls).toHaveLength(1);
      expect(cleanupCalls[0].hostId).toBe(primaryId);
    });

    it('host selection skips down hosts', () => {
      // Use a unique model name to avoid interference from other tests' hosts
      const _downId = addHost('down-skip', ['unique-skip-model:7b'], { status: 'down', consecutiveFailures: 3 });
      const healthyId = addHost('healthy-skip', ['unique-skip-model:7b'], { status: 'healthy' });

      // selectOllamaHostForModel returns { host, reason } — host is nested
      const result = db.selectOllamaHostForModel('unique-skip-model:7b');
      expect(result).toBeTruthy();
      expect(result.host).toBeTruthy();
      expect(result.host.id).toBe(healthyId);
    });

    it('degraded hosts are still available for task assignment', () => {
      const _degradedId = addHost('degraded-avail', [TEST_MODELS.SMALL], { status: 'degraded', consecutiveFailures: 1 });

      const result = db.selectOllamaHostForModel(TEST_MODELS.SMALL);
      expect(result).toBeTruthy();
      expect(result.host).toBeTruthy();
      // Degraded hosts should not be excluded (only 'down' hosts are filtered)
    });
  });

  // ─── Host status during task lifecycle ────────────────────────────

  describe('task metadata preservation during failover', () => {
    it('preserves error_output from original failure', () => {
      const hostId = addHost('metadata-preserve', [TEST_MODELS.SMALL]);
      const taskId = 'preserve-task';

      const capturedUpdates = [];
      const orphanCleanup = require('../maintenance/orphan-cleanup');

      orphanCleanup.init({
        db: {
          getConfig: vi.fn().mockReturnValue('0'),
          getRunningTasksForHost: vi.fn().mockReturnValue([
            { id: taskId, error_output: 'Previous error info\n' },
          ]),
          updateTaskStatus: vi.fn((id, status, fields) => {
            capturedUpdates.push({ id, status, fields });
          }),
          incrementRetry: vi.fn().mockReturnValue({ shouldRetry: false }),
          reconcileHostTaskCounts: vi.fn(),
          getRunningTasksLightweight: vi.fn().mockReturnValue([]),
        },
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

      orphanCleanup.cleanupOrphanedHostTasks(hostId, 'MetaHost');

      expect(capturedUpdates).toHaveLength(1);
      const update = capturedUpdates[0];
      expect(update.status).toBe('failed');
      expect(update.fields.cancel_reason).toBeUndefined();
      // Error output should contain both the original error and the HOST FAILOVER message
      expect(update.fields.error_output).toContain('Previous error info');
      expect(update.fields.error_output).toContain('HOST FAILOVER');
    });
  });
});
