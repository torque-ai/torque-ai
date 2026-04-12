# Fabro #24: Workflow Benchmarking Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the same goal against multiple workflow variants (different specs, different routing templates, different model stylesheets) and produce a comparison report. Lets users quantify "is workflow A better than workflow B?" before promoting a variant to default. Inspired by gpt-engineer's `bench` CLI and DSPy's optimizer loop.

**Architecture:** A new `bench_workflow_specs` MCP tool takes `{ goal, specs: [path1, path2, ...], runs_per_variant }`. For each spec × run combo, TORQUE creates a fresh workflow (using Plan 1's `run_workflow_spec`), waits for it to finish, then collects metrics from the bundle (Plan 15) + retro (Plan 2). After all runs complete, a comparison report scores each variant across cost, duration, success rate, verify pass rate, and (optionally) a custom metric defined in a `metric_command` shell script.

---

## File Structure

**New files:**
- `server/bench/runner.js` — orchestrator: spawn variants, collect metrics
- `server/bench/score.js` — compute composite scores
- `server/bench/render-report.js` — Markdown comparison report
- `server/handlers/bench-handlers.js`
- `server/tool-defs/bench-defs.js`
- `server/tests/bench-score.test.js`
- `server/tests/bench-runner.test.js`

**Modified files:**
- `server/db/schema-tables.js` — `bench_runs` table
- `server/database.js`
- `server/tools.js`, `server/tool-defs/index.js`, `server/api/routes-passthrough.js`
- `docs/benchmarking.md`

---

## Task 1: Schema + score module

- [ ] **Step 1: Schema**

In `server/db/schema-tables.js`:

```sql
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY,
  bench_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  workflow_id TEXT,
  goal TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT,
  metrics_json TEXT,
  composite_score REAL
);
CREATE INDEX IF NOT EXISTS idx_bench_runs_bench ON bench_runs(bench_id);
```

Add `'bench_runs'` to `ALL_TABLES`.

- [ ] **Step 2: Score module + tests**

Create `server/tests/bench-score.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { computeCompositeScore, summarize } = require('../bench/score');

describe('computeCompositeScore', () => {
  it('higher is better; weights success, verify pass, low cost, low duration', () => {
    const good = computeCompositeScore({ status: 'completed', verify_pass_rate: 1.0, cost_usd: 0.1, duration_seconds: 60 });
    const bad = computeCompositeScore({ status: 'failed', verify_pass_rate: 0.2, cost_usd: 5.0, duration_seconds: 600 });
    expect(good).toBeGreaterThan(bad);
  });
  it('failed runs score 0', () => {
    expect(computeCompositeScore({ status: 'failed', verify_pass_rate: 1.0, cost_usd: 0, duration_seconds: 1 })).toBe(0);
  });
  it('cancelled runs score 0', () => {
    expect(computeCompositeScore({ status: 'cancelled' })).toBe(0);
  });
});

describe('summarize', () => {
  it('aggregates per-variant statistics', () => {
    const runs = [
      { spec_path: 'A.yaml', composite_score: 80, metrics: { cost_usd: 0.5, duration_seconds: 100 } },
      { spec_path: 'A.yaml', composite_score: 85, metrics: { cost_usd: 0.6, duration_seconds: 120 } },
      { spec_path: 'B.yaml', composite_score: 50, metrics: { cost_usd: 0.2, duration_seconds: 60 } },
    ];
    const summary = summarize(runs);
    const a = summary.find(s => s.spec_path === 'A.yaml');
    const b = summary.find(s => s.spec_path === 'B.yaml');
    expect(a.runs).toBe(2);
    expect(a.avg_score).toBeCloseTo(82.5);
    expect(b.runs).toBe(1);
    expect(a.avg_score).toBeGreaterThan(b.avg_score);
  });
});
```

Create `server/bench/score.js`:

```js
'use strict';

/**
 * Composite score (0-100). Higher is better.
 * - Success: required (failed/cancelled = 0)
 * - Verify pass rate: 60% weight (most important quality signal)
 * - Cost factor: 25% weight (cheaper is better, normalized to a $0-$5 band)
 * - Duration factor: 15% weight (faster is better, normalized to 0-600s band)
 */
function computeCompositeScore(metrics) {
  if (!metrics || metrics.status !== 'completed') return 0;
  const verify = Math.max(0, Math.min(1, metrics.verify_pass_rate ?? 0.5));
  const costFactor = Math.max(0, Math.min(1, 1 - (metrics.cost_usd ?? 0) / 5));
  const durFactor = Math.max(0, Math.min(1, 1 - (metrics.duration_seconds ?? 0) / 600));
  return Math.round((verify * 0.60 + costFactor * 0.25 + durFactor * 0.15) * 100);
}

function summarize(runs) {
  const byVariant = new Map();
  for (const r of runs) {
    if (!byVariant.has(r.spec_path)) byVariant.set(r.spec_path, []);
    byVariant.get(r.spec_path).push(r);
  }
  return [...byVariant.entries()].map(([spec_path, list]) => {
    const scores = list.map(x => x.composite_score || 0);
    const costs = list.map(x => x.metrics?.cost_usd || 0);
    const durs = list.map(x => x.metrics?.duration_seconds || 0);
    return {
      spec_path,
      runs: list.length,
      avg_score: scores.reduce((s, x) => s + x, 0) / list.length,
      max_score: Math.max(...scores),
      min_score: Math.min(...scores),
      avg_cost_usd: costs.reduce((s, x) => s + x, 0) / list.length,
      avg_duration_seconds: durs.reduce((s, x) => s + x, 0) / list.length,
    };
  }).sort((a, b) => b.avg_score - a.avg_score);
}

module.exports = { computeCompositeScore, summarize };
```

Run tests → PASS. Commit: `feat(bench): composite scoring + summarization`.

---

## Task 2: Runner orchestrator

- [ ] **Step 1: Tests + implementation**

Create `server/bench/runner.js`:

```js
'use strict';

const { randomUUID } = require('crypto');
const db = require('../database');
const { computeCompositeScore } = require('./score');
const logger = require('../logger').child({ component: 'bench' });

async function runBench({ goal, specs, runs_per_variant = 1, working_directory }) {
  const benchId = randomUUID();
  const allRuns = [];

  // Sequential by default — parallel would race for codex slots and skew cost/duration metrics
  for (const specPath of specs) {
    for (let i = 0; i < runs_per_variant; i++) {
      const runId = randomUUID();
      logger.info(`[bench] ${benchId} run ${runId} for ${specPath} (attempt ${i + 1}/${runs_per_variant})`);

      // Insert pending row
      db.prepare(`INSERT INTO bench_runs (id, bench_id, spec_path, goal, started_at, status)
                  VALUES (?, ?, ?, ?, ?, 'pending')`).run(
        runId, benchId, specPath, goal, new Date().toISOString()
      );

      let workflowId = null;
      let metrics = {};
      try {
        const { handleRunWorkflowSpec } = require('../handlers/workflow-spec-handlers');
        const result = handleRunWorkflowSpec({
          spec_path: specPath,
          working_directory,
          goal,
        });
        if (result.isError) throw new Error(result.content?.[0]?.text);
        workflowId = result.structuredData?.workflow_id;

        // Wait for the workflow to complete (block — bench is inherently sequential)
        const { awaitWorkflow } = require('../execution/workflow-runtime');
        await awaitWorkflow(workflowId, { timeout_minutes: 30 });

        // Collect metrics
        const wf = db.getWorkflow(workflowId);
        const tasks = db.getWorkflowTasks(workflowId);
        const verifyTags = tasks.flatMap(t => {
          try { return typeof t.tags === 'string' ? JSON.parse(t.tags) : (t.tags || []); } catch { return []; }
        }).filter(t => t.startsWith('tests:'));
        const passCount = verifyTags.filter(t => t === 'tests:pass').length;
        const totalVerified = verifyTags.length;
        const totalCost = tasks.reduce((s, t) => s + (Number(t.cost_usd) || 0), 0);
        const startMs = new Date(wf.started_at || wf.created_at).getTime();
        const endMs = new Date(wf.completed_at || new Date()).getTime();

        metrics = {
          status: wf.status,
          task_count: tasks.length,
          completed_count: tasks.filter(t => t.status === 'completed').length,
          failed_count: tasks.filter(t => t.status === 'failed').length,
          verify_pass_rate: totalVerified > 0 ? passCount / totalVerified : null,
          cost_usd: Number(totalCost.toFixed(6)),
          duration_seconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
        };
      } catch (err) {
        logger.info(`[bench] run ${runId} failed: ${err.message}`);
        metrics = { status: 'failed', error: err.message };
      }

      const composite = computeCompositeScore(metrics);
      db.prepare(`UPDATE bench_runs SET workflow_id = ?, completed_at = ?, status = ?, metrics_json = ?, composite_score = ?
                  WHERE id = ?`).run(
        workflowId, new Date().toISOString(), metrics.status || 'unknown',
        JSON.stringify(metrics), composite, runId
      );
      allRuns.push({ id: runId, spec_path: specPath, workflow_id: workflowId, metrics, composite_score: composite });
    }
  }

  return { bench_id: benchId, runs: allRuns };
}

module.exports = { runBench };
```

Commit: `feat(bench): orchestrator runs each spec N times and collects metrics`.

---

## Task 3: Report renderer + MCP tool

- [ ] **Step 1: Renderer**

Create `server/bench/render-report.js`:

```js
'use strict';

const { summarize } = require('./score');

function renderReport({ bench_id, runs }) {
  const summary = summarize(runs);
  const lines = [`# Bench ${bench_id.slice(0, 8)}`, '', `Total runs: ${runs.length}`, '', '## Summary by variant', '', '| Spec | Runs | Avg Score | Max | Min | Avg Cost (USD) | Avg Duration (s) |', '|---|---|---|---|---|---|---|'];
  for (const s of summary) {
    lines.push(`| \`${s.spec_path}\` | ${s.runs} | **${s.avg_score.toFixed(1)}** | ${s.max_score} | ${s.min_score} | $${s.avg_cost_usd.toFixed(4)} | ${s.avg_duration_seconds.toFixed(0)} |`);
  }
  lines.push('', '## Verdict', '');
  if (summary.length > 0) {
    const winner = summary[0];
    lines.push(`Winner: \`${winner.spec_path}\` with average score ${winner.avg_score.toFixed(1)}.`);
  }
  return lines.join('\n');
}

module.exports = { renderReport };
```

- [ ] **Step 2: MCP tool**

Create `server/tool-defs/bench-defs.js`:

```js
'use strict';
const BENCH_TOOLS = [
  {
    name: 'bench_workflow_specs',
    description: 'Run multiple workflow specs against the same goal and produce a comparison report.',
    inputSchema: {
      type: 'object',
      required: ['goal', 'specs'],
      properties: {
        goal: { type: 'string' },
        specs: { type: 'array', items: { type: 'string' }, minItems: 2 },
        runs_per_variant: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
        working_directory: { type: 'string' },
      },
    },
  },
];
module.exports = { BENCH_TOOLS };
```

Create `server/handlers/bench-handlers.js`:

```js
'use strict';
const { runBench } = require('../bench/runner');
const { renderReport } = require('../bench/render-report');

async function handleBenchWorkflowSpecs(args) {
  const result = await runBench(args);
  const report = renderReport(result);
  return {
    content: [{ type: 'text', text: report }],
    structuredData: { ...result, report },
  };
}

module.exports = { handleBenchWorkflowSpecs };
```

Wire dispatch + REST.

- [ ] **Step 3: Docs + restart + smoke**

Create `docs/benchmarking.md`:

````markdown
# Workflow Benchmarking

Run the same goal against multiple workflow variants and produce a comparison report.

```
bench_workflow_specs {
  goal: "Add a /health endpoint",
  specs: ["workflows/v1.yaml", "workflows/v2.yaml", "workflows/v3.yaml"],
  runs_per_variant: 3
}
```

For each spec × run combo, TORQUE:
1. Creates a fresh workflow from the spec
2. Waits for completion
3. Collects metrics (status, task counts, verify pass rate, cost, duration)
4. Computes a composite score (0-100)

After all runs finish, a Markdown report ranks variants by average score.

## Composite score weights

- Verify pass rate: 60%
- Cost (normalized 0-$5): 25%
- Duration (normalized 0-600s): 15%
- Status=failed/cancelled: score = 0

## When to use

- Before promoting a workflow variant to default
- When tuning routing templates or model stylesheets
- For provider comparisons (run the same workflow with different stylesheets)

## Caveats

- Bench runs SEQUENTIALLY. Parallel runs would race for slots and skew cost/duration metrics.
- Each variant should produce comparable artifacts. Wildly different DAGs aren't comparable on cost alone.
````

`await_restart`. Smoke: create two trivial workflow specs and benchmark them. Expect a Markdown table ranking them by score.

Commit: `docs(bench): workflow benchmarking guide`.
