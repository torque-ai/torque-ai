# Full Performance Scan

**Date:** 2026-04-04
**Scope:** server/ (excluding tests, excluding issues already in runtime-performance-scan.md)
**Variant:** performance

## Summary

15 new findings across governance hooks blocking the event loop with synchronous git subprocesses, audit/inventory sync filesystem walks, PRAGMA table_info calls on every file-change recording, N+1 query patterns in coordination and project-stats modules, unprepared statements inside loops, and per-request work that should be cached at startup.

## Findings

### [HIGH] Governance hooks run up to 5 execFileSync('git') calls per task submission

- **File:** server/governance/hooks.js:219, 279, 333, 338, 391
- **Description:** The governance `evaluate()` function runs synchronously on every task submission (called from task-hooks.js). Five separate checkers spawn blocking git subprocesses: `checkPushedBeforeRemote` (line 219: `git log origin/main..HEAD`), `checkDiffAfterCodex` (line 279: `git diff --stat HEAD`), `checkRequireWorktree` (line 333: `git branch --show-current` + line 338: `git worktree list --porcelain`), and `checkPushBeforeSubagentTests` (line 391: `git log origin/main..HEAD`). When multiple rules are active, a single `smart_submit_task` call can block the event loop for 500ms-2s while these git subprocesses execute sequentially. During burst submissions (e.g., workflow creation with 5-10 tasks), this creates severe head-of-line blocking.
- **Status:** NEW
- **Suggested fix:** Replace `execFileSync` with async `execFile` (promise-wrapped) in all checkers and make `evaluate()` async. The `createGovernanceHooks` contract already returns a plain object, so callers can be updated to `await evaluate()`. Alternatively, cache git state (branch name, unpushed count) with a short TTL (5s) since it rarely changes between sequential task submissions.

### [HIGH] Audit inventory reads every source file twice synchronously (readFileSync)

- **File:** server/audit/inventory.js:105, 158, 197
- **Description:** `inventoryFiles()` performs a synchronous recursive directory walk via `readdirSync` (line 158). For each source file, it calls `countLines()` (line 196) which does `readFileSync` + split to count lines, then immediately calls `readFileSync` again (line 197) to read the same file content for import extraction. This reads every file twice synchronously. On a codebase with 500 source files, this means 1000+ `readFileSync` calls that block the event loop. The function is called from `scan_project` and `full_project_audit` MCP tools.
- **Status:** NEW
- **Suggested fix:** Read each file once and reuse the content for both line counting and import extraction. Convert to async using `fs.promises.readdir`/`readFile`. The `countLines` function should accept content as a parameter instead of re-reading the file.

### [HIGH] Audit orchestrator reads all file contents synchronously before chunking

- **File:** server/audit/orchestrator.js:96-109, server/audit/chunking.js:208
- **Description:** `readFileContents()` in orchestrator.js loops over all audit files and calls `readFileSync` for each (line 101). `createReviewUnits()` in chunking.js uses `readFileSync` as its default file reader (line 208). Both are synchronous and can block the event loop for seconds on large projects. The audit orchestrator is invoked from `full_project_audit` which is an MCP tool call, meaning it blocks all other MCP request processing during the file reads.
- **Status:** NEW
- **Suggested fix:** Convert `readFileContents` to use `fs.promises.readFile` with `Promise.all` (bounded concurrency). Pass an async `readFile` option to `createReviewUnits`.

### [MEDIUM] PRAGMA table_info called on every recordFileChange and getTaskFileChanges

- **File:** server/db/task-metadata.js:40-46, 141, 202
- **Description:** `getTaskFileChangeColumns()` runs `PRAGMA table_info(task_file_changes)` and maps the result to a Set on every invocation. It is called at the start of both `recordFileChange()` (line 141) and `getTaskFileChanges()` (line 202). Since `recordFileChange` runs for every file modified by a task (potentially 10-50 times per task completion), and the table schema never changes during server lifetime, this is pure overhead. PRAGMA queries are fast (~0.1ms) but the cumulative cost across thousands of file changes adds up.
- **Status:** NEW
- **Suggested fix:** Cache the column Set at module level after the first call (schema does not change at runtime). Invalidate only on server restart. Same pattern applies to `getAuditLogColumns()` in scheduling-automation.js (lines 53-69, called at lines 72 and 343).

### [MEDIUM] getProjectStats issues 7 sequential queries + tag JSON parsing in a loop

- **File:** server/db/project-config-core.js:463-553
- **Description:** `getProjectStats()` issues 7 separate database queries sequentially for a single project: task counts by status, recent tasks, cost summary, pipeline count, scheduled task count, top templates, and all tags. The tag query (line 528-539) fetches ALL tasks with tags for the project and parses JSON for each row in a loop to compute tag frequency. With 1000 tasks, this means 1000 `JSON.parse` calls. The function is called from the dashboard `/api/v2/projects/:project/stats` endpoint.
- **Status:** NEW
- **Suggested fix:** Combine the count queries into a single query using subqueries. For tag frequency, either maintain a denormalized `project_tag_counts` table, or use SQLite's `json_each()` function: `SELECT value as tag, COUNT(*) as cnt FROM tasks, json_each(tasks.tags) WHERE project = ? GROUP BY value ORDER BY cnt DESC LIMIT 10`.

### [MEDIUM] listAgentGroups issues N+1 queries (COUNT per group)

- **File:** server/db/coordination.js:583-592
- **Description:** `listAgentGroups()` fetches all groups, then for each group runs a separate `SELECT COUNT(*) FROM agent_group_members WHERE group_id = ?` query (line 587-589). With N groups, this produces N+1 queries. The prepared statement is also created fresh inside the loop via `db.prepare()` instead of being prepared once outside.
- **Status:** NEW
- **Suggested fix:** Use a single query with LEFT JOIN: `SELECT g.*, COUNT(m.group_id) as member_count FROM agent_groups g LEFT JOIN agent_group_members m ON g.id = m.group_id GROUP BY g.id ORDER BY g.name`.

### [MEDIUM] expireStaleLeases creates 3 prepared statements per expired claim inside loop

- **File:** server/db/coordination.js:490-498
- **Description:** Inside the `expireStaleLeases` transaction, for each expired claim, three `db.prepare()` calls are made (lines 492, 493, 497) followed by `recordCoordinationEvent` which itself does another `db.prepare`. While better-sqlite3 caches prepared statements internally, the repeated prepare-string-hashing and lookup adds overhead that scales linearly with expired claims. During large-scale stall recovery, many claims can expire simultaneously.
- **Status:** NEW
- **Suggested fix:** Hoist all three prepared statements outside the loop: `const updateClaim = db.prepare(...); const updateTask = db.prepare(...); const updateAgent = db.prepare(...);` then call `.run()` inside the loop.

### [MEDIUM] failoverAgent creates 3 prepared statements per claim inside transaction loop

- **File:** server/db/coordination.js:897-918
- **Description:** Similar to expireStaleLeases, `failoverAgent` iterates over active claims and creates fresh `db.prepare()` statements for UPDATE task_claims, UPDATE tasks, and UPDATE agents inside the loop (lines 901-907, 910, 918). Each claim iteration re-prepares the same SQL strings.
- **Status:** NEW
- **Suggested fix:** Hoist prepared statements outside the loop, call `.run()` with parameters inside.

### [MEDIUM] Zombie checker runs execFileSync('tasklist') per tracked process on Windows

- **File:** server/maintenance/orphan-cleanup.js:291-303
- **Description:** `checkZombieProcesses()` runs every 30 seconds (zombie check interval). On Windows, for each tracked running process, it spawns `execFileSync('tasklist', ['/FI', 'PID eq ...'])` (line 291) to verify the process exists. With 5 concurrent tasks, this spawns 5 synchronous subprocesses per check cycle, blocking the event loop for ~200-500ms each cycle. The check runs even when all processes are healthy (no early exit if process.kill(pid, 0) succeeds).
- **Status:** NEW
- **Suggested fix:** Only run the tasklist check when `process.kill(pid, 0)` succeeds (which it does for dead Windows processes due to handle retention) -- this is already the case but the optimization is: call a single `tasklist /FO CSV` (no filter), parse the full output once, and check all PIDs against it. This replaces N subprocess spawns with 1. Or use async `execFile`.

### [MEDIUM] SSE getAllowedOrigins() creates a new Set on every HTTP request

- **File:** server/mcp-sse.js:91-100, 108-111
- **Description:** `getAllowedOrigins()` creates a new `Set` with dashboard origin URLs every time it is called. It is invoked via `resolveMcpAllowedOrigin()` on every SSE HTTP request (line 261). The function reads `serverConfig.getInt('dashboard_port')` and constructs two URL strings for the Set. While individually fast, this allocates a new Set + 2 strings per request and is completely unnecessary since the dashboard port never changes at runtime.
- **Status:** NEW
- **Suggested fix:** Cache the Set at module level, invalidated only when `MCP_ALLOWED_ORIGINS` env var or config changes. This is a startup-time value.

### [MEDIUM] Chunked review reads files synchronously in MCP tool handler

- **File:** server/chunked-review.js:384
- **Description:** `generateReviewChunks()` calls `readFileSync` (line 384) to read the target file for chunked review. This function is called from the `submit_chunked_review` MCP tool handler, which runs on the SSE server's event loop. For large files (5000+ lines), this can block for 10-50ms.
- **Status:** NEW
- **Suggested fix:** Replace with `await fs.promises.readFile()` and make the handler async. The MCP protocol handler already supports async tool handlers.

### [LOW] cleanupOrphanedDotnetProcesses runs execFileSync('wmic') on interval

- **File:** server/maintenance/orphan-cleanup.js:115-139
- **Description:** `cleanupOrphanedDotnetProcesses()` runs on a periodic interval and calls `execFileSync('wmic', ['process', 'where', ...])` (line 115) on Windows. This blocks the event loop for 100-500ms per invocation. While it only runs periodically (not on every request), it shares the event loop with task completion processing.
- **Status:** NEW
- **Suggested fix:** Replace with async `execFile` and await the result.

### [LOW] Diffusion planner reads files synchronously

- **File:** server/diffusion/planner.js:11-13
- **Description:** The diffusion planner reads file contents via `readFileSync` in a loop (line 12). This is called when creating a diffusion plan, reading all referenced files synchronously.
- **Status:** NEW
- **Suggested fix:** Replace with `fs.promises.readFile` and `Promise.all` for parallel reads.

### [LOW] CI watcher uses execFileSync for git remote URL detection

- **File:** server/ci/watcher.js:486-489
- **Description:** `watch()` calls `execFileSync('git', ...)` to detect the git remote URL when setting up a CI watch. This blocks the event loop during watch setup. While it only runs once per watch setup (not on hot path), it can delay MCP response processing.
- **Status:** NEW
- **Suggested fix:** Replace with async `execFile`.

### [LOW] v2-governance-handlers and admin routes use writeFileSync for temp plan files

- **File:** server/api/v2-governance-handlers.js:575, server/dashboard/routes/admin.js:222
- **Description:** Both governance plan submission handlers write plan content to temp files synchronously via `writeFileSync` before processing. This blocks the event loop for the duration of the disk write.
- **Status:** NEW
- **Suggested fix:** Replace with `await fs.promises.writeFile()`.

## Patterns Verified as Acceptable

- **getConfig()** has 30s TTL cache (config-core.js:40), not a hot-path issue
- **queue-scheduler processQueueInternal** uses lightweight DB queries, provider limit caching (10s TTL), efficient single-pass provider counting
- **rate limiter** uses in-memory Map with periodic cleanup and `.unref()`, well-designed
- **logger** uses async write stream with rotation, not blocking on hot path
- **SSE session management** has proper cleanup on disconnect, bounded session count (MAX_SSE_SESSIONS=50)
- **timer-registry.js** has clean Set-based tracking with clearAll for shutdown
- **_stallWarningEmitted Set** is cleaned up on task completion/cancellation, will not leak
- **event-bus** has 50 max listeners, no unbounded growth risk
- **provider limit cache** in queue-scheduler has 10s TTL, prevents DB thrashing
