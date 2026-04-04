# Execution Module Quality Scan
**Date:** 2026-04-04
**Scope:** server/execution/
**Variant:** quality

## Summary
12 findings: 0 critical, 3 high, 6 medium, 3 low.

## Findings

### [HIGH] processQueueInternal is 334 lines with nesting depth 6
- **File:** server/execution/queue-scheduler.js:686
- **Description:** `processQueueInternal()` is 334 lines and performs: budget resets, TTL expiry queries with raw SQL (`db.prepare()`), host capacity checks, resource pressure gating, task categorization, three separate provider-type scheduling loops (ollama, codex, API), overflow handling, and a fallback scan. The raw `db.prepare()` call at line 715 bypasses the DI/abstraction layer. This function has the highest complexity in the execution directory and is difficult to unit test in isolation.
- **Status:** NEW
- **Suggested fix:** Extract the TTL-expiry block (lines 710-732) into a named helper. Extract the three provider-type scheduling loops into `processOllamaTasks()`, `processCodexTasks()`, and `processApiTasks()`. Move the raw SQL to a data-access module.

### [HIGH] startTask is 396 lines with nesting depth 9
- **File:** server/execution/task-startup.js:277
- **Description:** `startTask()` is the longest function in the directory at 396 lines. It handles: preflight checks, provider routing, routing chain propagation, safeguard checks, policy evaluation, atomic slot claims, file resolution, file locking, provider-specific command building (ollama/API/claude-cli/codex), NVM path management, Windows .cmd resolution, baseline commit capture, and process spawning. Nesting reaches 9 levels deep inside the try-catch + provider branching + file lock loop. The function has a try-catch wrapping lines 422-671 that acts as a resource-cleanup block for the claimed slot.
- **Status:** NEW
- **Suggested fix:** Extract the file resolution + locking block (lines 440-491) into `resolveAndLockFiles()`. Extract the provider-specific command building (lines 498-579) into `buildProviderCommand()`. The slot-release catch (lines 656-671) is doing the right thing but the 250-line try body is the problem.

### [HIGH] spawnAndTrackProcess is 330 lines with nesting depth 7
- **File:** server/execution/process-lifecycle.js:340
- **Description:** `spawnAndTrackProcess()` is 330 lines and combines: process spawning, stdin piping, process tracker setup, git SHA storage, instant-exit detection, dashboard notification, stream handler attachment, close handler (with finalization dispatch), error handler (with cleanup and finalization), and startup timeout setup. The close and error handlers are defined inline as async closures, each 50-70 lines. This makes the function hard to test because the close/error behavior is coupled to the spawn lifecycle.
- **Status:** NEW
- **Suggested fix:** Extract the `child.on('close')` handler body into a standalone `handleProcessClose(taskId, code, proc, provider)` function. Same for `child.on('error')`. This makes them individually testable and reduces the parent function by ~150 lines.

### [MEDIUM] handlePostCompletion is 220 lines with nesting depth 8
- **File:** server/execution/completion-pipeline.js:128
- **Description:** `handlePostCompletion()` performs 10+ distinct concerns in sequence: terminal hooks, provider usage recording, circuit-breaker recording, model outcome recording, provider health recording, governance evaluation, webhook dispatch, workflow termination, project dependency resolution, pipeline step advancement, output safeguards, MCP event dispatch, partial output cleanup, coordination claim release, version tracking with raw SQL, and auto-release. Lines 272-346 contain a block with raw `database.getDbInstance()` calls and inline SQL (`rawDb.prepare(...).run(...)`) for commit scanning, which bypasses the DI container and is 75 lines deep.
- **Status:** NEW
- **Suggested fix:** Extract the version-tracking block (lines 272-346) into a `handleVersionTracking(taskId, task)` function in a separate module (e.g., `version-tracking-stage.js`). The raw SQL should live in a data-access module.

### [MEDIUM] Duplicate getEffectiveGlobalMaxConcurrent implementations
- **File:** server/execution/provider-router.js:324, server/execution/queue-scheduler.js:312
- **Description:** Two independent implementations of `getEffectiveGlobalMaxConcurrent()` exist. The queue-scheduler version accepts a `preRead` parameter for pre-fetched config values; the provider-router version does not. Both compute the same thing (auto-compute vs configured max concurrent). The queue-scheduler also uses `_safeConfigInt` (an injected function) while provider-router uses its own `safeConfigInt` local function. This duplication means a bug fix in one version might not be applied to the other.
- **Status:** NEW
- **Suggested fix:** Move `getEffectiveGlobalMaxConcurrent` to a shared module (e.g., `concurrency-limits.js`) and have both callers delegate.

### [MEDIUM] Metadata parsing duplicated 9+ times across execution modules
- **File:** server/execution/fallback-retry.js:211,469, server/execution/queue-scheduler.js:250,645, server/execution/slot-pull-scheduler.js:80,171, server/execution/process-streams.js:88, server/execution/task-finalizer.js:303,320
- **Description:** The pattern `typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {}` (and slight variants) appears at least 9 times in execution modules. Some wrap in try-catch, some don't. A shared `normalizeMetadata` utility exists at `server/utils/normalize-metadata.js` (imported by strategic-hooks.js) but the other 8+ call sites don't use it. This was already noted in the prior code-quality scan as a LOW finding (duplicate normalizeMetadata helpers); this finding documents the full scope within execution/ specifically.
- **Status:** NEW
- **Suggested fix:** Replace all inline metadata-parsing with `normalizeMetadata()` from `server/utils/normalize-metadata.js`. The function already handles string, object, null, and array edge cases.

### [MEDIUM] tryLocalFirstFallback is 148 lines with 4 fallback steps inlined
- **File:** server/execution/fallback-retry.js:205
- **Description:** `tryLocalFirstFallback()` is 148 lines and implements a 4-step fallback cascade (same model different host, different coder model, different local provider, cloud escalation) all in a single function with 6-level nesting. Each step has its own try-catch block, DB update pattern, dashboard notification, and process-queue trigger. Steps 1-3 share a nearly identical pattern: record failover event, update task status with metadata, notify dashboard, trigger queue. This structural duplication adds ~30 lines per step.
- **Status:** NEW
- **Suggested fix:** Extract a `requeueWithFallback(taskId, updates, failoverEvent)` helper that handles the shared update-notify-queue pattern. Each step becomes a 5-line block calling the helper.

### [MEDIUM] tryHashlineTieredFallback is 113 lines with nesting depth 8
- **File:** server/execution/fallback-retry.js:644
- **Description:** `tryHashlineTieredFallback()` follows the same pattern as `tryLocalFirstFallback()` with 3 fallback steps (same model different host, larger hashline-capable model, codex escalation). The nesting reaches 8 because each step is wrapped in a provider check, a local-attempts check, and a try-catch. The same `requeueWithFallback` pattern described above would apply here too.
- **Status:** NEW
- **Suggested fix:** Same as tryLocalFirstFallback: extract the shared requeue pattern. Additionally, consider unifying the two tiered-fallback functions since they share the same 3-step structure (host fallback, model escalation, cloud/codex escalation).

### [MEDIUM] No test coverage for provider-router.js
- **File:** server/execution/provider-router.js (377 lines)
- **Description:** No test file directly imports or tests `provider-router.js`. The `tda-01-provider-sovereignty.test.js` file mentions provider routing but tests it through the task-manager integration, not the router module directly. Functions like `resolveProviderRouting()`, `getProviderSlotLimits()`, `tryReserveHostSlotWithFallback()`, and `tryCreateAutoPR()` have no unit-level test coverage. The auto-PR function involves git operations and external CLI calls that should be tested with mocks.
- **Status:** NEW
- **Suggested fix:** Add `provider-router.test.js` covering routing decisions, slot limits computation, and the auto-PR path with mocked `execFile`.

### [LOW] fallback-retry.js at 1001 lines is a complexity hotspot
- **File:** server/execution/fallback-retry.js (1001 lines)
- **Description:** This module contains 6 major fallback strategies (cloud fallback, local-first fallback, stall recovery, model escalation, hashline tiered fallback, hashline format selection), error classification (127-line function), and delay computation. While each function is individually documented, the module as a whole covers too many responsibilities. It has 14 exported functions.
- **Status:** NEW
- **Suggested fix:** Consider splitting into `fallback-chains.js` (cloud/local/hashline fallback cascades), `stall-recovery.js` (stall detection responses), and `error-classification.js` (the `classifyError` function and pattern tables). Low priority since each function works and has test coverage.

### [LOW] Raw SQL in processQueueInternal TTL expiry
- **File:** server/execution/queue-scheduler.js:715-716
- **Description:** The TTL-expiry block calls `db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'pending') AND created_at < ? AND provider != 'workflow'").all(cutoff)` directly. This bypasses the task-core abstraction layer. The `db` variable here is the injected dependency which may be the database facade, so `prepare()` invokes raw SQLite. This is a minor DI hygiene issue since the rest of the scheduler uses `db.listQueuedTasksLightweight()`, `db.getRunningCount()`, etc.
- **Status:** NEW
- **Suggested fix:** Add a `expireQueuedTasks(cutoffIso)` function to `task-core.js` or the relevant data module and call it from the scheduler.

### [LOW] Inline require() calls in hot paths
- **File:** server/execution/fallback-retry.js:164,336,745, server/execution/task-finalizer.js:265,298,325,356,396,599,617,637,643, server/execution/queue-scheduler.js:689,831
- **Description:** Multiple modules use inline `require()` inside function bodies (not at module top level). While Node.js caches `require()` results after first call (so this is not a performance issue), it obscures dependencies and makes it harder to trace what a module depends on. The `task-finalizer.js` has 10+ inline requires inside `finalizeTask()`. Some are deliberately lazy-loaded to break circular dependencies (documented in process-lifecycle.js), but others (like `require('../database')` in task-finalizer.js lines 600, 618, 643) are not circular — they're convenience shortcuts.
- **Status:** NEW
- **Suggested fix:** Move non-circular inline requires to module top level. For the database facade requires that are DI violations, inject via `init(deps)` instead. Low priority since Node caches modules.
