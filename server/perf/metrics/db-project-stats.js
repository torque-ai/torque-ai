'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures projectConfigCore.getProjectStats(project) wall time directly.
// This is the DB-layer counterpart to handler-project-stats (Task 8) — same
// 1000-task fixture, same query work, just without the handler-shape wrapper.
//
// Phase 2 (N+1 + missing indexes) will move this metric: getProjectStats
// today issues 7 sequential queries plus per-row JSON.parse in the
// tag-frequency path.
//
// CAUTION: projectConfigCore.setDb is module-global. See the comment in
// handler-project-stats.js — same setDb handle is shared.

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 1000 });
  const projectConfigCore = require('../../db/project-config-core');
  if (typeof projectConfigCore.setDb === 'function') {
    projectConfigCore.setDb(fx.db);
  }
  cached = { fx, projectConfigCore };
  return cached;
}

async function run(ctx) {
  const { projectConfigCore, fx } = lazyLoad();
  const start = performance.now();
  const stats = projectConfigCore.getProjectStats(fx.projectId);
  const elapsed = performance.now() - start;
  if (!stats) throw new Error('db-project-stats: getProjectStats returned null');
  return { value: elapsed };
}

module.exports = {
  id: 'db-project-stats',
  name: 'DB: getProjectStats (1000-task project)',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run
};
