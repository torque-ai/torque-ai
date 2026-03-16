---
name: torque-cancel
description: Cancel running or queued TORQUE tasks
argument-hint: "[task-id | 'all']"
allowed-tools:
  - mcp__torque__cancel_task
  - mcp__torque__list_tasks
  - mcp__torque__check_status
  - AskUserQuestion
---

# TORQUE Cancel

Cancel running or queued tasks.

## Instructions

### If task ID provided ($ARGUMENTS is a UUID or short hash):

1. Call `cancel_task` with the task ID
2. Report success or failure
3. Call `check_status` to show updated queue

### If "all":

1. Call `list_tasks` with `status="running"` and `status="queued"`
2. Call `cancel_task` for each
3. Report count cancelled

### If no argument:

1. Call `check_status` to show current tasks
2. If there are running/queued tasks, present them via AskUserQuestion with options:
   - Each task as a selectable option (ID + description)
   - "Cancel all" option
3. Cancel selected task(s)
4. Show updated status

Cancelled tasks preserve their partial output for review.
