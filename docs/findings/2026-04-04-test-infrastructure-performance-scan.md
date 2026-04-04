# Test Infrastructure Performance Scan

**Date:** 2026-04-04
**Scope:** server/tests/ — test infrastructure, import costs, setup/teardown patterns
**Variant:** performance

## Summary

7 findings: 1 critical, 3 high, 2 medium, 1 low.

The core problem: test imports dominate runtime. A single test file that calls `setupTestDb()` or directly requires `tools.js` pays ~335ms in cold import overhead, loading 350 modules (319 server + 31 node_modules) before executing a single test. With 688 test files across 8 workers (pool: forks), each worker fork pays this cost independently for every file it loads. The full suite spends ~40s of its 83s runtime on module loading.

The import cost breaks down as:
- `database.js` (legacy facade): ~90ms, loads 88 modules (all 44 db sub-modules eagerly)
- `task-manager.js`: ~170ms, loads 224 modules (pulls in database + dashboard-server + all providers + all utilities)
- `dashboard-server.js`: ~150ms when loaded from task-manager (includes api/v2-dispatch.js which loads all v2 handler modules)
- `tools.js`: ~335ms total cold import (loads the entire server module graph — 350 modules via 34 handler modules + 38 tool-def files)

## Findings

### [CRITICAL] tools.js is a 350-module mega-import loaded by 179 test files
- **File:** server/tests/vitest-setup.js:141
- **Description:** `setupTestDb()` unconditionally calls `require('../tools')` to provide `handleToolCall`. This loads the entire TORQUE module graph: 34 handler modules, 38 tool-def files, task-manager, dashboard-server, all providers, all db modules, all utilities — 350 modules totaling ~335ms per cold import. 164 test files call `setupTestDb()`, plus 22 files directly require `../tools` — a total of 179 files paying this cost. Only a fraction of these tests actually use `handleToolCall`; many just need a fresh database. Each vitest fork pays this cost independently per file, meaning across the suite, `tools.js` is cold-loaded hundreds of times.
- **Status:** NEW
- **Suggested fix:** Split `setupTestDb()` into two variants: (1) `setupTestDbOnly()` that provides just `db` and `rawDb` without loading tools.js (~30ms), and (2) the existing `setupTestDb()` for tests that actually call `handleToolCall`. Migrate tests that never use `handleToolCall` to the lightweight variant. Expected savings: ~300ms per file for the ~100+ tests that don't need `handleToolCall`, reducing total suite import time by 30-40%.

### [HIGH] task-manager.js imports dashboard-server.js eagerly, pulling in the full v2 API
- **File:** server/task-manager.js:14
- **Description:** `task-manager.js` has a top-level `require('./dashboard-server')` which transitively loads `api/v2-dispatch.js` (all v2 handler modules), `dashboard/router.js` (all dashboard route handlers), and the `ws` WebSocket library. This single require adds ~150ms and 136 modules to any file that imports task-manager. Most tests mock task-manager anyway, but those that don't (37 test files) pay this cost even if they never use the dashboard broadcast functionality. The dashboard-server import exists so task-manager can call `broadcastUpdate()` for live UI updates — a feature unused in tests.
- **Status:** NEW
- **Suggested fix:** Lazy-load dashboard-server in task-manager: replace the top-level require with a function that loads it on first use. Tests that mock task-manager are unaffected. Tests that use the real task-manager save ~150ms on import. Alternative: inject dashboard-server as a dependency via the DI container instead of direct require.

### [HIGH] database.js legacy facade eagerly loads all 44 db sub-modules
- **File:** server/database.js:25-60
- **Description:** `database.js` has 44 top-level require() calls to load every db sub-module (code-analysis, cost-tracking, host-management, workflow-engine, etc.) regardless of which ones the consumer needs. This takes ~90ms and loads 88 modules. 24 test files import database.js directly, and another 164 import it transitively via `setupTestDb()`. The facade exists for backward compatibility — the DI container already registers these modules individually. Tests that import `database.js` for just `getTask()` or `getConfig()` load 43 unnecessary sub-modules.
- **Status:** NEW
- **Suggested fix:** For tests, this is partially mitigated by the `setupTestDbModule()` function which imports only the needed sub-module. Migrating the remaining 24 direct `require('../database')` usages in tests to use specific db sub-modules (`../db/task-core`, `../db/config-core`, etc.) would avoid the facade entirely. Longer term, lazy-loading sub-modules in database.js (getter properties instead of top-level requires) would benefit all consumers.

### [HIGH] 226 test files exceed 500 lines, limiting parallel efficiency
- **File:** server/tests/ (226 files > 500 lines, 62 files > 1000 lines)
- **Description:** Vitest distributes work at file granularity across workers. Files over 500 lines are effectively sequential bottlenecks: the worker assigned to a 2701-line file (api-server.test.js) or a 2353-line file (task-core-handlers.test.js) is blocked for the entire duration while other workers finish early. With 8 workers and 688 files, long files create tail latency. The 62 files exceeding 1000 lines (~135K lines total) are the worst offenders. The largest files: api-server.test.js (2701), task-core-handlers.test.js (2353), v2-infrastructure-handlers.test.js (2161), queue-scheduler.test.js (2117), dashboard-infrastructure-routes.test.js (2075).
- **Status:** NEW
- **Suggested fix:** Split the top 20 largest test files into smaller files grouped by describe block. Vitest can then distribute the pieces across workers. This improves tail latency without changing test count. Files like api-server.test.js can be split into api-server-core.test.js, api-server-sse.test.js, api-server-routes.test.js, etc.

### [MEDIUM] pool: 'forks' forces full module re-import per file (no cross-file caching)
- **File:** server/vitest.config.js:13
- **Description:** The vitest config uses `pool: 'forks'` which creates isolated Node.js child processes per worker. Unlike `pool: 'threads'` (worker_threads), fork-based workers cannot share the module cache across files run in the same worker. Each file loaded by a fork gets a fresh `require.cache`, so `tools.js` (350 modules, ~335ms) is fully re-loaded for every file the worker processes. The comment in worker-setup.js explains why forks are used: `vi.mock` does not work for Node built-ins in pool:forks + CJS mode, and monkey-patching `child_process` in worker-setup.js is the only reliable approach to prevent git.exe orphan storms on Windows. This is a legitimate constraint, but it makes the import cost problem ~3-5x worse than it would be with thread-based workers.
- **Status:** NEW
- **Suggested fix:** This is constrained by the Windows git orphan problem. However, two mitigations exist: (1) Use vitest's `poolMatchGlobs` to run tests that don't spawn git in `threads` pool and only tests that need git interception in `forks`, or (2) reduce per-file import cost (findings 1-3) which makes the fork overhead proportionally smaller. If findings 1-3 are addressed, per-file import drops from ~335ms to ~30ms, making the fork vs thread distinction largely moot.

### [MEDIUM] 14 test files call vi.resetModules() in beforeEach — full re-import per test
- **File:** server/tests/pii-guard.test.js, restart-drain.test.js, api-routes.test.js, budget-alert-webhooks.test.js, and 10 others
- **Description:** 14 test files call `vi.resetModules()` inside `beforeEach()`, which clears the module cache before every single test case. This forces a complete re-import of all `require()` calls in each test, multiplying the import cost by the number of tests in the file. For a test file with 20 tests that imports tools.js, this means ~335ms x 20 = ~6.7 seconds spent purely on re-importing. This pattern is used to get a fresh module state per test, but in most cases `db.resetForTest()` or `vi.restoreAllMocks()` would provide sufficient isolation without re-importing.
- **Status:** NEW
- **Suggested fix:** Audit each of the 14 files to determine if `vi.resetModules()` is truly needed. Common alternatives: (1) use `vi.restoreAllMocks()` for mock cleanup, (2) use `db.resetForTest()` for DB isolation, (3) move `vi.resetModules()` to `beforeAll()` if once-per-suite is sufficient. Files that genuinely need module-level isolation (e.g., testing module initialization behavior) should keep it but should avoid importing heavy modules.

### [LOW] test-helpers.js includes a self-test that runs as part of the suite
- **File:** server/tests/test-helpers.js:89-96
- **Description:** `test-helpers.js` contains a `describe('test-helpers')` block with a trivial test (`it('exports utility functions', ...)`). The comment says "Vitest needs at least one test in every matched file", but the file is matched by the `tests/**/*.test.js` glob only because it is inside the tests directory. Since it doesn't end in `.test.js`, it wouldn't normally be matched — but the vitest include pattern is `tests/**/*.test.js`, and this file is included because other test files `require()` it. The real issue is that 67 test files import it, and while the file itself is lightweight (98 lines, just path + utility functions), the unnecessary self-test adds clutter.
- **Status:** NEW
- **Suggested fix:** Remove the describe/it block from test-helpers.js. It is not needed since the file doesn't match the `*.test.js` glob pattern and is only imported as a module, not run directly.

## Import Cost Reference

Measured cold-import times on the development workstation (RTX 4060, NVMe SSD):

| Module | Time (ms) | Modules Loaded | Notes |
|--------|-----------|----------------|-------|
| `tools.js` | 335 | 350 | Full module graph — the worst offender |
| `task-manager.js` | 170 | 224 | Pulls in database + dashboard-server + providers |
| `dashboard-server.js` | 150 | 136 | Pulls in v2-dispatch (all v2 handlers) |
| `database.js` | 90 | 88 | Legacy facade, loads all 44 db sub-modules |
| `vitest-setup.js` | 30 | 26 | Lightweight — just db/task-core + fs/path/crypto |
| `db/task-core.js` | 30 | 25 | A single db sub-module (includes database.js transitively) |
| `handlers/shared.js` | 8 | 3 | Truly lightweight handler utility |
| `better-sqlite3` | 8 | 1 | Native addon — fast |
| `worker-setup.js` | 4 | 2 | Git monkey-patch — negligible |

## Estimated Impact

If the critical and high findings are addressed:
- **Per-file import cost**: ~335ms -> ~30ms (for tests that don't need handleToolCall)
- **Suite-wide import time**: ~40s -> ~10-15s (rough estimate with 8 fork workers)
- **Total suite time**: ~83s -> ~55-60s (import savings + better parallelization from file splits)
