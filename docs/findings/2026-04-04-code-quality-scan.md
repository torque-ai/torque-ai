# Code Quality & Maintainability Scan
Date: 2026-04-04
Scope: server/execution/, server/handlers/, server/api/, server/plugins/
Agent: code-scout

## Summary
10 findings: 0 critical, 3 high, 5 medium, 2 low.

## Findings

### [HIGH] Direct database.js imports bypass DI container in handlers
- File: server/handlers/competitive-feature-handlers.js:59, server/handlers/concurrency-handlers.js:6, server/handlers/discovery-handlers.js:4, server/handlers/model-registry-handlers.js:4,54, server/handlers/provider-crud-handlers.js:4
- Description: Six handler modules still call `require('../database')` or `.getDbInstance()` directly instead of receiving `db` via `init()` or the DI container. This defeats the DI migration and makes these modules hard to test in isolation.
- Status: NEW
- Suggested fix: Add `init(deps)` or `createXxx(deps)` factory accepting `db`; wire through container.js.

### [HIGH] Direct database.js imports in execution/ hot path
- File: server/execution/task-finalizer.js:600,618,643, server/execution/fallback-retry.js:563, server/execution/completion-pipeline.js:100,275, server/execution/strategic-hooks.js:5
- Description: Task finalizer calls `require('../database')` three times inside the finalization function body (scoring, budget, resume-context). These are inline requires on every task completion. Strategic-hooks imports the facade at module top level.
- Status: NEW
- Suggested fix: Inject `db` via the existing `init(deps)` pattern. The finalizer already receives `deps.db` — use it instead of re-requiring.

### [HIGH] Raw SQL with direct DB handle in model-registry-handlers
- File: server/handlers/model-registry-handlers.js:7-23,66
- Description: `handleListModels` constructs SQL with `db.prepare(query).all()` directly on the raw SQLite handle. `handleAssignModelRole` runs raw `INSERT OR REPLACE`. No DI, no abstraction layer, and no test coverage (no test file found referencing model-registry-handlers).
- Status: NEW
- Suggested fix: Move queries into a `db/model-registry.js` data module; add handler tests.

### [MEDIUM] No test coverage for plan-project-resolver.js
- File: server/execution/plan-project-resolver.js (135 lines)
- Description: No test file references this module. It handles plan-project dependency resolution on task completion — a correctness-sensitive path.
- Status: NEW
- Suggested fix: Add plan-project-resolver.test.js covering completion and failure paths.

### [MEDIUM] No test coverage for file-context-builder.js
- File: server/execution/file-context-builder.js (298 lines)
- Description: No test file references this module. It builds context-stuffing payloads for free providers — incorrect context could cause task failures.
- Status: NEW
- Suggested fix: Add file-context-builder.test.js covering token budgeting and file resolution.

### [MEDIUM] Excessive debug logging in workflow-runtime pipeline handler
- File: server/execution/workflow-runtime.js:401-435
- Description: `handlePipelineStepCompletion` has 10+ `logger.info()` calls with verbose JSON dumps (e.g., line 403 logs full task context). These are permanent info-level logs, not debug-level, producing noise in production.
- Status: NEW
- Suggested fix: Downgrade to `logger.debug()` or consolidate into 2-3 structured log lines.

### [MEDIUM] workflow-runtime.js at 1290 lines — complexity hotspot
- File: server/execution/workflow-runtime.js (1290 lines)
- Description: Contains pipeline handling, workflow DAG evaluation, output injection, conflict resolution dispatch, audit integration, and documentation generation. Multiple concerns in one file.
- Status: NEW
- Suggested fix: Extract pipeline step handling (~100 lines) and audit integration (~40 lines) into separate modules.

### [MEDIUM] Synchronous execFileSync in provider-router auto-PR path
- File: server/execution/provider-router.js:125,137,150,162
- Description: The auto-PR creation path calls `execFileSync` four times (git rev-parse, git log, git push, gh pr create). These block the event loop and could stall queue processing if git/gh is slow or the remote is unreachable.
- Status: NEW
- Suggested fix: Convert to async `execFile` with a timeout, or run in a worker thread.

### [LOW] Duplicate `normalizeMetadata` / `normalizeTaskStartOutcome` helpers
- File: server/execution/strategic-hooks.js:19, server/execution/queue-scheduler.js:124, server/api/v2-task-handlers.js:50
- Description: At least three modules define their own `normalizeMetadata` or metadata-parsing helpers with nearly identical logic (parse JSON string to object, handle null/array/string). No shared utility exists.
- Status: NEW
- Suggested fix: Extract a shared `utils/normalize-metadata.js` and reuse across modules.

### [LOW] process.on('queue-changed') listener leak potential
- File: server/execution/queue-scheduler.js:104-121
- Description: `init()` registers a process-level event listener. While it removes the previous one, calling `init()` without `stop()` in tests could accumulate listeners. The `removeStaleQueueChangedListeners` cleanup (line 68) mitigates this but relies on a Symbol tag that only matches listeners created by this module.
- Status: NEW
- Suggested fix: Add a guard in `init()` that calls `stop()` first, or document the cleanup contract.
