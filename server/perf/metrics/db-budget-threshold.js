'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures budgetWatcher.checkBudgetThresholds(provider) wall time. The
// internal path lists enabled cost_budgets rows for the provider, then for
// each budget calls buildBudgetStatus which runs getCurrentSpend — a windowed
// SUM over cost_tracking. The prior perf scan (2026-04-05) flagged this as a
// Phase 2 target because budget-watcher.js queries estimated_cost which is not
// indexed (the schema's indexed column is tracked_at; cost_usd is the stored
// column). This metric captures the baseline; it will move when Phase 2 fixes
// the column predicate or adds the missing index.
//
// Schema notes (schema-tables.js vs budget-watcher.js):
//   cost_budgets  — base schema uses budget_usd; watcher reads budget_amount.
//                   We add budget_amount via safeAddCol so SELECT * returns it.
//   cost_tracking — base schema uses cost_usd; watcher queries estimated_cost.
//                   We add estimated_cost via safeAddCol and seed it so the
//                   SUM has real data to scan.

const NOOP_EVENT_BUS = Object.freeze({ emit: () => {} });

let cached = null;

function safeAddCol(db, table, colDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch (_e) {
    // column already exists — ignore
  }
}

function lazyLoad() {
  if (cached) return cached;

  const fx = buildFixture({ tasks: 100 });

  // cost_budgets.budget_amount — budget-watcher reads budget.budget_amount from
  // SELECT * but the base schema column is budget_usd. Add the alias column.
  safeAddCol(fx.db, 'cost_budgets', 'budget_amount REAL DEFAULT 0');

  // cost_tracking.estimated_cost — budget-watcher queries SUM(estimated_cost)
  // but the base schema column is cost_usd. Add the alias column.
  safeAddCol(fx.db, 'cost_tracking', 'estimated_cost REAL DEFAULT 0');

  // Seed cost_tracking rows with estimated_cost values so the windowed SUM
  // has data to scan. Use tracked_at timestamps spread across the current
  // month so the monthly period window returns them.
  const insertCost = fx.db.prepare(`
    INSERT INTO cost_tracking
      (task_id, provider, model, input_tokens, output_tokens, cost_usd, estimated_cost, tracked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const taskRows = fx.db.prepare('SELECT id FROM tasks').all();
  const seedTx = fx.db.transaction(() => {
    let i = 0;
    for (const t of taskRows) {
      const ts = new Date(now - i * 60_000).toISOString();
      insertCost.run(t.id, 'codex', 'gpt-5.3-codex', 1000, 500, 0.05, 0.05, ts);
      i++;
    }
  });
  seedTx();

  // Seed a cost_budgets row for provider=codex. The watcher queries:
  //   SELECT * FROM cost_budgets WHERE enabled = 1 AND (provider = ? OR provider IS NULL)
  // Required columns: id, name, provider, budget_usd, period, enabled, created_at,
  //                   budget_amount (added above -- must be non-zero so spendPercent > 0).
  fx.db.prepare(`
    INSERT INTO cost_budgets
      (id, name, provider, budget_usd, budget_amount, period, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'perf-budget-codex',
    'Perf Codex Budget',
    'codex',
    100.0,
    100.0,
    'monthly',
    1,
    new Date().toISOString()
  );

  const { createBudgetWatcher } = require('../../db/budget-watcher');
  const watcher = createBudgetWatcher({ db: fx.db, eventBus: NOOP_EVENT_BUS });
  cached = { fx, watcher };
  return cached;
}

async function run(_ctx) {
  const { watcher } = lazyLoad();
  const start = performance.now();
  watcher.checkBudgetThresholds('codex');
  return { value: performance.now() - start };
}

module.exports = {
  id: 'db-budget-threshold',
  name: 'DB: budget threshold check (windowed spend)',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run,
};
