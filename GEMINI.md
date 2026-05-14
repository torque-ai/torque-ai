# TORQUE + Gemini

TORQUE is AI task orchestration: provider routing, queueing, workflow/dependency execution, and completion monitoring.

Gemini CLI does not use MCP tools, skills, or agents. Use the `torque` CLI (primary) or REST via `curl` (fallback).

## Common CLI workflows

Submit a task:

    torque submit "Add input validation to src/api/routes.ts"
    torque submit "Refactor parser.ts" --provider ollama

Check status:

    torque status
    torque status <task-id>

Wait for completion:

    torque await <task-id> --timeout 30m

Create and run a workflow:

    torque workflow create --name "feature-workflow" --description "Implement X"
    torque workflow add <workflow-id> --name "types" --description "Define interfaces" --provider codex-spark
    torque workflow add <workflow-id> --name "system" --depends-on types --description "Implement core logic" --provider codex
    torque workflow run <workflow-id>
    torque workflow await <workflow-id>

Cancel or inspect:

    torque cancel <task-id>
    torque health

Heavy work (optional remote execution):

    torque-remote npx vitest run tests/my-new-test.test.ts
    torque-remote npm run build

## Tool mapping (CLI ↔ REST)

| Operation | `torque` CLI | REST |
|-----------|--------------|------|
| submit_task | `torque submit` | `POST /api/tasks` |
| check_status | `torque status` | `GET /api/tasks` / `GET /api/tasks/{id}` |
| await_task | `torque await` | `GET /api/tasks/{id}` (long-poll/wait behavior) |
| create_workflow | `torque workflow create` | `POST /api/workflows` |
| add_workflow_task | `torque workflow add` | `POST /api/workflows/{id}/tasks` |
| run_workflow | `torque workflow run` | `POST /api/workflows/{id}/run` |
| await_workflow | `torque workflow await` | `GET /api/workflows/{id}` (wait behavior) |

## Curl example (direct REST)

    curl -sS -X POST http://127.0.0.1:3457/api/tasks \
      -H "Content-Type: application/json" \
      -d "{\"task\":\"Add input validation\",\"working_directory\":\"C:\\\\Users\\\\<user>\\\\Projects\\\\torque-public\"}"

    curl -sS http://127.0.0.1:3457/api/tasks/<task-id>

## Notes

- MCP tools, `/skill-*` handlers, and AGENTS-defined review/workflow-monitor roles are not available in this environment.
- The CLI binary is `torque` (`bin/torque.js`, mapped in `package.json` `bin`). There is no `torque-cli` shim.
- Use `torque` or REST endpoints for every TORQUE action.
