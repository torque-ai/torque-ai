# Restart Barrier Task Design

**Date:** 2026-04-10
**Status:** Draft
**Supersedes:** Current `restart_server` drain mode + `await_restart` polling

## Problem

The current restart mechanism lives outside the task system. `restart_server` with `drain: true` uses a `setInterval` poll loop, and `await_restart` uses an event-bus wait loop. Neither participates in the queue — during drain, the scheduler keeps starting new queued tasks, which extends drain time unpredictably. The restart is invisible to `task_info`, `list_tasks`, and the dashboard.

## Design

Make restart a first-class task in the queue system. When submitted, it acts as a barrier — the scheduler stops starting new work, running tasks drain naturally, and the restart fires when the pipeline is empty.

## Task Model

The restart task is a regular row in the `tasks` table:

| Field | Value |
|-------|-------|
| `provider` | `'system'` |
| `status` | Normal lifecycle: `queued` -> `running` -> `completed` |
| `task_description` | `"System restart: <reason>"` |
| `metadata` | `{ execution_type: 'system', system_action: 'restart', reason: '...' }` |
| `priority` | `0` (irrelevant — barrier blocks all starts regardless of priority) |
| `timeout_minutes` | Configurable, default 30 |

### Singleton Constraint

Only one active restart task at a time. Submitting a second returns an error with the existing task ID. "Active" means `status IN ('queued', 'running')`.

### Status Transitions

1. **`queued`** — barrier is up from this moment. Scheduler stops starting new work.
2. **`running`** — all previously-running tasks have completed. Drain is done.
3. **`completed`** — shutdown triggered. Task record survives the restart.

### Cancellation

Standard `cancel_task` sets status to `cancelled`. The scheduler no longer finds an active barrier, so queued work resumes immediately. The drain watcher tears down its listeners.

## Queue Scheduler Barrier

A single guard at the top of `processQueueInternal` in `queue-scheduler.js`, after the existing global capacity check:

```
Query for active restart barrier:
  SELECT id FROM tasks
  WHERE provider = 'system'
  AND status IN ('queued', 'running')
  LIMIT 1

If found: return immediately (don't start any new tasks)
```

The query only checks `provider = 'system'` and active status — no need to parse metadata JSON. If other system task types are added later, the query can be narrowed with a metadata check at that point. For now `provider: 'system'` is exclusively used for restart.

No new flags, no new state machine. The barrier is a query against existing data.

### Performance

One additional lightweight indexed query per scheduler cycle. The cycle already performs multiple DB reads (running count, queued task list, host capacity). Negligible overhead.

### Workflow Interaction

If a running workflow task completes and unblocks a dependent task, that task transitions to `queued`. The barrier prevents it from starting. When the new server comes up, the scheduler picks up the workflow from where it left off.

## Drain Watcher

A self-contained event listener created when the restart task is inserted.

### Lifecycle

1. `restart_server` handler creates the task, then spawns the drain watcher.
2. Watcher subscribes to terminal task events (`task:completed`, `task:failed`, `task:cancelled`) via the existing `taskEvents` emitter from `hooks/event-dispatch`.
3. On each event, check running count via `db.getRunningCount()`.
4. When running count hits zero:
   - Update restart task to `running`
   - Update restart task to `completed`
   - Set `process._torqueRestartPending = true`
   - Call `eventBus.emitShutdown()`
5. On timeout: update restart task to `failed` with `error_output: "Drain timeout after Xmin"`. Barrier lifts, queued work resumes.

### Cancellation Cleanup

Watcher listens for its own task being cancelled. If `task:cancelled` fires for the restart task ID, the watcher tears down listeners and stops. No orphaned timers.

### No Polling

Unlike the current `setInterval` drain, this is purely event-driven. Task terminal events wake the watcher instantly.

## API Surface

### `restart_server`

Always creates a barrier task. The `drain` and `drain_timeout_minutes` parameters are removed.

**Parameters:**
- `reason` (string, optional) — restart reason, logged and stored in task metadata
- `timeout_minutes` (number, optional, default 30) — max drain wait before the restart task fails

**Returns:**
```json
{
  "task_id": "rst-xxxx",
  "status": "queued",
  "pipeline": { "running": 3, "queued": 2 },
  "message": "Restart barrier queued. 3 running tasks must complete before restart."
}
```

If the pipeline is already empty, the task goes `queued` -> `running` -> `completed` immediately and shutdown triggers — same end result as today's immediate restart.

If a restart task already exists, returns:
```json
{
  "task_id": "rst-existing",
  "status": "already_pending",
  "message": "Restart already pending (task rst-existing). Cancel it first or await it."
}
```

### `await_restart`

Becomes a thin wrapper. Submits the restart barrier task (or attaches to an existing one) and calls the standard `await_task` logic — heartbeats, event-bus wakeups, timeout. On completion, returns the "Server restart triggered" message.

Callers can alternatively:
```
restart_server({ reason: "..." })     // creates the barrier
await_task({ task_id: "rst-xxxx" })   // waits like any other task
```

### `cancel_task`

Works unchanged. Cancelling the restart task ID lifts the barrier.

### Dashboard

Restart task appears in task lists and status views like any other task. Provider shows as `system`, description shows the reason.

## Edge Cases

### Stale Restart Tasks on Startup

During server init, query for `provider: 'system'` tasks with `status IN ('queued', 'running')`. Cancel them with `error_output: "Server restarted independently — stale restart barrier cleared"`. Prevents a leftover barrier from blocking the queue after an unrelated crash or manual restart.

### Interaction with `isShuttingDown`

The existing `isShuttingDown` flag stays as-is. It gates `processQueue` during actual shutdown (after `emitShutdown`). The barrier task gates it during drain. They don't conflict — barrier operates before shutdown, `isShuttingDown` operates during it.

### Governance

The existing governance rule blocking force-restart when tasks are running becomes unnecessary. Every restart now drains. The governance check can be removed or simplified to logging.

### `stopTaskForRestart`

No longer needed — by the time shutdown fires, running count is already zero. Can be left in place as dead code or removed.

### Multiple Sessions

Two sessions calling `restart_server` — the second gets back the existing restart task ID. Both can `await_task` on the same ID.

### Empty Pipeline Fast Path

If no tasks are running/queued/pending/blocked when `restart_server` is called, the task goes through its full lifecycle instantly (`queued` -> `running` -> `completed` -> shutdown). No drain wait.

## Files Changed

| File | Change |
|------|--------|
| `server/tools.js` | Replace `handleRestartServer` — create barrier task + drain watcher instead of poll loop |
| `server/execution/queue-scheduler.js` | Add barrier query at top of `processQueueInternal` |
| `server/handlers/workflow/await.js` | Simplify `handleAwaitRestart` to create-or-attach + await_task |
| `server/index.js` | Add stale restart task cleanup to startup init |
| `server/tool-defs/core-defs.js` | Update `restart_server` schema (remove `drain`/`drain_timeout_minutes`, add `timeout_minutes`) |
| `server/providers/registry.js` | Register `'system'` category (so `categorizeQueuedTasks` doesn't mark it invalid) |
| `server/tests/restart-drain.test.js` | Rewrite for barrier task behavior |
| `server/tests/restart-server-tool.test.js` | Update for new return shape |
| `server/tests/await-restart.test.js` | Update for wrapper behavior |

## What This Removes

- The `setInterval` drain poll in `handleRestartServer`
- The `drain` / `drain_timeout_minutes` parameters on `restart_server`
- The standalone drain loop in `handleAwaitRestart` (replaced by await_task delegation)
- The governance force-restart guard (no force-restart exists anymore)
