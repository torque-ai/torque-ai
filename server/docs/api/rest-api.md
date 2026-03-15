# REST API Reference

TORQUE exposes a REST API on port 3457 for external integrations (CI/CD, webhooks, scripts). The API maps HTTP endpoints to MCP tools.

## Base URL

```
http://127.0.0.1:3457
```

The API binds to localhost only. It is not accessible from other machines.

## Authentication

Authentication is optional. When configured, include the API key in the `X-Torque-Key` header.

### Set an API Key

```
configure { key: "api_key", value: "your-secret-key" }
```

### Using the Key

```bash
curl -H "X-Torque-Key: your-secret-key" http://127.0.0.1:3457/api/status
```

When no API key is configured, all requests are accepted without authentication.

## Response Format

### Success

```json
{
  "tool": "check_status",
  "result": "## Task Status\n\nRunning: 2\nQueued: 3\n..."
}
```

The `result` field contains the MCP tool's text output, typically formatted as Markdown.

### Error

```json
{
  "error": "Task not found"
}
```

Error responses use appropriate HTTP status codes (400, 401, 404, 500).

## Endpoints

### Health Check

```
GET /healthz
```

Container-friendly health endpoint. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "uptime_seconds": 3600,
  "database": "connected",
  "ollama": "healthy",
  "queue_depth": 3,
  "running_tasks": 1
}
```

---

### Tasks

#### Submit a Task

```
POST /api/tasks
```

Maps to `smart_submit_task`. Automatically selects the best provider.

**Request body:**

```json
{
  "task": "Write unit tests for src/utils/parser.js",
  "working_directory": "/path/to/project",
  "provider": "aider-ollama",
  "model": "codellama",
  "priority": 5
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `task` | Yes | Task description |
| `working_directory` | No | Project directory |
| `provider` | No | Override provider selection |
| `model` | No | Override model selection |
| `priority` | No | Priority (higher = more urgent) |

**Example:**

```bash
curl -X POST http://127.0.0.1:3457/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"task": "Write unit tests for parser.js"}'
```

#### List Tasks

```
GET /api/tasks
GET /api/tasks?status=running
GET /api/tasks?status=failed&provider=ollama
```

Maps to `list_tasks`.

| Query Parameter | Description |
|----------------|-------------|
| `status` | Filter by status (queued, running, completed, failed) |
| `provider` | Filter by provider |
| `limit` | Max results (default: 25) |

#### Get Task Result

```
GET /api/tasks/:task_id
```

Maps to `get_result`. Returns the task's full output, status, and metadata.

**Example:**

```bash
curl http://127.0.0.1:3457/api/tasks/abc123
```

#### Cancel a Task

```
DELETE /api/tasks/:task_id
```

Maps to `cancel_task`. Cancels a running or queued task.

**Example:**

```bash
curl -X DELETE http://127.0.0.1:3457/api/tasks/abc123
```

---

### Status & Health

#### System Status

```
GET /api/status
```

Maps to `check_status`. Returns queue overview with task counts by status.

#### Ollama Health

```
GET /api/health
```

Maps to `check_ollama_health`. Checks connectivity to all registered Ollama hosts.

---

### Providers

#### List Providers

```
GET /api/providers
```

Maps to `list_providers`. Returns all configured providers with their status.

---

### Workflows

#### Create a Workflow

```
POST /api/workflows
```

Maps to `create_workflow`.

**Request body:**

```json
{
  "name": "deploy-pipeline",
  "description": "Build, test, and deploy"
}
```

#### Run a Workflow

```
POST /api/workflows/:workflow_id/run
```

Maps to `run_workflow`. Starts executing the workflow.

---

### Metrics

#### Prometheus Metrics

```
GET /api/metrics
```

Maps to `export_metrics_prometheus`. Returns metrics in Prometheus text format for scraping.

---

## Dashboard API

The dashboard server (port 3456) has its own REST API for the web UI. These endpoints are separate from the main REST API.

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tasks` | List tasks with pagination |
| `GET` | `/api/tasks/:id` | Get task details with output chunks |
| `GET` | `/api/tasks/:id/logs` | Get task logs |
| `POST` | `/api/tasks/:id/retry` | Retry a failed task |
| `POST` | `/api/tasks/:id/cancel` | Cancel a task |
| `POST` | `/api/tasks/:id/approve-switch` | Approve provider switch |
| `POST` | `/api/tasks/:id/reject-switch` | Reject provider switch |

#### Query Parameters for `GET /api/tasks`

| Parameter | Description |
|-----------|-------------|
| `page` | Page number (default: 1) |
| `limit` | Items per page (default: 25, max: 100) |
| `status` | Filter by status |
| `provider` | Filter by provider |
| `search` | Search task descriptions |
| `from` | Start date filter |
| `to` | End date filter |
| `orderBy` | Sort field |
| `orderDir` | Sort direction (`asc` or `desc`) |

### Providers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/providers` | List providers with stats |
| `GET` | `/api/providers/:id/stats` | Provider statistics |

### Hosts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/hosts` | List Ollama hosts |
| `GET` | `/api/hosts/:id` | Get host details with settings |
| `GET` | `/api/hosts/activity` | GPU activity and model status |
| `POST` | `/api/hosts/scan` | Scan network for Ollama hosts |
| `POST` | `/api/hosts/:id/toggle` | Enable/disable host |

### Statistics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats/overview` | Dashboard overview stats |
| `GET` | `/api/stats/timeseries` | Task time series data |
| `GET` | `/api/stats/quality` | Quality score statistics |
| `GET` | `/api/stats/stuck` | Stuck/stalled task detection |

### Budget

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/budget/summary` | Cost summary |
| `GET` | `/api/budget/status` | Budget status |

### Plan Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/plan-projects` | List plan projects |
| `GET` | `/api/plan-projects/:id` | Get plan project details |
| `POST` | `/api/plan-projects/import` | Import a plan |
| `POST` | `/api/plan-projects/:id/pause` | Pause project |
| `POST` | `/api/plan-projects/:id/resume` | Resume project |
| `POST` | `/api/plan-projects/:id/retry` | Retry failed tasks |
| `DELETE` | `/api/plan-projects/:id` | Delete project |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/system/status` | Memory, uptime, system info |
| `GET` | `/api/instances` | Multi-session instance discovery |

### Project Tuning

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/project-tuning` | List project tunings |
| `POST` | `/api/project-tuning` | Create/update tuning |
| `GET` | `/api/project-tuning/:path` | Get specific tuning |
| `DELETE` | `/api/project-tuning/:path` | Delete tuning |

### Benchmarks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/benchmarks?hostId=...` | Get benchmark results |
| `POST` | `/api/benchmarks/apply` | Apply benchmark settings |

## CORS

Both API servers send `Access-Control-Allow-Origin: *` headers, allowing requests from any origin. The main API also allows `X-Torque-Key` in cross-origin requests.

## Body Size Limits

Both servers enforce a 10MB request body limit. Requests exceeding this limit receive a 400 error.

## Error Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 204 | Success (no content, used for OPTIONS) |
| 400 | Bad request (invalid JSON, body too large, invalid parameters) |
| 401 | Unauthorized (missing or invalid API key) |
| 404 | Not found |
| 500 | Server error |
