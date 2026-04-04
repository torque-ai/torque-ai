# Runtime Performance Scan

**Date:** 2026-04-04
**Scope:** server/ (excluding tests)
**Variant:** performance

## Summary
10 findings across sync I/O in hot paths, N+1 DB query patterns, unbounded sync filesystem walks, and blocking git operations in the task completion pipeline.

## Findings

### [HIGH] execFileSync('git') blocks event loop on every completed task (completion-pipeline.js)
- **File:** server/execution/completion-pipeline.js:293
- **Description:** `handlePostCompletion()` runs on every task completion. For versioned projects, it calls `execFileSync('git', ['log', ...])` synchronously to scan for untracked commits, then loops over each result line running an individual `INSERT` per commit. This blocks the event loop for the duration of the git subprocess (potentially hundreds of milliseconds on large repos). Since task completions can arrive in bursts when workflows finish, this creates head-of-line blocking for all other event processing.
- **Status:** NEW
- **Suggested fix:** Replace `execFileSync` with `execFile` (callback/promise) and wrap the commit-insert loop in a `db.transaction()` for batch efficiency. Or defer the entire Phase 9 auto-release block to `setImmediate` so it doesn't block the completion pipeline.

### [HIGH] execFileSync('git', ['diff', 'HEAD~1']) blocks event loop in adversarial review stage
- **File:** server/execution/adversarial-review-stage.js:74
- **Description:** `collectDiff()` calls `execFileSync('git', ['diff', 'HEAD~1'])` with a `maxBuffer` of DIFF_MAX_BYTES. This runs synchronously inside the task finalizer pipeline, blocking the event loop while git computes the diff. On repos with large changesets, this can take several seconds.
- **Status:** NEW
- **Suggested fix:** Replace with `execFile` (async) and await the result. The `runStage()` wrapper in task-finalizer.js already supports async handlers via `Promise.resolve(handler(ctx))`.

### [HIGH] Sync filesystem walk in captureDirectoryBaselines blocks event loop
- **File:** server/db/file-baselines.js:125-153
- **Description:** `captureDirectoryBaselines()` performs a recursive synchronous filesystem walk (`readdirSync` + `statSync`) over the entire working directory, calling `captureFileBaseline()` on each matching file (which itself calls `statSync` + `readFileSync` + a DB insert). For large codebases, this can block the event loop for seconds. This function is called during task safeguard checks in the completion pipeline.
- **Status:** NEW
- **Suggested fix:** Convert to an async walk using `fs.promises.readdir` + `fs.promises.stat`, or limit the scan depth/file count. Alternatively, move baseline capture to a background worker.

### [HIGH] Sync filesystem walk in checkDuplicateFiles blocks event loop
- **File:** server/db/file-baselines.js:771-830
- **Description:** `checkDuplicateFiles()` performs a synchronous recursive directory scan (`readdirSync` + `isDirectory`/`isFile`) up to depth 10, building a filename-to-locations Map. Called during post-task validation, this blocks the event loop for the entire scan duration. The `searchSimilarFiles()` function (line 857-933) has the same pattern, also reading file contents synchronously with `readFileSync` during `classname` searches.
- **Status:** NEW
- **Suggested fix:** Convert to async filesystem APIs or run on a worker thread. For the `classname` search variant that reads file contents with `readFileSync`, consider using `fs.promises.readFile` with concurrency limiting.

### [MEDIUM] N+1 query pattern in getHealthSummary — 3 queries per health check type
- **File:** server/db/resource-health.js:129-159
- **Description:** `getHealthSummary()` first queries all distinct `check_type` values, then for each type calls `getLatestHealthCheck(check_type)` (1 query) and `getHealthHistory({ checkType, limit: 10 })` (1 query). With N health check types, this executes 1 + 2N queries. While the number of check types is typically small (5-10), the pattern is fragile and would degrade if new check types are added.
- **Status:** NEW
- **Suggested fix:** Replace with a single query that fetches the latest 10 records per check_type using a window function: `SELECT *, ROW_NUMBER() OVER (PARTITION BY check_type ORDER BY checked_at DESC) as rn FROM health_status WHERE rn <= 10`.

### [MEDIUM] N+1 query pattern in getDatabaseHealth — sequential COUNT per table
- **File:** server/db/resource-health.js:525-548
- **Description:** `getDatabaseHealth()` runs a separate `SELECT COUNT(*) FROM <table>` for 5 tables sequentially. While each COUNT is fast on SQLite with small tables, on a table with 100K+ rows (e.g., `task_events`), these can take 10-50ms each, and the function runs them all sequentially. Combined with the integrity check and fragmentation queries (5 PRAGMAs), this function issues ~12 sequential queries.
- **Status:** NEW
- **Suggested fix:** Combine the COUNT queries into a single query using subqueries: `SELECT (SELECT COUNT(*) FROM tasks) as tasks, (SELECT COUNT(*) FROM task_events) as task_events, ...`.

### [MEDIUM] purgeGrowthTables performs sync readdirSync + statSync per snapshot file
- **File:** server/db/resource-health.js:247-262
- **Description:** `purgeGrowthTables()` calls `fs.readdirSync(snapshotDir)` followed by `fs.statSync(filePath)` for every `.json` file in the snapshot directory to check modification time. If thousands of snapshot files accumulate, this synchronously blocks the event loop during maintenance. The function is called from maintenance routines, but can be triggered by health check or cleanup endpoints.
- **Status:** NEW
- **Suggested fix:** Use `fs.promises.readdir` with `{ withFileTypes: true }` and `fs.promises.stat` for async I/O. Or batch the deletion using `mtime` from `readdir` entries on platforms that support it.

### [MEDIUM] dashboard-server calls fs.existsSync on every static file request
- **File:** server/dashboard-server.js:204-220
- **Description:** The `serveStatic()` handler calls `fs.existsSync(reactDir)` to decide which dashboard directory to use on every request (line 204), then `fs.existsSync(filePath)` for SPA fallback (line 216), and `fs.existsSync(filePath)` again for 404 detection (line 220) — up to 3 sync filesystem calls per HTTP request. While these are fast on local disk, they block the event loop and don't cache the directory resolution result which is invariant after startup.
- **Status:** NEW
- **Suggested fix:** Cache the `dashboardDir` resolution at startup (it never changes at runtime). For the per-request file existence checks, the existing `staticFileCache` partially addresses this, but the `existsSync` calls run before the cache is consulted. Move to `fs.access` (async) or rely on the `fs.readFile` error path for 404 handling.

### [MEDIUM] _cleanOrphanedTaskChildren issues 40+ individual DELETE statements per task
- **File:** server/db/task-core.js:821-843
- **Description:** `_cleanOrphanedTaskChildren()` iterates 38 child tables, running a separate `DELETE FROM <table> WHERE task_id = ?` for each one. While each is wrapped in a try/catch, the function issues ~40 prepared statements sequentially. When called from `deleteTasks()` (line 876-883), this runs inside a transaction but iterates ALL matching task IDs, so deleting 100 failed tasks means 4000+ individual DELETE statements.
- **Status:** NEW
- **Suggested fix:** For bulk deletion, use `DELETE FROM <table> WHERE task_id IN (SELECT id FROM tasks WHERE status = ?)` for each child table instead of iterating per task. This reduces the query count from O(tasks * tables) to O(tables).

### [LOW] listTasks parses JSON for every row even when caller doesn't need parsed fields
- **File:** server/db/task-core.js:787-793
- **Description:** `listTasks()` maps over every returned row, calling `safeJsonParse()` on `context`, `files_modified`, and `tags` for each row. When fetching 1000 tasks (the default limit), this runs 3000 JSON.parse calls. Many callers (e.g., queue-scheduler) only need a subset of fields and don't use parsed context/files/tags. The lightweight variant `listQueuedTasksLightweight()` already addresses this for queued tasks, but the general `listTasks()` is still used by API endpoints and dashboard queries.
- **Status:** NEW
- **Suggested fix:** Add a `raw: true` option to `listTasks()` that skips JSON parsing, returning the raw SQLite rows. Callers that need parsed fields can opt in, while hot paths like dashboard listing can skip the overhead.
