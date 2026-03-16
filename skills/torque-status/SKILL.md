---
name: torque-status
description: Show TORQUE task status — running, queued, failed, hosts, and notifications
argument-hint: "[task-id | running | queued | failed | hosts | notifications]"
allowed-tools:
  - mcp__torque__check_status
  - mcp__torque__list_tasks
  - mcp__torque__get_progress
  - mcp__torque__get_result
  - mcp__torque__check_ollama_health
  - mcp__torque__list_ollama_models
  - mcp__torque__check_notifications
---

# TORQUE Status

Show current state of the TORQUE task queue and infrastructure.

## Instructions

### If argument is a task ID ($ARGUMENTS looks like a UUID or short hash):

1. Call `get_result` with the task ID to get full details
2. Call `get_progress` for the task if it's still running
3. Display: status, provider, model, host, elapsed time, description, output (if complete), errors (if failed)

### If argument is a filter keyword:

- **"running"**: Call `list_tasks` with `status="running"`. Show task ID, provider, model, host, elapsed time, description for each.
- **"queued"**: Call `list_tasks` with `status="queued"`. Show task ID, priority, description for each.
- **"failed"**: Call `list_tasks` with `status="failed"`. Show task ID, error summary, description for each.
- **"hosts"**: Call `check_ollama_health` then `list_ollama_models`. Show each host's URL, status, available models, and capacity.
- **"notifications"**: Call `check_notifications` to show pending task completion/failure events. Display each event's task ID, status, duration, and description.

### If no argument (default overview):

1. Call `check_status` to get the queue summary
2. Call `check_ollama_health` to show infrastructure health
3. Call `check_notifications` to show pending notification count
4. Present as:

```
## TORQUE Status

**Infrastructure:** [Ollama status] | [N models available]
**Queue:** Running: X | Queued: X | Completed (today): X | Failed: X
**Notifications:** X pending events

### Active Tasks
[For each: ID, provider, model, elapsed, description]

### Queued
[For each: ID, priority, description]

### Pending Notifications (if any)
[For each: task ID, status, duration, description]

### Recent Failures (if any)
[For each: ID, error summary]
```

5. If tasks are completed but not yet reviewed, remind: use `/torque-review` to inspect results
