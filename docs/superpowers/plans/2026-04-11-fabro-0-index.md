# Fabro-Inspired Plans — Index

88 plans implementing recommendations from `docs/superpowers/research/2026-04-11-fabro-review.md` plus session-derived enhancements plus features scouted from 74 other software-factory / AI-coding / orchestration projects: OpenHands, Aider, SWE-agent, MetaGPT, ChatDev, Plandex, Cline, Goose, GPT-Engineer, TaskWeaver, Sweep, DSPy, CrewAI, LangGraph, Temporal, AutoGen, Trigger.dev, Dagster, Prefect, Continue.dev, GPT Pilot, Cadence, Restate, Argo Workflows, Mentat, Conductor, Smol-Developer, Inngest, Letta (MemGPT), Devika, AutoCodeRover, Kestra, Activepieces, Camunda 8, Refact, Bolt.diy, n8n, AutoGPT, LlamaIndex, Windmill, Pydantic AI, Dify, Rivet, BAML, ControlFlow, Agno, Marvin, Haystack, CAMEL-AI, Dapr Workflows, Flyte, mem0, Pipedream, Langfuse, Portkey, Promptfoo, Outlines, TensorZero, AutoGen Studio, Firecrawl, DeepEval, E2B, smolagents, Zep, Arize Phoenix, Braintrust, Modal, Cody, Dust, Mastra, Vercel AI SDK, Claude Agent SDK, SuperAGI, LangSmith, GPT Researcher, Cloudflare Agents, Inngest AgentKit.

## Plan list

### Foundation
1. **[Workflow-as-Code](2026-04-11-fabro-1-workflow-as-code.md)** — YAML workflow specs in `workflows/`
14. **[Typed Event Backbone](2026-04-11-fabro-14-typed-event-backbone.md)** — append-only event log (OpenHands)
27. **[Typed Workflow State](2026-04-11-fabro-27-typed-workflow-state.md)** — shared state w/ reducers (LangGraph)
29. **[Event-History Replay](2026-04-11-fabro-29-event-history-replay.md)** — durable per-workflow journal (Temporal)
32. **[Distributed Agent Runtime](2026-04-11-fabro-32-distributed-agent-runtime.md)** — host/worker unification (AutoGen)
38. **[Project Domains](2026-04-11-fabro-38-project-domains.md)** — first-class tenant boundary (Cadence)
50. **[Plugin Catalog + Runtime Loading](2026-04-11-fabro-50-plugin-catalog.md)** — versioned, namespaced plugins (Kestra + Activepieces)

### Quality & trust
4. **[Goal Gates + Failure Classification](2026-04-11-fabro-4-goal-gates-and-failure-classes.md)**
11. **[Test Deflaker](2026-04-11-fabro-11-test-deflaker.md)**
21. **[Pre-Commit AI Review](2026-04-11-fabro-21-pre-commit-ai-review.md)** — (Sweep)
23. **[Typed Task Signatures](2026-04-11-fabro-23-typed-task-signatures.md)** — (DSPy)
6. **[Cost Ceilings](2026-04-11-fabro-6-cost-ceilings.md)**
44. **[Per-Hunk Approval Gates](2026-04-11-fabro-44-per-hunk-approval.md)** — (Mentat)
52. **[Connection Registry + Auth Lifecycle](2026-04-11-fabro-52-connection-registry.md)** — encrypted credentials (Activepieces)

### Routing & orchestration
3. **[Stylesheet Routing](2026-04-11-fabro-3-stylesheet-routing.md)** — CSS-like rules
12. **[Conditional Edges](2026-04-11-fabro-12-conditional-edges.md)**
5. **[Parallel Fan-Out + Merge](2026-04-11-fabro-5-parallel-fanout-merge.md)**
7. **[Per-Task Verify](2026-04-11-fabro-7-per-task-verify.md)**
18. **[Architect/Editor Split](2026-04-11-fabro-18-architect-editor-split.md)** — (Aider/Cline)
22. **[Sub-Workflows as Callable Tools](2026-04-11-fabro-22-subworkflows-as-tools.md)** — (Goose)
26. **[Crew/Flow Split](2026-04-11-fabro-26-crew-flow-split.md)** — (CrewAI)
31. **[Activity Boundaries](2026-04-11-fabro-31-activity-boundaries.md)** — (Temporal)
33. **[Concurrency Keys](2026-04-11-fabro-33-concurrency-keys.md)** — (Trigger.dev)
36. **[Deployments + Work Pools](2026-04-11-fabro-36-deployments-work-pools.md)** — (Prefect)
40. **[Detached Child Workflows](2026-04-11-fabro-40-detached-child-workflows.md)** — (Cadence)
43. **[Declarative System Tasks](2026-04-11-fabro-43-system-tasks.md)** — inline/jq/http/human (Conductor)
45. **[Unified Trigger + Admission Layer](2026-04-11-fabro-45-unified-trigger-admission.md)** — cron+event+debounce+throttle (Inngest)

### Artifacts
34. **[Asset-Centric Artifact Model](2026-04-11-fabro-34-asset-centric-artifacts.md)** — (Dagster)
35. **[Partition-Aware Workflows](2026-04-11-fabro-35-workflow-partitions.md)** — (Dagster)
55. **[Streaming Artifact Protocol](2026-04-11-fabro-55-streaming-artifacts.md)** — `<action>` stream chunks (Bolt.diy)

### Context & memory
16. **[Context Condenser](2026-04-11-fabro-16-context-condenser.md)** — (OpenHands)
17. **[Repository Map](2026-04-11-fabro-17-repository-map.md)** — (Aider, Plandex)
25. **[Experience Memory](2026-04-11-fabro-25-experience-memory.md)** — (TaskWeaver)
37. **[Modular Rule Blocks](2026-04-11-fabro-37-modular-rule-blocks.md)** — `.torque/rules/` (Continue)
47. **[Agent Memory Hierarchy](2026-04-11-fabro-47-agent-memory.md)** — core/recall/archival + sleep consolidation (Letta)

### Observability & operations
2. **[Auto-Retrospectives](2026-04-11-fabro-2-auto-retrospectives.md)**
13. **[Workflow Visualization](2026-04-11-fabro-13-workflow-visualization.md)**
15. **[Trajectory Replay + Run Artifacts](2026-04-11-fabro-15-trajectory-replay.md)** — (SWE-agent, ChatDev)
19. **[Lifecycle Hooks](2026-04-11-fabro-19-lifecycle-hooks.md)** — (Cline)
20. **[Shadow-Git Checkpoints](2026-04-11-fabro-20-shadow-git-checkpoints.md)** — (Cline)
24. **[Workflow Benchmarking](2026-04-11-fabro-24-workflow-benchmarking.md)** — (gpt-engineer)
28. **[Time-Travel + Forked Debugging](2026-04-11-fabro-28-time-travel-replay.md)** — (LangGraph)
30. **[Signals/Queries/Updates](2026-04-11-fabro-30-signals-queries-updates.md)** — (Temporal)
39. **[Visibility Query Layer](2026-04-11-fabro-39-visibility-query.md)** — SQL-like search (Cadence)
46. **[Step Trace Waterfall](2026-04-11-fabro-46-dev-server-trace.md)** — Gantt-style timeline (Inngest)
51. **[Workflow Revisions + Rollback](2026-04-11-fabro-51-workflow-revisions.md)** — (Kestra)

### Errors & recovery
42. **[Collaborative Debugging Loop](2026-04-11-fabro-42-collaborative-debugging.md)** — operator-in-the-loop (GPT Pilot)
49. **[Surgical Repair Loop](2026-04-11-fabro-49-surgical-repair-loop.md)** — symbol-search + SBFL + candidate selection (AutoCodeRover)
53. **[Scoped Error Boundary Events](2026-04-11-fabro-53-scoped-error-boundaries.md)** — business vs technical errors (Camunda)
56. **[Error Workflows](2026-04-11-fabro-56-error-workflows.md)** — configured failure handler (n8n)

### Reusability & automation
8. **[Workflow Templates](2026-04-11-fabro-8-workflow-templates.md)**
9. **[Workflow Scheduling](2026-04-11-fabro-9-workflow-scheduling.md)**
10. **[Resume / Replay](2026-04-11-fabro-10-resume-replay.md)**

### Software factory loop
41. **[Spec Capture Agent](2026-04-11-fabro-41-spec-capture-agent.md)** — (GPT Pilot)
48. **[Browser-Driven Research Stage](2026-04-11-fabro-48-research-stage.md)** — (Devika)
54. **[Project-Scoped Fine-Tune Pipeline](2026-04-11-fabro-54-fine-tune-pipeline.md)** — LoRA per project (Refact)

### External integration + authoring surfaces
57. **[Agent Protocol External API](2026-04-11-fabro-57-agent-protocol-api.md)** — vendor-neutral HTTP contract (AutoGPT)
58. **[Signature-Derived Input UIs](2026-04-11-fabro-58-signature-ui.md)** — auto form from function signature (Windmill)
59. **[Validator-Driven Retry Loop](2026-04-11-fabro-59-validator-retry.md)** — validators participate in repair (Pydantic AI)
60. **[Graphs-as-Library + Remote Debugger](2026-04-11-fabro-60-graphs-as-library.md)** — embed TORQUE runtime in any Node app (Rivet)
61. **[Prompt DSL with Schema-Aligned Parsing](2026-04-11-fabro-61-prompt-dsl-sap.md)** — .torquefn files + SAP (BAML)

### Reasoning + workflow quality (round 5)
62. **[Reasoning Toolkits](2026-04-11-fabro-62-reasoning-toolkits.md)** — think/analyze/search as MCP tools (Agno)
63. **[Persistent Threads](2026-04-11-fabro-63-persistent-threads.md)** — first-class thread + history (Marvin)
64. **[Build-Time DAG Validation](2026-04-11-fabro-64-build-time-validation.md)** — reject bad workflows at submit (Haystack)
65. **[Task Result Caching](2026-04-11-fabro-65-task-result-caching.md)** — hash-keyed dedupe + single-flight (Flyte)
66. **[Auto-Extracted Memory](2026-04-11-fabro-66-auto-extracted-memory.md)** — extract memories from conversations + rerank (mem0)
67. **[Step-Native Suspend + Rerun](2026-04-11-fabro-67-step-suspend-rerun.md)** — in-step pause w/ resume_url (Pipedream)

### Observability + evaluation + optimization (round 6)
68. **[LLM Observability Platform](2026-04-11-fabro-68-observability-platform.md)** — sessions + datasets + prompts + universal scores (Langfuse)
69. **[Semantic Cache + Guardrails Middleware](2026-04-11-fabro-69-semantic-cache-middleware.md)** — near-duplicate hits + pre/post guardrails (Portkey)
70. **[Eval Framework](2026-04-11-fabro-70-eval-framework.md)** — matrix + judges + red-team CLI (Promptfoo + DeepEval)
71. **[FSM-Guided Structured Generation](2026-04-11-fabro-71-fsm-guided-generation.md)** — pre-hoc constraint complements SAP (Outlines)
72. **[Functions + Variants + Optimization Loop](2026-04-11-fabro-72-functions-variants.md)** — stable task ID w/ competing variants + auto-propose (TensorZero)
73. **[Schema-Backed Visual Builder](2026-04-11-fabro-73-schema-backed-builder.md)** — dual-mode canvas + JSON + gallery (AutoGen Studio)
74. **[Firecrawl Research Integration](2026-04-11-fabro-74-firecrawl-research.md)** — LLM-ready markdown + schema extraction + crawl (Firecrawl)

### Sandbox + memory + context (round 7)
75. **[Sandbox Substrate](2026-04-11-fabro-75-sandbox-substrate.md)** — pluggable isolated environments w/ filesystem/terminal (E2B + Modal)
76. **[CodeAgent — Code-as-Action](2026-04-11-fabro-76-code-agent.md)** — agent action language is executable code in sandbox (smolagents)
77. **[Temporal Knowledge Graph Memory](2026-04-11-fabro-77-temporal-graph-memory.md)** — time-aware facts + contradiction-aware invalidation (Zep)
78. **[OpenTelemetry-Native Observability](2026-04-11-fabro-78-otel-observability.md)** — OpenInference semantic conventions + auto-instrumentation (Arize Phoenix)
79. **[Experiment SDK + Portable Scorers](2026-04-11-fabro-79-eval-sdk.md)** — runExperiment() + offline/online scorers + diff view (Braintrust)
80. **[Code Graph + @-Mention Context](2026-04-11-fabro-80-code-graph-context.md)** — multi-repo indexes + unified mention resolver (Cody)
81. **[Workspaces + Synced Data Sources](2026-04-11-fabro-81-workspaces-data-sources.md)** — team spaces + periodic source sync (Dust)

### Authoring + runtime refinement (round 8)
82. **[Fluent Workflow DSL](2026-04-11-fabro-82-fluent-workflow-dsl.md)** — `.step().then().parallel().branch()` TS-first builder (Mastra)
83. **[Unified Streaming Kernel](2026-04-11-fabro-83-streaming-kernel.md)** — single stream-run primitive for text/tools/steps (Vercel AI SDK)
84. **[Claude Code SDK Provider + Layered Permissions](2026-04-11-fabro-84-claude-code-sdk-provider.md)** — subagent + session + hook chain (Claude Agent SDK)
85. **[Run-Scoped Artifact Isolation](2026-04-11-fabro-85-run-scoped-artifacts.md)** — per-run dirs + index + promote (SuperAGI)
86. **[Annotation Queues](2026-04-11-fabro-86-annotation-queues.md)** — rubric-driven human review w/ reservations (LangSmith)
87. **[Report Types + Citation Ledger](2026-04-11-fabro-87-report-types-citation-ledger.md)** — typed research outputs + dedup'd source ledger (GPT Researcher)
88. **[First-Class Router for Crew Networks](2026-04-11-fabro-88-crew-router.md)** — code/llm/hybrid router for Plan 26 crews (AgentKit)

## Source attributions

| Plan | Inspired by |
|---|---|
| 1-13 | Fabro + session-derived |
| 14 | OpenHands |
| 15 | SWE-agent + ChatDev |
| 16 | OpenHands |
| 17 | Aider + Plandex |
| 18 | Aider |
| 19, 20 | Cline |
| 21 | Sweep |
| 22 | Goose |
| 23 | DSPy |
| 24 | gpt-engineer |
| 25 | TaskWeaver |
| 26 | CrewAI |
| 27, 28 | LangGraph |
| 29, 30, 31 | Temporal |
| 32 | AutoGen |
| 33 | Trigger.dev |
| 34, 35 | Dagster |
| 36 | Prefect |
| 37 | Continue |
| 38, 39, 40 | Cadence |
| 41, 42 | GPT Pilot |
| 43 | Conductor |
| 44 | Mentat |
| 45, 46 | Inngest |
| 47 | Letta (MemGPT) |
| 48 | Devika |
| 49 | AutoCodeRover |
| 50, 51 | Kestra |
| 52 | Activepieces |
| 53 | Camunda 8 |
| 54 | Refact |
| 55 | Bolt.diy |
| 56 | n8n |
| 57 | AutoGPT |
| 58 | Windmill |
| 59 | Pydantic AI |
| 60 | Rivet |
| 61 | BAML |
| 62 | Agno |
| 63 | Marvin |
| 64 | Haystack |
| 65 | Flyte |
| 66 | mem0 |
| 67 | Pipedream |
| 68 | Langfuse |
| 69 | Portkey |
| 70 | Promptfoo + DeepEval |
| 71 | Outlines |
| 72 | TensorZero |
| 73 | AutoGen Studio |
| 74 | Firecrawl |
| 75 | E2B + Modal |
| 76 | smolagents |
| 77 | Zep |
| 78 | Arize Phoenix |
| 79 | Braintrust |
| 80 | Cody |
| 81 | Dust |
| 82 | Mastra |
| 83 | Vercel AI SDK |
| 84 | Claude Agent SDK |
| 85 | SuperAGI |
| 86 | LangSmith |
| 87 | GPT Researcher |
| 88 | Inngest AgentKit |

## Suggested sequencing

**Batch A — Foundation** (1, 14, 27, 29, 38, 50, 7, 4)
**Batch B — Quality + cost guardrails** (11, 6, 21, 23, 44, 52)
**Batch C — Routing + orchestration** (3, 12, 18, 5, 26, 31, 32, 33, 36, 43, 45)
**Batch D — Artifacts** (34, 35, 55)
**Batch E — Context + memory** (17, 16, 25, 37, 47)
**Batch F — Observability + operations** (2, 15, 19, 20, 13, 24, 28, 30, 39, 46, 51)
**Batch G — Errors + recovery** (42, 49, 53, 56)
**Batch H — Reusability + automation** (8, 22, 9, 10, 40)
**Batch I — Software factory loop** (41, 48, 54)
**Batch J — External integration + authoring** (57, 58, 59, 60, 61)
**Batch K — Reasoning + workflow quality** (62, 63, 64, 65, 66, 67)
**Batch L — Observability + evaluation + optimization** (68, 69, 70, 71, 72, 73, 74)
**Batch M — Sandbox + memory + context** (75, 76, 77, 78, 79, 80, 81)
**Batch N — Authoring + runtime refinement** (82, 83, 84, 85, 86, 87, 88)

## How to execute

For each plan, choose:

**1. Subagent-Driven (recommended)** — One subagent per task, review between, fast iteration. See `superpowers:subagent-driven-development`.

**2. Inline Execution** — Batch through tasks in a single session with checkpoints. See `superpowers:executing-plans`.

The plan file is the source of truth — do not deviate without updating the plan first.
