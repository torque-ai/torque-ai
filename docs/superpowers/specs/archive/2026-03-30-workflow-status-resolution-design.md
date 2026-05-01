# Workflow Status Resolution Design

**Date:** 2026-03-30
**Status:** Approved

## Problem

When a workflow completes, its final status is determined by a simple ternary chain:

```js
const finalStatus = stats.failed > 0 ? 'failed' : stats.cancelled > 0 ? 'cancelled' : 'completed';
```

This is too coarse. A workflow where 7/8 tasks completed and 1 failed gets the same `failed` status as a workflow where everything failed. A workflow where a user manually cancelled one task shows as `cancelled` even though most tasks succeeded.

## Solution

Add a `completed_with_errors` workflow status for workflows where all tasks reached a terminal state but some failed or were cancelled. Reserve `failed` for total failures and `cancelled` for explicit workflow-level cancellation.

### Status Resolution Logic

In `checkWorkflowCompletion` (`server/execution/workflow-runtime.js:1094`), replace the ternary with:

1. **Filter out superseded tasks:** Cancelled tasks with `resubmitted_as` in their metadata (from restart recovery) are excluded from status calculation -- the replacement task is what matters.

2. **Recount from the filtered set:**
   - `effectiveCompleted` -- completed + skipped tasks
   - `effectiveFailed` -- failed tasks
   - `effectiveCancelled` -- cancelled tasks (excluding superseded)

3. **Determine final status:**
   - **`completed`** -- all effective tasks completed or skipped (zero failures, zero non-superseded cancellations)
   - **`completed_with_errors`** -- all tasks terminal, at least one effective task completed, but some failed or were cancelled
   - **`failed`** -- all tasks terminal, zero tasks completed (all failed/cancelled/skipped)
   - **`cancelled`** -- workflow was explicitly cancelled via `cancel_workflow` tool (not individual task cancellations)

The `cancelled` status is set by the `cancel_workflow` codepath directly, not by `checkWorkflowCompletion`. `checkWorkflowCompletion` only resolves between `completed`, `completed_with_errors`, and `failed`.

### Dashboard Constants

New entries in `dashboard/src/constants.js`:

| Map | Key | Value |
|---|---|---|
| `STATUS_COLORS` | `completed_with_errors` | `'text-yellow-400'` |
| `STATUS_BG_COLORS` | `completed_with_errors` | `'bg-yellow-600'` |
| `STATUS_DOT_COLORS` | `completed_with_errors` | `'bg-yellow-400'` |
| `STATUS_ICONS` | `completed_with_errors` | `'⚠'` |

Yellow sits between green (completed) and red (failed) visually.

Workflow list views (`Workflows.jsx`, `BatchHistory.jsx`) already render via these constant maps and will pick up the new status automatically.

MCP tool responses (`await_workflow`, `workflow_status`) return the raw workflow status string. Claude and API consumers see `completed_with_errors` without handler changes.

### Schema

No new columns. The `workflows.status` column is TEXT and accepts any string value. No retroactive migration -- existing workflows keep their current status. The new logic applies going forward when `checkWorkflowCompletion` runs.

If workflow status validation exists, add `completed_with_errors` to the valid set.

### Superseded Task Filtering

A cancelled task is "superseded" when:
- `task.status === 'cancelled'`
- `task.cancel_reason` is `'server_restart'` or `'orphan_cleanup'`
- `task.metadata` contains `resubmitted_as` pointing to a replacement task

Superseded tasks are excluded from the effective count. This ensures restart-recovered workflows can still achieve `completed` status when all replacement tasks succeed.

## Files Affected

| File | Change |
|------|--------|
| `server/execution/workflow-runtime.js:1094` | Replace ternary with nuanced status resolution |
| `dashboard/src/constants.js` | Add `completed_with_errors` to all status maps |
| `server/execution/workflow-runtime.js` | Guard `checkWorkflowCompletion` to not override `cancelled` set by `cancel_workflow` |
| `server/tests/workflow-runtime.test.js` | Tests for new status resolution logic |

## Not In Scope

- Retroactive migration of existing workflow statuses
- Additional sub-statuses beyond the four defined here
- Changes to `await_workflow` response formatting (it already returns raw status)
