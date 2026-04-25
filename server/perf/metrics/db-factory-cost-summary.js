'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures buildProjectCostSummary against a 100-task batch with seeded
// factory_feedback, cost_tracking rows. This is the primary signal for
// Phase 2's N+1 query work — the current implementation calls getTaskCostData
// with all task IDs at once (a single bulk IN query), but the overall path
// iterates factory_feedback rows, resolves tasks, then looks up cost data.
//
// Data shape required by buildProjectCostSummary:
//   factory_projects  — FK parent for factory_feedback
//   factory_feedback  — one row per "cycle"; batch_id links to workflow_id on tasks
//   tasks             — workflow_id = batch_id; tasks in the batch
//   cost_tracking     — per-task cost rows (cost_usd column)
//
// factory_feedback is NOT in the base createTables schema — it only exists as a
// migration (version 18). We create it manually here.

const BATCH_ID = 'perf-batch-001';
const PROJECT_ID = 'perf-factory-project';

let cached = null;

function lazyLoad() {
  if (cached) return cached;

  const fx = buildFixture({ tasks: 100, projectId: PROJECT_ID });

  // factory_feedback is a migration-only table — create it in the fixture DB.
  fx.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      consecutive_empty_cycles INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  fx.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      batch_id TEXT,
      health_delta_json TEXT,
      execution_metrics_json TEXT,
      guardrail_activity_json TEXT,
      human_corrections_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed the factory_project row (FK parent).
  fx.db.prepare(`
    INSERT OR IGNORE INTO factory_projects (id, name, path)
    VALUES (?, ?, ?)
  `).run(PROJECT_ID, 'Perf Fixture Project', '/tmp/perf-fixture-project');

  // Seed one factory_feedback cycle pointing at our batch.
  fx.db.prepare(`
    INSERT INTO factory_feedback (project_id, batch_id, health_delta_json)
    VALUES (?, ?, ?)
  `).run(
    PROJECT_ID,
    BATCH_ID,
    JSON.stringify({ lint: { delta: 5 }, tests: { delta: 10 } })
  );

  // Update all 100 tasks to belong to the batch via workflow_id so
  // getRelevantTasks (workflow_id IN (batch_ids)) matches them.
  fx.db.prepare(
    'UPDATE tasks SET workflow_id = ? WHERE project = ?'
  ).run(BATCH_ID, PROJECT_ID);

  // Seed cost_tracking rows for every task so getTaskTrackingRows returns data.
  // Schema: task_id, provider, model, input_tokens, output_tokens, cost_usd, tracked_at
  const insertCost = fx.db.prepare(`
    INSERT INTO cost_tracking (task_id, provider, model, input_tokens, output_tokens, cost_usd, tracked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const taskRows = fx.db.prepare('SELECT id FROM tasks WHERE project = ?').all(PROJECT_ID);
  const tx = fx.db.transaction(() => {
    for (const t of taskRows) {
      insertCost.run(t.id, 'codex', 'gpt-5.3-codex', 1000, 500, 0.012, new Date().toISOString());
    }
  });
  tx();

  const factoryCostMetrics = require('../../factory/cost-metrics');
  factoryCostMetrics.init({ db: fx.db });
  cached = { fx, factoryCostMetrics };
  return cached;
}

async function run(_ctx) {
  const { factoryCostMetrics, fx } = lazyLoad();
  const start = performance.now();
  const summary = factoryCostMetrics.buildProjectCostSummary(fx.projectId);
  const elapsed = performance.now() - start;
  if (!summary) throw new Error('cost summary returned null');
  return { value: elapsed };
}

module.exports = {
  id: 'db-factory-cost-summary',
  name: 'DB: buildProjectCostSummary (100-task batch)',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run,
};