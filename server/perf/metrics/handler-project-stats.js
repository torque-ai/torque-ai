'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures handleProjectStats({project: <id>}) wall time. This handler is the
// entry point for both the MCP `project_stats` tool and the dashboard
// /api/v2/projects/:project/stats endpoint. The HTTP framing layer (request
// parse, JSON serialization, response write) is NOT included — it's small
// relative to DB query cost.
//
// Phase 2 (N+1 queries + missing indexes) will move this metric significantly:
// getProjectStats today issues 7 sequential queries plus per-row JSON parse
// for tag frequency across all tasks in the project.
//
// Tables queried by getProjectStats:
//   tasks (x3: status GROUP BY, recent ORDER BY, tags full-scan)
//   token_usage (x1: SUM aggregation)
//   pipelines (x1: COUNT)
//   scheduled_tasks (x1: COUNT)
// All tables are created by createTables in the base schema — no extra patches
// needed in fixtures.js beyond the server_epoch column already applied by Task 6.
//
// CAUTION — setDb global state: project-config-core.setDb sets the module-scope
// db handle and cascades to sub-modules (project-cache, pipeline-crud, etc.).
// This metric's lazyLoad() calls setDb on first invocation. If task-core-create
// (metric #2) ran first in the same process its setDb call already wired a
// different fixture; this metric immediately overwrites it. The driver runs
// metrics sequentially so there is no concurrency hazard, but the last metric
// to call setDb wins for the remainder of the process. Documented here; the
// proper fix (per-instance DB handles) is deferred to Phase 2 design work.

let cached = null;

function lazyLoad() {
  if (cached) return cached;

  const fx = buildFixture({ tasks: 1000 });

  const projectConfigCore = require('../../db/project-config-core');
  if (typeof projectConfigCore.setDb === 'function') {
    projectConfigCore.setDb(fx.db);
  } else {
    throw new Error('project-config-core: no setDb injection path found');
  }

  const { handleProjectStats } = require('../../handlers/task/project');
  cached = { fx, handleProjectStats };
  return cached;
}

async function run(_ctx) {
  const { handleProjectStats, fx } = lazyLoad();
  const start = performance.now();
  const result = handleProjectStats({ project: fx.projectId });
  const elapsed = performance.now() - start;

  // Sanity: handleProjectStats returns { content: [{type:'text', text:...}] }
  // on success. A missing-project error returns makeError(code, msg) which has
  // a different shape — no content array. Guard against a broken fixture wiring.
  if (!result || !result.content) {
    throw new Error(
      `handleProjectStats returned unexpected shape: ${JSON.stringify(result)}`
    );
  }
  return { value: elapsed };
}

module.exports = {
  id: 'handler-project-stats',
  name: 'Handler: handleProjectStats (1000-task project)',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run,
};
