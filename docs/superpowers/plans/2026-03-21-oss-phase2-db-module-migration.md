# OSS Phase 2: DB Sub-Module Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all 47 db sub-modules from the `setDb()` setter pattern to factory functions, and eliminate the `_wireCrossModuleDI()` setter chains. The `database.js` facade stays alive for backward compat — it calls the factories and re-exports their APIs.

**Architecture:** Each db module becomes a factory function that receives its dependencies as parameters and returns its public API. The `database.js` facade calls these factories during `init()` instead of using `setDb()` / setter injection.

**Tech Stack:** Node.js, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-oss-architecture-design.md` — Phase 2 section

**Depends on:** Phase 1 (container foundation) — completed

**Tests:** Run via `torque-remote npx vitest run`. For targeted: `torque-remote npx vitest run server/tests/<file>`.

---

## Conversion Pattern

Every db module follows the same transformation:

### Before (current — mutable setter DI)
```js
'use strict';
const logger = require('../logger').child({ component: 'example' });

let db;
let getTaskFn;

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { getTaskFn = fn; }

function doThing(id) {
  const task = getTaskFn(id);
  return db.prepare('SELECT ...').get(task.id);
}

module.exports = { setDb, setGetTask, doThing };
```

### After (factory — explicit deps)
```js
'use strict';
const logger = require('../logger').child({ component: 'example' });

function createExample({ db, taskCore }) {
  function doThing(id) {
    const task = taskCore.getTask(id);
    return db.prepare('SELECT ...').get(task.id);
  }

  return { doThing };
}

// Legacy compat — setDb/setGetTask still work during migration
let _instance = null;
let _db = null;
let _taskCore = null;

function setDb(dbInstance) {
  _db = dbInstance;
  _instance = null; // force re-create on next access
}
function setGetTask(fn) {
  _taskCore = { getTask: fn };
  _instance = null;
}

function _getInstance() {
  if (!_instance && _db) {
    _instance = createExample({ db: _db, taskCore: _taskCore || {} });
  }
  return _instance || {};
}

// Re-export all functions through lazy proxy
module.exports = new Proxy({ setDb, setGetTask, createExample }, {
  get(target, prop) {
    if (prop in target) return target[prop];
    const inst = _getInstance();
    return inst[prop];
  }
});
```

**The Proxy pattern** lets `database.js` continue calling `mod.setDb(db)` and `mod.doThing()` while also exposing `createExample` for the container. When all consumers migrate to the container (Phase 5), the legacy compat layer is removed.

**Simpler alternative for stateless modules:** Modules with no `setDb` (pure functions) just need their exports registered as-is in the container — no conversion needed.

---

## Batched Execution

Modules are grouped into batches of 4-8 by similarity and dependency tier.

### Task 1: Batch A — Stateless utilities (no conversion needed)

These modules have no `setDb`, no mutable state. Register them in the container as-is.

**Modules:** `config-keys.js`, `query-filters.js`, `schema-seeds.js`, `schema-migrations.js`, `analytics-metrics.js`

**Files:**
- Modify: `server/container.js` — register these 5 modules as values in the default container

- [ ] Register each module in container.js `initModules()` legacy path
- [ ] Verify: `npx vitest run`
- [ ] Commit: `feat(di): register stateless db utilities in container`

---

### Task 2: Batch B — Simple setDb-only modules (8 modules)

These modules only use `setDb()` — no cross-module deps. Mechanical conversion.

**Modules:**
- `db/audit-store.js`
- `db/email-peek.js`
- `db/peek-fixture-catalog.js`
- `db/pack-registry.js`
- `db/peek-policy-audit.js`
- `db/peek-recovery-approvals.js`
- `db/recovery-metrics.js`
- `db/validation-rules.js`

**Pattern:** For each module:
1. Read the module to identify all exported functions
2. Wrap all functions in a `createXxx({ db })` factory
3. Add legacy compat layer (setDb + Proxy)
4. Verify existing tests still pass

- [ ] Convert all 8 modules to factory pattern
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert 8 simple db modules to factory pattern`

---

### Task 3: Batch C — setDb + data-dir modules (4 modules)

These use `setDb()` plus additional simple dependencies (data dir, config).

**Modules:**
- `db/config-core.js` (setDb, has config cache)
- `db/code-analysis.js` (setDb only)
- `db/ci-cache.js` (setDb, wired late in _wireCrossModuleDI)
- `db/inbound-webhooks.js` (setDb only)

- [ ] Convert all 4 modules to factory pattern
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert config-core and 3 db modules to factory pattern`

---

### Task 4: Batch D — setDb + setGetTask modules (6 modules)

These use `setDb()` + `setGetTask()` — the most common cross-module pattern. The factory receives `{ db, taskCore }` where `taskCore.getTask` replaces the old `setGetTask` setter.

**Modules:**
- `db/cost-tracking.js` (setDb + setGetTask)
- `db/coordination.js` (setDb + setGetTask)
- `db/file-tracking.js` (setDb + setGetTask + setDataDir)
- `db/host-management.js` (setDb + setGetTask + setGetProjectRoot, also has circular require)
- `db/webhooks-streaming.js` (setDb only, but consumed by others)
- `db/backup-core.js` (setDb + setInternals — special case)

**Special handling:**
- `host-management.js` has a circular `require('../database')` — the factory eliminates this by receiving deps as params
- `backup-core.js` receives `setInternals` with 9 functions — the factory receives these as params
- `file-tracking.js` also needs `dataDir` as a factory param

- [ ] Convert all 6 modules to factory pattern
- [ ] Fix circular requires in host-management.js
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert 6 cross-module db modules to factory pattern`

---

### Task 5: Batch E — Complex cross-module modules (5 modules)

These have extensive `setDbFunctions()` setter chains. The factory receives all cross-module deps explicitly.

**Modules:**
- `db/task-core.js` (setDb + setExternalFns with 6 deps)
- `db/event-tracking.js` (setDb + setGetTask + setDbFunctions with 13 deps)
- `db/analytics.js` (setDb + setGetTask + setDbFunctions + setFindSimilarTasks)
- `db/scheduling-automation.js` (setDb + setGetTask + 3 setters)
- `db/task-metadata.js` (setDb + setGetTask + 5 setters)

- [ ] Convert all 5 modules to factory pattern
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert 5 complex db modules to factory pattern`

---

### Task 6: Batch F — Heavy cross-module modules (3 modules)

These are the most interconnected modules with bidirectional dependencies.

**Modules:**
- `db/project-config-core.js` (setDb + setGetTask + setRecordEvent + setDbFunctions with 7 deps)
- `db/provider-routing-core.js` (setDb + setGetTask + setHostManagement, circular require)
- `db/workflow-engine.js` (setDb, consumed by many)

**Special handling:**
- `provider-routing-core.js` has circular `require('../database')` — factory eliminates this
- `project-config-core.js` and `event-tracking.js` have bidirectional deps — resolve via lazy evaluation or split

- [ ] Convert all 3 modules to factory pattern
- [ ] Fix circular requires
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert 3 heavy cross-module db modules to factory pattern`

---

### Task 7: Batch G — Policy engine + remaining modules (6 modules)

**Modules:**
- `policy-engine/profile-store.js` (setDb + setGetProjectMetadata)
- `policy-engine/evaluation-store.js` (setDb only)
- `db/host-benchmarking.js`
- `db/host-complexity.js`
- `db/host-selection.js`
- `db/budget-watcher.js`

- [ ] Convert all 6 modules to factory pattern
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert policy engine stores and remaining db modules to factory pattern`

---

### Task 8: Batch H — Final db modules + schema (5 modules)

**Modules:**
- `db/project-cache.js`
- `db/provider-capabilities.js`
- `db/provider-performance.js`
- `db/provider-quotas.js`
- `db/provider-scoring.js`
- `db/model-capabilities.js`
- `db/throughput-metrics.js` (circular require — fix)
- `db/schema.js` (circular require — fix)

- [ ] Convert all modules to factory pattern
- [ ] Fix circular requires in throughput-metrics.js and schema.js
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): convert final db modules to factory pattern`

---

### Task 9: Update database.js to use factories

Now that all modules export `createXxx` factories, update `database.js` to:
1. Call factories instead of `setDb()` in `_injectDbAll()`
2. Call factories with cross-deps instead of setter chains in `_wireCrossModuleDI()`
3. Keep the merged exports facade intact

- [ ] Refactor `_injectDbAll()` to use factory calls
- [ ] Refactor `_wireCrossModuleDI()` to use factory calls
- [ ] Verify `resetForTest()` still works
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `refactor(di): database.js uses factories instead of setter injection`

---

### Task 10: Register all db modules in the container

Update `container.js` to register all db module factories in the default container during boot.

- [ ] Register all factories in container boot sequence
- [ ] Run DI lint rule: `node scripts/check-no-direct-db-import.js`
- [ ] Run: `npx vitest run` — no new failures
- [ ] Commit: `feat(di): register all db module factories in container`
- [ ] Push to origin/main
