'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures isRestartBarrierActive(db) wall time, batched 1000x per run() call
// to amplify a sub-microsecond per-call cost into a measurable median.
//
// SCOPE LIMITATION: The full restart-barrier flow (barrier task creation +
// queue-drain-and-shutdown synchronization) cannot be reproduced cleanly
// in-process — it requires real eventBus subscriptions, queue scheduler
// init, and signal handlers. This metric captures only the per-scheduler-
// tick barrier-check primitive, which is the part that runs on every
// queue-scheduler iteration. Phase 1 (sync I/O) and Phase 2 (N+1) won't
// move this metric meaningfully — the function does one indexed SELECT.
// The dev-iteration signal worth tracking lives in worktree-lifecycle
// (metric #12). This metric exists for structural coverage of the barrier
// primitive in case future work changes its shape.

const BATCH_SIZE = 1000;

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 0 });
  // Seed one system-provider task so isRestartBarrierActive returns a row
  // (the function exits early on a hit, but the SELECT still runs first;
  // a non-empty matching set exercises the index hit path).
  fx.db.prepare(
    `INSERT INTO tasks (id, project, status, task_description, created_at, provider)
     VALUES (?, ?, 'queued', ?, ?, 'system')`
  ).run(`perf-barrier-${process.pid}`, fx.projectId, 'Perf barrier seed task', new Date().toISOString());
  const { isRestartBarrierActive } = require('../../execution/restart-barrier');
  cached = { fx, isRestartBarrierActive };
  return cached;
}

async function run(_ctx) {
  const { isRestartBarrierActive, fx } = lazyLoad();
  const start = performance.now();
  for (let i = 0; i < BATCH_SIZE; i++) {
    isRestartBarrierActive(fx.db);
  }
  const elapsed = performance.now() - start;
  // Return per-call median (elapsed / BATCH_SIZE) for stability across runs.
  return { value: elapsed / BATCH_SIZE };
}

module.exports = {
  id: 'restart-barrier',
  name: 'Restart barrier check (per-call, 1000x amplified)',
  category: 'dev-iteration',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run
};
