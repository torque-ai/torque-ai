# Fabro-Inspired Plans — Index

44 plans implementing recommendations from `docs/superpowers/research/2026-04-11-fabro-review.md` plus session-derived enhancements plus features scouted from 25 other software-factory / AI-coding / orchestration projects: OpenHands, Aider, SWE-agent, MetaGPT, ChatDev, Plandex, Cline, Goose, GPT-Engineer, TaskWeaver, Sweep, DSPy, CrewAI, LangGraph, Temporal, AutoGen, Trigger.dev, Dagster, Prefect, Continue.dev, GPT Pilot, Cadence, Restate, Argo Workflows, Mentat, Conductor, Smol-Developer.

## Plan list

### Foundation
1. **[Workflow-as-Code](2026-04-11-fabro-1-workflow-as-code.md)** — YAML workflow specs in `workflows/`
14. **[Typed Event Backbone](2026-04-11-fabro-14-typed-event-backbone.md)** — append-only event log for replay/sidecar/audit (foundation for many later plans)
27. **[Typed Workflow State](2026-04-11-fabro-27-typed-workflow-state.md)** — shared state object with reducers + `$state.path` interpolation (LangGraph)
29. **[Event-History Replay](2026-04-11-fabro-29-event-history-replay.md)** — durable per-workflow event journal + replay (Temporal)
32. **[Distributed Agent Runtime](2026-04-11-fabro-32-distributed-agent-runtime.md)** — host/worker model unifies providers/MCP/remote agents (AutoGen)
38. **[Project Domains](2026-04-11-fabro-38-project-domains.md)** — first-class tenant boundary with retention, defaults, archival (Cadence)

### Quality & trust
4. **[Goal Gates + Failure Classification](2026-04-11-fabro-4-goal-gates-and-failure-classes.md)**
11. **[Test Deflaker](2026-04-11-fabro-11-test-deflaker.md)**
21. **[Pre-Commit AI Review](2026-04-11-fabro-21-pre-commit-ai-review.md)** — reviewer flags issues before commit (Sweep)
23. **[Typed Task Signatures](2026-04-11-fabro-23-typed-task-signatures.md)** — input/output JSON Schema contracts (DSPy)
6. **[Cost Ceilings](2026-04-11-fabro-6-cost-ceilings.md)** — hybrid USD + subscription budgets
44. **[Per-Hunk Approval Gates](2026-04-11-fabro-44-per-hunk-approval.md)** — fine-grained edit review w/ feedback loop (Mentat)

### Routing & orchestration
3. **[Stylesheet Routing](2026-04-11-fabro-3-stylesheet-routing.md)** — CSS-like rules for provider/model
12. **[Conditional Edges](2026-04-11-fabro-12-conditional-edges.md)** — route on outcome / failure_class
5. **[Parallel Fan-Out + Merge](2026-04-11-fabro-5-parallel-fanout-merge.md)**
7. **[Per-Task Verify](2026-04-11-fabro-7-per-task-verify.md)**
18. **[Architect/Editor Split](2026-04-11-fabro-18-architect-editor-split.md)** — planner + editor model composition (Aider/Cline)
22. **[Sub-Workflows as Callable Tools](2026-04-11-fabro-22-subworkflows-as-tools.md)** — child workflows invokable as MCP tools (Goose)
26. **[Crew/Flow Split](2026-04-11-fabro-26-crew-flow-split.md)** — `kind: crew` autonomous subteams in deterministic workflows (CrewAI)
31. **[Activity Boundaries](2026-04-11-fabro-31-activity-boundaries.md)** — uniform retry/timeout/heartbeat for provider/MCP/verify/remote (Temporal)
33. **[Concurrency Keys](2026-04-11-fabro-33-concurrency-keys.md)** — per-tenant lanes, fairness, dedup (Trigger.dev)
36. **[Deployments + Work Pools](2026-04-11-fabro-36-deployments-work-pools.md)** — workflow def vs execution placement (Prefect)
40. **[Detached Child Workflows](2026-04-11-fabro-40-detached-child-workflows.md)** — WAIT/ABANDON/REQUEST_CANCEL/TERMINATE policies (Cadence)
43. **[Declarative System Tasks](2026-04-11-fabro-43-system-tasks.md)** — inline / jq_transform / http_call / human kinds (Conductor)

### Artifacts (NEW dimension)
34. **[Asset-Centric Artifact Model](2026-04-11-fabro-34-asset-centric-artifacts.md)** — code/test/doc as first-class assets w/ lineage + checks (Dagster)
35. **[Partition-Aware Workflows](2026-04-11-fabro-35-workflow-partitions.md)** — repo/package partitions, partial recompute, backfill (Dagster)

### Context & memory
16. **[Context Condenser](2026-04-11-fabro-16-context-condenser.md)** — auto-summarize old stages (OpenHands)
17. **[Repository Map](2026-04-11-fabro-17-repository-map.md)** — tree-sitter project map (Aider, Plandex)
25. **[Experience Memory](2026-04-11-fabro-25-experience-memory.md)** — what-worked-last-time pool (TaskWeaver)
37. **[Modular Rule Blocks](2026-04-11-fabro-37-modular-rule-blocks.md)** — `.torque/rules/` with frontmatter scoping (Continue)

### Observability & operations
2. **[Auto-Retrospectives](2026-04-11-fabro-2-auto-retrospectives.md)**
13. **[Workflow Visualization](2026-04-11-fabro-13-workflow-visualization.md)** — Mermaid graphs in dashboard
15. **[Trajectory Replay + Run Artifacts](2026-04-11-fabro-15-trajectory-replay.md)** — `runs/<id>/` bundles, replayable (SWE-agent, ChatDev)
19. **[Lifecycle Hooks](2026-04-11-fabro-19-lifecycle-hooks.md)** — TaskStart/Complete/PreToolUse hooks (Cline)
20. **[Shadow-Git Checkpoints](2026-04-11-fabro-20-shadow-git-checkpoints.md)** — per-task rollback (Cline)
24. **[Workflow Benchmarking](2026-04-11-fabro-24-workflow-benchmarking.md)** — A/B compare workflow variants (gpt-engineer)
28. **[Time-Travel + Forked Debugging](2026-04-11-fabro-28-time-travel-replay.md)** — fork a workflow from any state checkpoint (LangGraph)
30. **[Signals/Queries/Updates](2026-04-11-fabro-30-signals-queries-updates.md)** — three-contract live workflow control (Temporal)
39. **[Visibility Query Layer](2026-04-11-fabro-39-visibility-query.md)** — SQL-like search over workflows + tasks (Cadence)

### Reusability & automation
8. **[Workflow Templates](2026-04-11-fabro-8-workflow-templates.md)**
9. **[Workflow Scheduling](2026-04-11-fabro-9-workflow-scheduling.md)**
10. **[Resume / Replay](2026-04-11-fabro-10-resume-replay.md)**

### Software factory loop
41. **[Spec Capture Agent](2026-04-11-fabro-41-spec-capture-agent.md)** — conversation → structured reviewed spec (GPT Pilot)
42. **[Collaborative Debugging Loop](2026-04-11-fabro-42-collaborative-debugging.md)** — operator-in-the-loop debug sessions (GPT Pilot)

## Hard dependencies

| Plan | Requires |
|---|---|
| 8 (templates) | 1 (workflow-as-code) |
| 9 (scheduling) | 1 |
| 15 (trajectory replay) | 14 (event backbone) |
| 22 (sub-workflows) | 1 |
| 26 (crew/flow) | 5, 18, 23 |
| 27 (typed state) | 14, 23 |
| 28 (time-travel) | 10, 27, 29 |
| 29 (event-history replay) | 14, 27 |
| 30 (signals/queries) | 27, 29 |
| 31 (activities) | 14, 27, 29 |
| 32 (distributed runtime) | 14, 31 |
| 34 (assets) | 14, 27, 29 |
| 35 (partitions) | 27, 34 |
| 36 (deployments + pools) | 1, 33 |
| 38 (domains) | 33, 36 |
| 39 (visibility) | 38 |
| 40 (parent-close) | 22 |
| 41 (spec capture) | 26, 27, 30 |
| 42 (debugging loop) | 14, 27, 29, 30, 41 |
| 43 (system tasks) | 5, 26, 30 |
| 44 (per-hunk approval) | 14, 19, 20 |

## Suggested sequencing

**Batch A — Foundation (build first, others layer on)**
- Plan 1: Workflow-as-Code
- Plan 14: Typed Event Backbone
- Plan 27: Typed Workflow State
- Plan 29: Event-History Replay
- Plan 38: Project Domains (admin boundary for everything else)
- Plan 7: Per-Task Verify (low risk, big quality win)
- Plan 4: Goal Gates + Failure Classes

**Batch B — Quality + Cost guardrails**
- Plan 11: Test Deflaker
- Plan 6: Cost Ceilings
- Plan 21: Pre-Commit AI Review
- Plan 23: Typed Task Signatures
- Plan 44: Per-Hunk Approval Gates

**Batch C — Smarter routing & orchestration**
- Plan 3: Stylesheet Routing
- Plan 12: Conditional Edges
- Plan 18: Architect/Editor Split
- Plan 5: Parallel Fan-Out + Merge
- Plan 26: Crew/Flow Split
- Plan 31: Activity Boundaries
- Plan 32: Distributed Agent Runtime
- Plan 33: Concurrency Keys
- Plan 36: Deployments + Work Pools
- Plan 43: Declarative System Tasks

**Batch D — Artifacts**
- Plan 34: Asset-Centric Artifact Model
- Plan 35: Partition-Aware Workflows

**Batch E — Context discipline**
- Plan 17: Repository Map
- Plan 16: Context Condenser
- Plan 25: Experience Memory
- Plan 37: Modular Rule Blocks

**Batch F — Observability & operations**
- Plan 2: Auto-Retrospectives
- Plan 15: Trajectory Replay + Run Artifacts
- Plan 19: Lifecycle Hooks
- Plan 20: Shadow-Git Checkpoints
- Plan 13: Workflow Visualization
- Plan 24: Workflow Benchmarking
- Plan 28: Time-Travel + Forked Debugging
- Plan 30: Signals/Queries/Updates
- Plan 39: Visibility Query Layer
- Plan 40: Detached Child Workflows

**Batch G — Reusability & automation**
- Plan 8: Workflow Templates
- Plan 22: Sub-Workflows as Tools
- Plan 9: Workflow Scheduling
- Plan 10: Resume / Replay

**Batch H — Software factory loop (operator-facing)**
- Plan 41: Spec Capture Agent
- Plan 42: Collaborative Debugging Loop

## Source attributions

| Plan | Inspired by |
|---|---|
| 1-13 | Fabro + session-derived |
| 14 | OpenHands |
| 15 | SWE-agent + ChatDev |
| 16 | OpenHands |
| 17 | Aider + Plandex |
| 18 | Aider |
| 19 | Cline |
| 20 | Cline |
| 21 | Sweep |
| 22 | Goose |
| 23 | DSPy |
| 24 | gpt-engineer |
| 25 | TaskWeaver |
| 26 | CrewAI |
| 27 | LangGraph |
| 28 | LangGraph |
| 29 | Temporal |
| 30 | Temporal |
| 31 | Temporal |
| 32 | AutoGen |
| 33 | Trigger.dev |
| 34 | Dagster |
| 35 | Dagster |
| 36 | Prefect |
| 37 | Continue |
| 38 | Cadence |
| 39 | Cadence |
| 40 | Cadence |
| 41 | GPT Pilot |
| 42 | GPT Pilot |
| 43 | Conductor |
| 44 | Mentat |

## Pending (not yet planned)

These scouts were submitted but stuck in queue contention; will plan after they land:

- **Inngest** — durable functions for serverless, event-driven fan-out
- **Letta (MemGPT)** — stateful agent memory with core/recall/archival split
- **Smol-Developer** — minimal scaffold-and-iterate pattern (already landed; ideas folded into Plans 18/41/42 instead of standalone plan)

## How to execute

For each plan, choose:

**1. Subagent-Driven (recommended)** — One subagent per task, review between, fast iteration. See `superpowers:subagent-driven-development`.

**2. Inline Execution** — Batch through tasks in a single session with checkpoints. See `superpowers:executing-plans`.

The plan file is the source of truth — do not deviate without updating the plan first.
