# Database Facade Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the database.js facade merge loop so database.js becomes a thin connection lifecycle module. All 800+ re-exported sub-module functions are accessed directly via sub-module imports or the DI container.

**Architecture:** database.js keeps ONLY: `init()`, `close()`, `getDbInstance()`, `isDbClosed()`, `resetForTest()`, `safeAddColumn()`, `getDataDir()`, `getDbPath()`, and the core task operations that live directly in database.js (not delegated to sub-modules). The `_subModules` merge loop and `mergedExports` are deleted.

**Risk:** 49 test files still import database.js. Each must be migrated to import sub-modules directly before the facade can be removed.

---

## Phase 1: Migrate remaining test files (49 files)

### Task 1: Migrate `require.cache` injection tests (7 files)

These tests replace the entire database module in `require.cache` with a mock object. After the facade is removed, there's nothing to replace — tests should mock the specific sub-modules the production code imports.

**Files:** `exp1-ollama-provider-handlers.test.js`, `global-setup.js`, `host-management.test.js`, `integration-auto-routed-overflow.test.js`, `orchestrator-handlers.test.js`, `v2-control-plane.test.js`, `v2-governance-plan-projects.test.js`

For each:
- [ ] Read the file to understand what production code it tests
- [ ] Identify which sub-modules the production code imports
- [ ] Replace `require.cache[require.resolve('../database')] = mockDb` with mocks for specific sub-modules
- [ ] Remove the database import
- [ ] Verify test passes

### Task 2: Migrate `getDbInstance` tests (8 files)

These need the raw SQLite handle. After facade removal, `getDbInstance()` stays on database.js (it's a core function).

**Files:** `cost-tracking.test.js`, `p1-database-fixes.test.js`, `p1-infra-fixes.test.js`, `provider-routing-core.test.js`, `schema-migrations.test.js`, `slot-pull-routing.test.js`, `throughput-metrics.test.js`, `workstation-handlers.test.js`

For each:
- [ ] Check if `getDbInstance` is the ONLY database function used
- [ ] If yes, keep `const { getDbInstance } = require('../database')` (this is fine — database.js keeps this export)
- [ ] If other facade functions are used, migrate them to sub-module imports
- [ ] Remove any facade function calls

### Task 3: Migrate `resetForTest` infrastructure files (8 files)

Infrastructure files that call `db.resetForTest()`. This function stays on database.js.

**Files:** `e2e-helpers.js`, `p1-workflow-fixes.test.js`, `provider-investigation-fixes.test.js`, `provider-override-runtime.test.js`, `reset-for-test.test.js`, `task-finalizer.test.js`, `test-container.js`, `vitest-setup.js`

For each:
- [ ] Keep `const db = require('../database')` for `resetForTest` / `close` / `init`
- [ ] Migrate any facade function calls to sub-module imports
- [ ] These files are ALLOWED to import database.js post-facade-removal

### Task 4: Migrate `createMockDb` / mock pattern tests (5 files)

These create mock db objects. They don't actually use the database module at runtime.

**Files:** `agent-discovery.test.js`, `automation-handlers-main.test.js`, `dashboard-server.test.js`, `free-tier-fallback-codex.test.js`, `provider-routing-config.test.js`

For each:
- [ ] Check if `require('../database')` is actually used or if the test only uses mock objects
- [ ] If unused, remove the import
- [ ] If used in `require.cache`, convert to sub-module mocking

### Task 5: Migrate remaining `vi.spyOn(db, ...)` tests (8 files)

**Files:** `api-server.test.js`, `budget-alert-webhooks.test.js`, `dashboard-routes.test.js`, `event-dispatch.test.js`, `p0-cors-csrf.test.js`, `p0-timing-attack.test.js`, `p3-sse-session-cap.test.js`, `v2-health-models.test.js`

For each:
- [ ] Retarget remaining spies from `db` to specific sub-modules
- [ ] If `getDbInstance` is the only remaining use, keep as destructured import

### Task 6: Migrate "other" pattern tests (13 files)

**Files:** `advanced-artifacts-handlers.test.js`, `advanced-debugger-handlers.test.js`, `await-heartbeat.test.js`, `baseline-all-models.js`, `baseline-runner.js`, `discovery.test.js`, `handler-workflow-advanced.test.js`, `snapscope-handlers.test.js`, `test-hardening.test.js`, `test-station-routing.test.js`, `v2-local-providers.test.js`, `workflow-advanced-handlers.test.js`, `workflow-await.test.js`

For each:
- [ ] Read the file and determine what database functions are used
- [ ] Migrate to sub-module imports or keep minimal database import for core functions

---

## Phase 2: Slim down database.js

### Task 7: Remove the facade merge loop

After all test migrations are complete:

- [ ] Delete the `_subModules` array (lines ~891-916)
- [ ] Delete the `mergedExports` loop (lines ~921-940)
- [ ] Delete the `_DI_INTERNALS` set (lines ~672-690)
- [ ] Replace `module.exports = mergedExports` with a minimal export:
```js
module.exports = {
  // Connection lifecycle
  init, close, getDbInstance, isDbClosed: () => dbClosed,
  isReady: () => !!db && !dbClosed,
  getDataDir: () => DATA_DIR, getDbPath: () => DB_PATH,
  // Test support
  resetForTest,
  // DI wiring (internal)
  _wireAllModules,
  // Core utilities (no sub-module equivalent)
  safeAddColumn, validateColumnName, safeJsonParse,
  // Core task operations (thin wrappers → taskCore)
  createTask, getTask, updateTask, updateTaskStatus, listTasks,
  deleteTask, deleteTasks, countTasks, countTasksByStatus,
  getRunningCount, getRunningCountByProvider, resolveTaskId,
  getNextQueuedTask, tryClaimTaskSlot, listQueuedTasksLightweight,
  // Core config operations (thin wrappers → configCore)
  getConfig, setConfig, setConfigDefault, getAllConfig,
  // Listeners
  onClose, addTaskStatusTransitionListener, removeTaskStatusTransitionListener,
};
```
- [ ] Remove all the thin wrapper functions that are no longer needed (the ones that just call `taskCore.xxx()`)
- [ ] Verify: `node -e "const db = require('./database'); db.init(); console.log('OK')"`

### Task 8: Update the DI lint script

- [ ] Update the lint script to reflect the new reality — database.js is no longer a facade
- [ ] Change the script description and violation messaging
- [ ] Run: `node scripts/check-no-direct-db-import.js --summary`

### Task 9: Final verification + push

- [ ] Run full test suite
- [ ] Verify database.js line count (target: under 400 lines)
- [ ] Push everything
