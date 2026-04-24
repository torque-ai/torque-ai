# MCP restart resilience — design

**Date:** 2026-04-23
**Scope:** Two small server-side changes to `server/mcp-sse.js` and `server/transports/sse/session.js` that make the TORQUE MCP SSE transport more resilient across a server restart, without requiring changes to Claude Code's MCP client.
**Status:** Draft, pending user review.

## Context

Every TORQUE restart — whether triggered by `scripts/worktree-cutover.sh`, an explicit `restart_server` barrier task, or an external stop/start — breaks the SSE connection between TORQUE and Claude Code. The client does not auto-reconnect; the user has to run `/mcp` manually. When two Claude sessions are active and one restarts the server, the other session's MCP tool list goes dead until the user notices and reconnects.

The underlying behavior is legitimate: node exits, the SSE TCP stream closes, and a new process starts listening. But the server currently:

- Closes each SSE stream with a bare `session.res.end()` — no protocol-level hint, no SSE `retry:` directive, no MCP notification.
- Drops all session state from memory on shutdown via `clearAllSessionState()`. Only sessions that explicitly called `subscribe_task_events` are in the `task_event_subscriptions` DB table; other sessions are gone entirely.

Most of the resume machinery already exists — `restoreSubscription` is invoked at `mcp-sse.js:449` for any fresh connection that presents a known sessionId, and `task_event_subscriptions` has a 24h TTL. The gap is that shutdown doesn't fully populate this table.

## Goals

1. On graceful shutdown, emit a client-agnostic reconnect hint to every SSE session before closing.
2. On graceful shutdown, persist enough session metadata that any client presenting the same `sessionId` within 24h gets its filter/subscription state restored.

## Non-goals

- No reverse proxy or SSE-buffering front-end.
- No changes to Claude Code's MCP client. This spec is server-side only. If Anthropic later ships SSE auto-reconnect, this work is what it will land on.
- No persistence of the in-memory `pendingEvents` queue. Task-level events are already durable in `task_events`; a client that cares about events missed during the restart window can reconcile via the normal task-query path (`await_task`, `task_info`, etc.) — this is the authoritative source and is already filter-aware.
- No per-session `lastEventId` tracking or event replay baseline. The global `eventIdCounter` in `session.js` is shared across all sessions; adding per-session tracking would require modifying every notification send site. Out of scope for this round.
- No change to the 24h subscription TTL.
- No change to authentication. The existing reconnect-auth check at `mcp-sse.js:366` is untouched.
- No new schema columns. One in-place constraint drop (below) is required to unblock the persistence path.

## Schema note — FK drop on `task_event_subscriptions.task_id`

Implementation surfaced a pre-existing latent bug: `task_event_subscriptions.task_id` is declared as `FOREIGN KEY REFERENCES tasks(id)`, but `persistSubscription` at `server/transports/sse/session.js:590` writes `JSON.stringify([...session.taskFilter])` — a JSON array string — into that column. With `foreign_keys = ON` (active per `database.js:611`), any attempt to persist a session with a populated `taskFilter` fails silently (the try/catch at `session.js:601-603` swallows the FK violation). The existing feature has been effectively broken for every non-empty subscription since the FK was added; nothing caught it because the error was swallowed and no code path validates that the write succeeded.

To unblock this spec, drop the FK. The column is a JSON array of task IDs, not a scalar — the FK was never correct. The migration rebuilds the table in place without the FK and preserves the two existing indexes. The fresh-install CREATE TABLE in `schema-tables.js` is updated in lockstep.

## Architecture

Two call sites change. No schema change.

```
   graceful shutdown                         fresh SSE connect
   ─────────────────                         ──────────────────
   mcp-sse.js:stop()                         mcp-sse.js:handleSseConnection()
        │                                          │
        │  1. send MCP `notifications/message`     │  1. existingSession? reattach, done
        │     {type: "server_restarting",          │  2. fresh session + known sessionId?
        │      retry_after_ms: 2000}               │     → restoreSubscription(sessionId)   ← existing
        │     to every session                     │       restores eventFilter, taskFilter
        │                                          │
        │  2. write raw SSE `retry: 2000\n\n`      │
        │     to every session                     │
        │                                          │
        │  3. persistSubscription for every        │
        │     session in `sessions`                │  ← new shutdown-time call
        │                                          │
        │  4. session.res.end() (existing)         │
```

## Components

### 1. Shutdown hint emission — `mcp-sse.js:stop()`

Before the existing `session.res.end()` in the shutdown loop, add two writes:

```js
// MCP protocol-level hint — any compliant client can surface this
sendJsonRpcNotification(session, 'notifications/message', {
  level: 'info',
  logger: 'torque',
  data: { type: 'server_restarting', retry_after_ms: 2000 },
});

// Native EventSource reconnect directive — honored by browser EventSource,
// no-op for clients that ignore it
if (session.res && !session.res.writableEnded) {
  try { session.res.write('retry: 2000\n\n'); } catch {}
}
```

The `sendJsonRpcNotification` helper already exists at `mcp-sse.js:~209`. We do not need a new wire format.

### 2. Per-session persistence on shutdown — call `persistSubscription` in `mcp-sse.js:stop()`

The existing `persistSubscription` already writes the row unconditionally once its "owned session" guard passes, and the guard holds for every session in the live `sessions` map during shutdown (we iterate before `clearAllSessionState()`). Default `eventFilter = {completed, failed}` is set at session creation, so sessions that never called `subscribe_task_events` still have a writable row.

No new helper is needed. The mcp-sse.js shutdown loop becomes:

```js
for (const [id, session] of sessions) {
  clearTrackedInterval(session.keepaliveTimer);
  try {
    sessionMod.persistSubscription(id, session);
  } catch { /* non-fatal */ }
  // ...existing hint writes + res.end()
}
```

## Data flow

**Shutdown path:**
1. `stop()` is entered (SIGTERM, `restart_server` barrier, `gracefulShutdown('cutover')`, etc.).
2. For each session: send `notifications/message`, write `retry: 2000\n\n`, persist via `persistSessionOnShutdown`, call `res.end()`.
3. Process exits.

**Reconnect path (unchanged):**
1. New process starts, loads DB connection (startup reconcilers already run).
2. Client hits `GET /sse?sessionId=<old>`.
3. `handleSseConnection` finds no `existingSession` (memory was wiped), falls through to `restoreSubscription(sessionId)`.
4. If a non-expired row exists, eventFilter and taskFilter are attached to the new session object. Client resumes with the same filters it had before the restart.

## Error handling

- All new persistence calls are wrapped in try/catch with non-fatal logging. A DB failure during shutdown must not block `res.end()` or process exit.
- The MCP `notifications/message` write is best-effort — if the client socket is already half-closed, the caught error is swallowed.
- The `retry:` directive is written on its own line with the usual `\n\n` terminator, matching the SSE spec. No escaping concerns; it's a server-generated literal.

## Testing

Two unit tests, added to existing `server/tests/mcp-sse.test.js` harness:

1. **Shutdown hint emitted**: stub `session.res.write`, call `stop()`, assert that both the `notifications/message` JSON-RPC frame and a `retry: 2000\n\n` directive were written before `res.end()`.
2. **Shutdown persistence writes all sessions**: create 3 sessions (one with filters, one with a task subscription, one with neither), call `stop()`, assert all 3 rows exist in `task_event_subscriptions` after shutdown.

No integration test is needed beyond these; the restart barrier is already well-tested in `cutover-barrier-integration.test.js`, and this work doesn't touch the barrier path. Subscription restoration on reconnect is already covered by existing `restoreSubscription` tests — this spec only broadens what writes into the table, not how it's read.

## Rollout

- No config flag. This is strictly additive — shutdown writes more rows; reconnect behavior is unchanged. Neither can break an existing client that doesn't present a sessionId.
- No changes to `scripts/worktree-cutover.sh` or the restart barrier mechanism itself.
- One in-place FK-drop migration on `task_event_subscriptions` (see "Schema note" above); additive otherwise. The migration is idempotent — the FK pre-check early-returns on fresh installs and on already-migrated DBs.
