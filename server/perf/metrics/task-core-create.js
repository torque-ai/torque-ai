'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures taskCore.createTask end-to-end: provider/metadata normalization,
// task.id validation, project registration check, and the INSERT INTO tasks.
//
// Injection path: setDb() — sets the module-scoped db handle in task-core.js.
//
// The fixture DB is built with createTables (base schema). The server_epoch
// column is migration-added and not in the base schema, so we add it via
// ALTER TABLE before wiring the DB into task-core.
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

  // Add migration-only column that createTask's INSERT references.
  try { fx.db.exec('ALTER TABLE tasks ADD COLUMN server_epoch INTEGER'); } catch { /* already exists */ }

  const taskCore = require('../../db/task-core');
  taskCore.setDb(fx.db);

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
