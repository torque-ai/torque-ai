# Performance Hunt — Arc Umbrella Design

**Status:** Approved 2026-04-25 by user (designation: "Fixer" session). Append-only after initial commit; mid-arc discipline-rule revisions require a deliberate commit with rationale.

**Goal:** Hunt down all performance issues in TORQUE that slow the project or its development cycle, fix them under a discipline that prevents the *class* from recurring, and lock the wins in via a regression gate.

**Driving constraints:**

- Lasting solutions, not quick wins. Every fix is paired with a discipline rule that prevents the pattern from re-emerging.
- Single-session execution shape. Pacing follows LLM throughput (TORQUE teams plus Codex/Claude scouts), not human-coordination overhead. Calendar compresses; rigor does not.
- Re-scout before each phase. The 4 prior performance scans (2026-04-04, 2026-04-05, 2026-04-12) are priors, not ground truth. Each phase starts with a fresh scout against current main.
- Strict regression gate, narrow surface. ~13 tracked metrics, 10% threshold, deliberate-commit baseline updates.

---

## 1. Arc + Decomposition

### 1.1 Sub-projects

| # | Sub-project | Pattern | Discipline | Enforcement |
|---|-------------|---------|------------|-------------|
| 0 | **Perf baseline + regression gate** | (cross-cutting) | "Perf-tracked metrics committed to repo, baseline updates require deliberate commit" | Pre-push gate fails if any tracked metric regresses >10%; baseline JSON committed |
| 1 | **Sync I/O on hot paths** | Synchronous filesystem, git, and subprocess calls inside request handlers, completion pipeline, governance hooks, audit walks | "No synchronous I/O in hot-path files; reach for promises by default" | Custom ESLint rule with hot-path file glob list plus allowlist for startup-only callsites |
| 2 | **N+1 queries + missing/wrong indexes** | factory-handlers per-project loops, cost-metrics 3x recomputation, budget-watcher querying wrong column, unindexed cache lookups | "Batched-read primitives over per-row loops; query-column-matches-index audit at PR time" | Test-time prepared-statement counter wrapper that asserts max prepares per request; pre-push grep audit for queries against unindexed columns |
| 3 | **Repeated work / per-request allocations** | PRAGMA per file change, Set allocation per SSE request, dashboard existence checks per request, JSON parse per row | "Module-level memoization for invariant computations; per-request allocations require justification" | Code review checklist plus handler call-counter visibility on dashboard panel |
| 4 | **Test infra import bloat** | 350-module mega-import via `setupTestDb()`, `database.js` 44-module facade, `task-manager.js` pulling `dashboard-server.js` | "Lazy-load coupling-bridge modules; setupTestDb has variants by need" | Vitest setup measures import time per file (warn >250ms, fail >500ms); ESLint rule against importing `tools.js` / `task-manager.js` from tests |

### 1.2 Sequence

`0` first (alone, establishes the gate) → `1` and `4` in parallel (disjoint surfaces) → `2` (DB layer, conflicts with Phase 1 surface) → `3` (repeated work, smallest bucket).

### 1.3 What "done" means for the arc

The arc is shipped when **all five** sub-projects have met phase closure criteria (Section 3.5) AND the umbrella's child-spec index shows every phase as `shipped` with a cutover commit hash.

### 1.4 Worktree topology

One worktree per active sub-project, named `feat-perf-<phase>-<slug>`:

- `feat-perf-0-baseline`
- `feat-perf-1-sync-io`
- `feat-perf-2-nplusone`
- `feat-perf-3-repeated-work`
- `feat-perf-4-test-infra`

Phases 1 and 4 hold simultaneous worktrees; phases 0, 2, 3 hold one worktree at a time.

---

## 2. Sub-project 0 — Performance Baseline + Regression Gate

This is the contract every other phase reports into. Sub-project 0 has no separate child spec — *this section IS the child spec*.

### 2.1 Tracked metric set (v0)

13 metric definitions; metrics #9 and #11 have multiple variants (each variant gets its own entry in `baseline.json`), bringing the actual baseline-entry count to ~17. The 10% regression threshold applies per-entry.

| # | Metric | Scope | Run shape |
|---|--------|-------|-----------|
| 1 | Queue scheduler tick | Hot-path runtime | Median of 1000 ticks, in-process |
| 2 | Task pipeline `handleTaskCreate` end-to-end | Hot-path runtime | Median of 100, in-process |
| 3 | Governance `evaluate()` per submission | Hot-path runtime | Median of 100, in-process |
| 4 | Dashboard `/api/v2/projects/:id/stats` | Request latency | p95 of 50 HTTP requests against test server |
| 5 | MCP tool round-trip for `task_info` | Request latency | p95 of 100 calls via MCP harness |
| 6 | SSE notification fan-out (subscribe → broadcast → receive) | Request latency | p95 of 50 cycles via real SSE client |
| 7 | DB: factory cost summary for 100-task batch | DB query timing | Median of 50 |
| 8 | DB: `getProjectStats` for project with 1000 tasks | DB query timing | Median of 50 |
| 9 | DB: `listTasks` 1000 rows (raw vs parsed) | DB query timing | Median of 50, two variants |
| 10 | DB: budget threshold check (windowed spend lookup) | DB query timing | Median of 50 |
| 11 | Cold import: `tools.js`, `task-manager.js`, `database.js`, `db/task-core.js` | Test infra | Median of 10 cold imports per module (separate Node processes) |
| 12 | Worktree create + cleanup wall time | Dev iteration | Median of 5 |
| 13 | Restart barrier: drain → shutdown → ready | Dev iteration | Median of 5 |

Each metric: warmup runs plus N measurement runs, take median, trim top/bottom 10% as outliers. Tolerance is plus/minus 10% on the median.

### 2.2 Harness architecture

- **Layout:** `server/perf/`
  - `run-perf.js` — main entry (`npm run perf`)
  - `metrics/<metric-slug>.js` — one module per metric, exports `name`, `category`, `runs`, `warmup`, `run()`, `units`
  - `fixtures.js` — shared seeded fixture builder (1000-task project, 100-task batch, etc.) for stable measurement
  - `baseline.json` — committed; current accepted baseline values
  - `last-run.json` — gitignored; written every run
  - `report.js` — emits human-readable diff vs baseline
- **Output format:** baseline.json is `{ metric_id: { median_ms, p95_ms (when applicable), runs, env, captured_at } }`. last-run.json mirrors the shape and adds `delta_pct_vs_baseline`.
- **Run command:** `npm run perf` from `server/`. Exits 0 if all tracked metrics within tolerance; exits 1 if any regressed >10%.
- **Stability strategy:** harness routes through `torque-remote` when available (canonical perf environment is the user's workstation); local fallback runs with a "local timings, advisory only" banner.
- **Env capture:** every report records `cpu_count`, `total_memory_mb`, `node_version`, `platform`, `host_label`. Reports compare baseline-to-current env; if env differs, the report flags advisory-only and does not gate.

### 2.3 Gate enforcement

- **Pre-push integration:** `scripts/pre-push-hook` already runs the dashboard + remote server suite on pushes to `main`. Add a perf step:
  - If the push targets `main` (or a merge into main), run `npm run perf` against the staging branch (`pre-push-gate/<sha>`) via `torque-remote`.
  - Compare to `baseline.json`. Fail the push if any tracked metric regressed >10%.
- **Bypass:** `git push --no-verify` (existing escape hatch). Additional `PERF_GATE_BYPASS=1 git push` env-var bypass for known-acceptable regressions during incident response. Both bypass paths log to `server/perf/bypass-audit.log` (or to TORQUE governance audit if available).

### 2.4 Baseline update protocol

- When a fix legitimately changes a baseline (e.g., Phase 1 makes governance `evaluate()` 5x faster), the implementer runs `npm run perf -- --update-baseline` in the worktree. This rewrites `baseline.json` with current timings plus a `last_updated_at` field per metric.
- The commit that touches `baseline.json` MUST include a `perf-baseline:` trailer per changed metric. Example trailers:

  ```
  perf-baseline: tools.js cold-import 335ms to 31ms (Phase 4: lazy-load setupTestDb variants)
  perf-baseline: governance evaluate() 1.8s to 0.42s (Phase 1: async git subprocesses)
  ```
- **Pre-push validation:** if `baseline.json` is in the diff, the commit message MUST contain at least one `perf-baseline:` trailer with non-empty rationale (>20 chars after the arrow). Gate fails otherwise. This forces every baseline change to be deliberate and rationale-tagged in `git log`.

### 2.5 Phase 0 deliverables

When Sub-project 0 cuts over to main, the repo contains:

1. `server/perf/` directory (runner, 13 metric modules, fixtures, report generator).
2. `server/perf/baseline.json` — initial baseline captured on the user's `torque-remote` workstation.
3. `server/package.json` updated with `npm run perf` script.
4. `scripts/pre-push-hook` updated to run perf step for pushes to main.
5. `scripts/perf-baseline-trailer.js` (or shell equivalent) — validates `perf-baseline:` trailer presence in commits that touch `baseline.json`.
6. `server/perf/README.md` — documents the metric set, run protocol, baseline update protocol, exception process.
7. `.gitignore` updated to exclude `server/perf/last-run.json` and `server/perf/bypass-audit.log`.

### 2.6 Phase 0 non-goals

- No discipline rules added in Phase 0. Sub-project 0 establishes the *gate*; the rules come with Phases 1-4.
- No metrics added that depend on Phase 1-4 work (e.g., per-handler call counts come with Phase 3).
- No backfill of historical perf data — baseline starts fresh today.

---

## 3. Discipline Framework

Each pattern class gets a rule, an enforcement mechanism, an exception protocol, and a migration playbook. The discipline ships *with* the sweep — not after it.

### 3.1 Phase 1 — Sync I/O

- **Rule:** No synchronous filesystem, git, or subprocess calls in hot-path files. Specifically: `readFileSync`, `writeFileSync`, `statSync`, `existsSync` from `fs`, plus `execFileSync`, `execSync`, `spawnSync` from the `child_process` module.
- **Hot-path file globs:**
  - `server/handlers/**`
  - `server/execution/**`
  - `server/governance/**`
  - `server/audit/**`
  - `server/api/**`
  - `server/dashboard-server.js`
  - `server/queue-scheduler*.js`
  - `server/maintenance/orphan-cleanup.js`
- **Enforcement:** Custom ESLint rule `torque/no-sync-fs-on-hot-paths` lives in `server/eslint-rules/`, configured in `server/eslint.config.js`. CI lint step in pre-push gate fails if violated.
- **Exception:** `// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- <reason>` — rule requires reason text >10 chars. Enforces real justification.
- **Migration:** Phase 1 starts with an allowlist of all current violations (auto-generated by running the rule once). Each sub-task removes one offender from the allowlist plus fixes it. Phase 1 closure = allowlist empty.

### 3.2 Phase 2 — N+1 + indexes

- **Rules:**
  - No prepared-statement creation inside loops, `.map()`, `.forEach()`. (Hoist prepares outside the loop body.)
  - WHERE clauses in `server/db/**` and `server/handlers/**` must reference indexed columns (or carry a `-- @full-scan: <reason>` SQL comment).
  - `.all()` without LIMIT requires `-- @bounded-by: <reason>` comment.
- **Enforcement (3-layer):**
  - ESLint rule `torque/no-prepare-in-loop` (catches obvious cases).
  - Test helper `assertMaxPrepares(handler, max)` runs `handler` and asserts prepared-statement invocation count. Phase 2 wires this into perf-tracked handler tests (`/api/v2/projects/:id/stats` ≤ 8, `factoryHealth.summary` ≤ 3, etc.).
  - Pre-push audit script `scripts/audit-db-queries.js` scans `server/db/**/*.js` plus `server/handlers/**/*.js` against `schema-tables.js` index list. Flags queries against unindexed columns lacking the `@full-scan` tag.
- **Exception:** SQL comment with `@full-scan: <reason>` or `@bounded-by: <reason>`. Audit script enforces non-empty reason.
- **Migration:** Phase 2 fixes all flagged callsites plus introduces 1-2 batched-read primitives (`getLatestScoresBatch(projectIds)`, `buildProjectCostSummaryBatch(projectId)` shared cache) so future code has the right shape available.

### 3.3 Phase 3 — Repeated work / per-request allocations

This pattern is the hardest to lint. Best-fit enforcement:

- **Rule:** Module-level memoization for computations invariant after startup. Per-request allocations require explicit justification.
- **Enforcement:**
  - Per-handler "calls per request" counter exposed in the perf harness (Phase 3 adds a metric category for it). Regression gate catches unintended growth.
  - Code review checklist appended to PR template: "Any new per-request allocation? Cached why-not?"
  - Dashboard `Operations > Perf` panel surfaces top-10 per-request hot allocations. Anyone editing those handlers sees the cost in the dashboard.
- **Exception:** No formal mechanism. Code review is the gate.
- **Migration:** Phase 3 sweeps current offenders (PRAGMA per file change, dashboard existence checks, SSE allowed-origins Set, `listTasks` JSON parse), wires the dashboard panel.

### 3.4 Phase 4 — Test infra import bloat

- **Rule:** Tests import only what they need. No top-level `require('../tools')` or `require('../task-manager')` from `server/tests/**` unless the file is on a deliberate allowlist.
- **Enforcement:**
  - ESLint rule `torque/no-heavy-test-imports` enforces the rule with a configured allowlist of legitimate `handleToolCall`-using tests.
  - Vitest setup wrapper measures cold-import time per test file. Logs a warning at >250ms, fails the file at >500ms with a clear error pointing at the heavy module.
- **Exception:** File added to the ESLint rule's allowlist, with a comment explaining why it needs the heavy import.
- **Migration:** Phase 4 splits `setupTestDb` into `setupTestDbOnly` (lightweight, no tools.js) and `setupTestDb` (existing, with tools.js). Migrates ~150 of the 179 files to the lightweight variant. Splits top 20 test files >1000 lines. Deletes the test-helpers.js self-test stub.

### 3.5 Phase closure criteria (all four implementation phases)

A phase is not done until **all four**:

1. **All findings closed** — fresh scout for that pattern returns zero hits.
2. **Discipline rule live** — ESLint rule shipped + enabled in `eslint.config.js`, OR test invariant wired into vitest, OR audit script wired into pre-push gate. Whichever fits the pattern.
3. **Tracked metrics moved by the phase, captured in baseline** — for phases that improve *existing* baseline metrics (Phase 1, 2, 4): at least one improves >10% on the median, with `perf-baseline:` trailer. For phases that *introduce new* baseline metrics (Phase 3 adds per-handler call counts and per-request allocation counters; Phase 1 may add governance `evaluate()` median if not in v0): the new metrics are added to `baseline.json` with their post-fix values, and the addition commit carries a `perf-baseline:` trailer documenting "added in Phase N: <reason>". Either path counts as criterion 3 satisfied.
4. **Re-scout confirms zero** — `/torque-scout performance` re-run scoped to that phase's pattern class returns no findings of that class.

Phases 1+4 run in separate worktrees and meet closure criteria independently before merging. Phases 2 and 3 each get their own worktree.

---

## 4. Phase Orchestration via TORQUE

### 4.1 Phase lifecycle (applies to all 5 sub-projects)

1. **Pre-flight**
   - Fresh `/torque-scout performance` scoped to this phase's pattern (provider: `claude-cli`). Sub-project 0 skips this — it's net-new infra.
   - Read findings; fold into the child spec.
   - Run `scripts/worktree-create.sh perf-<phase>-<slug> --install`.
   - Write child spec to `docs/superpowers/specs/2026-04-25-perf-<phase>-<slug>-design.md`.
   - Invoke `superpowers:writing-plans` from the worktree to produce the implementation plan.
2. **Plan review** — User reviews the plan; adjustments made; plan committed to the worktree.
3. **Execute** — `/torque-team <plan>` from the worktree spawns the Planner / QC / Remediation / (optional) UI Reviewer pipeline. Planner submits via `smart_submit_task` (Codex by default for code-gen).
4. **Verify** — All four closure criteria from §3.5.
5. **Cutover** — `scripts/worktree-cutover.sh perf-<phase>-<slug>` merges to main, drains the queue, runs the restart barrier, restarts on the new code, cleans up the worktree. Perf gate runs as part of pre-push during the cutover; if any tracked metric *unexpectedly* regressed, cutover blocks until investigated.
6. **Post-merge re-scout** — One more `/torque-scout performance` scoped to this phase's pattern, run against merged-and-running main. Findings file committed to `docs/findings/2026-04-25-perf-arc/<phase>-post.md`. If anything new appears, opens follow-up tasks.

### 4.2 Per-phase artifacts

| Phase | Worktree | Team artifacts | Gate additions |
|---|---|---|---|
| **0** Baseline + gate | `feat-perf-0-baseline` | `server/perf/` runner + 13 metric modules + fixtures, `server/perf/baseline.json`, `npm run perf` script, pre-push hook integration, `perf-baseline:` trailer enforcement | Establishes the gate (no metrics added yet — baseline IS today's measurements) |
| **1** Sync I/O | `feat-perf-1-sync-io` | `torque/no-sync-fs-on-hot-paths` ESLint rule + tests, hot-path config, ~25-30 file edits converting sync to async, governance hook async migration, audit-walk async conversion | +2-3 metrics likely (governance `evaluate()` median, audit walk wall time) |
| **4** Test infra | `feat-perf-4-test-infra` | `torque/no-heavy-test-imports` ESLint rule, vitest cold-import measurement wrapper, `setupTestDbOnly` variant, ~150 file migrations, top-20 test file splits | +2-3 metrics (cold-import for `tools.js` / `task-manager.js` / `database.js`, suite total wall time) |
| **2** N+1 + indexes | `feat-perf-2-nplusone` | `torque/no-prepare-in-loop` rule, `assertMaxPrepares` test helper, `scripts/audit-db-queries.js`, batched-read primitives (`getLatestScoresBatch`, `buildProjectCostSummaryBatch`), index additions for `factory_guardrail_events.batch_id` and `task_cache.content_hash`, sweep of factory-handlers + cost-metrics + budget-watcher | +2-3 metrics (factory cost summary, project stats, budget threshold) |
| **3** Repeated work | `feat-perf-3-repeated-work` | Module-level memoization for `getTaskFileChangeColumns`, `getAuditLogColumns`, dashboard directory resolution, SSE allowed-origins Set, `listTasks` raw mode, dashboard `Operations > Perf` panel, PR template update | +1-2 metrics (per-handler call counts, allocations per request) |

### 4.3 Parallelism (Phases 1 + 4)

- Two worktrees active simultaneously: `feat-perf-1-sync-io` and `feat-perf-4-test-infra`.
- Two `/torque-team` pipelines running concurrently (separate Planner + QC + Remediation per worktree).
- Codex slot pressure: each pipeline averages 1-2 concurrent Codex tasks; total ~2-4 concurrent. Within current host capacity.
- Cutover ordering: first to converge cuts over first; the second worktree rebases on the new main before its own cutover. Conflict surface is near-zero (Phase 1 touches `server/handlers/`, `server/execution/`, `server/audit/`; Phase 4 touches `server/tests/`, `server/database.js`, `server/task-manager.js`). The one shared file is `server/eslint-rules/index.js` (both phases ship a new rule); whoever cuts over second adds their export to that file.

### 4.4 Cross-phase rules

- **Restart barrier between phases.** Every cutover uses `await_restart`. No external `taskkill` / `stop-torque.sh`.
- **No factory work during phases 1 or 2.** Both phases edit hot-path code that the factory exercises continuously. Factory projects are paused for the duration of phase 1 and phase 2 cutovers (`pause_all_projects` before cutover, `resume_project` after restart confirmed). Phase 0, 3, and 4 don't need factory pause.
- **Scout findings live in arc-specific dir** — `docs/findings/2026-04-25-perf-arc/<phase>-pre.md` and `<phase>-post.md`. Easy to compare pre-and-post for closure proof.
- **Each phase commits via worktree, not main** — pre-commit hook already blocks direct main commits while worktrees exist. Reinforces existing discipline.

---

## 5. Umbrella → Child Spec Lifecycle

The umbrella spec is the durable contract. Child specs are point-in-time snapshots written when a phase starts, against the repo state and scout findings of that moment.

### 5.1 What lives where

**Umbrella spec** (this document) — written once, today. Append-only after the initial commit:

- The arc + decomposition (§1).
- Sub-project 0 design in full (§2). Sub-project 0's spec IS the umbrella's §2 — there is no separate child spec for Phase 0.
- The discipline framework (§3) — durable rules, exception protocols, closure criteria.
- Phase orchestration lifecycle (§4) — durable lifecycle, not phase-specific findings.
- Child spec index (§6 below) — updated as each child is written.

**Child specs** (`docs/superpowers/specs/2026-04-25-perf-<phase>-<slug>-design.md`) — written just-in-time when a phase starts. Each contains:

- The phase's pre-flight scout findings (verbatim or summarized; full findings linked).
- The specific files/functions to be changed (with current line numbers).
- The discipline rule's exact ESLint config / audit script SQL / test invariant code (per §3 — but with current line numbers and call sites).
- The migration playbook (which violations close in what order; allowlist starting state).
- The phase's tracked-metric additions (which metrics, expected before/after).
- Phase-specific risks and rollback plan.

### 5.2 When each child spec gets written

| Phase | Trigger | Written before |
|---|---|---|
| 0 (= umbrella §2) | After this brainstorming approves | Umbrella commit |
| 1 — Sync I/O | Sub-project 0 cutover complete; perf gate live; `baseline.json` committed | Phase 1 worktree creation |
| 4 — Test infra | Same trigger as Phase 1 (parallel start) | Phase 4 worktree creation |
| 2 — N+1 | Phases 1+4 cut over to main; both verified live (perf gate green; no rollbacks pending) | Phase 2 worktree creation |
| 3 — Repeated work | Phase 2 cut over to main; verified live | Phase 3 worktree creation |

### 5.3 Lifecycle of one child spec

1. **Trigger** — prior phase verified live.
2. **Scout** — `submit_scout` (provider: `claude-cli`) scoped to phase's pattern, working dir = main.
3. **Read findings** — Findings file lands in `docs/findings/2026-04-25-perf-arc/<phase>-pre.md`.
4. **Write child spec** — `superpowers:brainstorming` is *not* re-invoked (umbrella already covers the design); spec is written directly with the findings folded in. User review gate per child spec.
5. **Update umbrella's child-spec index** — one-line entry pointing at the child spec, committed together with the spec.
6. **Worktree create** — `feat-perf-<phase>-<slug>`.
7. **Plan via writing-plans** — produces implementation plan in the worktree.
8. **Plan review by user.**
9. **Execute via /torque-team.**
10. **Verify (closure criteria).**
11. **Cutover** + post-merge re-scout.
12. **Update umbrella's child-spec index** — mark phase as `shipped` with cutover commit hash.

### 5.4 How the umbrella stays current

- Append-only after the initial commit. Mid-arc, only the child-spec index gets updated (status flips: `planned` → `in-progress` → `shipped`). Discipline rules and orchestration sections do not change.
- If a phase discovers something that *should* change the umbrella (e.g., closure criteria don't fit a real situation), that's a deliberate revision: a separate commit with rationale, reviewed before continuing.
- This keeps the umbrella stable enough that mid-arc context can re-anchor on it confidently.

### 5.5 Single-session execution shape

After this spec is approved:

1. Spec self-review (placeholder scan, contradictions, ambiguity).
2. User review gate.
3. On approval, invoke `superpowers:writing-plans` to produce **Phase 0's implementation plan** (umbrella §2 IS Phase 0's spec).
4. Worktree → execute → verify → cutover.
5. Phase 0 verified live → repeat the child-spec lifecycle for Phases 1+4 in parallel, then 2, then 3.

Each phase's "write child spec → review → plan → execute → cutover" cycle stays in the same session unless the user signals otherwise. Each cycle exits cleanly so if sessions split, the resume point is unambiguous.

---

## 6. Child Spec Index

| Phase | Child spec | Status | Cutover commit |
|---|---|---|---|
| 0 — Baseline + gate | (umbrella §2) | planned | — |
| 1 — Sync I/O | (written when phase starts, after Phase 0 cutover) | planned | — |
| 4 — Test infra | (written when phase starts, after Phase 0 cutover) | planned | — |
| 2 — N+1 + indexes | (written when phase starts, after Phases 1+4 verified live) | planned | — |
| 3 — Repeated work | (written when phase starts, after Phase 2 verified live) | planned | — |

Status values: `planned` → `scout-complete` → `spec-written` → `plan-approved` → `in-progress` → `shipped` (with cutover commit hash) → `closed` (after post-merge scout returns clean).

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Perf harness flakiness causes false-positive regressions, eroding trust in the gate | Trim outliers, route through `torque-remote` for canonical timings, capture env metadata, advisory-only mode when env mismatches baseline |
| Phase 1 + Phase 4 cutover conflict on `server/eslint-rules/index.js` | Documented merge protocol: second-to-cutover rebases on new main, adds rule export, conflict surface is one line |
| Discipline rules surface too many existing violations to fix in one sweep | Allowlist-shrinking migration: rule is enabled with current violations grandfathered; sub-tasks each remove one entry; closure = empty allowlist |
| Re-scout finds new pattern instances outside the phase's planned scope | Treat them as Phase N+1 input, not Phase N scope creep. Captured in scout findings and rolled into next-phase child spec. |
| Phase 2 batched-read primitive design conflicts with existing factory-health helpers | Phase 2 child spec includes a brief refactor of factory-health's `getLatestScores` API surface. Documented as a Phase 2 deliverable. |
| Restart barrier hangs because a long-running task is stuck | Existing `cleanupStaleRestartBarriers()` plus `cancel_task` on the barrier. No new mitigation needed. |
| Codex sandbox blocks `torque-remote` perf runs | Phase 0's harness designed with sandbox-tolerant fallback chain (in-process metrics first, HTTP metrics second, remote-only metrics last with explicit "remote required" marker) |
| Pre-push gate slows iteration on non-main branches | Gate only applies on pushes to main (consistent with existing test gate) |

---

## 8. Glossary

- **Hot path** — code that runs per-request, per-task, or per-completion. Not startup or one-shot maintenance.
- **Tracked metric** — a perf measurement gated in `baseline.json`. Distinct from "measured for visibility."
- **Allowlist (discipline rule)** — list of currently-grandfathered violations that the rule permits. Shrinks as the phase progresses; phase closure = empty.
- **Phase closure** — meeting all four §3.5 criteria. Must happen before cutover.
- **Cutover** — `scripts/worktree-cutover.sh` run for the phase's worktree.
- **Post-merge re-scout** — fresh scout against main *after* cutover, validating closure criterion 4.
