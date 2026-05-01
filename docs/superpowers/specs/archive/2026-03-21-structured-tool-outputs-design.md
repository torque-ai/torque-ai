# Structured Tool Outputs — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Phase 1 — 8 highest-value tools (infrastructure + proof of pattern)
**Motivation:** MCP spec 2025-06-18 supports `outputSchema` on tool definitions and `structuredContent` in responses. TORQUE's tools currently return only human-readable markdown in `content`. Adding structured output to high-value query tools lets LLMs parse task counts, statuses, and provider data directly without regex-parsing markdown.

## Approach

**Centralized Schema Registry + Handler Refactoring**

- `server/tool-output-schemas.js` — centralized registry of JSON Schema `outputSchema` definitions (same pattern as `tool-annotations.js`)
- Handlers for target tools add a `structuredData` field alongside existing `content`
- Protocol layer in `mcp-protocol.js` copies `structuredData` → `structuredContent` and cleans up the internal field
- `tools.js` merges `outputSchema` onto tool objects at startup (same pattern as annotations)

## Phase 1 Tools (8)

| Tool | Handler File | What It Returns |
|------|-------------|-----------------|
| `check_status` | `handlers/task/core.js` | Single task status or queue summary (running/queued counts, task list) |
| `task_info` | `handlers/task/core.js` | Delegates to check_status/get_result/get_progress by mode |
| `list_tasks` | `handlers/task/core.js` | Filtered task list with status, provider, model, timestamps |
| `get_result` | `handlers/task/core.js` | Completed task output, exit code, duration, files modified |
| `get_progress` | `handlers/task/core.js` | Running task progress percentage, elapsed time, output tail |
| `workflow_status` | `handlers/workflow/index.js` | Workflow state, task counts by status, per-task details |
| `list_workflows` | `handlers/workflow/index.js` | Workflow list with status, task counts, timestamps |
| `list_ollama_hosts` | `handlers/provider-handlers.js` | Host list with status, models, running tasks, health |

## Output Schemas

### check_status

Output shape depends on whether `task_id` is provided. The schema is a permissive union — all fields optional except `pressure_level`. When `task_id` is provided, `task` is present. Without it, `running_count`, `queued_count`, and the task arrays are present.

```json
{
  "type": "object",
  "properties": {
    "pressure_level": { "type": "string", "enum": ["low", "normal", "high", "critical"] },
    "task": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "status": { "type": "string", "enum": ["pending", "queued", "running", "completed", "failed", "cancelled"] },
        "provider": { "type": "string" },
        "model": { "type": "string" },
        "progress": { "type": "number" },
        "exit_code": { "type": "number" },
        "elapsed_seconds": { "type": "number" },
        "description": { "type": "string" }
      },
      "required": ["id", "status"]
    },
    "running_count": { "type": "number" },
    "queued_count": { "type": "number" },
    "running_tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "status": { "type": "string" },
          "provider": { "type": "string" },
          "model": { "type": "string" },
          "progress": { "type": "number" },
          "is_stalled": { "type": "boolean" },
          "last_activity_seconds": { "type": "number" },
          "description": { "type": "string" }
        }
      }
    },
    "queued_tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "provider": { "type": "string" },
          "model": { "type": "string" },
          "priority": { "type": "number" },
          "description": { "type": "string" }
        }
      }
    },
    "recent_tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "status": { "type": "string" },
          "model": { "type": "string" },
          "description": { "type": "string" }
        }
      }
    }
  },
  "required": ["pressure_level"]
}
```

**Implementation note:** The handler computes `running`, `queued`, and `recent` as separate DB queries (lines 563-565). Map them to `running_tasks`, `queued_tasks`, `recent_tasks` respectively — preserving the categorization. `is_stalled` and `last_activity_seconds` come from `taskManager.getTaskActivity()` (line 581).

### task_info

Delegates to check_status/get_result/get_progress by `mode` parameter. The schema is a superset of all three — fields present depend on mode. All fields optional except `mode`.

```json
{
  "type": "object",
  "properties": {
    "mode": { "type": "string", "enum": ["status", "result", "progress"] },
    "pressure_level": { "type": "string" },
    "task": { "type": "object" },
    "running_count": { "type": "number" },
    "queued_count": { "type": "number" },
    "running_tasks": { "type": "array" },
    "queued_tasks": { "type": "array" },
    "recent_tasks": { "type": "array" },
    "id": { "type": "string" },
    "status": { "type": "string" },
    "provider": { "type": "string" },
    "model": { "type": "string" },
    "exit_code": { "type": "number" },
    "duration_seconds": { "type": "number" },
    "output": { "type": "string" },
    "error_output": { "type": "string" },
    "files_modified": { "type": "array", "items": { "type": "string" } },
    "progress": { "type": "number" },
    "elapsed_seconds": { "type": "number" },
    "output_tail": { "type": "string" }
  },
  "required": ["mode"]
}
```

**Implementation note:** `task_info` delegates to other handlers. The `structuredData` from the delegate gets the `mode` field added, then returned directly. No separate construction needed — just pass through + tag with mode.

### list_tasks

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number" },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "status": { "type": "string" },
          "provider": { "type": "string" },
          "model": { "type": "string" },
          "priority": { "type": "number" },
          "description": { "type": "string" },
          "created_at": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  },
  "required": ["count", "tasks"]
}
```

### get_result

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "status": { "type": "string" },
    "provider": { "type": "string" },
    "model": { "type": "string" },
    "host_name": { "type": "string" },
    "exit_code": { "type": "number" },
    "duration_seconds": { "type": "number" },
    "output": { "type": "string" },
    "error_output": { "type": "string" },
    "files_modified": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["id", "status"]
}
```

**Implementation note:** `duration_seconds` must be computed as raw seconds from `task.started_at` and `task.completed_at` timestamps. Do NOT use `calculateDuration()` which returns a formatted string like "2m 30s". Use: `Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000)`.

### get_progress

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "status": { "type": "string" },
    "progress": { "type": "number" },
    "elapsed_seconds": { "type": "number" },
    "output_tail": { "type": "string" }
  },
  "required": ["id", "status", "progress"]
}
```

**Implementation notes:**
- `status` is derived from the progress object's `running` boolean: `progress.running ? 'running' : task.status`
- `elapsed_seconds` maps from `progress.elapsedSeconds` (camelCase in handler → snake_case in schema)
- `output_tail` uses the same truncated output as the markdown (respects `tail_lines` parameter)

### workflow_status

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "status": { "type": "string" },
    "visibility": { "type": "string" },
    "completed_count": { "type": "number" },
    "running_count": { "type": "number" },
    "queued_count": { "type": "number" },
    "pending_count": { "type": "number" },
    "blocked_count": { "type": "number" },
    "failed_count": { "type": "number" },
    "skipped_count": { "type": "number" },
    "cancelled_count": { "type": "number" },
    "open_count": { "type": "number" },
    "total_count": { "type": "number" },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "node_id": { "type": "string" },
          "task_id": { "type": "string" },
          "status": { "type": "string" },
          "provider": { "type": "string" },
          "progress": { "type": "number" },
          "exit_code": { "type": "number" },
          "depends_on": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  },
  "required": ["id", "name", "status", "total_count"]
}
```

**Implementation note:** All count fields come from `getWorkflowTaskCounts()` in `handlers/shared.js` (lines 305-368). The handler already computes `queued`, `blocked`, `skipped`, `cancelled`, `open`, `runnable`, `terminal` counts. `visibility` comes from `evaluateWorkflowVisibility()`.

### list_workflows

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number" },
    "workflows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "status": { "type": "string" },
          "visibility": { "type": "string" },
          "total_tasks": { "type": "number" },
          "completed_tasks": { "type": "number" },
          "open_tasks": { "type": "number" },
          "created_at": { "type": "string" }
        }
      }
    }
  },
  "required": ["count", "workflows"]
}
```

**Implementation note:** `visibility` and `open_tasks` come from `evaluateWorkflowVisibility()` and the enriched counts computed per-workflow in the handler (line 1230).

### list_ollama_hosts

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number" },
    "hosts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "url": { "type": "string" },
          "status": { "type": "string", "enum": ["healthy", "down", "degraded", "unknown"] },
          "enabled": { "type": "boolean" },
          "running_tasks": { "type": "number" },
          "max_concurrent": { "type": "number" },
          "memory_limit_mb": { "type": "number" },
          "models": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  },
  "required": ["count", "hosts"]
}
```

## Architecture

### Files

| File | Action | Purpose |
|------|--------|---------|
| `server/tool-output-schemas.js` | **New** | Schema registry: `getOutputSchema(name)`, `validateSchemaCoverage(names)` |
| `server/tools.js` | **Modify** | Merge `outputSchema` onto tool objects at startup |
| `server/mcp-protocol.js` | **Modify** | Copy `structuredData` → `structuredContent`, clean up internal field |
| `server/handlers/task/core.js` | **Modify** | Add `structuredData` to check_status, list_tasks, get_result, get_progress, task_info |
| `server/handlers/workflow/index.js` | **Modify** | Add `structuredData` to workflow_status, list_workflows |
| `server/handlers/provider-handlers.js` | **Modify** | Add `structuredData` to list_ollama_hosts |
| `server/tests/tool-output-schemas.test.js` | **New** | Registry tests, handler conformance tests, protocol tests |

### Data Flow

```
Handler returns:
  { content: [{ type: 'text', text: markdown }], structuredData: { ... } }
        ↓
mcp-protocol.js _handleToolCallInternal:
  if (result.structuredData && !result.isError):
    if (getOutputSchema(name)):
      result.structuredContent = result.structuredData
      delete result.structuredData
        ↓
Client receives:
  { content: [{ type: 'text', text: markdown }], structuredContent: { ... } }

Error paths:
  When handler returns without structuredData (errors, early returns),
  protocol layer simply omits structuredContent. This is spec-compliant —
  structuredContent is only required on successful (non-error) responses.

tools/list response includes:
  { name, description, inputSchema, annotations, outputSchema }
```

### Handler Modification Pattern

Each handler adds `structuredData` by extracting data it already has. No new DB queries — just reshaping existing variables into a structured object:

```js
// Example: check_status with task_id
const task = db.getTask(args.task_id);       // already fetched
const progress = getTaskProgress(task.id);    // already fetched

return {
  pressureLevel,
  content: [{ type: 'text', text: formatTaskStatus(task, progress) }],
  structuredData: {
    pressure_level: pressureLevel,
    task: {
      id: task.id,
      status: task.status,
      provider: task.provider,
      model: task.model,
      progress: progress?.progress || 0,
      exit_code: task.exit_code,
      elapsed_seconds: progress?.elapsedSeconds,
      description: (task.task_description || '').slice(0, 200),
    }
  }
};
```

### Protocol Compatibility

`mcp-protocol.js` reports `protocolVersion: '2024-11-05'`. The `outputSchema` and `structuredContent` features are additive — clients that support them check for the fields' presence, not the protocol version. Clients that don't support them ignore the extra fields. No protocol version bump is needed. If a future MCP SDK enforces version-gated feature detection, the version can be bumped then.

## Testing

### Registry Tests
- `getOutputSchema` returns schema for declared tools, `undefined` for undeclared
- Every declared schema is valid JSON Schema (type: 'object', has properties)
- No schema references a tool that doesn't exist in TOOLS (stale detection)
- Schema count matches expected Phase 1 count (8 tools)

### Handler Conformance Tests
For each Phase 1 tool:
- Call handler with representative args — verify `result.structuredData` exists and is an object
- Verify `result.structuredData` has the `required` fields declared in the schema
- Verify field types match schema declarations
- Verify `result.content` still exists (backward compat)

Error/edge cases:
- `check_status` with nonexistent `task_id` — verify NO `structuredData` on error response
- `get_result` with a still-running task — verify behavior (may return partial or error)
- `list_tasks` with no matching results — verify `{ count: 0, tasks: [] }` (empty array, not absent)
- `list_workflows` with no workflows — verify `{ count: 0, workflows: [] }`

### Protocol Layer Tests
- `tools/call` response includes `structuredContent` when handler returns `structuredData`
- `structuredData` internal field is NOT present in final response (cleaned up)
- `tools/call` response for tools without schema does NOT include `structuredContent`
- `tools/list` includes `outputSchema` on declared tools
- `tools/list` does NOT include `outputSchema` on undeclared tools

## Future Phases

Phase 2 (~10 tools): provider_stats, success_rates, list_providers, check_ollama_health, get_cost_summary, get_budget_status, get_cost_forecast, get_concurrency_limits, check_stalled_tasks, check_task_progress

Phase 3 (~12 tools): workflow_history, list_models, list_pending_models, list_archived, get_archive_stats, get_provider_health_trends, health_check, get_integration_health, list_tags, get_batch_summary

Each phase follows the same pattern: add schema to registry, add `structuredData` to handler, add conformance test. Schemas are forward-compatible — new fields can be added in future phases without breaking existing consumers.

## Non-Goals

- No changes to tools that return freeform text (mutations, file edits, etc.)
- No `outputSchema` for error responses (errors use existing `isError` + `content` pattern)
- No protocol version bump (outputSchema is additive, discovered by field presence)
- No breaking changes to existing `content` output (structuredContent is additive)
