# TORQUE Agents

Use these agents when orchestrating work through TORQUE in Codex.

## Durable TORQUE Change Rules

These rules apply to future Codex sessions working in this repository:

1) When fixing or changing TORQUE itself, create a dedicated git worktree and branch first. Do not edit `main` directly except for an explicitly approved emergency hotfix.
2) Make and verify changes inside that feature worktree. Keep the main worktree available for the currently running TORQUE server.
3) Merge the feature branch back deliberately after review. For runtime/server/config changes, prefer `scripts/worktree-cutover.sh <feature-name>` because it merges, drains, restarts, and cleans up through the intended path.
4) Use TORQUE restart barriers for server restarts: `restart_server` or `await_restart`. Do not use `taskkill`, `Stop-Process`, PID-file kills, or ad hoc node termination unless the MCP layer is unresponsive and the user explicitly approves.
5) Docs-only changes may merge without a restart, but still use a worktree and state that no restart is required.

## task-reviewer

name: task-reviewer
description: Review completed tasks and emit an APPROVE/FLAG verdict with traceable defects and fixes.
triggers: "review task", "check the output of that task", "validate the completed task", "approve or flag task"
instructions:
1) Read task metadata with `task_info` (or `check_status` where available), task id, provider, and status.
2) Read every changed file before judging completion quality.
3) Apply checks for stubs/TODOs, truncation, hallucinated APIs, missing error handling, weak type safety, and mismatch vs requested behavior.
4) Return `VERDICT: APPROVE` or `VERDICT: FLAG`.
5) For FLAG issues, provide severity (CRITICAL/IMPORTANT/SUGGESTION), file:line, concrete problem, and one scoped `submit_task` fix action.

## workflow-architect

name: workflow-architect
description: Turn feature specs into concrete TORQUE workflows with correct dependencies.
triggers: "plan a workflow", "break this into TORQUE tasks", "design the DAG for", "decompose this feature"
instructions:
1) Create either one `submit_task` or a `create_workflow` + ordered `add_workflow_task` plan.
2) Select providers by task profile: greenfield `codex`, heavy reasoning `deepinfra`, precision edits `hashline-ollama`, routine edits `ollama`.
3) Keep each node self-contained with file paths, acceptance criteria, and explicit `depends_on`.
4) Detect conflicting file writes and serialize those tasks.
5) Include dependency graph and conflict notes in output.

## batch-monitor

name: batch-monitor
description: Monitor running workflows/tasks, call out stalls/failures early, and summarize completion.
triggers: "monitor the workflow", "watch my running tasks", "keep an eye on the batch", "track workflow progress"
instructions:
1) If no id is provided, ask for workflow/task ids.
2) Start with `workflow_status` and report counts (running/pending/done/failed).
3) Monitor with heartbeat-style `await_workflow` calls and avoid polling loops.
4) On stall or failure, classify retryable logic vs runtime issues, then recommend one action with user confirmation.
5) On completion, provide a concise terminal summary and next-step recommendation.
