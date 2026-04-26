'use strict';

/**
 * Lightweight per-process call counters for hot-path operations.
 * Tracked to the Operations > Perf dashboard panel via /api/v2/operations/perf.
 */

const _counters = {
  listTasksParsed: 0,
  listTasksRaw: 0,
  capabilitySetBuilt: 0,
  pragmaCostBudgets: 0,
  pragmaPackRegistry: 0,
};

function increment(key) {
  if (Object.prototype.hasOwnProperty.call(_counters, key)) {
    _counters[key]++;
  }
}

function getSnapshot(reset = false) {
  const snap = { ...(_counters) };
  if (reset) {
    for (const k of Object.keys(_counters)) _counters[k] = 0;
  }
  return snap;
}

module.exports = { increment, getSnapshot };
