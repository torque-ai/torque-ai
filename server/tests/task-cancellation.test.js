'use strict';

// --- CJS module mock helper ---
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports,
  };
}

// Install mock for event-dispatch before requiring the module under test
const mockDispatchTaskEvent = vi.fn();
installMock('../hooks/event-dispatch', { dispatchTaskEvent: mockDispatchTaskEvent });

const createCancellationHandler = require('../execution/task-cancellation');
const ProcessTracker = require('../execution/process-tracker');
const processLifecycle = require('../execution/process-lifecycle');

describe('task-cancellation', () => {
  let deps;
  let handler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchTaskEvent.mockReset();

    deps = {
      db: {
        resolveTaskId: vi.fn(),
        getTask: vi.fn(),
        updateTaskStatus: vi.fn(),
        releaseAllFileLocks: vi.fn(() => 0),
      },
      runningProcesses: new Map(),
      apiAbortControllers: new Map(),
      pendingRetryTimeouts: new Map(),
      stallRecoveryAttempts: new Map(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sanitizeTaskOutput: vi.fn((x) => x),
      safeTriggerWebhook: vi.fn(),
      killProcessGraceful: vi.fn(),
      cleanupChildProcessListeners: vi.fn(),
      cleanupProcessTracking: vi.fn(),
      safeDecrementHostSlot: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      processQueue: vi.fn(),
    };

    handler = createCancellationHandler(deps);
  });

  // ---------------------------------------------------------------
  // triggerCancellationWebhook
  // ---------------------------------------------------------------
  describe('triggerCancellationWebhook', () => {
    it('delegates to safeTriggerWebhook', () => {
      handler.triggerCancellationWebhook('task-1', 'cancelled');
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith('task-1', 'cancelled');
    });
  });

  // ---------------------------------------------------------------
  // dispatchCancelEvent
  // ---------------------------------------------------------------
  describe('dispatchCancelEvent', () => {
    it('dispatches event via event-dispatch', () => {
      const fakeTask = { id: 'task-1', status: 'running' };
      deps.db.getTask.mockReturnValue(fakeTask);

      handler.dispatchCancelEvent('task-1', 'cancelled');

      expect(mockDispatchTaskEvent).toHaveBeenCalledWith('cancelled', fakeTask);
    });

    it('swallows errors without throwing', () => {
      mockDispatchTaskEvent.mockImplementation(() => {
        throw new Error('dispatch boom');
      });

      expect(() => handler.dispatchCancelEvent('task-1', 'cancelled')).not.toThrow();
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[MCP Notify]'),
        'dispatch boom'
      );
    });
  });

  // ---------------------------------------------------------------
  // cancelTask
  // ---------------------------------------------------------------
  describe('cancelTask', () => {
    it('throws when task not found (resolveTaskId returns null)', () => {
      deps.db.resolveTaskId.mockReturnValue(null);

      expect(() => handler.cancelTask('bad-prefix')).toThrow(
        'No task found matching ID prefix: bad-prefix'
      );
    });

    it('kills running process, updates status, cleans up, fires webhooks, triggers workflow termination, processes queue', () => {
      const fullId = 'full-task-id';
      deps.db.resolveTaskId.mockReturnValue(fullId);

      const fakeProc = {
        process: { pid: 123 },
        output: 'some output',
        errorOutput: 'some error',
      };
      deps.runningProcesses.set(fullId, fakeProc);
      deps.sanitizeTaskOutput.mockReturnValue('sanitized output');
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'running' });

      const result = handler.cancelTask('full-task-id');

      expect(result).toBe(true);
      expect(deps.killProcessGraceful).toHaveBeenCalledWith(fakeProc, fullId, 5000);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        output: 'sanitized output',
        error_output: 'some error\n[cancelled] Cancelled by user',
        cancel_reason: 'user',
      });
      expect(deps.cleanupChildProcessListeners).toHaveBeenCalledWith(fakeProc.process);
      expect(deps.cleanupProcessTracking).toHaveBeenCalledWith(
        fakeProc, fullId, deps.runningProcesses, deps.stallRecoveryAttempts
      );
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(mockDispatchTaskEvent).toHaveBeenCalledWith('cancelled', expect.any(Object));
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
      expect(deps.processQueue).toHaveBeenCalled();
      expect(deps.db.releaseAllFileLocks.mock.invocationCallOrder[0])
        .toBeLessThan(deps.processQueue.mock.invocationCallOrder[0]);
    });

    it('uses graceful SIGTERM then SIGKILL flow and removes ProcessTracker state', () => {
      vi.useFakeTimers();
      try {
        const fullId = 'graceful-task';
        const runningProcesses = new ProcessTracker();
        const apiAbortControllers = runningProcesses.abortControllers;
        const pendingRetryTimeouts = runningProcesses.retryTimeouts;
        const stallRecoveryAttempts = runningProcesses.stallAttempts;
        let procTimeoutFired = 0;
        let retryTimeoutFired = 0;

        const child = {
          kill: vi.fn(),
          removeAllListeners: vi.fn(),
          stdout: { removeAllListeners: vi.fn() },
          stderr: { removeAllListeners: vi.fn() },
        };
        const trackedProc = {
          process: child,
          output: 'stream output',
          errorOutput: 'stream error',
          timeoutHandle: setTimeout(() => { procTimeoutFired++; }, 1000),
          startupTimeoutHandle: setTimeout(() => { procTimeoutFired++; }, 2000),
          completionGraceHandle: setTimeout(() => { procTimeoutFired++; }, 3000),
        };

        runningProcesses.set(fullId, trackedProc);
        stallRecoveryAttempts.set(fullId, { attempts: 2, lastStrategy: 'retry' });
        pendingRetryTimeouts.set(fullId, setTimeout(() => { retryTimeoutFired++; }, 4000));

        deps.db.resolveTaskId.mockReturnValue(fullId);
        deps.db.getTask.mockReturnValue({ id: fullId, status: 'running' });

        const realHandler = createCancellationHandler({
          ...deps,
          runningProcesses,
          apiAbortControllers,
          pendingRetryTimeouts,
          stallRecoveryAttempts,
          killProcessGraceful: processLifecycle.killProcessGraceful,
          cleanupChildProcessListeners: processLifecycle.cleanupChildProcessListeners,
          cleanupProcessTracking: processLifecycle.cleanupProcessTracking,
        });

        const result = realHandler.cancelTask(fullId);

        expect(result).toBe(true);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(runningProcesses.has(fullId)).toBe(false);
        expect(stallRecoveryAttempts.has(fullId)).toBe(false);
        expect(pendingRetryTimeouts.has(fullId)).toBe(false);
        expect(child.stdout.removeAllListeners).toHaveBeenCalledWith('data');
        expect(child.stderr.removeAllListeners).toHaveBeenCalledWith('data');
        expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');

        vi.advanceTimersByTime(4999);
        expect(child.kill).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(child.kill).toHaveBeenCalledTimes(2);
        expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        expect(procTimeoutFired).toBe(0);
        expect(retryTimeoutFired).toBe(0);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it('clears pending retry timeout if present', () => {
      const fullId = 'retry-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });

      const fakeTimeout = setTimeout(() => {}, 100000);
      deps.pendingRetryTimeouts.set(fullId, fakeTimeout);

      handler.cancelTask(fullId);

      expect(deps.pendingRetryTimeouts.has(fullId)).toBe(false);
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cancelled pending retry')
      );

      clearTimeout(fakeTimeout); // cleanup
    });

    it('uses "timeout" webhook event when reason includes "timeout"', () => {
      const fullId = 'timeout-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });

      handler.cancelTask(fullId, 'Stall timeout detected');

      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'timeout');
      expect(mockDispatchTaskEvent).toHaveBeenCalledWith('timeout', expect.any(Object));
    });

    it('cancels queued tasks without process kill', () => {
      const fullId = 'queued-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.killProcessGraceful).not.toHaveBeenCalled();
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: 'Cancelled by user',
        cancel_reason: 'user',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
      // processQueue should NOT be called for queued tasks
      expect(deps.processQueue).not.toHaveBeenCalled();
    });

    it('cancels blocked tasks', () => {
      const fullId = 'blocked-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'blocked' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: 'Cancelled by user',
        cancel_reason: 'user',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
    });

    it('cancels pending tasks', () => {
      const fullId = 'pending-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'pending' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: 'Cancelled by user',
        cancel_reason: 'user',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
    });

    it('cancels pending approval tasks', () => {
      const fullId = 'pending-approval-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'pending_approval' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: 'Cancelled by user',
        cancel_reason: 'user',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
      expect(deps.processQueue).not.toHaveBeenCalled();
    });

    it('cancels running tasks without process in memory (decrements host slot)', () => {
      const fullId = 'orphan-running';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'running', ollama_host_id: 'host-1' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.safeDecrementHostSlot).toHaveBeenCalledWith({ ollamaHostId: 'host-1' });
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: expect.stringContaining('Process was not found in memory'),
        cancel_reason: 'user',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
      expect(deps.processQueue).toHaveBeenCalled();
    });

    it('passes through a structured cancel_reason option', () => {
      const fullId = 'structured-cancel-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });

      const result = handler.cancelTask(fullId, 'Server shutdown', { cancel_reason: 'server_restart' });

      expect(result).toBe(true);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
        error_output: 'Server shutdown',
        cancel_reason: 'server_restart',
      });
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
    });

    it('logs and continues when cancellation lock release fails', () => {
      const fullId = 'queued-lock-release-error-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });
      deps.db.releaseAllFileLocks.mockImplementation(() => {
        throw new Error('sqlite busy');
      });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.db.releaseAllFileLocks).toHaveBeenCalledWith(fullId);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        `[FileLock] Non-fatal error releasing locks for cancelled task ${fullId}: sqlite busy`
      );
      expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
      expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
    });

    it('aborts API controller if present', () => {
      const fullId = 'api-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'queued' });

      const fakeController = { abort: vi.fn() };
      deps.apiAbortControllers.set(fullId, fakeController);

      handler.cancelTask(fullId);

      expect(fakeController.abort).toHaveBeenCalled();
      expect(deps.apiAbortControllers.has(fullId)).toBe(false);
    });

    it('returns false after aborting a spawn-time controller when the task record is not ready yet', () => {
      const fullId = 'spawn-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue(null);

      const fakeController = { abort: vi.fn() };
      deps.apiAbortControllers.set(fullId, fakeController);

      const result = handler.cancelTask(fullId, 'Cancelled during spawn');

      expect(result).toBe(false);
      expect(fakeController.abort).toHaveBeenCalledTimes(1);
      expect(deps.apiAbortControllers.has(fullId)).toBe(false);
      expect(deps.db.updateTaskStatus).not.toHaveBeenCalled();
      expect(deps.safeTriggerWebhook).not.toHaveBeenCalled();
      expect(deps.handleWorkflowTermination).not.toHaveBeenCalled();
      expect(deps.processQueue).not.toHaveBeenCalled();
    });

    it('returns false when task has non-cancellable status (e.g., completed)', () => {
      const fullId = 'done-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'completed' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(false);
      expect(deps.db.updateTaskStatus).not.toHaveBeenCalled();
      expect(deps.safeTriggerWebhook).not.toHaveBeenCalled();
    });

    it('is idempotent when the same task is cancelled twice', () => {
      const fullId = 'duplicate-cancel-task';
      const task = { id: fullId, status: 'queued' };
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockImplementation(() => task);
      deps.db.updateTaskStatus.mockImplementation((taskId, status) => {
        if (taskId === fullId) task.status = status;
      });

      const firstResult = handler.cancelTask(fullId);
      const secondResult = handler.cancelTask(fullId);

      expect(firstResult).toBe(true);
      expect(secondResult).toBe(false);
      expect(deps.db.updateTaskStatus).toHaveBeenCalledTimes(1);
      expect(deps.safeTriggerWebhook).toHaveBeenCalledTimes(1);
      expect(mockDispatchTaskEvent).toHaveBeenCalledTimes(1);
      expect(deps.handleWorkflowTermination).toHaveBeenCalledTimes(1);
    });

    it('continues even if db.updateTaskStatus throws (running process path)', () => {
      const fullId = 'db-error-task';
      deps.db.resolveTaskId.mockReturnValue(fullId);

      const fakeProc = {
        process: { pid: 456 },
        output: 'output',
        errorOutput: 'err',
      };
      deps.runningProcesses.set(fullId, fakeProc);
      deps.db.updateTaskStatus.mockImplementation(() => {
        throw new Error('db write failed');
      });
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'running' });

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update task'),
        'db write failed'
      );
      // Cleanup still happens after the db error
      expect(deps.cleanupChildProcessListeners).toHaveBeenCalled();
      expect(deps.cleanupProcessTracking).toHaveBeenCalled();
      expect(deps.safeTriggerWebhook).toHaveBeenCalled();
      expect(deps.handleWorkflowTermination).toHaveBeenCalled();
      expect(deps.processQueue).toHaveBeenCalled();
    });
  });
});
