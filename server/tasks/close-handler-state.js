'use strict';

/**
 * tasks/close-handler-state.js — bookkeeping for pending task close handlers.
 *
 * On task process exit, the close handler runs async work (auto-verify,
 * file-write checks, retry decisions). Tests need to be able to wait for
 * all in-flight close-handler work to settle before tearing down DB state,
 * otherwise execFileSync('git', ...) calls inside the close handler get
 * orphaned when vitest kills worker forks (notably on Windows).
 *
 * This module owns:
 *   - the pending-close-handler counter
 *   - the list of waiters that drain when the counter hits zero
 *   - the drainResolvers / waitForPending helpers
 *
 * The counter is mutated by execution/process-lifecycle.js via the
 * accessor object returned by createCloseHandlerState() — task-manager.js
 * passes that accessor through DI so the lifecycle module can update the
 * count without taking a hard dependency on this module.
 *
 * Extracted from task-manager.js to give the bookkeeping its own module.
 */

let pendingCloseHandlers = 0;
let closeHandlerResolvers = [];

/** Resolve any promises waiting for close handlers to finish. */
function drainCloseHandlerResolvers() {
  if (pendingCloseHandlers <= 0) {
    pendingCloseHandlers = 0; // clamp to zero
    const resolvers = closeHandlerResolvers;
    closeHandlerResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/**
 * Wait for all in-flight close handlers to complete.
 * Returns immediately if none are pending.
 * @param {number} timeout - Max wait time in ms (default 15000)
 */
function waitForPendingHandlers(timeout = 15000) {
  if (pendingCloseHandlers <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let wrappedResolve;
    const timer = setTimeout(() => {
      closeHandlerResolvers = closeHandlerResolvers.filter(r => r !== wrappedResolve);
      resolve(); // don't reject — just stop waiting
    }, timeout);
    wrappedResolve = () => { clearTimeout(timer); resolve(); };
    closeHandlerResolvers.push(wrappedResolve);
  });
}

/**
 * Build the accessor object that execution/process-lifecycle.js receives
 * via DI. Mutates the module-level counter through getter/setter so the
 * lifecycle code never sees this module directly.
 */
function createCloseHandlerStateAccessor() {
  return {
    get count() { return pendingCloseHandlers; },
    set count(v) { pendingCloseHandlers = v; },
    drain: drainCloseHandlerResolvers,
  };
}

// Test helper — reset to a clean state.
function _resetForTest() {
  pendingCloseHandlers = 0;
  closeHandlerResolvers = [];
}

module.exports = {
  drainCloseHandlerResolvers,
  waitForPendingHandlers,
  createCloseHandlerStateAccessor,
  _resetForTest,
  // Read-only views for tests / orphan-cleanup heartbeats.
  getPendingCount: () => pendingCloseHandlers,
};
