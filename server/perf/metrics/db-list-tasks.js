'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures listTasks({project, limit: 1000}) wall time. Two variants:
// - 'parsed' (default): listTasks parses tags/files_modified/context JSON
//   per row. With 1000 rows, that's 3000 JSON.parse calls.
// - 'raw': forward-compatible variant for the planned Phase 3 listTasks({raw:true})
//   option that skips per-row JSON parsing. Until that option ships, this
//   variant measures the same code path as 'parsed' — a future Phase 3
//   implementation will produce divergent timings automatically.
//
// CAUTION: taskCore.setDb is module-global. See task-core-create.js for the
// fuller treatment of the setDb contention concern.

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 1000 });
  const taskCore = require('../../db/task-core');
  if (typeof taskCore.setDb === 'function') {
    taskCore.setDb(fx.db);
  } else {
    throw new Error('db-list-tasks: taskCore.setDb not found');
  }
  cached = { fx, taskCore };
  return cached;
}

async function run(ctx) {
  const { taskCore, fx } = lazyLoad();
  const opts = { project: fx.projectId, limit: 1000 };
  if (ctx.variant === 'raw') opts.raw = true; // forward-compatible (no-op until Phase 3)
  const start = performance.now();
  const tasks = taskCore.listTasks(opts);
  const elapsed = performance.now() - start;
  if (!Array.isArray(tasks)) throw new Error(`db-list-tasks: expected array, got ${typeof tasks}`);
  return { value: elapsed };
}

module.exports = {
  id: 'db-list-tasks',
  name: 'DB: listTasks 1000 rows',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  variants: ['parsed', 'raw'],
  run
};
