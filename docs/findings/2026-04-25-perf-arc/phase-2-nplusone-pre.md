# Phase 2 Pre-Flight Scout — N+1 Queries + Missing Indexes

**Date:** 2026-04-25
**Worktree:** feat-perf-2-nplusone
**Base commit:** 9624f171dd53fc21936332249cb4ddd1c469916d
**Discipline rule:** No db.prepare() in loops; WHERE clauses must reference indexed columns or carry @full-scan tag (per umbrella §3.2)

## Summary

14 findings across 8 files. Four are HIGH — two live N+1 query fans that fire per-project on the `factory_status` and `list_factory_projects` endpoints (the busiest factory control-plane calls), one prepare-in-loop inside the task bulk-delete cascade that issues 40+ prepares per task ID, and one wrong-column predicate in `budget-watcher.js` that silently reads `SUM(estimated_cost)` from `cost_tracking` where the schema column is actually `cost_usd` (always returns 0). Seven are MEDIUM — the `getHealthSummary` N+1 (2N+1 queries per distinct check type), the `getDatabaseHealth` prepare-in-for-of loop, the `getAuditLogColumns` PRAGMA re-executed per audit write, the `getScoreHistory` N+1 on `include_trends` requests, `getAllTags`/`getTagStats` unbounded reads over all tasks, and the semantic similarity fallback full-table-scan in project-cache. Three findings from prior scans (`listAgentGroups` N+1, `expireStaleLeases`/`failoverAgent` prepare-in-loop, `buildProjectCostSummary` triple-compute, `content_hash` missing index) have been silently resolved. The outstanding `factory_guardrail_events.batch_id` missing index is confirmed still absent.

---

## Findings

### [HIGH] handleFactoryStatus + handleListFactoryProjects: getLatestScores N+1 per project

- **File:** `server/handlers/factory-handlers.js:841` (handleFactoryStatus), `:604` (handleListFactoryProjects)
- **Pattern:** Both handlers iterate `factoryHealth.listProjects()` and call `factoryHealth.getLatestScores(p.id)` inside `Promise.all(...map(...))`. Each `getLatestScores` call issues a correlated subquery against `factory_health_snapshots`. With N registered factory projects, both endpoints fire N+1 queries (1 for listProjects + N for getLatestScores).
- **Hot-path context:** `factory_status` is the primary polling endpoint for the factory dashboard. The REST `/api/v2/factory/status` route hits `handleFactoryStatus` on every dashboard refresh (default 5-30s poll interval). `handleListFactoryProjects` is called by `list_factory_projects` MCP tool. Both calls also invoke `factoryLoopInstances.listInstances` and `countOpenFactoryWorkItems` per project, compounding the fan-out.
- **Was in prior scan?** Yes — `2026-04-12-performance-sweep.md` finding #2 cited `factory-handlers.js:52-59` and `:204-228`. The triple-compute issue in the same prior scan finding (#3, `buildProjectCostSummary`) has since been fixed (single shared summary call). The N+1 getLatestScores fan remains unaddressed.
- **Fix shape:** Add `getLatestScoresBatch(projectIds)` to `factory-health.js` that fetches all latest snapshots for multiple projects in one query: `SELECT project_id, dimension, score FROM factory_health_snapshots WHERE id IN (SELECT MAX(id) FROM factory_health_snapshots WHERE project_id IN (?) GROUP BY project_id, dimension)`. Call this once from the handler and build a `Map<projectId, scores>`.
- **Severity rationale:** HIGH. The `factory_status` endpoint is called every 5-30 seconds by the factory dashboard. With 5 projects each having 10 dimensions, a single dashboard refresh issues 5 getLatestScores queries + 5 listInstances queries + 5 countOpenFactoryWorkItems queries = 15+ DB round-trips per request.

### [HIGH] handleProjectHealth include_trends: getScoreHistory N+1 per dimension

- **File:** `server/handlers/factory-handlers.js:642-646`
- **Pattern:** When `args.include_trends` is truthy, the handler iterates all dimensions and calls `factoryHealth.getScoreHistory(project.id, dim, 20)` inside a `for...of` loop — one query per dimension. With 10 valid dimensions, this issues 10 sequential queries.
- **Hot-path context:** Called by the `project_health` MCP tool and the factory detail panel in the dashboard. The `include_trends` flag is enabled by default in the factory health monitoring view.
- **Was in prior scan?** No — this path was not flagged in prior scans.
- **Fix shape:** Add `getScoreHistoryBatch(projectId, dimensions, limit)` to factory-health.js that retrieves history for all requested dimensions in one query: `SELECT dimension, id, score, scan_type, batch_id, scanned_at FROM factory_health_snapshots WHERE project_id = ? AND dimension IN (?) ORDER BY dimension, scanned_at ASC`. Partition results in JS.
- **Severity rationale:** HIGH. The `idx_fhs_project_dim` composite index covers `(project_id, dimension, scanned_at)` so each individual query is fast, but 10 round-trips for a single MCP tool response adds latency that compounds when the factory dashboard polls multiple projects.

### [HIGH] _cleanOrphanedTaskChildren: db.prepare() inside for...of over child tables

- **File:** `server/db/task-core.js:1014-1016`
- **Pattern:** `_cleanOrphanedTaskChildren(taskId)` iterates a Set of ~38 child table names and calls `db.prepare(\`DELETE FROM ${table} WHERE task_id = ?\`)` inside the loop body. `deleteTasks(status)` then calls this per task ID inside a transaction — so deleting 50 failed tasks issues 38 × 50 = 1900 `db.prepare()` calls total.
- **Hot-path context:** Called from `deleteTask()` and `deleteTasks()`. `deleteTasks` is triggered by the cleanup scheduler and by the `delete_tasks` MCP tool. During large cleanup runs (e.g., bulk-deleting completed tasks after a workflow), this creates significant overhead.
- **Was in prior scan?** Yes — `2026-04-04-runtime-performance-scan.md` finding #9 documented the 40+ individual DELETE statements but focused on the query count. The prepare-in-loop aspect was called out in the original finding as: "prepare statements sequentially." The fix has not been applied.
- **Fix shape:** Hoist all 38 DELETE statements outside `_cleanOrphanedTaskChildren` as module-level prepared statements (one per table). Because the table set is static and known at module load time, prepare them all at startup or lazily on first use with a module-level cache object. Call `.run(taskId)` inside the loop.
- **Severity rationale:** HIGH. The N×38 prepare overhead is proportional to task deletion batch size. better-sqlite3 internally caches prepared statements by SQL string, but hash-lookup on 38 distinct SQL strings per task still accumulates measurably in bulk-delete paths.

### [HIGH] budget-watcher: getCurrentSpend queries non-existent column `estimated_cost`

- **File:** `server/db/budget-watcher.js:264`, `:272`, `:281`, `:288`
- **Pattern:** `getCurrentSpend()` queries `COALESCE(SUM(estimated_cost), 0) AS spend FROM cost_tracking` at 4 call sites. The `cost_tracking` schema (schema-tables.js:2448) defines the column as `cost_usd`, not `estimated_cost`. There is no `estimated_cost` column on this table. SQLite will silently return `NULL` for unknown column names in an aggregate expression when no rows match, causing the budget-watcher to always compute a spend of `0` regardless of actual spend.
- **Hot-path context:** `getCurrentSpend` is called from `buildBudgetStatus` which is called from `checkBudgetStatus`. Budget threshold checks run during task pipeline startup (pipeline.js:111-118) and during task finalization (task-finalizer.js:616-623) — two calls per task lifecycle. Budget alerts are also displayed on the dashboard.
- **Was in prior scan?** Prior scan `2026-04-05-performance-sweep.md` finding #3 flagged `created_at` vs `tracked_at` on the same function. The `tracked_at` fix has been applied (lines 274, 290 now use `tracked_at`). But the `estimated_cost` → `cost_usd` column rename was never fixed. This is a NEW finding at the column level.
- **Fix shape:** Replace `SUM(estimated_cost)` with `SUM(cost_usd)` at all 4 call sites (lines 264, 272, 281, 288). The `idx_cost_tracking_tracked` index covers `(provider, tracked_at)` so the timed queries already use the right index; only the SUM column name is wrong.
- **Severity rationale:** HIGH. This is a correctness bug, not just a performance finding: all budget threshold checks are silently broken — they always see 0% spend and never fire. Every task runs without any budget guard in production.

---

### [MEDIUM] getHealthSummary: 2N+1 queries (getLatestHealthCheck + getHealthHistory per check_type)

- **File:** `server/db/resource-health.js:129-159`
- **Pattern:** `getHealthSummary()` first queries `SELECT DISTINCT check_type FROM health_status` (1 query), then for each distinct type calls `getLatestHealthCheck(check_type)` (1 query each) and `getHealthHistory({ checkType, limit: 10 })` (1 query each). With N distinct check types (typically 5-8), this issues 2N+1 queries.
- **Hot-path context:** Exposed via the `get_health_summary` MCP tool and the `/api/v2/health/summary` REST endpoint. Dashboard health panels poll this.
- **Was in prior scan?** Yes — `2026-04-04-runtime-performance-scan.md` finding #5. Not yet fixed.
- **Fix shape:** Single query with window function: `SELECT *, ROW_NUMBER() OVER (PARTITION BY check_type ORDER BY checked_at DESC) AS rn FROM health_status WHERE rn <= 10`. Partition and pivot in JS.
- **Severity rationale:** MEDIUM. The number of check types is small and bounded, so absolute query count is low. But each query is a separate round-trip that can't be pipelined in SQLite's synchronous driver.

### [MEDIUM] getDatabaseHealth: db.prepare() inside for...of over table names

- **File:** `server/db/resource-health.js:536-548`
- **Pattern:** `getDatabaseHealth()` (line 527-548) iterates `Object.entries(tables)` — a fixed 5-entry object — and calls `db.prepare(query).get()` inside the loop for each table's COUNT(*). 5 separate prepare calls and 5 separate queries instead of one combined subquery.
- **Hot-path context:** `getDatabaseHealth` is called from the `/api/v2/health/database` REST endpoint and from the `get_database_health` MCP tool. Dashboard health panel polls it on each load.
- **Was in prior scan?** Yes — `2026-04-04-runtime-performance-scan.md` finding #6. Not yet fixed.
- **Fix shape:** Replace the loop with a single combined query: `SELECT (SELECT COUNT(*) FROM tasks) as tasks, (SELECT COUNT(*) FROM task_events) as task_events, (SELECT COUNT(*) FROM webhooks) as webhooks, (SELECT COUNT(*) FROM webhook_logs) as webhook_logs, (SELECT COUNT(*) FROM health_status) as health_status`.
- **Severity rationale:** MEDIUM. Fixed 5-table loop means bounded N=5, but prepare-inside-loop is still a lint violation per umbrella §3.2.

### [MEDIUM] getAuditLogColumns: PRAGMA table_info re-executed on every audit write

- **File:** `server/db/scheduling-automation.js:53-69`
- **Pattern:** `getAuditLogColumns()` runs `PRAGMA table_info(audit_log)` every time it is called. It has no module-level cache. It is called at line 72 (`getLatestAuditChainHash`) and at line 343 (inside `logAuditEvent`) on every audit write. `logAuditEvent` is called on every task status change, template usage, scheduling event, etc.
- **Hot-path context:** `logAuditEvent` is wired into the task lifecycle — every task state transition that runs through the audit subsystem re-runs the PRAGMA.
- **Was in prior scan?** Yes — `2026-04-04-full-performance-scan.md` finding #4 cited `task-metadata.js` getTaskFileChangeColumns (which now has a module-level cache, fixed). The `getAuditLogColumns` equivalent was cited as a secondary example. It remains unfixed.
- **Fix shape:** Add module-level cache variable `let _auditLogColumnsCache = null` and return early if populated, matching the fixed pattern in `task-metadata.js:41-48`.
- **Severity rationale:** MEDIUM. PRAGMA queries are ~0.1ms each but fire on every task-status-change audit write. In high-throughput factory batches (50+ task completions in sequence), this is unnecessary repeated overhead.

### [MEDIUM] project-cache lookupCache: full-table scan on semantic similarity fallback

- **File:** `server/db/project-cache.js:171-187`
- **Pattern:** When exact-hash lookup misses, `lookupCache()` runs `SELECT * FROM task_cache WHERE expires_at IS NULL OR expires_at > datetime('now')` (no LIMIT), retrieves every unexpired row, and computes cosine similarity in JS for each. With a large cache, this loads all rows into memory, parses JSON embedding vectors per row, and does floating-point math per candidate.
- **Hot-path context:** Called from `server/handlers/advanced/intelligence.js:64-67`. The exact-match path (line 149-153) now uses the `idx_cache_hash` index added in schema-tables.js:1672. But the semantic fallback still does a full-table scan.
- **Was in prior scan?** Yes — `2026-04-05-performance-sweep.md` finding #4. The `idx_cache_hash` index was added (resolving the exact-match concern) but the semantic fallback full-scan is unaddressed.
- **Fix shape:** Short-term: add `LIMIT 500` to the semantic fallback query to bound memory usage. Long-term: use SQLite's `json_each()` or a dedicated vector index. Alternatively, consider a two-stage approach: filter candidates by task description prefix or working_directory before cosine similarity.
- **Severity rationale:** MEDIUM. The exact-match path (the common case) is now fast. The semantic fallback is invoked only on cache misses, so frequency depends on cache hit rate. But on a cold cache, every intelligence tool invocation does an unbounded full scan.

### [MEDIUM] getAllTags / getTagStats: unbounded full-table scan over tasks.tags

- **File:** `server/db/task-metadata.js:492-505` (getAllTags), `:512-524` (getTagStats); also `server/db/project-config-core.js:547-557` (getProjectStats)
- **Pattern:** All three functions scan the entire `tasks` table for non-null tag rows (`SELECT tags FROM tasks WHERE tags IS NOT NULL`) and parse JSON in a loop. `getAllTags` and `getTagStats` scan across ALL projects; `getProjectStats` scans within one project but still retrieves all tag-bearing rows. With 10K+ tasks, this is 10K+ JSON.parse calls.
- **Hot-path context:** `getProjectStats` is called from `/api/v2/projects/:project/stats` (dashboard stats panel). `getAllTags` is exposed via MCP `list_tags`. `getTagStats` is called from dashboard tag filter UI.
- **Was in prior scan?** Yes — `2026-04-04-full-performance-scan.md` finding #5 flagged `getProjectStats` tag aggregation. The `json_each()` fix was suggested but not applied.
- **Fix shape:** Replace all three with `SELECT value AS tag, COUNT(*) AS cnt FROM tasks, json_each(tags) [WHERE project = ?] GROUP BY value ORDER BY cnt DESC LIMIT 100`. This pushes tag parsing into SQLite and removes per-row JSON.parse calls from JS.
- **Severity rationale:** MEDIUM. Scales linearly with total task count. On a factory project with a year of history (50K+ tasks), this becomes a noticeable blocking read.

---

### [LOW] getProjectStats: 7 sequential queries for a single project stats response

- **File:** `server/db/project-config-core.js:482-574`
- **Pattern:** `getProjectStats()` issues 7 separate prepared queries sequentially (task counts by status, recent tasks, cost summary, pipeline count, scheduled task count, top templates, tag scan). While individual queries are fast, 7 sequential round-trips add cumulative latency.
- **Hot-path context:** Called from `/api/v2/projects/:project/stats` on dashboard load.
- **Was in prior scan?** Yes — `2026-04-04-full-performance-scan.md` finding #5. Partially addressed (the tag JSON.parse loop is still present; other queries unchanged).
- **Fix shape:** Combine the count queries using subqueries or a single CTE. The tag query should use json_each() (see MEDIUM finding above). The recent tasks and top templates queries are reasonably bounded (LIMIT 10, LIMIT 5) and acceptable as-is.
- **Severity rationale:** LOW. Each individual query is O(1) for counts (uses indexes). The main waste is 7 round-trips; acceptable on lightly-loaded instances but wasteful in a multi-project batch dashboard.

### [LOW] getHealthSummary adjacent: getSystemMetrics prepare-in-for-of

- **File:** `server/db/resource-health.js:315-326`
- **Pattern:** `getSystemMetrics()` iterates `ALLOWED_TABLES` (6 entries) and calls `db.prepare(\`SELECT COUNT(*) as count FROM ${table}\`).get()` inside the loop — same pattern as getDatabaseHealth but in a different function.
- **Hot-path context:** Called from the system metrics dashboard panel and `/api/v2/health/metrics` endpoint.
- **Was in prior scan?** No — this function was not specifically flagged. It shares the same pattern as getDatabaseHealth.
- **Fix shape:** Same as getDatabaseHealth: single combined subquery.
- **Severity rationale:** LOW. Bounded 6-table loop, admin-only endpoint, not on the task execution hot path.

### [LOW] handlePauseAllProjects: sequential UPDATE per project inside for...of

- **File:** `server/handlers/factory-handlers.js:806-827`
- **Pattern:** `handlePauseAllProjects()` iterates all projects and calls `factoryHealth.updateProject(p.id, { status: 'paused' })` + `factoryAudit.recordAuditEvent(...)` per project inside a `for...of` loop. Each call issues 1-2 separate DB writes. With N projects, this is 2N sequential DB operations.
- **Hot-path context:** Called from the emergency pause MCP tool. Not a frequent hot path.
- **Was in prior scan?** No.
- **Fix shape:** Wrap the entire loop in a single `db.transaction()` to batch all UPDATEs atomically. For the prepare side, hoist the UPDATE statement outside the loop.
- **Severity rationale:** LOW. Emergency pause is rarely called; N projects is typically small (< 10). No correctness risk, just a minor efficiency improvement.

### [LOW] factory-health.js getProjectByPath: unbounded fallback scan

- **File:** `server/db/factory-health.js:103-108`
- **Pattern:** `getProjectByPath()` first does an exact-match `WHERE path = ?` lookup (fast — `path` has a UNIQUE constraint which creates an implicit index). On miss, it falls back to `SELECT * FROM factory_projects` (all rows) and filters in JS using `normalizeProjectPath`. With many registered factory projects, this is an unbounded read.
- **Hot-path context:** Called from `resolveProject()` in factory-handlers.js on every MCP tool call that accepts a project path. The exact-match fast path succeeds for normalized paths.
- **Was in prior scan?** No. The UNIQUE constraint on `path` was not documented in prior scans.
- **Fix shape:** The UNIQUE constraint on `path` means exact-match is already fast. The fallback is a correctness concern for legacy rows with non-canonical paths. Consider normalizing paths at write time (registration) so the fallback is never needed. If the fallback must remain, add `LIMIT 50` to bound memory.
- **Severity rationale:** LOW. The primary path is fast. The fallback fires only for legacy rows with backslash or non-canonical paths, which is an edge case in practice.

---

## Missing indexes inventory

| Table | Column(s) | Used by query at | Should have index? | Prior scan? |
|---|---|---|---|---|
| `factory_guardrail_events` | `batch_id` | `feedback.js:231-233` (JS filter after loading 100 rows) | Yes — `(project_id, batch_id, created_at)` composite | 2026-04-12 |
| `task_cache` | `content_hash` | `project-cache.js:149-153` | **RESOLVED** — `idx_cache_hash` added in schema-tables.js:1672 | 2026-04-05 |

## Wrong-column predicates

| File:line | Filter column | Schema actual column | Effect | Prior scan? |
|---|---|---|---|---|
| `budget-watcher.js:264,272,281,288` | `estimated_cost` | `cost_usd` | Always returns 0; all budget thresholds silently disabled | Partial (2026-04-05 flagged `created_at`→`tracked_at` which was fixed; `estimated_cost`→`cost_usd` is NEW) |

## prepare-in-loop callsites

| File:line | Loop type | Statement | Hoist where? |
|---|---|---|---|
| `task-core.js:1016` | `for...of childTables` (38 tables) | `DELETE FROM ${table} WHERE task_id = ?` | Module-level cache object keyed by table name |
| `resource-health.js:538` | `for...of Object.entries(tables)` (5 tables) | `SELECT COUNT(*) as count FROM ${table}` | Replace with single combined subquery |
| `resource-health.js:318` (getSystemMetrics) | `for...of ALLOWED_TABLES` (6 tables) | `SELECT COUNT(*) as count FROM ${table}` | Replace with single combined subquery |

## .all() without LIMIT

| File:line | Table | Reasonable bound | Notes |
|---|---|---|---|
| `task-metadata.js:493` (getAllTags) | `tasks` | 10K–100K rows | Use json_each() GROUP BY instead |
| `task-metadata.js:513` (getTagStats) | `tasks` | 10K–100K rows | Use json_each() GROUP BY instead |
| `project-config-core.js:548` (getProjectStats tags) | `tasks` | Per-project scope | Use json_each() GROUP BY instead |
| `project-cache.js:171-174` (semantic fallback) | `task_cache` | Unbounded | Add LIMIT 500 as short-term bound |
| `factory-health.js:106` (getProjectByPath fallback) | `factory_projects` | < 20 rows in practice | Legacy path; mitigate by normalizing paths at write time |
| `resource-health.js:131-132` (getHealthSummary DISTINCT) | `health_status` | Small distinct set | Acceptable; DISTINCT check_type reads bounded rows |

## N+1 query patterns (caller-level)

| Caller | Per-item query | Items | Total queries | Prior scan? |
|---|---|---|---|---|
| `factory-handlers.js:841` (handleFactoryStatus `.map`) | `getLatestScores(p.id)` | N projects | N+1 | 2026-04-12 |
| `factory-handlers.js:604` (handleListFactoryProjects `.map`) | `getLatestScores(p.id)` | N projects | N+1 | 2026-04-12 |
| `factory-handlers.js:645` (handleProjectHealth `for...of dims`) | `getScoreHistory(id, dim, 20)` | 10 dimensions | N+1 | NEW |
| `resource-health.js:135` (getHealthSummary `for...of types`) | `getLatestHealthCheck` + `getHealthHistory` | ~5-8 types | 2N+1 | 2026-04-04 |

## Previously reported findings — resolution status

| Finding | Source | Status |
|---|---|---|
| `listAgentGroups` N+1 COUNT per group | 2026-04-04 | **RESOLVED** — replaced with LEFT JOIN subquery (coordination.js:587-598) |
| `expireStaleLeases` prepare-in-loop (3 stmts) | 2026-04-04 | **RESOLVED** — stmts hoisted outside loop (coordination.js:489-491) |
| `failoverAgent` / `triggerFailover` prepare-in-loop | 2026-04-04 | **RESOLVED** — stmts hoisted outside loop (coordination.js:902-909) |
| `buildProjectCostSummary` called 3× per request | 2026-04-12 | **RESOLVED** — single shared call in handleFactoryCostMetrics:1941, passed to each helper |
| `cost-metrics.js` getTaskCostData N+1 per task | 2026-04-12 | **RESOLVED** — batched: getTaskUsageRows + getTaskTrackingRows both use IN (?) over all task IDs |
| `task_cache.content_hash` missing index | 2026-04-05 | **RESOLVED** — `idx_cache_hash` added in schema-tables.js:1672 |
| `budget-watcher.js` `created_at` predicate (wrong column) | 2026-04-05 | **RESOLVED** — queries now use `tracked_at` (lines 274, 290) |
| `getScoreHistory` ordering bug (ASC LIMIT 2 = oldest 2, not newest 2) | 2026-04-12 | **RESOLVED** — `getRecentScoreHistory` in feedback.js:267-269 uses `{ order: 'DESC' }` and then reverses |
| `task-metadata.js getTaskFileChangeColumns` PRAGMA on every call | 2026-04-04 | **RESOLVED** — module-level cache added (lines 42-48) |

## Coverage

- Files scanned: `server/db/**/*.js`, `server/handlers/factory-handlers.js`, `server/factory/cost-metrics.js`, `server/factory/feedback.js`, `server/db/budget-watcher.js`, `server/db/project-cache.js`, `server/db/resource-health.js`, `server/dashboard-server.js`
- Total prepare-in-loop callsites: **3** (task-core.js, resource-health.js getDatabaseHealth, resource-health.js getSystemMetrics)
- Total unindexed-column predicates: **1** (factory_guardrail_events.batch_id)
- Total wrong-column predicates: **1** (budget-watcher.js estimated_cost → cost_usd)
- Total missing indexes (net new): **1** (factory_guardrail_events.batch_id)
- Total .all() without LIMIT: **5** substantive (tag reads ×3, semantic fallback ×1, getProjectByPath fallback ×1) + 1 acceptable (getHealthSummary DISTINCT)
- Total N+1 patterns: **4** (factory status/list ×2, project health trends ×1, resource health summary ×1)

## Notes for Phase 2 child spec

### Batching clusters

1. **Factory status batch** — `getLatestScoresBatch` absorbs the `handleFactoryStatus` and `handleListFactoryProjects` N+1 at once. Single new method in factory-health.js; handlers updated to call it once and destructure results per project ID.

2. **Trends batch** — `getScoreHistoryBatch` absorbs the `handleProjectHealth include_trends` N+1. Also a single method in factory-health.js using a single query partitioned by dimension.

3. **Resource health COUNT consolidation** — `getDatabaseHealth` + `getSystemMetrics` both do prepare-in-for-of over fixed table sets. Can be fixed in a single pass with combined subquery for each function.

4. **Tag aggregation** — `getAllTags`, `getTagStats`, and `getProjectStats` tag block can all be unified to use `json_each()` GROUP BY. Three edit sites, one pattern.

### Legitimate full-scans (@full-scan candidates)

- `factory-health.js:106` fallback — legacy path normalization. Acceptable with small factory project counts (< 20). Tag `@full-scan` with comment explaining the invariant.
- `resource-health.js:131` DISTINCT check_type — bounded by the number of distinct health check types (stable at 5-8). Tag `@full-scan`.
- `project-cache.js:171-174` semantic fallback — unbounded in theory but only fires on cache miss. Add `LIMIT 500` and tag `@full-scan` pending a proper vector index solution.

### DB migration required

- **`factory_guardrail_events.batch_id`** — add `CREATE INDEX IF NOT EXISTS idx_fge_batch ON factory_guardrail_events(project_id, batch_id, created_at)` in a new migration. No code change needed in the hot path once the index exists; the JS-level filter in feedback.js can be replaced by a direct `batch_id = ?` WHERE clause.

### Code-change-only fixes

- `budget-watcher.js` estimated_cost → cost_usd (4 one-line edits)
- `task-core.js` _cleanOrphanedTaskChildren hoist (module-level prepare cache)
- `scheduling-automation.js` getAuditLogColumns cache (add module-level variable)
- `resource-health.js` getHealthSummary window function (single query)
- `resource-health.js` getDatabaseHealth + getSystemMetrics combined subquery

### Severity summary

- **HIGH:** 4 (factory status N+1, project health trends N+1, task cleanup prepare-in-loop, budget-watcher wrong column — the last is a correctness bug)
- **MEDIUM:** 7 (getHealthSummary 2N+1, getDatabaseHealth prepare-in-loop, getAuditLogColumns PRAGMA repeat, project-cache semantic scan, getAllTags/getTagStats/getProjectStats tag reads, getScoreHistory N+1)
- **LOW:** 3 (getSystemMetrics prepare-in-loop, handlePauseAllProjects sequential writes, getProjectByPath fallback scan)
