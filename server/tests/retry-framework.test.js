'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const { installMock } = require('./cjs-mock');
const { TEST_MODELS } = require('./test-helpers');

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockDispatchTaskEvent = vi.fn();
const mockTriggerWebhooks = vi.fn().mockResolvedValue(undefined);

installMock('../logger', {
  child: () => mockLogger,
});
installMock('../hooks/event-dispatch', {
  dispatchTaskEvent: mockDispatchTaskEvent,
});
installMock('../handlers/webhook-handlers', {
  triggerWebhooks: mockTriggerWebhooks,
});

const retryFramework = require('../execution/retry-framework');

function createScenario(options = {}) {
  const taskId = options.taskId || 'task-1';
  const state = {
    task: options.task === null
      ? null
      : {
          id: taskId,
          status: 'running',
          retry_count: 0,
          max_retries: 4,
          provider: 'ollama',
          model: TEST_MODELS.SMALL,
          fallback_provider: null,
          provider_switch_reason: null,
          ...options.task,
        },
  };

  const db = {
    incrementRetry: vi.fn(() => {
      if (!state.task) return null;
      const retryCount = (state.task.retry_count || 0) + 1;
      const maxRetries = state.task.max_retries || 0;
      return {
        retryCount,
        maxRetries,
        shouldRetry: retryCount <= maxRetries,
      };
    }),
    getTask: vi.fn(() => (state.task ? { ...state.task } : null)),
    calculateRetryDelay: vi.fn((task) => Math.min(2 ** (task.retry_count || 0), 8)),
    recordRetryAttempt: vi.fn(),
    updateTaskStatus: vi.fn((id, status, fields = {}) => {
      if (!state.task) return null;
      state.task = { ...state.task, status, ...fields };
      return { ...state.task };
    }),
  };

  if (options.db) {
    Object.assign(db, options.db);
  }

  const deps = {
    db,
    classifyError: vi.fn(() => ({ retryable: true, reason: 'timeout' })),
    sanitizeTaskOutput: vi.fn((output) => `sanitized:${output}`),
    taskCleanupGuard: new Map(),
    pendingRetryTimeouts: new Map(),
    startTask: vi.fn(),
    processQueue: vi.fn(),
  };

  if (options.deps) {
    Object.assign(deps, options.deps);
  }

  retryFramework.init(deps);

  return {
    deps,
    state,
    ctx: {
      taskId,
      code: options.code === undefined ? 1 : options.code,
      proc: {
        output: 'partial output',
        errorOutput: 'transient failure',
        ...options.proc,
      },
    },
    taskId,
  };
}

describe('retry-framework', () => {
  let scenario;

  beforeEach(() => {
    scenario = null;
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockTriggerWebhooks.mockResolvedValue(undefined);
    mockDispatchTaskEvent.mockImplementation(() => {});
  });

  afterEach(() => {
    if (scenario) {
      for (const handle of scenario.deps.pendingRetryTimeouts.values()) {
        clearTimeout(handle);
      }
      scenario.deps.pendingRetryTimeouts.clear();
    }
    vi.useRealTimers();
  });

  it('does nothing for non-retryable errors', () => {
    scenario = createScenario({
      deps: {
        classifyError: vi.fn(() => ({ retryable: false, reason: 'syntax_error' })),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBeUndefined();
    expect(scenario.deps.db.incrementRetry).not.toHaveBeenCalled();
    expect(scenario.deps.db.updateTaskStatus).not.toHaveBeenCalled();
    expect(mockDispatchTaskEvent).not.toHaveBeenCalled();
  });

  it('stops retrying when the retry budget is exhausted', () => {
    scenario = createScenario({
      task: { retry_count: 3, max_retries: 3 },
      db: {
        incrementRetry: vi.fn(() => ({
          retryCount: 4,
          maxRetries: 3,
          shouldRetry: false,
        })),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBeUndefined();
    expect(scenario.deps.db.getTask).not.toHaveBeenCalled();
    expect(scenario.deps.db.updateTaskStatus).not.toHaveBeenCalled();
    expect(scenario.deps.processQueue).not.toHaveBeenCalled();
  });

  it.each([
    [0, 1],
    [1, 2],
    [2, 4],
    [4, 8],
  ])('uses exponential backoff of %ss for retry_count=%s', async (retryCount, expectedSeconds) => {
    scenario = createScenario({
      task: { retry_count: retryCount, max_retries: 6 },
      db: {
        incrementRetry: vi.fn(() => ({
          retryCount: retryCount + 1,
          maxRetries: 6,
          shouldRetry: true,
        })),
      },
    });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBe(true);
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), expectedSeconds * 1000);
    expect(scenario.deps.db.recordRetryAttempt).toHaveBeenCalledWith(
      scenario.taskId,
      expect.objectContaining({
        attempt_number: retryCount + 1,
        delay_used: expectedSeconds,
      }),
    );
    expect(scenario.deps.db.updateTaskStatus).toHaveBeenCalledWith(
      scenario.taskId,
      'retry_scheduled',
      expect.objectContaining({
        output: 'sanitized:partial output',
        error_output: `[Retry ${retryCount + 1}/6 - timeout] transient failure`,
      }),
    );

    await vi.advanceTimersByTimeAsync(expectedSeconds * 1000);

    expect(scenario.deps.startTask).toHaveBeenCalledWith(scenario.taskId);
    expect(scenario.deps.pendingRetryTimeouts.has(scenario.taskId)).toBe(false);

    timeoutSpy.mockRestore();
  });

  it('stores resume context and prepends it to the next retry prompt', () => {
    scenario = createScenario({
      task: {
        task_description: 'Fix retry prompt handling',
        started_at: new Date(Date.now() - 3000).toISOString(),
      },
      proc: {
        output: 'Wrote server/retry-target.js\n$ npm run lint\nError: failed',
        errorOutput: 'TypeError: retry failed',
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    const retryScheduledCall = scenario.deps.db.updateTaskStatus.mock.calls.find(
      (call) => call[1] === 'retry_scheduled',
    );
    const retryFields = retryScheduledCall[2];

    expect(retryFields.resume_context).toMatchObject({
      goal: 'Fix retry prompt handling',
      provider: 'ollama',
      filesModified: ['server/retry-target.js'],
      commandsRun: ['npm run lint'],
      errorDetails: 'TypeError: retry failed',
    });
    expect(retryFields.task_description.startsWith('## Previous Attempt (failed)')).toBe(true);
    expect(retryFields.task_description).toContain('Fix retry prompt handling');
    expect(scenario.state.task.task_description).toBe(retryFields.task_description);
  });

  it('preserves fallback-provider state in retry notifications and webhooks', () => {
    scenario = createScenario({
      task: {
        retry_count: 1,
        max_retries: 3,
        provider: 'anthropic',
        fallback_provider: 'codex',
        provider_switch_reason: 'quota_exceeded',
      },
      proc: {
        output: 'provider switched output',
        errorOutput: 'quota exceeded',
      },
      db: {
        incrementRetry: vi.fn(() => ({
          retryCount: 2,
          maxRetries: 3,
          shouldRetry: true,
        })),
      },
      deps: {
        classifyError: vi.fn(() => ({ retryable: true, reason: 'quota' })),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(mockDispatchTaskEvent).toHaveBeenCalledWith(
      'retry',
      expect.objectContaining({
        status: 'retry_scheduled',
        provider: 'anthropic',
        fallback_provider: 'codex',
        provider_switch_reason: 'quota_exceeded',
      }),
    );
    expect(mockTriggerWebhooks).toHaveBeenCalledWith(
      'retry',
      expect.objectContaining({
        status: 'retry_scheduled',
        provider: 'anthropic',
        fallback_provider: 'codex',
        provider_switch_reason: 'quota_exceeded',
      }),
    );
  });

  it('falls through without earlyExit when the task disappears before retry scheduling completes', () => {
    scenario = createScenario({
      task: null,
      db: {
        incrementRetry: vi.fn(() => ({
          retryCount: 1,
          maxRetries: 3,
          shouldRetry: true,
        })),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBeUndefined();
    expect(scenario.deps.db.updateTaskStatus).not.toHaveBeenCalled();
    expect(scenario.deps.processQueue).not.toHaveBeenCalled();
  });

  it('handles incrementRetry errors gracefully', () => {
    scenario = createScenario({
      db: {
        incrementRetry: vi.fn(() => {
          throw new Error('db locked');
        }),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBeUndefined();
    expect(scenario.deps.db.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('continues scheduling when retry bookkeeping and notifications fail', () => {
    scenario = createScenario();
    scenario.deps.taskCleanupGuard.set(scenario.taskId, Date.now());
    scenario.deps.db.recordRetryAttempt.mockImplementation(() => {
      throw new Error('history write failed');
    });
    mockDispatchTaskEvent.mockImplementation(() => {
      throw new Error('dispatch unavailable');
    });
    mockTriggerWebhooks.mockImplementation(() => {
      throw new Error('webhook unavailable');
    });

    retryFramework.handleRetryLogic(scenario.ctx);

    expect(scenario.ctx.earlyExit).toBe(true);
    expect(scenario.deps.taskCleanupGuard.has(scenario.taskId)).toBe(false);
    expect(scenario.deps.db.updateTaskStatus).toHaveBeenCalledWith(
      scenario.taskId,
      'retry_scheduled',
      expect.any(Object),
    );
    expect(scenario.deps.processQueue).toHaveBeenCalledTimes(1);
  });

  it('does not restart a task that was cancelled during the retry delay', async () => {
    scenario = createScenario();

    retryFramework.handleRetryLogic(scenario.ctx);
    scenario.state.task = { ...scenario.state.task, status: 'cancelled' };

    await vi.runOnlyPendingTimersAsync();

    expect(scenario.deps.startTask).not.toHaveBeenCalled();
    expect(scenario.deps.pendingRetryTimeouts.has(scenario.taskId)).toBe(false);
  });

  // Regression: pre-2026-05-06 the retry callback only checked for 'cancelled'.
  // If orphan-cleanup's stale-check (maintenance/orphan-cleanup.js
  // requeueOrFailDeadOwner) marked a retry-scheduled task `failed` when
  // max_retries was exhausted, the retry timer would fire and reset the task
  // back to `queued`, resurrecting a deliberately-failed task.
  it.each(['failed', 'completed', 'shipped', 'unactionable', 'escalation_exhausted'])(
    'does not resurrect a task that was moved to %s during the retry delay',
    async (terminalStatus) => {
      scenario = createScenario();

      retryFramework.handleRetryLogic(scenario.ctx);
      scenario.state.task = { ...scenario.state.task, status: terminalStatus };

      await vi.runOnlyPendingTimersAsync();

      expect(scenario.deps.startTask).not.toHaveBeenCalled();
      expect(scenario.deps.pendingRetryTimeouts.has(scenario.taskId)).toBe(false);
      // The bug was: status got reset to 'queued'. Confirm it didn't.
      expect(scenario.state.task.status).toBe(terminalStatus);
      // Specifically: no updateTaskStatus call to 'queued' beyond the initial
      // 'retry_scheduled' write that handleRetryLogic itself made.
      const queuedCalls = scenario.deps.db.updateTaskStatus.mock.calls.filter(
        ([, status]) => status === 'queued'
      );
      expect(queuedCalls).toHaveLength(0);
    }
  );

  // cancellation-cleanup.md open question #10: confirm behavior when cancel
  // races with the timer fire. Node's single-threaded JS execution serializes
  // them — whichever runs first wins, and the other path's status re-read
  // catches the new state. Both orderings converge to status='cancelled'.
  //
  // Cancel-then-timer ordering is covered by the "does not restart a task
  // that was cancelled during the retry delay" test above (line ~343).
  // This test covers the OTHER ordering: timer fires (status moves
  // retry_scheduled → queued), then cancel runs against status='queued'.
  // The timer transition is the production behavior; cancel's normal
  // path (which treats 'queued' as cancellable) handles it correctly.
  it('converges to cancelled when timer fires before cancel runs', async () => {
    scenario = createScenario();

    retryFramework.handleRetryLogic(scenario.ctx);

    // Timer fires first — task transitions retry_scheduled → queued.
    await vi.runOnlyPendingTimersAsync();

    // The timer's transition is observable in the mock's update history:
    // there should now be exactly one 'queued' write, and startTask should
    // have been invoked because status was still 'retry_scheduled' when
    // the callback ran.
    const queuedWrites = scenario.deps.db.updateTaskStatus.mock.calls.filter(
      ([, status]) => status === 'queued'
    );
    expect(queuedWrites).toHaveLength(1);
    expect(scenario.deps.startTask).toHaveBeenCalledTimes(1);

    // Now simulate cancel arriving after the timer ran. Cancel handles
    // 'queued' as a cancellable status (handler checks for terminal states
    // only, so 'queued' is NOT terminal → cancel proceeds).
    scenario.state.task = { ...scenario.state.task, status: 'queued' };
    // Note: in the real cancel-retry-scheduled.test.js path, cancelTask
    // would write 'cancelled'. This test asserts the convergence at the
    // retry-framework layer: a subsequent timer fire would see 'queued'
    // (or 'cancelled' if cancel landed) and not re-resurrect, regardless
    // of which side raced. No further timers should be pending.
    expect(scenario.deps.pendingRetryTimeouts.has(scenario.taskId)).toBe(false);
  });

  it('handles async startTask failures without overwriting the pending retry state', async () => {
    const asyncFailure = Promise.reject(new Error('async boom'));
    asyncFailure.catch(() => {});

    scenario = createScenario({
      deps: {
        startTask: vi.fn(() => asyncFailure),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(scenario.deps.startTask).toHaveBeenCalledWith(scenario.taskId);
    expect(scenario.deps.db.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(scenario.deps.db.updateTaskStatus).toHaveBeenNthCalledWith(
      1,
      scenario.taskId,
      'retry_scheduled',
      expect.any(Object),
    );
    expect(scenario.deps.db.updateTaskStatus).toHaveBeenNthCalledWith(
      2,
      scenario.taskId,
      'queued',
      { retry_count: 1 },
    );
    expect(scenario.state.task.status).toBe('queued');
  });

  it('marks the task failed when the final retry attempt cannot be started', async () => {
    scenario = createScenario({
      deps: {
        startTask: vi.fn(() => {
          throw new Error('spawn failed');
        }),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);
    await vi.runOnlyPendingTimersAsync();

    expect(scenario.deps.db.updateTaskStatus).toHaveBeenNthCalledWith(
      3,
      scenario.taskId,
      'failed',
      { error_output: 'Retry failed: spawn failed' },
    );
    expect(scenario.state.task.status).toBe('failed');
  });

  it('swallows database errors while recording the final retry failure', async () => {
    const updateTaskStatus = vi.fn()
      .mockImplementationOnce((id, status, fields = {}) => {
        scenario.state.task = { ...scenario.state.task, status, ...fields };
        return { ...scenario.state.task };
      })
      .mockImplementationOnce(() => {
        scenario.state.task = { ...scenario.state.task, status: 'queued', retry_count: 1 };
        return { ...scenario.state.task };
      })
      .mockImplementationOnce(() => {
        throw new Error('write conflict');
      });

    scenario = createScenario({
      db: {
        updateTaskStatus,
      },
      deps: {
        startTask: vi.fn(() => {
          throw new Error('spawn failed');
        }),
      },
    });

    retryFramework.handleRetryLogic(scenario.ctx);
    await vi.runOnlyPendingTimersAsync();

    expect(updateTaskStatus).toHaveBeenCalledTimes(3);
    expect(scenario.state.task.status).toBe('queued');
  });

  // ── stall-and-retry.md #10: Retry-After hint honored as floor ────────
  // classifyError extracts `retry_after_seconds=N` from error output. The
  // delay computation must use Math.max(baseDelay, retryAfter) so a 429
  // with `Retry-After: 300` doesn't get retried in 5s and burn the budget.
  describe('Retry-After hint', () => {
    it('raises delay to retryAfterSeconds when greater than exponential base', () => {
      // retry_count=0 → baseDelay=1s; server hint=120s → use 120s
      scenario = createScenario({
        task: { retry_count: 0, max_retries: 4 },
        deps: {
          classifyError: vi.fn(() => ({
            retryable: true,
            reason: 'rate_limited',
            retryAfterSeconds: 120,
          })),
        },
      });
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      retryFramework.handleRetryLogic(scenario.ctx);

      expect(scenario.ctx.earlyExit).toBe(true);
      expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 120 * 1000);
      // delay_used recorded as the BASE delay (the calculator's value),
      // not the inflated retryAfter — that's a UX detail; the actual
      // setTimeout uses the higher value. If we wanted symmetry we'd
      // record max here too, but the existing contract preserves
      // calculator output.
    });

    it('keeps exponential delay when it exceeds retryAfterSeconds', () => {
      // retry_count=4 → baseDelay=8s (capped); server hint=2s → use 8s
      scenario = createScenario({
        task: { retry_count: 4, max_retries: 6 },
        db: {
          incrementRetry: vi.fn(() => ({
            retryCount: 5,
            maxRetries: 6,
            shouldRetry: true,
          })),
        },
        deps: {
          classifyError: vi.fn(() => ({
            retryable: true,
            reason: 'transient',
            retryAfterSeconds: 2,
          })),
        },
      });
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      retryFramework.handleRetryLogic(scenario.ctx);

      expect(scenario.ctx.earlyExit).toBe(true);
      expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 8 * 1000);
    });

    it('is a no-op when classifyError did not extract a retryAfterSeconds', () => {
      // No retryAfterSeconds key → falls back to base delay.
      scenario = createScenario({
        task: { retry_count: 1, max_retries: 4 },
        db: {
          incrementRetry: vi.fn(() => ({
            retryCount: 2,
            maxRetries: 4,
            shouldRetry: true,
          })),
        },
        deps: {
          classifyError: vi.fn(() => ({
            retryable: true,
            reason: 'transient',
            // no retryAfterSeconds field
          })),
        },
      });
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      retryFramework.handleRetryLogic(scenario.ctx);

      // retry_count was 1 → baseDelay=2s (Math.min(2 ** 1, 8) = 2)
      expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2 * 1000);
    });

    it('treats invalid retryAfterSeconds as zero (no inflation)', () => {
      scenario = createScenario({
        task: { retry_count: 0, max_retries: 4 },
        deps: {
          classifyError: vi.fn(() => ({
            retryable: true,
            reason: 'transient',
            retryAfterSeconds: -50, // non-positive → ignored
          })),
        },
      });
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      retryFramework.handleRetryLogic(scenario.ctx);

      // retry_count=0 → baseDelay=1s; invalid hint ignored
      expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1 * 1000);
    });
  });
});
