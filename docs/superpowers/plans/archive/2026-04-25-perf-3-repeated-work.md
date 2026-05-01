# Phase 3 — Repeated Work & Per-Request Allocations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate repeated per-call allocations (Set construction, JSON parsing, PRAGMA queries) that fire on every hot path, add a `listTasks({raw:true})` escape hatch, instrument perf counters in the dashboard, and close the Phase 3 arc with a re-scout and baseline update.

**Architecture:** Module-level constants replace per-call `new Set()` literals; a `Map`-backed cache in `provider-capabilities.js` memoizes capability sets keyed by provider name; PRAGMA results in `budget-watcher.js` and `pack-registry.js` are cached after the first read and invalidated on `setDb()`; `task-core.js` gains an `options.raw` branch that skips `safeJsonParse` for the three JSON columns; a new `operations-perf-counters.js` module tracks call counts; a new `OperationsPerf` tab in the dashboard surfaces them. No ESLint rule is added (umbrella spec §3.3: pattern too varied to lint mechanically).

**Tech Stack:** Node.js (CJS modules), better-sqlite3, React 18 + lazy/Suspense, existing test harness (vitest + fixtures)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `server/execution/provider-router.js` | Hoist `PAID_PROVIDERS` Set to module scope |
| Modify | `server/execution/queue-scheduler.js` | Hoist `GPU_SHARING_PROVIDERS` and `OLLAMA_GPU_PROVIDERS` |
| Modify | `server/db/provider-capabilities.js` | Add `_capabilitySetCache` Map + `getProviderCapabilitySet()` |
| Modify | `server/execution/slot-pull-scheduler.js` | Call `getProviderCapabilitySet()` instead of `new Set(getProviderCapabilities())` |
| Modify | `server/handlers/integration/routing.js` | Same swap in `providerSupportsRepoWriteTasks` |
| Modify | `server/db/budget-watcher.js` | Cache `hasThresholdConfigColumn` result; clear on `setDb()` |
| Modify | `server/db/pack-registry.js` | Cache `getPackRegistryColumnInfo` result; clear on `setDb()` |
| Modify | `server/db/task-core.js` | Add `options.raw` branch skipping `safeJsonParse` for tags/files_modified/context |
| Modify | `server/api/v2-analytics-handlers.js` | Add `raw: true` to the `listTasks` call in the routing decisions handler |
| Create | `server/operations-perf-counters.js` | Lightweight counter module: increment/getSnapshot/reset |
| Modify | `server/api/v2-operations-handlers.js` | Add `/api/v2/operations/perf` GET route wired to counters |
| Modify | `server/db/task-core.js` | Instrument `listTasksParsed` / `listTasksRaw` counters |
| Modify | `server/db/provider-capabilities.js` | Instrument `capabilitySetBuilt` counter |
| Modify | `server/db/budget-watcher.js` | Instrument `pragmaCostBudgets` counter |
| Modify | `server/db/pack-registry.js` | Instrument `pragmaPackRegistry` counter |
| Create | `dashboard/src/views/OperationsPerf.jsx` | React component: fetch + display perf counters table |
| Create | `dashboard/src/views/OperationsPerf.test.jsx` | 3 tests: renders data / loading / error |
| Modify | `dashboard/src/views/OperationsHub.jsx` | Add `perf` tab + lazy OperationsPerf import |
| Modify | `.github/PULL_REQUEST_TEMPLATE.md` | Add Performance review section |
| Modify | `server/perf/baseline.json` | Update raw/parsed divergence after implementation |
| Create | `server/tests/task-core-list-tasks-raw.test.js` | raw option correctness + timing divergence test |
| Create | `server/tests/provider-capabilities-memo.test.js` | 100 calls = 1 Set built; cleared on setDb |
| Create | `server/tests/budget-watcher-pragma-cache.test.js` | 100 calls = 1 PRAGMA; cleared on setDb |
| Create | `server/tests/pack-registry-pragma-cache.test.js` | 100 calls = 1 PRAGMA; cleared on setDb |

---

### Task 1: Hoist invariant Set literals in provider-router.js and queue-scheduler.js (Spec Task A)

**Files:**
- Modify: `server/execution/provider-router.js` (~line 287)
- Modify: `server/execution/queue-scheduler.js` (~lines 438, 841)

- [ ] **Step 1: Write the failing test (provider-router)**

  Create `server/tests/provider-router-paid-providers.test.js`:

  ```js
  'use strict';
  const { resolveProviderRouting } = require('../execution/provider-router');

  // If PAID_PROVIDERS is module-level, the same Set reference is used across calls.
  // We verify it is not re-created per call by checking identity of the export.
  test('PAID_PROVIDERS is a module-level constant (not created per call)', () => {
    const mod = require('../execution/provider-router');
    expect(mod.PAID_PROVIDERS).toBeInstanceOf(Set);
    expect(mod.PAID_PROVIDERS).toBe(mod.PAID_PROVIDERS); // same ref
    expect(mod.PAID_PROVIDERS.has('anthropic')).toBe(true);
    expect(mod.PAID_PROVIDERS.has('groq')).toBe(true);
    expect(mod.PAID_PROVIDERS.has('codex')).toBe(true);
    expect(mod.PAID_PROVIDERS.has('claude-cli')).toBe(true);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd C:/Users/Werem/Projects/torque-public/.worktrees/feat-perf-3-repeated-work
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/provider-router-paid-providers.test.js
  ```
  Expected: FAIL — `mod.PAID_PROVIDERS` is `undefined` (not yet exported).

- [ ] **Step 3: Hoist PAID_PROVIDERS in provider-router.js**

  In `server/execution/provider-router.js`, find (around line 285-290) the function `resolveProviderRouting`.
  Inside it there will be a line like:
  ```js
  const paidProviders = new Set(['anthropic', 'groq', 'codex', 'claude-cli']);
  ```
  Replace it with a reference to a module-level constant. At the top of the file (after the `'use strict';` line and requires), add:
  ```js
  const PAID_PROVIDERS = new Set(['anthropic', 'groq', 'codex', 'claude-cli']);
  ```
  Inside `resolveProviderRouting`, delete the old `const paidProviders = ...` line and replace every use of `paidProviders` with `PAID_PROVIDERS`.
  At the bottom of the file's `module.exports`, add `PAID_PROVIDERS` to the export object.

- [ ] **Step 4: Write the failing tests for queue-scheduler constants**

  Create `server/tests/queue-scheduler-set-constants.test.js`:

  ```js
  'use strict';
  const mod = require('../execution/queue-scheduler');

  test('GPU_SHARING_PROVIDERS is a module-level Set constant', () => {
    expect(mod.GPU_SHARING_PROVIDERS).toBeInstanceOf(Set);
    expect(mod.GPU_SHARING_PROVIDERS.has('ollama')).toBe(true);
  });

  test('OLLAMA_GPU_PROVIDERS is a module-level Set constant', () => {
    expect(mod.OLLAMA_GPU_PROVIDERS).toBeInstanceOf(Set);
    expect(mod.OLLAMA_GPU_PROVIDERS.has('ollama')).toBe(true);
  });
  ```

- [ ] **Step 5: Run test to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/queue-scheduler-set-constants.test.js
  ```
  Expected: FAIL — exports not present yet.

- [ ] **Step 6: Hoist GPU_SHARING_PROVIDERS and OLLAMA_GPU_PROVIDERS in queue-scheduler.js**

  In `server/execution/queue-scheduler.js`:

  Near line 438, inside `createProviderRuntimeState`, find:
  ```js
  const _gpuSharingProviders = new Set(['ollama']);
  ```
  Delete that line. At module scope (after requires), add:
  ```js
  const GPU_SHARING_PROVIDERS = new Set(['ollama']);
  ```
  Replace every reference to `_gpuSharingProviders` in `createProviderRuntimeState` with `GPU_SHARING_PROVIDERS`.

  Near line 841, inside `processQueueInternal`, find:
  ```js
  const _ollamaGpuProviders = new Set(['ollama']);
  ```
  Delete that line. At module scope, add:
  ```js
  const OLLAMA_GPU_PROVIDERS = new Set(['ollama']);
  ```
  Replace every reference to `_ollamaGpuProviders` in `processQueueInternal` with `OLLAMA_GPU_PROVIDERS`.
  Add both `GPU_SHARING_PROVIDERS` and `OLLAMA_GPU_PROVIDERS` to `module.exports`.

- [ ] **Step 7: Run both tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/provider-router-paid-providers.test.js server/tests/queue-scheduler-set-constants.test.js
  ```
  Expected: PASS (2 test files, all tests green).

- [ ] **Step 8: Commit**

  ```bash
  cd C:/Users/Werem/Projects/torque-public/.worktrees/feat-perf-3-repeated-work
  git add server/execution/provider-router.js server/execution/queue-scheduler.js \
        server/tests/provider-router-paid-providers.test.js \
        server/tests/queue-scheduler-set-constants.test.js
  git commit -m "perf(router): hoist PAID_PROVIDERS, GPU_SHARING_PROVIDERS, OLLAMA_GPU_PROVIDERS to module scope"
  ```

---

### Task 2: Capability Set memoization in provider-capabilities.js (Spec Task B)

**Files:**
- Modify: `server/db/provider-capabilities.js`
- Create: `server/tests/provider-capabilities-memo.test.js`

- [ ] **Step 1: Write the failing test**

  Create `server/tests/provider-capabilities-memo.test.js`:

  ```js
  'use strict';

  test('getProviderCapabilitySet returns a Set', () => {
    const { createProviderCapabilities } = require('../db/provider-capabilities');
    const caps = createProviderCapabilities();
    const s = caps.getProviderCapabilitySet('codex');
    expect(s).toBeInstanceOf(Set);
    expect(s.size).toBeGreaterThan(0);
  });

  test('100 calls to getProviderCapabilitySet build the Set exactly once (cache hit)', () => {
    const { createProviderCapabilities } = require('../db/provider-capabilities');
    const caps = createProviderCapabilities();
    let buildCount = 0;
    const orig = caps.getProviderCapabilities.bind(caps);
    caps.getProviderCapabilities = (p) => { buildCount++; return orig(p); };
    for (let i = 0; i < 100; i++) caps.getProviderCapabilitySet('codex');
    // The cache is populated on first call; subsequent 99 calls skip getProviderCapabilities.
    expect(buildCount).toBe(1);
  });

  test('setDb clears the capability set cache', () => {
    const { createProviderCapabilities } = require('../db/provider-capabilities');
    const caps = createProviderCapabilities();
    caps.getProviderCapabilitySet('codex'); // populate cache
    const s1 = caps.getProviderCapabilitySet('codex');
    caps.setDb(null); // clear
    const s2 = caps.getProviderCapabilitySet('codex');
    // After setDb, a new Set is created — different reference
    expect(s1).not.toBe(s2);
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/provider-capabilities-memo.test.js
  ```
  Expected: FAIL — `caps.getProviderCapabilitySet` is not a function.

- [ ] **Step 3: Add memoization to provider-capabilities.js**

  Open `server/db/provider-capabilities.js`. The module currently has `let _db = null` and a `setDb` function.

  After the `let _db = null;` line (around line 28), add:
  ```js
  const _capabilitySetCache = new Map();
  ```

  In `setDb(db)`, after `_db = db;`, add:
  ```js
  _capabilitySetCache.clear();
  ```

  After the existing `meetsCapabilityRequirements` function, add a new exported function:
  ```js
  function getProviderCapabilitySet(provider) {
    if (_capabilitySetCache.has(provider)) return _capabilitySetCache.get(provider);
    const s = new Set(getProviderCapabilities(provider));
    _capabilitySetCache.set(provider, s);
    return s;
  }
  ```

  Add `getProviderCapabilitySet` to the `module.exports` object.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/provider-capabilities-memo.test.js
  ```
  Expected: PASS (3 tests).

- [ ] **Step 5: Update callers to use getProviderCapabilitySet**

  **slot-pull-scheduler.js** (around line 99):
  Find:
  ```js
  const providerCaps = new Set(capabilities.getProviderCapabilities(provider));
  ```
  Replace with:
  ```js
  const providerCaps = capabilities.getProviderCapabilitySet(provider);
  ```

  **server/handlers/integration/routing.js** (around line 142):
  Find the require/destructure at the top of the file — it will have `getProviderCapabilities` in it.
  Add `getProviderCapabilitySet` to that destructure.
  Then find:
  ```js
  const providerCapabilities = new Set(getProviderCapabilities(provider));
  ```
  Replace with:
  ```js
  const providerCapabilities = getProviderCapabilitySet(provider);
  ```

- [ ] **Step 6: Run full capabilities test suite to verify no regressions**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/provider-capabilities-memo.test.js server/tests/provider-capabilities.test.js
  ```
  Expected: PASS (all tests).

- [ ] **Step 7: Commit**

  ```bash
  git add server/db/provider-capabilities.js \
        server/execution/slot-pull-scheduler.js \
        server/handlers/integration/routing.js \
        server/tests/provider-capabilities-memo.test.js
  git commit -m "perf(capabilities): memoize provider capability Sets; add getProviderCapabilitySet()"
  ```

---

### Task 3: PRAGMA cache in budget-watcher.js (Spec Task C)

**Files:**
- Modify: `server/db/budget-watcher.js`
- Create: `server/tests/budget-watcher-pragma-cache.test.js`

- [ ] **Step 1: Write the failing test**

  Create `server/tests/budget-watcher-pragma-cache.test.js`:

  ```js
  'use strict';
  const Database = require('better-sqlite3');

  function makeDb() {
    const db = new Database(':memory:');
    db.exec(CREATE TABLE IF NOT EXISTS cost_budgets (
      id INTEGER PRIMARY KEY,
      provider TEXT,
      budget_usd REAL,
      threshold_pct REAL,
      notify_only INTEGER DEFAULT 0
    ));
    return db;
  }

  test('hasThresholdConfigColumn PRAGMA runs exactly once for 100 calls (cache hit)', () => {
    const db = makeDb();
    let pragmaCount = 0;
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
      return origPrepare(sql);
    };
    const bw = require('../db/budget-watcher');
    bw.setDb(db);
    for (let i = 0; i < 100; i++) bw.hasThresholdConfigColumn(db);
    expect(pragmaCount).toBe(1);
  });

  test('setDb clears the PRAGMA cache', () => {
    const db1 = makeDb();
    const db2 = makeDb();
    const bw = require('../db/budget-watcher');
    bw.setDb(db1);
    bw.hasThresholdConfigColumn(db1); // populate
    bw.setDb(db2); // should clear
    let pragmaCount = 0;
    const origPrepare = db2.prepare.bind(db2);
    db2.prepare = (sql) => {
      if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
      return origPrepare(sql);
    };
    bw.hasThresholdConfigColumn(db2);
    expect(pragmaCount).toBe(1);
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/budget-watcher-pragma-cache.test.js
  ```
  Expected: FAIL — PRAGMA runs 100 times, not 1.

- [ ] **Step 3: Add PRAGMA cache to budget-watcher.js**

  Open `server/db/budget-watcher.js`. Mirror the pattern from `scheduling-automation.js:22`.

  Find the module-level variables near the top (around lines 1-30). Add:
  ```js
  let _hasThresholdConfigColumnCache = null;
  ```

  Find the `setDb` function. After the line that assigns the db instance, add:
  ```js
  _hasThresholdConfigColumnCache = null;
  ```

  Find `hasThresholdConfigColumn` function (around lines 160-162). It currently runs:
  ```js
  const cols = database.prepare('PRAGMA table_info(cost_budgets)').all();
  return cols.some(c => c.name === 'threshold_pct');
  ```
  Replace the body with:
  ```js
  if (_hasThresholdConfigColumnCache !== null) return _hasThresholdConfigColumnCache;
  const cols = database.prepare('PRAGMA table_info(cost_budgets)').all();
  _hasThresholdConfigColumnCache = cols.some(c => c.name === 'threshold_pct');
  return _hasThresholdConfigColumnCache;
  ```

  Ensure `hasThresholdConfigColumn` is exported (check `module.exports` at the bottom).

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/budget-watcher-pragma-cache.test.js
  ```
  Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add server/db/budget-watcher.js server/tests/budget-watcher-pragma-cache.test.js
  git commit -m "perf(budget-watcher): cache hasThresholdConfigColumn PRAGMA result; clear on setDb()"
  ```

---

### Task 4: PRAGMA cache in pack-registry.js (Spec Task C continued)

**Files:**
- Modify: `server/db/pack-registry.js`
- Create: `server/tests/pack-registry-pragma-cache.test.js`

- [ ] **Step 1: Write the failing test**

  Create `server/tests/pack-registry-pragma-cache.test.js`:

  ```js
  'use strict';
  const Database = require('better-sqlite3');

  function makeDb() {
    const db = new Database(':memory:');
    db.exec(CREATE TABLE IF NOT EXISTS pack_registry (
      id INTEGER PRIMARY KEY,
      name TEXT,
      version TEXT
    ));
    return db;
  }

  test('getPackRegistryColumnInfo PRAGMA runs exactly once for 100 calls (cache hit)', () => {
    const db = makeDb();
    let pragmaCount = 0;
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
      return origPrepare(sql);
    };
    const pr = require('../db/pack-registry');
    pr.setDb(db);
    for (let i = 0; i < 100; i++) pr.getPackRegistryColumnInfo();
    expect(pragmaCount).toBe(1);
  });

  test('setDb clears the PRAGMA cache', () => {
    const db1 = makeDb();
    const db2 = makeDb();
    const pr = require('../db/pack-registry');
    pr.setDb(db1);
    pr.getPackRegistryColumnInfo(); // populate
    pr.setDb(db2); // should clear
    let pragmaCount = 0;
    const origPrepare = db2.prepare.bind(db2);
    db2.prepare = (sql) => {
      if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
      return origPrepare(sql);
    };
    pr.getPackRegistryColumnInfo();
    expect(pragmaCount).toBe(1);
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/pack-registry-pragma-cache.test.js
  ```
  Expected: FAIL — PRAGMA runs 100 times.

- [ ] **Step 3: Add PRAGMA cache to pack-registry.js**

  Open `server/db/pack-registry.js`. The file has `let db;` at line 6 and `setDb` at lines 8-10.
  `getPackRegistryColumnInfo` is at lines 13-21.

  After `let db;`, add:
  ```js
  let _packRegistryColumnInfoCache = null;
  ```

  In `setDb(dbInstance)`, after `db = dbInstance;`, add:
  ```js
  _packRegistryColumnInfoCache = null;
  ```

  In `getPackRegistryColumnInfo()`, wrap the body:
  ```js
  function getPackRegistryColumnInfo() {
    if (_packRegistryColumnInfoCache !== null) return _packRegistryColumnInfoCache;
    const cols = db.prepare('PRAGMA table_info(pack_registry)').all();
    _packRegistryColumnInfoCache = cols.reduce((acc, col) => {
      acc[col.name] = col;
      return acc;
    }, {});
    return _packRegistryColumnInfoCache;
  }
  ```
  (Match the existing return shape — if the original returns an array instead of an object, preserve that shape and adjust the cache assignment accordingly.)

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/pack-registry-pragma-cache.test.js
  ```
  Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add server/db/pack-registry.js server/tests/pack-registry-pragma-cache.test.js
  git commit -m "perf(pack-registry): cache getPackRegistryColumnInfo PRAGMA result; clear on setDb()"
  ```

---

### Task 5: listTasks({raw: true}) — skip safeJsonParse for tags/files_modified/context (Spec Task D)

This is the keystone Phase 3 optimization. The `db-list-tasks` metric `raw` variant will now measure a genuinely different code path.

**Files:**
- Modify: `server/db/task-core.js`
- Create: `server/tests/task-core-list-tasks-raw.test.js`

- [ ] **Step 1: Write the failing tests**

  Create `server/tests/task-core-list-tasks-raw.test.js`:

  ```js
  'use strict';
  const Database = require('better-sqlite3');

  function makeDb() {
    const db = new Database(':memory:');
    db.exec(CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project TEXT,
      description TEXT,
      status TEXT DEFAULT 'queued',
      provider TEXT,
      tags TEXT DEFAULT '[]',
      files_modified TEXT DEFAULT '[]',
      context TEXT DEFAULT 'null',
      auto_approve INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    ));
    for (let i = 0; i < 10; i++) {
      db.prepare(INSERT INTO tasks (id, project, description, tags, files_modified, context)
        VALUES (?, 'proj', 'task', ?, ?, ?)).run(
        	ask-,
        JSON.stringify(['tagA', 'tagB']),
        JSON.stringify(['file1.js']),
        JSON.stringify({ key: 'val' })
      );
    }
    return db;
  }

  test('listTasks default (parsed) returns parsed tags array', () => {
    const taskCore = require('../db/task-core');
    taskCore.setDb(makeDb());
    const tasks = taskCore.listTasks({ project: 'proj', limit: 10 });
    expect(Array.isArray(tasks[0].tags)).toBe(true);
    expect(tasks[0].tags).toEqual(['tagA', 'tagB']);
  });

  test('listTasks({raw:true}) returns tags as raw JSON string', () => {
    const taskCore = require('../db/task-core');
    taskCore.setDb(makeDb());
    const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true });
    expect(typeof tasks[0].tags).toBe('string');
    expect(tasks[0].tags).toBe('["tagA","tagB"]');
  });

  test('listTasks({raw:true}) still casts auto_approve to boolean', () => {
    const taskCore = require('../db/task-core');
    taskCore.setDb(makeDb());
    const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true });
    expect(typeof tasks[0].auto_approve).toBe('boolean');
  });

  test('listTasks({raw:true}) is measurably faster than parsed for 1000 rows', () => {
    const db = new Database(':memory:');
    db.exec(CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project TEXT,
      description TEXT,
      status TEXT DEFAULT 'queued',
      provider TEXT,
      tags TEXT DEFAULT '[]',
      files_modified TEXT DEFAULT '[]',
      context TEXT DEFAULT 'null',
      auto_approve INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    ));
    const ins = db.prepare(INSERT INTO tasks (id, project, description, tags, files_modified, context)
      VALUES (?, 'p', 'd', ?, ?, ?));
    for (let i = 0; i < 1000; i++) {
      ins.run(	, JSON.stringify(['a','b','c']), JSON.stringify(['x.js','y.js']), JSON.stringify({k:'v'}));
    }
    const taskCore = require('../db/task-core');
    taskCore.setDb(db);
    // Warm up
    for (let w = 0; w < 5; w++) {
      taskCore.listTasks({ project: 'p', limit: 1000 });
      taskCore.listTasks({ project: 'p', limit: 1000, raw: true });
    }
    const N = 20;
    const { performance } = require('perf_hooks');
    let parsedTotal = 0, rawTotal = 0;
    for (let i = 0; i < N; i++) {
      let t = performance.now();
      taskCore.listTasks({ project: 'p', limit: 1000 });
      parsedTotal += performance.now() - t;
      t = performance.now();
      taskCore.listTasks({ project: 'p', limit: 1000, raw: true });
      rawTotal += performance.now() - t;
    }
    const parsedMean = parsedTotal / N;
    const rawMean = rawTotal / N;
    // raw must be at least 10% faster than parsed (skipping 3000 JSON.parse calls per batch)
    expect(rawMean).toBeLessThan(parsedMean * 0.90);
  }, 30000);
  ```

- [ ] **Step 2: Run to verify the tests fail (especially the timing test)**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/task-core-list-tasks-raw.test.js
  ```
  Expected: FAIL — `raw: true` not yet implemented (tags still parsed), timing test also fails.

- [ ] **Step 3: Implement raw option in task-core.js**

  Open `server/db/task-core.js`. Find the post-processing block around lines 960-990 that looks like:
  ```js
  return rows.map(row => {
    const out = { ...row };
    if ('auto_approve' in row) out.auto_approve = Boolean(row.auto_approve);
    if ('context' in row) out.context = safeJsonParse(row.context, null);
    if ('files_modified' in row) out.files_modified = safeJsonParse(row.files_modified, []);
    if ('tags' in row) out.tags = safeJsonParse(row.tags, []);
    return out;
  });
  ```
  Replace it with:
  ```js
  return rows.map(row => {
    const out = { ...row };
    if ('auto_approve' in row) out.auto_approve = Boolean(row.auto_approve);
    if (!(options && options.raw)) {
      if ('context' in row) out.context = safeJsonParse(row.context, null);
      if ('files_modified' in row) out.files_modified = safeJsonParse(row.files_modified, []);
      if ('tags' in row) out.tags = safeJsonParse(row.tags, []);
    }
    return out;
  });
  ```
  Verify `options` is in scope at that point (it should be a parameter of the surrounding `listTasks` function).

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/task-core-list-tasks-raw.test.js
  ```
  Expected: PASS (4 tests including timing divergence). The timing test has a 30s timeout.

- [ ] **Step 5: Commit**

  ```bash
  git add server/db/task-core.js server/tests/task-core-list-tasks-raw.test.js
  git commit -m "perf(task-core): add listTasks({raw:true}) option; skip safeJsonParse for tags/files_modified/context"
  ```

---

### Task 6: Wire raw:true into v2-analytics-handlers.js (Spec Task D continued)

**Files:**
- Modify: `server/api/v2-analytics-handlers.js`
- Create: `server/tests/v2-analytics-list-tasks-raw.test.js`

- [ ] **Step 1: Write the failing test**

  Create `server/tests/v2-analytics-list-tasks-raw.test.js`:

  ```js
  'use strict';
  // Verify that the routing decisions handler passes raw:true to listTasks.

  test('getRoutingDecisions passes raw:true to listTasks', () => {
    let capturedOpts = null;
    // Intercept the taskCore require before loading the handler
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request.endsWith('task-core') || request.endsWith('task-core.js')) {
        return {
          listTasks: (opts) => { capturedOpts = opts; return []; },
          TASK_ROUTING_DECISION_COLUMNS: ['id', 'provider', 'metadata'],
        };
      }
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../api/v2-analytics-handlers')];
    const { getRoutingDecisions } = require('../api/v2-analytics-handlers');
    Module._load = origLoad;
    const req = { query: { limit: '10' } };
    const res = { json: () => {} };
    getRoutingDecisions(req, res);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.raw).toBe(true);
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/v2-analytics-list-tasks-raw.test.js
  ```
  Expected: FAIL — `capturedOpts.raw` is undefined.

- [ ] **Step 3: Add raw:true to the listTasks call in v2-analytics-handlers.js**

  Open `server/api/v2-analytics-handlers.js`. Find the `getRoutingDecisions` handler (~line 505).
  The call looks like:
  ```js
  taskCore.listTasks({ limit: limit * 3, order: 'desc', columns: taskCore.TASK_ROUTING_DECISION_COLUMNS })
  ```
  Change it to:
  ```js
  taskCore.listTasks({ limit: limit * 3, order: 'desc', columns: taskCore.TASK_ROUTING_DECISION_COLUMNS, raw: true })
  ```
  The existing guard on line 515 (`typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata`) already handles the raw string case.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/v2-analytics-list-tasks-raw.test.js
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add server/api/v2-analytics-handlers.js server/tests/v2-analytics-list-tasks-raw.test.js
  git commit -m "perf(analytics): pass raw:true to listTasks in routing decisions handler"
  ```

---

### Task 7: operations-perf-counters.js + REST endpoint (Spec Task E)

**Files:**
- Create: `server/operations-perf-counters.js`
- Modify: `server/api/v2-operations-handlers.js`
- Modify: `server/db/task-core.js` (instrument)
- Modify: `server/db/provider-capabilities.js` (instrument)
- Modify: `server/db/budget-watcher.js` (instrument)
- Modify: `server/db/pack-registry.js` (instrument)

- [ ] **Step 1: Write the failing test for the counter module**

  Create `server/tests/operations-perf-counters.test.js`:

  ```js
  'use strict';

  // Force a fresh require for each test to avoid state bleed
  function freshCounters() {
    delete require.cache[require.resolve('../operations-perf-counters')];
    return require('../operations-perf-counters');
  }

  test('increment increases the named counter', () => {
    const c = freshCounters();
    c.increment('listTasksParsed');
    c.increment('listTasksParsed');
    const snap = c.getSnapshot();
    expect(snap.listTasksParsed).toBe(2);
  });

  test('getSnapshot(reset=true) resets counters to zero', () => {
    const c = freshCounters();
    c.increment('listTasksRaw');
    c.getSnapshot(true);
    const snap = c.getSnapshot();
    expect(snap.listTasksRaw).toBe(0);
  });

  test('increment with unknown key is a no-op (no crash)', () => {
    const c = freshCounters();
    expect(() => c.increment('unknownKey')).not.toThrow();
  });

  test('snapshot includes all expected keys', () => {
    const c = freshCounters();
    const snap = c.getSnapshot();
    expect(snap).toHaveProperty('listTasksParsed');
    expect(snap).toHaveProperty('listTasksRaw');
    expect(snap).toHaveProperty('capabilitySetBuilt');
    expect(snap).toHaveProperty('pragmaCostBudgets');
    expect(snap).toHaveProperty('pragmaPackRegistry');
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/operations-perf-counters.test.js
  ```
  Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Create operations-perf-counters.js**

  Create `server/operations-perf-counters.js`:

  ```js
  'use strict';

  const _counters = {
    listTasksParsed: 0,
    listTasksRaw: 0,
    capabilitySetBuilt: 0,
    pragmaCostBudgets: 0,
    pragmaPackRegistry: 0,
  };

  function increment(key) {
    if (Object.prototype.hasOwnProperty.call(_counters, key)) {
      _counters[key]++;
    }
  }

  function getSnapshot(reset = false) {
    const snap = { ...(_counters) };
    if (reset) {
      for (const k of Object.keys(_counters)) _counters[k] = 0;
    }
    return snap;
  }

  module.exports = { increment, getSnapshot };
  ```

- [ ] **Step 4: Run tests to verify counter module passes**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/operations-perf-counters.test.js
  ```
  Expected: PASS (4 tests).

- [ ] **Step 5: Instrument callers**

  **server/db/task-core.js** — Add at the top of the file (after existing requires):
  ```js
  const perfCounters = require('../operations-perf-counters');
  ```
  In the `listTasks` function body, just before the `return` statement, add:
  ```js
  if (options && options.raw) {
    perfCounters.increment('listTasksRaw');
  } else {
    perfCounters.increment('listTasksParsed');
  }
  ```

  **server/db/provider-capabilities.js** — Add at the top of the file:
  ```js
  const perfCounters = require('../operations-perf-counters');
  ```
  In `getProviderCapabilitySet`, after `const s = new Set(getProviderCapabilities(provider));`, add:
  ```js
  perfCounters.increment('capabilitySetBuilt');
  ```

  **server/db/budget-watcher.js** — Add at the top of the file:
  ```js
  const perfCounters = require('../operations-perf-counters');
  ```
  In `hasThresholdConfigColumn`, in the branch that runs the PRAGMA (the else/null branch), add after the PRAGMA call:
  ```js
  perfCounters.increment('pragmaCostBudgets');
  ```

  **server/db/pack-registry.js** — Add at the top of the file:
  ```js
  const perfCounters = require('../operations-perf-counters');
  ```
  In `getPackRegistryColumnInfo`, in the branch that runs the PRAGMA, add:
  ```js
  perfCounters.increment('pragmaPackRegistry');
  ```

- [ ] **Step 6: Add GET /api/v2/operations/perf route**

  Open `server/api/v2-operations-handlers.js`. Add a new handler at the bottom:
  ```js
  function getPerfCounters(req, res) {
    const perfCounters = require('../operations-perf-counters');
    const reset = req.query.reset === 'true';
    res.json({ ok: true, counters: perfCounters.getSnapshot(reset) });
  }
  ```
  Add it to `module.exports`.

  Open the router file that registers v2 operations routes (search for `v2-operations-handlers` references in `server/api/` or the main router setup). Register:
  ```js
  router.get('/operations/perf', handlers.getPerfCounters);
  ```

- [ ] **Step 7: Run counter tests to confirm no regressions**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run server/tests/operations-perf-counters.test.js
  ```
  Expected: PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add server/operations-perf-counters.js \
        server/api/v2-operations-handlers.js \
        server/db/task-core.js \
        server/db/provider-capabilities.js \
        server/db/budget-watcher.js \
        server/db/pack-registry.js \
        server/tests/operations-perf-counters.test.js
  git commit -m "feat(perf): add operations-perf-counters module + /api/v2/operations/perf endpoint"
  ```

---

### Task 8: Dashboard OperationsPerf tab (Spec Task E continued)

**Files:**
- Create: `dashboard/src/views/OperationsPerf.jsx`
- Create: `dashboard/src/views/OperationsPerf.test.jsx`
- Modify: `dashboard/src/views/OperationsHub.jsx`

- [ ] **Step 1: Write the failing component tests**

  Create `dashboard/src/views/OperationsPerf.test.jsx`:

  ```jsx
  import React from 'react';
  import { render, screen, waitFor } from '@testing-library/react';
  import { vi } from 'vitest';
  import OperationsPerf from './OperationsPerf';

  beforeEach(() => { vi.restoreAllMocks(); });

  test('renders counter table when fetch succeeds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        counters: {
          listTasksParsed: 42,
          listTasksRaw: 7,
          capabilitySetBuilt: 3,
          pragmaCostBudgets: 1,
          pragmaPackRegistry: 0,
        },
      }),
    });
    render(<OperationsPerf />);
    await waitFor(() => screen.getByText('42'));
    expect(screen.getByText('listTasks (parsed)')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  test('shows loading state before fetch resolves', () => {
    global.fetch = vi.fn(() => new Promise(() => {})); // never resolves
    render(<OperationsPerf />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  test('shows error state when fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));
    render(<OperationsPerf />);
    await waitFor(() => screen.getByText(/error/i));
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });
  ```

- [ ] **Step 2: Run to verify tests fail**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run dashboard/src/views/OperationsPerf.test.jsx
  ```
  Expected: FAIL — module not found.

- [ ] **Step 3: Create OperationsPerf.jsx**

  Create `dashboard/src/views/OperationsPerf.jsx`:

  ```jsx
  import React, { useState, useEffect } from 'react';

  const COUNTER_LABELS = {
    listTasksParsed: 'listTasks (parsed)',
    listTasksRaw: 'listTasks (raw)',
    capabilitySetBuilt: 'Capability Set built',
    pragmaCostBudgets: 'PRAGMA cost_budgets',
    pragmaPackRegistry: 'PRAGMA pack_registry',
  };

  async function fetchCounters() {
    const res = await fetch('/api/v2/operations/perf');
    if (!res.ok) throw new Error(HTTP );
    return res.json();
  }

  export default function OperationsPerf() {
    const [state, setState] = useState({ loading: true, error: null, counters: null });

    useEffect(() => {
      let cancelled = false;
      function load() {
        fetchCounters()
          .then(data => {
            if (!cancelled) setState({ loading: false, error: null, counters: data.counters });
          })
          .catch(err => {
            if (!cancelled) setState({ loading: false, error: err.message, counters: null });
          });
      }
      load();
      const interval = setInterval(load, 30000);
      return () => { cancelled = true; clearInterval(interval); };
    }, []);

    if (state.loading) return <div>Loading perf counters...</div>;
    if (state.error) return <div>Error: {state.error}</div>;

    return (
      <div style={{ padding: '1rem' }}>
        <h3>Performance Counters</h3>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Counter</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(COUNTER_LABELS).map(([key, label]) => (
              <tr key={key}>
                <td style={{ padding: '4px 8px' }}>{label}</td>
                <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                  {state.counters[key] ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  ```

- [ ] **Step 4: Run component tests to verify they pass**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run dashboard/src/views/OperationsPerf.test.jsx
  ```
  Expected: PASS (3 tests).

- [ ] **Step 5: Add Perf tab to OperationsHub.jsx**

  Open `dashboard/src/views/OperationsHub.jsx`.

  Find the existing lazy imports (pattern: `const X = lazy(() => import('./X'))`). Add:
  ```jsx
  const OperationsPerf = lazy(() => import('./OperationsPerf'));
  ```

  Find the TABS array. It currently contains entries like `{ id: 'routing', label: 'Routing' }`. Add:
  ```jsx
  { id: 'perf', label: 'Perf' },
  ```
  Position it as the last tab (after `version-control` or wherever the current last tab is).

  Find the render block for tabs. It will have a pattern like:
  ```jsx
  {tab === 'governance' && <Suspense fallback={LOADING_FALLBACK}><Governance {...props} /></Suspense>}
  ```
  Add after the last existing tab render block:
  ```jsx
  {tab === 'perf' && <Suspense fallback={LOADING_FALLBACK}><OperationsPerf /></Suspense>}
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add dashboard/src/views/OperationsPerf.jsx \
        dashboard/src/views/OperationsPerf.test.jsx \
        dashboard/src/views/OperationsHub.jsx
  git commit -m "feat(dashboard): add OperationsPerf tab showing live perf counters"
  ```

---

### Task 9: PR template checklist (Spec Task F)

**Files:**
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Add Performance review section to PR template**

  Open `.github/PULL_REQUEST_TEMPLATE.md`. It currently has sections: What, Why, Testing, Notes.
  Insert a new section between Testing and Notes:

  ```markdown
  ## Performance review (Phase 3 discipline)

  - [ ] Hot paths: no `new Set()` or `new Map()` literals inside functions called per-tick or per-request
  - [ ] Invariant data (provider lists, column names, capability sets) hoisted to module scope or cached with `setDb()` invalidation
  - [ ] `listTasks` callers that do not need parsed JSON: pass `raw: true`
  - [ ] New PRAGMA queries: cached with null-guard + `setDb()` clear (mirror `scheduling-automation.js` pattern)
  - [ ] Perf counters: if adding a new hot-path operation, add a counter key to `operations-perf-counters.js`
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add .github/PULL_REQUEST_TEMPLATE.md
  git commit -m "docs(pr-template): add Phase 3 performance review checklist"
  ```

---

### Task 10: Re-scout — verify all Phase 3 findings are closed (Spec Task H)

**Files:**
- Read: `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-pre.md`
- Write: `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-post.md`

- [ ] **Step 1: Verify each pre-flight finding is addressed**

  Check each item from the pre-flight findings file against the tasks completed:

  | Finding | Task | Closed by |
  |---------|------|-----------|
  | MEDIUM: `slot-pull-scheduler.js:99` new Set per tick | Task 2 | `getProviderCapabilitySet()` |
  | MEDIUM: `task-core.js` safeJsonParse per row | Task 5 | `options.raw` branch |
  | LOW: `provider-router.js:287` new Set per routing call | Task 1 | `PAID_PROVIDERS` constant |
  | LOW: `queue-scheduler.js:438+841` two new Set per tick | Task 1 | `GPU_SHARING_PROVIDERS`, `OLLAMA_GPU_PROVIDERS` |
  | LOW: `budget-watcher.js` PRAGMA per buildBudgetStatus | Task 3 | `_hasThresholdConfigColumnCache` |
  | LOW: `pack-registry.js` PRAGMA per listPacks | Task 4 | `_packRegistryColumnInfoCache` |

- [ ] **Step 2: Write phase-3-repeated-work-post.md**

  Create `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-post.md` with the following content:

  ```markdown
  # Phase 3 Post-Flight — Repeated Work & Per-Request Allocations

  **Date:** 2026-04-25
  **Branch:** feat/perf-3-repeated-work
  **Status:** ALL PRE-FLIGHT FINDINGS CLOSED

  ## Closures

  | Severity | Location | Finding | Resolution |
  |----------|----------|---------|------------|
  | MEDIUM | `slot-pull-scheduler.js:99` | `new Set(capabilities.getProviderCapabilities(provider))` per tick per provider | Replaced with `capabilities.getProviderCapabilitySet(provider)` — Map-backed cache, O(1) after first call |
  | MEDIUM | `task-core.js:972-979` | `safeJsonParse` for tags/files_modified/context per row, always | Added `options.raw` branch; callers that do not need parsed JSON opt in with `raw: true` |
  | LOW | `provider-router.js:287` | `new Set(['anthropic','groq','codex','claude-cli'])` per routing call | Hoisted to module-level `PAID_PROVIDERS` |
  | LOW | `queue-scheduler.js:438` | `new Set(['ollama'])` per `createProviderRuntimeState` call | Hoisted to module-level `GPU_SHARING_PROVIDERS` |
  | LOW | `queue-scheduler.js:841` | `new Set(['ollama'])` per `processQueueInternal` call | Hoisted to module-level `OLLAMA_GPU_PROVIDERS` |
  | LOW | `budget-watcher.js:160-162` | `PRAGMA table_info(cost_budgets)` per `buildBudgetStatus` | Cached in `_hasThresholdConfigColumnCache`; cleared on `setDb()` |
  | LOW | `pack-registry.js:13-21` | `PRAGMA table_info(pack_registry)` per `listPacks`/`registerPack` | Cached in `_packRegistryColumnInfoCache`; cleared on `setDb()` |

  ## Already Closed (confirmed pre-flight)

  - `dashboard-server.js existsSync` — closed in prior phase
  - `getAllowedOrigins()` Set — closed in prior phase
  - `getAuditLogColumns` PRAGMA — closed in prior phase (scheduling-automation.js pattern established)
  - `getTaskFileChangeColumns` PRAGMA — closed in prior phase

  ## New Observability Added

  - `server/operations-perf-counters.js` — tracks call counts for all 5 hot paths
  - `/api/v2/operations/perf` — REST endpoint returns snapshot (with optional reset)
  - `Operations > Perf` dashboard tab — live display, 30s auto-refresh
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-post.md
  git commit -m "docs(perf): add Phase 3 post-flight closure report"
  ```

---

### Task 11: Perf baseline update (Spec Task G)

**Files:**
- Modify: `server/perf/baseline.json`

- [ ] **Step 1: Run the perf harness to capture new db-list-tasks timings**

  ```bash
  cd C:/Users/Werem/Projects/torque-public/.worktrees/feat-perf-3-repeated-work/server
  node perf/run.js --metric db-list-tasks --update-baseline
  ```
  If `--update-baseline` flag does not exist, run the harness and manually update `server/perf/baseline.json`.
  The `raw` variant should now show >20% lower median than `parsed` (was ~16ms vs ~17.7ms; after fix expect ~12-14ms vs ~17-18ms).

- [ ] **Step 2: Verify the divergence is meaningful**

  Open `server/perf/baseline.json`. Check `metrics.db-list-tasks.byVariant`:
  - `raw.median` must be < `parsed.median * 0.90` (at least 10% faster)
  - If not, investigate: confirm `listTasks({raw:true})` is actually taking the raw branch by adding a temporary `console.log` to verify

- [ ] **Step 3: Commit with perf-baseline trailer**

  ```bash
  git add server/perf/baseline.json
  git commit -m "perf(baseline): update db-list-tasks raw/parsed divergence after Phase 3 implementation

  perf-baseline: db-list-tasks raw now >10% faster than parsed (Phase 3)"
  ```
  The `perf-baseline:` trailer is required by the pre-push gate when touching `baseline.json`.

---

### Task 12: Cutover prep — final checks before merge

This task is orchestrator-only. No new files. Delegates merge to the orchestrator via `scripts/worktree-cutover.sh`.

- [ ] **Step 1: Run the full test suite from the worktree**

  ```bash
  torque-remote --branch feat/perf-3-repeated-work npx vitest run
  ```
  Expected: all tests pass. Fix any regressions before proceeding.

- [ ] **Step 2: Verify git log looks clean**

  ```bash
  cd C:/Users/Werem/Projects/torque-public/.worktrees/feat-perf-3-repeated-work
  git log --oneline origin/main..HEAD
  ```
  Expected: ~12 commits covering Tasks 1-11. No stray WIP commits.

- [ ] **Step 3: Confirm no factory pause needed**

  Per umbrella spec §4.4: Phase 3 does not require a factory pause. The changes are additive (new exports, new options, new files) with no breaking interface changes. The cutover can proceed while the factory is running.

- [ ] **Step 4: Hand off to orchestrator for cutover**

  The orchestrator runs:
  ```bash
  cd C:/Users/Werem/Projects/torque-public
  scripts/worktree-cutover.sh perf-3-repeated-work
  ```
  This merges feat/perf-3-repeated-work to main, drains the queue, restarts TORQUE, and removes the worktree.

---

## Self-Review Checklist

### Spec Coverage

| Spec Task | Plan Tasks | Status |
|-----------|------------|--------|
| A: Hoist invariant Sets | Task 1 | Covered — PAID_PROVIDERS, GPU_SHARING_PROVIDERS, OLLAMA_GPU_PROVIDERS |
| B: Capability Set memoization | Task 2 | Covered — getProviderCapabilitySet + Map cache |
| C: PRAGMA caches | Tasks 3, 4 | Covered — budget-watcher + pack-registry |
| D: listTasks raw mode | Tasks 5, 6 | Covered — implementation + analytics caller |
| E: Dashboard perf panel | Tasks 7, 8 | Covered — counter module + REST endpoint + React tab |
| F: PR template | Task 9 | Covered |
| G: Baseline update | Task 11 | Covered — with perf-baseline trailer |
| H: Re-scout | Task 10 | Covered — post-flight doc |

### Key Constraints Verified

- No ESLint rule added (umbrella spec §3.3 — pattern too varied to lint mechanically)
- No factory pause for Phase 3 cutover (umbrella spec §4.4)
- All tests run via `torque-remote --branch feat/perf-3-repeated-work`
- `perf-baseline:` trailer required when updating `baseline.json`
- "100 calls = 1 op" cache tests present in Tasks 2, 3, 4
- Timing divergence test for listTasks raw present in Task 5
- One commit per task
