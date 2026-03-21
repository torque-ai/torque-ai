# MCP Elicitation for Approval Gates — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Motivation:** When TORQUE tasks hit approval gates (file size shrink >50%, validation failures, high-risk recovery), the server sets `needs_review: true` and hopes the orchestrating LLM relays the question to the human. This is unreliable. MCP elicitation (spec 2025-06-18) lets the server ask the human directly via a structured form dialog in Claude Code v2.1.76+.

## Approach

**Full Bidirectional Protocol Support + Approval Gate Integration**

1. Add server→client request capability to `mcp-sse.js` (generic, enables elicitation AND future sampling)
2. Create `server/mcp/elicitation.js` helper for clean handler-level API
3. Wire into all three approval gate types with graceful degradation

## Protocol Layer — Bidirectional Request Support

**New function: `sendClientRequest(sessionId, method, params)` in `mcp-sse.js`**

Sends a JSON-RPC request TO the client over the SSE stream, returns a Promise that resolves when the client responds.

```
Server sends (via SSE event):
  { jsonrpc: '2.0', id: 'elicit-abc123', method: 'elicitation/create', params: { ... } }

Client responds (via POST /messages):
  { jsonrpc: '2.0', id: 'elicit-abc123', result: { action: 'accept', content: { approved: true } } }
```

Design decisions:
- Pending requests tracked in `Map<requestId, { resolve, reject, timeout }>` per session
- Request ID prefix `elicit-` is for logging/debugging only — **routing uses Map lookup**, not prefix matching
- 5-minute timeout per elicitation (configurable) — timeout resolves with `{ action: 'cancel' }`
- Response vs request discrimination in POST handler: if parsed message has NO `method` field and has an `id` matching a pending request in the Map → route to `handleClientResponse`. Skip `validateJsonRpcRequest` for responses (they lack `method`).

### Response Routing in POST /messages Handler

Current flow: `parse JSON → validateJsonRpcRequest → handleRequest`. New flow:

```
parse JSON
  → has `method` field? → existing path: validateJsonRpcRequest → handleRequest
  → no `method` field + `id` matches pending request? → handleClientResponse(message, session)
  → neither? → 400 Bad Request
```

### Session Disconnect Cleanup

When an SSE session disconnects (`res.on('close', ...)`), all pending elicitation Promises for that session are resolved with `{ action: 'cancel' }` (not rejected). This matches the timeout behavior so consumer code doesn't need separate error handling.

## Capability Negotiation

**Requires `mcp-protocol.js` signature change:** Currently `_onInitialize(session)` — change to `_onInitialize(session, params)` so capabilities can be captured.

In the `initialize` handler:

```js
case 'initialize': {
  // Capture client capabilities for elicitation/sampling support
  session.clientCapabilities = params?.capabilities || {};
  session.supportsElicitation = Boolean(params?.capabilities?.elicitation);

  const response = { ... };
  if (_onInitialize) _onInitialize(session, params);  // <-- params added
  return response;
}
```

The `init()` function contract and all `onInitialize` callbacks in `mcp-sse.js` and `index.js` must be updated to accept the extra `params` argument (ignored if not needed).

## Session-to-Task Linkage

**Problem:** The finalization pipeline (`task-finalizer.js`, `safeguard-gates.js`, `auto-verify-retry.js`) has no reference to the MCP session that submitted the task. `elicit()` needs a session to send requests to.

**Solution:** Store `session_id` on task at submission time, look up live session at elicitation time.

1. At task submission (`handleSubmitTask` in `task/core.js`): if the call came through an MCP session, store `session.__sessionId` in task metadata as `mcp_session_id`
2. `elicit()` helper accepts either a session object OR a `session_id` string. If given a string, it looks up the live session from the SSE sessions Map (exported from `mcp-sse.js`)
3. If the session is no longer connected (user closed Claude Code), `elicit()` returns `{ action: 'decline' }` — falls back to existing behavior

This avoids threading sessions through the entire finalization pipeline. The pipeline only needs the task's `mcp_session_id` from metadata.

## Elicitation Helper

**New file: `server/mcp/elicitation.js`**

```js
const response = await elicit(sessionOrId, {
  message: 'Task output shrank by 62%. Approve the changes?',
  requestedSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['approve', 'reject', 'rollback'] },
    },
    required: ['decision'],
  },
});
// response = { action: 'accept'|'decline'|'cancel', content: { decision: '...' } }
```

Behavior:
- `elicit(sessionOrId, params)` → Promise resolving `{ action, content }`
- Accepts session object OR session_id string (looks up live session from Map)
- If session lacks elicitation capability → `{ action: 'decline' }`
- If no session / session disconnected → `{ action: 'decline' }`
- On timeout (5 min) → `{ action: 'cancel' }`
- `requestedSchema` supports only primitive types (string, number, boolean) per MCP spec

## Approval Gate Integration

Three integration points. All follow the same pattern: call `elicit()`, use the decision if accepted, fall back to existing behavior otherwise.

**Pipeline blocking acknowledgment:** `elicit()` with a 5-minute timeout blocks the finalization pipeline for that task while waiting for the human. The finalization lock is held during this time. This is acceptable — approval gates are rare (only triggered by anomalies), and the timeout bounds the maximum block duration.

### A) File Size Shrink (>50%)

**Location:** `server/validation/safeguard-gates.js` and/or `server/execution/strategic-review-stage.js` — where `file_size_delta_pct` is checked and `needs_review` is set.

The exact insertion point is where `metadata.needs_review = true` is set due to file size regression. Before setting the flag, call `elicit()` using `metadata.mcp_session_id`.

### B) Validation Failures (stubs, truncation, syntax)

**Location:** `server/validation/auto-verify-retry.js` — where verify_command failures are handled.

Before submitting a fix task or marking as failed, call `elicit()`.

### C) High-Risk Peek Recovery

**Location:** `server/handlers/peek/recovery.js` — where `requireHighRiskApproval` gates recovery actions.

This handler already has the MCP session available (it's called directly from a tool handler). Wire `elicit(session, ...)` directly.

### Graceful Degradation

Every elicitation call falls back to existing behavior if:
- No MCP session available (REST API, dashboard, headless mode)
- Client doesn't support elicitation (capability not declared)
- Session disconnected since task submission
- Timeout (5 minutes)
- User declines or cancels

The existing approval system (`needs_review`, `approve_task`/`reject_task` tools) remains fully functional.

## Architecture

### Files

| File | Action | Purpose |
|------|--------|---------|
| `server/mcp-sse.js` | **Modify** | `sendClientRequest()`, pending request Map, response routing in POST handler, disconnect cleanup |
| `server/mcp-protocol.js` | **Modify** | `onInitialize(session, params)` signature, capture client capabilities, `handleClientResponse()` |
| `server/mcp/elicitation.js` | **New** | `elicit(sessionOrId, params)` helper |
| `server/handlers/task/core.js` | **Modify** | Store `mcp_session_id` in task metadata at submission |
| `server/validation/safeguard-gates.js` | **Modify** | Wire elicitation into file-size-shrink gate |
| `server/execution/strategic-review-stage.js` | **Modify** | Wire elicitation into review decision |
| `server/validation/auto-verify-retry.js` | **Modify** | Wire elicitation into validation failure gate |
| `server/handlers/peek/recovery.js` | **Modify** | Wire elicitation into high-risk recovery gate |
| `server/tests/elicitation.test.js` | **New** | Unit + integration tests |

## Testing

### Unit Tests — elicitation.js
- Returns `{ action: 'decline' }` when session lacks elicitation capability
- Returns `{ action: 'decline' }` when no session / disconnected session
- Returns `{ action: 'cancel' }` on timeout
- Sends correct JSON-RPC request structure via mock transport
- Resolves correctly when client accepts with content

### Unit Tests — protocol layer
- `sendClientRequest` sends correctly formatted JSON-RPC request
- `handleClientResponse` resolves matching pending request Promise
- Ignores responses with no matching pending request (no crash on garbage IDs)
- Pending requests resolved with `{ action: 'cancel' }` on session disconnect
- Concurrent elicitations to same session both resolve correctly
- Timeout race: response arriving just before timeout doesn't double-resolve
- Initialize with `{ capabilities: { elicitation: {} } }` → `supportsElicitation = true`
- Initialize without capability → `supportsElicitation = false`

### Integration Tests — approval gates
- File size shrink gate calls `elicit()`, proceeds on approve, rolls back on rollback
- Falls back to `needs_review` when elicitation not available
- Validation failure gate calls `elicit()`, marks task failed on reject
- Peek recovery gate calls `elicit()`, blocks action on reject

### Not Tested
- End-to-end with live Claude Code (requires real MCP session)
- Stdio transport elicitation (SSE only for now)

## Non-Goals

- No sampling support (same bidirectional protocol — easy to add later)
- No stdio transport elicitation (SSE only)
- No dashboard UI for elicitation
- No changes to existing `approve_task`/`reject_task` tools
- No per-gate-type custom schemas (all use approve/reject/rollback enum)
- No protocol version bump (elicitation is additive, detected by capability)
