# Compact Context Tool — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Motivation:** When LLMs resume sessions (context rollover, new conversation), they need to quickly understand "what happened, what's running, what's next" without calling 3-4 tools and parsing verbose markdown. Existing tools (`workflow_status`, `check_status`, `task_info`) return full tables, ASCII DAGs, and detailed output — useful for deep inspection but too heavy for session resume. A compact context tool returns a token-efficient digest (~200-300 tokens) that gives the LLM situational awareness in one call.

## Tool Definition

**New tool: `get_context`** — Tier 1 (core), always available.

```js
{
  name: 'get_context',
  description: 'Compact session context for LLM resume. Returns a token-efficient digest of current state — what completed, what is running, what is next, any blockers. Use this when resuming a session or needing a quick situational overview instead of calling multiple status tools.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'Workflow ID for workflow-scoped context. Omit for queue-wide context.'
      },
      include_output: {
        type: 'boolean',
        description: 'Include truncated output snippets from completed/failed tasks (default: false)',
        default: false
      }
    }
  }
}
```

- `workflow_id` provided → workflow scope
- `workflow_id` omitted → queue scope
- `include_output` opt-in to keep default response minimal

**Annotations:** `readOnlyHint: true, idempotentHint: true` (query tool, no side effects). Add as explicit override in `tool-annotations.js` since `get_` prefix convention already produces this annotation, but an explicit entry documents intent.

## Output Shape — Queue Scope

When called without `workflow_id`:

```json
{
  "scope": "queue",
  "pressure_level": "normal",
  "running": {
    "count": 2,
    "tasks": [
      { "id": "abc123", "provider": "codex", "progress": 45, "elapsed_seconds": 120, "description": "Write auth tests", "is_stalled": false }
    ]
  },
  "queued": {
    "count": 3,
    "next": [
      { "id": "def456", "priority": 5, "description": "Implement login UI" }
    ]
  },
  "recent_completed": {
    "count": 8,
    "last_3": [
      { "id": "ghi789", "status": "completed", "exit_code": 0, "duration_seconds": 120, "description": "Add user model" }
    ]
  },
  "recent_failed": {
    "count": 1,
    "tasks": [
      { "id": "jkl012", "status": "failed", "exit_code": 1, "error_snippet": "TypeError: cannot read...", "description": "Fix migration" }
    ]
  },
  "active_workflows": {
    "count": 1,
    "workflows": [
      { "id": "wf-001", "name": "Feature: Auth", "status": "running", "completed": 3, "total": 6 }
    ]
  },
  "provider_health": {
    "healthy": ["ollama", "codex"],
    "down": [],
    "degraded": []
  }
}
```

Design choices:
- `running.tasks` capped at 5 entries, includes `progress` (percentage) and `elapsed_seconds` for intervention decisions
- `queued.next` capped at 5 entries, sorted by priority descending
- `recent_completed`: `count` is total completed tasks, `last_3` shows last 3 by recency. Source: `db.listTasks({ status: 'completed', limit: 3 })`
- `recent_failed`: `count` is total failed tasks, `tasks` shows last 10 by recency. Failures demand attention, so higher cap. Source: `db.listTasks({ status: 'failed', limit: 10 })`
- `error_snippet` is first 200 chars of `task.error_output`, falling back to first 200 chars of `task.output` if `error_output` is empty
- `active_workflows`: fetch all workflows with `db.listWorkflows({})`, filter in JS to status `running` or `pending`. (`db.listWorkflows` only accepts a single status string, so multi-status requires in-memory filtering.)
- `provider_health` covers Ollama hosts only (via `db.listOllamaHosts()`). Cloud provider health (Codex, DeepInfra, etc.) is not tracked in the DB — this is a known limitation. Future enhancement could add cloud provider availability checks.

## Output Shape — Workflow Scope

When called with `workflow_id`:

```json
{
  "scope": "workflow",
  "workflow": {
    "id": "wf-001",
    "name": "Feature: Auth",
    "status": "running",
    "visibility": "actionable",
    "elapsed_seconds": 340
  },
  "counts": {
    "completed": 3,
    "running": 1,
    "queued": 1,
    "pending": 0,
    "blocked": 1,
    "failed": 0,
    "skipped": 0,
    "cancelled": 0,
    "total": 6
  },
  "completed_tasks": [
    { "node_id": "types", "exit_code": 0, "duration_seconds": 45 }
  ],
  "running_tasks": [
    { "node_id": "system", "provider": "codex", "elapsed_seconds": 120, "progress": 45 }
  ],
  "failed_tasks": [],
  "blocked_tasks": [
    { "node_id": "wire", "blocked_by": ["system"] }
  ],
  "next_actionable": [
    { "node_id": "tests", "depends_on": ["system"], "ready": false }
  ],
  "alerts": []
}
```

Design choices:
- `counts` includes `skipped` and `cancelled` (from `getWorkflowTaskCounts()`). Excludes `pending_provider_switch`, `open`, `runnable`, `terminal` — these are derived/aggregated values that add noise to a compact digest. LLMs needing those use `workflow_status`.
- `completed_tasks` is node_id + exit_code + duration only (use `get_result` for full output)
- `running_tasks` includes progress and provider for intervention decisions
- `failed_tasks` includes `error_snippet` (first 200 chars of `error_output`, fallback to `output`)
- `blocked_tasks` shows what's blocking each. `blocked_by` is the list of node_ids from `depends_on` that are NOT in `completed` status. Derivation: for each task with status `blocked` or `pending`, filter its `depends_on` list to only include nodes whose status is not `completed`.
- `next_actionable` shows pending/queued tasks where ALL `depends_on` nodes are `completed`. These are the tasks that can run immediately. `ready: true` means all deps complete; `ready: false` means some deps still running (but no deps failed/blocked).
- `alerts` sources: stall info from `taskManager.getTaskActivity()` per running task (is_stalled + lastActivitySeconds), provider fallback from task metadata field `_provider_switch_reason`. Example alerts: `"Task system stalled (no output 180s)"`, `"Task data fell back from ollama to codex"`.
- When `include_output: true`, completed_tasks and failed_tasks get `output_tail` (last 500 chars of `task.output`)

## Architecture

### Files

| File | Action | Purpose |
|------|--------|---------|
| `server/handlers/context-handler.js` | **New** | `handleGetContext` — builds compact digest for both scopes. Export function name `handleGetContext` maps to tool `get_context` via auto-dispatch (`pascalToSnake`). |
| `server/tool-defs/context-defs.js` | **New** | Tool definition for `get_context` |
| `server/tool-output-schemas.js` | **Modify** | Add `get_context` outputSchema |
| `server/tool-annotations.js` | **Modify** | Add `get_context` explicit override (readOnly + idempotent) |
| `server/core-tools.js` | **Modify** | Add `get_context` to TIER_1 array |
| `server/tools.js` | **Modify** | Two insertions: (1) add `...require('./tool-defs/context-defs')` to TOOLS array (~line 46), (2) add `require('./handlers/context-handler')` to HANDLER_MODULES array (~line 95) |
| `server/handlers/task/core.js` | **Modify** | Export `getTaskInfoPressureLevel` (currently module-local at ~line 37). Add to `module.exports`. |
| `server/tests/context-handler.test.js` | **New** | Unit + integration tests |

### Data Sources

The handler is a pure aggregator — no new DB queries beyond what existing tools already use:

| Data | Source | Field Mapping |
|------|--------|---------------|
| Running tasks | `db.listTasks({ status: 'running' })` | id, provider, description from task row |
| Queued tasks | `db.listTasks({ status: 'queued', limit: 5 })` | id, priority, description from task row |
| Recent completed | `db.listTasks({ status: 'completed', limit: 3 })` | id, exit_code, duration from timestamps |
| Recent failed | `db.listTasks({ status: 'failed', limit: 10 })` | id, exit_code, error_output snippet |
| Task progress | `taskManager.getTaskProgress(id)` | `.progress` (%), `.elapsedSeconds` → `elapsed_seconds` |
| Task activity | `taskManager.getTaskActivity(id, { skipGitCheck: true })` | `.isStalled` → `is_stalled` |
| Pressure level | `getTaskInfoPressureLevel()` (exported from `handlers/task/core.js`) | Direct string value |
| Workflow status | `db.getWorkflowStatus(workflow_id)` | id, name, status, tasks object, timestamps |
| Workflow counts | `getWorkflowTaskCounts(status)` (from `handlers/shared.js`) | completed, running, queued, pending, blocked, failed, skipped, cancelled, total |
| Workflow visibility | `evaluateWorkflowVisibility(status)` (from `handlers/shared.js`) | `.label` → visibility |
| Active workflows | `db.listWorkflows({})` filtered in JS to running/pending | id, name, status, counts |
| Provider health | `db.listOllamaHosts()` | Grouped by `.status` into healthy/down/degraded |

### Token Budget

- Queue scope target: ~200-300 tokens
- Workflow scope target: ~150-250 tokens
- Compared to `workflow_status`: 500-1000+ tokens (full task tables + ASCII DAG)
- Compared to `check_status` + `workflow_status` + `list_ollama_hosts`: 1500-3000 tokens

## Testing

### Unit Tests
- Queue scope with no args returns correct shape (all top-level fields present, correct types)
- Workflow scope with `workflow_id` returns correct shape
- Invalid `workflow_id` returns error without structuredData
- `include_output: true` adds `output_tail` to completed/failed task entries
- Queue scope caps: running.tasks max 5, queued.next max 5, recent_completed.last_3 max 3
- Workflow scope with empty workflow (all pending) returns zero counts and empty arrays
- Error snippets truncated to 200 chars
- "Nothing happening" — zero running, zero queued, zero recent: returns correct shape with empty arrays and zero counts
- `provider_health` with no hosts configured returns `{ healthy: [], down: [], degraded: [] }`
- Workflow scope `blocked_tasks.blocked_by` correctly lists incomplete dependency node_ids
- Workflow scope `next_actionable` correctly identifies tasks where all deps are completed
- Workflow scope `alerts` includes stall warnings for stalled running tasks

### Integration Tests
- `get_context` response has `structuredData` conforming to outputSchema
- `get_context` has annotations (readOnly + idempotent)
- `get_context` appears in Tier 1 tool list
- `get_context` structuredData flows through protocol layer as `structuredContent`

### Not Tested
Data accuracy of underlying queries — already covered by existing test suites for `db.listTasks`, `getWorkflowTaskCounts`, etc. We test that the handler shapes the output correctly.

## Non-Goals

- No caching (queries are fast enough, data changes frequently)
- No historical context (what happened yesterday) — this is current state only
- No replacing existing tools — `get_context` is for quick overview, detailed tools remain for deep inspection
- No project scoping (future enhancement — could add `project` parameter)
- No cloud provider health tracking (not in DB; Ollama hosts only)
