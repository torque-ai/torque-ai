'use strict';

/**
 * providers/host-mutex.js — Per-host async mutex for GPU contention prevention.
 *
 * Ensures only one Ollama task runs at a time on each host. If two tasks
 * get scheduled on the same single-GPU host (race condition or multi-instance),
 * the second task waits until the first completes.
 *
 * Usage:
 *   const release = await acquireHostLock(hostId);
 *   try { ... } finally { release(); }
 */

const logger = require('../logger').child({ component: 'host-mutex' });

const _hostLocks = new Map(); // hostId -> { holder, queue }
let _nextLockEntryId = 1;

function normalizeOptions(options) {
  if (!options) return {};
  if (typeof options === 'object' && typeof options.addEventListener === 'function') {
    return { signal: options };
  }
  return options;
}

function makeAbortError(hostId, taskId) {
  const detail = taskId ? ` for task ${taskId}` : '';
  const error = new Error(`Host lock wait aborted for host ${hostId}${detail}`);
  error.name = 'AbortError';
  error.code = 'HOST_LOCK_ABORTED';
  return error;
}

function makeTimeoutError(hostId, waitTimeoutMs, taskId) {
  const detail = taskId ? ` for task ${taskId}` : '';
  const error = new Error(`Timed out after ${waitTimeoutMs}ms waiting for host lock ${hostId}${detail}`);
  error.name = 'HostLockTimeoutError';
  error.code = 'HOST_LOCK_WAIT_TIMEOUT';
  return error;
}

function getOrCreateState(hostId) {
  let state = _hostLocks.get(hostId);
  if (!state) {
    state = { holder: null, queue: [] };
    _hostLocks.set(hostId, state);
  }
  return state;
}

function cleanupEntry(entry) {
  if (entry.abortHandler && entry.signal) {
    entry.signal.removeEventListener('abort', entry.abortHandler);
  }
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
  }
  entry.abortHandler = null;
  entry.timeoutHandle = null;
}

function cleanupHolderAbort(entry) {
  if (entry.holderAbortHandler && entry.signal) {
    entry.signal.removeEventListener('abort', entry.holderAbortHandler);
  }
  entry.holderAbortHandler = null;
}

function pruneState(hostId, state) {
  if (!state.holder && state.queue.length === 0) {
    _hostLocks.delete(hostId);
  }
}

function removeQueuedEntry(hostId, entry, error) {
  const state = _hostLocks.get(hostId);
  if (!state || entry.acquired || entry.settled) return false;

  const index = state.queue.indexOf(entry);
  if (index !== -1) state.queue.splice(index, 1);
  entry.cancelled = true;
  entry.settled = true;
  cleanupEntry(entry);
  logger.info(`[HostMutex] Cancelled waiter for host ${hostId}${entry.taskId ? ` task=${entry.taskId}` : ''}`);
  entry.reject(error);
  pruneState(hostId, state);
  return true;
}

function drainHostQueue(hostId) {
  const state = _hostLocks.get(hostId);
  if (!state || state.holder) return;

  while (state.queue.length > 0) {
    const entry = state.queue.shift();
    if (entry.cancelled || entry.settled) continue;

    entry.acquired = true;
    entry.settled = true;
    entry.acquiredAt = Date.now();
    state.holder = entry;
    cleanupEntry(entry);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      cleanupHolderAbort(entry);

      const current = _hostLocks.get(hostId);
      if (!current || current.holder !== entry) return;

      current.holder = null;
      logger.info(`[HostMutex] Released lock for host ${hostId}${entry.taskId ? ` task=${entry.taskId}` : ''}`);
      if (current.queue.length === 0) {
        _hostLocks.delete(hostId);
        return;
      }
      setImmediate(() => drainHostQueue(hostId));
    };

    if (entry.signal) {
      entry.holderAbortHandler = () => {
        logger.info(`[HostMutex] Releasing lock for host ${hostId}${entry.taskId ? ` task=${entry.taskId}` : ''} after abort`);
        release();
      };
      entry.signal.addEventListener('abort', entry.holderAbortHandler, { once: true });
      if (entry.signal.aborted) {
        entry.holderAbortHandler();
      }
    }

    const waitedMs = Math.max(0, entry.acquiredAt - entry.enqueuedAt);
    logger.info(`[HostMutex] Acquired lock for host ${hostId}${entry.taskId ? ` task=${entry.taskId}` : ''} after ${waitedMs}ms`);
    entry.resolve(release);
    return;
  }

  pruneState(hostId, state);
}

/**
 * Acquire an exclusive lock for a given host.
 * Returns a release function that must be called when done.
 * If another task holds the lock, this call blocks until it's released.
 *
 * @param {string} hostId - Ollama host ID
 * @param {Object|AbortSignal} [options]
 * @param {AbortSignal} [options.signal] - Cancels a queued waiter before acquire
 * @param {number} [options.waitTimeoutMs] - Optional wait timeout in milliseconds
 * @param {string} [options.taskId] - Optional task id for diagnostics
 * @returns {Promise<Function>} Release function
 */
function acquireHostLock(hostId, options = {}) {
  const lockOptions = normalizeOptions(options);
  const normalizedHostId = String(hostId || 'default-host');
  const taskId = lockOptions.taskId || lockOptions.label || null;
  const signal = lockOptions.signal || null;
  const waitTimeoutMs = Number(lockOptions.waitTimeoutMs);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(normalizedHostId, taskId));
      return;
    }

    const state = getOrCreateState(normalizedHostId);
    const entry = {
      id: _nextLockEntryId++,
      hostId: normalizedHostId,
      taskId,
      signal,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      acquiredAt: null,
      acquired: false,
      settled: false,
      cancelled: false,
      abortHandler: null,
      timeoutHandle: null,
    };

    if (signal) {
      entry.abortHandler = () => {
        removeQueuedEntry(normalizedHostId, entry, makeAbortError(normalizedHostId, taskId));
      };
      signal.addEventListener('abort', entry.abortHandler, { once: true });
    }

    if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        removeQueuedEntry(normalizedHostId, entry, makeTimeoutError(normalizedHostId, waitTimeoutMs, taskId));
      }, waitTimeoutMs);
      entry.timeoutHandle.unref?.();
    }

    state.queue.push(entry);
    if (state.holder || state.queue.length > 1) {
      logger.info(`[HostMutex] Queued waiter for host ${normalizedHostId}${taskId ? ` task=${taskId}` : ''}; depth=${state.queue.length}`);
    }
    drainHostQueue(normalizedHostId);
  });
}

function getHostLockSnapshot(hostId = null) {
  const serializeState = (state) => ({
    holder: state.holder ? {
      taskId: state.holder.taskId,
      enqueuedAt: state.holder.enqueuedAt,
      acquiredAt: state.holder.acquiredAt,
      heldMs: state.holder.acquiredAt ? Date.now() - state.holder.acquiredAt : null,
    } : null,
    queueLength: state.queue.length,
    waiters: state.queue.map((entry) => ({
      taskId: entry.taskId,
      enqueuedAt: entry.enqueuedAt,
      waitedMs: Date.now() - entry.enqueuedAt,
    })),
  });

  if (hostId !== null && hostId !== undefined) {
    const state = _hostLocks.get(String(hostId));
    return state ? serializeState(state) : { holder: null, queueLength: 0, waiters: [] };
  }

  const snapshot = {};
  for (const [lockedHostId, state] of _hostLocks.entries()) {
    snapshot[lockedHostId] = serializeState(state);
  }
  return snapshot;
}

function _resetHostLocksForTests() {
  for (const state of _hostLocks.values()) {
    for (const entry of state.queue) {
      cleanupEntry(entry);
      entry.cancelled = true;
      entry.settled = true;
    }
    if (state.holder) {
      cleanupEntry(state.holder);
      cleanupHolderAbort(state.holder);
    }
  }
  _hostLocks.clear();
  _nextLockEntryId = 1;
}

module.exports = {
  acquireHostLock,
  getHostLockSnapshot,
  _resetHostLocksForTests,
};
