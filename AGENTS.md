# TORQUE Agents

Use these agents when orchestrating work through TORQUE in Codex.

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
