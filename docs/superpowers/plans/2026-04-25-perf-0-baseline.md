# Phase 0 — Performance Baseline + Regression Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a perf measurement harness with 13 tracked metrics, a regression gate that blocks pushes to `main` when metrics regress >10%, a baseline-update protocol enforced by commit-message trailer, and the supporting docs/scripts. This is Phase 0 of the performance hunt arc; every subsequent phase reports into this gate.

**Architecture:** A standalone `npm run perf` command in `server/` runs N metric modules sequentially against an in-process test database with seeded fixtures. Each metric warms up, runs N times, takes the trimmed median, and writes results to `last-run.json`. The reporter compares against committed `baseline.json` and exits non-zero if any tracked entry regressed >10%. The pre-push hook adds a perf step on pushes to `main`, routed through `torque-remote` for canonical timings. Baseline updates require a `perf-baseline:` commit trailer, validated by a small Node script.

**Tech Stack:** Node.js (commonjs), better-sqlite3 (in-memory), vitest (existing test runner), bash (pre-push hook), no new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` §2 is the design contract for this plan.

**Worktree:** `feat-perf-0-baseline` at `.worktrees/feat-perf-0-baseline/` on branch `feat/perf-0-baseline`. All commits go to that branch. Tests run via `torque-remote` from the worktree directory.

**Important rules during implementation:**

- **Never run tests locally.** Always: `torque-remote npx vitest run path/to/test.js` from the worktree dir.
- **Never restart TORQUE.** TORQUE is shared infrastructure. The perf harness must work without restarting TORQUE.
- **Never edit main directly.** All work in this worktree.
- **Commit per task** unless a task explicitly says otherwise.
- **Use Read before Edit** — never guess at indentation or surrounding context.

---

## Task 1: Bootstrap perf harness skeleton with smoke test

**Files:**
- Create: `server/perf/run-perf.js`
- Create: `server/perf/metrics/index.js`
- Create: `server/perf/report.js`
- Modify: `server/package.json`
- Test: `server/tests/perf-runner.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing test for the runner skeleton**

Create `server/tests/perf-runner.test.js`:

```js
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('node:child_process');

const PERF_RUNNER = path.resolve(__dirname, '..', 'perf', 'run-perf.js');

describe('perf runner skeleton', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-runner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exits 0 with --metrics-list', () => {
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER, '--metrics-list'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No metrics registered yet');
  });

  it('writes last-run.json under PERF_OUT_DIR after a smoke run', () => {
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome, PERF_SMOKE: '1' },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    const lastRun = path.join(tmpHome, 'last-run.json');
    expect(fs.existsSync(lastRun)).toBe(true);
    const data = JSON.parse(fs.readFileSync(lastRun, 'utf8'));
    expect(data).toHaveProperty('metrics');
    expect(data).toHaveProperty('captured_at');
    expect(data).toHaveProperty('env');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `torque-remote npx vitest run tests/perf-runner.test.js`

Expected: FAIL with "Cannot find module '.../perf/run-perf.js'" (because the file does not exist yet).

- [ ] **Step 3: Implement the runner skeleton — registry**

Create `server/perf/metrics/index.js`:

```js
'use strict';

// Metric modules will register themselves here as they are added.
// Each metric module exports: { id, name, category, runs, warmup, units, run() }
const metrics = [];

function register(metric) {
  if (!metric || typeof metric.id !== 'string') {
    throw new Error('register(): metric.id required');
  }
  if (typeof metric.run !== 'function') {
    throw new Error('register(): metric.run() required');
  }
  if (metrics.some((m) => m.id === metric.id)) {
    throw new Error(`register(): duplicate metric id ${metric.id}`);
  }
  metrics.push(metric);
}

function list() {
  return metrics.slice();
}

module.exports = { register, list };
```

- [ ] **Step 4: Implement the runner skeleton — reporter helper**

Create `server/perf/report.js`:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function captureEnv() {
  return {
    cpu_count: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    node_version: process.version,
    platform: process.platform,
    host_label: process.env.PERF_HOST_LABEL || os.hostname()
  };
}

function writeLastRun(outDir, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'last-run.json');
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  return target;
}

function readBaseline(outDir) {
  const target = path.join(outDir, 'baseline.json');
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

module.exports = { captureEnv, writeLastRun, readBaseline };
```

- [ ] **Step 5: Implement the runner skeleton — entry**

Create `server/perf/run-perf.js`:

```js
#!/usr/bin/env node
'use strict';

const path = require('path');
const registry = require('./metrics');
const report = require('./report');

const args = process.argv.slice(2);
const outDir = process.env.PERF_OUT_DIR || path.join(__dirname);

function run() {
  if (args.includes('--metrics-list')) {
    const all = registry.list();
    if (all.length === 0) {
      console.log('No metrics registered yet.');
      return 0;
    }
    for (const m of all) {
      console.log(`${m.id}\t${m.category}\t${m.name}`);
    }
    return 0;
  }

  if (process.env.PERF_SMOKE === '1') {
    const payload = {
      captured_at: new Date().toISOString(),
      env: report.captureEnv(),
      metrics: {}
    };
    const target = report.writeLastRun(outDir, payload);
    console.log(`smoke run wrote ${target}`);
    return 0;
  }

  console.log('No metrics registered. Add metric modules under server/perf/metrics/ and require them from run-perf.js.');
  return 0;
}

process.exitCode = run();
```

- [ ] **Step 6: Add `npm run perf` script**

Read `server/package.json`, find the `"scripts"` block, and add a `"perf"` entry just after the existing `"test"` entry. Result:

```json
"scripts": {
  "start": "node index.js",
  "test": "vitest run --config vitest.config.js",
  "perf": "node perf/run-perf.js",
  ...
```

- [ ] **Step 7: Update `.gitignore`**

Append to the project-root `.gitignore`:

```
# Perf harness — last run is local-only; baseline.json IS committed
server/perf/last-run.json
server/perf/bypass-audit.log
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `torque-remote npx vitest run tests/perf-runner.test.js`

Expected: PASS — both `--metrics-list` and `PERF_SMOKE=1` runs succeed.

- [ ] **Step 9: Commit**

```bash
cd .worktrees/feat-perf-0-baseline
git add server/perf/run-perf.js server/perf/metrics/index.js server/perf/report.js server/package.json server/tests/perf-runner.test.js .gitignore
git commit -m "perf(harness): bootstrap runner skeleton with smoke mode"
```

---

## Task 2: Define metric module contract + registration aggregator

**Files:**
- Create: `server/perf/metrics/_template.md`
- Modify: `server/perf/run-perf.js`
- Create: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-contract.test.js`

- [ ] **Step 1: Write the failing test for metric contract**

Create `server/tests/perf-metric-contract.test.js`:

```js
describe('perf metric registry contract', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../perf/metrics')];
  });

  it('rejects metric without id', () => {
    const r = require('../perf/metrics');
    expect(() => r.register({ run: () => 0 })).toThrow(/metric\.id required/);
  });

  it('rejects metric without run()', () => {
    const r = require('../perf/metrics');
    expect(() => r.register({ id: 'foo' })).toThrow(/metric\.run/);
  });

  it('rejects duplicate id', () => {
    const r = require('../perf/metrics');
    r.register({ id: 'foo', run: () => 0 });
    expect(() => r.register({ id: 'foo', run: () => 0 })).toThrow(/duplicate metric id/);
  });

  it('list() returns registered metrics in insertion order', () => {
    const r = require('../perf/metrics');
    r.register({ id: 'a', name: 'A', category: 'cat', run: () => 0 });
    r.register({ id: 'b', name: 'B', category: 'cat', run: () => 0 });
    expect(r.list().map((m) => m.id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-contract.test.js`

Expected: PASS (Task 1's registry already enforces these checks).

- [ ] **Step 3: Document the contract**

Create `server/perf/metrics/_template.md`:

````markdown
# Metric module contract

Each metric module under `server/perf/metrics/` MUST export:

```js
module.exports = {
  id: 'unique-slug',
  name: 'Human readable name',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 10,
  runs: 100,
  variants: ['raw', 'parsed'],
  run: async (ctx) => ({ value: 42, p95: null })
};
```

Variants render as separate baseline entries with id `${id}.${variant}`.

`ctx` provides:
- `ctx.fixture` — shared fixture builder result
- `ctx.iter` — current iteration index (0-based)
- `ctx.variant` — current variant name when `variants` is set
````

- [ ] **Step 4: Wire metric registration into run-perf.js**

Modify `server/perf/run-perf.js`. Near the top, after the `require('./metrics')` line, add:

```js
require('./metrics/all'); // registers all metric modules
```

Create `server/perf/metrics/all.js`:

```js
'use strict';

// Each line registers one metric. Add new metrics here.
// (Empty for now — metrics are added in subsequent tasks.)
```

- [ ] **Step 5: Run the runner with --metrics-list**

From the worktree root, run: `cd server && node perf/run-perf.js --metrics-list`

Expected: `No metrics registered yet.`

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/_template.md server/perf/metrics/all.js server/perf/run-perf.js server/tests/perf-metric-contract.test.js
git commit -m "perf(harness): document metric contract and registration aggregator"
```

---

## Task 3: Add the runs-and-median driver

**Files:**
- Create: `server/perf/driver.js`
- Test: `server/tests/perf-driver.test.js`
- Modify: `server/perf/run-perf.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-driver.test.js`:

```js
const { runMetric } = require('../perf/driver');

describe('perf driver', () => {
  it('runs warmup then measurement, returns trimmed median', async () => {
    let invocations = 0;
    const metric = {
      id: 'fake', name: 'Fake', category: 'hot-path-runtime', units: 'ms',
      warmup: 3, runs: 7,
      run: async () => {
        invocations++;
        const measureIdx = invocations - 3;
        if (measureIdx < 1) return { value: 999 };
        return { value: measureIdx };
      }
    };
    const result = await runMetric(metric);
    expect(result.median).toBe(4);
    expect(result.runs).toBe(7);
    expect(result.warmup).toBe(3);
    expect(invocations).toBe(10);
  });

  it('trims 10% top+bottom outliers when runs >= 10', async () => {
    const metric = {
      id: 'fake2', name: 'Fake2', category: 'hot-path-runtime', units: 'ms',
      warmup: 0, runs: 10,
      run: async ({ iter }) => ({ value: iter === 0 ? 1000 : iter === 9 ? 2000 : iter })
    };
    const result = await runMetric(metric);
    expect(result.median).toBe(4.5);
  });

  it('iterates variants when metric.variants is set', async () => {
    const seen = [];
    const metric = {
      id: 'fake3', name: 'Fake3', category: 'db-query', units: 'ms',
      warmup: 0, runs: 1, variants: ['raw', 'parsed'],
      run: async ({ variant }) => {
        seen.push(variant);
        return { value: variant === 'raw' ? 10 : 20 };
      }
    };
    const result = await runMetric(metric);
    expect(seen).toEqual(['raw', 'parsed']);
    expect(result.byVariant).toEqual({
      raw: { median: 10, runs: 1 },
      parsed: { median: 20, runs: 1 }
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run tests/perf-driver.test.js`

Expected: FAIL with "Cannot find module '.../perf/driver'".

- [ ] **Step 3: Implement the driver**

Create `server/perf/driver.js`:

```js
'use strict';

function trimmedMedian(values) {
  if (values.length === 0) return null;
  if (values.length < 10) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  const trim = Math.floor(values.length * 0.1);
  const sorted = values.slice().sort((a, b) => a - b);
  const trimmed = sorted.slice(trim, sorted.length - trim);
  const mid = Math.floor(trimmed.length / 2);
  return trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function runOnce(metric, ctx) {
  const result = await metric.run(ctx);
  if (typeof result?.value !== 'number' || !Number.isFinite(result.value)) {
    throw new Error(`metric ${metric.id} returned non-numeric value: ${JSON.stringify(result)}`);
  }
  return result.value;
}

async function runVariant(metric, variant) {
  const ctx = { fixture: metric.fixture, variant };
  for (let i = 0; i < (metric.warmup || 0); i++) {
    await runOnce(metric, { ...ctx, iter: -1 });
  }
  const samples = [];
  for (let i = 0; i < metric.runs; i++) {
    const v = await runOnce(metric, { ...ctx, iter: i });
    samples.push(v);
  }
  return { median: trimmedMedian(samples), p95: p95(samples), runs: samples.length };
}

async function runMetric(metric) {
  if (metric.variants && metric.variants.length > 0) {
    const byVariant = {};
    for (const variant of metric.variants) {
      const r = await runVariant(metric, variant);
      byVariant[variant] = { median: r.median, runs: r.runs };
      if (r.p95 !== null && r.p95 !== r.median) byVariant[variant].p95 = r.p95;
    }
    return { id: metric.id, runs: metric.runs, warmup: metric.warmup, byVariant };
  }
  const r = await runVariant(metric, null);
  return { id: metric.id, median: r.median, p95: r.p95, runs: r.runs, warmup: metric.warmup };
}

module.exports = { runMetric, trimmedMedian, p95 };
```

- [ ] **Step 4: Wire driver into run-perf.js**

Change `function run()` to `async function run()` and replace its body with:

```js
async function run() {
  if (args.includes('--metrics-list')) {
    const all = registry.list();
    if (all.length === 0) { console.log('No metrics registered yet.'); return 0; }
    for (const m of all) console.log(`${m.id}\t${m.category}\t${m.name}`);
    return 0;
  }

  if (process.env.PERF_SMOKE === '1') {
    const payload = { captured_at: new Date().toISOString(), env: report.captureEnv(), metrics: {} };
    const target = report.writeLastRun(outDir, payload);
    console.log(`smoke run wrote ${target}`);
    return 0;
  }

  const all = registry.list();
  if (all.length === 0) {
    console.log('No metrics registered. Add metric modules under server/perf/metrics/.');
    return 0;
  }

  const driver = require('./driver');
  const results = {};
  for (const metric of all) {
    process.stdout.write(`measuring ${metric.id}... `);
    const r = await driver.runMetric(metric);
    results[metric.id] = r;
    if (r.byVariant) {
      const summary = Object.entries(r.byVariant).map(([k, v]) => `${k}=${v.median.toFixed(2)}`).join(' ');
      console.log(summary);
    } else {
      console.log(`median=${r.median.toFixed(2)}${r.p95 ? ` p95=${r.p95.toFixed(2)}` : ''}`);
    }
  }

  const payload = { captured_at: new Date().toISOString(), env: report.captureEnv(), metrics: results };
  const target = report.writeLastRun(outDir, payload);
  console.log(`wrote ${target}`);
  return 0;
}
```

Replace the bottom `process.exitCode = run();` line with:

```js
run().then((code) => process.exit(code), (err) => { console.error('perf run failed:', err); process.exit(2); });
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-driver.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/driver.js server/perf/run-perf.js server/tests/perf-driver.test.js
git commit -m "perf(harness): driver with warmup, runs, trimmed median, p95, variants"
```

---

## Task 4: Add seeded fixture builder

**Files:**
- Create: `server/perf/fixtures.js`
- Test: `server/tests/perf-fixtures.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-fixtures.test.js`:

```js
const { buildFixture } = require('../perf/fixtures');

describe('perf fixture builder', () => {
  it('returns a sqlite handle plus seeded counts', () => {
    const fx = buildFixture({ tasks: 100, batchTasks: 25 });
    try {
      expect(fx.db).toBeDefined();
      const taskCount = fx.db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
      expect(taskCount).toBe(100);
      const batchTasks = fx.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE batch_id IS NOT NULL').get().c;
      expect(batchTasks).toBe(25);
    } finally {
      fx.close();
    }
  });

  it('seeds deterministically — same options produce same task ids', () => {
    const a = buildFixture({ tasks: 10, seed: 42 });
    const b = buildFixture({ tasks: 10, seed: 42 });
    try {
      const aIds = a.db.prepare('SELECT id FROM tasks ORDER BY id').all().map((r) => r.id);
      const bIds = b.db.prepare('SELECT id FROM tasks ORDER BY id').all().map((r) => r.id);
      expect(aIds).toEqual(bIds);
    } finally {
      a.close();
      b.close();
    }
  });

  it('seeds at least one project row even when tasks=0', () => {
    const fx = buildFixture({ tasks: 0 });
    try {
      const projectCount = fx.db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
      expect(projectCount).toBeGreaterThanOrEqual(1);
    } finally {
      fx.close();
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run tests/perf-fixtures.test.js`

Expected: FAIL with "Cannot find module '.../perf/fixtures'".

- [ ] **Step 3: Implement the fixture builder**

Create `server/perf/fixtures.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFixture(opts = {}) {
  const tasks = opts.tasks ?? 1000;
  const batchTasks = opts.batchTasks ?? 0;
  const projectId = opts.projectId ?? 'perf-fixture';
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);

  const db = new Database(':memory:');
  runMigrations(db);

  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
    .run(projectId, 'Perf Fixture', new Date().toISOString());

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project, status, description, created_at, batch_id, tags, files_modified, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < tasks; i++) {
      const id = `perf-task-${seed}-${i.toString().padStart(6, '0')}`;
      const status = rng() < 0.7 ? 'completed' : 'failed';
      const inBatch = i < batchTasks;
      insertTask.run(
        id, projectId, status,
        `Fixture task ${i} for perf measurement`,
        new Date(Date.now() - i * 1000).toISOString(),
        inBatch ? `perf-batch-${seed}` : null,
        JSON.stringify(['perf', `bucket-${i % 5}`]),
        JSON.stringify([`src/file-${i % 20}.js`]),
        JSON.stringify({ note: 'seeded' })
      );
    }
  });
  tx();

  return { db, projectId, close: () => db.close() };
}

module.exports = { buildFixture, mulberry32 };
```

- [ ] **Step 4: Run the test**

Run: `torque-remote npx vitest run tests/perf-fixtures.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/perf/fixtures.js server/tests/perf-fixtures.test.js
git commit -m "perf(harness): seeded in-memory fixture builder"
```

---

## Task 5: Implement metric #1 — queue scheduler tick

**Files:**
- Create: `server/perf/metrics/queue-scheduler-tick.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-queue-tick.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-queue-tick.test.js`:

```js
const metric = require('../perf/metrics/queue-scheduler-tick');

describe('metric: queue-scheduler-tick', () => {
  it('exposes the metric contract fields', () => {
    expect(metric.id).toBe('queue-scheduler-tick');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(100);
    expect(metric.warmup).toBeGreaterThanOrEqual(5);
    expect(typeof metric.run).toBe('function');
  });

  it('run() returns a positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-queue-tick.test.js`

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/queue-scheduler-tick.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 200, batchTasks: 50 });
  const scheduler = require('../../execution/queue-scheduler');
  cached = { fx, scheduler };
  return cached;
}

async function run() {
  const { scheduler } = lazyLoad();
  const start = performance.now();
  scheduler.processQueueInternal({ tickReason: 'perf-measurement', skipPromotion: true });
  const elapsed = performance.now() - start;
  return { value: elapsed };
}

module.exports = {
  id: 'queue-scheduler-tick',
  name: 'Queue scheduler tick (skipPromotion)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 10,
  runs: 1000,
  run
};
```

- [ ] **Step 4: Register the metric**

Modify `server/perf/metrics/all.js`:

```js
'use strict';

require('../metrics').register(require('./queue-scheduler-tick'));
```

- [ ] **Step 5: Run the test + a smoke run**

Run: `torque-remote npx vitest run tests/perf-metric-queue-tick.test.js`

Expected: PASS.

Then from the worktree's `server/` directory, run: `node perf/run-perf.js`

Expected: a `measuring queue-scheduler-tick... median=...` line, then `wrote .../last-run.json`.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/queue-scheduler-tick.js server/perf/metrics/all.js server/tests/perf-metric-queue-tick.test.js
git commit -m "perf(metrics): #1 queue-scheduler-tick"
```

> **Note for Tasks 6–17:** Each metric module follows the same shape: a `server/perf/metrics/<slug>.js` file exporting the contract, a `server/tests/perf-metric-<slug>.test.js` smoke test asserting the contract is honored and `run()` returns a positive number, registration in `metrics/all.js`, and one commit per metric. Setup logic is metric-specific; the harness shape is invariant.

---

## Task 6: Implement metric #2 — task pipeline `handleTaskCreate`

**Files:**
- Create: `server/perf/metrics/task-pipeline-create.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-task-pipeline-create.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-task-pipeline-create.test.js`:

```js
const metric = require('../perf/metrics/task-pipeline-create');

describe('metric: task-pipeline-create', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('task-pipeline-create');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(50);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-task-pipeline-create.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/task-pipeline-create.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 0 });
  const { handleTaskCreate } = require('../../handlers/task/pipeline');
  cached = { fx, handleTaskCreate };
  return cached;
}

let counter = 0;

async function run({ iter }) {
  const { handleTaskCreate, fx } = lazyLoad();
  counter += 1;
  const start = performance.now();
  await handleTaskCreate({
    project: fx.projectId,
    description: `Perf measurement task ${counter} iter ${iter}`,
    provider: 'system',
    dryRun: true
  });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'task-pipeline-create',
  name: 'Task pipeline handleTaskCreate (dryRun)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 10,
  runs: 100,
  run
};
```

- [ ] **Step 4: Register the metric**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./task-pipeline-create'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-task-pipeline-create.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/task-pipeline-create.js server/perf/metrics/all.js server/tests/perf-metric-task-pipeline-create.test.js
git commit -m "perf(metrics): #2 task-pipeline-create"
```

---

## Task 7: Implement metric #3 — governance `evaluate()`

**Files:**
- Create: `server/perf/metrics/governance-evaluate.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-governance-evaluate.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-governance-evaluate.test.js`:

```js
const metric = require('../perf/metrics/governance-evaluate');

describe('metric: governance-evaluate', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('governance-evaluate');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-governance-evaluate.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/governance-evaluate.js`:

```js
'use strict';

const { performance } = require('perf_hooks');

let cached = null;

function lazyLoad() {
  if (cached) return cached;
  const { createGovernanceHooks } = require('../../governance/hooks');
  const hooks = createGovernanceHooks({ projectName: 'perf-fixture' });
  cached = { hooks };
  return cached;
}

async function run() {
  const { hooks } = lazyLoad();
  const taskBrief = {
    project: 'perf-fixture',
    description: 'Perf measurement task',
    provider: 'codex',
    working_directory: process.cwd()
  };
  const start = performance.now();
  await hooks.evaluate('preTaskSubmit', taskBrief);
  return { value: performance.now() - start };
}

module.exports = {
  id: 'governance-evaluate',
  name: 'Governance hooks evaluate(preTaskSubmit)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run
};
```

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./governance-evaluate'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-governance-evaluate.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/governance-evaluate.js server/perf/metrics/all.js server/tests/perf-metric-governance-evaluate.test.js
git commit -m "perf(metrics): #3 governance-evaluate"
```

---

## Task 8: Implement metric #4 — dashboard `/api/v2/projects/:id/stats` p95

**Files:**
- Create: `server/perf/metrics/dashboard-project-stats.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-dashboard-project-stats.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-dashboard-project-stats.test.js`:

```js
const metric = require('../perf/metrics/dashboard-project-stats');

describe('metric: dashboard-project-stats', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('dashboard-project-stats');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
  });

  it('run() returns a positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 2: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-dashboard-project-stats.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/dashboard-project-stats.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const http = require('http');
const { buildFixture } = require('../fixtures');

let server = null;
let port = 0;
let projectId = null;

async function setup() {
  if (server) return;
  const fx = buildFixture({ tasks: 1000, batchTasks: 200 });
  projectId = fx.projectId;
  const { createDashboardServer } = require('../../dashboard-server');
  server = createDashboardServer({ db: fx.db, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}

function getStats() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/v2/projects/${projectId}/stats`, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error(`status ${res.statusCode}: ${body}`));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  await setup();
  const start = performance.now();
  await getStats();
  return { value: performance.now() - start };
}

module.exports = {
  id: 'dashboard-project-stats',
  name: 'Dashboard /api/v2/projects/:id/stats',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run
};
```

> NOTE: `createDashboardServer` may not currently accept `{ db, port }` options. If it does not, add a thin factory wrapper in `server/dashboard-server.js` that takes a pre-built db handle and returns an http.Server without auto-starting listen. Read `dashboard-server.js` first; the factory should not change any existing exports.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./dashboard-project-stats'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-dashboard-project-stats.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/dashboard-project-stats.js server/perf/metrics/all.js server/tests/perf-metric-dashboard-project-stats.test.js server/dashboard-server.js
git commit -m "perf(metrics): #4 dashboard-project-stats"
```

---

## Task 9: Implement metric #5 — MCP `task_info` round-trip

**Files:**
- Create: `server/perf/metrics/mcp-task-info.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-mcp-task-info.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-mcp-task-info.test.js`:

```js
const metric = require('../perf/metrics/mcp-task-info');

describe('metric: mcp-task-info', () => {
  it('contract', () => {
    expect(metric.id).toBe('mcp-task-info');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-mcp-task-info.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/mcp-task-info.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

async function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 100 });
  const { createTools } = require('../../tools');
  const { handleToolCall } = createTools({ db: fx.db });
  const row = fx.db.prepare('SELECT id FROM tasks LIMIT 1').get();
  cached = { handleToolCall, taskId: row.id };
  return cached;
}

async function run() {
  const { handleToolCall, taskId } = await setup();
  const start = performance.now();
  await handleToolCall('task_info', { task_id: taskId });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'mcp-task-info',
  name: 'MCP tool round-trip: task_info',
  category: 'request-latency',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run
};
```

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./mcp-task-info'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-mcp-task-info.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/mcp-task-info.js server/perf/metrics/all.js server/tests/perf-metric-mcp-task-info.test.js
git commit -m "perf(metrics): #5 mcp-task-info round-trip"
```

---

## Task 10: Implement metric #6 — SSE notification fan-out

**Files:**
- Create: `server/perf/metrics/sse-fan-out.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-sse-fan-out.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-sse-fan-out.test.js`:

```js
const metric = require('../perf/metrics/sse-fan-out');

describe('metric: sse-fan-out', () => {
  it('contract', () => {
    expect(metric.id).toBe('sse-fan-out');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-sse-fan-out.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/sse-fan-out.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const http = require('http');

let cached = null;

async function setup() {
  if (cached) return cached;
  const { createMcpSseTransport } = require('../../mcp-sse');
  const transport = createMcpSseTransport();
  const server = http.createServer((req, res) => transport.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  cached = { server, transport, port };
  return cached;
}

function subscribeOnce(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/sse', method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          if (buf.includes('event: ready')) {
            res.destroy();
            resolve();
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const { port, transport } = await setup();
  const start = performance.now();
  await subscribeOnce(port);
  await transport.broadcast({ type: 'perf-test', iter: Date.now() });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'sse-fan-out',
  name: 'SSE fan-out: subscribe → broadcast → receive',
  category: 'request-latency',
  units: 'ms',
  warmup: 3,
  runs: 50,
  run
};
```

> NOTE: If `createMcpSseTransport` does not export `broadcast`, this metric should call into the live event-bus (`require('../../event-bus').emit(...)`) and measure the time until a subscribed client receives the matching frame. Read `server/mcp-sse.js` and `server/event-bus.js` first; pick the cleanest single-cycle measurement. Document the chosen approach in a comment.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./sse-fan-out'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-sse-fan-out.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/sse-fan-out.js server/perf/metrics/all.js server/tests/perf-metric-sse-fan-out.test.js
git commit -m "perf(metrics): #6 sse-fan-out"
```

---

## Task 11: Implement metric #7 — DB factory cost summary

**Files:**
- Create: `server/perf/metrics/db-factory-cost-summary.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-db-factory-cost-summary.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-db-factory-cost-summary.test.js`:

```js
const metric = require('../perf/metrics/db-factory-cost-summary');

describe('metric: db-factory-cost-summary', () => {
  it('contract', () => {
    expect(metric.id).toBe('db-factory-cost-summary');
    expect(metric.category).toBe('db-query');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-db-factory-cost-summary.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/db-factory-cost-summary.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 100, batchTasks: 100 });
  const insertCost = fx.db.prepare(
    `INSERT INTO cost_tracking (task_id, provider, model, prompt_tokens, completion_tokens, total_cost, tracked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = fx.db.transaction(() => {
    const tasks = fx.db.prepare('SELECT id FROM tasks').all();
    for (const t of tasks) {
      insertCost.run(t.id, 'codex', 'gpt-5.3-codex', 1000, 500, 0.012, new Date().toISOString());
    }
  });
  tx();
  const { buildProjectCostSummary } = require('../../factory/cost-metrics');
  cached = { fx, buildProjectCostSummary };
  return cached;
}

async function run() {
  const { buildProjectCostSummary, fx } = setup();
  const start = performance.now();
  buildProjectCostSummary(fx.projectId, { db: fx.db });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'db-factory-cost-summary',
  name: 'DB: buildProjectCostSummary (100-task batch)',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run
};
```

> NOTE: If `buildProjectCostSummary` does not accept `{ db }` for injection, read `server/factory/cost-metrics.js` and either pass the db through the existing argument shape or add an internal helper that accepts the handle. Document the chosen path in a comment.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./db-factory-cost-summary'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-db-factory-cost-summary.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/db-factory-cost-summary.js server/perf/metrics/all.js server/tests/perf-metric-db-factory-cost-summary.test.js
git commit -m "perf(metrics): #7 db-factory-cost-summary"
```

---

## Task 12: Implement metric #8 — DB `getProjectStats`

**Files:**
- Create: `server/perf/metrics/db-project-stats.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-db-project-stats.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-db-project-stats.test.js`:

```js
const metric = require('../perf/metrics/db-project-stats');

describe('metric: db-project-stats', () => {
  it('contract', () => {
    expect(metric.id).toBe('db-project-stats');
    expect(metric.category).toBe('db-query');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-db-project-stats.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/db-project-stats.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 1000 });
  const { getProjectStats } = require('../../db/project-config-core');
  cached = { fx, getProjectStats };
  return cached;
}

async function run() {
  const { getProjectStats, fx } = setup();
  const start = performance.now();
  getProjectStats(fx.projectId, { db: fx.db });
  return { value: performance.now() - start };
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
```

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./db-project-stats'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-db-project-stats.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/db-project-stats.js server/perf/metrics/all.js server/tests/perf-metric-db-project-stats.test.js
git commit -m "perf(metrics): #8 db-project-stats"
```

---

## Task 13: Implement metric #9 — DB `listTasks` raw vs parsed (variants)

**Files:**
- Create: `server/perf/metrics/db-list-tasks.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-db-list-tasks.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-db-list-tasks.test.js`:

```js
const metric = require('../perf/metrics/db-list-tasks');

describe('metric: db-list-tasks', () => {
  it('exposes variants', () => {
    expect(metric.id).toBe('db-list-tasks');
    expect(metric.variants).toEqual(['parsed', 'raw']);
  });

  it('run({variant: "parsed"}) returns positive value', async () => {
    const r = await metric.run({ iter: 0, variant: 'parsed' });
    expect(r.value).toBeGreaterThan(0);
  });

  it('run({variant: "raw"}) returns positive value', async () => {
    const r = await metric.run({ iter: 0, variant: 'raw' });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-db-list-tasks.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/db-list-tasks.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 1000 });
  const { listTasks } = require('../../db/task-core');
  cached = { fx, listTasks };
  return cached;
}

async function run({ variant }) {
  const { listTasks, fx } = setup();
  const opts = { project: fx.projectId, limit: 1000 };
  if (variant === 'raw') opts.raw = true;
  const start = performance.now();
  listTasks(opts, { db: fx.db });
  return { value: performance.now() - start };
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
```

> NOTE: `listTasks({ raw: true })` is a planned Phase 3 addition — until that ships, the raw variant baseline equals the parsed variant. The metric module is forward-compatible: when Phase 3 adds the option, the variant divergence appears in the next run.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./db-list-tasks'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-db-list-tasks.test.js`

Expected: PASS (both variants return numeric values; raw == parsed for now).

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/db-list-tasks.js server/perf/metrics/all.js server/tests/perf-metric-db-list-tasks.test.js
git commit -m "perf(metrics): #9 db-list-tasks (parsed and raw variants)"
```

---

## Task 14: Implement metric #10 — DB budget threshold check

**Files:**
- Create: `server/perf/metrics/db-budget-threshold.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-db-budget-threshold.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-db-budget-threshold.test.js`:

```js
const metric = require('../perf/metrics/db-budget-threshold');

describe('metric: db-budget-threshold', () => {
  it('contract', () => {
    expect(metric.id).toBe('db-budget-threshold');
    expect(metric.category).toBe('db-query');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-db-budget-threshold.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/db-budget-threshold.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 100 });
  const insertCost = fx.db.prepare(
    `INSERT INTO cost_tracking (task_id, provider, model, prompt_tokens, completion_tokens, total_cost, tracked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  const tx = fx.db.transaction(() => {
    const tasks = fx.db.prepare('SELECT id FROM tasks').all();
    let i = 0;
    for (const t of tasks) {
      insertCost.run(t.id, 'codex', 'gpt-5.3-codex', 1000, 500, 0.05,
        new Date(now - (i++ * 60_000)).toISOString());
    }
  });
  tx();
  const { checkBudgetThreshold } = require('../../db/budget-watcher');
  cached = { fx, checkBudgetThreshold };
  return cached;
}

async function run() {
  const { checkBudgetThreshold, fx } = setup();
  const start = performance.now();
  checkBudgetThreshold({ provider: 'codex', windowHours: 24 }, { db: fx.db });
  return { value: performance.now() - start };
}

module.exports = {
  id: 'db-budget-threshold',
  name: 'DB: budget threshold check (windowed spend)',
  category: 'db-query',
  units: 'ms',
  warmup: 5,
  runs: 50,
  run
};
```

> NOTE: The current `checkBudgetThreshold` filters by `created_at` (column does not exist on `cost_tracking` — see prior performance-sweep finding). The metric will run, but the query falls off the index. That is the Phase 2 target. Read `server/db/budget-watcher.js` first to confirm the function signature, and adjust the call shape if the API differs.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./db-budget-threshold'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-db-budget-threshold.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/db-budget-threshold.js server/perf/metrics/all.js server/tests/perf-metric-db-budget-threshold.test.js
git commit -m "perf(metrics): #10 db-budget-threshold"
```

---

## Task 15: Implement metric #11 — cold import (4 module variants)

**Files:**
- Create: `server/perf/metrics/cold-import.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-cold-import.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-cold-import.test.js`:

```js
const metric = require('../perf/metrics/cold-import');

describe('metric: cold-import', () => {
  it('exposes the four module variants', () => {
    expect(metric.id).toBe('cold-import');
    expect(metric.variants).toEqual(['tools', 'task-manager', 'database', 'db-task-core']);
  });

  it('run({variant}) returns positive ms', async () => {
    const r = await metric.run({ iter: 0, variant: 'database' });
    expect(r.value).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-cold-import.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/cold-import.js`:

```js
'use strict';

const cp = require('node:child_process');
const path = require('path');

const VARIANT_PATHS = {
  tools: path.resolve(__dirname, '..', '..', 'tools.js'),
  'task-manager': path.resolve(__dirname, '..', '..', 'task-manager.js'),
  database: path.resolve(__dirname, '..', '..', 'database.js'),
  'db-task-core': path.resolve(__dirname, '..', '..', 'db', 'task-core.js')
};

async function run({ variant }) {
  const target = VARIANT_PATHS[variant];
  if (!target) throw new Error(`unknown variant ${variant}`);
  // Spawn a fresh node process so each run gets a cold module cache.
  const child = cp.spawnSync(process.execPath, ['-e', `
    const start = process.hrtime.bigint();
    require(${JSON.stringify(target)});
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    process.stdout.write(elapsed.toFixed(3));
  `], { encoding: 'utf8' });
  if (child.status !== 0) {
    throw new Error(`cold-import child failed: ${child.stderr}`);
  }
  return { value: parseFloat(child.stdout) };
}

module.exports = {
  id: 'cold-import',
  name: 'Cold import time per heavy module',
  category: 'test-infra',
  units: 'ms',
  warmup: 1,
  runs: 10,
  variants: ['tools', 'task-manager', 'database', 'db-task-core'],
  run
};
```

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./cold-import'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-cold-import.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/cold-import.js server/perf/metrics/all.js server/tests/perf-metric-cold-import.test.js
git commit -m "perf(metrics): #11 cold-import (4 module variants)"
```

---

## Task 16: Implement metric #12 — worktree create + cleanup wall time

**Files:**
- Create: `server/perf/metrics/worktree-lifecycle.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-worktree-lifecycle.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-worktree-lifecycle.test.js`:

```js
const metric = require('../perf/metrics/worktree-lifecycle');

describe('metric: worktree-lifecycle', () => {
  it('contract', () => {
    expect(metric.id).toBe('worktree-lifecycle');
    expect(metric.category).toBe('dev-iteration');
  });

  it('run() completes and returns positive ms', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  }, 60000);
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-worktree-lifecycle.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/worktree-lifecycle.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const cp = require('node:child_process');
const path = require('path');

let counter = 0;

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  counter++;
  const slug = `perf-mtm-${process.pid}-${counter}`;
  const branch = `perf/mtm-${slug}`;
  const worktreePath = path.join(repoRoot, '.worktrees', `feat-${slug}`);

  const start = performance.now();

  let r = cp.spawnSync('git', ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`create failed: ${r.stderr}`);

  r = cp.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`remove failed: ${r.stderr}`);
  cp.spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, encoding: 'utf8' });

  return { value: performance.now() - start };
}

module.exports = {
  id: 'worktree-lifecycle',
  name: 'Worktree create + cleanup (no-checkout)',
  category: 'dev-iteration',
  units: 'ms',
  warmup: 1,
  runs: 5,
  run
};
```

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./worktree-lifecycle'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-worktree-lifecycle.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/metrics/worktree-lifecycle.js server/perf/metrics/all.js server/tests/perf-metric-worktree-lifecycle.test.js
git commit -m "perf(metrics): #12 worktree-lifecycle"
```

---

## Task 17: Implement metric #13 — restart barrier drain → ready

**Files:**
- Create: `server/perf/metrics/restart-barrier.js`
- Modify: `server/perf/metrics/all.js`
- Test: `server/tests/perf-metric-restart-barrier.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-metric-restart-barrier.test.js`:

```js
const metric = require('../perf/metrics/restart-barrier');

describe('metric: restart-barrier', () => {
  it('contract', () => {
    expect(metric.id).toBe('restart-barrier');
    expect(metric.category).toBe('dev-iteration');
  });

  it('run() returns positive ms (in-process barrier sim)', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-metric-restart-barrier.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the metric**

Create `server/perf/metrics/restart-barrier.js`:

```js
'use strict';

const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

let cached = null;

function setup() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 5 });
  const restartBarrier = require('../../execution/restart-barrier');
  const eventBus = require('../../event-bus');
  cached = { fx, restartBarrier, eventBus };
  return cached;
}

async function run() {
  const { restartBarrier, eventBus, fx } = setup();
  // Simulate the barrier path in-process. Real restart_server is too slow
  // to measure 5 times; this measures the drain-and-ready synchronization
  // primitive in the no-running-tasks case.
  const start = performance.now();
  const barrier = restartBarrier.createBarrier({ db: fx.db, eventBus });
  await barrier.waitForDrain();
  return { value: performance.now() - start };
}

module.exports = {
  id: 'restart-barrier',
  name: 'Restart barrier: drain → ready (in-process)',
  category: 'dev-iteration',
  units: 'ms',
  warmup: 0,
  runs: 5,
  run
};
```

> NOTE: If `restart-barrier.js` does not currently expose `createBarrier({ db, eventBus })` and `waitForDrain()`, this metric should call into whichever shape exists today (e.g., `cleanupStaleRestartBarriers` + `subscribeToShutdown`). Read `server/execution/restart-barrier.js` first; the goal is to measure the time from "barrier raised" to "drain signal fired" in the no-running-tasks case. Document the chosen approach in a comment.

- [ ] **Step 4: Register**

Append to `server/perf/metrics/all.js`:

```js
require('../metrics').register(require('./restart-barrier'));
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-metric-restart-barrier.test.js`

Expected: PASS.

- [ ] **Step 6: Run full perf and verify all 13 metrics show up**

From the worktree, run: `cd server && node perf/run-perf.js --metrics-list`

Expected: 13 lines (queue-scheduler-tick, task-pipeline-create, governance-evaluate, dashboard-project-stats, mcp-task-info, sse-fan-out, db-factory-cost-summary, db-project-stats, db-list-tasks, db-budget-threshold, cold-import, worktree-lifecycle, restart-barrier).

- [ ] **Step 7: Commit**

```bash
git add server/perf/metrics/restart-barrier.js server/perf/metrics/all.js server/tests/perf-metric-restart-barrier.test.js
git commit -m "perf(metrics): #13 restart-barrier — completes the v0 metric set"
```

---

## Task 18: Implement reporter with baseline diff and threshold check

**Files:**
- Modify: `server/perf/report.js`
- Modify: `server/perf/run-perf.js`
- Test: `server/tests/perf-reporter.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-reporter.test.js`:

```js
const { compareToBaseline } = require('../perf/report');

describe('perf reporter compareToBaseline', () => {
  it('returns no regressions when current matches baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 100 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it('flags regression when current >10% above baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 115 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].id).toBe('foo');
    expect(result.regressions[0].delta_pct).toBeCloseTo(15, 1);
  });

  it('does NOT flag a 9% increase as regression', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 109 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
  });

  it('flags an improvement when current <-10% below baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 70 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toHaveLength(1);
  });

  it('handles variants by exploding into per-variant entries', () => {
    const baseline = {
      metrics: { 'cold-import': { byVariant: { tools: { median: 300 }, database: { median: 80 } } } }
    };
    const current = {
      metrics: { 'cold-import': { byVariant: { tools: { median: 350 }, database: { median: 80 } } } }
    };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].id).toBe('cold-import.tools');
  });

  it('skips comparison when env mismatches and reports advisory', () => {
    const baseline = { metrics: { foo: { median: 100 } }, env: { host_label: 'omen' } };
    const current = { metrics: { foo: { median: 200 } }, env: { host_label: 'macbook' } };
    const result = compareToBaseline(baseline, current);
    expect(result.advisory).toBe(true);
    expect(result.regressions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-reporter.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement compareToBaseline**

Edit `server/perf/report.js`. Append to the existing module:

```js
const REGRESSION_THRESHOLD_PCT = 10;
const IMPROVEMENT_THRESHOLD_PCT = -10;

function expandVariants(metrics) {
  const out = {};
  for (const [id, entry] of Object.entries(metrics || {})) {
    if (entry.byVariant) {
      for (const [variant, vEntry] of Object.entries(entry.byVariant)) {
        out[`${id}.${variant}`] = vEntry;
      }
    } else {
      out[id] = entry;
    }
  }
  return out;
}

function compareToBaseline(baseline, current) {
  if (!baseline) {
    return { regressions: [], improvements: [], advisory: false, notes: ['no baseline.json — first run'] };
  }
  const baselineHost = baseline.env?.host_label;
  const currentHost = current.env?.host_label;
  if (baselineHost && currentHost && baselineHost !== currentHost) {
    return {
      regressions: [], improvements: [], advisory: true,
      notes: [`env mismatch: baseline captured on ${baselineHost}, current on ${currentHost} — advisory only`]
    };
  }

  const baseM = expandVariants(baseline.metrics);
  const curM = expandVariants(current.metrics);
  const regressions = [];
  const improvements = [];

  for (const [id, cur] of Object.entries(curM)) {
    const base = baseM[id];
    if (!base || typeof base.median !== 'number') continue;
    const delta_pct = ((cur.median - base.median) / base.median) * 100;
    if (delta_pct > REGRESSION_THRESHOLD_PCT) {
      regressions.push({ id, baseline_median: base.median, current_median: cur.median, delta_pct });
    } else if (delta_pct < IMPROVEMENT_THRESHOLD_PCT) {
      improvements.push({ id, baseline_median: base.median, current_median: cur.median, delta_pct });
    }
  }

  return { regressions, improvements, advisory: false, notes: [] };
}

module.exports.compareToBaseline = compareToBaseline;
module.exports.REGRESSION_THRESHOLD_PCT = REGRESSION_THRESHOLD_PCT;
```

- [ ] **Step 4: Wire into run-perf.js**

Edit `server/perf/run-perf.js`. After the `const target = report.writeLastRun(outDir, payload);` line, before the `return 0;`, insert:

```js
  const baseline = report.readBaseline(outDir);
  const cmp = report.compareToBaseline(baseline, payload);
  if (cmp.notes.length > 0) console.log(cmp.notes.join('\n'));
  if (cmp.improvements.length > 0) {
    console.log(`\nImprovements (${cmp.improvements.length}):`);
    for (const i of cmp.improvements) {
      console.log(`  ${i.id}: ${i.baseline_median.toFixed(2)} → ${i.current_median.toFixed(2)} (${i.delta_pct.toFixed(1)}%)`);
    }
  }
  if (cmp.regressions.length > 0) {
    console.log(`\nRegressions (${cmp.regressions.length}):`);
    for (const r of cmp.regressions) {
      console.log(`  ${r.id}: ${r.baseline_median.toFixed(2)} → ${r.current_median.toFixed(2)} (+${r.delta_pct.toFixed(1)}%)`);
    }
    if (process.env.PERF_GATE_BYPASS === '1') {
      console.log('\nPERF_GATE_BYPASS=1 set — regressions logged but exit suppressed');
    } else if (cmp.advisory) {
      console.log('\nadvisory mode — regressions reported but exit suppressed');
    } else {
      return 1;
    }
  }
```

- [ ] **Step 5: Run the test**

Run: `torque-remote npx vitest run tests/perf-reporter.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/perf/report.js server/perf/run-perf.js server/tests/perf-reporter.test.js
git commit -m "perf(reporter): baseline diff with 10% threshold and env-mismatch advisory"
```

---

## Task 19: Implement `--update-baseline` mode

**Files:**
- Modify: `server/perf/run-perf.js`
- Modify: `server/perf/report.js`
- Test: `server/tests/perf-update-baseline.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-update-baseline.test.js`:

```js
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('node:child_process');

const PERF_RUNNER = path.resolve(__dirname, '..', 'perf', 'run-perf.js');

describe('perf --update-baseline', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ub-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes baseline.json from last-run.json when --update-baseline is passed', () => {
    fs.writeFileSync(path.join(tmpHome, 'last-run.json'), JSON.stringify({
      captured_at: '2026-04-25T00:00:00Z',
      env: { host_label: 'test' },
      metrics: { foo: { median: 50 } }
    }));
    const result = cp.spawnSync(process.execPath, [PERF_RUNNER, '--update-baseline'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PERF_OUT_DIR: tmpHome, PERF_SMOKE: '1' },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    const baseline = JSON.parse(fs.readFileSync(path.join(tmpHome, 'baseline.json'), 'utf8'));
    expect(baseline.metrics.foo.median).toBe(50);
    expect(baseline.metrics.foo.last_updated_at).toBeDefined();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-update-baseline.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement --update-baseline flow**

Edit `server/perf/report.js`. Add at the bottom:

```js
function updateBaseline(outDir) {
  const lastPath = path.join(outDir, 'last-run.json');
  if (!fs.existsSync(lastPath)) {
    throw new Error(`last-run.json not found at ${lastPath} — run perf first`);
  }
  const last = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
  const stamp = new Date().toISOString();
  const metrics = {};
  for (const [id, entry] of Object.entries(last.metrics || {})) {
    metrics[id] = { ...entry, last_updated_at: stamp };
  }
  const baseline = {
    captured_at: last.captured_at,
    env: last.env,
    last_updated_at: stamp,
    metrics
  };
  const target = path.join(outDir, 'baseline.json');
  fs.writeFileSync(target, JSON.stringify(baseline, null, 2));
  return target;
}

module.exports.updateBaseline = updateBaseline;
```

Edit `server/perf/run-perf.js`. Inside the `async function run()`, near the top (right after the `--metrics-list` branch), add:

```js
  if (args.includes('--update-baseline')) {
    const target = report.updateBaseline(outDir);
    console.log(`updated baseline at ${target}`);
    return 0;
  }
```

- [ ] **Step 4: Run the test**

Run: `torque-remote npx vitest run tests/perf-update-baseline.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/perf/run-perf.js server/perf/report.js server/tests/perf-update-baseline.test.js
git commit -m "perf(reporter): --update-baseline copies last-run.json into baseline.json"
```

---

## Task 20: Add advisory banner on host mismatch + env-capture tests

**Files:**
- Modify: `server/perf/run-perf.js`
- Modify: `server/tests/perf-reporter.test.js`

- [ ] **Step 1: Add new failing tests**

Append to `server/tests/perf-reporter.test.js`:

```js
const { captureEnv } = require('../perf/report');

describe('perf captureEnv', () => {
  it('includes cpu_count, total_memory_mb, node_version, platform, host_label', () => {
    const env = captureEnv();
    expect(env.cpu_count).toBeGreaterThan(0);
    expect(env.total_memory_mb).toBeGreaterThan(0);
    expect(env.node_version).toMatch(/^v/);
    expect(env.platform).toMatch(/^(win32|linux|darwin)$/);
    expect(env.host_label).toBeTruthy();
  });

  it('honors PERF_HOST_LABEL when set', () => {
    const orig = process.env.PERF_HOST_LABEL;
    try {
      process.env.PERF_HOST_LABEL = 'test-host';
      const env = captureEnv();
      expect(env.host_label).toBe('test-host');
    } finally {
      if (orig === undefined) delete process.env.PERF_HOST_LABEL;
      else process.env.PERF_HOST_LABEL = orig;
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `torque-remote npx vitest run tests/perf-reporter.test.js`

Expected: PASS (the existing captureEnv from Task 1 already honors PERF_HOST_LABEL).

- [ ] **Step 3: Add advisory banner output**

Edit `server/perf/run-perf.js`. After all metrics are measured but before the regressions block, add:

```js
  const baselineEnv = baseline?.env;
  const currentEnv = payload.env;
  if (baselineEnv && currentEnv && baselineEnv.host_label !== currentEnv.host_label) {
    console.log(`\nNOTICE: baseline captured on ${baselineEnv.host_label}, current run on ${currentEnv.host_label} — advisory mode (no gate)`);
  }
```

- [ ] **Step 4: Verify the smoke run still works**

From the worktree's `server/` directory, run: `node perf/run-perf.js`

Expected: completes; if no `baseline.json` exists yet, the run logs `no baseline.json — first run` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/perf/run-perf.js server/tests/perf-reporter.test.js
git commit -m "perf(reporter): env-capture tests + advisory banner on host mismatch"
```

---

## Task 21: Capture initial baseline on canonical workstation

**Files:**
- Create: `server/perf/baseline.json` (committed)

- [ ] **Step 1: Run the perf harness on torque-remote (canonical workstation)**

From the worktree:

```bash
torque-remote --branch feat/perf-0-baseline bash -c "cd server && node perf/run-perf.js"
```

Expected: `last-run.json` written under `server/perf/` on the remote, results streamed back.

- [ ] **Step 2: Promote last-run.json to baseline.json**

Still from the worktree:

```bash
torque-remote --branch feat/perf-0-baseline bash -c "cd server && node perf/run-perf.js --update-baseline"
```

Expected: `baseline.json` written under `server/perf/` on the remote.

- [ ] **Step 3: Pull baseline.json back to the worktree**

The remote workstation overlays its results into the local worktree as part of the `torque-remote` round trip. Verify in the worktree:

```bash
ls -la server/perf/baseline.json
```

Expected: file exists, ~1-2KB, contains 13 metric entries (with cold-import expanded to 4 variants and db-list-tasks to 2 variants).

If the file is not present locally after the remote run, copy it back manually using the project's standard remote-fetch flow.

- [ ] **Step 4: Sanity-check the baseline content**

```bash
cat server/perf/baseline.json | head -40
```

Expected: a valid JSON document with `captured_at`, `env.host_label` matching the workstation, and a `metrics` object with all 13 ids present.

- [ ] **Step 5: Commit**

```bash
git add server/perf/baseline.json
git commit -m "perf(baseline): capture initial v0 baseline on canonical workstation"
```

---

## Task 22: Add `perf-baseline:` trailer validator

**Files:**
- Create: `scripts/perf-baseline-trailer.js`
- Test: `server/tests/perf-baseline-trailer.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/perf-baseline-trailer.test.js`:

```js
const { validateTrailer } = require('../../scripts/perf-baseline-trailer');

describe('perf-baseline-trailer validator', () => {
  it('passes when baseline.json is not in diff', () => {
    const r = validateTrailer({ commitMessage: 'feat: unrelated', changedFiles: ['server/foo.js'] });
    expect(r.ok).toBe(true);
  });

  it('fails when baseline.json is in diff but no trailer present', () => {
    const r = validateTrailer({
      commitMessage: 'perf: tweak something',
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/perf-baseline:/);
  });

  it('passes when trailer is present with non-empty rationale (>20 chars after arrow)', () => {
    const r = validateTrailer({
      commitMessage: `perf: phase 1 ships

perf-baseline: governance evaluate() 1800 to 420 (Phase 1: async git subprocesses replace sync ones)
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(true);
  });

  it('fails when rationale is empty', () => {
    const r = validateTrailer({
      commitMessage: `perf: x

perf-baseline: foo 100 to 50
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
  });

  it('fails when rationale is too short (<20 chars after arrow)', () => {
    const r = validateTrailer({
      commitMessage: `perf: x

perf-baseline: foo 100 to 50 (small)
`,
      changedFiles: ['server/perf/baseline.json']
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `torque-remote npx vitest run tests/perf-baseline-trailer.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement the validator**

Create `scripts/perf-baseline-trailer.js`:

```js
'use strict';

const cp = require('node:child_process');

const BASELINE_FILE = 'server/perf/baseline.json';
const TRAILER_LINE_RE = /^perf-baseline:\s*([^\n]+?)\s*\(([^)]+)\)\s*$/m;
const RATIONALE_MIN_CHARS = 20;

function validateTrailer({ commitMessage, changedFiles }) {
  if (!changedFiles.some((f) => f === BASELINE_FILE || f.endsWith('/' + BASELINE_FILE))) {
    return { ok: true, reason: 'baseline.json not in diff' };
  }
  const allLines = (commitMessage || '').split(/\r?\n/);
  const trailers = allLines.filter((l) => /^perf-baseline:/.test(l));
  if (trailers.length === 0) {
    return { ok: false, reason: `commit modifies ${BASELINE_FILE} but contains no perf-baseline: trailer` };
  }
  for (const t of trailers) {
    const m = TRAILER_LINE_RE.exec(t);
    if (!m) {
      return { ok: false, reason: `perf-baseline: trailer not in expected format "<metric> <old> to <new> (<rationale>)" — got: ${t}` };
    }
    const rationale = m[2].trim();
    if (rationale.length < RATIONALE_MIN_CHARS) {
      return { ok: false, reason: `perf-baseline: rationale too short (<${RATIONALE_MIN_CHARS} chars): "${rationale}"` };
    }
  }
  return { ok: true };
}

function getCommitMessage(ref) {
  const r = cp.spawnSync('git', ['log', '-1', '--format=%B', ref], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return r.stdout;
}

function getChangedFiles(ref) {
  const r = cp.spawnSync('git', ['show', '--name-only', '--format=', ref], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git show failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

if (require.main === module) {
  const ref = process.argv[2] || 'HEAD';
  const result = validateTrailer({
    commitMessage: getCommitMessage(ref),
    changedFiles: getChangedFiles(ref)
  });
  if (result.ok) {
    process.exit(0);
  } else {
    console.error('perf-baseline trailer check FAILED:', result.reason);
    process.exit(1);
  }
}

module.exports = { validateTrailer };
```

- [ ] **Step 4: Run the test**

Run: `torque-remote npx vitest run tests/perf-baseline-trailer.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/perf-baseline-trailer.js server/tests/perf-baseline-trailer.test.js
git commit -m "perf(gate): trailer validator for perf-baseline: commit messages"
```

---

## Task 23: Wire pre-push hook integration

**Files:**
- Modify: `scripts/pre-push-hook`

- [ ] **Step 1: Read the current pre-push hook**

Open `scripts/pre-push-hook` and locate the section that decides whether to run the full main gate (look for the `is_main_push` or `targets_main` branch).

- [ ] **Step 2: Add a perf step to the main-push gate**

Edit `scripts/pre-push-hook`. Find the step that runs the existing test gate via `torque-remote`. Immediately AFTER the test gate's success path (the section that sets the gate-passed status), insert:

```bash
# Perf regression gate: run after tests pass, before allowing the push.
echo "[pre-push] running perf regression gate..."
PERF_OUT=$(torque-remote --branch "${gate_ref}" bash -c "cd server && node perf/run-perf.js" 2>&1)
PERF_STATUS=$?
echo "$PERF_OUT"
if [ "$PERF_STATUS" -ne 0 ]; then
  if [ "${PERF_GATE_BYPASS:-0}" = "1" ]; then
    echo "[pre-push] PERF_GATE_BYPASS=1 — perf regressions logged but push allowed"
    echo "[$(date -Iseconds)] BYPASS sha=$(git rev-parse HEAD) reason=PERF_GATE_BYPASS user=$(git config user.email)" \
      >> server/perf/bypass-audit.log
  else
    echo "[pre-push] perf regression gate FAILED — push blocked"
    echo "[pre-push] to bypass for incident response: PERF_GATE_BYPASS=1 git push"
    exit 1
  fi
fi

# perf-baseline trailer enforcement: any commit that modifies baseline.json
# must carry a perf-baseline: trailer with rationale.
for sha in $(git rev-list "$remote_ref..$local_ref"); do
  if git show --name-only --format= "$sha" | grep -q '^server/perf/baseline\.json$'; then
    if ! node scripts/perf-baseline-trailer.js "$sha"; then
      echo "[pre-push] commit $sha modifies baseline.json without perf-baseline: trailer"
      exit 1
    fi
  fi
done
```

> NOTE: The exact variable names (`gate_ref`, `remote_ref`, `local_ref`) depend on the existing hook's structure. Read the hook fully first, then place the perf step using the actual names. The placement requirement is: AFTER the existing test gate passes, BEFORE the hook returns 0.

- [ ] **Step 3: Smoke-test the hook locally (no actual push)**

From the worktree:

```bash
git push --dry-run origin feat/perf-0-baseline 2>&1 | head -30
```

Expected: hook runs, perf step executes, no actual push (dry-run).

- [ ] **Step 4: Commit**

```bash
git add scripts/pre-push-hook
git commit -m "perf(gate): pre-push integrates perf regression check + trailer enforcement"
```

---

## Task 24: Write README and finalize

**Files:**
- Create: `server/perf/README.md`

- [ ] **Step 1: Write the README**

Create `server/perf/README.md`:

````markdown
# Performance Harness

Measures hot-path latency, request latency, DB query timing, test infra cold-import, and dev-iteration speed across 13 tracked metrics. The committed `baseline.json` is the contract; pre-push gate fails if any tracked metric regresses >10%.

## Quick start

```bash
# Run all metrics, write last-run.json, compare to baseline.
npm run perf

# List registered metrics.
node perf/run-perf.js --metrics-list

# Promote last-run.json to baseline.json (requires perf-baseline: trailer in commit).
node perf/run-perf.js --update-baseline
```

## Metric set (v0)

13 metric definitions; #9 and #11 have multiple variants in baseline.json:

| ID | Category | Description |
|---|---|---|
| `queue-scheduler-tick` | hot-path-runtime | processQueueInternal() median |
| `task-pipeline-create` | hot-path-runtime | handleTaskCreate() dryRun median |
| `governance-evaluate` | hot-path-runtime | evaluate(preTaskSubmit) median |
| `dashboard-project-stats` | request-latency | /api/v2/projects/:id/stats over loopback HTTP |
| `mcp-task-info` | request-latency | handleToolCall('task_info') median + p95 |
| `sse-fan-out` | request-latency | subscribe → broadcast → receive p95 |
| `db-factory-cost-summary` | db-query | buildProjectCostSummary against 100-task batch |
| `db-project-stats` | db-query | getProjectStats against 1000-task project |
| `db-list-tasks` | db-query | listTasks 1000 rows; variants `parsed`, `raw` |
| `db-budget-threshold` | db-query | budget threshold windowed-spend lookup |
| `cold-import` | test-infra | spawn fresh node, require module; variants `tools`, `task-manager`, `database`, `db-task-core` |
| `worktree-lifecycle` | dev-iteration | git worktree add --no-checkout + remove |
| `restart-barrier` | dev-iteration | restart barrier drain → ready (no-tasks case) |

## Run protocol

Each metric runs `warmup` iterations (results discarded), then `runs` measurement iterations. The driver returns the trimmed-median (top/bottom 10% trimmed when runs ≥ 10) plus optional p95 for request-latency metrics. Variants run independently and produce separate baseline entries (`<id>.<variant>`).

## Baseline update protocol

When a fix legitimately changes a tracked metric:

1. From the feature worktree, run `npm run perf` and confirm timings.
2. Run `node perf/run-perf.js --update-baseline` to promote `last-run.json` to `baseline.json`.
3. Commit `baseline.json` with a `perf-baseline:` trailer per changed metric:

```
perf: ship Phase 1 sync I/O migration

perf-baseline: governance-evaluate 1800 to 420 (Phase 1: async git subprocesses)
perf-baseline: task-pipeline-create 95 to 60 (Phase 1: governance no longer blocks pipeline)
```

4. Push. The pre-push gate validates the trailer; missing or short rationale (<20 chars) blocks the push.

## Bypass

`PERF_GATE_BYPASS=1 git push` allows a push despite a perf regression. Logged to `server/perf/bypass-audit.log`. Use only during incident response.

## Variance and stability

Run timings on the user's `torque-remote` workstation are the canonical baseline. Local runs work but produce a `NOTICE: ... advisory mode` banner when the host_label differs from the baseline; in advisory mode the gate does not block.

## Adding a metric

1. Create `server/perf/metrics/<slug>.js` exporting the metric module contract (see `metrics/_template.md`).
2. Register in `server/perf/metrics/all.js`.
3. Add a unit test under `server/tests/perf-metric-<slug>.test.js`.
4. Run `npm run perf` and confirm it appears in the output.
5. Capture a baseline entry: `node perf/run-perf.js --update-baseline`, commit with a `perf-baseline:` trailer documenting the new addition.
````

- [ ] **Step 2: Run the full harness end-to-end one more time**

From the worktree's `server/` directory: `node perf/run-perf.js`

Expected: 13 metrics measured, no regressions vs baseline (since baseline was just captured), `wrote .../last-run.json`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/perf/README.md
git commit -m "perf(docs): README documenting metric set, run protocol, baseline update, bypass"
```

---

## Task 25: Final verification — push, gate, cutover

**Files:** none (verification only)

- [ ] **Step 1: Push the feature branch (NOT main)**

From the worktree:

```bash
git push -u origin feat/perf-0-baseline
```

Expected: push succeeds; non-main branches skip the full gate.

- [ ] **Step 2: Run the full test suite via torque-remote**

```bash
torque-remote --branch feat/perf-0-baseline npx vitest run --config vitest.config.js
```

Expected: all suites pass, including the new perf-* tests.

- [ ] **Step 3: Cutover**

From the repo root (NOT the worktree):

```bash
scripts/worktree-cutover.sh perf-0-baseline
```

Expected: feat/perf-0-baseline merges to main; queue drains; restart barrier completes; perf gate runs as part of the merge push and passes (since baseline equals current); worktree is removed.

- [ ] **Step 4: Verify perf gate is live**

After cutover, confirm the gate is wired by inspecting `.git/hooks/pre-push` (or whatever the hook installer points at). The hook should reference `perf/run-perf.js` and `scripts/perf-baseline-trailer.js`.

- [ ] **Step 5: Update umbrella's child-spec index**

In a fresh worktree (or a quick docs-only worktree), edit `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` Section 6:

```
| 0 — Baseline + gate | (umbrella §2) | shipped | <cutover-commit-sha> |
```

Replace `<cutover-commit-sha>` with the actual cutover commit hash from Step 3. Commit and merge. (Docs-only change per CLAUDE.md — deliberate merge, no restart barrier required.)

- [ ] **Step 6: Phase 0 closure check**

Verify:

- All 13 metrics live and measured.
- baseline.json committed.
- Pre-push gate runs perf step on main-targeted pushes.
- Trailer validator enforced.
- README documents the protocol.
- Bypass mechanism (`PERF_GATE_BYPASS=1`) works and logs to audit.
- Umbrella index updated to `shipped`.

If all checks pass, Phase 0 is closed. Phase 1 (sync I/O) and Phase 4 (test infra) can begin per the umbrella's §5.2 schedule.

---

## Self-review checklist

Run through these before declaring the plan complete:

- **Spec coverage:** Each deliverable in umbrella §2.5 has a task that produces it. ✓ (Tasks 1-3 = harness; 5-17 = 13 metrics; 18 = reporter; 19 = update-baseline; 21 = baseline.json; 22 = trailer validator; 23 = pre-push; 24 = README; .gitignore updated in Task 1.)
- **Placeholder scan:** No "TBD" or "implement later" in step bodies. NOTE blocks in Tasks 8, 10, 11, 14, 17 flag adjustments-on-encounter (factory wrapper signature, eventbus shape, etc.) — these are explicit "read first, then implement" prompts with the goal stated, not placeholders.
- **Type consistency:** Metric module contract (`id`, `name`, `category`, `units`, `warmup`, `runs`, `variants`, `run`) used identically across all 13 metric tasks. Driver result shape (`median`, `p95`, `runs`, `byVariant`) consistent in Tasks 3, 18, 19.
- **Test coverage:** Every implementation task has a paired test task and explicit fail-then-pass cycle. The `--update-baseline` flow has its own test. The trailer validator has 5 test cases covering edge cases.

