# Full-Project Code Quality Scan
Date: 2026-04-04
Scope: server/api/, server/handlers/, server/db/, server/plugins/, server/mcp/, server/validation/, server/routing/ (excluding server/execution/ — scanned separately)
Agent: quality-scout

## Summary
18 findings: 0 critical, 5 high, 8 medium, 5 low.

## Findings

### [HIGH] DI bypass: competitive-feature-handlers.js has 5 inline require('../database') calls
- File: server/handlers/competitive-feature-handlers.js:59,117,134,157,171
- Description: Five handler functions each call `require('../database').getDbInstance()` inline. The module has no `init(deps)` or factory that accepts a db handle, making it untestable in isolation and inconsistent with the DI migration. Every call repeats the same defensive `database.getDbInstance ? database.getDbInstance() : null` pattern.
- Status: NEW
- Suggested fix: Add a `createCompetitiveFeatureHandlers(deps)` factory that receives `{ db }` and close over it, or add `init(deps)` following the pattern in other handler files.

### [HIGH] DI bypass: v2-analytics-handlers.js uses raw SQL via getDbInstance()
- File: server/api/v2-analytics-handlers.js:238
- Description: `handleModelStats` calls `dbModule.getDbInstance()` to run raw SQL (`db.prepare(...)`) for model/provider aggregation. The module top-level imports `require('../database')` at line 11 and uses it to escape the DI container. No `init(deps)` pattern passes db through; the factory `createV2AnalyticsHandlers` at line 668 does not inject a db handle.
- Status: NEW
- Suggested fix: Pass the raw DB handle (or a dedicated analytics data-access module) through the factory's `_deps` parameter.

### [HIGH] DI bypass: v2-infrastructure-handlers.js constructs RemoteAgentRegistry from getDbInstance()
- File: server/api/v2-infrastructure-handlers.js:478-482
- Description: `_getRegistry()` calls `dbModule.getDbInstance()` and constructs `new RemoteAgentRegistry(rawDb)` directly. This duplicates registry construction done in the remote-agents plugin (server/plugins/remote-agents/index.js:47) and in v2-core-handlers.js:52, and in tools.js:302. Four separate `new RemoteAgentRegistry(getDbInstance())` sites create independent registry instances rather than sharing one through the container.
- Status: NEW
- Suggested fix: Register a singleton `agentRegistry` in the DI container during plugin install; inject it into v2-infrastructure-handlers and v2-core-handlers via their init/factory functions.

### [HIGH] DI bypass: handlers/workflow/index.js imports database.js facade directly
- File: server/handlers/workflow/index.js:7
- Description: Top-level `const database = require('../../database')` with `database.getDbInstance()` at line 469 for raw SQL. This is a 1515-line file on the critical workflow path. The module does not receive db via `init()` or factory — it hard-requires the facade.
- Status: NEW
- Suggested fix: Add `init(deps)` that receives `{ db }` or use the existing `createWorkflowHandlers(_deps)` factory to inject the handle.

### [HIGH] DI bypass: handlers/validation/index.js imports database.js facade directly
- File: server/handlers/validation/index.js:12
- Description: Top-level `const database = require('../../database')` in a 982-line validation handler. No `init(deps)` accepts a db handle. This module also uses `execFileSync` for git operations (line 160), which blocks the event loop during validation.
- Status: NEW
- Suggested fix: Wire db through factory injection, and convert the synchronous git calls to async where possible.

### [MEDIUM] Stale metric prefix "codexbridge_" in Prometheus metrics
- File: server/db/provider-routing-core.js:340-576
- Description: `getPrometheusMetrics()` (237 lines) emits ~25 metric families all prefixed `codexbridge_` (the old project name). TORQUE is the current name. The prefix is also hardcoded in the coordination handler (server/handlers/advanced/coordination.js:844) and tested in server/tests/provider-routing.test.js. This is a public-facing API surface — renaming requires a coordinated migration.
- Status: NEW
- Suggested fix: Rename prefix to `torque_` with a deprecation period: emit both old and new prefixes for one release, then drop the old prefix. Update tests.

### [MEDIUM] Duplicate RemoteAgentRegistry construction across 4 non-test files
- File: server/api/v2-core-handlers.js:52, server/api/v2-infrastructure-handlers.js:482, server/plugins/remote-agents/index.js:47, server/tools.js:302
- Description: Each site creates `new RemoteAgentRegistry(db.getDbInstance())` independently. This means four in-memory registry objects exist, each with its own state, rather than one authoritative instance. The plugin already creates one during install — the other three should reuse it.
- Status: NEW
- Suggested fix: Register the registry in the container during plugin install; resolve it from the container in the other three sites.

### [MEDIUM] Complexity hotspot: handleSmartSubmitTask is 963 lines
- File: server/handlers/integration/routing.js:271-1233
- Description: A single function spanning 963 lines handles provider routing, versioning validation, project defaults resolution, cost estimation, context stuffing, tuning overrides, baseline capture, policy evaluation, and task creation. This is the longest function in the scanned scope and combines at least 8 distinct concerns.
- Status: NEW
- Suggested fix: Extract into phases: (1) validate + normalize, (2) route provider, (3) apply tuning/context, (4) capture baselines, (5) create task. Each can be a named function called from the orchestrator.

### [MEDIUM] Complexity hotspot: runOutputSafeguards is 675 lines
- File: server/validation/output-safeguards.js:83-757
- Description: Single function combining file validation, syntax scoring, build checks, quality scoring, approval gates, auto-rollback, retry scheduling, XAML validation, and provider stats recording. High nesting (5+ levels at lines 130-155). Function uses module-level `db` reference set by `init()`.
- Status: NEW
- Suggested fix: Split into pipeline stages: (1) file validation, (2) syntax + quality scoring, (3) approval/rollback decisions, (4) XAML-specific checks, (5) stats recording.

### [MEDIUM] Complexity hotspot: analyzeTaskForRouting is 543 lines
- File: server/db/smart-routing.js:71-613
- Description: Single function performing category classification, provider health checks, template evaluation, fallback chain walking, capacity checks, cost estimation, and safety net application. Contains a 32-line inline `applyProviderSafetyNet` closure and raw SQL at line 97.
- Status: NEW
- Suggested fix: Extract the safety-net logic and the capacity/health check loop into named functions.

### [MEDIUM] No test coverage for mcp/tool-mapping.js (641 lines)
- File: server/mcp/tool-mapping.js
- Description: Contains `mapTaskToolCall` (323 lines) and `validateToolArgumentsSemantics` (238 lines) — both are critical dispatch-path functions that translate v1 namespaced tool names into internal calls. No dedicated test file exists. A bug in mapping silently drops or misroutes tool calls.
- Status: NEW
- Suggested fix: Add tool-mapping.test.js covering at least the 15+ tool name mappings and the semantic validation branches.

### [MEDIUM] No test coverage for remote-test-routing.js (459 lines)
- File: server/plugins/remote-agents/remote-test-routing.js
- Description: Contains `createRemoteTestRouter` (367 lines) which decides whether to run verify/test commands locally or remotely. This is the core routing decision for the remote workstation feature. No dedicated test file was found.
- Status: NEW
- Suggested fix: Add remote-test-routing.test.js covering local fallback, remote routing, and error handling paths.

### [MEDIUM] No test coverage for build-verification.js (349 lines)
- File: server/validation/build-verification.js
- Description: Runs build verification commands (spawnSync) as part of the close-handler pipeline. Uses platform-specific spawn strategies (lines 255/265/275 for Unix/Windows/fallback). No dedicated test file.
- Status: NEW
- Suggested fix: Add build-verification.test.js with mocked spawnSync covering the platform branches.

### [LOW] db/provider-performance.js calls _db.getDbInstance() despite receiving db via setDb()
- File: server/db/provider-performance.js:12,35
- Description: Module receives `_db` via `setDb(db)`, but then calls `_db.getDbInstance()` to get the raw handle. This means the injected value must be the full database facade (not the raw db handle), coupling this module to the facade shape. All other db/ modules that use `setDb()` receive the raw handle directly.
- Status: NEW
- Suggested fix: Change `setDb()` to accept and store the raw db instance directly, consistent with other db/ modules.

### [LOW] Inconsistent DB accessor patterns across handlers
- File: server/handlers/concurrency-handlers.js:5-13, server/handlers/provider-crud-handlers.js:22-30
- Description: Two different handler files define their own local `getDb()` / `getDatabaseHandle()` helpers with identical logic (try `database.getDb()`, fallback to `database.getDbInstance()`). At least 4 other handlers inline the same pattern. No shared utility exists.
- Status: NEW
- Suggested fix: Extract a shared `utils/get-db-handle.js` or centralize in the database facade module.

### [LOW] No test coverage for concurrency-handlers.js, provider-crud-handlers.js, discovery-handlers.js
- File: server/handlers/concurrency-handlers.js (242 lines), server/handlers/provider-crud-handlers.js (745 lines), server/handlers/discovery-handlers.js (54 lines)
- Description: These three handler modules have zero test files referencing them. `provider-crud-handlers.js` at 745 lines handles API key management (set/clear/get), provider CRUD, and cache invalidation — sensitive operations that warrant test coverage.
- Status: NEW
- Suggested fix: Add test files, prioritizing provider-crud-handlers.js (key management) and concurrency-handlers.js (slot management).

### [LOW] db/throughput-metrics.js lazy-requires database as fallback despite DI
- File: server/db/throughput-metrics.js:14-18
- Description: Module declares `setDb()` for DI but immediately falls back to `require('../database')` in `getDbInstanceOrThrow()` if the injected instance is null. The comment says "avoids circular require" but the fallback re-introduces the circular dependency path. If `setDb()` is always called during boot, the fallback is dead code; if not, it masks a wiring bug.
- Status: NEW
- Suggested fix: Remove the lazy require fallback and let the missing-db error surface. If setDb() isn't always called, fix the wiring in container.js.

### [LOW] getPrometheusMetrics() is 237 lines of sequential raw SQL in a db/ module
- File: server/db/provider-routing-core.js:340-576
- Description: The function executes 12+ separate `db.prepare().all()` queries sequentially, each building metric strings. No caching, no batching. This is called on every `/metrics` scrape. While each query is fast individually, the aggregate latency grows with table sizes.
- Status: NEW
- Suggested fix: Consider caching the metric output for 10-30 seconds (scrape intervals are typically 15-60s), or batch the queries into a single SQL union.

## Files > 1000 Lines in Scope (Complexity Hotspots)

| File | Lines | Notes |
|------|-------|-------|
| server/db/schema-tables.js | 3314 | Single `createTables` function (3047 lines) — DDL-only, acceptable |
| server/handlers/workflow/await.js | 1980 | Two 400+ line functions (handleAwaitWorkflow, handleAwaitTask) |
| server/db/provider-routing-core.js | 1515 | 237-line Prometheus function, 543-line routing function |
| server/handlers/workflow/index.js | 1515 | DI bypass, no factory injection |
| server/handlers/task/core.js | 1496 | handleSubmitTask (323 lines) |
| server/handlers/integration/routing.js | 1446 | handleSmartSubmitTask (963 lines) |
| server/validation/post-task.js | 1469 | runOutputSafeguards (675 lines) |
| server/mcp/index.js | 1462 | executeInternalMcpTool (305 lines), DI bypass (2 requires) |
| server/plugins/snapscope/tool-defs.js | 1413 | Data definitions — acceptable |
| server/handlers/provider-ollama-hosts.js | 1418 | Multiple 100+ line formatting functions |
| server/api/v2-governance-handlers.js | 1387 | handleSystemStatus with deep nesting |
| server/db/workflow-engine.js | 1386 | Expression parser (tokenize + parse) is complex but well-structured |
| server/db/analytics.js | 1335 | Many small functions — acceptable decomposition |
| server/db/webhooks-streaming.js | 1290 | Reasonable decomposition for feature scope |
| server/api/routes.js | 1283 | Route registration — acceptable |
| server/handlers/webhook-handlers.js | 1264 | sendWebhook (267 lines) |
| server/api/v2-inference.js | 1196 | executeV2ProviderInference (511 lines), runV2AsyncTask (348 lines) |
| server/db/host-management.js | 1195 | Multiple concerns but well-factored |
| server/handlers/task/intelligence.js | 1156 | Multiple handler functions — acceptable |
| server/handlers/task/pipeline.js | 1141 | Pipeline orchestration |
| server/api/v2-core-handlers.js | 1112 | DI bypass (RemoteAgentRegistry construction) |
| server/handlers/provider-tuning.js | 1116 | Multiple handler functions |
| server/handlers/automation-handlers.js | 1110 | Feature batch orchestration |
| server/db/file-tracking.js | 1094 | Reasonable for file tracking scope |
| server/handlers/advanced/intelligence.js | 1091 | Multiple handler functions |
| server/handlers/integration/infra.js | 1058 | Scan/audit integration |
| server/db/scheduling-automation.js | 1043 | Cron scheduling |
| server/handlers/integration/index.js | 1007 | Integration aggregator |
| server/handlers/advanced/coordination.js | 1005 | Agent coordination |
| server/db/file-quality.js | 1003 | Quality assessment |

## Pattern Summary

| Pattern | Count | Severity |
|---------|-------|----------|
| Direct `require('../database')` in scan scope (non-test) | 18 files | HIGH (DI bypass) |
| `getDbInstance()` calls in scan scope (non-test) | 12 files | HIGH (raw SQL access) |
| Functions > 300 lines | 12 functions | MEDIUM (complexity) |
| Functions > 100 lines | 30+ functions | LOW (monitor) |
| Empty `catch {}` blocks | ~50+ instances | LOW (most are intentional safe-defaults) |
| Handler files with no tests | 5 files | MEDIUM (coverage gap) |
| Duplicate RemoteAgentRegistry construction | 4 non-test sites | MEDIUM (instance proliferation) |
| Duplicate getDatabaseHandle/getDb patterns | 6+ files | LOW (code duplication) |
