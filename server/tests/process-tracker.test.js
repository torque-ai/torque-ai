'use strict';

const ProcessTracker = require('../execution/process-tracker');

describe('ProcessTracker', () => {
  let tracker;
  const taskId = 'test-task-001';

  beforeEach(() => {
    tracker = new ProcessTracker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Map compatibility', () => {
    it('is an instance of Map', () => {
      expect(tracker).toBeInstanceOf(Map);
    });

    it('supports set/get/has/delete', () => {
      const entry = { process: { pid: 100 }, output: 'hello' };
      tracker.set(taskId, entry);

      expect(tracker.has(taskId)).toBe(true);
      expect(tracker.get(taskId)).toBe(entry);
      expect(tracker.size).toBe(1);

      tracker.delete(taskId);
      expect(tracker.has(taskId)).toBe(false);
      expect(tracker.size).toBe(0);
    });

    it('supports keys() iteration', () => {
      tracker.set('a', {});
      tracker.set('b', {});
      tracker.set('c', {});

      const keys = [...tracker.keys()];
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('supports entries() iteration', () => {
      const entry = { process: {} };
      tracker.set(taskId, entry);

      const entries = [...tracker.entries()];
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(taskId);
      expect(entries[0][1]).toBe(entry);
    });

    it('supports clear()', () => {
      tracker.set('a', {});
      tracker.set('b', {});
      tracker.clear();
      expect(tracker.size).toBe(0);
    });

    it('supports for..of iteration', () => {
      tracker.set('x', { output: '1' });
      tracker.set('y', { output: '2' });

      const collected = [];
      for (const [id, entry] of tracker) {
        collected.push({ id, output: entry.output });
      }
      expect(collected).toEqual([
        { id: 'x', output: '1' },
        { id: 'y', output: '2' },
      ]);
    });
  });

  describe('getProcess', () => {
    it('returns the child process object', () => {
      const proc = { pid: 1234, kill: vi.fn() };
      tracker.set(taskId, { process: proc });
      expect(tracker.getProcess(taskId)).toBe(proc);
    });

    it('returns undefined for unknown task', () => {
      expect(tracker.getProcess('nonexistent')).toBeUndefined();
    });
  });

  describe('getOutput / getErrorOutput', () => {
    it('returns accumulated output strings', () => {
      tracker.set(taskId, {
        output: 'stdout data',
        errorOutput: 'stderr data',
      });
      expect(tracker.getOutput(taskId)).toBe('stdout data');
      expect(tracker.getErrorOutput(taskId)).toBe('stderr data');
    });

    it('returns undefined for unknown tasks', () => {
      expect(tracker.getOutput('nope')).toBeUndefined();
      expect(tracker.getErrorOutput('nope')).toBeUndefined();
    });
  });

  describe('appendOutput', () => {
    it('appends stdout chunks and updates lastOutputAt', () => {
      const entry = { output: 'a', lastOutputAt: Date.now() - 10_000 };
      tracker.set(taskId, entry);

      const before = Date.now();
      const newLen = tracker.appendOutput(taskId, 'b');
      expect(newLen).toBe(2);
      expect(tracker.getOutput(taskId)).toBe('ab');
      expect(entry.lastOutputAt).toBeGreaterThanOrEqual(before);
      expect(entry.lastOutputAt).toBeLessThanOrEqual(Date.now());
    });

    it('returns -1 when entry is missing', () => {
      expect(tracker.appendOutput('missing', 'data')).toBe(-1);
    });
  });

  describe('appendErrorOutput', () => {
    it('appends stderr chunks and updates lastOutputAt', () => {
      const entry = { errorOutput: 'err', lastOutputAt: Date.now() - 10_000 };
      tracker.set(taskId, entry);

      const before = Date.now();
      const newLen = tracker.appendErrorOutput(taskId, '-next');
      expect(newLen).toBe(8);
      expect(tracker.getErrorOutput(taskId)).toBe('err-next');
      expect(entry.lastOutputAt).toBeGreaterThanOrEqual(before);
      expect(entry.lastOutputAt).toBeLessThanOrEqual(Date.now());
    });

    it('returns -1 when entry is missing', () => {
      expect(tracker.appendErrorOutput('missing', 'oops')).toBe(-1);
    });
  });

  describe('getElapsedMs', () => {
    it('returns elapsed time since startTime', () => {
      const now = Date.now();
      tracker.set(taskId, { startTime: now - 2500 });
      expect(tracker.getElapsedMs(taskId)).toBeGreaterThanOrEqual(2400);
      expect(tracker.getElapsedMs(taskId)).toBeLessThanOrEqual(3000);
    });

    it('returns undefined for unknown task', () => {
      expect(tracker.getElapsedMs('nope')).toBeUndefined();
    });
  });

  describe('getProvider', () => {
    it('returns the provider name', () => {
      tracker.set(taskId, { provider: 'codex' });
      expect(tracker.getProvider(taskId)).toBe('codex');
    });

    it('returns undefined for unknown task', () => {
      expect(tracker.getProvider('nope')).toBeUndefined();
    });
  });

  describe('getHostId', () => {
    it('returns the Ollama host ID', () => {
      tracker.set(taskId, { ollamaHostId: 'host-abc' });
      expect(tracker.getHostId(taskId)).toBe('host-abc');
    });

    it('returns undefined for unknown task', () => {
      expect(tracker.getHostId('nope')).toBeUndefined();
    });
  });

  describe('updateHeartbeat', () => {
    it('updates lastOutputAt to current time', () => {
      const oldTime = Date.now() - 10_000;
      tracker.set(taskId, { lastOutputAt: oldTime });

      tracker.updateHeartbeat(taskId);
      const entry = tracker.get(taskId);
      expect(entry.lastOutputAt).toBeGreaterThan(oldTime);
      expect(entry.lastOutputAt).toBeLessThanOrEqual(Date.now());
    });

    it('does nothing for unknown task', () => {
      expect(() => tracker.updateHeartbeat('nonexistent')).not.toThrow();
    });
  });

  describe('getIdleSeconds', () => {
    it('returns seconds since last output', () => {
      tracker.set(taskId, { lastOutputAt: Date.now() - 30_000 });

      const idle = tracker.getIdleSeconds(taskId);
      expect(idle).toBeGreaterThanOrEqual(29);
      expect(idle).toBeLessThan(32);
    });

    it('returns undefined for unknown task', () => {
      expect(tracker.getIdleSeconds('nope')).toBeUndefined();
    });
  });

  describe('count', () => {
    it('returns size as count property', () => {
      expect(tracker.count).toBe(0);
      tracker.set('a', {});
      tracker.set('b', {});
      expect(tracker.count).toBe(2);
      tracker.delete('a');
      expect(tracker.count).toBe(1);
    });
  });

  describe('clearAndDelete', () => {
    it('clears timeout handles before deleting', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const timeoutHandle = setTimeout(() => {}, 99999);
      const startupTimeoutHandle = setTimeout(() => {}, 99999);
      const completionGraceHandle = setTimeout(() => {}, 99999);

      tracker.set(taskId, {
        timeoutHandle,
        startupTimeoutHandle,
        completionGraceHandle,
      });

      const result = tracker.clearAndDelete(taskId);
      expect(result).toBe(true);
      expect(tracker.has(taskId)).toBe(false);
      expect(clearSpy).toHaveBeenCalledWith(timeoutHandle);
      expect(clearSpy).toHaveBeenCalledWith(startupTimeoutHandle);
      expect(clearSpy).toHaveBeenCalledWith(completionGraceHandle);
    });

    it('returns false for unknown task', () => {
      expect(tracker.clearAndDelete('nonexistent')).toBe(false);
    });

    it('handles entries with no timeout handles', () => {
      tracker.set(taskId, { output: 'some data' });
      const result = tracker.clearAndDelete(taskId);
      expect(result).toBe(true);
      expect(tracker.has(taskId)).toBe(false);
    });
  });

  describe('killProcess', () => {
    it('kills the process and returns true', () => {
      const proc = { kill: vi.fn() };
      tracker.set(taskId, { process: proc });

      const result = tracker.killProcess(taskId);
      expect(result).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('returns false when the task is missing', () => {
      expect(tracker.killProcess('missing')).toBe(false);
    });

    it('returns false when kill throws', () => {
      const proc = { kill: vi.fn(() => {
        throw new Error('already dead');
      }) };
      tracker.set(taskId, { process: proc });
      expect(tracker.killProcess(taskId)).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('returns a frozen shallow copy', () => {
      const entry = { output: 'hello', process: { pid: 1 } };
      tracker.set(taskId, entry);

      const snapshot = tracker.snapshot(taskId);
      expect(snapshot).toEqual(entry);
      expect(snapshot).not.toBe(entry);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('returns null for unknown task', () => {
      expect(tracker.snapshot('missing')).toBeNull();
    });
  });

  describe('stall recovery API', () => {
    it('exposes the stallAttempts map', () => {
      expect(tracker.stallAttempts).toBeInstanceOf(Map);
      expect(tracker.stallAttempts.size).toBe(0);
    });

    it('supports get, set, and delete operations', () => {
      const state = { attempts: 2, lastStrategy: 'ping' };
      expect(tracker.getStallAttempts(taskId)).toBeUndefined();

      tracker.setStallAttempts(taskId, state);
      expect(tracker.getStallAttempts(taskId)).toBe(state);
      expect(tracker.stallAttempts.has(taskId)).toBe(true);

      expect(tracker.deleteStallAttempts(taskId)).toBe(true);
      expect(tracker.getStallAttempts(taskId)).toBeUndefined();
      expect(tracker.deleteStallAttempts(taskId)).toBe(false);
    });
  });

  describe('abort controllers', () => {
    it('supports controller lifecycle methods', () => {
      const controller = new AbortController();
      expect(tracker.getAbortController(taskId)).toBeUndefined();
      expect(tracker.abortControllers.has(taskId)).toBe(false);

      tracker.setAbortController(taskId, controller);
      expect(tracker.getAbortController(taskId)).toBe(controller);
      expect(tracker.abortControllers.get(taskId)).toBe(controller);
      expect(tracker.deleteAbortController(taskId)).toBe(true);

      expect(tracker.getAbortController(taskId)).toBeUndefined();
      expect(tracker.abortControllers.has(taskId)).toBe(false);
    });
  });

  describe('retry timeouts', () => {
    it('supports retry timeout getter/setter', () => {
      const handle = setTimeout(() => {}, 10_000);
      tracker.setRetryTimeout(taskId, handle);
      expect(tracker.getRetryTimeout(taskId)).toBe(handle);
    });

    it('cancelRetryTimeout clears timer and removes map entry', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const handle = setTimeout(() => {}, 10_000);
      tracker.setRetryTimeout(taskId, handle);

      const result = tracker.cancelRetryTimeout(taskId);
      expect(result).toBe(true);
      expect(tracker.getRetryTimeout(taskId)).toBeUndefined();
      expect(clearSpy).toHaveBeenCalledWith(handle);
    });

    it('cancelRetryTimeout is idempotent for missing ids', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      expect(tracker.cancelRetryTimeout('missing')).toBe(false);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('cancelAllRetryTimeouts clears and removes all handles', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const handleA = setTimeout(() => {}, 10_000);
      const handleB = setTimeout(() => {}, 20_000);

      tracker.setRetryTimeout('a', handleA);
      tracker.setRetryTimeout('b', handleB);

      tracker.cancelAllRetryTimeouts();
      expect(clearSpy).toHaveBeenCalledWith(handleA);
      expect(clearSpy).toHaveBeenCalledWith(handleB);
      expect(tracker.retryTimeouts.size).toBe(0);
    });
  });

  describe('cleanup guard', () => {
    it('marks cleanup state and prevents duplicate cleanup', () => {
      const first = tracker.markCleanedUp(taskId);
      const second = tracker.markCleanedUp(taskId);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(tracker.cleanupGuard.has(taskId)).toBe(true);
      expect(tracker.clearCleanupGuard(taskId)).toBe(true);
      expect(tracker.cleanupGuard.has(taskId)).toBe(false);
    });

    it('sweeps expired cleanup guard entries with TTL logic', () => {
      vi.useFakeTimers();
      try {
        const base = new Date('2026-03-11T00:00:00Z').getTime();
        tracker._cleanupGuardTtlMs = 60_000;
        tracker._cleanupSweepIntervalMs = 30_000;
        vi.setSystemTime(base);

        tracker._cleanupGuard.set('stale', base - (tracker._cleanupGuardTtlMs + 1000));
        tracker._cleanupGuard.set('alive', base + (tracker._cleanupGuardTtlMs - 5_000));
        tracker._lastCleanupSweep = base - (tracker._cleanupSweepIntervalMs + 1000);

        vi.setSystemTime(base + 62_000);
        tracker.markCleanedUp('new-task');

        expect(tracker.cleanupGuard.has('stale')).toBe(false);
        expect(tracker.cleanupGuard.has('alive')).toBe(true);
        expect(tracker.cleanupGuard.has('new-task')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('full lifecycle', () => {
    it('cleanups task, removes timers and cross maps', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const timeoutHandle = setTimeout(() => {}, 10000);
      const startupTimeoutHandle = setTimeout(() => {}, 10000);
      const completionGraceHandle = setTimeout(() => {}, 10000);

      tracker.set(taskId, {
        timeoutHandle,
        startupTimeoutHandle,
        completionGraceHandle,
      });
      tracker.setStallAttempts(taskId, { attempts: 1, lastStrategy: 'ping' });
      tracker.setAbortController(taskId, new AbortController());

      const cleanup = tracker.cleanup(taskId);
      expect(cleanup).toBe(true);
      expect(tracker.has(taskId)).toBe(false);
      expect(tracker.getStallAttempts(taskId)).toBeUndefined();
      expect(tracker.getAbortController(taskId)).toBeUndefined();
      expect(clearSpy).toHaveBeenCalledWith(timeoutHandle);
      expect(clearSpy).toHaveBeenCalledWith(startupTimeoutHandle);
      expect(clearSpy).toHaveBeenCalledWith(completionGraceHandle);
    });

    it('cleanup returns false for missing task and removes stall attempts', () => {
      tracker.setStallAttempts('missing', { attempts: 2, lastStrategy: 'none' });
      const result = tracker.cleanup('missing');
      expect(result).toBe(false);
      expect(tracker.getStallAttempts('missing')).toBeUndefined();
    });

    it('cleanupAll cleans all tracked processes and internal maps', () => {
      tracker.set('task-a', {
        timeoutHandle: setTimeout(() => {}, 10000),
      });
      tracker.set('task-b', {
        startupTimeoutHandle: setTimeout(() => {}, 10000),
      });
      tracker.setStallAttempts('task-a', { attempts: 1, lastStrategy: 'retry' });
      tracker.setAbortController('task-b', new AbortController());

      tracker.cleanupAll();

      expect(tracker.count).toBe(0);
      expect(tracker.getRunningCount()).toBe(0);
      expect(tracker.hasProcess('task-a')).toBe(false);
      expect(tracker.hasProcess('task-b')).toBe(false);
      expect(tracker.stallAttempts.size).toBe(0);
      expect(tracker.abortControllers.size).toBe(0);
    });

    it('resetAll clears runtime maps and cancels retry timers', () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const kill = vi.fn();
      tracker.set(taskId, {
        process: { pid: 1, kill },
        timeoutHandle: setTimeout(() => {}, 10_000),
        startupTimeoutHandle: setTimeout(() => {}, 10_000),
      });
      tracker.setStallAttempts(taskId, { attempts: 1, lastStrategy: 'none' });
      tracker.setAbortController(taskId, new AbortController());
      tracker.setRetryTimeout(taskId, setTimeout(() => {}, 10_000));
      tracker.markCleanedUp(taskId);

      tracker.resetAll();

      expect(tracker.count).toBe(0);
      expect(tracker.stallAttempts.size).toBe(0);
      expect(tracker.abortControllers.size).toBe(0);
      expect(tracker.cleanupGuard.size).toBe(0);
      expect(tracker.retryTimeouts.size).toBe(0);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(clearSpy).toHaveBeenCalled();
    });

    it('supports running count and hasProcess checks', () => {
      tracker.set('a', {});
      tracker.set('b', {});

      expect(tracker.getRunningCount()).toBe(2);
      expect(tracker.hasProcess('a')).toBe(true);
      expect(tracker.hasProcess('missing')).toBe(false);

      const firstCleanup = tracker.cleanup('a');
      expect(firstCleanup).toBe(true);
      expect(tracker.getRunningCount()).toBe(1);
      expect(tracker.hasProcess('a')).toBe(false);
    });

    it('returns false on double cleanup', () => {
      tracker.set(taskId, { process: { pid: 1, kill: vi.fn() } });

      expect(tracker.cleanup(taskId)).toBe(true);
      expect(tracker.cleanup(taskId)).toBe(false);
    });
  });

  describe('DI compatibility', () => {
    it('works when passed to functions expecting a Map', () => {
      function cleanupProcessTracking(proc, taskId, runningProcesses, stallRecoveryAttempts) {
        runningProcesses.delete(taskId);
        if (stallRecoveryAttempts) stallRecoveryAttempts.delete(taskId);
      }

      tracker.set(taskId, { process: { pid: 1 }, output: 'test' });
      const stallMap = new Map();
      stallMap.set(taskId, { attempts: 2 });

      cleanupProcessTracking({}, taskId, tracker, stallMap);

      expect(tracker.has(taskId)).toBe(false);
      expect(stallMap.has(taskId)).toBe(false);
    });

    it('works with destructured factory pattern', () => {
      function createHandler({ runningProcesses }) {
        return {
          cancel(taskId) {
            const entry = runningProcesses.get(taskId);
            if (entry) {
              runningProcesses.delete(taskId);
              return true;
            }
            return false;
          },
        };
      }

      tracker.set(taskId, { process: {} });
      const handler = createHandler({ runningProcesses: tracker });

      expect(handler.cancel(taskId)).toBe(true);
      expect(tracker.size).toBe(0);
    });
  });
});
