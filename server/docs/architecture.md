# Architecture

## System Overview

TORQUE runs as an MCP server communicating with Claude Code over stdio using JSON-RPC 2.0. It simultaneously serves a real-time dashboard over HTTP/WebSocket and a REST API for external integrations.

```
Claude Code (IDE)
    │
    │ MCP stdio protocol (JSON-RPC 2.0)
    ▼
┌─────────────────────────────────────────────┐
│  TORQUE MCP Server (index.js)               │
│                                             │
│  ┌─────────┐  ┌──────────────┐              │
│  │ Tools   │  │ Task Manager │              │
│  │ (462)   │──│ (processes)  │              │
│  └────┬────┘  └──────┬───────┘              │
│       │              │                      │
│  ┌────┴────┐  ┌──────┴───────┐              │
│  │Handlers │  │  Providers   │              │
│  │ (42)    │  │ local+cloud  │              │
│  └────┬────┘  └──────┬───────┘              │
│  ┌────┴────────────────────┐                │
│  │   Database (SQLite)     │                │
│  │   50+ tables            │                │
│  └─────────────────────────┘                │
│                                             │
│  ┌─────────────┐  ┌───────────┐             │
│  │ Dashboard   │  │ REST API  │             │
│  │ :3456       │  │ :3457     │             │
│  │ HTTP + WS   │  │ HTTP      │             │
│  └─────────────┘  └───────────┘             │
└─────────────────────────────────────────────┘
    │                    │
    ▼                    ▼
  Ollama hosts       Cloud APIs
  (LAN/local)      (Anthropic, Groq, DeepInfra, Hyperbolic)
```

## Module Layout

### Server Core

| Module | File | Purpose |
|--------|------|---------|
| Entry Point | `index.js` | MCP server lifecycle, JSON-RPC handler, orphan mode, shutdown |
| Tool Definitions | `tools.js` | All 462 MCP tool schemas and dispatch to handlers |
| Task Manager | `task-manager.js` | Process spawning, queue processing, health monitoring, retry |
| Database | `database.js` | SQLite schema, queries, data validation, migrations |

### Handlers (`handlers/`)

`server/handlers/` currently contains 42 handler modules:

| Module |
|--------|
| `adv-approval.js` |
| `adv-artifacts.js` |
| `adv-coordination.js` |
| `adv-debugger.js` |
| `adv-intelligence.js` |
| `adv-performance.js` |
| `adv-scheduling.js` |
| `advanced-handlers.js` |
| `automation-batch-orchestration.js` |
| `automation-handlers.js` |
| `automation-ts-tools.js` |
| `conflict-resolution-handlers.js` |
| `error-codes.js` |
| `hashline-handlers.js` |
| `inbound-webhook-handlers.js` |
| `integration-handlers.js` |
| `integration-infra.js` |
| `integration-plans.js` |
| `integration-routing.js` |
| `provider-handlers.js` |
| `provider-ollama-hosts.js` |
| `provider-tuning.js` |
| `remote-agent-handlers.js` |
| `shared.js` |
| `snapscope-handlers.js` |
| `task-core.js` |
| `task-handlers.js` |
| `task-intelligence.js` |
| `task-operations.js` |
| `task-pipeline.js` |
| `task-project.js` |
| `task-utils.js` |
| `tsserver-handlers.js` |
| `validation-analysis-handlers.js` |
| `validation-cost-handlers.js` |
| `validation-failure-handlers.js` |
| `validation-file-handlers.js` |
| `validation-handlers.js` |
| `validation-safeguard-handlers.js` |
| `validation-security-handlers.js` |
| `validation-xaml-handlers.js` |
| `webhook-handlers.js` |
| `workflow-advanced.js` |
| `workflow-await.js` |
| `workflow-dag.js` |
| `workflow-handlers.js` |
| `workflow-templates.js` |

### Providers (`providers/`)

| Module | Purpose |
|--------|---------|
| `execute-api.js` | API provider execution (Anthropic, Groq, OpenAI-compatible providers) |
| `execute-cli.js` | CLI-backed provider execution (Claude CLI, Codex) |
| `execute-hashline.js` | Hashline/Hashline-OpenAI execution adapters |
| `execute-ollama.js` | Ollama execution path and host selection |

### Database (`db/`)

`server/db/` currently contains 52 modules:

| Module |
|--------|
| `adaptive-retry.js` |
| `analytics-metrics.js` |
| `analytics.js` |
| `audit.js` |
| `bulk-operations.js` |
| `code-analysis.js` |
| `config.js` |
| `coordination.js` |
| `cost-tracking.js` |
| `duration-prediction.js` |
| `event-tracking.js` |
| `experimentation.js` |
| `failure-prediction.js` |
| `file-baselines.js` |
| `file-conflict-tracking.js` |
| `file-quality.js` |
| `file-tracking.js` |
| `host-benchmarking.js` |
| `host-complexity.js` |
| `host-management.js` |
| `host-selection.js` |
| `inbound-webhooks.js` |
| `index.js` |
| `migrations.js` |
| `model-capabilities.js` |
| `pipeline-management.js` |
| `prioritization.js` |
| `project-cache.js` |
| `project-config-cache.js` |
| `project-config-core.js` |
| `project-config-pipelines.js` |
| `project-config.js` |
| `provider-routing-config.js` |
| `provider-routing-core.js` |
| `provider-routing-stats.js` |
| `provider-routing.js` |
| `scheduling-automation.js` |
| `scheduling.js` |
| `schema-migrations.js` |
| `schema-seeds.js` |
| `schema-tables.js` |
| `schema.js` |
| `task-artifacts.js` |
| `task-debugger.js` |
| `task-intelligence.js` |
| `task-metadata.js` |
| `tasks.js` |
| `validation-rules.js` |
| `validation.js` |
| `webhooks-streaming.js` |
| `workflow-engine.js` |
| `workflows.js` |

### Services

| Module | Purpose |
|--------|---------|
| `dashboard-server.js` | HTTP + WebSocket server for the live dashboard (port 3456) |
| `api-server.js` | REST API mapping HTTP endpoints to MCP tools (port 3457) |
| `discovery.js` | mDNS/Bonjour network discovery for Ollama hosts |
| `logger.js` | JSON-lines structured logging with rotation |
| `path-utils.js` | Path resolution, validation, data directory management |
| `types.js` | JSDoc type definitions for IDE autocomplete |

### Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `gpu-metrics-server.js` | Companion HTTP service for nvidia-smi GPU/VRAM metrics |
| `reset-ollama.sh` / `.ps1` | Platform-specific Ollama reset utilities |
| `mcp-launch-readiness.js` | MCP gateway startup verification |
| `check-live-rest-readiness.js` | REST API health + provider lane readiness |

## Data Flow

### Task Submission

1. Claude calls `smart_submit_task` via MCP
2. `tools.js` dispatches to `task-handlers.js`
3. Smart routing analyzes task complexity and selects provider
4. File baselines are captured (pre-execution snapshots)
5. Task is inserted into SQLite with status `pending`
6. `task-manager.js` spawns a provider process or makes an API call
7. Task status updates flow through the database
8. Dashboard receives WebSocket notifications in real-time
9. On completion, validation safeguards run automatically

### Provider Routing

```
Task Description
    │
    ▼
┌──────────────────┐
│  Smart Router    │
│  (complexity     │
│   analysis)      │
└────────┬─────────┘
         │
    ┌────┴────────────┐
    ▼                 ▼
Local LLM         Cloud Provider
(Ollama)          (Claude/Groq)
  │                   │
  ▼                   ▼
Simple tasks:     Complex tasks:
- Docs            - Security code
- Tests           - Multi-file refactor
- Boilerplate     - Architecture
- Config          - XAML/WPF
```

### Queue Processing

The task manager maintains a priority queue with distributed locking:

1. `processQueue()` acquires a distributed lock
2. Checks available capacity across all providers and hosts
3. Dequeues highest-priority task that fits available resources
4. Spawns execution, updates status to `running`
5. On completion: validates output, updates status, processes next

## Database Schema

TORQUE uses SQLite via `better-sqlite3` with 50+ tables organized by domain:

### Core Tables
- `tasks` — Main task table (status, provider, model, output, timing, metadata)
- `templates` — Reusable task templates
- `config` — Key-value configuration store
- `analytics` — Event logging and metrics

### Workflow Tables
- `workflows`, `task_dependencies` — DAG workflow definitions
- `pipelines`, `pipeline_steps` — Pipeline execution
- `scheduled_tasks`, `cron_schedules` — Task scheduling

### Provider Tables
- `ollama_hosts` — Remote Ollama host registry
- `provider_task_stats` — Provider performance metrics
- `benchmark_results` — GPU benchmark data

### Quality Tables
- `validation_rules`, `validation_results` — Safeguard rules and outcomes
- `quality_scores` — Output quality metrics
- `file_baselines` — Pre-execution file snapshots
- `rollback_points`, `task_rollbacks` — Rollback history
- `build_results`, `build_checks` — Build verification

### Governance Tables
- `approval_rules`, `approval_requests`, `pending_approvals` — Approval gates
- `audit_log`, `audit_trail` — Audit history
- `token_usage` — Token consumption tracking
- `budget_alerts` — Cost threshold alerts

### Integration Tables
- `webhooks`, `webhook_logs` — External event callbacks
- `agents`, `agent_groups`, `task_claims` — Multi-agent coordination
- `distributed_locks` — Concurrency control

## Security Model

### Input Validation
- Column name whitelisting for dynamic SQL queries
- Parameter binding (prepared statements) — no string interpolation
- JSON size validation (1MB max)
- String length limits on all inputs
- Date range sanity checks (1900–2100)

### Path Security
- Path traversal prevention (`..` filtering)
- Absolute path rejection for user inputs
- Safe working directory resolution

### Process Security
- `spawn()` instead of `exec()` — no shell injection
- 30-second timeout on git commands
- Process cleanup guard against double-cleanup
- Memory-bounded JSON parsing

### Access Control
- Optional API key authentication for the REST API (`X-Torque-Key` header)
- Tool filtering (core vs all tools) to reduce context window usage
- Approval gates for sensitive operations
- Audit logging of all state changes

## Concurrency Model

- The MCP server runs single-threaded on Node.js
- Task execution is delegated to child processes (spawn) or HTTP API calls
- Queue processing uses distributed locks to prevent race conditions across MCP instances
- A process-local lock prevents concurrent `processQueue()` calls within the same instance
- Task cleanup uses a guard map to prevent double-processing from close/error handler races

## Orphan Mode

When the MCP connection drops but tasks are still running, the server enters "orphan mode":
- Continues monitoring running tasks
- Shuts down cleanly once all tasks complete
- Prevents zombie processes

