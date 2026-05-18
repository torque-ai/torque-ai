# Factory Improvement Backlog - 100 Candidates

Generated: 2026-05-18

## Scope

This is a discovery backlog for the TORQUE factory. It lists 100 concrete improvement candidates, ranging from small hygiene fixes to larger control-plane changes. No factory tasks were submitted while producing this document.

## Evidence Snapshot

- Live factory projects were all `paused` / `IDLE`; active task count was `0`.
- Live factory work items still included `302` non-terminal rows: `295 needs_replan`, `4 prioritized`, `2 needs_review`, and `1 planned`.
- Project distribution of non-terminal rows: `SpudgetBooks 150`, `StateTrace 84`, `DLPhone 64`, `NetSim 3`, `bitsy 1`, `torque-public 0`.
- Provider configuration was Codex-primary after migration `61`: `default_provider=codex`, `smart_routing_default_provider=codex`, `active_routing_template=preset-codex-primary`; Claude and Ollama providers were disabled.
- DI metrics reported `54` container registrations, `30` wired-at-boot services, and `38` imperative-init modules, with `0` direct or fallback database importers.
- Current largest non-test server files included `server/factory/loop-controller.js` at `7392` lines, `server/providers/execution.js` at `4529`, `server/factory/plan-execute.js` at `4079`, `server/db/schema/tables.js` at `3897`, and `server/handlers/factory-handlers.js` at `3227`.
- Marker scan found `183` TODO, `57` FIXME, `41` HACK, `30` XXX, `126` follow-up, and `317` future markers across `server`, `docs`, and `dashboard`.
- Test scan found `41` skipped or todo test markers across `server/tests`, `dashboard/src`, and `dashboard/e2e`.
- Worktree state showed `33` git worktrees, plus DB rows including `85` active `factory_worktrees`, `35` preserved factory worktrees, and `601` active `vc_worktrees`.
- Last 7 days of factory decisions were dominated by high-volume housekeeping and replan signals, including `auto_recovery_skipped_benign 3473`, `swept_orphan_worktree_dirs 2154`, `stage_complete 1522`, `selected_work_item 857`, `plan_quality_routed_to_needs_replan_after_intrabatch_retries 277`, and `cannot_generate_plan_routed_to_needs_replan 160`.
- `factory_attempt_history` had `1591` rows, including `829` `unknown` zero-diff reasons and `54` `already_in_place` heuristic classifications.

## Backlog

| ID | Area | Size | Improvement | Evidence |
|---|---|---:|---|---|
| F001 | Work-item backlog | S | Add a daily `needs_replan` summary grouped by project and reject reason. | Live DB has `295 needs_replan` rows. |
| F002 | Work-item backlog | S | Add an age SLA for `needs_replan` rows so old items stop blending into fresh failures. | `needs_replan` dominates all non-terminal rows. |
| F003 | Work-item backlog | M | Build a "replan queue" dashboard view with filters for project, age, source, and last failure shape. | Non-terminal rows are spread across five projects. |
| F004 | Work-item backlog | M | Add a batch action to convert safe `needs_replan` rows back to `pending` after their blocker clears. | Current backlog has many parked rows but no active tasks. |
| F005 | Work-item backlog | M | Store structured replan failure buckets separate from free-form `reject_reason`. | Decision log shows repeated plan-quality and cannot-generate routes. |
| F006 | Work-item backlog | L | Add a bounded replan scheduler that drains only N items per project per cycle. | `SpudgetBooks` alone has `150` non-terminal rows. |
| F007 | Work-item backlog | S | Add a `needs_review` inbox count to factory status and dashboard header. | Live DB has `2 needs_review` rows. |
| F008 | Work-item backlog | S | Surface `planned` and `prioritized` rows separately from `needs_replan` in summaries. | Live DB has `1 planned` and `4 prioritized` rows. |
| F009 | Work-item backlog | M | Add a status taxonomy doc that explains which statuses are executable, deferred, terminal, or operator-owned. | Current statuses include `needs_replan`, `needs_review`, `unactionable`, and `escalation_exhausted`. |
| F010 | Work-item backlog | M | Replace broad `unactionable` use with a distinct `deferred_out_of_scope` status for valid-but-not-current work. | Live DB has `144 unactionable` rows, including prior manually scoped items. |
| F011 | Plan generation | S | Create a report for top plan-quality gate rejection causes. | `plan_quality_routed_to_needs_replan_after_intrabatch_retries` occurred `277` times in 7 days. |
| F012 | Plan generation | M | Detect same-shape plan regeneration loops before spending another architect attempt. | Repeated replan decision actions show recurring shapes. |
| F013 | Plan generation | M | Store plan-quality feedback as structured fields, not only prompt text. | Gate feedback currently feeds later prompts but is hard to aggregate. |
| F014 | Plan generation | S | Add a command to preview whether a work item has enough specificity before PLAN runs. | Existing plan-quality rules are only visible after a generated plan fails. |
| F015 | Plan generation | M | Add a "minimal viable plan" fallback for small single-file work when architect planning fails repeatedly. | `cannot_generate_plan_routed_to_needs_replan` occurred `160` times in 7 days. |
| F016 | Plan generation | M | Record plan source provenance in one normalized field across scout, plan file, architect, and manual sources. | Factory intake currently mixes multiple source paths and statuses. |
| F017 | Plan generation | M | Add a stale-plan scanner for plan files whose target files changed heavily after intake. | Docs describe stale probes for scout items, but plan-file drift remains a recurring risk. |
| F018 | Plan generation | S | Add a plan-intake duplicate audit that reports active duplicates by `plan_path`. | Docs describe dedup behavior; an audit would verify it at rest. |
| F019 | Plan generation | M | Create a replan feedback diff that shows what changed between plan attempts. | Existing attempt history focuses on execution outputs, not plan deltas. |
| F020 | Plan generation | L | Split architect planning into classify, draft, lint, and repair phases with separate budgets. | `server/factory/plan-generation-cluster.js` is `2573` lines. |
| F021 | Provider routing | S | Add a provider-template validator that rejects disabled providers in active chains unless explicitly allowed. | Active config is Codex-primary, but templates can still contain disabled providers. |
| F022 | Provider routing | S | Add a startup warning if `strategic_provider` points at a disabled or unavailable provider. | Migration `61` had to normalize `strategic_provider` away from local Ollama. |
| F023 | Provider routing | M | Add an endpoint that explains the chosen provider and every skipped fallback candidate. | Provider config has many disabled providers but routing decisions are still opaque. |
| F024 | Provider routing | M | Add a TTL to emergency routing templates so temporary Codex-down presets expire automatically. | `active_routing_template` was corrected back to `preset-codex-primary`. |
| F025 | Provider routing | S | Add a one-click provider drift check to compare DB config, routing template, and live provider status. | Recent fix corrected seed and migration drift. |
| F026 | Provider routing | M | Update retry-rule seed targets that still point at disabled `claude-cli`. | `server/db/schema/seeds.js` has retry rules targeting `claude-cli`. |
| F027 | Provider routing | M | Add tests proving disabled providers cannot be selected through fallback retry rules. | Provider list shows Claude disabled but retry seed data can still reference it. |
| F028 | Provider routing | S | Expose Codex quota reset/probe state directly in provider status. | User expects Codex to resume as soon as limits reset. |
| F029 | Provider routing | M | Store per-task "provider override was user-requested" flags to prevent unwanted fallback. | `tda-01-provider-sovereignty.test.js` contains provider-sovereignty todo tests. |
| F030 | Provider routing | L | Make routing templates capability-aware so disabled local providers are not used as generic last resorts. | Active templates and provider config are separate tables. |
| F031 | Execution | L | Continue decomposing `server/execution/task-startup.js` into claim, policy, command, and launch modules. | File is `2730` lines. |
| F032 | Execution | L | Split `server/providers/execution.js` into adapter selection, routing-chain execution, proposal application, and provider-specific transports. | File is `4529` lines. |
| F033 | Execution | M | Add a guard that blocks automatic placeholder file creation unless the plan explicitly requested a new file. | `server/execution/file-context-builder.js` can create placeholder stubs. |
| F034 | Execution | M | Record every auto-created target file in task metadata so verification can distinguish intentional files from scaffolding. | File-context builder creates stubs but downstream provenance is thin. |
| F035 | Execution | M | Add a no-write retry policy that distinguishes read-only investigation from failed modification. | Prior memory and guards show no-op agentic completions were a real failure mode. |
| F036 | Execution | M | Add a task-output quality histogram by provider and task type. | Provider routing has performance tables but factory outcomes need clearer aggregation. |
| F037 | Execution | L | Convert subprocess lifecycle edge cases into typed completion reasons instead of string parsing. | `server/providers/execute-cli.js` is `2446` lines. |
| F038 | Execution | M | Add an execution "why not started" explainer for queued or parked tasks. | Active queue is `0`, but many work items are parked in factory-specific statuses. |
| F039 | Execution | M | Add per-provider command preview redaction tests for every provider class. | Provider execution spans CLI, API, and local adapters. |
| F040 | Execution | S | Add a dashboard count for tasks skipped by startup reconciler instead of logging one row per task. | Recent logs had many `Startup task reconciler skipped already-resubmitted task` lines. |
| F041 | Verification | M | Make factory verify-stall threshold configurable instead of hardcoded. | `docs/factory.md` documents a hardcoded `45 * 60 * 1000` threshold. |
| F042 | Verification | M | Add a shared state marker so execution-layer stall recovery and factory verify-stall recovery can see each other's actions. | Docs say the two stall layers can fire independently. |
| F043 | Verification | S | Add a status page that identifies which stall layer owns the current stall. | Docs warn not to add a third stall layer and to identify the owner first. |
| F044 | Verification | M | Add config-backed retry budgets for dependency resolver cascades. | Factory docs mention a cascade limit of 3 dep resolutions. |
| F045 | Verification | M | Persist verify error fingerprints so repeated same-failure retries can be capped earlier. | Verify prompt already includes error progression, but DB aggregation is limited. |
| F046 | Verification | S | Add a targeted test for non-plan-file scout execution. | `server/tests/factory-execute-non-plan-file.test.js` has a skipped core scenario. |
| F047 | Verification | M | Add a report for `unknown` zero-diff attempt classifications by project and provider. | `factory_attempt_history` has `829` `unknown` zero-diff rows. |
| F048 | Verification | M | Treat high-confidence `already_in_place` as a first-class auto-ship candidate with operator audit. | `factory_attempt_history` has `54` `already_in_place` heuristic rows. |
| F049 | Verification | M | Add precondition-missing recovery suggestions that route to environment or dependency setup instead of generic replan. | Attempt history includes `precondition_missing` rows. |
| F050 | Verification | L | Add a verify ledger view connecting work item, plan task, task id, provider, failure fingerprint, and final disposition. | `docs/recovery-decisions.md` mentions `verification_ledger` as future routing evidence. |
| F051 | Recovery | S | Compact repeated `auto_recovery_skipped_benign` decisions into sampled or rolled-up events. | 7-day decision count is `3473`. |
| F052 | Recovery | S | Compact repeated `swept_orphan_worktree_dirs` decisions into per-run summary rows. | 7-day decision count is `2154`. |
| F053 | Recovery | M | Add a recovery health score that flags projects with repeated benign skips but no shipped work. | Benign recovery noise can hide lack of useful progress. |
| F054 | Recovery | M | Add tests that every documented decision action has one producer and one consumer expectation. | `docs/factory.md` documents many named decision actions. |
| F055 | Recovery | M | Add a recovery-strategy conflict audit to CI. | `docs/recovery-decisions.md` describes multi-path strategy conflicts. |
| F056 | Recovery | M | Add an operator-facing "why paused" synthesis from recent decisions, active work item, and provider state. | Factory docs say decisions are the first place to debug stuck loops. |
| F057 | Recovery | S | Add a repair suggestion when `baseline_blocked_work_item_requeued` fires. | Docs identify this as a special baseline/environment recovery path. |
| F058 | Recovery | M | Store terminal escalation evidence in a normalized table for later analytics. | Terminal statuses include `escalation_exhausted 126`. |
| F059 | Recovery | M | Add automatic stale-row age checks for `escalation_exhausted` items. | Live DB has `126 escalation_exhausted` rows. |
| F060 | Recovery | L | Build a recovery simulator that replays decision logs without mutating tasks. | Recovery rules are complex and currently validated mostly through tests and live state. |
| F061 | Worktrees | S | Add a worktree hygiene dashboard card showing git worktrees, factory worktree rows, and vc worktree rows. | Current scan found `33` git worktrees. |
| F062 | Worktrees | M | Add an age-based alert for `factory_worktrees.status='active'` rows whose owning task is no longer active. | DB has `85` active factory worktree rows while active task count is `0`. |
| F063 | Worktrees | M | Add a cleanup plan for `vc_worktrees.status='active'` rows that are not mapped to live work. | DB has `601` active vc worktree rows. |
| F064 | Worktrees | S | Add a preserved-worktree inventory with reason, age, branch, and linked task. | DB has `35` preserved factory worktree rows. |
| F065 | Worktrees | M | Add a worktree cleanup dry-run command that is safe to run while factory projects are paused. | Worktree state has many rows and directories. |
| F066 | Worktrees | M | Report orphaned temp worktrees under `server/.tmp/worktrees` separately from feature worktrees. | Git worktree list includes server temp worktrees. |
| F067 | Worktrees | S | Include worktree count deltas in cutover summaries. | Cutover already scans and skips many factory-owned worktrees. |
| F068 | Worktrees | M | Add a branch collision preflight that explains whether a stale branch, DB row, or directory owns the name. | Factory docs describe stale branch force-delete and stale DB row reclaim. |
| F069 | Worktrees | M | Add tests for preserved invalid worktree reuse paths. | Prior cutovers have preserved invalid factory worktrees. |
| F070 | Worktrees | L | Move worktree reconcile output from logs into a queryable hygiene table. | Worktree cleanup currently logs sweeps at high frequency. |
| F071 | Dashboard/API | S | Stop polling active loop endpoints every 5 seconds when all projects are paused and IDLE. | Recent logs show repeated paused loop polling. |
| F072 | Dashboard/API | S | Lower decision polling frequency for paused projects or require panel focus. | Recent `/decisions?limit=30` calls recur for paused projects. |
| F073 | Dashboard/API | M | Add ETag or last-decision cursor support to decision endpoints. | Decision endpoint responses take around 160 to 206 ms in recent logs. |
| F074 | Dashboard/API | M | Cache paused-project summary responses separately from running-project summaries. | Recent `/api/v2/factory/projects?status=paused&summary=basic` calls are frequent. |
| F075 | Dashboard/API | S | Show active task count and active work item count side by side. | Active tasks are `0`, but non-terminal work items are `302`. |
| F076 | Dashboard/API | M | Add a "work is paused but backlog remains" dashboard state. | All projects are paused/IDLE while backlog remains. |
| F077 | Dashboard/API | M | Add provider drift warnings to the provider settings page. | Recent migration had to restore Codex-primary defaults. |
| F078 | Dashboard/API | S | Surface `state_consistency.ok=false` as a prominent dashboard banner. | `docs/factory.md` documents state consistency fields. |
| F079 | Dashboard/API | M | Add a factory endpoint that returns grouped work-item counts without dashboard-side aggregation. | Current analysis needed direct SQL. |
| F080 | Dashboard/API | L | Add a factory operations landing view optimized for repeated action, not just status display. | Factory control spans projects, decisions, tasks, providers, and worktrees. |
| F081 | Architecture | L | Continue reducing `server/factory/loop-controller.js` by extracting one stage policy at a time. | File is `7392` lines. |
| F082 | Architecture | L | Split `server/factory/plan-execute.js` into plan materialization, task submission, await handling, and failure classification. | File is `4079` lines. |
| F083 | Architecture | L | Split `server/handlers/factory-handlers.js` by read APIs, lifecycle mutations, recovery actions, and admin tools. | File is `3227` lines. |
| F084 | Architecture | L | Split `server/db/schema/tables.js` into bounded schema modules with ownership comments. | File is `3897` lines. |
| F085 | Architecture | L | Move more imperative-init modules into container registration. | DI metrics show `38` imperative-init modules. |
| F086 | Architecture | M | Add a monotonic DI migration scoreboard that fails when imperative-init count rises without an allowlist note. | DI metrics are available but not a ratchet for imperative init. |
| F087 | Architecture | M | Add module ownership docs for the largest 30 server files. | Largest-file scan shows many modules above `1500` lines. |
| F088 | Architecture | M | Add a "factory boundary" lint rule for direct imports from stage internals. | The architecture review treated boundary regressions as a recurring risk. |
| F089 | Architecture | S | Add a daily line-count trend for key factory files. | `loop-controller.js` grew after the prior decomposition slice. |
| F090 | Architecture | L | Convert `server/db/workflow-engine.js` away from module-global DB state. | Historical critic memory flagged module-global DB dependency. |
| F091 | Tests | S | Create a skipped-test inventory doc grouped by intentional environment skips vs real debt. | Test scan found `41` skipped or todo markers. |
| F092 | Tests | S | Unskip or delete stale governance hook skip tests after revalidating current behavior. | `server/tests/governance-hooks.test.js` has multiple `it.skip` cases. |
| F093 | Tests | M | Convert `task-manager.test.js` todo exports into direct tests through public helper modules or remove stale todos. | `task-manager.test.js` has four todo tests. |
| F094 | Tests | M | Turn provider-sovereignty todo tests into executable regression tests. | `tda-01-provider-sovereignty.test.js` has three provider fallback todo cases. |
| F095 | Tests | M | Add a gate that blocks adding unconditional `it.skip` without an issue or expiration. | Several skip markers are unconditional. |
| F096 | Tests | M | Add integration smoke docs for env-gated REST suites so skipped integration tests are intentional. | Multiple REST integration suites use `describe.skip` when env is absent. |
| F097 | Tests | S | Re-enable or replace the close-phases quality-revert skipped test. | `server/tests/close-phases.test.js` has an unconditional skip. |
| F098 | Tests | S | Re-enable or replace resource-health prepare-cache skipped tests. | `server/tests/resource-health.test.js` has two unconditional skips. |
| F099 | Tests | M | Add a test that validates provider seed defaults keep Claude and Ollama disabled unless explicitly enabled. | Recent provider-default fix touched seeds and migration. |
| F100 | Process | L | Build a controlled intake path that converts approved improvement backlog rows into factory work items only after operator approval. | This document intentionally finds improvements without submitting factory tasks. |

## Suggested First Slice

The lowest-risk first slice is reporting and classification work: summarize replan causes, add age visibility, build a replan queue view, report unknown zero-diff attempts, and inventory skipped tests. These reduce operator ambiguity without changing execution behavior.
