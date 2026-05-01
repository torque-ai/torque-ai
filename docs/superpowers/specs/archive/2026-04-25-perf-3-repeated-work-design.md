# Phase 3 Child Spec — Repeated Work + Per-Request Allocations

**Status:** Draft 2026-04-26 (pending user review). FINAL phase of the perf hunt arc.

**Parent:** `docs/superpowers/specs/2026-04-25-perf-arc-umbrella-design.md` §3.3, §4.2 row 5

**Pre-flight findings:** `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-pre.md` (scout commit `b4034435`)

**Goal:** Close the remaining repeated-work + per-request-allocation patterns the prior arc didn't already absorb, ship the `listTasks({raw:true})` option that Phase 0's metric #9 forward-compatibly anticipated, add the `Operations > Perf` dashboard panel for per-handler allocation visibility, update the PR template with a per-request-allocation review checklist, and capture the perf gate baseline updates that close out the arc.

## 1. State of the world (vs the umbrella spec's assumptions)

Umbrella §4.2 row 5 anticipated module-level memoization for: `getTaskFileChangeColumns`, `getAuditLogColumns`, dashboard directory resolution, SSE `getAllowedOrigins` Set, `listTasks` raw mode, plus a dashboard `Operations > Perf` panel and a PR template update.

**Most of the umbrella's anticipated targets were silently absorbed by Phases 1, 2, and 4 as the arc progressed.** What remains is genuinely small:

**Already closed (no Phase 3 action):**
- `getTaskFileChangeColumns` PRAGMA cache — fixed pre-arc (`server/db/task-metadata.js:42-48`)
- `getAuditLogColumns` PRAGMA cache — Phase 2 Task J (`server/db/scheduling-automation.js:59`)
- `dashboard-server.js` `existsSync` per request — Phase 1 cleanup (`server/dashboard-server.js:84` `DASHBOARD_STATIC_DIR` constant)
- `getAllowedOrigins()` per-SSE-request Set — already cached at module level (`server/mcp-sse.js:92` `ALLOWED_ORIGINS` constant; `invalidateAllowedOriginsCache()` retained as no-op for backward compat)

**What remains** (this phase's scope):

- 0 HIGH
- 2 MEDIUM (capability-Set per-tick allocation, `listTasks` JSON-parse per row)
- 5 LOW (invariant-literal Sets in scheduler/router; 2 new PRAGMA cases in budget-watcher + pack-registry)
- Dashboard `Operations > Perf` panel (visibility for per-handler allocations + PRAGMA call counts)
- PR template update (review checklist for per-request allocations)

This phase has the **WEAKEST formal enforcement** of all four implementation phases per umbrella §3.3. There is no hard ESLint rule for "module-level memoization" — the discipline relies on dashboard visibility + code review + PR checklist + the perf-harness `db-list-tasks` raw-vs-parsed metric divergence (the only mechanical signal).

---

## 2. Scope

### 2.1 In scope (from scout)

**MEDIUM:**

1. **`slot-pull-scheduler.js:99`** — `findBestTaskForProvider` allocates `new Set(getProviderCapabilities(provider))` per heartbeat tick per provider. With 5 providers active, that's ~5 Sets per scheduler tick (every 1-5s). Secondary callsites: `provider-capabilities.js:58` (`meetsCapabilityRequirements`), `handlers/integration/routing.js:142` (`providerSupportsRepoWriteTasks`). Fix: cache per-provider capability Sets at module level in `provider-capabilities.js`, expose `getProviderCapabilitySet(provider)` returning a cached Set. Invalidation: clear cache when `setDb()` is called or when a provider's `capability_tags` row changes.

2. **`task-core.js:972-979` (listTasks JSON-parse per row)** — `listTasks` always applies `safeJsonParse` to `context`/`files_modified`/`tags` columns regardless of caller need. Dashboard `/api/v2/tasks` Kanban poll fires this 1000× per request (3 parses per row × 1000 rows). **This finding maps directly to Phase 0 metric #9 (`db-list-tasks` raw vs parsed) which was forward-compatibly designed to land here.** Fix: add `raw: true` option that skips post-processing entirely. Update analytics handlers in `v2-analytics-handlers.js:515` that immediately re-parse `task.metadata` to pass `raw: true`.

**LOW:**

3. **`provider-router.js:287`** — `new Set(['anthropic', 'groq', 'codex', 'claude-cli'])` (`paidProviders`) allocated per `resolveProviderRouting()` call. Fix: hoist to module-level constant `PAID_PROVIDERS`.

4. **`queue-scheduler.js:438` + `:841`** — two identical `new Set(['ollama'])` (1-element Sets) allocated per scheduler tick. Fix: hoist to module-level constants `GPU_SHARING_PROVIDERS` and `OLLAMA_GPU_PROVIDERS` (or one shared constant — confirm during implementation if the two callsites are semantically equivalent).

5. **`budget-watcher.js:160-162` (`hasThresholdConfigColumn` PRAGMA per `buildBudgetStatus`)** — `PRAGMA table_info(cost_budgets)` runs on every call, twice per `buildBudgetStatus` (via `ensureThresholdConfigStorage` + `readThresholdConfig`). Fix: module-level boolean cache `_hasThresholdConfigColumnCache`. Pattern matches Phase 2's `getAuditLogColumns` fix.

6. **`pack-registry.js:13-21` (`getPackRegistryColumnInfo` PRAGMA per `listPacks`/`registerPack`)** — same shape as #5. Cold path (rarely invoked) but a clean cosmetic fix. Module-level cache `_packRegistryColumnInfoCache`.

### 2.2 Phase 3 also ships (umbrella §4.2 row 5)

7. **Dashboard `Operations > Perf` panel** — surfaces per-handler call counts + per-request allocation tallies + PRAGMA-per-second metrics. Sources data from a lightweight in-memory counter the harness drives. Phase 3 ships the panel skeleton + 3-4 representative metrics; deeper instrumentation is v0.1.

8. **PR template update** — adds a checklist item: "Any new per-request allocation in this PR? Cached why-not? Pre-flight check: grep for `new Set(`, `new Map(`, `JSON.parse`, `PRAGMA ` inside handler/scheduler hot paths." Lives at `.github/PULL_REQUEST_TEMPLATE.md` (or `docs/templates/pr-checklist.md` if no GitHub template exists yet).

### 2.3 Out of scope (deferred to v0.1)

- **Lazy-parse wrapper for listTasks** (alternative to `raw: true`). The proxy/getter approach is invasive; `raw: true` covers the high-leverage cases.
- **Deep instrumentation of all handlers** for the Operations > Perf panel. Phase 3 ships representative coverage; full instrumentation is its own arc.
- **`chunked-review.js readFileSync`** — explicitly grandfathered in Phase 1 scope (sync-io pattern, not repeated-work pattern). v0.1 candidate for the Phase 1.5 follow-up.

---

## 3. Discipline rules

### 3.1 No new hard ESLint gate

Per umbrella §3.3, repeated-work / per-request allocations are too varied to lint mechanically. The closest mechanical check is "is `new Set(...)` or `new Map(...)` constructed inside a handler/scheduler function with all-literal arguments?" — but false positives would dominate (legitimate per-iteration Sets that depend on iteration state). Phase 3 deliberately ships **no ESLint rule** for this pattern class.

### 3.2 Soft enforcement layers (3-tier)

**Tier 1: PR template checklist** (Section 2.2 item 8).

**Tier 2: Dashboard `Operations > Perf` panel** (Section 2.2 item 7) — gives reviewers visibility into per-handler allocation counts and PRAGMA frequencies. Not a gate, but a fact-check tool.

**Tier 3: Existing perf-harness gate** — Phase 0's regression gate (10% threshold) catches significant regressions on the tracked metrics. The `db-list-tasks` raw-vs-parsed metric is the most direct signal for Phase 3-class drift.

### 3.3 No grandfather list needed

Unlike Phases 1, 2, and 4 (each of which has explicit grandfathered exceptions in their ESLint rule allowlists), Phase 3 has no hard gate to grandfather against. The 7 findings ship clean fixes; no exception annotations needed.

---

## 4. Migration playbook

Order tasks by impact-to-cost ratio and natural grouping.

### 4.1 Task A: Hoist invariant Sets (Group A — mechanical)

- `provider-router.js:287` — extract `PAID_PROVIDERS` constant.
- `queue-scheduler.js:438` — extract `GPU_SHARING_PROVIDERS` constant. Read `:841` in the same edit; if both Sets are semantically equivalent, share one constant; if their intent diverges, keep two with distinct names.
- One commit, three callsites.

### 4.2 Task B: Capability Set memoization (Group B)

- Add `_capabilitySetCache: Map<string, Set<string>>` at the top of `server/db/provider-capabilities.js`.
- Add `getProviderCapabilitySet(provider)` that:
  1. Returns cached Set if present.
  2. Otherwise calls `getProviderCapabilities(provider)`, wraps in a Set, caches under provider name, returns.
- Invalidation: clear cache in `setDb()` (existing module-scope hook). Also clear when `setProviderCapabilities(provider, ...)` is called (writes to DB).
- Update callers: `slot-pull-scheduler.js:99`, `provider-capabilities.js:58` (meetsCapabilityRequirements), `handlers/integration/routing.js:142` (providerSupportsRepoWriteTasks).
- Add a unit test: 100 calls to `getProviderCapabilitySet('codex')` → 1 underlying `getProviderCapabilities` call (assert via spy).

### 4.3 Task C: PRAGMA caches (Group C)

- `server/db/budget-watcher.js`: add `_hasThresholdConfigColumnCache = null` module-level. Update `hasThresholdConfigColumn(database)` to return cached value if non-null. Mirrors `scheduling-automation.js:59` exactly.
- `server/db/pack-registry.js`: add `_packRegistryColumnInfoCache = null`. Update `getPackRegistryColumnInfo()` similarly.
- Both fixes are one-file edits with no cross-file impact.
- Add unit tests: each cache returns the same array/boolean across 100 calls (proven by spy on the underlying PRAGMA).

### 4.4 Task D: `listTasks({raw: true})` — Phase 0 metric #9 forward-compat lands (Group D, the keystone)

- Add `raw` option to `server/db/task-core.js:listTasks(options)`. When `options.raw === true`, skip the `safeJsonParse` post-processing for `context`/`files_modified`/`tags`/`metadata`.
- Existing callers default to `raw: false` (no behavior change for them).
- Update analytics handlers in `server/handlers/v2-analytics-handlers.js:515` (and any other callers that immediately re-parse `task.metadata` after `listTasks` returns it) to pass `raw: true`.
- Add a perf-harness assertion: when `db-list-tasks` runs the `raw` variant, the resulting median must be lower than the `parsed` variant median by at least 20% (the JSON-parse overhead is the only difference).

### 4.5 Task E: Dashboard Operations > Perf panel (skeleton)

- Add a new panel route at `/operations/perf` in the dashboard.
- Backend: lightweight in-process counter exposed via `/api/v2/operations/perf` REST endpoint. Counts:
  - `listTasks` calls per second (parsed vs raw)
  - Slot-pull heartbeat capability-Set construction count per minute (after Task B should be near-zero)
  - PRAGMA call frequency per table (cost_budgets, pack_registry)
- Frontend: simple table view (no heavy charting). Auto-refreshes every 30s.
- Phase 3 ships the skeleton; v0.1 deepens instrumentation.

### 4.6 Task F: PR template checklist update

- Edit `.github/PULL_REQUEST_TEMPLATE.md` (or create `docs/templates/pr-checklist.md` if no GitHub template exists). Add a section:

```markdown
## Performance review (Phase 3 discipline)

- [ ] Any new `new Set(...)`, `new Map(...)`, or `JSON.parse(...)` inside handler/scheduler functions with all-literal/invariant arguments? If yes — hoist to module level OR document why per-call construction is required.
- [ ] Any new `PRAGMA table_info(...)` or schema introspection in a hot path? If yes — cache result at module level (see `scheduling-automation.js:59` for the canonical pattern).
- [ ] Any new `listTasks(...)` call where the caller will re-parse `metadata`/`tags`/`files_modified` themselves? If yes — pass `raw: true` to skip the redundant parse.
```

### 4.7 Task G: Perf baseline update

- Run `npm run perf` on the canonical workstation. Expected movements:
  - `db-list-tasks.raw` should now differ measurably from `db-list-tasks.parsed` (Phase 0 forward-compat lands; the divergence is the validation that Phase 3 worked).
  - `db-list-tasks.parsed` baseline may stay similar (the parse work is unchanged for parsed callers).
- Update `baseline.json` with `--update-baseline`. Commit with `perf-baseline:` trailer per moved metric.

### 4.8 Task H: Re-scout closure verification

- `submit_scout` (provider claude-cli) scoped to repeated-work + per-request-allocation patterns. Output to `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-post.md`.
- Confirm zero new findings beyond what's deferred to v0.1.

---

## 5. Tracked-metric updates to `baseline.json`

### 5.1 Existing metrics that should move

| Metric | Current baseline | Expected after Phase 3 |
|---|---|---|
| `db-list-tasks.parsed` | unchanged | unchanged (parsed callers still parse) |
| `db-list-tasks.raw` | currently same as parsed (Phase 0 placeholder) | **>20% lower than parsed** — the divergence proves Phase 3 worked |

### 5.2 New tracked metric (proposed)

- **`handler-listTasks-1000`** — measures `handleListTasks({project, limit: 1000, raw: true})` end-to-end at the MCP handler layer. Captures the analytics-handler benefit directly. Optional; the `db-list-tasks.raw` divergence is sufficient signal.

### 5.3 Update protocol

Cutover commit (or follow-on) carries `perf-baseline:` trailers per moved variant:

```
perf-baseline: db-list-tasks.parsed <old> to <new> (Phase 3: unchanged baseline; parsed callers retain JSON-parse work)
perf-baseline: db-list-tasks.raw <old> to <new> (Phase 3: raw mode lands; metadata/tags/files-modified strings returned without parsing)
```

---

## 6. Phase closure criteria (per umbrella §3.5)

1. **All findings closed** — fresh scout returns zero NEW findings beyond v0.1 deferrals (lazy-parse wrapper, deep handler instrumentation).
2. **Discipline live** — PR template updated; Operations > Perf dashboard panel reachable; perf-harness `db-list-tasks.raw` variant measurably faster than parsed.
3. **Tracked metrics moved by the phase, captured in baseline** — `db-list-tasks.raw` divergence captured with `perf-baseline:` trailer. (No "20% improvement on existing metric" requirement — the divergence-capture is the evidence.)
4. **Re-scout confirms zero** — post-merge scout file at `docs/findings/2026-04-25-perf-arc/phase-3-repeated-work-post.md`.

### 6.1 Bonus criterion (specific to Phase 3 closing the arc)

- **Umbrella spec §6 child-spec index** updated — Phase 3 marked `shipped` with cutover commit. After Phase 3 lands, the index has all 5 sub-projects in the `shipped` state and the arc is formally complete.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Capability cache invalidation is missed when a provider's `capability_tags` is updated mid-process | Add an explicit `setProviderCapabilities(provider, tags)` write path that clears the cache for that provider. The cache is process-local; restart-on-change is the safety net. |
| `listTasks({raw: true})` callers forget to parse `metadata` themselves and end up with stringified JSON in their UI/response | The change is opt-in; no existing callers see different behavior. The PR template checklist guides new callers. Updated analytics handlers explicitly call `JSON.parse` on `task.metadata` after `listTasks` returns. |
| Operations > Perf dashboard panel adds counter overhead to handlers | The counter increments are O(1) integer adds in already-hot code paths. Total overhead is sub-microsecond per call. Verified by perf gate (no regression on `db-list-tasks` metrics post-instrumentation). |
| PRAGMA caches in budget-watcher / pack-registry mask real schema-migration drift if the column actually changes mid-process | The two columns in question (`threshold_config` on `cost_budgets`, the columns on `pack_registry`) are migration-only and don't change at runtime. If a future migration alters them, restart clears the cache. |
| Phase 3 cutover triggers TORQUE restart unnecessarily (per umbrella §4.4 Phase 3 doesn't need factory pause) | Skip factory pause; cutover proceeds against running factory. Worst case: 1-2 in-flight factory tasks are interrupted by drain (drain barrier handles cleanly). |

---

## 8. Execution shape

- **Worktree:** `feat-perf-3-repeated-work` (already created at `.worktrees/feat-perf-3-repeated-work/`).
- **Branch:** `feat/perf-3-repeated-work` (off main `68c6ba5a`, includes Phases 0+1+2+4).
- **Implementation plan:** Written via `superpowers:writing-plans` from this worktree after spec approval.
- **Execution path:** `superpowers:subagent-driven-development` per umbrella §4.1, same pattern as Phases 0/1/2/4.
- **Cutover:** `scripts/worktree-cutover.sh perf-3-repeated-work`. **No factory pause needed** per umbrella §4.4. Phase 3 doesn't touch hot-path code that the factory exercises continuously.
- **Conflict surface with main:** none — Phase 3 only touches `server/db/{provider-capabilities,budget-watcher,pack-registry,task-core}.js`, `server/execution/{slot-pull-scheduler,queue-scheduler,provider-router}.js`, `server/handlers/{integration/routing,v2-analytics-handlers}.js`, `dashboard/`, `.github/`. No other phase will interleave.
- **After cutover:** umbrella spec §6 index update flips Phase 3 to `shipped`. **The perf hunt arc is then formally complete** — all 5 sub-projects shipped with the regression gate in place.
