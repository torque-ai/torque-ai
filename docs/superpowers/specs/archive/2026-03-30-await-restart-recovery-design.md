# Await Restart Recovery Design

**Date:** 2026-03-30
**Status:** Approved

## Problem

When the TORQUE server restarts (clean or crash), tasks that were running get cancelled. The `await_task` and `await_workflow` MCP tools have no recovery mechanism:

- **Clean restart:** `__shutdownSignal` fires, await returns a "Server Shutting Down" message. But the tasks are already cancelled by the time the server comes back — there's nothing to await anymore. Claude has to manually figure out what happened and resubmit.
- **Crash/hard kill:** No shutdown signal fires. The SSE connection drops. Claude's in-flight await call hangs indefinitely. On startup, orphan cleanup eventually marks the tasks, but there's no structured way for Claude to detect this happened.
- **No structured cancel reason:** `cancelTask()` writes a freeform string to `error_output`. There's no machine-readable field to distinguish restart-kills from user-cancellations, stalls, or timeouts.

## Solution

Approach A (cancel_reason field + await-side recovery) with a server epoch from Approach C for crash detection.

### 1. Schema Changes

#### `cancel_reason` column on tasks table

- **Type:** TEXT, nullable
- **Only set when status is `cancelled`**
- **Values:** `'user'`, `'server_restart'`, `'stall'`, `'timeout'`, `'orphan_cleanup'`, `'host_failover'`, `'workflow_cascade'`
- **Set by:** every codepath that calls `cancelTask()` or `updateTaskStatus(..., 'cancelled', ...)`

#### `server_epoch` in config table

- **Key:** `server_epoch`, **Value:** integer
- Starts at 1 (or 0 if not set, incremented to 1 on first boot)
- Read once at boot, incremented, written back, cached in memory

#### `server_epoch` column on tasks table

- **Type:** INTEGER
- Stamped at task creation time with the current epoch
- Used by await to detect orphans from crashed servers without waiting for cleanup timers

Migration runs automatically on startup (same pattern as existing schema migrations).

### 2. Cancel Codepath Updates

Every cancel codepath passes a structured reason. `cancelTask()` gains an options object:

```js
// Before:
cancelTask(taskId, 'Server shutdown')

// After:
cancelTask(taskId, 'Server shutdown', { cancel_reason: 'server_restart' })
```

Unset `cancel_reason` defaults to `'user'`.

| Codepath | Current reason string | New `cancel_reason` |
|---|---|---|
| `taskManager.shutdown({ cancelTasks: true })` | `'Server shutdown'` | `'server_restart'` |
| User-initiated cancel (MCP tool) | `'Cancelled by user'` | `'user'` |
| Stall detection auto-cancel | `'Stalled - no output for Xs'` | `'stall'` |
| Stale task timeout check | `'Auto-cancelled: Task exceeded X minute timeout'` | `'timeout'` |
| Host failover cleanup | `'Host X became unavailable'` | `'host_failover'` |
| Workflow cascade (parent failed) | varies | `'workflow_cascade'` |
| Startup orphan cleanup | currently marks as `failed` | Change to `cancelled` with `cancel_reason: 'orphan_cleanup'` |
| Batch cancel tool | `'Batch cancel'` | `'user'` |

The existing freeform reason string stays in `error_output` for human readability. The new `cancel_reason` column is the machine-readable field for programmatic decisions.

### 3. Server Epoch Lifecycle

**On startup:**
1. Read current `server_epoch` from config table (default 0 if not set)
2. Increment by 1, write back
3. Cache in memory (e.g., `serverConfig.epoch`)

**On task creation:**
- Stamp `server_epoch` on the task row with the current cached value

**Await-side epoch check:**
When `await_task` or `await_workflow` re-enters and finds a task in `running` status:
- Compare `task.server_epoch` vs current epoch
- If `task.server_epoch < currentEpoch` -> this task is an orphan from a dead server
- The await loop can immediately treat it as restart-cancelled without waiting for the orphan cleanup timer

The await loop itself becomes an eager orphan detector. The moment Claude reconnects and calls `await_task`, recovery starts immediately.

### 4. Await Recovery Logic

**Detection (at the top of the poll loop):**

```
if task.status === 'cancelled' AND cancel_reason in ['server_restart', 'orphan_cleanup']
  -> restart recovery path

if task.status === 'running' AND task.server_epoch < currentEpoch
  -> mark cancelled with cancel_reason 'orphan_cleanup', then restart recovery path
```

**Recovery path (auto_resubmit_on_restart: false, the default):**

Returns a structured response:

```markdown
## Task Cancelled by Server Restart

**Task ID:** abc123
**Cancel Reason:** server_restart
**Original Description:** Write unit tests for...
**Provider:** codex
**Partial Output:** (last 1500 chars)
**Files Modified:** src/foo.ts, src/bar.ts

### Recovery Options
- Resubmit with `submit_task` using the same description
- Check partial output and files modified before deciding
- Task was running for 2m 34s before cancellation
```

**Recovery path (auto_resubmit_on_restart: true):**

1. Clone the original task's description, provider, model, working_directory, tags, and timeout
2. Submit a new task via the existing `submitTask` internal function
3. Update the await loop to track the new task ID
4. Emit a heartbeat: "Task restart-cancelled, resubmitted as new-task-id, continuing to wait"
5. Continue the poll loop seamlessly

**Workflow recovery (auto_resubmit_on_restart: true):**

For `await_workflow`, iterate all tasks in the workflow:
- **Completed** -> skip (already done)
- **Cancelled with restart reason** -> resubmit, wire into the same workflow node
- **Pending/blocked** -> leave alone (DAG engine unblocks them when dependencies complete)
- **Running + stale epoch** -> mark cancelled, then resubmit

The workflow's `acknowledged_tasks` set is preserved, so already-yielded tasks aren't re-yielded.

### 5. New `await_task` / `await_workflow` Parameter

```
auto_resubmit_on_restart: boolean (default: false)
```

When true, the await loop automatically resubmits restart-cancelled tasks and continues waiting. When false, returns the structured recovery response and lets Claude decide.

### 6. Edge Cases & Safety

**Double-resubmit prevention:**
When auto-resubmit creates a new task, it writes `resubmitted_as: 'new-task-id'` into the original task's metadata. If the await loop encounters the same cancelled task again, it follows the pointer instead of resubmitting again.

**Resubmit loop breaker:**
If a task has been resubmitted due to restart more than 3 times (tracked via `restart_resubmit_count` in metadata), stop auto-resubmitting and return the recovery response instead. Something is structurally wrong.

**Provider preservation:**
The resubmitted task uses the same provider and model as the original. If the original provider was chosen by smart routing, the resubmitted task records the resolved provider (not "auto"), since conditions may have changed.

**Partial work handling:**
The resubmitted task starts from scratch. Providers like Codex work from the filesystem state, so if the original task wrote partial files, the new task picks up from that state naturally. For Ollama tasks, partial edits may have been applied, so the new task description should be sufficient to produce correct results from the current file state.

**Workflow node identity:**
When resubmitting a workflow task, the new task is wired to the same `workflow_node_id` so the DAG engine's dependency tracking still works. The old task's status in the workflow is updated to point to the replacement.

**Race with orphan cleanup:**
The await loop and the startup orphan cleanup could both try to handle the same orphaned task. The await loop's cancellation is idempotent — if orphan cleanup already marked it cancelled, the await loop just reads the cancel_reason and proceeds. If the await loop marks it first, orphan cleanup skips it (already cancelled).

## Files Affected

| File | Change |
|------|--------|
| `server/db/task-core.js` | Schema migration: add `cancel_reason` and `server_epoch` columns |
| `server/db/config-core.js` or `server/index.js` | Server epoch increment on startup |
| `server/execution/task-cancellation.js` | Accept and persist `cancel_reason` option |
| `server/task-manager.js` | Pass `cancel_reason` in shutdown, stamp epoch on task creation |
| `server/maintenance/orphan-cleanup.js` | Set `cancel_reason: 'orphan_cleanup'` when marking stale tasks |
| `server/handlers/workflow/await.js` | Recovery logic in both `handleAwaitTask` and `handleAwaitWorkflow` |
| `server/tool-defs/workflow-defs.js` | Add `auto_resubmit_on_restart` parameter to tool definitions |
| `server/execution/fallback-retry.js` | Pass appropriate `cancel_reason` for stall/host-failover cancels |
| `server/execution/workflow-runtime.js` | Pass `cancel_reason: 'workflow_cascade'` for cascade cancels |

## Not In Scope

- Server-side auto-resubmission on startup (explicitly rejected — Claude should decide)
- Resuming tasks from partial output (too complex, diminishing returns)
- SSE transport reconnection logic (handled by MCP client layer)
