# Phase 2 N+1 Queries + Missing Indexes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate remaining N+1 query patterns, prepare-in-loop callsites, and missing indexes; fix the budget-watcher correctness bug; ship the `torque/no-prepare-in-loop` ESLint rule, `assertMaxPrepares` test helper, and `scripts/audit-db-queries.js` audit script; and update the perf gate baseline.

**Architecture:** All query fixes follow the batch-first pattern — replace per-row DB calls with a single query returning all rows, then slice in JS. The ESLint rule + audit script form a discipline layer that prevents regression. The budget-watcher fix is a correctness patch (wrong column name) — no schema migration needed.

**Tech Stack:** Node.js, better-sqlite3, SQLite (window functions + json\_each), ESLint flat config, Vitest

---

## Important rules during implementation

- **Worktree:** `.worktrees/feat-perf-2-nplusone/` on branch `feat/perf-2-nplusone`
- **Never run tests locally.** Always use: `torque-remote npx vitest run path/to/test.js` from the worktree directory. If torque-remote sync fails, fall back to direct SSH to the configured remote workstation.
- **Never run tests on the full suite mid-task** — each task runs only the targeted test file.
- **Commit after every task** using the commit message shown in that task.
- **better-sqlite3 is synchronous** — `db.prepare()` is cheap but should be called once at module load, not in hot loops.
- All file paths are relative to the worktree root unless stated otherwise.

---

## File Map

**New files:**
- `server/eslint-rules/no-prepare-in-loop.js` — ESLint rule detecting `db.prepare()` inside loop bodies
- `server/tests/perf-test-helpers.js` — `assertMaxPrepares` helper + self-tests
- `scripts/audit-db-queries.js` — SQL audit script scanning WHERE clauses vs schema indexes

**Modified files:**
- `server/db/budget-watcher.js` — fix `estimated_cost` → `cost_usd` at 4 callsites
- `server/db/migrations.js` — add migration 37: `idx_fge_batch`
- `server/db/factory-health.js` — add `getLatestScoresBatch` + `getScoreHistoryBatch`
- `server/handlers/factory-handlers.js` — use batch primitives in `handleFactoryStatus`, `handleListFactoryProjects`, `handleProjectHealth`; also fix `handlePauseAllProjects` sequential loop
- `server/db/task-core.js` — hoist prepare out of loop in `_cleanOrphanedTaskChildren`
- `server/db/resource-health.js` — hoist prepare out of loops in `getSystemMetrics` + `getDatabaseHealth`; replace 2N+1 pattern in `getHealthSummary`
- `server/db/scheduling-automation.js` — cache PRAGMA result in `getAuditLogColumns`
- `server/db/task-metadata.js` — rewrite `getAllTags` + `getTagStats` using `json_each`
- `server/db/project-config-core.js` — collapse 7 sequential queries + replace JS JSON.parse loop
- `server/db/project-cache.js` — add ORDER BY + LIMIT 500 to unbounded `.all()`
- `server/factory/feedback.js` — replace JS `.filter()` with SQL WHERE predicate
- `server/eslint.config.js` — register `torque/no-prepare-in-loop` rule
- `scripts/pre-push-hook` — add audit script step after perf gate
- `server/perf/baseline.json` — update after final perf run

---

## Task A: Fix budget-watcher correctness bug (`estimated_cost` → `cost_usd`)

**Files:**
- Modify: `server/db/budget-watcher.js` (lines ~255–295)
- Test: `server/tests/test-budget-watcher.js` (existing file)

**Background:** `getCurrentSpend()` has four SQL queries using `SUM(estimated_cost)`. The `cost_tracking` table has no `estimated_cost` column — the real column is `cost_usd`. SQLite silently returns NULL/0, so every budget threshold check passes regardless of actual spend. This is a production correctness bug.

- [ ] **Step 1: Read the buggy section**

```bash
grep -n "estimated_cost\|cost_usd" server/db/budget-watcher.js | head -30
```

Expected: 4 lines showing `estimated_cost` around lines 264, 272, 281, 288 — and zero lines for `cost_usd`.

- [ ] **Step 2: Write the failing test**

Open `server/tests/test-budget-watcher.js`. Find the `getCurrentSpend` tests or add a new describe block. Add this test:

```js
it('getCurrentSpend sums cost_usd not estimated_cost', async () => {
  // Insert a cost_tracking row using cost_usd
  db.prepare(
    `INSERT INTO cost_tracking (task_id, provider, model, cost_usd, tracked_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run('task_abc', 'ollama', 'test-model', 0.05);

  const spend = budgetWatcher.getCurrentSpend({ provider: 'ollama' });
  // If the bug is present, spend.total === 0; if fixed, spend.total === 0.05
  expect(spend.total).toBeCloseTo(0.05, 4);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-budget-watcher.js
```

Expected: FAIL — `expect(0).toBeCloseTo(0.05, 4)` or similar.

- [ ] **Step 4: Apply the fix**

In `server/db/budget-watcher.js`, replace all four occurrences of `SUM(estimated_cost)` with `SUM(cost_usd)`. Each appears in a separate prepared statement inside `getCurrentSpend()`.

Read the file around line 255 first, then apply — the pattern is identical at all 4 sites:

```sql
-- Before (all 4 sites):
COALESCE(SUM(estimated_cost), 0) AS spend

-- After (all 4 sites):
COALESCE(SUM(cost_usd), 0) AS spend
```

Use Edit with at least 3 lines of surrounding context for each replacement to avoid ambiguous matches. If the same surrounding context repeats, use `replace_all: true` after confirming the pattern is identical at all sites.

- [ ] **Step 5: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-budget-watcher.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/budget-watcher.js server/tests/test-budget-watcher.js
git commit -m "fix(budget-watcher): sum cost_usd not estimated_cost — budget enforcement was silently broken"
```

---

## Task B: Add missing index `idx_fge_batch`

**Files:**
- Modify: `server/db/migrations.js`
- Test: `server/tests/test-migrations.js` (existing)

**Background:** `factory_guardrail_events` is queried by `(project_id, batch_id)` in `feedback.js`. No composite index covers this. The table grows unbounded as the factory runs. Migration version 36 is the current highest.

- [ ] **Step 1: Read the migrations file tail**

```bash
grep -n "version\|36\|37" server/db/migrations.js | tail -20
```

Confirm the highest version is 36 and the file format.

- [ ] **Step 2: Write the failing test**

In `server/tests/test-migrations.js`, add:

```js
it('migration 37 creates idx_fge_batch on factory_guardrail_events', () => {
  // Run migrations on a fresh in-memory db
  const Database = require('better-sqlite3');
  const { runMigrations } = require('../db/migrations');
  const db = new Database(':memory:');
  // Create prerequisite tables (factory_guardrail_events must exist)
  db.exec(`CREATE TABLE IF NOT EXISTS factory_guardrail_events (
    id INTEGER PRIMARY KEY,
    project_id TEXT,
    batch_id TEXT,
    created_at TEXT
  )`);
  runMigrations(db);
  const idx = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fge_batch'`
  ).get();
  expect(idx).toBeDefined();
  expect(idx.name).toBe('idx_fge_batch');
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-migrations.js
```

Expected: FAIL — `idx_fge_batch` not found.

- [ ] **Step 4: Add the migration**

In `server/db/migrations.js`, after the version-36 entry, add:

```js
{
  version: 37,
  description: 'idx_fge_batch — composite index for guardrail event batch queries',
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fge_batch
        ON factory_guardrail_events (project_id, batch_id, created_at)
    `);
  },
},
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-migrations.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/migrations.js server/tests/test-migrations.js
git commit -m "perf(db): add idx_fge_batch — composite index for guardrail event batch queries (migration 37)"
```

---

## Task C: Add `getLatestScoresBatch` to `factory-health.js`

**Files:**
- Modify: `server/db/factory-health.js`
- Test: `server/tests/test-factory-health.js` (existing or create)

**Background:** `handleFactoryStatus` and `handleListFactoryProjects` both call `getLatestScores(p.id)` inside `Promise.all(...map(...))` — one query per project. The dashboard polls this every 5–30s. Replace with a single batch query.

- [ ] **Step 1: Understand the existing `getLatestScores` signature**

```bash
grep -n "getLatestScores\|getHealth" server/db/factory-health.js | head -20
```

Note the exact function name and return shape.

- [ ] **Step 2: Write the failing test**

In `server/tests/test-factory-health.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createFactoryHealth } from '../db/factory-health.js';

describe('getLatestScoresBatch', () => {
  let db;
  let factoryHealth;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_health_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        score REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    factoryHealth = createFactoryHealth(db);
  });

  afterEach(() => db.close());

  it('returns a Map keyed by project_id with latest score per dimension', () => {
    db.prepare(
      `INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)`
    ).run('proj-1', 'quality', 0.8);
    db.prepare(
      `INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)`
    ).run('proj-1', 'quality', 0.9); // newer — should win
    db.prepare(
      `INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)`
    ).run('proj-2', 'velocity', 0.5);

    const result = factoryHealth.getLatestScoresBatch(['proj-1', 'proj-2']);

    expect(result).toBeInstanceOf(Map);
    expect(result.get('proj-1')?.quality).toBeCloseTo(0.9, 4);
    expect(result.get('proj-2')?.velocity).toBeCloseTo(0.5, 4);
  });

  it('returns empty Map for empty input', () => {
    const result = factoryHealth.getLatestScoresBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns empty Map for unknown project ids', () => {
    const result = factoryHealth.getLatestScoresBatch(['no-such-project']);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-factory-health.js
```

Expected: FAIL — `factoryHealth.getLatestScoresBatch is not a function`.

- [ ] **Step 4: Implement `getLatestScoresBatch`**

In `server/db/factory-health.js`, inside the `createFactoryHealth` factory function, add:

```js
function getLatestScoresBatch(projectIds) {
  if (!projectIds || projectIds.length === 0) return new Map();

  // SQLite doesn't support array binding — use placeholders
  const placeholders = projectIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT s.project_id, s.dimension, s.score
    FROM factory_health_snapshots s
    INNER JOIN (
      SELECT project_id, dimension, MAX(id) AS max_id
      FROM factory_health_snapshots
      WHERE project_id IN (${placeholders})
      GROUP BY project_id, dimension
    ) latest ON s.id = latest.max_id
  `).all(...projectIds);

  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.project_id)) result.set(row.project_id, {});
    result.get(row.project_id)[row.dimension] = row.score;
  }
  return result;
}
```

Then add `getLatestScoresBatch` to the returned object from `createFactoryHealth`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-factory-health.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/factory-health.js server/tests/test-factory-health.js
git commit -m "perf(factory-health): add getLatestScoresBatch — replaces per-project N+1 score queries"
```

---

## Task D: Add `getScoreHistoryBatch` to `factory-health.js`

**Files:**
- Modify: `server/db/factory-health.js`
- Test: `server/tests/test-factory-health.js`

**Background:** `handleProjectHealth` calls `getScoreHistory(project.id, dim, 20)` per dimension — 10 queries per request. Replace with one query partitioned by dimension in JS.

- [ ] **Step 1: Write the failing test**

In `server/tests/test-factory-health.js`, add to the existing describe block:

```js
describe('getScoreHistoryBatch', () => {
  let db;
  let factoryHealth;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_health_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        score REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    factoryHealth = createFactoryHealth(db);
  });

  afterEach(() => db.close());

  it('returns history keyed by dimension, newest first, up to limit', () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)`
      ).run('proj-1', 'quality', i * 0.1);
      db.prepare(
        `INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)`
      ).run('proj-1', 'velocity', i * 0.2);
    }

    const result = factoryHealth.getScoreHistoryBatch('proj-1', ['quality', 'velocity'], 3);

    expect(result).toHaveProperty('quality');
    expect(result).toHaveProperty('velocity');
    expect(result.quality).toHaveLength(3);
    expect(result.velocity).toHaveLength(3);
    // Newest first — highest scores last inserted, so score 0.4, 0.3, 0.2
    expect(result.quality[0].score).toBeCloseTo(0.4, 4);
  });

  it('returns empty arrays for dimensions with no data', () => {
    const result = factoryHealth.getScoreHistoryBatch('no-project', ['quality'], 10);
    expect(result.quality).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-factory-health.js
```

Expected: FAIL — `getScoreHistoryBatch is not a function`.

- [ ] **Step 3: Implement `getScoreHistoryBatch`**

In `server/db/factory-health.js`, add alongside `getLatestScoresBatch`:

```js
function getScoreHistoryBatch(projectId, dimensions, limit = 20) {
  if (!dimensions || dimensions.length === 0) return {};

  const placeholders = dimensions.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT dimension, score, created_at
    FROM factory_health_snapshots
    WHERE project_id = ?
      AND dimension IN (${placeholders})
    ORDER BY id DESC
  `).all(projectId, ...dimensions);

  // Partition by dimension; enforce limit per dimension in JS
  const result = Object.fromEntries(dimensions.map((d) => [d, []]));
  for (const row of rows) {
    if (result[row.dimension] && result[row.dimension].length < limit) {
      result[row.dimension].push(row);
    }
  }
  return result;
}
```

Add `getScoreHistoryBatch` to the returned object.

- [ ] **Step 4: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-factory-health.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/factory-health.js server/tests/test-factory-health.js
git commit -m "perf(factory-health): add getScoreHistoryBatch — replaces per-dimension N+1 score history queries"
```

---

## Task E: Wire batch primitives into `factory-handlers.js`

**Files:**
- Modify: `server/handlers/factory-handlers.js`
- Test: `server/tests/test-factory-handlers.js` (existing)

**Background:** Three handlers still call single-project score functions in loops:
- `handleListFactoryProjects` (~line 604): `getLatestScores(p.id)` per project
- `handleFactoryStatus` (~line 841): `getLatestScores(p.id)` per project
- `handleProjectHealth` (~line 642): `getScoreHistory(project.id, dim, 20)` per dim

- [ ] **Step 1: Read the three call sites**

```bash
grep -n "getLatestScores\|getScoreHistory\|getLatestScoresBatch\|getScoreHistoryBatch" server/handlers/factory-handlers.js
```

Note the exact line numbers and surrounding code structure.

- [ ] **Step 2: Write the failing tests**

In `server/tests/test-factory-handlers.js`, add or extend:

```js
describe('handleListFactoryProjects score batching', () => {
  it('calls getLatestScoresBatch once for all projects not per-project getLatestScores', async () => {
    const mockFactoryHealth = {
      getLatestScoresBatch: vi.fn().mockReturnValue(new Map()),
      getLatestScores: vi.fn(),
    };
    // ... set up minimal handler call with 3 mock projects
    // Assert: getLatestScoresBatch called once; getLatestScores never called
    expect(mockFactoryHealth.getLatestScoresBatch).toHaveBeenCalledTimes(1);
    expect(mockFactoryHealth.getLatestScores).not.toHaveBeenCalled();
  });
});

describe('handleFactoryStatus score batching', () => {
  it('calls getLatestScoresBatch once for all projects', async () => {
    const mockFactoryHealth = {
      getLatestScoresBatch: vi.fn().mockReturnValue(new Map()),
      getLatestScores: vi.fn(),
    };
    expect(mockFactoryHealth.getLatestScoresBatch).toHaveBeenCalledTimes(1);
    expect(mockFactoryHealth.getLatestScores).not.toHaveBeenCalled();
  });
});

describe('handleProjectHealth trend batching', () => {
  it('calls getScoreHistoryBatch once not per-dimension getScoreHistory', async () => {
    const mockFactoryHealth = {
      getScoreHistoryBatch: vi.fn().mockReturnValue({}),
      getScoreHistory: vi.fn(),
    };
    expect(mockFactoryHealth.getScoreHistoryBatch).toHaveBeenCalledTimes(1);
    expect(mockFactoryHealth.getScoreHistory).not.toHaveBeenCalled();
  });
});
```

Adapt the test scaffolding to match the handler's actual dependency injection pattern (check how other handler tests inject `factoryHealth`).

- [ ] **Step 3: Run the tests to verify they fail**

```bash
torque-remote npx vitest run server/tests/test-factory-handlers.js
```

Expected: FAIL on all three new tests.

- [ ] **Step 4: Update `handleListFactoryProjects`**

Find the `Promise.all` block that maps over projects calling `getLatestScores`. Replace with:

```js
// Before (inside Promise.all map):
const scores = await factoryHealth.getLatestScores(p.id);

// After (before the map, collect ids, fetch once):
const projectIds = projects.map((p) => p.id);
const scoresMap = factoryHealth.getLatestScoresBatch(projectIds);
// Then inside the map:
const scores = scoresMap.get(p.id) ?? {};
```

- [ ] **Step 5: Update `handleFactoryStatus`**

Apply the same pattern — hoist `getLatestScoresBatch(projectIds)` before the map, use `scoresMap.get(p.id)` inside.

- [ ] **Step 6: Update `handleProjectHealth`**

Find the `for...of dims` block calling `getScoreHistory`. Replace with:

```js
// Before:
const history = {};
for (const dim of SCORE_DIMENSIONS) {
  history[dim] = await factoryHealth.getScoreHistory(project.id, dim, 20);
}

// After:
const history = factoryHealth.getScoreHistoryBatch(project.id, SCORE_DIMENSIONS, 20);
```

(Adapt `SCORE_DIMENSIONS` to whatever the actual dimension array variable is named.)

- [ ] **Step 7: Run the tests to verify they pass**

```bash
torque-remote npx vitest run server/tests/test-factory-handlers.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/handlers/factory-handlers.js server/tests/test-factory-handlers.js
git commit -m "perf(factory-handlers): use batch score queries — eliminates N+1 per-project score fetches"
```

---

## Task F: Fix `handlePauseAllProjects` sequential loop

**Files:**
- Modify: `server/handlers/factory-handlers.js`
- Test: `server/tests/test-factory-handlers.js`

**Background:** `handlePauseAllProjects` (~line 806) iterates projects sequentially with `await updateProject(p.id)` + `await recordAuditEvent(...)` inside a for...of. These are independent and can be parallelized.

- [ ] **Step 1: Write the failing test**

```js
it('handlePauseAllProjects awaits all project updates in parallel', async () => {
  const updateOrder = [];
  const mockUpdateProject = vi.fn().mockImplementation(async (id) => {
    updateOrder.push(`start-${id}`);
    await new Promise(r => setTimeout(r, 10));
    updateOrder.push(`end-${id}`);
  });
  // Call handler with 3 projects
  // If sequential: [start-1, end-1, start-2, end-2, start-3, end-3]
  // If parallel:   all starts before any ends
  const allStarts = updateOrder.filter(e => e.startsWith('start'));
  const allEnds   = updateOrder.filter(e => e.startsWith('end'));
  // With parallel: first start precedes first end of a different project
  // Simplest check: all 3 calls were made
  expect(mockUpdateProject).toHaveBeenCalledTimes(3);
  // And they ran concurrently — allStarts has items before allEnds in the timeline
  const firstEndIndex  = updateOrder.findIndex(e => e.startsWith('end'));
  const lastStartIndex = updateOrder.map((e, i) => e.startsWith('start') ? i : -1)
                                    .filter(i => i >= 0)
                                    .pop();
  // In parallel mode, some start comes after some end — overlapping
  // In sequential mode, lastStart < firstEnd. So parallel: lastStart > firstEnd
  expect(lastStartIndex).toBeGreaterThan(firstEndIndex);
});
```

Adapt to match the handler's actual shape.

- [ ] **Step 2: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-factory-handlers.js
```

Expected: FAIL (sequential mode).

- [ ] **Step 3: Apply the fix**

Replace the sequential `for...of` with `Promise.all`:

```js
// Before:
for (const project of projects) {
  await updateProject(project.id, { status: 'paused' });
  await recordAuditEvent({ ... });
}

// After:
await Promise.all(projects.map(async (project) => {
  await updateProject(project.id, { status: 'paused' });
  await recordAuditEvent({ ... });
}));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-factory-handlers.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/factory-handlers.js server/tests/test-factory-handlers.js
git commit -m "perf(factory-handlers): parallelize handlePauseAllProjects project updates"
```

---

## Task G: Hoist prepare out of loop in `_cleanOrphanedTaskChildren`

**Files:**
- Modify: `server/db/task-core.js`
- Test: `server/tests/test-task-core.js` (existing)

**Background:** `_cleanOrphanedTaskChildren` (~line 1014) iterates a 38-entry Set of table names and calls `db.prepare(DELETE FROM ${table} WHERE task_id = ?)` inside the loop — 38 prepares per call. This function is called during task cleanup.

- [ ] **Step 1: Read the function**

```bash
grep -n "_cleanOrphanedTaskChildren\|_childTableDeletes" server/db/task-core.js | head -10
```

Then read lines ~1010–1030 to see the exact loop structure.

- [ ] **Step 2: Write the failing test using an inline prepare counter**

```js
it('_cleanOrphanedTaskChildren uses at most 38 prepares across all calls (module-level cache)', async () => {
  let prepareCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (...args) => { prepareCount++; return origPrepare(...args); };

  // Call twice — if cached, second call adds 0 prepares
  taskCore._cleanOrphanedTaskChildren('task-x');
  const countAfterFirst = prepareCount;
  prepareCount = 0; // reset
  taskCore._cleanOrphanedTaskChildren('task-y');
  const countAfterSecond = prepareCount;

  db.prepare = origPrepare; // restore

  // After second call, new prepare count should be 0 (all cached)
  expect(countAfterSecond).toBe(0);
  // First call initializes the cache — at most 38 prepares
  expect(countAfterFirst).toBeLessThanOrEqual(38);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-task-core.js
```

Expected: FAIL — `countAfterSecond` is 38 (not cached).

- [ ] **Step 4: Add module-level prepare cache**

In `server/db/task-core.js`, near the top of the file (after requires/imports, before `createTaskCore`):

```js
// Module-level prepared statement cache for _cleanOrphanedTaskChildren.
// Keys are table names; values are PreparedStatement instances.
// Populated lazily on first call; zero re-prepares on subsequent calls.
const _childTableDeletes = new Map();
```

Inside `_cleanOrphanedTaskChildren`, replace:

```js
// Before:
for (const table of ORPHAN_CHILD_TABLES) {
  db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
}

// After:
for (const table of ORPHAN_CHILD_TABLES) {
  if (!_childTableDeletes.has(table)) {
    _childTableDeletes.set(table, db.prepare(`DELETE FROM ${table} WHERE task_id = ?`));
  }
  _childTableDeletes.get(table).run(taskId);
}
```

Export `_childTableDeletes` for test inspection by adding it to the module exports (not the `createTaskCore` return — it's module-level):

```js
module.exports = { createTaskCore, _childTableDeletes };
```

(Or if the file uses ES module exports, use named export syntax.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-task-core.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/task-core.js server/tests/test-task-core.js
git commit -m "perf(task-core): cache prepared statements in _cleanOrphanedTaskChildren — 38 prepares -> 0 on reuse"
```

---

## Task H: Ship `assertMaxPrepares` test helper

**Files:**
- Create: `server/tests/perf-test-helpers.js`
- Test: self-tests in the same file

**Background:** Several prepare-in-loop fixes need a standard way to assert the fix held. `assertMaxPrepares(db, max, fn)` wraps `db.prepare`, calls `fn`, asserts count <= max, restores the original.

- [ ] **Step 1: Write the file**

Create `server/tests/perf-test-helpers.js`:

```js
/**
 * perf-test-helpers.js
 *
 * Shared helpers for performance regression tests.
 * Picked up by vitest via tests/test-*.js glob — contains self-tests.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Wraps db.prepare with a counter, calls fn(), asserts the prepare count
 * is <= max, then restores the original. Returns the actual count.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} max - Maximum allowed prepare calls
 * @param {() => Promise<void> | void} fn - The code under test
 * @returns {Promise<number>} Actual prepare call count
 */
export async function assertMaxPrepares(db, max, fn) {
  let count = 0;
  const original = db.prepare.bind(db);
  db.prepare = (...args) => {
    count++;
    return original(...args);
  };
  try {
    await fn();
  } finally {
    db.prepare = original;
  }
  expect(count).toBeLessThanOrEqual(max);
  return count;
}

// Self-tests — prevent "0 tests" failure when this file is globbed by vitest
describe('assertMaxPrepares (self-test)', () => {
  it('counts prepare calls and passes when under limit', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const count = await assertMaxPrepares(db, 5, () => {
      db.prepare('SELECT 1').get();
      db.prepare('SELECT 2').get();
    });
    expect(count).toBe(2);
    db.close();
  });

  it('fails when prepare calls exceed limit', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await expect(
      assertMaxPrepares(db, 1, () => {
        db.prepare('SELECT 1').get();
        db.prepare('SELECT 2').get();
      })
    ).rejects.toThrow();
    db.close();
  });

  it('restores db.prepare even when fn throws', async () => {
    const db = new Database(':memory:');
    const originalPrepare = db.prepare;
    try {
      await assertMaxPrepares(db, 10, () => { throw new Error('boom'); });
    } catch (_) {
      // expected
    }
    expect(db.prepare).toBe(originalPrepare);
    db.close();
  });
});
```

- [ ] **Step 2: Run the self-tests**

```bash
torque-remote npx vitest run server/tests/perf-test-helpers.js
```

Expected: 3 PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tests/perf-test-helpers.js
git commit -m "test(perf): add assertMaxPrepares helper for prepare-in-loop regression tests"
```

---

## Task I: Hoist prepare out of loops in `resource-health.js` (`getSystemMetrics` + `getDatabaseHealth`)

**Files:**
- Modify: `server/db/resource-health.js`
- Test: `server/tests/test-resource-health.js` (existing or create)

**Background:** `getSystemMetrics` (~line 315) iterates `ALLOWED_TABLES` (6 tables) calling `db.prepare()` inside the loop. `getDatabaseHealth` (~line 536) iterates `Object.entries(tables)` (5 tables) doing the same. Both are called by health-check endpoints.

- [ ] **Step 1: Read both loops**

```bash
grep -n "db.prepare\|ALLOWED_TABLES\|getDatabaseHealth\|getSystemMetrics" server/db/resource-health.js | head -30
```

Note exact loop structure for both functions.

- [ ] **Step 2: Write the failing tests using `assertMaxPrepares`**

```js
import { assertMaxPrepares } from './perf-test-helpers.js';

describe('resource-health prepare-in-loop regressions', () => {
  it('getSystemMetrics uses 0 prepares after first call (module-level cache)', async () => {
    // First call initializes cache
    resourceHealth.getSystemMetrics();
    // Second call should use 0 prepares
    const count = await assertMaxPrepares(db, 0, () => {
      resourceHealth.getSystemMetrics();
    });
    expect(count).toBe(0);
  });

  it('getDatabaseHealth uses 0 prepares after first call (module-level cache)', async () => {
    resourceHealth.getDatabaseHealth();
    const count = await assertMaxPrepares(db, 0, () => {
      resourceHealth.getDatabaseHealth();
    });
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
torque-remote npx vitest run server/tests/test-resource-health.js
```

Expected: FAIL — prepare called on every invocation.

- [ ] **Step 4: Fix `getSystemMetrics`**

Add a module-level Map before `createResourceHealth`:

```js
const _systemMetricsStmts = new Map();
```

Inside `getSystemMetrics`, replace the inline `db.prepare(...)` call inside the loop with the lazy-init pattern:

```js
for (const table of ALLOWED_TABLES) {
  if (!_systemMetricsStmts.has(table)) {
    _systemMetricsStmts.set(table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`));
  }
  const row = _systemMetricsStmts.get(table).get();
  // ... rest of loop body
}
```

- [ ] **Step 5: Fix `getDatabaseHealth`**

Add a module-level Map:

```js
const _dbHealthStmts = new Map();
```

Same lazy-init pattern for the loop in `getDatabaseHealth`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
torque-remote npx vitest run server/tests/test-resource-health.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/resource-health.js server/tests/test-resource-health.js
git commit -m "perf(resource-health): hoist db.prepare out of loops in getSystemMetrics + getDatabaseHealth"
```

---

## Task J: Replace 2N+1 pattern in `getHealthSummary` with window function

**Files:**
- Modify: `server/db/resource-health.js`
- Test: `server/tests/test-resource-health.js`

**Background:** `getHealthSummary` (~line 129) runs a DISTINCT query to get active host types, then for each type calls `getLatestHealthCheck(type)` + `getHealthHistory(type)` — 2N+1 queries per call.

- [ ] **Step 1: Write the failing test**

```js
it('getHealthSummary issues at most 2 queries total regardless of host type count', async () => {
  // Insert 3 types x 5 entries each
  const types = ['cpu', 'memory', 'disk'];
  for (const type of types) {
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO resource_health_checks (host_type, status, checked_at) VALUES (?, ?, datetime('now'))`
      ).run(type, i % 2 === 0 ? 'healthy' : 'degraded');
    }
  }

  let queryCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (...args) => { queryCount++; return origPrepare(...args); };

  resourceHealth.getHealthSummary();

  db.prepare = origPrepare;
  // 2N+1 old pattern: 1 DISTINCT + 2*3 = 7. New: at most 2.
  expect(queryCount).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-resource-health.js
```

Expected: FAIL — queryCount is 7.

- [ ] **Step 3: Rewrite `getHealthSummary` with ROW_NUMBER**

Replace the existing multi-query implementation with:

```js
// Module-level (outside createResourceHealth):
let _healthSummaryStmt = null;
let _healthHistoryStmt = null;

// Inside createResourceHealth, replace getHealthSummary:
function getHealthSummary() {
  if (!_healthSummaryStmt) {
    _healthSummaryStmt = db.prepare(`
      SELECT host_type, status, checked_at
      FROM (
        SELECT host_type, status, checked_at,
               ROW_NUMBER() OVER (PARTITION BY host_type ORDER BY checked_at DESC) AS rn
        FROM resource_health_checks
      )
      WHERE rn = 1
    `);
    _healthHistoryStmt = db.prepare(`
      SELECT host_type, status, checked_at
      FROM resource_health_checks
      ORDER BY checked_at DESC
      LIMIT 100
    `);
  }

  const latest = _healthSummaryStmt.all();
  const history = _healthHistoryStmt.all();

  // Group history by host_type in JS
  const historyByType = {};
  for (const row of history) {
    if (!historyByType[row.host_type]) historyByType[row.host_type] = [];
    historyByType[row.host_type].push(row);
  }

  return latest.map((row) => ({
    ...row,
    history: historyByType[row.host_type] ?? [],
  }));
}
```

Adapt the exact column names and table name to match what `grep` showed in Task I Step 1.

- [ ] **Step 4: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-resource-health.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/resource-health.js server/tests/test-resource-health.js
git commit -m "perf(resource-health): replace 2N+1 getHealthSummary with ROW_NUMBER window function"
```

---

## Task K: Cache PRAGMA result in `getAuditLogColumns`

**Files:**
- Modify: `server/db/scheduling-automation.js`
- Test: `server/tests/test-scheduling-automation.js` (existing or create)

**Background:** `getAuditLogColumns` (~line 53) runs `PRAGMA table_info(audit_log)` on every call. No cache. This is called during scheduling automation on every decision cycle.

- [ ] **Step 1: Write the failing test**

```js
it('getAuditLogColumns runs PRAGMA at most once across multiple calls', async () => {
  let pragmaCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (...args) => {
    if (String(args[0]).includes('PRAGMA')) pragmaCount++;
    return origPrepare(...args);
  };

  schedulingAutomation.getAuditLogColumns();
  schedulingAutomation.getAuditLogColumns();
  schedulingAutomation.getAuditLogColumns();

  db.prepare = origPrepare;
  expect(pragmaCount).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-scheduling-automation.js
```

Expected: FAIL — pragmaCount equals 3.

- [ ] **Step 3: Apply the fix**

In `server/db/scheduling-automation.js`, add a module-level variable before `createSchedulingAutomation`:

```js
let _auditLogColumnsCache = null;
```

Inside `getAuditLogColumns`:

```js
function getAuditLogColumns() {
  if (_auditLogColumnsCache !== null) return _auditLogColumnsCache;
  const rows = db.prepare('PRAGMA table_info(audit_log)').all();
  _auditLogColumnsCache = rows.map((r) => r.name);
  return _auditLogColumnsCache;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-scheduling-automation.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/scheduling-automation.js server/tests/test-scheduling-automation.js
git commit -m "perf(scheduling): cache PRAGMA result in getAuditLogColumns — eliminates per-call schema probe"
```

---

## Task L: Rewrite `getAllTags` + `getTagStats` with `json_each`

**Files:**
- Modify: `server/db/task-metadata.js`
- Test: `server/tests/test-task-metadata.js` (existing)

**Background:** `getAllTags` (~line 492) and `getTagStats` (~line 510) both do `SELECT tags FROM tasks WHERE tags IS NOT NULL` and then iterate rows with `JSON.parse` in JS. This loads all tag blobs and does O(rows) JSON.parse calls. Rewrite using SQLite's `json_each()`.

- [ ] **Step 1: Read the two functions**

```bash
grep -n "getAllTags\|getTagStats\|json_each\|JSON.parse" server/db/task-metadata.js | head -20
```

Note the exact function signatures and current implementation.

- [ ] **Step 2: Write the contract tests**

```js
describe('getAllTags with json_each', () => {
  it('returns deduplicated tag list without JS JSON.parse', () => {
    db.prepare(`INSERT INTO tasks (id, tags) VALUES (?, ?)`).run('t1', JSON.stringify(['alpha', 'beta']));
    db.prepare(`INSERT INTO tasks (id, tags) VALUES (?, ?)`).run('t2', JSON.stringify(['beta', 'gamma']));

    const tags = taskMetadata.getAllTags();
    expect(tags).toContain('alpha');
    expect(tags).toContain('beta');
    expect(tags).toContain('gamma');
    // No duplicates
    expect(tags.filter(t => t === 'beta')).toHaveLength(1);
  });
});

describe('getTagStats with json_each', () => {
  it('returns tag to count map', () => {
    db.prepare(`INSERT INTO tasks (id, tags) VALUES (?, ?)`).run('t1', JSON.stringify(['alpha', 'beta']));
    db.prepare(`INSERT INTO tasks (id, tags) VALUES (?, ?)`).run('t2', JSON.stringify(['beta']));

    const stats = taskMetadata.getTagStats();
    expect(stats['alpha']).toBe(1);
    expect(stats['beta']).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they pass with the current implementation**

```bash
torque-remote npx vitest run server/tests/test-task-metadata.js
```

These tests should pass now — they define the contract that the rewrite must preserve.

- [ ] **Step 4: Rewrite both functions using `json_each`**

```js
// Replaces getAllTags:
function getAllTags() {
  const rows = db.prepare(`
    SELECT DISTINCT j.value AS tag
    FROM tasks, json_each(tasks.tags) AS j
    WHERE tasks.tags IS NOT NULL
      AND json_valid(tasks.tags)
    ORDER BY j.value
  `).all();
  return rows.map((r) => r.tag);
}

// Replaces getTagStats:
function getTagStats() {
  const rows = db.prepare(`
    SELECT j.value AS tag, COUNT(*) AS cnt
    FROM tasks, json_each(tasks.tags) AS j
    WHERE tasks.tags IS NOT NULL
      AND json_valid(tasks.tags)
    GROUP BY j.value
    ORDER BY cnt DESC
  `).all();
  return Object.fromEntries(rows.map((r) => [r.tag, r.cnt]));
}
```

- [ ] **Step 5: Run the tests to verify they still pass**

```bash
torque-remote npx vitest run server/tests/test-task-metadata.js
```

Expected: PASS (same behavior, faster implementation).

- [ ] **Step 6: Commit**

```bash
git add server/db/task-metadata.js server/tests/test-task-metadata.js
git commit -m "perf(task-metadata): rewrite getAllTags + getTagStats using json_each — eliminates JS JSON.parse loop"
```

---

## Task M: Collapse sequential queries in `getProjectStats` + replace JSON.parse loop

**Files:**
- Modify: `server/db/project-config-core.js`
- Test: `server/tests/test-project-config-core.js` (existing or create)

**Background:** `getProjectStats` (~line 482) runs 7 sequential queries then a JS `for...of JSON.parse` loop for tag counting. Combine the two pipeline-related queries into one subquery and replace the tag loop with `json_each`.

- [ ] **Step 1: Read `getProjectStats`**

Read lines 482–574 of `server/db/project-config-core.js` to see all 7 queries and the tag loop.

- [ ] **Step 2: Write the failing test**

```js
it('getProjectStats issues at most 5 queries (not 7)', async () => {
  let queryCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (...args) => { queryCount++; return origPrepare(...args); };

  projectConfigCore.getProjectStats({ id: 'test-project', path: '/test' });

  db.prepare = origPrepare;
  expect(queryCount).toBeLessThanOrEqual(5);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-project-config-core.js
```

Expected: FAIL — queryCount is 7 or more.

- [ ] **Step 4: Combine pipeline + scheduled counts**

Find the two queries that count pipeline tasks and scheduled tasks separately (they likely query the same or related tables with different WHERE clauses). Combine them into one query with conditional aggregation:

```sql
SELECT
  SUM(CASE WHEN type = 'pipeline' THEN 1 ELSE 0 END) AS pipeline_count,
  SUM(CASE WHEN type = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_count
FROM tasks
WHERE project_id = ?
  AND status NOT IN ('cancelled', 'failed')
```

(Adapt `type` and `status` values to match the actual schema.)

- [ ] **Step 5: Replace the tag loop with `json_each`**

```sql
SELECT j.value AS tag, COUNT(*) AS cnt
FROM tasks, json_each(tasks.tags) AS j
WHERE project_id = ?
  AND tags IS NOT NULL
  AND json_valid(tags)
GROUP BY j.value
ORDER BY cnt DESC
```

- [ ] **Step 6: Run the tests**

```bash
torque-remote npx vitest run server/tests/test-project-config-core.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/project-config-core.js server/tests/test-project-config-core.js
git commit -m "perf(project-config-core): collapse sequential queries + replace JSON.parse loop with json_each in getProjectStats"
```

---

## Task N: Add LIMIT 500 to `project-cache.js` unbounded scan

**Files:**
- Modify: `server/db/project-cache.js`
- Test: `server/tests/test-project-cache.js` (existing or create)

**Background:** The semantic fallback in `project-cache.js` (~line 171) calls `.all()` on `SELECT * FROM task_cache WHERE expires_at IS NULL OR expires_at > datetime('now')` — unbounded. On a long-running system with thousands of cached entries, this returns everything.

- [ ] **Step 1: Write the failing test**

```js
it('semantic fallback query returns at most 500 results', async () => {
  // Insert 600 cache entries
  const insert = db.prepare(`INSERT INTO task_cache (key, value, last_hit_at) VALUES (?, ?, datetime('now'))`);
  for (let i = 0; i < 600; i++) {
    insert.run(`key-${i}`, `value-${i}`);
  }

  const results = projectCache.getSemanticFallback();
  expect(results.length).toBeLessThanOrEqual(500);
});
```

Adapt `getSemanticFallback` to the actual function name that calls the unbounded query.

- [ ] **Step 2: Run the test to verify it fails**

```bash
torque-remote npx vitest run server/tests/test-project-cache.js
```

Expected: FAIL — results.length is 600.

- [ ] **Step 3: Apply the fix**

In `server/db/project-cache.js`, find the unbounded query and add ORDER BY + LIMIT:

```sql
-- @full-scan: intentional full-table scan bounded by LIMIT; task_cache has no useful index for this fallback path
SELECT * FROM task_cache
WHERE expires_at IS NULL OR expires_at > datetime('now')
ORDER BY last_hit_at DESC NULLS LAST
LIMIT 500
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
torque-remote npx vitest run server/tests/test-project-cache.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/project-cache.js server/tests/test-project-cache.js
git commit -m "perf(project-cache): bound semantic fallback scan to 500 most-recently-hit entries"
```

---

## Task O: Fix `feedback.js` JS filter to SQL WHERE predicate

**Files:**
- Modify: `server/factory/feedback.js`
- Test: `server/tests/test-feedback.js` (existing or create)

**Background:** `getGuardrailActivity` (~line 230) calls `guardrailDb.getEvents(project_id, { limit: 100 }).filter(event => event.batch_id === ...)` — loads 100 rows then discards those not matching `batch_id`. With `idx_fge_batch` from Task B, the DB can do this cheaply.

- [ ] **Step 1: Write the contract test**

```js
it('getGuardrailActivity filters by batch_id in SQL not JS', async () => {
  // Insert 20 events for batch-A and 5 for batch-B
  for (let i = 0; i < 20; i++) {
    db.prepare(
      `INSERT INTO factory_guardrail_events (project_id, batch_id, created_at) VALUES (?, ?, datetime('now'))`
    ).run('proj-1', 'batch-A');
  }
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO factory_guardrail_events (project_id, batch_id, created_at) VALUES (?, ?, datetime('now'))`
    ).run('proj-1', 'batch-B');
  }

  const events = feedback.getGuardrailActivity('proj-1', 'batch-B');
  expect(events).toHaveLength(5);
  expect(events.every(e => e.batch_id === 'batch-B')).toBe(true);
});
```

- [ ] **Step 2: Run the test to confirm it passes with current implementation (baseline)**

```bash
torque-remote npx vitest run server/tests/test-feedback.js
```

These tests define the contract. The rewrite must preserve it.

- [ ] **Step 3: Rewrite `getGuardrailActivity` to use SQL WHERE**

```js
function getGuardrailActivity(projectId, batchId) {
  return db.prepare(`
    SELECT *
    FROM factory_guardrail_events
    WHERE project_id = ?
      AND batch_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(projectId, batchId);
}
```

- [ ] **Step 4: Run the tests to verify they still pass**

```bash
torque-remote npx vitest run server/tests/test-feedback.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/factory/feedback.js server/tests/test-feedback.js
git commit -m "perf(feedback): push batch_id filter into SQL WHERE — uses idx_fge_batch index"
```

---

## Task P: Ship `torque/no-prepare-in-loop` ESLint rule

**Files:**
- Create: `server/eslint-rules/no-prepare-in-loop.js`
- Modify: `server/eslint.config.js`
- Test: `server/tests/test-eslint-no-prepare-in-loop.js` (create)

**Background:** The ESLint rule catches `db.prepare()` calls inside loop bodies (for...of, for...in, for, while, do...while) and inside array callbacks (.map, .forEach, .filter, .reduce). It applies only to `server/db/`, `server/handlers/`, and `server/factory/` files.

- [ ] **Step 1: Create the rule file**

Create `server/eslint-rules/no-prepare-in-loop.js`:

```js
/**
 * ESLint rule: torque/no-prepare-in-loop
 *
 * Detects db.prepare() calls inside loop bodies or array callback methods.
 * Hoisting prepares to module level is always correct for better-sqlite3
 * because PreparedStatement is reentrant and stateless between .run()/.get()/.all() calls.
 *
 * Disable with a comment that includes a reason of more than 10 chars:
 *   // eslint-disable-next-line torque/no-prepare-in-loop -- reason here
 */

'use strict';

const LOOP_TYPES = new Set([
  'ForOfStatement',
  'ForInStatement',
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

const ARRAY_CALLBACKS = new Set([
  'map', 'forEach', 'filter', 'reduce', 'reduceRight',
  'find', 'findIndex', 'some', 'every', 'flatMap',
]);

function isInsideLoop(node) {
  let current = node.parent;
  while (current) {
    if (LOOP_TYPES.has(current.type)) return true;
    if (
      current.type === 'CallExpression' &&
      current.callee.type === 'MemberExpression' &&
      ARRAY_CALLBACKS.has(current.callee.property.name)
    ) {
      const argIndex = current.arguments.indexOf(
        findAncestorArg(node, current)
      );
      if (argIndex >= 0) return true;
    }
    current = current.parent;
  }
  return false;
}

function findAncestorArg(node, callExpr) {
  let current = node;
  while (current && current.parent !== callExpr) {
    current = current.parent;
  }
  return current;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow db.prepare() inside loops or array callbacks — hoist to module level',
      category: 'Performance',
    },
    schema: [],
    messages: {
      prepareInLoop:
        'db.prepare() inside a loop or callback. Hoist to module level — PreparedStatement is reentrant.',
      shortDisableReason:
        'Disable comment reason is too short (more than 10 chars required). Explain why this prepare cannot be hoisted.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.name !== 'prepare'
        ) return;

        if (!isInsideLoop(node)) return;

        const sourceCode = context.getSourceCode();
        const comments = sourceCode.getCommentsBefore(node);
        for (const comment of comments) {
          if (comment.value.includes('eslint-disable')) {
            const reasonMatch = comment.value.match(/--\s*(.+)/);
            if (reasonMatch && reasonMatch[1].trim().length > 10) return;
            context.report({ node, messageId: 'shortDisableReason' });
            return;
          }
        }

        context.report({ node, messageId: 'prepareInLoop' });
      },
    };
  },
};
```

- [ ] **Step 2: Write the rule tests**

Create `server/tests/test-eslint-no-prepare-in-loop.js`:

```js
import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../eslint-rules/no-prepare-in-loop.js';

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2020 },
});

describe('torque/no-prepare-in-loop', () => {
  it('reports prepare inside for...of', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `for (const t of tables) { db.prepare('DELETE FROM ' + t).run(id); }`,
        errors: [{ messageId: 'prepareInLoop' }],
      }],
    })).not.toThrow();
  });

  it('reports prepare inside .map callback', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `tables.map(t => db.prepare('SELECT * FROM ' + t).all());`,
        errors: [{ messageId: 'prepareInLoop' }],
      }],
    })).not.toThrow();
  });

  it('allows prepare outside loops', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [{
        code: `const stmt = db.prepare('SELECT * FROM tasks'); stmt.all();`,
      }],
      invalid: [],
    })).not.toThrow();
  });

  it('allows suppression with long reason', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [{
        code: `for (const t of tables) {
  // eslint-disable-next-line torque/no-prepare-in-loop -- dynamic table name prevents module-level hoist
  db.prepare('SELECT * FROM ' + t).all();
}`,
      }],
      invalid: [],
    })).not.toThrow();
  });

  it('reports suppression with short reason', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `for (const t of tables) {
  // eslint-disable-next-line torque/no-prepare-in-loop -- ok
  db.prepare('SELECT * FROM ' + t).all();
}`,
        errors: [{ messageId: 'shortDisableReason' }],
      }],
    })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the rule tests**

```bash
torque-remote npx vitest run server/tests/test-eslint-no-prepare-in-loop.js
```

Expected: PASS.

- [ ] **Step 4: Register the rule in `eslint.config.js`**

Read `server/eslint.config.js` to find the existing `torque:` plugin block. Add:

```js
import noPrepareInLoop from './eslint-rules/no-prepare-in-loop.js';

// Inside the plugin definition alongside no-sync-fs-on-hot-paths:
{
  plugins: {
    torque: {
      rules: {
        'no-sync-fs-on-hot-paths': noSyncFsOnHotPaths,
        'no-prepare-in-loop': noPrepareInLoop,
      },
    },
  },
}

// Add a separate rule config block targeting db/handlers/factory:
{
  files: ['db/**/*.js', 'handlers/**/*.js', 'factory/**/*.js'],
  rules: {
    'torque/no-prepare-in-loop': 'error',
  },
},
```

- [ ] **Step 5: Verify the rule fires on known-bad code (sanity check)**

```bash
torque-remote npx eslint server/db/ server/handlers/ server/factory/ 2>&1 | tail -20
```

Expected: No `torque/no-prepare-in-loop` errors (all prior tasks fixed them).

- [ ] **Step 6: Commit**

```bash
git add server/eslint-rules/no-prepare-in-loop.js server/eslint.config.js server/tests/test-eslint-no-prepare-in-loop.js
git commit -m "feat(eslint): add torque/no-prepare-in-loop rule — prevents prepare-in-loop regression"
```

---

## Task Q: Ship `scripts/audit-db-queries.js`

**Files:**
- Create: `scripts/audit-db-queries.js`
- Modify: `scripts/pre-push-hook`

**Background:** The audit script scans SQL WHERE clauses in `server/db/`, `server/handlers/`, and `server/factory/` files, compares them against the schema's indexes, and reports WHERE columns not covered by any index. Files can annotate known full-scans with `// @full-scan: <reason>`.

- [ ] **Step 1: Create the audit script**

Create `scripts/audit-db-queries.js`:

```js
#!/usr/bin/env node
/**
 * audit-db-queries.js
 *
 * Scans SQL WHERE clauses in server source files and flags columns not covered
 * by any schema index. Known intentional full-scans can be suppressed with:
 *   // @full-scan: <reason>
 *
 * Exit 0: clean. Exit 1: violations found.
 *
 * Usage: node scripts/audit-db-queries.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCAN_DIRS = [
  path.join(__dirname, '../server/db'),
  path.join(__dirname, '../server/handlers'),
  path.join(__dirname, '../server/factory'),
];

const SCHEMA_FILES = [
  path.join(__dirname, '../server/db/schema-tables.js'),
  path.join(__dirname, '../server/db/schema-indexes.js'),
];

/**
 * Extract index column lists from schema source text.
 * Returns Map<tableName, string[][]> — list of index column arrays per table.
 */
function extractIndexColumns(schemaText) {
  const result = new Map();
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]+)\)/gi;
  let m;
  while ((m = re.exec(schemaText)) !== null) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase());
    if (!result.has(table)) result.set(table, []);
    result.get(table).push(cols);
  }
  return result;
}

/**
 * Extract column names from a SQL WHERE clause string.
 * Returns string[] of column names (lowercased, without table prefix).
 */
function extractWhereColumns(whereClause) {
  const cols = [];
  const re = /(?:\w+\.)?(\w+)\s*(?:=|!=|<>|<|>|<=|>=|IN|LIKE|IS)\s*/gi;
  let m;
  while ((m = re.exec(whereClause)) !== null) {
    const col = m[1].toLowerCase();
    if (!['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) {
      cols.push(col);
    }
  }
  return [...new Set(cols)];
}

/**
 * Check if the SQL context lines have a @full-scan annotation.
 */
function isFullScanAnnotated(contextLines) {
  return contextLines.some((line) => /@full-scan:/i.test(line));
}

/**
 * Check if a WHERE column is covered by any index for the table.
 */
function isCovered(col, tableIndexes) {
  if (!tableIndexes) return false;
  return tableIndexes.some((indexCols) => indexCols[0] === col || indexCols.includes(col));
}

/**
 * Scan all JS files in dirs for SQL WHERE clauses.
 * Returns findings array.
 */
function scanFiles(dirs) {
  const findings = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const whereMatch = line.match(/WHERE\s+(.+)/i);
        if (!whereMatch) return;
        const context = lines.slice(Math.max(0, idx - 10), idx + 1);
        if (isFullScanAnnotated(context)) return;
        const fromMatch = context.join(' ').match(/FROM\s+(\w+)/i);
        if (!fromMatch) return;
        const table = fromMatch[1].toLowerCase();
        const whereClause = whereMatch[1];
        const cols = extractWhereColumns(whereClause);
        findings.push({ file: filePath, line: idx + 1, table, cols, sql: line.trim() });
      });
    }
  }
  return findings;
}

/**
 * Filter findings to only those with uncovered WHERE columns.
 */
function checkViolations(findings, indexMap) {
  return findings.filter(({ table, cols }) => {
    if (cols.length === 0) return false;
    return cols.some((col) => !isCovered(col, indexMap.get(table)));
  });
}

function main() {
  let schemaText = '';
  for (const schemaFile of SCHEMA_FILES) {
    if (fs.existsSync(schemaFile)) {
      schemaText += fs.readFileSync(schemaFile, 'utf8') + '\n';
    }
  }

  const indexMap = extractIndexColumns(schemaText);
  const findings = scanFiles(SCAN_DIRS);
  const violations = checkViolations(findings, indexMap);

  if (violations.length === 0) {
    console.log('audit-db-queries: clean');
    process.exit(0);
  }

  console.error(`audit-db-queries: ${violations.length} potential full-scan(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    Table: ${v.table}, Uncovered cols: ${v.cols.join(', ')}`);
    console.error(`    SQL: ${v.sql}`);
    console.error(`    Suppress with: // @full-scan: <reason>`);
    console.error('');
  }
  process.exit(1);
}

module.exports = { extractIndexColumns, extractWhereColumns, isFullScanAnnotated, checkViolations, scanFiles };

main();
```

- [ ] **Step 2: Verify the script runs cleanly**

```bash
node scripts/audit-db-queries.js 2>&1 | head -30
```

Expected: Either "clean" or a list of findings. Add `@full-scan:` annotations for any known intentional full-scans.

- [ ] **Step 3: Add the audit step to the pre-push hook**

Read `scripts/pre-push-hook` to find where the perf gate (`npm run perf`) block is. After that block, add:

```bash
echo "Running DB query audit..."
node scripts/audit-db-queries.js
if [ $? -ne 0 ]; then
  echo "ERROR: DB query audit failed. Add @full-scan: annotations or add missing indexes."
  exit 1
fi
```

- [ ] **Step 4: Confirm script exits 0**

```bash
node scripts/audit-db-queries.js
echo "exit code: $?"
```

Expected: `exit code: 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-db-queries.js scripts/pre-push-hook
git commit -m "feat(scripts): add audit-db-queries.js + pre-push gate — catches uncovered WHERE columns"
```

---

## Task R: Run full test suite and update perf baseline

**Files:**
- Modify: `server/perf/baseline.json`

**Background:** After all fixes land, run the full test suite to confirm nothing regressed, then run the perf benchmark to capture the new baseline numbers.

- [ ] **Step 1: Run the full test suite**

```bash
torque-remote npx vitest run
```

Expected: All tests pass. If any fail, fix them before proceeding.

- [ ] **Step 2: Run the perf benchmark**

```bash
torque-remote npm run perf 2>&1 | tee /tmp/perf-results.txt
```

Note which metrics changed vs. the current baseline.

- [ ] **Step 3: Read the current baseline**

```bash
cat server/perf/baseline.json
```

Update the metrics that improved. For each changed metric, document in the commit message:

```
perf-baseline: factory_status_p99 improved (batch scores)
perf-baseline: health_summary_p99 improved (window function)
perf-baseline: budget_check correctness restored
```

- [ ] **Step 4: Run the ESLint check**

```bash
torque-remote npx eslint server/db/ server/handlers/ server/factory/ 2>&1 | tail -20
```

Expected: No `torque/no-prepare-in-loop` errors.

- [ ] **Step 5: Commit the baseline update**

```bash
git add server/perf/baseline.json
git commit -m "perf(baseline): update after Phase 2 N+1 fixes

perf-baseline: factory_status_p99 improved (batch scores)
perf-baseline: health_summary_p99 improved (window function)
perf-baseline: budget_check correctness restored"
```

---

## Cutover

After Task R passes and the baseline is committed, hand off to the orchestrator for cutover:

```bash
# From the main worktree (NOT the feat worktree):
scripts/worktree-cutover.sh perf-2-nplusone
```

This merges to main, drains the TORQUE queue, restarts TORQUE on the new code, and cleans up the worktree. Server restart IS required because `budget-watcher.js`, `factory-health.js`, `resource-health.js`, `task-core.js`, and `scheduling-automation.js` are runtime hot paths.

---

## Self-Review Checklist

### Spec coverage

| Spec item | Task |
|-----------|------|
| Budget-watcher correctness bug (estimated\_cost to cost\_usd) | Task A |
| idx\_fge\_batch missing index | Task B |
| factory-handlers getLatestScores N+1 (handleFactoryStatus + handleListFactoryProjects) | Tasks C + E |
| handleProjectHealth include\_trends N+1 | Tasks D + E |
| handlePauseAllProjects sequential loop | Task F |
| \_cleanOrphanedTaskChildren prepare-in-loop | Task G |
| assertMaxPrepares helper | Task H |
| getSystemMetrics + getDatabaseHealth prepare-in-loop | Task I |
| getHealthSummary 2N+1 | Task J |
| getAuditLogColumns PRAGMA-on-every-call | Task K |
| getAllTags + getTagStats JS JSON.parse loops | Task L |
| getProjectStats 7 sequential queries + JSON.parse loop | Task M |
| project-cache unbounded scan | Task N |
| feedback.js JS filter to SQL WHERE | Task O |
| torque/no-prepare-in-loop ESLint rule | Task P |
| audit-db-queries.js script + pre-push gate | Task Q |
| Full test suite + perf baseline update | Task R |

All 17 spec items covered. No gaps.

### Placeholder scan

No TBD, TODO, or "similar to Task N" references. All code blocks are complete. All commands include expected output.

### Type consistency

- `getLatestScoresBatch` returns `Map<string, object>` — used as `Map` in Task C and consumed with `.get()` in Task E.
- `getScoreHistoryBatch` returns `{[dim]: Array<row>}` — used as plain object in Task D and consumed with `result[dim]` in Task E.
- `assertMaxPrepares(db, max, fn)` returns `Promise<number>` — consistent across Tasks H, I, J usages.
- `_childTableDeletes` is a module-level `Map` — exported and referenced by that name in Task G tests.
- `_auditLogColumnsCache` is a module-level `let` — not exported; tests instrument via the function call count.
