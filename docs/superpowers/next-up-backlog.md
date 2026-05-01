# Next-Up Backlog

Curated short list of the next feature plans worth picking up. Each entry summarizes the goal, why it fits TORQUE, and links to the canonical plan in `plans/`. Pulled from the 2026-05-01 spirit-of-TORQUE plan audit (see `plan-scope-decisions.md` for the full triage rationale).

These five are the highest-leverage near-term items: small surface, complement features already in production, directly address operator pain points called out in `CLAUDE.md` and memory feedback. Treat this as "what to queue next" rather than "what to do today" — none are urgent.

---

## 1. Per-Task Verify Customization

**Plan:** [`plans/2026-04-11-fabro-7-per-task-verify.md`](plans/2026-04-11-fabro-7-per-task-verify.md)

Let each task declare its own `verify_command` (and `verify_skip: true` to opt out). A docs task runs only markdown linting; a database task runs migration tests; a frontend task runs `vitest run dashboard/`. Cuts verify time, reduces false `tests:fail` noise, makes per-task verify signals meaningful.

**Why it fits.** TORQUE already has project-level verify wired into the close-handler pipeline. This scales it to mixed-language, mixed-target workflows (docs vs frontend vs server in one batch) without rewriting the stage.

**Surface:** small. Adds a metadata field; preference order in `auto-verify-retry`.

---

## 2. Test Deflaker

**Plan:** [`plans/2026-04-11-fabro-11-test-deflaker.md`](plans/2026-04-11-fabro-11-test-deflaker.md)

Track per-test pass/fail history. A test that flips state without code change is flaky. When a verify failure is composed entirely of known-flaky tests, tag the signal `tests:flaky:N` instead of `tests:fail:N` so downstream routing/recovery doesn't chase ghost regressions.

**Why it fits.** Directly addresses the operator-mandated `feedback_test_infra_degraded_defer_verification` memory rule: the factory burns Codex budget chasing flake-driven failures. High ROI for the cost.

**Surface:** new `test_outcomes` table + classifier + parser hook in auto-verify.

---

## 3. Workflow Mermaid Visualization

**Plan:** [`plans/2026-04-11-fabro-13-workflow-visualization.md`](plans/2026-04-11-fabro-13-workflow-visualization.md)

Render workflow specs and live workflows as Mermaid diagrams in the dashboard. See the DAG instead of parsing YAML mentally. Status colors light up live; conditional edges, merge nodes, goal-gated nodes get distinct shapes/badges.

**Why it fits.** Operator console (`Factory.jsx`) needs structural visibility, not text-only DAGs. Pairs with the existing factory dashboards and complements goal-gates / parallel-fanout if those land.

**Surface:** one render module + REST endpoint + dashboard panel using the `mermaid` JS library's `run()` API.

---

## 4. Per-Hunk Approval

**Plan:** [`plans/2026-04-11-fabro-44-per-hunk-approval.md`](plans/2026-04-11-fabro-44-per-hunk-approval.md)

When a Codex/agent task produces a multi-file diff and the workflow is configured for human review, present per-file and per-hunk Accept/Reject controls. Accepted subset commits; rejected hunks become feedback for the agent's next pass.

**Why it fits.** TORQUE already has reviewer agents and trust-level gates. Per-hunk is the missing surface for "trust this diff partially" — biggest UX upgrade for human-in-the-loop factory mode.

**Surface:** `pending_diffs` table + diff renderer + verdict pipeline.

---

## 5. Surgical Repair Loop

**Plan:** [`plans/2026-04-11-fabro-49-surgical-repair-loop.md`](plans/2026-04-11-fabro-49-surgical-repair-loop.md)

Upgrade verify-fail recovery from "retry with more prompt context" to localize-then-fix: (1) symbol-aware code search built on already-shipped codegraph indexes, (2) spectrum-based fault localization ranking suspicious files by test coverage, (3) candidate patch selection that preserves all attempted fixes and picks the best by validator score.

**Why it fits.** Reads like a natural Phase 6.6 sitting on top of the existing auto-verify-retry stage. Codegraph is already shipped; this is the consumer that uses it for the highest-value purpose.

**Surface:** three composed subsystems; replaces the current "retry with more context" path inside Phase 6.5.

---

## Other KEEP candidates (not top 5, but on the list)

These are still in `plans/` and remain actionable. Picked up the top 5 because they have the smallest surface and most direct leverage, but the rest are valid:

- `plans/2026-04-11-fabro-2-auto-retrospectives.md` — append per-workflow retros to the database; closes the factory feedback loop.
- `plans/2026-04-11-fabro-4-goal-gates-and-failure-classes.md` — formalize reject_reason taxonomy; pairs with auto-recovery + replan-recovery.
- `plans/2026-04-11-fabro-5-parallel-fanout-merge.md` — first-class fan-out/merge task kinds for ensemble routing.
- `plans/2026-04-11-fabro-6-cost-ceilings.md` — enforceable per-workflow budget caps; pairs with budget-aware routing (#89).
- `plans/2026-04-11-fabro-25-experience-memory.md` — per-project few-shot pool of "what worked last time."
- `plans/2026-04-11-fabro-37-modular-rule-blocks.md` — `.torque/rules/*.md` with auto-injection by glob; replaces ad-hoc CLAUDE.md sprawl.
- `plans/2026-04-11-fabro-65-task-result-caching.md` — hash-keyed dedupe of `(provider+model+prompt+inputs)`.
- `plans/2026-04-11-fabro-89-budget-aware-routing.md` — per-tenant spend feeds provider selection (depends on #6).
- `plans/2026-04-11-fabro-103-classifier-first-router.md` — front-door classifier above the shipped crew-router.

## Recently rewritten — fresh plans, ready to pick up

These were flagged STALE in the 2026-05-01 audit (drafted on top of unshipped predecessors), then rewritten 2026-05-01 against current TORQUE reality. No more STALE header — implementation-ready:

- `plans/2026-03-17-workstations-phase3-4-dashboard.md` — finish workstations migration by projecting legacy `ollama_hosts`/`peek_hosts`/`remote_agents` as SQLite views over the canonical `workstations` table; reroute writes through `workstation/model.js`. Dashboard work dropped (already shipped). `internal`.
- `plans/2026-04-11-fabro-23-typed-task-signatures.md` — opt-in `signature: { inputs, output }` field on the existing workflow YAML schema, validated at admission + completion pipeline using the same Ajv plumbing the crew runner already uses for `output_schema`. No side-table. `feature`.
- `plans/2026-04-11-fabro-29-event-history-replay.md` — extension of the already-shipped `task_events` (Plan 14) + `workflow_checkpoints` (Plan 28). Add 2 missing event types, expose workflow-scoped REST + dashboard timeline. No new table. `internal`.
- `plans/2026-04-11-fabro-79-eval-sdk.md` — minimal native A/B evaluator on top of existing benchmark + provider-scoring infrastructure. New `experiments` + `experiment_runs` tables, REST + Providers panel. Explicitly excludes OTEL, Promptfoo, hosted eval. `feature`.

(`fabro-67-step-suspend-rerun` was DROPPED — its load-bearing siblings fabro-30 and fabro-43 didn't fit TORQUE; see `plans/archive/2026-04-11-fabro-67-step-suspend-rerun.md` for the rationale.)
