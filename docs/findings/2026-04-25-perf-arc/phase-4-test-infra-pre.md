# Phase 4 Pre-Flight Scout — Test Infra Import Bloat

**Date:** 2026-04-25
**Worktree:** feat-perf-4-test-infra
**Base commit:** 6ce665b8bd824d9715b4b801f4ddd72e14a2733a
**Discipline rule:** No top-level `require('../tools')` or `require('../task-manager')` from `server/tests/**` unless on deliberate allowlist; `setupTestDb` has variants by need (per umbrella §3.4)

---

## Summary

The April 4 scan identified a 350-module mega-import problem costing ~335ms per test file cold import. Since then, three of the four structural root causes have been partially addressed: `database.js` was converted from 44 eager top-level sub-module requires to a lazy-load facade (now only 7 top-level requires); `task-manager.js` dashboard-server require was converted to a lazy getter; `vitest-setup.js` was split into `setupTestDb()` (with lazy tools.js access) and `setupTestDbOnly()` (zero tools.js import). The pool was also changed from `'forks'` to `'threads'`, eliminating the module-cache isolation penalty that was multiplying import costs per file.

What remains: 16 test files still do a top-level `require('../tools')` at module scope (loading the 350-module graph eagerly on file load, before any test runs). 5 of these 16 never call `handleToolCall`—they only need routing metadata (`routeMap`, `TOOLS`, `schemaMap`). The vitest-setup.js `setupTestDb()` path still holds a `require.resolve('../tools')` at module scope that forces the tools module path to be resolved eagerly. 90 test files still call `setupTestDb()` instead of `setupTestDbOnly()`, of which 17 demonstrably never use `handleToolCall` or `safeTool`. There are 38 test files with `vi.resetModules()` inside `beforeEach()` blocks, forcing full module re-import per test case. Finally, 75 test files exceed 1000 lines (up from 62 at the April 4 baseline), with the largest at 3638 lines—a new entrant not present in prior scans.

---

## Findings

### Heavy import counts (per file)

Files with at least one top-level (module-scope) `require('../tools')`:

| File | tools.js | task-manager.js | database.js | Notes |
|---|---|---|---|---|
| server/tests/api-server.test.js | yes | no | no | Uses handleToolCall |
| server/tests/auto-recovery-mcp-tools.test.js | yes | no | no | routeMap only |
| server/tests/eval-mcp-tools.test.js | yes | no | no | Uses handleToolCall |
| server/tests/mcp-factory-loop-tools.test.js | yes | no | no | Uses handleToolCall |
| server/tests/mcp-sse.test.js | yes | no | no | Uses handleToolCall |
| server/tests/mcp-streamable-http.test.js | yes | no | no | Uses handleToolCall |
| server/tests/mcp-tool-alignment.test.js | yes | no | no | routeMap/TOOLS/schemaMap only |
| server/tests/mcp-tools-plan-file.test.js | yes | no | no | Uses handleToolCall |
| server/tests/p2-orphaned-tools.test.js | yes | no | no | routeMap only |
| server/tests/p2-workflow-subscribe.test.js | yes | no | no | Uses handleToolCall |
| server/tests/p3-dead-routes.test.js | yes | no | no | routeMap only |
| server/tests/restart-server-tool.test.js | yes | yes | no | Uses handleToolCall |
| server/tests/test-hardening.test.js | yes | no | no | Uses handleToolCall |
| server/tests/tool-annotations.test.js | yes | no | no | TOOLS/routeMap only |
| server/tests/tool-schema-validation.test.js | yes | no | no | Uses handleToolCall |
| server/tests/tools-aggregator.test.js | yes | no | no | Uses handleToolCall |

Files with top-level `require('../task-manager')` (not inside beforeEach/beforeAll/test blocks):

| File | Notes |
|---|---|
| server/tests/dashboard-routes-advanced.test.js | top-level, line 9 |
| server/tests/e2e-post-task-validation.test.js | top-level, line 16 |
| server/tests/handler-adv-debugger.test.js | top-level, line 2 |
| server/tests/handler-task-core-extended.test.js | top-level, line 12 |
| server/tests/handler-task-pipeline.test.js | top-level, line 8 |
| server/tests/handler-task-project.test.js | top-level, line 7 |
| server/tests/handler-workflow-advanced.test.js | top-level, line 6 |
| server/tests/handler-workflow-handlers.test.js | top-level, line 5 |
| server/tests/harness-improvements.test.js | top-level, line 10 |
| server/tests/integration-index.test.js | top-level, line 9 |
| server/tests/p1-process-safety.test.js | top-level, line 17 |
| server/tests/policy-task-lifecycle.test.js | top-level, line 4 |
| server/tests/post-tool-hooks.test.js | top-level, line 12 |
| server/tests/task-intelligence.test.js | top-level, line 130 |
| server/tests/task-intelligence-handlers.test.js | top-level, line 142 |
| server/tests/task-operations.test.js | top-level, line 149 |
| server/tests/task-pipeline-handlers.test.js | top-level, line 73 |
| server/tests/workflow-handlers-analysis.test.js | top-level, line 2 |
| server/tests/workflow-handlers-core.test.js | top-level, line 3 |

---

### [HIGH] 5 test files require tools.js at top level but never call handleToolCall

These files load the entire 350-module graph (~335ms cold) to access routing metadata only (`routeMap`, `TOOLS`, `schemaMap`). The metadata is available much more cheaply from narrower imports (`./tool-annotations`, `./core-tools`, specific handler modules).

- `auto-recovery-mcp-tools.test.js:6` — imports `{ routeMap }` only
- `mcp-tool-alignment.test.js:9` — imports `{ TOOLS, routeMap, schemaMap }` only
- `p2-orphaned-tools.test.js:4` — imports `{ routeMap }` only
- `p3-dead-routes.test.js:4` — imports `{ routeMap }` only
- `tool-annotations.test.js:25` — imports `{ TOOLS, routeMap }` only

**Fix:** Export `TOOLS`, `routeMap`, and `schemaMap` from a lightweight `tool-registry.js` that does not load handler modules. Tests that need only the schema/route map import the thin module instead of `tools.js`.

---

### [HIGH] 16 test files still use module-scope require('../tools')

All 16 files above pay the ~335ms cold-import cost on every vitest thread worker that loads them, before any test assertion runs. The 11 that genuinely use `handleToolCall` are the correct allowlist for the ESLint rule `torque/no-heavy-test-imports`; the 5 metadata-only files should be removed from that allowlist and migrated.

- Total: 16 files at module scope
- Genuinely need `handleToolCall`: 11
- Metadata-only (should migrate): 5

---

### [HIGH] 38 test files with vi.resetModules() inside beforeEach()

These force a full module cache clear before every single test case. For any test that subsequently calls `require('../tools')` or loads a transitive heavy module, this multiplies the ~335ms import by the number of test cases in the file.

Worst offenders (multiple beforeEach+resetModules in one file):

- `server/tests/factory-loop-hardening.test.js` — 4 occurrences (lines 12, 85, 131, and at file open)
- `server/tests/tda-01-provider-sovereignty.test.js` — 6 occurrences (lines 65, 93, 193, 259, 331, 359)
- `server/tests/mcp-platform.test.js` — 5 occurrences (lines 185, 216, 282, 405, 484)
- `server/tests/config.test.js` — 4 occurrences (lines 10, 252, 263, 281)
- `server/tests/per-provider-concurrency.test.js` — 3 occurrences (lines 121, 192, 227)
- `server/tests/factory-audit.test.js` — 3 occurrences (lines 108, 134)

Full list (38 unique files):

`adapter-registry.test.js`, `advanced-intelligence-handlers.test.js`, `advanced-intelligence.test.js`,
`adversarial-review-dag.test.js`, `adversarial-review-stage.test.js`, `api-routes.test.js`,
`auto-release.test.js`, `benchmark.test.js`, `budget-alert-webhooks.test.js`,
`cli-client.test.js`, `config.test.js`, `factory-audit.test.js`,
`factory-loop-hardening.test.js`, `factory-loop-instance-routes.test.js`, `factory-provider-lane-routes.test.js`,
`factory-worktrees-persistence.test.js`, `integration-auto-routed-overflow.test.js`, `mcp-index.test.js`,
`ollama-agentic.test.js`, `orchestrator-e2e.test.js`, `orphan-cleanup.test.js`,
`peek-artifacts-handlers.test.js`, `peek-compliance-handlers.test.js`, `peek-federation-handlers.test.js`,
`policy-adapter-approval-extended.test.js`, `policy-adapter-feature-flag.test.js`, `prompts-tier-integration.test.js`,
`prompts-tier-templates.test.js`, `provider-registry.test.js`, `provider-router.test.js`,
`rest-passthrough-coercion.test.js`, `restart-drain.test.js`, `task-project-handlers.test.js`,
`tda-01-provider-sovereignty.test.js`, `v2-config-api.test.js`, `v2-governance-boolean-validation.test.js`,
`v2-governance-handlers.test.js`, `verification-ledger-stage.test.js`

**Fix:** Audit each. The common pattern is testing module initialization behavior or mocking provider/config singletons — for these, `vi.resetModules()` is legitimate but should be combined with `setupTestDbOnly()` instead of `setupTestDb()` to avoid re-loading tools.js on each reset. Where DB isolation is the actual goal, switch to `db.resetForTest()` in `beforeEach` instead.

---

### [MEDIUM] 90 test files call setupTestDb() — 17 never use handleToolCall

`setupTestDb()` returns a `handleToolCall` wrapper that lazily loads `tools.js` on first invocation. While the lazy wrapper avoids the cost if `handleToolCall` is never called in a test file, 17 of the 90 callers demonstrably never invoke `handleToolCall` or `safeTool` at all. These files could be migrated to `setupTestDbOnly()` with zero behavioral change.

Files calling `setupTestDb()` but never calling `handleToolCall` or `safeTool`:

- `server/tests/artifact-storage-path.test.js`
- `server/tests/build-bundle.test.js`
- `server/tests/event-emitter.test.js`
- `server/tests/event-replay.test.js`
- `server/tests/execute-ollama-coverage.test.js`
- `server/tests/factory-auto-pilot-regressions.test.js`
- `server/tests/factory-baseline-probe-integration.test.js`
- `server/tests/factory-dep-resolver-integration.test.js`
- `server/tests/factory-plan-quality-gate-e2e.test.js`
- `server/tests/factory-verify-review-integration.test.js`
- `server/tests/file-baselines-boundary.test.js`
- `server/tests/hashline-path-scoping.test.js`
- `server/tests/integration-index.test.js`
- `server/tests/replay.test.js`
- `server/tests/workflow-resume.test.js`
- `server/tests/workflow-spec-handlers.test.js`
- `server/tests/workflow-spec-integration.test.js`

Note: Because `setupTestDb()` now uses a lazy wrapper rather than an eager `require('../tools')`, the actual import cost is only paid if the file actually calls `handleToolCall`. These 17 files currently avoid paying the cost, but they should still be migrated to `setupTestDbOnly()` for clarity, correctness under `vi.resetModules()` (which can force the lazy path to re-evaluate), and to enforce the discipline rule.

---

### [MEDIUM] 75 test files exceed 1000 lines (up from 62 in April 4 baseline)

These are worker-distribution bottlenecks: vitest distributes work at file granularity, so a 3638-line file blocks one worker for the file's entire duration while other workers finish early.

Top 20 worst offenders (lines):

| File | Lines |
|---|---|
| server/tests/agentic-execution-fixes.test.js | 3638 |
| server/tests/api-server.test.js | 2715 |
| server/tests/task-core-handlers.test.js | 2360 |
| server/tests/v2-task-handlers.test.js | 2185 |
| server/tests/dashboard-infrastructure-routes.test.js | 2175 |
| server/tests/queue-scheduler.test.js | 2170 |
| server/tests/v2-infrastructure-handlers.test.js | 2162 |
| server/tests/factory-loop-controller.test.js | 2068 |
| server/tests/policy-engine-core.test.js | 2066 |
| server/tests/process-lifecycle.test.js | 2044 |
| server/tests/v2-governance-remaining.test.js | 1986 |
| server/tests/policy-adapters-verify-refactor.test.js | 1981 |
| server/tests/peek-analysis.test.js | 1960 |
| server/tests/v2-analytics-handlers.test.js | 1954 |
| server/tests/codebase-study.test.js | 1889 |
| server/tests/peek-capture.test.js | 1856 |
| server/tests/fallback-retry.test.js | 1735 |
| server/tests/workflow-await-handlers.test.js | 1659 |
| server/tests/peek-recovery-handlers.test.js | 1628 |
| server/tests/api-routes.test.js | 1604 |

`agentic-execution-fixes.test.js` at 3638 lines is a new entrant not in the April 4 scan. The prior scan's #1 was `api-server.test.js` at 2701 — it now shows 2715, a modest growth.

---

### [LOW] test-helpers.js self-test stub still present

- `server/tests/test-helpers.js:95-101` — contains a `describe('test-helpers')` block with a trivial self-assertion. The April 4 scan flagged this. It is still present (file is 104 lines). The stub adds no verification value since the file is not matched by the `*.test.js` glob and is only imported as a module.

**Fix:** Remove the `describe`/`it` block from `test-helpers.js`.

---

### [LOW] vitest-setup.js resolves tools.js path eagerly

- `server/tests/vitest-setup.js:30` — `const TOOLS_MODULE_PATH = require.resolve('../tools');` runs at module load time. This is a `require.resolve()` (not a full `require()`), so it does not load the 350-module graph. However, it does force Node to locate and stat `tools.js` on every worker-setup invocation. Combined with the `getToolsModule()` lazy pattern on lines 32-37, this is low-severity but worth noting as a future cleanup target if vitest-setup.js is restructured.

---

## Module-level dependency analysis

### server/database.js — now lazy-loaded

**Status: FIXED since April 4 baseline.**

The April 4 scan counted 44 top-level `require()` calls. Current count: **7 top-level requires** (better-sqlite3, path, os, fs, data-dir, logger, utils/json). All 37 former sub-module requires are now declared as lazy definitions in `_LAZY_MODULE_DEFINITIONS` and loaded via a Proxy getter on first access. The `database-facade-lazy-load.test.js` test verifies this behavior. Import of `database.js` alone no longer loads sub-modules. This is a confirmed fix.

### server/task-manager.js — dashboard-server lazy-loaded

**Status: PARTIALLY FIXED since April 4 baseline.**

The April 4 scan flagged `require('./dashboard-server')` at line 14 of `task-manager.js`. Current state: `dashboard-server` is behind a lazy getter (`let _dashboard = null; function getDashboard() { if (!_dashboard) _dashboard = require('./dashboard-server'); return _dashboard; }`) at lines 15-19. The eager top-level import is gone. However, `task-manager.js` still has **~30 top-level requires** for providers, execution modules, utils, db modules, etc. (crypto, container, taskCore, coordination, providerRoutingCore, sleep-watchdog, logger, providerRegistry, providerCfg, serverConfig, FreeQuotaTracker, gpuMetrics, eventBus, sanitize, model utils, git utils, file-resolution, hostMonitoring, contextEnrichment, tsserverClient, activityMonitoring, taskExecutionHooks, execution module, executeApi, postTask, task-cancellation, stall-detection, fallback-retry, workflow-runtime, output-safeguards). Cold-import cost reduction from dashboard-server lazy-load is meaningful but task-manager.js remains a heavy import overall.

### server/tools.js — unchanged

**Status: NO structural change since April 4 baseline.**

Still has **19 top-level requires** at lines 9-37 and 45-71, loading 6 handler modules (comparison, evidence-risk, governance, review, symbol-indexer, template) plus 26+ tool-def files via inline `require()` spread in the TOOL_DEFS object. The handler modules each pull in additional sub-modules. Total module count ~350 unchanged. The total `require()` call count in the file is 126 (many are spread-inline).

---

## Vitest config notes

Current state in `server/vitest.config.js` (as of HEAD):

- **`pool: 'threads'`** — Changed from `'forks'` since the April 4 baseline. This is a significant improvement: worker threads share the Node.js module cache across files run in the same thread, so cold-import cost for `tools.js` is paid once per thread worker, not once per file. With `maxWorkers` = `min(cpuCount-1, 8)`, a typical 8-worker machine pays the ~335ms tools.js import 8 times total instead of once per test file. This alone likely accounts for a substantial wall-time improvement independent of any code changes.
- **`maxWorkers: Math.max(1, Math.min(os.cpus().length - 1, 8))`** — dynamic, capped at 8.
- **`fileParallelism: true`** — files run in parallel within workers.
- **`setupFiles: ['tests/worker-setup.js']`** — lightweight git-interception monkey-patch only. No heavy modules imported here (confirmed: worker-setup.js imports only fs, os, path, Module, EventEmitter, PassThrough, child_process).
- **`globalSetup: ['tests/global-setup.js']`** — runs once, not per file.
- **`retry: 1`** — one retry per test case for transient flakes.
- **No `poolMatchGlobs`** — all tests run under a single pool configuration (threads). The April 4 scan suggested using `poolMatchGlobs` to separate git-needing tests into forks; this is no longer needed since the pool change to threads plus the monkey-patch in worker-setup.js solves the Windows git-orphan problem in thread mode.

---

## Coverage

- **Total test files scanned:** 1,014 (`.test.js` files in `server/tests/**`)
- **Test files with top-level tools.js require:** 16
- **Test files with any tools.js require (including inside blocks):** 28 (+ vitest-setup.js)
- **Test files calling setupTestDb() (potentially lazy-loading tools.js):** 90
- **Test files calling setupTestDbOnly() (confirmed no tools.js):** 152
- **Test files with vi.resetModules() in beforeEach():** 38
- **Test files >1000 lines:** 75
- **Test files >500 lines:** 254

---

## Comparison with April 4 baseline

| Finding | April 4 | April 25 | Change |
|---|---|---|---|
| pool mode | forks | threads | FIXED — eliminates per-file module reload |
| database.js eager sub-module loads | 44 top-level requires | 7 (lazy facade) | FIXED |
| task-manager.js dashboard-server | eager require at line 14 | lazy getter | FIXED |
| setupTestDb() split | not available | setupTestDbOnly() present | FIXED |
| files paying tools.js import via setupTestDb | ~164 (eager) | 0 eager; 90 lazy (cost paid only if handleToolCall called) | IMPROVED |
| top-level tools.js require in test files | 22 files | 16 files | IMPROVED (6 migrated) |
| vi.resetModules() in beforeEach | 14 files | 38 files | REGRESSED — 24 new occurrences added |
| test files >1000 lines | 62 | 75 | REGRESSED — 13 new large files added |
| test-helpers.js self-test | present | present | UNCHANGED |

The pool change to `'threads'` is the single most impactful structural fix—it was not part of the April 4 recommendations but addresses the root cause (per-file module reload) more directly than any code change. The `setupTestDbOnly()` split and lazy `database.js` are solid follow-through. The two regressions (`vi.resetModules()` spread and large-file growth) are the primary remaining work items.

---

## Notes for Phase 4 child spec

### Mechanical transformations (Codex-safe, low-risk)

1. **Migrate 17 `setupTestDb()` → `setupTestDbOnly()`** in files that never call `handleToolCall`/`safeTool`. Pure string replacement — no behavioral change because the lazy wrapper was never invoked.
2. **Remove `describe`/`it` stub from `test-helpers.js`** (lines 95-101). No other changes needed.
3. **Migrate 5 metadata-only tools.js files** (`auto-recovery-mcp-tools.test.js`, `mcp-tool-alignment.test.js`, `p2-orphaned-tools.test.js`, `p3-dead-routes.test.js`, `tool-annotations.test.js`) once a lightweight `tool-registry.js` exporting `TOOLS`, `routeMap`, and `schemaMap` without loading handlers is created.

### Requires design attention

4. **Thin tool-registry module** — extracting `TOOLS` (list of tool definitions), `routeMap` (tool-name→handler map), and `schemaMap` without loading the 6 handler modules needs a careful split. Handlers are currently loaded at module-scope inside `TOOL_DEFS` initialization in `tools.js`. The registry module must not require handlers to avoid recreating the import chain.
5. **vi.resetModules() in beforeEach() — audit 38 files** — some are genuinely testing module initialization (config singletons, provider registry cold-start). These need to keep `vi.resetModules()` but should ensure no heavy module is transitively required after the reset. Files whose reset pattern is purely for mock-reset isolation (not module-init testing) can replace with `vi.restoreAllMocks()` or `db.resetForTest()`.
6. **Top-20 file splits** — mechanical at the `describe` block level but requires author judgment on which describe blocks belong together. Split candidates: `agentic-execution-fixes.test.js` (3638 lines, no obvious single describe), `api-server.test.js` (2715 lines, has SSE/routes/core natural splits), `task-core-handlers.test.js` (2360 lines). Priority: top 10 files >1500 lines (10 files total), which account for ~22K lines that could be distributed as ~60-80 smaller files.

### ESLint rule allowlist for `torque/no-heavy-test-imports`

Legitimate `require('../tools')` callers (need `handleToolCall`) — the confirmed allowlist:

```
api-server.test.js, api-server-core.test.js, dashboard-routes.test.js,
eval-mcp-tools.test.js, inbound-webhook-handlers.test.js,
mcp-factory-loop-tools.test.js, mcp-sse.test.js, mcp-streamable-http.test.js,
mcp-tools-plan-file.test.js, p2-workflow-subscribe.test.js,
rest-passthrough-coercion.test.js, rest-passthrough-dispatch.test.js,
restart-drain.test.js, restart-server-tool.test.js, test-hardening.test.js,
tool-schema-validation.test.js, tools-aggregator.test.js,
webhook-idempotency.test.js, webhook-quota-trigger.test.js,
managed-oauth-handlers.test.js, context-handler.test.js
```

### vi.resetModules() files that likely need it (module-init tests)

`config.test.js`, `provider-registry.test.js`, `provider-router.test.js`, `adapter-registry.test.js`, `tda-01-provider-sovereignty.test.js`, `orphan-cleanup.test.js` — these test cold-start or singleton initialization behavior and likely need full module resets. Keep but pair with `setupTestDbOnly()`.
