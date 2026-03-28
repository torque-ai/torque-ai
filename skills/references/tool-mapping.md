---
name: tool-mapping
description: "Reference: maps every TORQUE MCP tool to its REST API endpoint and CLI equivalent"
---

# TORQUE tool mapping

| MCP Tool | REST Endpoint | CLI Command |
|----------|---------------|-------------|
| `submit_task` | `POST /api/tasks` | `torque-cli submit` |
| `smart_submit_task` | `POST /api/tasks/smart` | `torque-cli smart-submit` |
| `check_status` | `GET /api/tasks/:id` | `torque-cli status :id` |
| `get_result` | `GET /api/tasks/:id/result` | `torque-cli result :id` |
| `cancel_task` | `DELETE /api/tasks/:id` | `torque-cli cancel :id` |
| `await_task` | (SSE-based, no REST) | `torque-cli await :id` |
| `await_workflow` | (SSE-based, no REST) | `torque-cli await-workflow :id` |
| `check_ollama_health` | `GET /api/health` | `torque-cli health` |
| `list_tasks` | `GET /api/tasks` | `torque-cli list` |
| `create_workflow` | `POST /api/workflows` | `torque-cli workflow create` |
| `add_workflow_task` | `POST /api/workflows/:id/tasks` | `torque-cli workflow add-task` |
| `workflow_status` | `GET /api/workflows/:id` | `torque-cli workflow status :id` |
| `run_workflow` | `POST /api/workflows/:id/run` | `torque-cli workflow run :id` |
| `subscribe_task_events` | (SSE-based) | `N/A` |
| `check_notifications` | (SSE-based) | `N/A` |
| `scan_project` | `POST /api/scan` | `torque-cli scan` |
| `set_project_defaults` | `POST /api/project-defaults` | `torque-cli config set` |
| `get_project_defaults` | `GET /api/project-defaults` | `torque-cli config get` |

### SSE-only tools

- `await_task`
- `await_workflow`
- `subscribe_task_events`
- `check_notifications`
