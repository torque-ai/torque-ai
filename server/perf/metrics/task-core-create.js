'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures taskCore.createTask end-to-end: provider/metadata normalization,
// task.id validation, project registration check, and the INSERT INTO tasks.
//
// Injection path: setDb() — sets the module-scoped db handle in task-core.js.
//
// CAUTION: taskCore.setDb is module-global. Only one metric per perf-run
// process may own it. If a future metric also needs taskCore (e.g.,
// db-list-tasks Task 13), either it must reuse this metric's fixture or the
// metrics need a per-instance taskCore factory. The driver runs metrics
// sequentially in one process, so within a run setDb-using metrics will see
// the LAST handle wired in. For Phase 0 v0 only this metric uses setDb.
//
// The fixture DB is built with buildFixture (base schema + server_epoch patch).
// The server_epoch column is migration-added and not in the base schema;
// fixtures.js applies the ALTER TABLE idempotently so all metrics benefit.
//
// Excludes:
//   - working_directory stat (no working_directory passed)
//   - downstream pipeline steps (governance, budget, smart routing)
//
// Each iteration inserts a unique task ID so rows do not collide. The DB stays
// in memory and is never closed between iterations.

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 0 });
  const taskCore = require('../../db/task-core');
  if (typeof taskCore.setDb === 'function') {
    taskCore.setDb(fx.db);
  } else if (typeof taskCore.createTaskCore === 'function') {
    taskCore.createTaskCore({ db: fx.db });
  } else {
    throw new Error('task-core: no injection path found');
  }
  cached = { fx, taskCore };
  return cached;
}

let counter = 0;

async function run(ctx) {
  const { taskCore } = lazyLoad();
  counter += 1;
  const taskId = `perf-create-${process.pid}-${counter}`;
  const start = performance.now();
  taskCore.createTask({
    id: taskId,
    task_description: 'Perf measurement task — measure createTask wall time',
    project: 'perf-fixture',
    // Intentionally no working_directory (skips fs.statSync)
    // Intentionally no provider (uses default codex)
  });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'task-core-create',
  name: 'Task DB createTask (with validation)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run,
};
