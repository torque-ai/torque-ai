> **STALE — needs rewrite (2026-05-01).** Layered on unshipped fabro-70 (eval framework) and fabro-78 (OTEL). Refresh focus: drop the layered dependency, build a minimal native evaluator on the existing benchmark + provider-scoring pipes.

# Fabro #79: Experiment SDK + Portable Scorers (Braintrust)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Layer a **minimal SDK** on top of Plan 70's matrix runner: `runExperiment(name, { data, task, scores })` produces an **immutable experiment** with per-row results and a **diff view** against any prior experiment on the same dataset. **Scorers** are reusable functions that run identically in offline experiments **and** on live production traces (Plan 78). Inspired by Braintrust.

**Architecture:** Three additions:
1. **`runExperiment()` SDK** — creates an `experiments` row, iterates data, runs `task(item)` + each scorer, persists a row per `(item, scorer)` tuple.
2. **Scorers library** — `Scorer.create({ name, fn })` returns an object with `{ name, fn, asOnlineEvaluator }`. The same object runs against experiment rows OR as an online hook against completed task traces (writing Plan 68 scores).
3. **Diff view** — REST `GET /api/experiments/:a/diff/:b` returns aligned row-by-row delta + aggregate regressions.

**Tech Stack:** Node.js, Plan 70 matrix + assertions, Plan 68 score store. Builds on plans 68, 70, 78.

---

## File Structure

**New files:**
- `server/migrations/0NN-experiments.sql`
- `server/eval/experiment-sdk.js` — `runExperiment()` function
- `server/eval/scorer.js` — reusable Scorer class + adapters
- `server/eval/experiment-diff.js` — row-aligned comparison
- `server/tests/experiment-sdk.test.js`
- `server/tests/scorer.test.js`
- `server/tests/experiment-diff.test.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — `run_experiment`, `diff_experiments`, `register_online_scorer`
- `server/execution/task-finalizer.js` — run online scorers against new traces

---

## Task 1: Experiments migration + SDK

- [ ] **Step 1: Migration**

`server/migrations/0NN-experiments.sql`:

```sql
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT,
  dataset_version INTEGER,
  task_description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_experiment_id TEXT,
  immutable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS experiment_rows (
  row_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  input_json TEXT,
  expected_json TEXT,
  output_json TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiment_scores (
  experiment_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  scorer_name TEXT NOT NULL,
  value REAL,
  metadata_json TEXT,
  PRIMARY KEY (experiment_id, row_id, scorer_name)
);

CREATE INDEX IF NOT EXISTS idx_experiment_rows_exp ON experiment_rows(experiment_id);
CREATE INDEX IF NOT EXISTS idx_experiment_scores_scorer ON experiment_scores(scorer_name);
```

- [ ] **Step 2: Tests**

Create `server/tests/experiment-sdk.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createExperimentSdk } = require('../eval/experiment-sdk');

describe('runExperiment()', () => {
  let db, sdk;
  beforeEach(() => {
    db = setupTestDb();
    sdk = createExperimentSdk({ db });
  });

  it('creates experiment + rows + scores', async () => {
    const task = vi.fn(async ({ topic }) => `Summary of ${topic}`);
    const exact = {
      name: 'exact', fn: async ({ output, expected }) => ({ value: output === expected ? 1 : 0 }),
    };
    const result = await sdk.runExperiment('summary-v1', {
      data: [
        { input: { topic: 'apples' }, expected: 'Summary of apples' },
        { input: { topic: 'oranges' }, expected: 'Summary of bananas' },
      ],
      task, scores: [exact],
    });
    expect(result.experiment_id).toMatch(/^exp_/);
    const rows = db.prepare('SELECT * FROM experiment_rows WHERE experiment_id = ?').all(result.experiment_id);
    expect(rows).toHaveLength(2);
    const scores = db.prepare('SELECT * FROM experiment_scores WHERE experiment_id = ?').all(result.experiment_id);
    const values = scores.map(s => s.value).sort();
    expect(values).toEqual([0, 1]);
  });

  it('aggregates means per scorer in the summary', async () => {
    const task = async ({ n }) => n * 2;
    const scorer = { name: 'doubled', fn: async ({ input, output }) => ({ value: output === input.n * 2 ? 1 : 0 }) };
    const r = await sdk.runExperiment('double', {
      data: [{ input: { n: 1 } }, { input: { n: 2 } }, { input: { n: 3 } }],
      task, scores: [scorer],
    });
    expect(r.summary.doubled.mean).toBe(1);
    expect(r.summary.doubled.count).toBe(3);
  });

  it('captures errors on task failure', async () => {
    const task = async ({ n }) => { if (n < 0) throw new Error('negative'); return n; };
    const scorer = { name: 's', fn: async ({ output }) => ({ value: output > 0 ? 1 : 0 }) };
    const r = await sdk.runExperiment('e', {
      data: [{ input: { n: 1 } }, { input: { n: -1 } }],
      task, scores: [scorer],
    });
    const errorRow = db.prepare(`SELECT error FROM experiment_rows WHERE experiment_id = ? AND error IS NOT NULL`).get(r.experiment_id);
    expect(errorRow.error).toMatch(/negative/);
  });

  it('links to parent_experiment_id when provided', async () => {
    const base = await sdk.runExperiment('base', { data: [{ input: {} }], task: async () => 1, scores: [] });
    const followUp = await sdk.runExperiment('followup', {
      data: [{ input: {} }], task: async () => 2, scores: [],
      parentExperimentId: base.experiment_id,
    });
    const row = db.prepare('SELECT parent_experiment_id FROM experiments WHERE experiment_id = ?').get(followUp.experiment_id);
    expect(row.parent_experiment_id).toBe(base.experiment_id);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/eval/experiment-sdk.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createExperimentSdk({ db, logger = console }) {
  async function runExperiment(name, { data, task, scores = [], datasetId = null, datasetVersion = null, parentExperimentId = null }) {
    const experimentId = `exp_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO experiments (experiment_id, name, dataset_id, dataset_version, parent_experiment_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(experimentId, name, datasetId, datasetVersion, parentExperimentId);

    const scoreTotals = new Map(scores.map(s => [s.name, { sum: 0, count: 0 }]));

    for (const item of data) {
      const rowId = `row_${randomUUID().slice(0, 12)}`;
      const itemKey = item.key || JSON.stringify(item.input);
      const start = Date.now();
      let output, errorMsg = null;
      try { output = await task(item.input, { item }); }
      catch (err) { errorMsg = err.message; }
      const duration = Date.now() - start;

      db.prepare(`
        INSERT INTO experiment_rows (row_id, experiment_id, item_key, input_json, expected_json, output_json, duration_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rowId, experimentId, itemKey, JSON.stringify(item.input),
             item.expected != null ? JSON.stringify(item.expected) : null,
             output != null ? JSON.stringify(output) : null, duration, errorMsg);

      if (errorMsg) continue;
      for (const scorer of scores) {
        try {
          const r = await scorer.fn({ input: item.input, expected: item.expected, output, metadata: item.metadata });
          db.prepare(`INSERT INTO experiment_scores (experiment_id, row_id, scorer_name, value, metadata_json) VALUES (?,?,?,?,?)`)
            .run(experimentId, rowId, scorer.name, r.value, r.metadata ? JSON.stringify(r.metadata) : null);
          const totals = scoreTotals.get(scorer.name);
          totals.sum += r.value; totals.count++;
        } catch (err) {
          logger.warn?.('scorer failed', { scorer: scorer.name, err: err.message });
        }
      }
    }

    const summary = {};
    for (const [name, { sum, count }] of scoreTotals) {
      summary[name] = { mean: count > 0 ? sum / count : null, count };
    }
    return { experiment_id: experimentId, name, summary, item_count: data.length };
  }

  return { runExperiment };
}

module.exports = { createExperimentSdk };
```

Run tests → PASS. Commit: `feat(experiment): runExperiment() SDK creates immutable experiments with per-row scores`.

---

## Task 2: Scorer class with online adapter

- [ ] **Step 1: Tests**

Create `server/tests/scorer.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { Scorer } = require('../eval/scorer');

describe('Scorer', () => {
  it('create + invoke returns value', async () => {
    const s = Scorer.create({ name: 'len_gte_10', fn: async ({ output }) => ({ value: String(output).length >= 10 ? 1 : 0 }) });
    const r = await s.fn({ output: 'hello world' });
    expect(r.value).toBe(1);
  });

  it('asOnlineEvaluator wraps a trace into the scorer input shape', async () => {
    const s = Scorer.create({ name: 'len_gte_10', fn: async ({ output }) => ({ value: String(output).length >= 10 ? 1 : 0 }) });
    const online = s.asOnlineEvaluator();
    const r = await online({
      trace: { input: { prompt: 'hi' }, output: 'a very long output string' },
    });
    expect(r.value).toBe(1);
  });

  it('asOnlineEvaluator passes metadata from trace', async () => {
    const spy = vi.fn(async () => ({ value: 0 }));
    const s = Scorer.create({ name: 'x', fn: spy });
    const online = s.asOnlineEvaluator();
    await online({ trace: { input: 'i', output: 'o', metadata: { task_id: 't1' } } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ metadata: { task_id: 't1' } }));
  });
});
```

- [ ] **Step 2: Implement**

Create `server/eval/scorer.js`:

```js
'use strict';

class Scorer {
  constructor({ name, fn }) {
    if (!name || typeof fn !== 'function') throw new Error('Scorer requires name + fn');
    this.name = name;
    this.fn = fn;
  }

  // Same scorer runs against a live production trace by reshaping its data.
  asOnlineEvaluator() {
    return async ({ trace }) => this.fn({
      input: trace.input,
      expected: trace.expected,
      output: trace.output,
      metadata: trace.metadata,
    });
  }

  static create(opts) { return new Scorer(opts); }
}

module.exports = { Scorer };
```

Run tests → PASS. Commit: `feat(experiment): Scorer class + asOnlineEvaluator adapter`.

---

## Task 3: Experiment diff + MCP + online hook

- [ ] **Step 1: Diff tests + impl**

Create `server/tests/experiment-diff.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { diffExperiments } = require('../eval/experiment-diff');

describe('diffExperiments', () => {
  let db;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO experiments (experiment_id, name) VALUES ('a', 'v1'),('b','v2')`).run();
    db.prepare(`INSERT INTO experiment_rows (row_id, experiment_id, item_key, output_json) VALUES
      ('r1','a','k1','"old1"'),('r2','a','k2','"old2"'),('r3','b','k1','"new1"'),('r4','b','k2','"new2"')`).run();
    db.prepare(`INSERT INTO experiment_scores (experiment_id, row_id, scorer_name, value) VALUES
      ('a','r1','acc',0.5),('a','r2','acc',0.9),('b','r3','acc',0.9),('b','r4','acc',0.2)`).run();
  });

  it('aligns rows by item_key and reports score deltas', () => {
    const d = diffExperiments(db, 'a', 'b');
    expect(d.row_diffs).toHaveLength(2);
    const byKey = Object.fromEntries(d.row_diffs.map(r => [r.item_key, r]));
    expect(byKey.k1.scores.acc.delta).toBeCloseTo(0.4);
    expect(byKey.k2.scores.acc.delta).toBeCloseTo(-0.7);
  });

  it('classifies regressions and improvements', () => {
    const d = diffExperiments(db, 'a', 'b');
    expect(d.summary.acc.improved).toBe(1);
    expect(d.summary.acc.regressed).toBe(1);
  });

  it('reports items missing from either side', () => {
    db.prepare(`INSERT INTO experiment_rows (row_id, experiment_id, item_key, output_json) VALUES ('rX','b','k3','"new3"')`).run();
    const d = diffExperiments(db, 'a', 'b');
    expect(d.only_in_b.map(r => r.item_key)).toContain('k3');
  });
});
```

Create `server/eval/experiment-diff.js`:

```js
'use strict';

function diffExperiments(db, aId, bId) {
  const rowsA = db.prepare(`SELECT * FROM experiment_rows WHERE experiment_id = ?`).all(aId);
  const rowsB = db.prepare(`SELECT * FROM experiment_rows WHERE experiment_id = ?`).all(bId);
  const scoresA = db.prepare(`SELECT * FROM experiment_scores WHERE experiment_id = ?`).all(aId);
  const scoresB = db.prepare(`SELECT * FROM experiment_scores WHERE experiment_id = ?`).all(bId);

  const scoreByRow = (scores) => {
    const m = new Map();
    for (const s of scores) {
      if (!m.has(s.row_id)) m.set(s.row_id, {});
      m.get(s.row_id)[s.scorer_name] = s.value;
    }
    return m;
  };
  const sA = scoreByRow(scoresA);
  const sB = scoreByRow(scoresB);

  const mapA = new Map(rowsA.map(r => [r.item_key, r]));
  const mapB = new Map(rowsB.map(r => [r.item_key, r]));

  const row_diffs = [];
  const summary = {};
  for (const [key, a] of mapA) {
    const b = mapB.get(key);
    if (!b) continue;
    const aScores = sA.get(a.row_id) || {};
    const bScores = sB.get(b.row_id) || {};
    const scoreDelta = {};
    for (const name of new Set([...Object.keys(aScores), ...Object.keys(bScores)])) {
      const delta = (bScores[name] ?? 0) - (aScores[name] ?? 0);
      scoreDelta[name] = { a: aScores[name], b: bScores[name], delta };
      if (!summary[name]) summary[name] = { improved: 0, regressed: 0, unchanged: 0 };
      if (delta > 0.01) summary[name].improved++;
      else if (delta < -0.01) summary[name].regressed++;
      else summary[name].unchanged++;
    }
    row_diffs.push({ item_key: key, output_a: a.output_json, output_b: b.output_json, scores: scoreDelta });
  }

  const only_in_a = Array.from(mapA.values()).filter(r => !mapB.has(r.item_key));
  const only_in_b = Array.from(mapB.values()).filter(r => !mapA.has(r.item_key));

  return { experiment_a: aId, experiment_b: bId, row_diffs, only_in_a, only_in_b, summary };
}

module.exports = { diffExperiments };
```

Run tests → PASS. Commit: `feat(experiment): diff with regression/improvement classification`.

---

## Task 4: MCP tools + online hook

- [ ] **Step 1: MCP tools**

```js
run_experiment: {
  description: 'Run an experiment against a dataset. Returns experiment_id + summary.',
  inputSchema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string' },
    dataset_id: { type: 'string' },
    dataset_version: { type: 'integer' },
    inline_data: { type: 'array' },
    task_config: { type: 'object' },
    scorer_names: { type: 'array', items: { type: 'string' } },
    parent_experiment_id: { type: 'string' },
  }},
},
diff_experiments: {
  description: 'Compare two experiments aligned by dataset item. Returns row-by-row deltas + per-scorer summary.',
  inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } },
},
register_online_scorer: {
  description: 'Register a scorer to run against every completed task trace. Writes to Plan 68 scores table.',
  inputSchema: { type: 'object', required: ['scorer_name', 'subject_filter'], properties: { scorer_name: { type: 'string' }, subject_filter: { type: 'object' } } },
},
```

- [ ] **Step 2: Online hook in finalizer**

```js
const registered = defaultContainer.get('onlineScorerRegistry').list();
for (const { scorer, subjectFilter } of registered) {
  if (!matchesFilter(task, subjectFilter)) continue;
  const online = scorer.asOnlineEvaluator();
  (async () => {
    try {
      const r = await online({ trace: { input: task.task_description, output: finalOutput, metadata: { task_id: taskId } } });
      defaultContainer.get('scoreStore').record({
        subjectType: 'task', subjectId: taskId, name: scorer.name, value: r.value, source: 'online_scorer',
        metadata: r.metadata,
      });
    } catch (err) { logger.warn('online scorer failed', { taskId, scorer: scorer.name, err: err.message }); }
  })();
}
```

`await_restart`. Smoke: define a scorer `len_gte_10`, register as online, submit several tasks — confirm scores appear in Plan 68 store. Then `run_experiment` with the same scorer against a dataset — confirm experiment_id returned. `diff_experiments(a,b)` shows regressions between runs.

Commit: `feat(experiment): MCP surface + online scorer hook + diff endpoint`.
