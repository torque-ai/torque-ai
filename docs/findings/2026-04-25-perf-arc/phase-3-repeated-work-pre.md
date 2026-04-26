# Phase 3 Pre-Flight Scout — Repeated Work + Per-Request Allocations

**Date:** 2026-04-25
**Worktree:** feat-perf-3-repeated-work
**Base commit:** 68c6ba5a4ba5f6e467db3fb1daac3201fbce65fa
**Discipline rule:** Module-level memoization for invariant computations; per-request allocations require justification (per umbrella §3.3)

## Summary

7 open findings across 5 files. Two are MEDIUM — the `getCapabilitySet` per-cycle allocation in `slot-pull-scheduler.js` (new Set wrapping per slot heartbeat call, per provider) and the `listTasks` JSON-parse per row for `tags`/`files_modified`/`context` columns even when callers use projection but don't need parsed form. Three are LOW — invariant literal Sets allocated inside hot functions (`paidProviders` in `provider-router.js:287` per task routing call; two `_gpuSharingProviders`/`_ollamaGpuProviders` Sets inside `processQueueInternal`/`createProviderRuntimeState` per scheduler tick; and `hasThresholdConfigColumn` PRAGMA re-run per budget-status build). Two prior HIGH findings from the scans (`getAllowedOrigins` Set per SSE request; `dashboard-server.js existsSync` per request) are CONFIRMED CLOSED. The `getAuditLogColumns` and `getTaskFileChangeColumns` PRAGMA caches are confirmed closed. `chunked-review.js readFileSync` remains open as a Phase 1/2 deferral with a sync-io annotation but is excluded here as it was explicitly grandfathered in Phase 1 scope boundary.

---

## Findings

### [MEDIUM] slot-pull-scheduler: new Set(getProviderCapabilities(provider)) allocated per heartbeat per provider

- **File:** `server/execution/slot-pull-scheduler.js:99`
- **Pattern:** `findBestTaskForProvider(provider, excludeIds)` creates `new Set(capabilities.getProviderCapabilities(provider))` on every call. `getProviderCapabilities` always returns a new array — either `[...profile.capabilities]` (spread from the frozen `DEFAULT_CAPABILITIES` constant) or a JSON-parsed DB result. The resulting Set is then immediately used for `required.every(r => providerCaps.has(r))` and discarded. The default capabilities table (`DEFAULT_CAPABILITIES`) is fully static at process start.
- **Secondary site:** `server/db/provider-capabilities.js:58` — `meetsCapabilityRequirements` allocates a new Set on every call. `server/handlers/integration/routing.js:142` — `providerSupportsRepoWriteTasks` allocates a new Set on every call.
- **Hot-path context:** `findBestTaskForProvider` is called from `runSlotPullPass` (the slot-pull scheduler heartbeat). In a factory environment with 5 active providers and tasks waiting, this fires every heartbeat tick (typically every 1-5s) — allocating 5+ Sets per tick. When all slots are competing (peak load), this ticks rapidly.
- **Was in prior scan?** No — this specific callsite was not flagged in prior scans.
- **Fix shape:** Cache the capability Set per provider in `provider-capabilities.js` at module level: `const _capabilitySetCache = new Map()`. Populate on first call per provider (using DB value if configured, or `DEFAULT_CAPABILITIES` fallback). Invalidate on `setDb()` or when provider config changes. Because the default capabilities are process-invariant, the common case requires no invalidation. Alternatively, expose `getProviderCapabilitySet(provider)` that returns a cached Set directly.
- **Severity rationale:** MEDIUM. The allocation is small (5-10 element Set), but it fires per-provider-per-heartbeat-tick during active scheduling. The real cost is the intermediate array allocation from `[...profile.capabilities]` inside `getProviderCapabilities` plus the Set construction on every call. With factory throughput (50+ concurrent tasks), this is unnecessary GC pressure.

---

### [MEDIUM] listTasks: JSON.parse per row for tags/files_modified/context when projection is active but callers don't need parsed values

- **File:** `server/db/task-core.js:972-979`
- **Pattern:** `listTasks` always applies `safeJsonParse` to any row that contains `context`, `files_modified`, or `tags` columns — regardless of whether the caller actually uses the parsed form. The projection-aware `columns:` option correctly skips blob columns (output, error_output, context) when not requested, but when callers request `tags` or `files_modified` for filtering, the post-processing still parses them. The primary dashboard task-list endpoint (`v2-task-handlers.js:499-505`) requests `files_modified` and `tags` in its projection and uses `buildTaskResponse` which reads `task.tags` at line 857 (needs parsed form), but many analytics and infrastructure endpoints that request `metadata` only need the raw string for further `JSON.parse` themselves (e.g., `v2-analytics-handlers.js:515`).
- **Hot-path context:** `/api/v2/tasks` (Kanban list, dashboard poll) fires on every dashboard refresh (default 2-5s). With 1000 tasks at default limit, `listTasks` runs 3 `safeJsonParse` calls per row = 3000 JSON.parse calls per request. `TASK_LIST_COLUMNS` includes both `files_modified` and `tags`; `TASK_ROUTING_DECISION_COLUMNS` includes `metadata`. The analytics handlers parse `metadata` again after `listTasks` returns it already-parsed.
- **Was in prior scan?** Yes — `2026-04-04-runtime-performance-scan.md` finding #10 suggested a `raw: true` option. Partially addressed: column projection was added (avoiding the largest blobs), and `listQueuedTasksLightweight` was added for the scheduler path. But the general `listTasks` per-row JSON parsing for tag/files_modified columns remains.
- **Fix shape:** Two complementary approaches:
  1. **`raw: true` option** — skip `safeJsonParse` entirely, return raw strings. Callers that need parsed values call `safeJsonParse` themselves. Suitable for analytics handlers that immediately re-parse `metadata`.
  2. **Lazy parse wrapper** — return a thin proxy/getter where parsing is deferred until the field is accessed. This is more invasive; approach 1 is simpler.
  The highest-value quick win: for `TASK_ROUTING_DECISION_COLUMNS` callers that immediately re-parse `metadata`, pass `raw: true` to skip the redundant parse/reparse cycle.
- **Severity rationale:** MEDIUM. The projection column work already removed the biggest cost (multi-MB blob reads). The remaining per-row JSON parsing is small per call but fires 1000+ times per dashboard poll. The `raw: true` fix is straightforward and measurable.

---

### [LOW] provider-router.js: new Set(['anthropic', 'groq', 'codex', 'claude-cli']) allocated per task routing call

- **File:** `server/execution/provider-router.js:287`
- **Pattern:** `resolveProviderRouting(task, taskId)` creates `const paidProviders = new Set(['anthropic', 'groq', 'codex', 'claude-cli'])` on every invocation. This is a 4-element invariant Set — the contents never change. It is used immediately at line 305 (`paidProviders.has(normalizedRequestedProvider)`) and discarded.
- **Hot-path context:** Called once per task start from `task-startup.js`. In a busy factory batch (50 tasks/minute), this allocates 50 Sets per minute that are all identical.
- **Was in prior scan?** No.
- **Fix shape:** Hoist to module-level constant: `const PAID_PROVIDERS = new Set(['anthropic', 'groq', 'codex', 'claude-cli'])`. Zero behavior change.
- **Severity rationale:** LOW. 4-element Set allocation is trivial; the fix is a one-liner. Flagged for completeness as a canonical example of the pattern class.

---

### [LOW] queue-scheduler: two invariant ollama Sets allocated per scheduler tick

- **File:** `server/execution/queue-scheduler.js:438` (inside `createProviderRuntimeState`), `server/execution/queue-scheduler.js:841` (inside `processQueueInternal`)
- **Pattern:**
  - Line 438: `const _gpuSharingProviders = new Set(['ollama'])` allocated inside `createProviderRuntimeState()` which is called from `processQueueInternal` on every scheduler tick.
  - Line 841: `const _ollamaGpuProviders = new Set(['ollama'])` allocated inside `processQueueInternal` directly.
  Both are 1-element Sets containing the literal string `'ollama'`. They are invariant across the process lifetime.
- **Hot-path context:** `processQueueInternal` runs every scheduler tick (typically every 2-5s). Two identical 1-element Sets are allocated and immediately GC'd per tick.
- **Was in prior scan?** No.
- **Fix shape:** Hoist both to module-level constants. The comment at line 840-841 documents why the set exists (GPU-sharing provider documentation) — keep the comment at the module-level constant.
- **Severity rationale:** LOW. 1-element Sets are extremely cheap. The fix is mechanical.

---

### [LOW] budget-watcher: hasThresholdConfigColumn PRAGMA re-executed on every buildBudgetStatus call

- **File:** `server/db/budget-watcher.js:160-162`, called from `:187`, `:205`
- **Pattern:** `hasThresholdConfigColumn(database)` runs `PRAGMA table_info(cost_budgets)` and scans the result on every call. It has no module-level cache. It is called twice per `buildBudgetStatus` call: once via `ensureThresholdConfigStorage` (line 187) and once in `readThresholdConfig` (line 205). `buildBudgetStatus` is called once per enabled budget in `listBudgetsWithStatus` (line 422, 435) and from dashboard budget endpoints.
- **Hot-path context:** Not on the task submission hot path (`isBudgetExceeded` in cost-tracking.js does not call `buildBudgetStatus`). Called from `/api/v2/budgets` and the budget dashboard panel. With N enabled budgets, each call to list budget statuses runs 2N PRAGMA queries. Frequency: dashboard poll (5-30s) × N budgets.
- **Was in prior scan?** Partially — the prior scan found the `getAuditLogColumns` PRAGMA pattern (since fixed) and noted `getTaskFileChangeColumns` as a secondary example (also fixed). The `hasThresholdConfigColumn` equivalent was not explicitly flagged.
- **Fix shape:** Add module-level boolean cache: `let _hasThresholdConfigColumnCache = null`. Return cached value on subsequent calls. Pattern matches the already-fixed `getAuditLogColumns` cache in `scheduling-automation.js:59`.
- **Severity rationale:** LOW. PRAGMA is ~0.1ms; the function fires on dashboard polls, not task execution hot paths. But it is a pure unnecessary repeated query of invariant schema state.

---

### [LOW] pack-registry: PRAGMA table_info re-executed on every listPacks/registerPack call

- **File:** `server/db/pack-registry.js:13-21` (getPackRegistryColumnInfo), called from `:24` (getPackRegistryColumns), `:100` (registerPack), `:151` (listPacks)
- **Pattern:** `getPackRegistryColumnInfo()` runs `PRAGMA table_info(pack_registry)` on every call with no caching. It is called from both `listPacks` and `registerPack`. `getPackRegistryColumns()` wraps the result in `new Set(...)` — so every `listPacks` call does an uncached PRAGMA + a new Set construction.
- **Hot-path context:** Not a request-critical hot path. Pack registry is only accessed by the `register_pack`, `list_packs`, and `get_pack` MCP tools, which are rarely used. Included for completeness.
- **Was in prior scan?** No.
- **Fix shape:** Add module-level cache: `let _packRegistryColumnInfoCache = null`. Return cached value on subsequent calls. Same as the `getTaskFileChangeColumns` pattern.
- **Severity rationale:** LOW. Pack registry is cold-path; this is a cosmetic fix.

---

## Coverage

- Files scanned: `server/handlers/**/*.js`, `server/db/**/*.js`, `server/api/**/*.js`, `server/dashboard-server.js`, `server/mcp-sse.js`, `server/execution/**/*.js`, `server/maintenance/**/*.js`
- Total per-request allocations identified: 4 (capability Sets ×3 callsites, paidProviders Set ×1)
- Total repeated-work patterns identified: 4 (PRAGMA: budget-watcher ×1, pack-registry ×1; JSON.parse per row in listTasks; scheduler invariant Sets ×2)
- Total resolved-since-prior-scan: 5 (see table below)

---

## Resolved findings (already closed)

| Finding | Source | Status |
|---|---|---|
| `dashboard-server.js` `existsSync` per static request | 2026-04-04-runtime-performance-scan | RESOLVED — `DASHBOARD_STATIC_DIR` const cached at module load (`server/dashboard-server.js:84`); file-level eslint-disable annotation confirms this is startup-only |
| `getAllowedOrigins()` new Set per SSE HTTP request | 2026-04-04-full-performance-scan | RESOLVED — now `const ALLOWED_ORIGINS = new Set([...])` at module level (`server/mcp-sse.js:92-95`); `invalidateAllowedOriginsCache()` retained as a no-op for backward compat |
| `getAuditLogColumns()` PRAGMA re-executed per audit write | 2026-04-04-full-performance-scan, 2026-04-25-perf-arc/phase-2-nplusone-pre.md | RESOLVED — `_auditLogColumnsCache` module-level variable added (`server/db/scheduling-automation.js:59`); cache populated on first call, returned on all subsequent calls |
| `getTaskFileChangeColumns()` PRAGMA re-executed per file change record | 2026-04-04-full-performance-scan | RESOLVED — `_taskFileChangeColumnsCache` module-level Set added (`server/db/task-metadata.js:42-48`); guard check on every call |
| `chunked-review.js readFileSync` in `generateReviewChunks` on MCP handler thread | 2026-04-04-full-performance-scan | GRANDFATHERED in Phase 1 scope — still present at `server/chunked-review.js:384`; not a Phase 3 finding (sync-io pattern, not repeated-work pattern). Not addressed here. |

---

## Notes for Phase 3 child spec

### Findings cluster into two natural groups:

**Group A — Invariant-Set hoisting (mechanical, zero risk):**
- `provider-router.js:287` — hoist `PAID_PROVIDERS`
- `queue-scheduler.js:438, 841` — hoist `GPU_SHARING_PROVIDERS` and `OLLAMA_GPU_PROVIDERS`
- These are one-liner changes with no behavior risk. Can be batched in a single Codex task.

**Group B — Capability Set memoization (slightly more involved):**
- `provider-capabilities.js` — add module-level `Map<provider, Set<capability>>` cache in `getProviderCapabilities` or add a new `getProviderCapabilitySet(provider)` method that returns a cached Set.
- Invalidation: cache should be cleared when `setDb()` is called (new DB instance) or when a provider's `capability_tags` DB record is updated (rare). A simple solution: check if `_db` has changed; if not, return cached Set for that provider.
- Callers to update: `slot-pull-scheduler.js:99`, `provider-capabilities.js:58` (meetsCapabilityRequirements), `routing.js:142`.

**Group C — PRAGMA caches (copy-paste from existing fixed pattern):**
- `budget-watcher.js` — add `_hasThresholdConfigColumnCache` boolean guard. Pattern matches `scheduling-automation.js:59`.
- `pack-registry.js` — add `_packRegistryColumnInfoCache` array guard. Pattern matches `task-metadata.js:42-48`.
- Both are one-file edits, no cross-file impact.

**Group D — listTasks raw mode (small scope, high measurement value):**
- Add `raw: true` option to `listTasks` that skips post-processing `safeJsonParse` calls.
- Update `TASK_ROUTING_DECISION_COLUMNS` callers in `v2-analytics-handlers.js` that immediately re-parse `task.metadata` themselves.
- This is the highest-measurement-value fix: dashboard `/api/v2/tasks` Kanban poll is metric #4 in the perf harness (`getProjectStats`, 1000 tasks, Median of 50). A `raw: true` flag for metadata-only callers removes 1000 JSON.parse calls per poll cycle.

### Per-handler call-counter metrics for perf harness

The umbrella §3.3 note suggests per-handler call-counter visibility. For Phase 3, the most informative metrics would be:
- Slot-pull heartbeat: count of Sets allocated per `runSlotPullPass` invocation
- `listTasks` calls that request `tags`/`metadata` columns: parse count vs raw count
- Budget status rebuild frequency: PRAGMA calls per minute at dashboard poll rate

These can be tracked via the existing `server/perf/` harness by adding instrumentation to `slot-pull-scheduler.js:findBestTaskForProvider` and `task-core.js:listTasks`.

### Pure code-review findings (no formal lint/test gate possible)

The invariant-Set hoisting and PRAGMA cache findings (Groups A, B, C) have no mechanical lint enforcement — the discipline rule §3.3 relies on code review. The Phase 3 child spec should include a code review checklist item: "Invariant Sets/Maps constructed inside handler/scheduler functions must be justified or hoisted to module level."

### listTasks raw mode is the dominant signal

The `listTasks` JSON.parse per row is the single finding with a direct mapping to tracked perf metric #9 ("DB: `listTasks` 1000 rows (raw vs parsed)"). All other Phase 3 findings are micro-optimizations with sub-millisecond individual impact. The `raw: true` flag is the implementation with the most measurable baseline improvement.

### No formal enforcement gate

Per umbrella §3.3, Phase 3 has no hard enforcement gate (unlike Phase 1's ESLint rule or Phase 2's prepare-counter). The discipline relies on:
1. Dashboard panel showing per-handler allocation counts (future instrumentation)
2. Code review checklist for new handler code
3. Perf harness regression gate on `listTasks` raw vs parsed metric
