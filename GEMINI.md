# TORQUE + Gemini

TORQUE is AI task orchestration: provider routing, queueing, workflow/dependency execution, and completion monitoring.

Gemini CLI does not use MCP tools, skills, or agents. Use `torque-cli` (primary) or REST via `curl` (fallback).

## Common CLI workflows

Submit a task:

    torque-cli submit "Add input validation to src/api/routes.ts"
    torque-cli submit "Refactor parser.ts" --provider ollama

Check status:

    torque-cli status
    torque-cli status <task-id>

Wait for completion:

    torque-cli await <task-id> --timeout 30m

Create and run a workflow:

    torque-cli workflow create --name "feature-workflow" --description "Implement X"
    torque-cli workflow add <workflow-id> --name "types" --description "Define interfaces" --provider hashline-ollama
    torque-cli workflow add <workflow-id> --name "system" --depends-on types --description "Implement core logic" --provider codex
    torque-cli workflow run <workflow-id>
    torque-cli workflow await <workflow-id>

Cancel or inspect:

    torque-cli cancel <task-id>
    torque-cli health

Heavy work (optional remote execution):

    torque-remote npx vitest run tests/my-new-test.test.ts
    torque-remote npm run build

## Tool mapping (CLI ↔ REST)

| Operation | `torque-cli` | REST |
|-----------|--------------|------|
| submit_task | `torque-cli submit` | `POST /api/tasks` |
| check_status | `torque-cli status` | `GET /api/tasks` / `GET /api/tasks/{id}` |
| await_task | `torque-cli await` | `GET /api/tasks/{id}` (long-poll/wait behavior) |
| create_workflow | `torque-cli workflow create` | `POST /api/workflows` |
| add_workflow_task | `torque-cli workflow add` | `POST /api/workflows/{id}/tasks` |
| run_workflow | `torque-cli workflow run` | `POST /api/workflows/{id}/run` |
| await_workflow | `torque-cli workflow await` | `GET /api/workflows/{id}` (wait behavior) |

## Curl example (direct REST)

    curl -sS -X POST http://127.0.0.1:3457/api/tasks \
      -H "Content-Type: application/json" \
      -d "{\"task\":\"Add input validation\",\"working_directory\":\"C:\\\\Users\\\\Werem\\\\Projects\\\\torque-public\"}"

    curl -sS http://127.0.0.1:3457/api/tasks/<task-id>

## Notes

- MCP tools, `/skill-*` handlers, and AGENTS-defined review/workflow-monitor roles are not available in this environment.
- Use `torque-cli` or REST endpoints for every TORQUE action.
