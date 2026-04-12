# TORQUE Architecture Guide

How TORQUE works, from request entry to task completion.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        TORQUE Server                            │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │MCP stdio │  │ MCP SSE  │  │ REST API │   3 entry points     │
│  │ :stdin   │  │ :3458    │  │ :3457    │   all converge on    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   handleToolCall()  │
│       │              │              │                            │
│       └──────────────┼──────────────┘                           │
│                      ▼                                          │
│              ┌──────────────┐                                   │
│              │  tools.js    │  explicit TOOLS list              │
│              │ 582 built-in │  + enumerated routeMap wiring     │
│              └──────┬───────┘                                   │
│                     │                                           │
│       ┌─────────────┼─────────────┐                            │
│       ▼             ▼             ▼                             │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐                      │
│  │Handlers │  │Task Mgr  │  │Scheduler │                      │
│  │(22 files)│  │startTask │  │slot-pull │                      │
│  └─────────┘  └────┬─────┘  └────┬─────┘                      │
│                     │             │                              │
│                     ▼             ▼                              │
│              ┌──────────────────────┐                           │
│              │   Provider Registry  │                           │
│              │   12 providers       │                           │
│              └──────┬───────────────┘                           │
│                     │                                           │
│       ┌─────────────┼──────────────┐                           │
│       ▼             ▼              ▼                            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ Ollama  │  │  Codex   │  │Cloud APIs│                     │
│  │(local)  │  │(CLI sub) │  │(BYOK)   │                     │
│  └────┬────┘  └────┬─────┘  └────┬────┘                     │
│       │             │             │                             │
│       └─────────────┼─────────────┘                            │
│                     ▼                                           │
│              ┌──────────────┐                                  │
│              │Quality Gates │  7-phase completion pipeline      │
│              │30+ safeguards│                                  │
│              └──────┬───────┘                                  │
│                     │                                           │
│       ┌─────────────┼──────────────┐                           │
│       ▼             ▼              ▼                            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐                     │
│  │Workflow │  │Dashboard │  │  SQLite  │                     │
│  │Engine   │  │ :3456    │  │(15 sub-  │                     │
│  │(DAGs)   │  │(WebSocket)│  │ modules) │                     │
│  └─────────┘  └──────────┘  └──────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Request Flow

All three transports converge on a single dispatcher.

### Three Entry Points

| Transport | Port | File | Purpose |
|-----------|------|------|---------|
| **MCP stdio** | stdin/stdout | `server/index.js` | Claude Code direct connection |
| **MCP SSE** | 3458 | `server/mcp-sse.js` | Browser/remote MCP clients |
| **REST API** | 3457 | `server/api-server.core.js` | Dashboard, scripts, external tools |

### Dispatch Path

```
MCP stdio → handleMessage() → handleToolCallRequest() → callTool()
MCP SSE  → POST /messages   → handleMcpRequest()      → handleToolCall()
REST API → route match       → semantic handler         → handleToolCall()
                             → POST /api/tools/:name    → handleToolCall()
         ↓
   tools.js handleToolCall()
         ↓
   1. Inline handlers (ping, restart, unlock_tier)
   2. JSON Schema validation against tool-def schemas
   3. Path traversal guard on file_path args
   4. routeMap.get(name) → handler function
```

The built-in tool catalog now comes from the explicit `TOOLS` array in `server/tools.js`. Dispatch is wired from the curated `HANDLER_MODULES` list, with `handle*` exports converted via `pascalToSnake()` and additional manual `routeMap.set(...)` registrations for tools that need explicit routing, so new tools must be added to those lists rather than appearing automatically.

---

## Task Lifecycle

### 1. Submission

```
submit_task called
  │
  ├─ auto_route=true (default)?
  │   └─ handleSmartSubmitTask() analyzes task:
  │       ├─ Complexity: simple / normal / complex
  │       ├─ Language detection
  │       ├─ File count and sizes
  │       └─ Sets eligible_providers in metadata
  │
  └─ Creates task in DB with status: queued
      └─ Returns task ID immediately (non-blocking)
```

**Key file:** `server/handlers/task/core.js` → `handleSubmitTask()`
**Smart routing:** `server/handlers/integration/routing.js` → `handleSmartSubmitTask()`

### 2. Scheduling

The slot-pull scheduler runs a pass every 30 seconds and on every slot freed:

```
runSlotPullPass()
  │
  for each enabled provider:
  │
  ├─ Check available slots: max_concurrent - running_count
  ├─ Check Ollama host VRAM cap (shared across ollama providers)
  │
  for each open slot:
  │
  ├─ findBestTaskForProvider():
  │   ├─ Get unassigned queued tasks
  │   ├─ Filter by eligible_providers (from smart routing)
  │   ├─ Filter by capability_requirements
  │   ├─ Check quality gates (provider quality band vs task tier)
  │   ├─ Starvation override: after 5 min, relax quality gates
  │   └─ Return best match
  │
  ├─ claimTask(): atomic UPDATE ... WHERE status='queued'
  └─ startTask(taskId)
```

**Key file:** `server/execution/slot-pull-scheduler.js`
**Trigger:** 30s heartbeat + `process.emit('torque:queue-changed')` on task unblock

### 3. Execution

```
startTask(taskId)
  │
  ├─ Pre-flight checks (validation, budget, rate limits)
  ├─ Policy evaluation (governance rules)
  ├─ Atomic slot claim: db.tryClaimTaskSlot()
  ├─ File resolution (resolve paths from task description)
  │
  └─ Provider dispatch (based on provider category):
      │
      ├─ Ollama family:
      │   ├─ ollama → executeOllamaTask() → HTTP to Ollama API
      │
      ├─ CLI tools:
      │   ├─ codex → spawn codex CLI with stdin prompt
      │   ├─ codex-spark → spawn codex CLI with fast edit model
      │   └─ claude-cli → spawn claude CLI with stdin prompt
      │
      └─ Cloud APIs:
          └─ providerRegistry.getProviderInstance(name) → executeApiProvider()
              (anthropic, deepinfra, groq, hyperbolic, cerebras, google-ai, openrouter)
```

**Key file:** `server/task-manager.js` → `startTask()`
**Provider registry:** `server/providers/registry.js`

### 4. Completion (Quality Pipeline)

When a task's process exits, a 7-phase quality pipeline runs:

```
Process exits
  │
  Phase 0: Cleanup
  │  └─ Race guard, process cleanup, temp file removal
  │
  Phase 1: Retry Logic
  │  └─ Transient failure detection → automatic retry
  │
  Phase 2: Safeguard Checks
  │  └─ Output validation (empty output, truncation, error markers)
  │
  Phase 3: Auto Validation
  │  └─ Stub detection, TODO scanning, file size delta checks
  │
  Phase 4: Build/Test/Style
  │  └─ Compile check → test run → style check → auto-commit
  │
  Phase 5: Auto-Verify-Retry
  │  └─ Run project verify_command (e.g., "npm test")
  │  └─ Scoped error check (only fails if errors in THIS task's files)
  │  └─ On failure: auto-submit error-feedback fix task
  │
  Phase 6: Provider Failover
  │  └─ On failure: try next provider in fallback chain
  │
  Phase 7: Post-Completion
     ├─ Record provider usage + model outcome
     ├─ Fire terminal hooks + webhooks
     ├─ Evaluate workflow dependencies (unblock next tasks)
     ├─ Push dashboard update via WebSocket
     └─ Send MCP SSE notification to subscribed sessions
```

**Key files:**
- `server/execution/process-lifecycle.js` — Phase 0
- `server/execution/retry-framework.js` — Phase 1
- `server/validation/safeguard-gates.js` — Phase 2
- `server/validation/close-phases.js` — Phases 3, 4, 6
- `server/validation/auto-verify-retry.js` — Phase 5
- `server/execution/completion-pipeline.js` — Phase 7

---

## Provider System

### Categories

| Category | Providers | Execution Method |
|----------|-----------|-----------------|
| **Ollama** | ollama | HTTP to local/LAN Ollama API |
| **CLI** | codex, codex-spark, claude-cli | Spawn CLI process with stdin prompt |
| **Cloud API** | anthropic, deepinfra, hyperbolic, groq, cerebras, google-ai, openrouter, ollama-cloud | HTTP to cloud API (BYOK keys) |

### Smart Routing

`smart_submit_task` analyzes the task and sets `eligible_providers` in metadata:

| Complexity | Characteristics | Routed To |
|-----------|----------------|-----------|
| **Simple** | docs, comments, config changes | ollama |
| **Normal** | single-file code, tests | ollama or codex-spark |
| **Normal greenfield** | new file creation | codex |
| **Complex reasoning** | large code, architecture | deepinfra or hyperbolic |
| **Complex multi-file** | cross-file refactoring | codex or claude-cli |
| **XAML/WPF** | UI markup | anthropic |

### Fallback Chain

When a provider fails, the system tries the next provider:

```
ollama → codex → claude-cli → anthropic
deepinfra ↔ hyperbolic → anthropic → codex
```

**Key file:** `server/execution/fallback-retry.js`

---

## Workflow Engine

Workflows are directed acyclic graphs (DAGs) of tasks with dependencies.

### Structure

```
create_workflow "Feature Auth"
  │
  add_workflow_task "types"     (no deps)
  add_workflow_task "data"      (depends: types)
  add_workflow_task "system"    (depends: types, data)
  add_workflow_task "tests"     (depends: system)
  add_workflow_task "wire"      (depends: system, tests)
  │
  run_workflow
```

### Execution Flow

```
run_workflow
  │
  ├─ Tasks with no dependencies → status: queued (picked up by scheduler)
  ├─ Tasks with dependencies → status: blocked
  │
  Task completes
  │
  └─ handleWorkflowTermination(taskId)
      │
      ├─ evaluateWorkflowDependencies():
      │   ├─ Get all dependents of completed task
      │   ├─ For each dependent: are ALL its dependencies met?
      │   ├─ Evaluate condition expressions (default: completed or skipped)
      │   ├─ If met: inject context from completed tasks → unblockTask()
      │   └─ If condition failed: applyFailureAction()
      │       ├─ cancel — cancel the dependent
      │       ├─ skip — mark as skipped, evaluate its dependents
      │       ├─ continue — unblock anyway
      │       └─ run_alternate — switch to alternate node
      │
      └─ checkWorkflowCompletion():
          ├─ All tasks done → workflow: completed
          ├─ Any failed → workflow: failed
          └─ Blocked with no runnable → deadlock detected
```

**Key file:** `server/execution/workflow-runtime.js`

### Output Injection

When a task unblocks, completed dependency outputs are injected as context:

```
Task B depends on Task A
  → Task A completes with output "Created UserProfile.ts"
  → Task B's prompt gets prepended: "Prior step results: Created UserProfile.ts"
```

This lets downstream tasks build on upstream results.

---

## Dashboard

### Architecture

```
Browser ←── WebSocket ──→ Dashboard Server (:3456)
                              │
                              ├─ Static files (React SPA from dashboard/dist/)
                              ├─ REST API (/api/* routes)
                              └─ WebSocket topics:
                                  ├─ task:created
                                  ├─ tasks:batch-updated
                                  ├─ task:deleted
                                  ├─ stats:updated
                                  ├─ task:event
                                  └─ hosts:activity-updated
```

### Live Updates

TORQUE uses a debounced push system for dashboard updates:

1. Any module calls `process.emit('torque:task-updated', taskId)`
2. Dashboard server receives the event, adds to `pendingTaskUpdates` set
3. After 500ms debounce, `flushTaskUpdates()` sends batched deltas
4. Stats updates are throttled to once per 2 seconds
5. Large outputs are truncated and secrets redacted before broadcast

**Key file:** `server/dashboard-server.js`

### Views

| View | Shows |
|------|-------|
| **Kanban** | Real-time task flow (queued → running → completed) |
| **History** | Task history with search and filters |
| **Providers** | Provider cards grouped by category, stats, enable/disable |
| **Hosts** | Ollama host management, health, models |
| **Workflows** | DAG visualization, dependency tracking |
| **Budget** | Cost tracking, trends, budget alerts |
| **Strategic Brain** | AI decomposition/diagnosis/review + configuration |
| **Models** | Model configuration, tier assignments |
| + 6 more | Coordination, Approvals, Schedules, Batch History, Plan Projects, Routing Templates |

---

## Database

### Architecture

TORQUE uses SQLite via `better-sqlite3` (synchronous). The database module is a **facade** that merges exports from 15+ sub-modules into a single flat API.

```
database.js (facade)
  │
  ├─ Core exports (createTask, getTask, updateTaskStatus, listTasks, ...)
  │
  └─ _subModules merge loop:
      ├─ db/code-analysis.js
      ├─ db/cost-tracking.js
      ├─ db/host-management.js
      ├─ db/workflow-engine.js
      ├─ db/file-tracking.js
      ├─ db/scheduling-automation.js
      ├─ db/task-metadata.js
      ├─ db/coordination.js
      ├─ db/provider-routing-core.js
      ├─ db/event-tracking.js
      ├─ db/analytics.js
      ├─ db/webhooks-streaming.js
      ├─ db/inbound-webhooks.js
      ├─ db/project-config-core.js
      ├─ db/validation-rules.js
      └─ + additional specialized modules
```

### Merge Rules

1. Core exports (defined in `database.js`) take precedence (first-write-wins)
2. DI internals (`setDb`, `setGetTask`, etc.) are excluded from the public API
3. Sub-modules can be whitelisted with `{ mod, fns: ['specificFunction'] }` syntax
4. Result: one flat `module.exports` object with all database operations

### Key Tables

| Table | Purpose |
|-------|---------|
| `tasks` | All task state (status, provider, output, timestamps) |
| `workflows` | Workflow definitions and status |
| `task_dependencies` | DAG edges between tasks |
| `provider_config` | Provider settings (enabled, priority, max_concurrent) |
| `ollama_hosts` | Registered Ollama hosts (URL, status, models) |
| `project_config` | Per-project defaults (verify_command, provider, model) |
| `config` | Server-wide key-value configuration |
| `cost_tracking` | Per-task cost records |
| `file_baselines` | File snapshots for change comparison |
| `task_events` | Event bus for push notifications |

**Schema:** `server/db/schema-tables.js` (all CREATE TABLE/INDEX statements)
**Seeds:** `server/db/schema-seeds.js` (default provider configs, initial data)

---

## Key File Reference

| Component | File | Lines |
|-----------|------|-------|
| MCP stdio entry | `server/index.js` | ~1,300 |
| MCP SSE entry | `server/mcp-sse.js` | ~1,600 |
| REST API | `server/api-server.core.js` | ~2,650 |
| Tool dispatch | `server/tools.js` | ~820, 582 built-in |
| Tool definitions | `server/tool-defs/` | 44 files |
| Handlers | `server/handlers/` | 22 files |
| Task manager | `server/task-manager.js` | ~2,780 |
| Provider registry | `server/providers/registry.js` | ~200 |
| Slot-pull scheduler | `server/execution/slot-pull-scheduler.js` | ~260 |
| Workflow runtime | `server/execution/workflow-runtime.js` | ~1,100 |
| Quality pipeline | `server/validation/` + `server/execution/` | ~2,000 |
| Strategic Brain | `server/orchestrator/` | 6 files, ~800 |
| Dashboard server | `server/dashboard-server.js` | ~900 |
| Dashboard UI | `dashboard/src/` | React SPA, 14 views |
| Database facade | `server/database.js` | ~1,900 |
| DB sub-modules | `server/db/` | 15+ files |
| Schema | `server/db/schema-tables.js` | ~3,500 |
| Constants | `server/constants.js` | ~230 |
