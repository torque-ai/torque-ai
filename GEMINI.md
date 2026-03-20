# TORQUE — Threaded Orchestration Router for Queued Unit Execution

TORQUE is an AI task orchestration server that routes code generation work across 13 execution providers (local Ollama, Codex, DeepInfra, Hyperbolic, and more) with automatic load balancing, stall recovery, and quality safeguards. It exposes a REST API, an MCP SSE transport, and a task queue with DAG workflow support. Submit a task, TORQUE picks the right provider and model, runs it, and notifies you when it's done.

## Gemini CLI Interface

Gemini CLI does not have access to MCP tools, skills, or agents. The primary interface is `torque-cli` — a Node.js CLI that wraps the TORQUE REST API.

> MCP tools (`mcp__torque__*`), skills (`/torque-submit`, etc.), and agents (`task-reviewer`, `workflow-architect`, `batch-monitor`) are **not available** in this environment. Use `torque-cli` for all TORQUE operations.

## Common Operations

### Submit a task

```
torque-cli submit "Add input validation to src/api/routes.ts — check required fields and return 400 on missing"
```

With explicit provider:
```
torque-cli submit "Create new file src/utils/retry.ts with exponential backoff helper" --provider codex
```

### Check queue status

```
torque-cli status
```

Check a specific task:
```
torque-cli status <task-id>
```

Filter by state:
```
torque-cli status --filter running
torque-cli status --filter failed
```

### Wait for task completion

```
torque-cli await <task-id>
```

Blocks until the task completes or fails, then prints the result. Does not poll — uses push notification via SSE.

### Cancel a task

```
torque-cli cancel <task-id>
```

### Health check

```
torque-cli health
```

Returns server status, connected providers, host availability, and queue depth.

## Workflow Operations

### Create and run a workflow

```
torque-cli workflow create --name "my-feature" --description "Implement X"
torque-cli workflow add <workflow-id> --name "types" --description "Define interfaces for X" --provider codex
torque-cli workflow add <workflow-id> --name "system" --description "Implement X system class" --provider codex --depends-on types
torque-cli workflow run <workflow-id>
torque-cli workflow await <workflow-id>
```

### Check workflow status

```
torque-cli workflow status <workflow-id>
```

## Full REST API

For direct API access or scripting, see `skills/references/tool-mapping.md` for the complete mapping of REST endpoints to MCP tools. The API runs on port 3457 by default:

```
http://127.0.0.1:3457/api/tasks
http://127.0.0.1:3457/api/tasks/<task-id>
http://127.0.0.1:3457/api/workflows
```

## Remote Workstation

Heavy commands (builds, tests, compilation) should go through `torque-remote`, not run directly:

```
torque-remote npx vitest run src/tests/foo.test.ts
torque-remote npm run build
torque-remote cargo build --release
```

`torque-remote` routes to the configured remote workstation and falls back to local execution if unreachable.

## Best Practices

- Use `torque-cli await` after submitting — do not poll `torque-cli status` in a loop
- After Codex tasks complete, run `git diff --stat` — Codex sandboxes can silently revert files
- Use `torque-cli health` to verify providers are available before submitting large batches
- For complex multi-file features, use workflow operations rather than a single large task
