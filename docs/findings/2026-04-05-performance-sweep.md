# 2026-04-05 Performance Sweep

Scope: `server/`
Variant: `performance`

Reviewed prior findings under `docs/findings/`, especially `2026-04-04-full-performance-scan.md` and `2026-04-04-runtime-performance-scan.md`. Previously reported or already-fixed items are intentionally not repeated here.

## 1. High: v2 CLI provider execution still blocks the Node event loop

- Evidence: `server/providers/v2-cli-providers.js:145-181` runs provider jobs with `spawnSync(...)`; the inline note at `server/providers/v2-cli-providers.js:158-163` already documents that it blocks the Node.js event loop for the full CLI duration.
- Hot path: both synchronous and asynchronous v2 inference routes await `candidateAdapter.submit(...)` in `server/api/v2-inference.js:725-729` and `server/api/v2-inference.js:1014-1018`.
- Additional caller: strategic orchestration also uses `provider.submit(...)` in `server/orchestrator/strategic-brain.js:126-134`.
- Impact: long-running Codex or Claude CLI jobs still monopolize the single Node thread and can starve unrelated HTTP/MCP traffic while the child process runs.

## 2. High: task context enrichment remains synchronous in the submit/build path

- Evidence: the prompt builders still call the synchronous `enrichResolvedContext(...)` entrypoint from `server/execution/file-context-builder.js:169-176` and `server/execution/command-builders.js:78-86`.
- Internals: `server/utils/context-enrichment.js:167-187`, `server/utils/context-enrichment.js:196-310`, `server/utils/context-enrichment.js:368-417`, and `server/utils/context-enrichment.js:478-526` perform repeated `existsSync`, `statSync`, `readFileSync`, and `execFileSync('git', ...)` calls while resolving imports, probing test files, and fetching git history.
- Additional signal: an async wrapper exists in `server/utils/context-enrichment.js:732-749`, but it still delegates to the synchronous implementation and has no current call sites.
- Impact: tasks with multiple resolved files or deep import graphs still pay synchronous filesystem and git subprocess cost before execution starts, which can stall concurrent task submissions.

## 3. High: budget threshold spend queries do not align with the indexed timestamp column

- Evidence: `server/db/budget-watcher.js:271-275` and `server/db/budget-watcher.js:287-291` filter `cost_tracking` by `created_at`.
- Schema: `server/db/schema-tables.js:2141-2154` defines `cost_tracking.tracked_at` and indexes `(provider, tracked_at)` via `idx_cost_tracking_tracked`; there is no `created_at` column or matching index in the current schema.
- Hot path: budget threshold checks run during task pipeline startup in `server/handlers/task/pipeline.js:111-118` and during task finalization in `server/execution/task-finalizer.js:616-623`.
- Impact: the threshold checker cannot use the intended time-range index for windowed spend lookups. On the current schema it also falls off the fast path entirely because the predicate does not match the stored timestamp field.

## 4. Medium: task cache lookup still scales linearly with cache size

- Evidence: exact-match lookup in `server/db/project-cache.js:149-153` filters by `content_hash`, but `server/db/schema-tables.js:1299-1313` defines no index on that column; the only related cache index is `idx_task_cache_expires` in `server/db/schema-tables.js:2859`.
- Evidence: the semantic fallback then loads every unexpired row with `SELECT * FROM task_cache` and computes cosine similarity in JavaScript for each candidate in `server/db/project-cache.js:171-187`, including JSON parsing of each embedding vector.
- Call path: this is exposed directly by `server/handlers/advanced/intelligence.js:64-67`.
- Impact: cache lookup latency grows with table size, and misses pay a full table scan plus per-row JSON parse and similarity math.
