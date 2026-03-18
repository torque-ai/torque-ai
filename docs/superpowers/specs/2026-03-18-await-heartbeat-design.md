# Await Heartbeat — Periodic Progress Check-ins

**Date:** 2026-03-18
**Status:** Draft

## Problem

`await_task` and `await_workflow` block silently until a task completes or times out. Tasks commonly take 5-10 minutes. During that time, the user sees nothing — no progress, no status, no indication that anything is happening. This creates a poor experience and prevents Claude from making autonomous decisions (cancelling stalled tasks, resubmitting, informing the user) while waiting.

## Solution

Add **heartbeat yields** to both await tools. The tool returns periodically with a progress snapshot even when no task has completed. Claude reads the heartbeat, updates the user, optionally takes action (cancel, resubmit), and re-invokes to continue waiting. Notable events (task started, stall warning, retry, fallback) trigger an immediate heartbeat regardless of the timer.

## Design Decisions

- **Approach:** Heartbeat return pattern — the await tool returns from the MCP call with a heartbeat response. Claude processes it and re-invokes. This works within the existing MCP tool-call contract with no protocol changes.
- **Behavior model:** Inform + act (Claude can autonomously cancel/resubmit based on heartbeat data) with escalation to user when Claude genuinely needs human input.
- **Interval:** Fixed timer (default 5 minutes) plus immediate return on notable events.
- **Partial output:** Included when available. DB-backed with throttled writes (10s flush interval). Survives server restarts.
- **Phased delivery:** Heartbeat infrastructure first (Phase 1), partial output capture per-provider second (Phase 2). Heartbeats are valuable even without partial output.

## New Parameter

Both `await_task` and `await_workflow` gain one new parameter:

| Parameter | Type | Default | Min | Max | Description |
|-----------|------|---------|-----|-----|-------------|
| `heartbeat_minutes` | number | 5 | 0 | 30 | Minutes between scheduled heartbeats. 0 disables heartbeats (legacy behavior). Values 1-30 set the interval. |

All existing parameters are unchanged.

## Response Types

Await tools can now return five kinds of responses:

| Type | Trigger | Content |
|------|---------|---------|
| `task_completed` / `task_failed` | Terminal event | Full task output (unchanged from today) |
| `workflow_complete` | All workflow tasks done | Full summary + verify/commit (unchanged from today) |
| `heartbeat` | Timer or notable event | Progress snapshot with partial output |
| `timeout` | Timeout exceeded | Timeout error (unchanged from today) |
| `shutdown` | Server shutting down | Shutdown message (unchanged from today) |

## Heartbeat Response Format

```
## Heartbeat — Await Task [task-id]

**Reason:** scheduled | task_started | stall_warning | task_retried | provider_fallback
**Elapsed:** 4m 32s
**Tasks:** 2 completed, 0 failed, 1 running, 3 pending

### Running Tasks
| Task | Provider | Host | Elapsed | Description |
|------|----------|------|---------|-------------|
| abc123 | codex | cloud | 4m 32s | Write unit tests for... |

### Partial Output (last 1500 chars)
<captured stdout or "No output captured yet (provider buffers until completion)">

### Alerts
- Approaching stall threshold (144s / 180s) — consider cancelling if no progress

### Action
Re-invoke await_task to continue waiting, or take action (cancel, resubmit, etc.)
```

For `await_workflow`, heartbeats additionally include:
- Workflow progress table (completed/failed/running/pending counts)
- Next-up tasks (pending tasks that will run once a slot opens)

### Heartbeat Reason Name Mapping

Event bus names map to heartbeat reason strings as follows:

| Event Bus Name | Heartbeat Reason String |
|----------------|------------------------|
| `task:started` | `task_started` |
| `task:stall_warning` | `stall_warning` |
| `task:retry` | `task_retried` |
| `task:fallback` | `provider_fallback` |
| (timer) | `scheduled` |

### Size Budget

Heartbeats stay under ~3000 characters total. Partial output capped at 1500 chars. Metadata sections are compact. Target ~800-1000 tokens per heartbeat.

## Notable Events

Four **non-terminal** events trigger immediate heartbeat returns:

| Event | Emitted When | Source | Currently Exists? |
|-------|-------------|--------|-------------------|
| `task:started` | Task moves from queued to running | Queue processor / task-manager.js | No |
| `task:stall_warning` | Task reaches 80% of provider stall threshold | Stall detection loop (new pre-threshold check) | No |
| `task:retry` | Auto-retry kicks in, new attempt started | event-dispatch.js | Yes (reclassified as non-terminal) |
| `task:fallback` | Task rerouted to a different provider | fallback-retry.js | No |

**Emission points for new events:**
- `task:started` — emitted from task-manager.js (or database.js) when task status transitions to `running` and `started_at` is set
- `task:stall_warning` — new logic in stall-detection.js: on each stall check iteration, if elapsed time >= 80% of threshold but task is not yet stalled, emit warning (once per task, tracked via a Set)
- `task:fallback` — emitted from fallback-retry.js when `tryOllamaCloudFallback` or related reroute functions reassign a task

**Event filtering for `await_task`:** Notable event listeners filter by `task_id`, matching the existing behavior for terminal events. An unrelated task's `task:started` event does not trigger a heartbeat return. Because `task:started` and `task:fallback` go through `dispatchTaskEvent` (listener receives a task record with `.id`), while `task:stall_warning` emits directly (listener receives `{ taskId, ... }`), the filter must handle both shapes: `const eventTaskId = payload?.id || payload?.taskId`.

**Debounce for `await_workflow`:** When a workflow has multiple running tasks, rapid-fire notable events (e.g., 5 tasks start in succession) are coalesced. After the first notable event triggers a return, the handler collects any additional notable events from the same DB query cycle and includes them all in one heartbeat. On re-invocation, the handler checks current state from DB — it does not replay missed events.

### Not Included

Queue position changes — low signal, high noise.

## Partial Output Capture

### Phased Delivery

**Phase 1 (this spec):** Heartbeat infrastructure, notable events, scheduled heartbeats. Partial output field exists but may be NULL for all providers initially. Heartbeats say "No output captured yet" when NULL.

**Phase 2 (follow-up):** Instrument each streaming provider to write partial output. Provider-by-provider rollout: ollama first (simplest HTTP streaming), then aider-ollama, then cloud API providers.

### Provider Capabilities

| Provider | Streams During Execution? | Mechanism | Phase |
|----------|--------------------------|-----------|-------|
| ollama / hashline-ollama | Yes | HTTP streaming chunks | Phase 2a |
| aider-ollama | Yes | Process stdout pipe | Phase 2b |
| codex | No | Sandbox buffers until exit | N/A (always NULL) |
| claude-cli | No | CLI subprocess buffers | N/A (always NULL) |
| Cloud API (deepinfra, etc.) | Yes | SSE / chunked HTTP | Phase 2c |

### Storage

- Add `partial_output` TEXT column on the `tasks` table
- Streaming providers flush in-memory buffer to DB every 10 seconds (throttled)
- **In-memory buffer cap:** 32 KB per task. Ring buffer — oldest content is discarded at newline boundaries when cap is exceeded (preserves line integrity, avoids splitting UTF-8 characters). DB stores only the latest 32 KB window, not full accumulated output. Heartbeats display the **last 1500 characters** of this buffer (`buffer.slice(-1500)`).
- Buffered providers leave it NULL — heartbeat says "No output captured yet"
- Column cleared (set to NULL) when full output is written on task completion
- Survives server restarts — existing partial output in DB is immediately available for heartbeats

### Write Path

```
streaming chunk arrives → append to in-memory ring buffer (32 KB cap) → every 10s, flush buffer to tasks.partial_output
```

### Read Path

Heartbeat handler reads partial output via `SELECT partial_output FROM tasks WHERE id = ?`. This may be up to 10 seconds stale relative to the in-memory buffer. This staleness is acceptable — heartbeats fire every 5 minutes, so 10-second lag is imperceptible.

### Server Restart Behavior

On server restart, TORQUE does **not** re-attach to previously-running provider streams (subprocess pipes are lost, HTTP connections are dropped). Previously-running tasks retain whatever was flushed to DB before the restart. New partial output capture resumes only when the provider reconnects or the task is resubmitted. The DB-backed partial output ensures heartbeats can still report the last-known output.

## Await Handler Flow (Updated)

### await_task

```
handleAwaitTask(args):
  1. Parse params (existing + heartbeat_minutes)
  2. Load task from DB
  3. If already terminal → return completion result (unchanged)
  4. If heartbeat_minutes == 0 → use existing flow (no heartbeat, unchanged)
  5. Enter wait loop:

     Set up listeners:
       - Terminal events: task:completed, task:failed, task:cancelled, task:skipped
       - Notable events: task:started, task:stall_warning, task:retry, task:fallback
         (all filtered by task_id — only events for the awaited task)
       - Heartbeat timer: setTimeout(min(heartbeat_ms, remaining_timeout_ms))
       - Timeout timer: setTimeout(timeout_minutes * 60 * 1000)
       - Shutdown signal

     Wait for first signal...

     On terminal event → return completion result (unchanged from today)
     On notable event  → return heartbeat (reason: mapped event name, include partial output)
     On heartbeat timer → return heartbeat (reason: "scheduled", include partial output)
     On timeout → return timeout error (unchanged from today)
     On shutdown → return shutdown message (unchanged from today)

     Clean up all listeners before returning.
```

### await_workflow

Same pattern, with these differences:
- Heartbeats include all running tasks' progress, not just one
- Task completion triggers immediate return as a **task yield** (existing behavior)
- Heartbeats only fire when no tasks have completed during the interval
- Notable events for any task in the workflow trigger a return (no per-task filtering)
- Debounce: on notable event wakeup, query DB for all current workflow state and coalesce
- Priority order: task yield > notable event > scheduled heartbeat > timeout
- `acknowledged_tasks` persisted in workflow context (unchanged from today)

### Signal Priority

When multiple signals fire near-simultaneously, the first to call `done()` wins (race semantics, matching existing implementation). The priority order below is **advisory** — it describes the desired outcome, not a deterministic enforcement mechanism. In practice, terminal events and notable events fire from the event bus (microsecond dispatch) while timers fire from the event loop (millisecond resolution), so the natural race order matches the desired priority:

1. Terminal event / task yield (most informative)
2. Notable event
3. Scheduled heartbeat
4. Timeout
5. Shutdown

If two signals genuinely tie, either outcome is acceptable — the next invocation re-reads DB state regardless.

### Terminal Event Note

`task:timeout` is not a separate terminal event. When a task times out, its status is set to `cancelled`, and the `task:cancelled` listener catches it. This is the existing behavior and is preserved.

### Heartbeat Timer Clamping

The heartbeat timer is set to `min(heartbeat_minutes * 60000, remaining_timeout_ms)`. This prevents a heartbeat from firing after the timeout has already expired. If `heartbeat_minutes >= timeout_minutes`, the timeout fires first and no heartbeat is ever returned.

### Re-invocation Safety

- If a task completes during the brief gap (~1-2s) between heartbeat return and Claude re-invoking, the next invocation catches it immediately at step 3 (already terminal)
- `await_task` is stateless across invocations — no persistence needed
- `await_workflow` persists `acknowledged_tasks` in workflow context (unchanged)
- **Events between invocations are not replayed.** Notable events that fire during the re-invocation gap are not captured. This is by design — the next invocation reads current state from DB, which reflects the result of those events. For example, if `task:started` fires during the gap, the next heartbeat will show that task as "running" via the DB query. The event itself is not needed.

## Event Bus Changes

### Event Classification

```javascript
// Terminal events (trigger completion return):
// task:completed, task:failed, task:cancelled, task:skipped

// Non-terminal events (trigger heartbeat return):
// task:started, task:stall_warning, task:retry, task:fallback
```

Note: `task:retry` was previously grouped with terminal events in code comments. It is non-terminal — the task continues after being resubmitted. This reclassification is a correction.

### New Events

New events use `dispatchTaskEvent` where a full task record is available (task:started, task:fallback — both have access to the task row). For `task:stall_warning`, which originates in the stall detection loop without a full task record, emit directly on `taskEvents` with a lightweight payload:

```javascript
// task:started — emitted via dispatchTaskEvent (has full task record)
dispatchTaskEvent('started', taskRecord);

// task:fallback — emitted via dispatchTaskEvent (has full task record)
dispatchTaskEvent('fallback', taskRecord);

// task:stall_warning — emitted directly (stall loop has limited context)
taskEvents.emit('task:stall_warning', {
  taskId, provider, elapsed, threshold, description
});
```

All events are non-fatal — errors are logged but never block task execution.

### Stall Warning Deduplication

The stall detection loop emits `task:stall_warning` at most **once per task** per stall cycle. Tracked via an in-memory `Set<taskId>` that is cleared when the task transitions to a terminal state or is resubmitted.

## Database Changes

### tasks table

Add column:
```sql
ALTER TABLE tasks ADD COLUMN partial_output TEXT DEFAULT NULL;
```

### task_events table

No schema changes. New event types (`started`, `stall_warning`, `fallback`) are stored as string values in the existing `event_type` column.

## Tool Definition Changes

### workflow-defs.js

Add `heartbeat_minutes` to both `await_task` and `await_workflow` parameter schemas:

```javascript
heartbeat_minutes: {
  type: 'number',
  description: 'Minutes between scheduled progress heartbeats. Default 5. Set to 0 to disable.',
  default: 5
}
```

## Backward Compatibility

- `heartbeat_minutes: 0` disables heartbeats entirely, restoring legacy behavior
- Default of 5 means existing callers get heartbeats automatically — this is intentional (the whole point is better UX by default)
- Completion/timeout/shutdown responses are unchanged in format
- No changes to `check_notifications`, `subscribe_task_events`, or `ack_notification`

## Testing Strategy

- Unit tests for heartbeat timer firing and returning heartbeat response
- Unit tests for each notable event triggering immediate heartbeat
- Unit tests for signal priority (terminal > notable > scheduled)
- Unit tests for heartbeat_minutes=0 disabling heartbeats (legacy path)
- Unit tests for heartbeat timer clamping (heartbeat_minutes >= timeout_minutes)
- Unit tests for re-invocation safety (task completes during gap)
- Unit tests for stall warning deduplication (only fires once per task)
- Unit tests for await_workflow debounce (multiple notable events coalesced)
- Unit tests for partial output inclusion (streaming provider vs buffered / NULL)
- Unit tests for task_id filtering on notable events (await_task ignores unrelated tasks)
- Integration test: submit task, await with heartbeat, verify heartbeat fires before completion
- Integration test: workflow with multiple tasks, verify heartbeats include all running tasks
- Integration test: partial output appears in heartbeat for streaming provider (Phase 2)
