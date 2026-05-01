# Structured Tool Outputs Phase 2 — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Scope:** 10 provider/cost/monitoring tools — same pattern as Phase 1
**Prerequisite:** Phase 1 complete (schema registry, protocol layer, 8 tools)

## Tools

| Tool | Handler File | Key Data Fields |
|------|-------------|-----------------|
| `provider_stats` | `handlers/provider-handlers.js:177` | total_tasks, successful, failed, success_rate, total_tokens, total_cost, avg_duration |
| `success_rates` | `handlers/integration/index.js:584` | rates[]: group_key, total, successful, failed, success_rate |
| `list_providers` | `handlers/provider-handlers.js:84` | providers[]: provider, enabled, priority, max_concurrent |
| `check_ollama_health` | `handlers/provider-ollama-hosts.js:141` | healthy_count, total, hosts[]: name, url, status, models_count, vram |
| `get_cost_summary` | `handlers/validation/index.js:837` | Already returns JSON — just needs structuredData promotion |
| `get_budget_status` | `handlers/validation/index.js:852` | Already returns JSON — just needs structuredData promotion |
| `get_cost_forecast` | `handlers/validation/index.js:889` | Already returns JSON — just needs structuredData promotion |
| `get_concurrency_limits` | `handlers/concurrency-handlers.js` | providers[], hosts[] with max_concurrent, running_tasks |
| `check_stalled_tasks` | `handlers/task/operations.js:357` | stalled[]: taskId, elapsed, lastActivity, isStalled |
| `check_task_progress` | `handlers/task/operations.js:118` | running tasks with host, runtime, output_length |

## Approach

Identical to Phase 1:
1. Add `outputSchema` to `server/tool-output-schemas.js` for each tool
2. Add `structuredData` to each handler's return statement
3. Add conformance test per tool
4. Protocol layer and startup merge already handle everything else

Three tools (get_cost_summary, get_budget_status, get_cost_forecast) already return JSON in their text content — they just need the JSON also set as `structuredData` and a schema declared.

## Schemas

### provider_stats

```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string" },
    "total_tasks": { "type": "number" },
    "successful_tasks": { "type": "number" },
    "failed_tasks": { "type": "number" },
    "success_rate": { "type": "number" },
    "total_tokens": { "type": "number" },
    "total_cost": { "type": "number" },
    "avg_duration_seconds": { "type": "number" },
    "enabled": { "type": "boolean" },
    "priority": { "type": "number" },
    "max_concurrent": { "type": "number" }
  },
  "required": ["provider"]
}
```

### success_rates

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number" },
    "rates": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "group_key": { "type": "string" },
          "total": { "type": "number" },
          "successful": { "type": "number" },
          "failed": { "type": "number" },
          "success_rate": { "type": "number" }
        }
      }
    }
  },
  "required": ["count", "rates"]
}
```

### list_providers

```json
{
  "type": "object",
  "properties": {
    "default_provider": { "type": "string" },
    "count": { "type": "number" },
    "providers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "enabled": { "type": "boolean" },
          "priority": { "type": "number" },
          "max_concurrent": { "type": "number" }
        }
      }
    }
  },
  "required": ["count", "providers"]
}
```

### check_ollama_health

```json
{
  "type": "object",
  "properties": {
    "healthy_count": { "type": "number" },
    "total_count": { "type": "number" },
    "hosts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "url": { "type": "string" },
          "status": { "type": "string" },
          "running_tasks": { "type": "number" },
          "models_count": { "type": "number" }
        }
      }
    }
  },
  "required": ["healthy_count", "total_count", "hosts"]
}
```

### get_cost_summary

```json
{
  "type": "object",
  "properties": {
    "days": { "type": "number" },
    "costs": { "type": "object" }
  },
  "required": ["days"]
}
```

### get_budget_status

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number" },
    "budgets": { "type": "array" }
  },
  "required": ["count", "budgets"]
}
```

### get_cost_forecast

```json
{
  "type": "object",
  "properties": {
    "forecast": { "type": "object" }
  },
  "required": ["forecast"]
}
```

### get_concurrency_limits

```json
{
  "type": "object",
  "properties": {
    "providers": { "type": "array" },
    "hosts": { "type": "array" }
  },
  "required": ["providers"]
}
```

### check_stalled_tasks

```json
{
  "type": "object",
  "properties": {
    "running_count": { "type": "number" },
    "stalled_count": { "type": "number" },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "elapsed_seconds": { "type": "number" },
          "last_activity_seconds": { "type": "number" },
          "is_stalled": { "type": "boolean" }
        }
      }
    }
  },
  "required": ["running_count", "stalled_count", "tasks"]
}
```

### check_task_progress

```json
{
  "type": "object",
  "properties": {
    "running_count": { "type": "number" },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "host": { "type": "string" },
          "runtime_seconds": { "type": "number" },
          "output_length": { "type": "number" },
          "status": { "type": "string" }
        }
      }
    }
  },
  "required": ["running_count", "tasks"]
}
```

## Testing

One conformance test per tool: call handler, verify `structuredData` exists with correct required fields. Same pattern as Phase 1 tests in `tool-output-schemas.test.js`.

Update the "declares schemas for all expected tools" test to expect 19 total (9 current + 10 new).
