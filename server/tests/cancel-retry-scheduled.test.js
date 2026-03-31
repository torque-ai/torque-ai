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

describe('cancel retry_scheduled tasks (Bug #7)', () => {
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

  it('cancels a task in retry_scheduled status', () => {
    const fullId = 'retry-sched-task-1';
    deps.db.resolveTaskId.mockReturnValue(fullId);
    deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });

    const result = handler.cancelTask(fullId, 'User cancelled');

    expect(result).toBe(true);
    expect(deps.killProcessGraceful).not.toHaveBeenCalled();
    expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
      error_output: 'User cancelled',
      cancel_reason: 'user',
    });
    expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'cancelled');
    expect(mockDispatchTaskEvent).toHaveBeenCalledWith('cancelled', expect.any(Object));
    expect(deps.handleWorkflowTermination).toHaveBeenCalledWith(fullId);
  });

  it('clears pending retry timeout when cancelling retry_scheduled task', () => {
    vi.useFakeTimers();
    try {
      const fullId = 'retry-sched-task-2';
      deps.db.resolveTaskId.mockReturnValue(fullId);
      deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });

      let retryFired = false;
      const retryTimeout = setTimeout(() => { retryFired = true; }, 30000);
      deps.pendingRetryTimeouts.set(fullId, retryTimeout);

      const result = handler.cancelTask(fullId);

      expect(result).toBe(true);
      expect(deps.pendingRetryTimeouts.has(fullId)).toBe(false);
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cancelled pending retry')
      );

      // Advance time past the retry delay — the timeout should NOT fire
      vi.advanceTimersByTime(60000);
      expect(retryFired).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('clears stall recovery attempts when cancelling retry_scheduled task', () => {
    const fullId = 'retry-sched-task-3';
    deps.db.resolveTaskId.mockReturnValue(fullId);
    deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });
    deps.stallRecoveryAttempts.set(fullId, { attempts: 1, lastStrategy: 'retry' });

    handler.cancelTask(fullId);

    expect(deps.stallRecoveryAttempts.has(fullId)).toBe(false);
  });

  it('uses timeout webhook event when reason includes timeout', () => {
    const fullId = 'retry-sched-task-4';
    deps.db.resolveTaskId.mockReturnValue(fullId);
    deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });

    handler.cancelTask(fullId, 'Stall timeout detected');

    expect(deps.safeTriggerWebhook).toHaveBeenCalledWith(fullId, 'timeout');
    expect(mockDispatchTaskEvent).toHaveBeenCalledWith('timeout', expect.any(Object));
  });

  it('does not call processQueue (no slot freed)', () => {
    const fullId = 'retry-sched-task-5';
    deps.db.resolveTaskId.mockReturnValue(fullId);
    deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });

    handler.cancelTask(fullId);

    // retry_scheduled tasks are not occupying a host slot, so processQueue
    // should not be called (same pattern as queued/blocked/pending)
    expect(deps.processQueue).not.toHaveBeenCalled();
  });

  it('cancels retry_scheduled even without a pending timeout handle', () => {
    // Edge case: the retry timeout may have already fired (transitioning
    // the task back to queued) but the status update hasn't persisted yet,
    // or the timeout was cleared by something else. cancelTask should
    // still succeed for retry_scheduled status.
    const fullId = 'retry-sched-task-6';
    deps.db.resolveTaskId.mockReturnValue(fullId);
    deps.db.getTask.mockReturnValue({ id: fullId, status: 'retry_scheduled' });
    // No entry in pendingRetryTimeouts

    const result = handler.cancelTask(fullId);

    expect(result).toBe(true);
    expect(deps.db.updateTaskStatus).toHaveBeenCalledWith(fullId, 'cancelled', {
      error_output: 'Cancelled by user',
      cancel_reason: 'user',
    });
  });
});
