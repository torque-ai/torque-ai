# Phase 3 Post-Flight — Repeated Work & Per-Request Allocations

**Date:** 2026-04-25
**Branch:** feat/perf-3-repeated-work
**Status:** ALL PRE-FLIGHT FINDINGS CLOSED

## Closures

| Severity | Location | Finding | Resolution |
|----------|----------|---------|------------|
| MEDIUM | `slot-pull-scheduler.js:99` | `new Set(capabilities.getProviderCapabilities(provider))` per tick per provider | Replaced with `capabilities.getProviderCapabilitySet(provider)` — Map-backed cache in `provider-capabilities.js`, O(1) after first call per provider |
| MEDIUM | `task-core.js:972-979` | `safeJsonParse` for tags/files_modified/context per row, always | Added `options.raw` branch; callers that do not need parsed JSON opt in with `raw: true`. v2-analytics routing decisions handler updated. |
| LOW | `provider-router.js:287` | `new Set(['anthropic','groq','codex','claude-cli'])` per routing call | Hoisted to module-level `PAID_PROVIDERS` constant |
| LOW | `queue-scheduler.js:438` | `new Set(['ollama'])` per `createProviderRuntimeState` call | Hoisted to module-level `GPU_SHARING_PROVIDERS` constant |
| LOW | `queue-scheduler.js:841` | `new Set(['ollama'])` per `processQueueInternal` call | Hoisted to module-level `OLLAMA_GPU_PROVIDERS` constant |
| LOW | `budget-watcher.js:160-162` | `PRAGMA table_info(cost_budgets)` per `buildBudgetStatus` | Cached in `_hasThresholdConfigColumnCache` (WeakMap keyed by db instance); new db instance auto-clears |
| LOW | `pack-registry.js:13-21` | `PRAGMA table_info(pack_registry)` per `listPacks`/`registerPack` | Cached in `_packRegistryColumnInfoCache`; cleared on `setDb()` |

## Already Closed (confirmed pre-flight)

- `dashboard-server.js existsSync` — closed in Phase 1 (`DASHBOARD_STATIC_DIR` constant)
- `getAllowedOrigins()` Set — closed pre-arc (`ALLOWED_ORIGINS` module-level constant in `mcp-sse.js`)
- `getAuditLogColumns` PRAGMA — closed in Phase 2 (`scheduling-automation.js` pattern)
- `getTaskFileChangeColumns` PRAGMA — closed pre-arc (`task-metadata.js`)

## New Observability Added

- `server/operations-perf-counters.js` — lightweight in-process counter module tracking 5 hot-path operations
- `/api/v2/operations/perf` — REST GET endpoint returns counter snapshot (with optional `?reset=true`)
- `Operations > Perf` dashboard tab (`OperationsHub.jsx`) — live display, 30s auto-refresh
- All 5 hot paths instrumented: listTasksParsed, listTasksRaw, capabilitySetBuilt, pragmaCostBudgets, pragmaPackRegistry

## Tests Added

| Test file | Coverage |
|-----------|----------|
| `server/tests/provider-router-paid-providers.test.js` | PAID_PROVIDERS is module-level Set |
| `server/tests/queue-scheduler-set-constants.test.js` | GPU_SHARING_PROVIDERS, OLLAMA_GPU_PROVIDERS exported |
| `server/tests/provider-capabilities-memo.test.js` | 100 calls return same Set reference (cache hit); setDb clears |
| `server/tests/budget-watcher-pragma-cache.test.js` | 100 calls = 1 PRAGMA; fresh db = new cache entry |
| `server/tests/pack-registry-pragma-cache.test.js` | 100 calls = 1 PRAGMA; setDb clears |
| `server/tests/task-core-list-tasks-raw.test.js` | raw returns strings; auto_approve still boolean; timing divergence >10% |
| `server/tests/v2-analytics-list-tasks-raw.test.js` | handleRoutingDecisions passes raw:true |
| `server/tests/operations-perf-counters.test.js` | increment, reset, unknown key, snapshot keys |
| `dashboard/src/views/OperationsPerf.test.jsx` | renders data, loading state, error state |

## v0.1 Deferrals (unchanged from spec)

- Lazy-parse wrapper for listTasks (proxy/getter approach) — invasive, `raw:true` covers high-leverage cases
- Deep instrumentation of all handlers for the Perf panel — Phase 3 ships representative coverage
- `chunked-review.js readFileSync` — grandfathered in Phase 1 scope (sync-io pattern, not repeated-work)
