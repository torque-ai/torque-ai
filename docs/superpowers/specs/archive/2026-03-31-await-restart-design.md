# await_restart — Block Until Pipeline Drains, Then Restart

## Problem

`restart_server` with `drain: true` is fire-and-forget. The caller has no way to block until the drain completes — they must manually poll `list_tasks` and `check_notifications` in a loop, burning context tokens and requiring patience. `await_task` and `await_workflow` solved this for tasks; `await_restart` solves it for restarts.

## Design

### Tool Definition

**Name:** `await_restart`
**Location:** Handler in `server/handlers/workflow/await.js`, tool def in `server/tool-defs/core-defs.js`
**Always available:** Added to `CORE_TOOL_NAMES` in `server/core-tools.js` (no unlock needed)

### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout_minutes` | number | 30 | Max wait before giving up (min 1, max 60) |
| `heartbeat_minutes` | number | 5 | Progress snapshot interval, 0 to disable (min 0, max 30) |
| `reason` | string | `"await_restart"` | Restart reason logged and passed to shutdown event |

### Behavior

1. **Count pipeline:** Query running + queued + pending + blocked tasks. If zero, trigger restart immediately (set `process._torqueRestartPending`, emit shutdown) and return final response.

2. **Await loop (`while(true)`):**
   - Create a `Promise` that resolves on:
     - **Event-bus wake:** Listen for `task:completed`, `task:failed`, `task:cancelled` on `taskEvents` — resolves instantly when any task reaches a terminal state
     - **Heartbeat timer:** `setTimeout(heartbeatMs)` — fires at the configured interval
     - **Shutdown signal:** If `__shutdownSignal` is aborted, wake and return
   - On wake, recount pipeline tasks.
   - **If pipeline empty:** Set `process._torqueRestartPending = true`, emit `eventBus.emitShutdown(reason)`, return final "restart imminent" response.
   - **If heartbeat fired and pipeline not empty:** Return heartbeat progress snapshot. Caller re-invokes to continue.
   - **If timeout exceeded:** Return timeout response with remaining task counts. Server is NOT restarted.

3. **Cleanup:** Remove all event listeners on return (same pattern as `handleAwaitWorkflow`).

### Response Formats

**Heartbeat response:**
```
## Restart Drain — Heartbeat #N

| Status | Count |
|--------|-------|
| Running | 3 |
| Queued | 1 |
| Blocked | 12 |

**Elapsed:** 2m 15s / 30m timeout
**Recent:** task-abc (codex, 45s), task-def (ollama, 12s)

Re-invoke `await_restart` to continue waiting.
```

**Final response (drain complete):**
```
## Restart Ready

Pipeline drained in 4m 32s.
Server restart triggered — MCP client will reconnect with fresh code.
Run `/mcp` to force immediate reconnection.
```

**Timeout response:**
```
## Drain Timed Out

Waited 30m — 4 tasks still in pipeline (2 running, 1 queued, 1 blocked).
Server was NOT restarted. Cancel remaining tasks or increase timeout.
```

### Integration Points

| File | Change |
|------|--------|
| `server/handlers/workflow/await.js` | Add `handleAwaitRestart` function, export it |
| `server/tool-defs/core-defs.js` | Add `await_restart` tool definition schema |
| `server/core-tools.js` | Add `'await_restart'` to `CORE_TOOL_NAMES` |
| `server/tool-annotations.js` | Add annotation (readOnly: true, destructive: false) |
| `server/tests/await-restart.test.js` | Unit tests for the handler |

### Interaction With `restart_server`

`await_restart` is standalone — it does NOT require `restart_server drain: true` to be called first. It handles the full lifecycle: wait for pipeline to empty, then trigger restart. This means the typical usage is just:

```
await_restart({ reason: "Apply code changes", timeout_minutes: 15 })
```

No need to call `restart_server` first. If a drain is already in progress from a prior `restart_server` call, `await_restart` will detect the empty pipeline and trigger restart — the two don't conflict since they both just check task counts.

The existing `restart_server` drain mode (`setInterval` poller) continues to work independently for callers that don't use `await_restart`.

### What It Does NOT Do

- Does not cancel tasks — only waits
- Does not survive the actual restart — returns before server shuts down
- Does not block new task submissions — tasks queued during drain will be waited on
- Does not deduplicate with `restart_server` drain — both can coexist safely
