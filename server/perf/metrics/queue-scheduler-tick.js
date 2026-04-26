'use strict';

const { performance } = require('perf_hooks');
const { categorizeQueuedTasks } = require('../../execution/queue-scheduler');

// We measure the read-only categorization phase of one scheduler tick, NOT the
// promote-tasks (processQueueInternal) side-effecting path. processQueueInternal
// mutates module-scoped state and requires init() to be called first.
//
// categorizeQueuedTasks(queuedTasks, codexEnabled) accepts plain task objects and
// only touches the module-scoped `db` handle inside the late-bind routing branch,
// which is guarded by `_analyzeTaskForRouting !== null`. Since we never call
// init(), _analyzeTaskForRouting stays null and the db branch is dead. All other
// work (resolveEffectiveProvider, providerRegistry.getCategory) is pure.
//
// The fixture pre-assigns providers on all tasks so the late-bind branch never
// fires, giving stable, repeatable timings that represent per-tick categorization
// CPU cost — the first meaningful work in every scheduler tick.
//
// Note: categorizeQueuedTasks() sets task._effectiveProvider on input objects.
// Iterations 1+ run on already-stamped fixtures; this is idempotent because
// the assigned value is derived from task.provider which we set once at fixture
// build time.
//
// Scope: this metric tracks categorization wall-time only — NOT the full
// scheduler tick. The promote-tasks side-effecting path is excluded because
// processQueueInternal mutates state and requires init(). Hot-path-runtime
// metrics #2 (task-pipeline-create) and #3 (governance-evaluate) cover the
// I/O-bearing flows that Phase 1 (sync→async) and Phase 2 (N+1) will move.
// queue-scheduler-tick provides structural coverage of categorization itself.

const PROVIDERS = ['ollama', 'codex', 'groq', 'deepinfra', 'anthropic', 'codex-spark'];

function buildTaskFixture(count) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    tasks.push({
      id: `perf-task-${i.toString().padStart(6, '0')}`,
      provider: PROVIDERS[i % PROVIDERS.length],
      task_description: `Fixture task ${i} for perf measurement`,
      metadata: null,
      model: null,
    });
  }
  return tasks;
}

// Lazy-init: build the fixture once and reuse across all iterations.
let cachedTasks = null;

function getFixtureTasks() {
  if (!cachedTasks) {
    cachedTasks = buildTaskFixture(5000);
  }
  return cachedTasks;
}

async function run(ctx) {
  const tasks = getFixtureTasks();
  const start = performance.now();
  categorizeQueuedTasks(tasks, /* codexEnabled */ true);
  return { value: performance.now() - start };
}

module.exports = {
  id: 'queue-scheduler-tick',
  name: 'Queue scheduler tick (categorization phase)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 10,
  runs: 1000,
  run,
};
