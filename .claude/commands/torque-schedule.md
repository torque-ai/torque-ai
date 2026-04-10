---
name: torque-schedule
description: List, pause, resume, create, and delete TORQUE scheduled tasks
argument-hint: "[list | pause <name> | resume <name> | create <name> <cron> | delete <name> | info <name> | run <name>]"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# TORQUE Schedule Management

Manage TORQUE scheduled tasks (cron jobs, autodev loops, etc.).

## API

All calls go through the dashboard API at `http://127.0.0.1:3456/api/schedules`.
POST/DELETE requests require the header `-H "X-Requested-With: XMLHttpRequest"`.

## Instructions

### If no argument or "list" — show all schedules:

1. Run:
   ```
   curl -s "http://127.0.0.1:3456/api/schedules"
   ```

2. Parse the JSON `.schedules` array and present as:

```
## TORQUE Schedules

| Name | Cron | Enabled | Status | Runs | Last Run | Next Run |
|------|------|---------|--------|------|----------|----------|
| autodev:workflow:bitsy | */20 * * * * | yes | active | 47 | 12:00 UTC | 12:20 UTC |

To manage: /torque-schedule pause|resume|delete|info <name-or-id>
```

Use the schedule `name` field for display. Truncate `id` to first 8 chars when showing IDs.

### If argument starts with "pause":

1. Resolve the schedule — parse name or ID from argument
2. If ambiguous, list schedules and ask via AskUserQuestion
3. Run:
   ```
   curl -s -X POST "http://127.0.0.1:3456/api/schedules/<ID>/toggle" \
     -H "Content-Type: application/json" \
     -H "X-Requested-With: XMLHttpRequest" \
     -d '{"enabled": false}'
   ```
4. Confirm: "Schedule **<name>** paused. It will not fire until resumed."

### If argument starts with "resume":

1. Resolve the schedule — parse name or ID from argument
2. Run:
   ```
   curl -s -X POST "http://127.0.0.1:3456/api/schedules/<ID>/toggle" \
     -H "Content-Type: application/json" \
     -H "X-Requested-With: XMLHttpRequest" \
     -d '{"enabled": true}'
   ```
3. Confirm: "Schedule **<name>** resumed. Next fire: <next_run_at>."

### If argument starts with "delete":

1. Resolve the schedule
2. Confirm with user via AskUserQuestion (destructive — cannot be undone)
3. Run:
   ```
   curl -s -X DELETE "http://127.0.0.1:3456/api/schedules/<ID>" \
     -H "X-Requested-With: XMLHttpRequest"
   ```
4. Confirm deletion

### If argument starts with "info":

1. Resolve the schedule
2. List all schedules and find the matching one
3. Present full details:
   - Name, ID, cron expression, timezone
   - Enabled/status, run count, max runs
   - Last run time, status, and summary
   - Next scheduled fire time
   - Working directory, provider, project
   - Task description (first 200 chars)

### If argument starts with "create":

1. Parse the arguments. Expected forms:
   - `create <name> <cron_expression>` — then ask for task description via AskUserQuestion
   - `create <name> <cron_expression> <task_description>` — all provided
   - `create` with no further args — ask for name, cron, and description via AskUserQuestion

2. Optional fields to ask about (or accept defaults):
   - `provider` — execution provider (codex, ollama, etc.). Default: smart routing.
   - `model` — model override. Default: none.
   - `working_directory` — project root. Default: current working directory.

3. Run:
   ```
   curl -s -X POST "http://127.0.0.1:3456/api/schedules" \
     -H "Content-Type: application/json" \
     -H "X-Requested-With: XMLHttpRequest" \
     -d '{"name": "<name>", "cron_expression": "<cron>", "task_description": "<desc>", "provider": "<provider>", "working_directory": "<dir>"}'
   ```
   Omit `provider`, `model`, and `working_directory` from the JSON body if not specified.

4. Confirm: "Schedule **<name>** created. Cron: `<cron>`. Next fire: <next_run_at>."

### If argument starts with "run":

1. Resolve the schedule
2. Run:
   ```
   curl -s -X POST "http://127.0.0.1:3456/api/schedules/<ID>/run" \
     -H "Content-Type: application/json" \
     -H "X-Requested-With: XMLHttpRequest"
   ```
3. Report the result

## Resolving a schedule by name or ID

When the user provides a name or partial ID:
1. Fetch all schedules from `http://127.0.0.1:3456/api/schedules`
2. Match against `name` (case-insensitive contains) or `id` (prefix match)
3. If exactly one match, use it
4. If multiple matches, present them and ask the user to pick
5. If no match, report "No schedule found matching '<input>'"
