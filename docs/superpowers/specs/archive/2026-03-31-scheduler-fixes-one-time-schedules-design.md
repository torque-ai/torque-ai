# Scheduler Fixes & One-Time Schedules Design

**Date:** 2026-03-31
**Status:** Approved

## Summary

Three changes to TORQUE's task scheduler:

1. **Fix `toggle_schedule` MCP handler** — `enabled` parameter is ignored, always toggles
2. **Fix `cancel_scheduled` MCP handler** — errors with `projectConfigCore.getScheduledTask is not a function`
3. **Add one-time schedules** — fire at a specific datetime, execute task or workflow, auto-delete

## Bug Fix 1: `toggle_schedule` Ignores `enabled` Parameter

### Problem

The MCP handler in `server/handlers/advanced/scheduling.js:112` destructures `enabled` from args and passes it to `toggleScheduledTask()`. The DB function checks `enabled !== undefined` to decide whether to set or toggle. In practice, `enabled: false` still toggles — likely the MCP framework strips boolean `false` from args or delivers it in a way that fails the `!== undefined` check.

### Fix

Make the handler explicitly check for key presence using `'enabled' in args` and coerce to boolean:

```js
function handleToggleSchedule(args) {
  const { schedule_id } = args;
  const enabled = 'enabled' in args ? Boolean(args.enabled) : undefined;
  const schedule = toggleScheduledTask(schedule_id, enabled);
  // ...
}
```

### Files Changed

- `server/handlers/advanced/scheduling.js` — `handleToggleSchedule`

## Bug Fix 2: `cancel_scheduled` Calls Wrong Module

### Problem

`handleCancelScheduled` in `server/handlers/task/operations.js:580` calls:
- `projectConfigCore.getScheduledTask(args.schedule_id)`
- `projectConfigCore.deleteScheduledTask(args.schedule_id)`

`projectConfigCore.getScheduledTask` is a DI proxy (`_dbFunctions.getScheduledTask`) that may not be wired. `projectConfigCore.deleteScheduledTask` is not exported at all. The working REST path in `v2-governance-handlers.js` and `dashboard/routes/admin.js` uses `schedulingAutomation` directly.

### Fix

Change `handleCancelScheduled` (and `handlePauseScheduled` which has the same issue) to import and use `schedulingAutomation` from `../../db/scheduling-automation`:
- `schedulingAutomation.getScheduledTask(id)` — properly exported via `cron-scheduling.js`
- `schedulingAutomation.deleteScheduledTask(id)` — properly exported via `cron-scheduling.js`
- `schedulingAutomation.updateScheduledTask(id, updates)` — for pause/resume

### Files Changed

- `server/handlers/task/operations.js` — `handleCancelScheduled`, `handlePauseScheduled`

## Feature: One-Time Schedules

### Data Model

Extend existing `scheduled_tasks` table. No new table.

**New column:**
- `run_at` (`TEXT`, nullable) — ISO 8601 datetime for one-time schedules. Null for cron schedules.

**Existing column reuse:**
- `schedule_type` — currently always `'cron'`, now also `'once'`
- `next_run_at` — set equal to `run_at` for one-time schedules (enables existing `getDueScheduledTasks` to pick them up unchanged)
- `cron_expression` — null for one-time schedules
- `task_config` — same JSON blob, with optional `workflow_id` field for workflow firing

**Schema migration:**
```sql
ALTER TABLE scheduled_tasks ADD COLUMN run_at TEXT;
```

### Delay String Parsing

The MCP tool accepts either absolute `run_at` or relative `delay` string. Delay is resolved to absolute `run_at` at creation time.

**Format:** Concatenated duration segments: `(\d+)([dhm])`
- `d` = days (24 hours)
- `h` = hours
- `m` = minutes

**Examples:**
- `"30m"` -> now + 30 minutes
- `"4h"` -> now + 4 hours
- `"2h30m"` -> now + 2 hours 30 minutes
- `"1d"` -> now + 24 hours
- `"1d6h"` -> now + 30 hours

**Implementation:** `parseDelay(str)` function in `cron-scheduling.js`. Returns milliseconds. Regex: `/(\d+)([dhm])/g`. Sum all segments. Reject if no valid segments found.

### MCP Tool: `create_one_time_schedule`

```
name: create_one_time_schedule
params:
  name (string, required) — schedule name
  run_at (string, optional) — ISO 8601 datetime
  delay (string, optional) — relative offset ("4h", "2h30m", "1d")
  timezone (string, optional) — IANA timezone for run_at interpretation
  task (string, optional) — task description (mutually exclusive with workflow_id)
  workflow_id (string, optional) — existing workflow to run at scheduled time
  working_directory (string, optional)
  provider (string, optional)
  model (string, optional)
  auto_approve (boolean, default false)
  timeout_minutes (number, default 30)
```

**Validation:**
- Exactly one of `run_at` or `delay` is required
- Exactly one of `task` or `workflow_id` is required
- Resolved `run_at` must be in the future (60-second grace window for near-immediate)

### Scheduler Firing Logic

The scheduler tick already calls `getDueScheduledTasks()` which returns all enabled schedules with `next_run_at <= now`. No change needed to the query.

**Task/workflow submission branch** in `server/maintenance/scheduler.js:112-137` (the scheduler tick that processes due schedules). Currently it always creates a task via `db.createTask` + `taskManager.startTask`. Add a branch:

```
for each due schedule:
  if schedule.task_config.workflow_id:
    run_workflow(workflow_id)  // via workflow handler, with origin metadata
  else:
    db.createTask(...)  // existing logic
    taskManager.startTask(taskId)
```

**Origin metadata** attached to submitted task/workflow:
```json
{
  "scheduled_by": "<schedule_id>",
  "schedule_type": "once",
  "schedule_name": "<schedule_name>"
}
```

**Post-fire cleanup** — modify `markScheduledTaskRun()` in `cron-scheduling.js`:

```
if (schedule.schedule_type === 'once') {
  deleteScheduledTask(id);
  return null;
} else {
  // existing cron logic: update next_run_at, increment run_count
}
```

### Modified Existing Tools

**`toggle_schedule`:** Works for both cron and one-time. Disabling prevents firing. Re-enabling a one-time schedule keeps original `run_at` (no recalculation — unlike cron where re-enable recalculates next_run from now).

**`cancel_scheduled`:** Works unchanged — deletes the row regardless of type.

**`list_schedules`:** Add `Type` column showing `cron` or `once`. For one-time, show `run_at` where cron expression would appear.

### REST API Changes

- `POST /api/v2/schedules` — accept `schedule_type: 'once'` with `run_at` or `delay` (instead of `cron_expression`)
- `PUT /api/v2/schedules/:id` — accept `run_at` updates for one-time schedules
- Toggle and delete routes work unchanged

### Dashboard Changes

**Create form:** Schedule type toggle: **Cron** | **One-Time**.
- Cron selected: cron expression input (existing)
- One-Time selected: `<input type="datetime-local">` date/time picker. No cron field.

**Schedule list table:**
- Add **Type** column (`Cron` / `Once`)
- One-time schedules show formatted `run_at` datetime where cron expression appears
- "Next Run" column already populated from `next_run_at`

**Reschedule:** For unfired one-time schedules, edit action shows date/time picker. Updates `run_at` and `next_run_at` via `PUT /api/v2/schedules/:id`.

### Edge Cases

**Past `run_at`:** Rejected with error "Scheduled time must be in the future". 60-second grace window for near-immediate schedules.

**Server restart:** One-time schedules persist in DB. If overdue after restart, fires immediately on next tick (same as overdue cron).

**Delay precision:** Resolved to absolute time at creation, not at fire time. "4h" means 4 hours from submission.

**Missing workflow at fire time:** If `workflow_id` doesn't exist when the schedule fires, log error in task metadata, delete the schedule anyway. No ghost entries.

**Concurrent tick overlap:** `markScheduledTaskRun` (which deletes for one-time) runs before submission. Second tick finds row gone, skips it.

**Dashboard race:** User edits datetime at exact moment it fires. Delete-on-fire wins, edit gets 404. Acceptable.

## Files Changed Summary

| File | Change |
|------|--------|
| `server/handlers/advanced/scheduling.js` | Fix toggle handler, add `handleCreateOneTimeSchedule` |
| `server/handlers/task/operations.js` | Fix cancel/pause to use `schedulingAutomation` |
| `server/db/cron-scheduling.js` | Add `parseDelay`, `createOneTimeSchedule`, modify `markScheduledTaskRun`, modify `toggleScheduledTask` for once type |
| `server/maintenance/scheduler.js` | Add workflow firing branch and origin metadata in scheduler tick (lines 112-137) |
| `server/db/scheduling-automation.js` | Re-export new functions from cron-scheduling |
| `server/tool-defs/advanced-defs.js` | Add `create_one_time_schedule` tool definition |
| `server/api/v2-governance-handlers.js` | Handle `schedule_type: 'once'` in create/update routes |
| `server/api/routes.js` | No change (existing routes cover it) |
| `dashboard/src/views/Schedules.jsx` | Type toggle, datetime picker, type column in list |
| `server/index.js` or schema file | `ALTER TABLE` migration for `run_at` column |
| Tests | New tests for one-time CRUD, delay parsing, fire-and-delete, toggle/cancel fixes |
