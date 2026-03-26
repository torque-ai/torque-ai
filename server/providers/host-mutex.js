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

const _hostLocks = new Map(); // hostId → Promise

/**
 * Acquire an exclusive lock for a given host.
 * Returns a release function that must be called when done.
 * If another task holds the lock, this call blocks until it's released.
 *
 * @param {string} hostId - Ollama host ID
 * @returns {Promise<Function>} Release function
 */
function acquireHostLock(hostId) {
  const prev = _hostLocks.get(hostId) || Promise.resolve();
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  _hostLocks.set(hostId, prev.then(() => lock));
  return prev.then(() => {
    logger.info(`[HostMutex] Acquired lock for host ${hostId}`);
    return release;
  });
}

module.exports = { acquireHostLock };
