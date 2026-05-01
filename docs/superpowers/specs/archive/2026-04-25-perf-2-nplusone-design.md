# Phase 2 Child Spec — N+1 Queries + Missing Indexes

**Status:** Draft 2026-04-26 (pending user review)

**Parent:** `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` §3.2, §4.2 row 3

**Pre-flight findings:** `docs/findings/2026-04-25-perf-arc/phase-2-nplusone-pre.md` (scout commit `909c7005`)

**Goal:** Eliminate the remaining N+1 query patterns + prepare-in-loop callsites + missing indexes documented by the scout, fix the budget-watcher correctness bug, ship the `torque/no-prepare-in-loop` ESLint rule + `assertMaxPrepares` test helper + `scripts/audit-db-queries.js` audit, and update the perf gate baseline.

## 1. State of the world (vs the umbrella spec's assumptions)

The umbrella §3.2 anticipated a substantial sweep of N+1 + prepare-in-loop callsites + index gaps across factory-handlers, cost-metrics, budget-watcher, and the coordination subsystem. **9 of those have been silently resolved since the 2026-04-04 scans.** What remains is tighter:

**Already fixed since prior scans (no action this phase):**
- `listAgentGroups` N+1 (fixed via LEFT JOIN subquery in `coordination.js`)
- `expireStaleLeases` and `triggerFailover` prepare-in-loop (statements hoisted)
- `buildProjectCostSummary` 3× redundant compute (single shared call now)
- `cost-metrics.js` `getTaskCostData` per-task N+1 (batched via IN clause)
- `task_cache.content_hash` missing index (`idx_cache_hash` shipped in `schema-tables.js:1672`)
- `budget-watcher.js` `created_at`→`tracked_at` predicate (fixed)
- `getScoreHistory` ASC/LIMIT 2 ordering bug (fixed via `getRecentScoreHistory` DESC + reverse)
- `task-metadata.js getTaskFileChangeColumns` PRAGMA-on-every-call (module-level cache added)
- `getTaskFileChangeColumns` `audit_log` schema check (cached)

**What remains** (this phase's actual scope):

- 4 HIGH (incl. 1 correctness bug)
- 7 MEDIUM
- 3 LOW
- 1 missing index
- 3 prepare-in-loop callsites
- 6 unbounded `.all()` calls

The smaller scope means Phase 2 is more about **shipping the discipline rule + audit script** than mass migration. The discipline tooling is what prevents the patterns from re-creeping in.

---

## 2. Scope

### 2.1 In scope

**HIGH (correctness + measurable hot-path):**

1. **Budget-watcher correctness bug** (`server/db/budget-watcher.js:264,272,281,288`): `SUM(estimated_cost)` queries non-existent column. Schema column is `cost_usd`. Every budget threshold check silently returns 0. **Production budget enforcement is broken.** Fix: rename the SUM column to `cost_usd` at all 4 callsites.

2. **Factory-handlers `getLatestScores` N+1** (`server/handlers/factory-handlers.js:841` for `handleFactoryStatus`, `:604` for `handleListFactoryProjects`). Both iterate factory projects in `Promise.all(...map(...))` and call `factoryHealth.getLatestScores(p.id)` per project. The `factory_status` endpoint is polled every 5-30s by the dashboard. Fix: add `factoryHealth.getLatestScoresBatch(projectIds)` → single query with `WHERE id IN (SELECT MAX(id) FROM factory_health_snapshots WHERE project_id IN (?) GROUP BY project_id, dimension)`.

3. **`handleProjectHealth` `include_trends` N+1** (`server/handlers/factory-handlers.js:642-646`). Iterates dimensions and calls `getScoreHistory(project.id, dim, 20)` per dimension — 10 queries per request when trends are requested (default for the health panel). Fix: add `factoryHealth.getScoreHistoryBatch(projectId, dimensions, limit)` → single query partitioned by dimension in JS.

4. **`_cleanOrphanedTaskChildren` prepare-in-loop** (`server/db/task-core.js:1014-1016`). Iterates ~38 child table names and calls `db.prepare(\`DELETE FROM ${table} WHERE task_id = ?\`)` inside the loop. Bulk-deleting 50 tasks issues 38 × 50 = 1900 prepares. Fix: hoist the 38 DELETE statements to module-level cached prepares (lazy-initialize on first use).

**MEDIUM:**

5. **`getHealthSummary` 2N+1** (`server/db/resource-health.js:129-159`). Replace `for...of distinct check_types → 2 queries each` with single window-function query.

6. **`getDatabaseHealth` prepare-in-for-of** (`server/db/resource-health.js:536-548`). 5 sequential COUNT queries → single combined-subquery.

7. **`getAuditLogColumns` PRAGMA on every audit write** (`server/db/scheduling-automation.js:53-69`). Add module-level cache (mirrors the fixed `task-metadata.js` pattern).

8. **`getScoreHistory` N+1 already covered by Finding #3** (per-dimension; `getScoreHistoryBatch` fix subsumes this).

9. **`project-cache.js` semantic-fallback full-scan** (`server/db/project-cache.js:171-187`). Short-term: add `LIMIT 500`. Long-term: vector index — out of scope for this phase.

10. **`getAllTags` / `getTagStats` / `getProjectStats` tag scans** (`server/db/task-metadata.js:492-505,512-524`, `server/db/project-config-core.js:547-557`). Replace per-row `JSON.parse` loop with SQLite `json_each()` GROUP BY query.

11. **`getProjectStats` 7 sequential queries** (`server/db/project-config-core.js:482-574`). Combine the count subqueries; defer the recent-tasks/top-templates queries (already LIMIT-bounded, acceptable). The tag-scan piece is covered by Finding #10.

**LOW:**

12. **`getSystemMetrics` prepare-in-for-of** (`server/db/resource-health.js:315-326`). Same shape as Finding #6; same fix.

13. **`handlePauseAllProjects` sequential UPDATE per project** (`server/handlers/factory-handlers.js:806-827`). Wrap in single `db.transaction()`; hoist UPDATE prepare outside loop.

14. **`getProjectByPath` unbounded fallback scan** (`server/db/factory-health.js:103-108`). Edge-case path; add `LIMIT 50` as a defensive bound.

### 2.2 Missing index (DB migration)

- **`factory_guardrail_events.batch_id`** — used by `factory/feedback.js:221-224` to filter the latest 100 project events in JS by `batch_id`. The schema indexes `(project_id, created_at)` and `(project_id, category)` but no `batch_id` index. Add migration: `CREATE INDEX idx_fge_batch ON factory_guardrail_events (project_id, batch_id, created_at)` (composite ordered for the common query shape).

### 2.3 Out of scope (Phase 2.5 / v0.1)

- **Vector-index for project-cache semantic similarity** (Finding #9 long-term). Real `vss` extension or external vector DB; substantial design work.
- **Path normalization at write time for factory_projects** (Finding #14). Would eliminate the fallback entirely; orthogonal to N+1 work.

---

## 3. Discipline rules

Three rules ship together — they target different failure modes the scout documented.

### 3.1 Rule A: `torque/no-prepare-in-loop`

ESLint rule at `server/eslint-rules/no-prepare-in-loop.js`. In `server/db/**` and `server/handlers/**` (the same hot-path glob set used for Phase 1's rule), flags member-expression calls of `db.prepare(...)` (and aliased imports) inside `ForOfStatement`, `ForInStatement`, `ForStatement`, `WhileStatement`, `DoWhileStatement`, and `.map`/`.forEach`/`.filter`/`.reduce` callback bodies.

Exception annotation: `// eslint-disable-next-line torque/no-prepare-in-loop -- <reason>` requires reason text >10 chars (same convention as Phase 1's rule).

### 3.2 Test invariant: `assertMaxPrepares(handler, max)`

Add a test helper at `server/tests/test-helpers.js` (or a sibling perf-test-helpers module) that wraps `db.prepare` with a counter, runs the handler, and asserts the count is below `max`. Wire it into the perf-tracked handler tests:

- `handleFactoryStatus` — assert `prepares <= 4` (one for listProjects + getLatestScoresBatch + countOpenFactoryWorkItems + listInstances).
- `handleListFactoryProjects` — assert `prepares <= 4`.
- `handleProjectHealth({ include_trends: true })` — assert `prepares <= 5` (one for getProject + getScoreHistoryBatch + a few helper queries).
- `getProjectStats` — assert `prepares <= 8` (the 7 declared queries + room for one helper).
- `getHealthSummary` — assert `prepares <= 2` (DISTINCT + window-function combined query).
- `_cleanOrphanedTaskChildren(taskId)` — assert `prepares <= 1` (after hoisting; the prepare cache is a one-time cost).

### 3.3 Pre-push audit script: `scripts/audit-db-queries.js`

Node script that scans `server/db/**/*.js` and `server/handlers/**/*.js` for SQL string literals, extracts WHERE clause column names + table names, and cross-references them against the index list extracted from `server/db/schema-tables.js`. Flags any WHERE clause that references a column NOT covered by an index, unless the SQL carries a `-- @full-scan: <reason>` comment.

Output: zero violations or a list of (file, line, table, column, query-shape) tuples. Pre-push hook adds the audit step right after the perf gate.

The audit script's index extraction is intentionally simple: parse `CREATE INDEX` statements from `schema-tables.js` text. False positives are acceptable (suppress with the `@full-scan` tag); false negatives (missing real index gaps) are not.

### 3.4 Initial allowlist for Rule A

The rule is configured to start in `error` mode immediately because the scout identified only 3 prepare-in-loop callsites and Phase 2 fixes them all. No grandfathering needed.

### 3.5 Initial allowlist for the audit script

The script's first run produces a list of currently-flagged queries. Each gets a `-- @full-scan: <reason>` comment in the SQL string OR is fixed to use an indexed column. Phase 2 closure = audit script exits clean.

---

## 4. Migration playbook

Order tasks by impact-to-cost ratio. Highest-leverage first.

### 4.1 Task A: Fix budget-watcher correctness bug

- Edit `server/db/budget-watcher.js` to replace `SUM(estimated_cost)` with `SUM(cost_usd)` at lines 264, 272, 281, 288.
- Add a unit test that seeds `cost_tracking` rows with known `cost_usd` totals and asserts `getCurrentSpend()` returns the sum. The test would have failed against the old code.
- Verify by running the existing budget-watcher tests + the new test.
- Commit FIRST so the budget-enforcement fix lands fast (independent of the rest of Phase 2).

### 4.2 Task B: Add the `factory_guardrail_events.batch_id` index migration

- Add a new migration to `server/db/migrations.js` that creates `idx_fge_batch ON factory_guardrail_events (project_id, batch_id, created_at)`.
- Update `factory/feedback.js:221-224` to query by `batch_id` instead of loading 100 rows + JS filter.
- Add a test that seeds 100 events across 5 batch_ids and asserts the batch-scoped query returns only the matching subset.

### 4.3 Task C: Add `getLatestScoresBatch` and migrate the 2 callers

- Add `getLatestScoresBatch(projectIds)` to `server/db/factory-health.js`.
- Update `handleFactoryStatus` and `handleListFactoryProjects` in `server/handlers/factory-handlers.js` to call the batch primitive once and build a `Map<projectId, scores>`.
- Add an `assertMaxPrepares` test for both handlers asserting `prepares <= 4`.

### 4.4 Task D: Add `getScoreHistoryBatch` and migrate `handleProjectHealth`

- Add `getScoreHistoryBatch(projectId, dimensions, limit)` to factory-health.js.
- Update `handleProjectHealth` to call it once when `include_trends` is true.
- Add an `assertMaxPrepares` test for `handleProjectHealth({include_trends: true})`.

### 4.5 Task E: Hoist `_cleanOrphanedTaskChildren` prepares

- Add a module-level `_childTableDeletes` cache in `server/db/task-core.js` keyed by table name, initialized lazily on first use.
- Update `_cleanOrphanedTaskChildren(taskId)` to look up the prepared statement and call `.run(taskId)`.
- Add an `assertMaxPrepares` test for the bulk-delete path.

### 4.6 Task F: Implement `torque/no-prepare-in-loop` ESLint rule

- Implement the rule + tests under `server/eslint-rules/no-prepare-in-loop.js` and `server/tests/eslint-rule-no-prepare-in-loop.test.js`.
- Configure in `server/eslint.config.js` in `error` mode (no `warn` intermediate; Tasks D and E have already cleared the existing offenders).
- Run `npm run lint`; expect zero violations.

### 4.7 Task G: Implement `assertMaxPrepares` helper

- Add the helper to `server/tests/test-helpers.js` (or `perf-test-helpers.js` if test-helpers is too crowded).
- Wire the assertions into the per-finding tests added in Tasks C, D, E.

### 4.8 Task H: Combine `getHealthSummary` queries

- Rewrite `getHealthSummary` to use a single window-function query: `SELECT *, ROW_NUMBER() OVER (PARTITION BY check_type ORDER BY checked_at DESC) AS rn FROM health_status WHERE rn <= 10`.
- Partition results in JS to recreate the existing return shape.
- Add an `assertMaxPrepares` test asserting `prepares <= 2`.

### 4.9 Task I: Combine `getDatabaseHealth` and `getSystemMetrics` queries

- Replace both for-of loops with single combined subqueries.
- These are bounded loops (5 and 6 entries) but the prepare-in-loop pattern violates the rule.

### 4.10 Task J: Cache `getAuditLogColumns`

- Add module-level `_auditLogColumnsCache = null` to `server/db/scheduling-automation.js`.
- Mirror the `task-metadata.js getTaskFileChangeColumns` fix pattern.

### 4.11 Task K: `json_each()` for tag aggregation

- Rewrite the 3 tag-aggregation queries (`getAllTags`, `getTagStats`, `getProjectStats` tag scan) using SQLite's `json_each(tasks.tags)`.
- Existing tests should keep passing; the return shape doesn't change.

### 4.12 Task L: Combine `getProjectStats` count queries

- The 7 sequential count queries become 1 combined subquery.
- The recent-tasks and top-templates queries stay (already LIMIT-bounded).
- Combined with Task K's tag fix, the function drops from 7 round-trips + N JSON.parse to ~2 round-trips total.

### 4.13 Task M: `LIMIT 500` on project-cache semantic fallback

- Add `LIMIT 500` to the fallback `SELECT * FROM task_cache WHERE expires_at...` query.
- Add a test asserting the function bounds memory under load (no full-table scan when fallback fires).

### 4.14 Task N: `handlePauseAllProjects` transaction wrap

- Wrap the per-project loop in `db.transaction()`. Hoist the UPDATE prepare outside.
- Add a test asserting `prepares <= 3` (one UPDATE statement, one audit-log INSERT, one project-list SELECT).

### 4.15 Task O: `getProjectByPath` LIMIT bound

- Add `LIMIT 50` to the fallback scan.
- Document the legacy-path-normalization concern in a comment for the v0.1 follow-up.

### 4.16 Task P: Implement `scripts/audit-db-queries.js`

- Build the audit script + tests.
- First run produces a list of currently-flagged queries (probably small after Tasks A-O land).
- For each: either fix to use an indexed column, or add `-- @full-scan: <reason>` to the SQL string.
- Wire into `scripts/pre-push-hook` to run after the perf gate, before the trailer-validator.

### 4.17 Task Q: Re-scout closure verification

- `submit_scout` (provider claude-cli) scoped to N+1 + index patterns. Output to `docs/findings/2026-04-25-perf-arc/phase-2-nplusone-post.md`.
- Confirm zero new findings beyond what's been deliberately deferred to v0.1.

### 4.18 Task R: Capture perf baseline updates

- Run `npm run perf` on canonical workstation. `db-factory-cost-summary` should improve (Task C+D). `db-project-stats` should improve (Tasks K+L). `db-budget-threshold` should now produce meaningful values (Task A — was returning 0 silently).
- Update `baseline.json` with `--update-baseline`. Commit with `perf-baseline:` trailers per moved metric.

---

## 5. Tracked-metric updates to `baseline.json`

### 5.1 Existing metrics that should move

| Metric | Current baseline | Expected after Phase 2 |
|---|---|---|
| `db-factory-cost-summary` | 0.56ms | similar (Phase 0's metric was already against the silently-fixed cost-metrics path) |
| `db-project-stats` | 1.13ms | ~0.5-0.7ms (7 queries → 2; tag scan via json_each) |
| `db-budget-threshold` | 0.16ms | should NOW produce a non-zero meaningful spend value (currently 0 because column was wrong) — measurement may stay similar but the DATA is now real |

### 5.2 New tracked metric proposed (optional)

- **`handler-factory-status`** — measures `handleFactoryStatus` end-to-end with a 5-project fixture. Captures the N+1 fix from Task C directly. Without this metric, the fix's signal lives only in DB-layer metrics, which won't move much because each individual query is fast — the win is the count reduction.

This metric is recommended but not required for Phase 2 closure (the audit script + prepare-count tests provide structural coverage even without a wall-clock metric).

### 5.3 Update protocol

Cutover commit (or follow-on) carries `perf-baseline:` trailers per moved metric:

```
perf-baseline: db-project-stats <old> to <new> (Phase 2: 7 sequential queries combined to 2; tag scan via json_each)
perf-baseline: db-budget-threshold <old> to <new> (Phase 2: estimated_cost column rename — query now sees real spend)
```

---

## 6. Phase closure criteria (per umbrella §3.5)

1. **All findings closed** — fresh scout returns zero NEW findings beyond what's deferred to v0.1 (vector index, path normalization).
2. **Discipline rules live** — `torque/no-prepare-in-loop` in `error` mode; `assertMaxPrepares` wired into 6 perf-tracked handler tests; `scripts/audit-db-queries.js` in pre-push hook with zero violations.
3. **Tracked metrics moved by the phase, captured in baseline** — `db-project-stats` improves >10% AND `db-budget-threshold` baseline reflects real (non-zero) spend value. Baseline updated with `perf-baseline:` trailer.
4. **Re-scout confirms zero** — post-merge scout file at `docs/findings/2026-04-25-perf-arc/phase-2-nplusone-post.md`.
5. **Bonus correctness criterion** (specific to Phase 2): `getCurrentSpend` returns non-zero values when `cost_tracking` has rows. Sanity-check during cutover.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Budget-watcher fix changes behavior in production immediately on cutover (budget alerts start firing for the first time in months) | Fix lands as Task A first commit. After cutover, monitor for budget alert fan-out. If a dashboard panel surfaces budget at 100% across projects (because nobody set budget limits while the bug was active), surface to user immediately for triage. |
| `getLatestScoresBatch` and `getScoreHistoryBatch` produce different result shapes than the per-project calls | Each task's assertMaxPrepares test also asserts the result shape matches the existing per-project call (snapshot test). |
| `factory_guardrail_events.batch_id` migration on a populated production DB | Index creation is fast on a small table (factory_guardrail_events typically has <10K rows). Migration is non-blocking. |
| `_cleanOrphanedTaskChildren` cache leaks memory if dynamic table set ever grows | The 38 child tables are static and known at module load. Cache is bounded and small. Document the assumption inline. |
| `json_each()` requires SQLite ≥3.18 | better-sqlite3 ships with SQLite 3.40+; safe. |
| `audit-db-queries.js` produces too many false positives on first run | Use the `-- @full-scan: <reason>` annotation generously for known-acceptable cases (e.g., admin dump endpoints, MIGRATIONS table). The audit's job is to catch unintended unindexed queries, not flag every full-scan. |
| Phase 2 cutover triggers TORQUE restart while factory tasks running | Pause factory projects via REST `pause-all` before cutover (per umbrella §4.4); resume after restart confirmed. Same procedure as Phase 1 cutover. |

---

## 8. Execution shape

- **Worktree:** `feat-perf-2-nplusone` (already created at `.worktrees/feat-perf-2-nplusone/`).
- **Branch:** `feat/perf-2-nplusone` (off main `9624f171`, includes Phases 0+1+4).
- **Implementation plan:** Written via `superpowers:writing-plans` from this worktree after spec approval.
- **Execution path:** `superpowers:subagent-driven-development` per umbrella §4.1, same pattern as Phase 0/1/4.
- **Cutover:** `scripts/worktree-cutover.sh perf-2-nplusone`. Pause factory before; resume after restart confirmed. Phase 2 has no parallel-cutover concerns since Phases 1+4 already shipped.
- **Conflict surface:** none — Phase 2 only touches `server/db/**`, `server/handlers/factory-handlers.js`, `server/eslint-rules/`, `scripts/`. No other phase will interleave.
