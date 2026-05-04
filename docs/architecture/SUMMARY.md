# torque-ai Knowledge Primer

An automated software factory for Claude Code. Discover, plan, execute, verify, remediate, and release — autonomously across local and cloud LLM providers.

Coverage: 1534/1534 tracked files indexed (100%), 0 pending.

## Key Artifacts
- `docs/architecture/knowledge-pack.json` — machine-readable subsystem map, flows, hotspots, invariants, failure modes, traces, and change playbooks.
- `docs/architecture/study-delta.json` — latest delta, significance score, changed seams, and follow-up task proposals.
- `docs/architecture/module-index.json` — per-file facts: purpose, exports, and dependencies.

## Latest Delta
- **Significance:** low (12).
- 4 repo files changed since the previous study SHA.

## Pack Evaluation
- **Readiness:** expert_ready (A, score 100).
- **Strengths:** Coverage is effectively complete at 100% with no pending files. The pack captures 5 canonical flows, which gives downstream models a usable execution map.

## Benchmark
- **Benchmark Readiness:** expert_ready (A, score 95).
- **Cases:** 10 pass, 1 partial, 0 fail.
- **Benchmark Gap (suggestion):** Benchmark probe impact:server/tests/vitest-setup.js scored 69 (partial).

## LLM Onramp
- **Profile:** TORQUE control-plane monorepo. Node-based control plane with task execution, workflow orchestration, scheduled automation, and dashboard surfaces.
- **Briefing:** Node-based control plane with task execution, workflow orchestration, scheduled automation, and dashboard surfaces. Start with the top entrypoints and canonical flows, then use invariants and playbooks to reason about changes safely.
- **Read Order:** `server/index.js`, `server/task-manager.js`, `server/tools.js`, `bin/torque.js`, `server/api/v2-dispatch.js`, and `server/handlers/task/index.js`.

## Suggested Entry Points
- `server/index.js` — Primary package runtime entrypoint.
- `server/task-manager.js` — Top-level task execution coordinator.
- `server/tools.js` — Tool catalog and dispatch surface.
- `bin/torque.js` — Primary CLI entrypoint.
- `server/api/v2-dispatch.js` — Primary control-plane dispatch surface.
- `dashboard/src/App.jsx` — Dashboard shell composition.

## Primary Flows
- **Task lifecycle:** Task requests enter through API or handlers, start in the task manager, route through execution modules, and finish in the completion pipeline. Start with `server/api/v2-dispatch.js`, `server/handlers/task/index.js`, `server/task-manager.js`, and `server/execution/task-startup.js`.
- **Workflow lifecycle:** Workflow handlers define DAG structure, the runtime unblocks nodes, and await logic surfaces progress and completion. Start with `server/handlers/workflow/index.js`, `server/handlers/workflow/dag.js`, `server/execution/workflow-runtime.js`, and `server/handlers/workflow/await.js`.
- **Scheduled automation:** Schedules are stored in DB helpers, fired by the maintenance scheduler, and translated into tasks or tool executions by the schedule runner. Start with `server/db/cron-scheduling.js`, `server/api/v2-governance-handlers.js`, `server/maintenance/scheduler.js`, and `server/execution/schedule-runner.js`.
- **Tool dispatch:** Tool definitions and schemas are registered centrally, then routed to handlers and post-tool hooks through the MCP surface. Start with `server/tools.js`, `server/core-tools.js`, `server/hooks/post-tool-hooks.js`, and `server/mcp/index.js`.
- **Provider routing and retry:** Provider scoring, routing, and fallback logic combine health, capabilities, and retries to decide where work runs. Start with `server/db/provider-scoring.js`, `server/db/provider-health-history.js`, `server/db/provider-capabilities.js`, and `server/execution/provider-router.js`.

## Major Subsystems
- **Control-plane API:** HTTP and transport surfaces that expose TORQUE task, provider, workflow, and governance operations. Coverage: 25/25 indexed. Representative files: `server/index.js`, `server/api/v2-governance-handlers.js`, and `server/api-server.js`. Key exports: `init` (8), `_testing` (2), and `buildV2Middleware` (2). Key dependencies: `server/api/middleware.js` (16) and `server/logger.js` (12).
- **Task execution pipeline:** Task startup, provider routing, process lifecycle, retries, verification, and completion handling. Coverage: 32/32 indexed. Representative files: `server/task-manager.js`, `server/execution/queue-scheduler.js`, and `server/execution/task-finalizer.js`. Key exports: `init` (14), `_testing` (2), and `getEffectiveGlobalMaxConcurrent` (2). Key dependencies: `server/logger.js` (21) and `child_process` (8).
- **Workflow orchestration:** DAG workflow creation, await logic, diffusion planning, and workflow runtime coordination. Coverage: 12/12 indexed. Representative files: `server/execution/workflow-runtime.js`, `server/handlers/workflow/index.js`, and `server/handlers/workflow/await.js`. Key exports: `handleCreateFeatureWorkflow` (2), `init` (2), and `applyContextFrom` (1). Key dependencies: `server/logger.js` (8) and `server/db/workflow-engine.js` (6).
- **Persistence and scheduling:** SQLite-backed state, queues, schedules, provider stats, and workflow/task metadata. Coverage: 68/68 indexed. Representative files: `server/db/task-core.js`, `server/db/provider-routing-core.js`, and `server/db/config-core.js`. Key exports: `setDb` (48), `setGetTask` (17), and `init` (5). Key dependencies: `server/utils/json.js` (27) and `server/logger.js` (20).
- **Provider adapters:** Provider registry, CLI/API adapters, prompts, and provider-specific execution logic. Coverage: 32/32 indexed. Representative files: `server/providers/execution.js`, `server/providers/adapter-registry.js`, and `server/providers/execute-api.js`. Key exports: `init` (10), `chatCompletion` (3), and `buildClaudeCliCommand` (2). Key dependencies: `server/logger.js` (19) and `server/constants.js` (16).
- **Tool and MCP surface:** Tool catalog, schemas, dispatch, protocol transport, and MCP-facing integration points. Coverage: 128/128 indexed. Representative files: `server/tools.js`, `server/mcp-sse.js`, and `server/mcp/index.js`. Key exports: `additionalProperties` (69), `properties` (69), and `type` (69). Key dependencies: `crypto` (6) and `server/logger.js` (6).

## Critical Invariants
- **Task lifecycle:** Submission surfaces should delegate into handlers and the task manager instead of invoking providers directly. Read `server/api/v2-dispatch.js`, `server/handlers/task/index.js`, `server/task-manager.js`, and `server/execution/task-startup.js`.
- **Task lifecycle:** Task completion should converge through the finalizer and completion pipeline so verification and follow-up hooks stay centralized. Read `server/api/v2-dispatch.js`, `server/handlers/task/index.js`, `server/task-manager.js`, and `server/execution/task-startup.js`.
- **Workflow lifecycle:** Workflow structure, runtime unblocking, and await reporting should stay aligned on the same DAG semantics. Read `server/handlers/workflow/index.js`, `server/handlers/workflow/dag.js`, `server/execution/workflow-runtime.js`, and `server/handlers/workflow/await.js`.
- **Workflow lifecycle:** Dependent nodes should unblock only from persisted workflow state, not from ad hoc in-memory assumptions. Read `server/handlers/workflow/index.js`, `server/handlers/workflow/dag.js`, `server/execution/workflow-runtime.js`, and `server/handlers/workflow/await.js`.
- **Scheduled automation:** Schedules should create tracked task or tool executions; background automation should not fire invisibly. Read `server/db/cron-scheduling.js`, `server/api/v2-governance-handlers.js`, `server/maintenance/scheduler.js`, and `server/execution/schedule-runner.js`.

## Common Failure Modes
- **Bypassed finalization:** Tasks appear done but verification, ledger updates, or downstream hooks are missing. Investigate `server/execution/task-finalizer.js` and `server/execution/completion-pipeline.js` first.
- **Split execution ownership:** API or handler code starts doing provider work directly, creating duplicated retry and state transitions. Investigate `server/api/v2-dispatch.js`, `server/handlers/task/index.js`, and `server/task-manager.js` first.
- **DAG/runtime drift:** Nodes exist in definitions but never unblock, or await surfaces show states that do not match runtime behavior. Investigate `server/handlers/workflow/dag.js`, `server/execution/workflow-runtime.js`, and `server/handlers/workflow/await.js` first.
- **Silent schedule dispatch:** The scheduler fires but no task row, tool result, or completion record is created. Investigate `server/maintenance/scheduler.js`, `server/execution/schedule-runner.js`, and `server/db/cron-scheduling.js` first.
- **Run Now path divergence:** Manual schedule execution behaves differently from cron, skips work, or bypasses persistence helpers. Investigate `server/api/v2-governance-handlers.js`, `server/execution/schedule-runner.js`, and `server/db/cron-scheduling.js` first.

## Change Playbooks
- **Editing Control-plane API:** HTTP and transport surfaces that expose TORQUE task, provider, workflow, and governance operations. Start with `server/index.js`.
- **Editing Task execution pipeline:** Task startup, provider routing, process lifecycle, retries, verification, and completion handling. Start with `server/task-manager.js`.
- **Editing Workflow orchestration:** DAG workflow creation, await logic, diffusion planning, and workflow runtime coordination. Start with `server/handlers/workflow/index.js`.
- **Editing Persistence and scheduling:** SQLite-backed state, queues, schedules, provider stats, and workflow/task metadata. Start with `server/db/task-core.js`, `server/db/provider-routing-core.js`, and `server/db/config-core.js`.
- **Editing Provider adapters:** Provider registry, CLI/API adapters, prompts, and provider-specific execution logic. Start with `server/providers/execution.js`, `server/providers/adapter-registry.js`, and `server/providers/execute-api.js`.

## Change Impact Guidance
- **Control-plane API:** Recheck `server/index.js`, `server/api/v2-governance-handlers.js`, `server/api-server.js`, and `server/api/middleware.js`. Validate with `npx vitest run server/tests/api-server-core.test.js server/tests/v2-governance-handlers.test.js server/tests/claude-event-hooks.test.js server/tests/api-middleware.test.js` and `npm run lint`.
- **Task execution pipeline:** Recheck `server/task-manager.js`, `server/execution/queue-scheduler.js`, `server/execution/task-finalizer.js`, and `server/execution/fallback-retry.js`. Validate with `npx vitest run server/tests/bug-001-override-provider.test.js server/tests/fallback-retry.test.js server/tests/host-distribution.test.js server/tests/process-lifecycle.test.js` and `npm run lint`.
- **Workflow orchestration:** Recheck `server/handlers/workflow/index.js`, `server/execution/workflow-runtime.js`, `server/handlers/workflow/await.js`, and `server/handlers/workflow/advanced.js`. Validate with `npx vitest run server/tests/handler-workflow-advanced.test.js server/tests/handler-workflow-handlers.test.js server/tests/workflow-runtime.test.js server/tests/workflow-advanced-handlers.test.js` and `npm run lint`.
- **Persistence and scheduling:** Recheck `server/db/task-core.js`, `server/db/provider-routing-core.js`, `server/db/config-core.js`, and `server/db/host-management.js`. Validate with `npx vitest run server/tests/api-server.test.js server/tests/test-container-helper.js server/tests/v2-health-models.test.js server/tests/handler-task-core-extended.test.js` and `npm run lint`.

## Hotspots
- `server/tests/vitest-setup.js` — High fan-in (242) and fan-out (8) inside Validation and tests.
- `server/logger.js` — High fan-in (180) and fan-out (3) inside Runtime core.
- `server/db/task-core.js` — High fan-in (153) and fan-out (11) inside Persistence and scheduling.
- `server/task-manager.js` — High fan-in (74) and fan-out (65) inside Task execution pipeline.
- `server/tools.js` — High fan-in (36) and fan-out (102) inside Tool and MCP surface.
- `server/db/workflow-engine.js` — Shared internal dependency reused by 55 indexed modules in Persistence and scheduling.

## Representative Tests
- **Task lifecycle:** `server/tests/codebase-study.test.js`, `server/tests/host-distribution.test.js`, `server/tests/starttask-helpers.test.js`, and `server/tests/task-pipeline-handlers.test.js`. Tests touch files that participate in this canonical flow.
- **Scheduled automation:** `server/tests/v2-governance-handlers.test.js`, `server/tests/v2-governance-plan-projects.test.js`, `server/tests/api-server-core.test.js`, and `server/tests/api-server.test.js`. Tests touch files that participate in this canonical flow.
- **Workflow lifecycle:** `server/tests/handler-workflow-advanced.test.js`, `server/tests/handler-workflow-handlers.test.js`, `server/tests/workflow-advanced-handlers.test.js`, and `server/tests/handler-workflow-await.test.js`. Tests touch files that participate in this canonical flow.
- **Provider routing and retry:** `server/tests/test-container-helper.js`, `server/tests/provider-health-history.test.js`, `server/tests/fallback-retry.test.js`, and `server/tests/provider-capabilities.test.js`. Tests touch files that participate in this canonical flow.

## Navigation Hints
- How does a task move from submission to completion? Read `server/api/v2-dispatch.js`, `server/handlers/task/index.js`, `server/task-manager.js`, and `server/execution/task-startup.js`. Task requests enter through API or handlers, start in the task manager, route through execution modules, and finish in the completion pipeline.
- How are workflows created, advanced, and awaited? Read `server/handlers/workflow/index.js`, `server/handlers/workflow/dag.js`, `server/execution/workflow-runtime.js`, and `server/handlers/workflow/await.js`. Workflow handlers define DAG structure, the runtime unblocks nodes, and await logic surfaces progress and completion.
- How do schedules and Run Now executions work? Read `server/db/cron-scheduling.js`, `server/api/v2-governance-handlers.js`, `server/maintenance/scheduler.js`, and `server/execution/schedule-runner.js`. Schedules are stored in DB helpers, fired by the maintenance scheduler, and translated into tasks or tool executions by the schedule runner.
- Where do tool definitions, dispatch, and MCP transport live? Read `server/tools.js`, `server/core-tools.js`, `server/hooks/post-tool-hooks.js`, and `server/mcp/index.js`. Tool definitions and schemas are registered centrally, then routed to handlers and post-tool hooks through the MCP surface.
- How does TORQUE choose providers and retry failed work? Read `server/db/provider-scoring.js`, `server/db/provider-health-history.js`, `server/db/provider-capabilities.js`, and `server/execution/provider-router.js`. Provider scoring, routing, and fallback logic combine health, capabilities, and retries to decide where work runs.
- What lives in the control-plane api? Read `server/index.js`. HTTP and transport surfaces that expose TORQUE task, provider, workflow, and governance operations. Coverage: 25/25 indexed. Representative files: `server/index.js`, `server/api/v2-governance-handlers.js`, and `server/api-server.js`. Key exports: `init` (8), `_testing` (2), and `buildV2Middleware` (2). Key dependencies: `server/api/middleware.js` (16) and `server/logger.js` (12).
