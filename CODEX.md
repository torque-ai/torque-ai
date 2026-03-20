# TORQUE — Threaded Orchestration Router for Queued Unit Execution

TORQUE is an AI task orchestration server that routes code generation work across 13 execution providers (local Ollama, Codex, DeepInfra, Hyperbolic, and more) with automatic load balancing, stall recovery, and quality safeguards. It exposes a REST API, an MCP SSE transport, and a task queue with DAG workflow support. Submit a task, TORQUE picks the right provider and model, runs it, and notifies you when it's done.

## MCP Tools

TORQUE's full tool surface is available via the `mcp__torque__` prefix. All tools described in `CLAUDE.md` are accessible — same names, same parameters:

```
mcp__torque__submit_task         # submit a single task
mcp__torque__smart_submit_task   # submit with auto provider routing
mcp__torque__await_task          # block until task completes (push, not poll)
mcp__torque__create_workflow     # create a DAG workflow
mcp__torque__add_workflow_task   # add a task node to a workflow
mcp__torque__run_workflow        # start a workflow
mcp__torque__await_workflow      # block until workflow completes (push, not poll)
mcp__torque__workflow_status     # snapshot of workflow state
mcp__torque__task_info           # full task output + metadata
mcp__torque__list_tasks          # list tasks with optional filters
mcp__torque__cancel_task         # cancel a running or queued task
mcp__torque__check_notifications # retrieve pending push notifications
```

See `skills/references/codex-tools.md` for the full annotated tool list.

## Key Operations

### Submit a task

```
mcp__torque__smart_submit_task {
  description: "Add input validation to src/api/routes.ts — check required fields and return 400 on missing",
  working_directory: "/path/to/project"
}
```

`smart_submit_task` routes automatically. For explicit provider selection, use `submit_task` with `provider: "codex"`.

### Wait for completion (do not poll)

```
mcp__torque__await_task {
  task_id: "<id>",
  heartbeat_minutes: 5
}
```

Returns a heartbeat every 5 minutes and wakes instantly when the task finishes. Re-invoke if you receive a heartbeat instead of a result.

### Submit a workflow (DAG)

```
mcp__torque__create_workflow { name: "my-feature-workflow", description: "Implement X" }
mcp__torque__add_workflow_task { workflow_id: "<id>", name: "types", description: "...", provider: "codex", depends_on: [] }
mcp__torque__add_workflow_task { workflow_id: "<id>", name: "system", description: "...", provider: "codex", depends_on: ["types"] }
mcp__torque__run_workflow { workflow_id: "<id>" }
mcp__torque__await_workflow { workflow_id: "<id>", heartbeat_minutes: 5 }
```

### Check status

```
mcp__torque__list_tasks { status: "running" }
mcp__torque__task_info { task_id: "<id>" }
```

## Remote Workstation

Heavy commands (builds, tests, compilation) must go through `torque-remote`, not run directly. Running `npx vitest`, `npm test`, `dotnet build`, etc. directly will be blocked when a remote workstation is configured.

```
torque-remote npx vitest run src/tests/foo.test.ts
torque-remote npm run build
torque-remote cargo build --release
```

`torque-remote` falls back to local execution if the remote is unreachable.

## Available Skills

Skills are composable workflows invoked via `/skill-name`. Each skill is defined under `skills/`:

| Skill | File | Purpose |
|-------|------|---------|
| `torque-submit` | `skills/torque-submit/SKILL.md` | Submit work with routing, baselines, retry |
| `torque-status` | `skills/torque-status/SKILL.md` | Queue overview — running, queued, failed, hosts |
| `torque-review` | `skills/torque-review/SKILL.md` | Review output — validate, quality score, build check |
| `torque-workflow` | `skills/torque-workflow/SKILL.md` | DAG pipelines — create, add tasks, monitor |
| `torque-budget` | `skills/torque-budget/SKILL.md` | Cost tracking, budget status, provider performance |
| `torque-config` | `skills/torque-config/SKILL.md` | Configuration — tuning, hardware, safeguards |
| `torque-cancel` | `skills/torque-cancel/SKILL.md` | Cancel running or queued tasks |
| `torque-restart` | `skills/torque-restart/SKILL.md` | Restart the TORQUE server |

**Reference:**
- `skills/references/tool-mapping.md` — full REST API to MCP tool mapping
- `skills/references/codex-tools.md` — annotated tool list for Codex users

## Available Agents

See `AGENTS.md` for agent definitions:

- **task-reviewer** — inspect completed tasks, produce APPROVE/FLAG verdicts
- **workflow-architect** — decompose features into optimal TORQUE task DAGs
- **batch-monitor** — watch running workflows, surface stalls and failures

## Best Practices

- Use `smart_submit_task` — it handles provider routing automatically
- Use `await_task` / `await_workflow` — never poll `task_info` in a loop
- Check heartbeat alerts — if a stall warning appears, consider cancel + resubmit with fallback provider
- After Codex tasks complete, run `git diff --stat` — Codex sandboxes can silently revert files
- Use `set_project_defaults` to configure per-project provider, model, and verify command
