# Schedule Detail Drawer Design

**Date:** 2026-04-01
**Status:** Approved

## Summary

Add a right-side detail drawer to the dashboard Schedules view. Clicking a schedule row opens a slide-in panel showing full schedule details with inline-editable fields. Follows the same UX pattern as `TaskDetailDrawer` in the Kanban view.

## Component: `ScheduleDetailDrawer`

**File:** `dashboard/src/components/ScheduleDetailDrawer.jsx`

A focused component (~200-300 lines) that handles schedule detail display and inline editing. Lives inside `Schedules.jsx` state (not App.jsx) since it's only relevant on the Schedules page.

### Interaction Flow

1. User clicks a schedule row in `Schedules.jsx`
2. `Schedules.jsx` sets `selectedScheduleId` state
3. `ScheduleDetailDrawer` renders when `selectedScheduleId` is truthy
4. Drawer fetches full schedule via `GET /api/v2/schedules/:id`
5. User edits fields inline -- each field saves on blur/Enter via `PUT /api/v2/schedules/:id`
6. Close via X button, Escape key, or clicking the backdrop
7. On close, `Schedules.jsx` refreshes the list to reflect changes

### Drawer Layout

Four content sections plus header and actions:

**Header:**
- Editable schedule name (dashed underline, click to edit)
- Type badge: blue "Cron" or purple "Once"
- Status badge: green "Enabled" or gray "Disabled"
- Close (X) button

**Schedule Section:**
- Cron schedules: cron expression (editable), timezone (editable), next run (read-only), last run (read-only), run count (read-only)
- One-time schedules: fires-at datetime (editable via `datetime-local` input), countdown timer ("Xh Ym remaining"), timezone (editable)

**Execution Section:**
- Provider (editable, select dropdown)
- Model (editable, text input)
- Working directory (editable, text input)

**Task Description Section:**
- Full task description text (editable, auto-growing textarea)

**Info Section (read-only):**
- Schedule ID (truncated monospace)
- Created date
- One-time: "Auto-deletes after firing" note

**Actions (bottom):**
- Enable/Disable toggle button
- Delete button (with confirmation dialog)

### Visual Styling

- Drawer slides in from the right, same width as TaskDetailDrawer (~380px)
- Left border color matches type: blue (`#3b82f6`) for cron, purple (`#a855f7`) for one-time
- Sections use dark card backgrounds (`#1e293b`) with rounded corners
- Section headers are uppercase small labels (`#64748b`)
- Editable fields show dashed underline (`border-bottom: 1px dashed #475569`) as edit affordance

## Inline Editing Behavior

**Click-to-edit pattern:**
- Editable fields display as plain text with dashed underline hint
- Clicking replaces the text with the appropriate input control
- Save on blur or Enter -- sends `PUT /api/v2/schedules/:id` with the changed field
- Cancel on Escape -- reverts to original value
- Brief toast confirms "Schedule updated" on save

**Field types:**

| Field | Edit Control | Validation |
|-------|-------------|------------|
| Name | Text input | Required, non-empty |
| Cron expression | Text input | 5-field cron format |
| Fires At (one-time) | `datetime-local` input | Must be in the future |
| Timezone | Text input | IANA timezone string or empty |
| Provider | Select dropdown | Known provider list |
| Model | Text input | Free text |
| Working directory | Text input | Free text (server validates path) |
| Task description | Textarea (auto-grows) | Required, non-empty |

**Optimistic UI:** Update local state immediately on save. If PUT fails, revert the field and show error toast. No full re-fetch after each edit.

**Countdown for one-time:** Computed client-side from `next_run_at`. Updates every 60s via `setInterval`. Shows "Xh Ym remaining" or "Firing soon..." when < 1 minute.

## Keyboard

- Escape while editing a field: cancel the edit
- Escape while not editing: close the drawer
- Tab: move between editable fields naturally

## Backend Changes

### New REST Route

Add `PUT /api/v2/schedules/:id` to `server/api/routes.js`:

```
{
  method: 'PUT',
  path: /^\/api\/v2\/schedules\/([^/]+)$/,
  handlerName: 'handleV2CpUpdateSchedule',
  mapParams: ['schedule_id'],
  validators: { params: validateDecodedParamField('schedule_id', 'schedule id') },
}
```

### New REST Handler

`handleUpdateSchedule` in `server/api/v2-governance-handlers.js`:
- Parses body for partial updates (any subset of: name, cron_expression, run_at, timezone, task_description, provider, model, working_directory)
- For cron schedules: validates cron_expression if provided
- For one-time schedules: validates run_at is in the future if provided
- Calls `schedulingAutomation.updateScheduledTask(id, updates)`

### Extend `updateScheduledTask`

In `server/db/cron-scheduling.js`, the existing `updateScheduledTask` handles: name, timezone, cron_expression, task_config, enabled.

Extend to also handle:
- `run_at`: updates both `scheduled_time` and `next_run_at` for once-type schedules
- `task_description`: updates the `task_description` column directly
- Partial `task_config` merge: if caller sends `{ provider: 'codex' }`, merge into existing task_config JSON rather than replacing it entirely

### Dashboard API Client

Add to `dashboard/src/api.js` schedules object:
```js
get: (id) => requestV2(`/schedules/${id}`),
update: (id, data) => requestV2(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
```

## Integration with Schedules.jsx

- Add `selectedScheduleId` state and `setSelectedScheduleId`
- Row click handler: `onClick={() => setSelectedScheduleId(schedule.id)}`
- Existing toggle/delete buttons use `e.stopPropagation()` to prevent also opening drawer
- Render `<ScheduleDetailDrawer>` when `selectedScheduleId` is truthy
- On drawer close: clear `selectedScheduleId` and call `loadSchedules()` to refresh

## Edge Cases

**Schedule fires while drawer is open:** PUT returns 404 (one-time auto-deleted). Show toast "Schedule has already fired" and close drawer.

**Concurrent edits:** Last write wins. No locking needed -- single-user dashboard.

**Empty optional fields:** Provider, model, timezone show as dash (--) when empty. Clicking opens the input with empty value.

## Files Changed Summary

| File | Change |
|------|--------|
| `dashboard/src/components/ScheduleDetailDrawer.jsx` | Create: new component (~250 lines) |
| `dashboard/src/views/Schedules.jsx` | Modify: add selectedScheduleId state, row click, render drawer |
| `dashboard/src/api.js` | Modify: add `schedules.get()` and `schedules.update()` |
| `server/api/routes.js` | Modify: add PUT route for schedules |
| `server/api/v2-governance-handlers.js` | Modify: add `handleUpdateSchedule` handler |
| `server/db/cron-scheduling.js` | Modify: extend `updateScheduledTask` for run_at, task_description, partial task_config merge |
| Tests | New tests for drawer, update handler, and updateScheduledTask extension |
