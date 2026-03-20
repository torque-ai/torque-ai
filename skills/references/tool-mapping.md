---
name: tool-mapping
description: Cross-platform reference mapping TORQUE MCP tools to REST API endpoints and torque-cli commands. Use when working on non-MCP platforms or building integrations.
---

# TORQUE Tool Mapping

TORQUE exposes functionality through three interfaces:
- **MCP tools** — available in Claude Code, Codex CLI, and any MCP-compatible host
- **REST API** — HTTP endpoints on port 3457 (base: `http://127.0.0.1:3457`)
- **torque-cli** — thin CLI wrapper over the REST API

## Core Task Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `smart_submit_task` | `POST /api/tasks` | `torque-cli submit <description>` | Auto-routes provider by complexity. Preferred entry point. |
| `submit_task` | `POST /api/tasks/submit` | `torque-cli submit --provider=X <description>` | Explicit provider; set `auto_route=false` to bypass smart routing |
| `check_status` | `GET /api/status?task_id=X` | `torque-cli status` | Omit task_id for all-tasks summary |
| `get_result` | `GET /api/tasks/:id` | `torque-cli result <task-id>` | Full output of a completed task |
| `list_tasks` | `GET /api/tasks?status=X&limit=N` | `torque-cli list [--status=X]` | Filter by status, tag, project |
| `cancel_task` | `DELETE /api/tasks/:id` | `torque-cli cancel <task-id>` | Sends SIGTERM → SIGKILL to subprocess |
| `wait_for_task` | *(polling loop over `GET /api/tasks/:id`)* | `torque-cli await <task-id>` | Blocks until done; CLI uses exponential backoff polling |
| `await_task` | *(MCP event-bus push)* | — | MCP-only; wakes instantly via SSE push. No REST/CLI equivalent |
| `queue_task` | — | — | MCP-only; queues without explicit provider assignment |

## Workflow Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `create_workflow` | `POST /api/workflows` + `POST /api/v2/workflows` | `torque-cli workflow create <name> --task "..."` | CLI requires at least one `--task` flag |
| `add_workflow_task` | `POST /api/workflows/:id/tasks` + `POST /api/v2/workflows/:id/tasks` | — | CLI has no add-task subcommand |
| `run_workflow` | `POST /api/workflows/:id/run` + `POST /api/v2/workflows/:id/run` | `torque-cli workflow run <id>` | Starts a created workflow |
| `workflow_status` | `GET /api/workflows/:id` + `GET /api/v2/workflows/:id` | `torque-cli workflow status <id>` | |
| `cancel_workflow` | `POST /api/v2/workflows/:id/cancel` | — | MCP/REST only |
| `pause_workflow` | `POST /api/v2/workflows/:id/pause` | — | MCP/REST only |
| `list_workflows` | `GET /api/v2/workflows?status=X` | — | MCP/REST only |
| `await_workflow` | *(MCP event-bus push)* | — | MCP-only; wakes instantly via SSE push. No REST/CLI equivalent |
| `create_feature_workflow` | `POST /api/v2/workflows/feature` | — | MCP/REST only; creates typed DAG (types→data→events→system→tests→wire) |

## Provider Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `list_providers` | `GET /api/providers` + `GET /api/v2/providers` | — | |
| `configure_provider` | `POST /api/providers/configure` | — | Enable/disable; set max_concurrent, API keys |
| `set_default_provider` | `POST /api/providers/default` | — | |
| `check_ollama_health` | `GET /api/health` | `torque-cli health` | Returns health of all Ollama hosts |

## Orchestration / Strategic Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `strategic_decompose` | `POST /api/tools/strategic_decompose` | `torque-cli decompose <feature> -d <dir>` | Uses 405B model to split features into sub-tasks |
| `strategic_diagnose` | `POST /api/tools/strategic_diagnose` | `torque-cli diagnose <task-id>` | Root-cause analysis on failed tasks |
| `strategic_review` | `POST /api/tools/strategic_review` | `torque-cli review <task-id>` | Quality review of completed task output |
| `strategic_benchmark` | `POST /api/tools/strategic_benchmark` | `torque-cli benchmark [--suite=all]` | Benchmark decompose/diagnose/review |

## Automation / Project Defaults

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `set_project_defaults` | — | — | MCP-only; persists per-project provider, model, verify_command |
| `get_project_defaults` | — | — | MCP-only |
| `configure_stall_detection` | — | — | MCP-only |
| `auto_verify_and_fix` | — | — | MCP-only; runs tsc/verify, auto-submits fix tasks |
| `generate_test_tasks` | — | — | MCP-only; scans for untested files |
| `scan_project` | — | — | MCP-only; project analysis before planning |

## CI Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `await_ci_run` | — | — | MCP-only |
| `watch_ci_repo` | — | `torque-cli ci watch <repo>` | Background CI failure polling |
| `ci_run_status` | — | `torque-cli ci status` | |
| `stop_ci_watch` | — | `torque-cli ci stop` | |
| `diagnose_ci_failure` | — | `torque-cli ci diagnose` | |
| `list_ci_runs` | — | `torque-cli ci runs` | |
| `configure_ci_provider` | — | `torque-cli ci configure` | |

## Notification Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `check_notifications` | — | — | MCP-only; retrieve push events for completed tasks |
| `subscribe_task_events` | — | — | MCP-only; subscribe to task completion/failure events |
| `ack_notification` | — | — | MCP-only |

## Server / Session Tools

| MCP Tool | REST Endpoint | torque-cli | Notes |
|----------|--------------|------------|-------|
| `ping` | `GET /healthz` | `torque-cli health` | Keepalive; CLI hits `/healthz` not `/ping` |
| `restart_server` | `POST /api/shutdown` | — | MCP triggers graceful restart; REST is shutdown-only |
| `unlock_tier` | — | — | MCP-only; progressively exposes more tools |
| `unlock_all_tools` | — | — | MCP-only; expose all ~488 tools |

## V2 Inference API (Direct LLM Access)

These REST endpoints are not exposed as MCP tools — they provide direct inference access for integrations.

| REST Endpoint | Notes |
|--------------|-------|
| `POST /api/v2/inference` | Route inference request through TORQUE's provider chain |
| `POST /api/v2/providers/:id/inference` | Direct inference to a specific provider |
| `GET /api/v2/providers/:id/capabilities` | Provider capability metadata |
| `GET /api/v2/providers/:id/models` | Available models for a provider |
| `GET /api/v2/providers/:id/health` | Provider health check |
| `GET /api/v2/tasks/:id/events` | SSE event stream for a specific task |
| `GET /api/v2/tasks/:id/logs` | Task execution logs |
| `GET /api/v2/tasks/:id/diff` | File diff produced by a task |

## MCP Tools With No REST Equivalent

The following tier-1 tools are only accessible via MCP:

- `await_task` / `await_workflow` — event-bus push, not polling
- `check_notifications` / `subscribe_task_events` / `ack_notification`
- `set_project_defaults` / `get_project_defaults`
- `configure_stall_detection`
- `auto_verify_and_fix` / `generate_test_tasks` / `scan_project`
- `unlock_tier` / `unlock_all_tools`
- `await_ci_run`

## Notes

- **REST API base URL:** `http://127.0.0.1:3457`
- **MCP SSE base URL:** `http://127.0.0.1:3458/sse`
- **torque-cli** reads `TORQUE_BASE_URL` env var (default: `http://127.0.0.1:3457`)
- **Legacy vs V2 routes:** `/api/tasks`, `/api/workflows` are legacy (still supported). `/api/v2/tasks`, `/api/v2/workflows` are the modern control-plane endpoints. The MCP tools route to both depending on the operation.
- **Authentication:** All endpoints require an auth token if configured. Pass as `Authorization: Bearer <token>` header.
