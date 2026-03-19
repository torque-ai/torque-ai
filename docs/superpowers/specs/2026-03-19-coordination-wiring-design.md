# Coordination Wiring — Connect Task Lifecycle to Governance Tables

**Date:** 2026-03-19
**Status:** Draft

## Problem

TORQUE has a fully implemented coordination layer (agents, claims, events, approvals, schedules) with database tables, API endpoints, and dashboard pages. But the normal task flow — `submit_task → queue → slot-pull-scheduler → provider → completion` — bypasses all of it. The coordination dashboard shows empty tables. The approval system never blocks tasks. The event log is mostly empty.

The infrastructure works (verified by tests and API endpoints returning correct empty results). It's just never called from the hot path.

## Solution

Wire the existing coordination infrastructure into the normal task lifecycle at three integration points:

1. **Auto-register MCP sessions as agents** — sessions appear in the coordination dashboard automatically
2. **Auto-create claims and record events** — task execution populates coordination tables
3. **Wire approval checks into task submission** — approval rules are evaluated, tasks are blocked when rules match

## Design Decisions

- **Zero manual setup for coordination visibility.** Sessions auto-register, claims auto-create, events auto-record. The dashboard populates itself.
- **Approvals are opt-in.** Template rules ship disabled. Users toggle on what they want. No surprise blocking.
- **Auto-approve timeout is configurable and disableable.** Teams that require explicit approval set `auto_approve_after_minutes` to null. Exposed in dashboard.
- **All writes are non-fatal.** Coordination table writes never block task execution. If a coordination write fails, the task proceeds.

## 1. Auto-Register MCP Sessions as Agents

### Trigger

In `server/mcp-sse.js`, when a new SSE session is established (the `/sse` endpoint handler).

### Agent Record

| Field | Value | Source |
|-------|-------|--------|
| `id` | SSE session ID | Already generated in mcp-sse.js |
| `name` | `"claude-code@unknown"` initially, updated to `"claude-code@<project>"` on first tool call with `working_directory` | Lazy update |
| `agent_type` | `"mcp-session"` | Static |
| `capabilities` | `["submit", "await", "workflow"]` | Static |
| `max_concurrent` | `10` | Informational — one session can submit many concurrent tasks via workflows |
| `status` | `"online"` on connect, `"offline"` on disconnect | Lifecycle |
| `metadata` | `{ claude_code_version, connected_at, transport: "sse" }` | From SSE handshake |

### Lifecycle

- **SSE connect** → `db.registerAgent({ ... })` + record `session_connected` coordination event
- **First tool call with `working_directory`** → update agent name to `"claude-code@<project_name>"`. The name update is triggered in `mcp-sse.js` before calling `handleToolCall`, using a `session.nameUpdated` flag to avoid re-checking on every subsequent call.
- **SSE disconnect** → update agent status to `"offline"` + record `session_disconnected` coordination event
- **Server startup** → sweep all agents, set any with status `"online"` to `"offline"` (no SSE sessions survive a restart)
- **Cleanup** — offline agents older than 7 days are removed by existing maintenance. Agent records persist after disconnect for historical visibility.

### Non-fatal

Agent registration is wrapped in try/catch. If it fails, the SSE session still works — coordination is additive, not required.

## 2. Wire Task Lifecycle to Coordination

### A. Session-to-Task Association

In `submit_task` / `smart_submit_task` handlers, store the SSE session ID in task metadata:

```javascript
metadata.submitted_by_agent = sessionId;
```

**Threading the session ID to handlers:** The session ID is not currently passed to `handleToolCall`. To make it available, inject it into the args object following the existing `__shutdownSignal` pattern.

**Note:** Another session is actively implementing `docs/superpowers/plans/2026-03-19-architecture-phase-1-transport-unification.md`, which extracts shared MCP protocol logic into `mcp-protocol.js`. After that refactor, the tool call flow becomes `mcp-protocol.handleRequest → SSE callback → handleToolCall`. The `__sessionId` injection should happen in the SSE-specific callback passed to `mcpProtocol.init()`:

```javascript
// In mcp-sse.js, in the SSE callback to mcpProtocol.init():
handleToolCall: async (name, args, session) => {
  const argsWithSignal = { ...args, __shutdownSignal: shutdownAbort.signal, __sessionId: session.id };
  return handleToolCall(name, argsWithSignal);
}
```

The `session` object is already passed by `mcp-protocol.js` to the callback — we just add `__sessionId` alongside the existing `__shutdownSignal`. If the transport unification is not yet merged when this spec is implemented, use the pre-refactor injection point instead (directly in `handleMcpRequest` before calling `handleToolCall`).

Handlers that need the session ID read it from `args.__sessionId`. Minimal cross-cutting impact, no signature changes to the 489 tool handlers.

If the task is submitted via REST API (no session), `__sessionId` is undefined — claims are skipped for sessionless tasks.

### B. Task Claims at Execution Start

In `slot-pull-scheduler.js`, when a task is picked up and assigned to a provider:

```javascript
const agentId = task.metadata?.submitted_by_agent;
if (agentId) {
  try {
    // Verify agent exists before claiming (agent registration may have failed)
    const agent = db.getAgent ? db.getAgent(agentId) : null;
    if (agent) {
      db.claimTask(taskId, agentId, 600); // 10-minute lease
    }
  } catch (e) {
    // Non-fatal
  }
}
```

**Lease duration:** 600 seconds (10 minutes). Renewed by the coordination scheduler loop. Released on terminal status.

**Claim release:** In `completion-pipeline.js`, after task reaches terminal state. The `listClaims` function needs a `task_id` filter added (it currently supports `agent_id`, `status`, `include_expired`, `limit` but not `task_id`). Add `task_id` as an optional filter parameter:

```javascript
try {
  const claims = db.listClaims({ task_id: taskId, status: 'active' });
  for (const claim of claims) {
    db.releaseTaskClaim(claim.id);
  }
} catch (e) {
  // Non-fatal
}
```

**Required change to `coordination.js`:** Extend `listClaims` to accept a `task_id` filter in the WHERE clause. This is a 2-line addition to the existing SQL query builder.

### C. Coordination Events

Hook into `dispatchTaskEvent` in `server/hooks/event-dispatch.js`. After the existing emission (event bus + task_events table + SSE push), also write to `coordination_events`.

**Function signature:** `recordCoordinationEvent(eventType, agentId, taskId, details)` takes four positional arguments (not an options object):

```javascript
try {
  const agentId = task.metadata?.submitted_by_agent || null;
  db.recordCoordinationEvent(
    eventName,                    // 'completed', 'failed', etc.
    agentId,                      // session that submitted the task
    task.id,                      // task ID
    JSON.stringify({ status: task.status, exit_code: task.exit_code, provider: task.provider })
  );
} catch (e) {
  // Non-fatal
}
```

**Event name mapping:** `dispatchTaskEvent` is called with bare names (`'completed'`, `'failed'`). The coordination event uses the same bare names — no `task_` prefix needed. Session events (`session_connected`, `session_disconnected`) are recorded directly in `mcp-sse.js`, not via `dispatchTaskEvent`.

**Events recorded automatically:**

| Event | Trigger Point | Recorded In |
|-------|--------------|-------------|
| `session_connected` | SSE session established | mcp-sse.js |
| `session_disconnected` | SSE session closed | mcp-sse.js |
| `task_submitted` | submit_task / smart_submit_task handler | task handler |
| `task_claimed` | slot-pull-scheduler assigns task | slot-pull-scheduler.js |
| `completed` | dispatchTaskEvent('completed') | event-dispatch.js |
| `failed` | dispatchTaskEvent('failed') | event-dispatch.js |
| `cancelled` | dispatchTaskEvent('cancelled') | event-dispatch.js |
| `retry` | dispatchTaskEvent('retry') | event-dispatch.js |
| `fallback` | dispatchTaskEvent('fallback') | event-dispatch.js |
| `approval_requested` | checkApprovalRequired matches a rule | task handler |
| `approval_decided` | approveTask / rejectApproval called | approval handler |

### Lease Renewal

The existing coordination scheduler loop (runs every 30 seconds in `index.js`, line ~948, already calls `expireStaleLeases()`) is extended to also renew active claims for running tasks:

```javascript
// In the coordination scheduler, after expireStaleLeases()
try {
  const activeClaims = db.listClaims({ status: 'active' });
  for (const claim of activeClaims) {
    const task = db.getTask(claim.task_id);
    if (task && task.status === 'running') {
      db.renewLease(claim.id, 600); // Extend 10 more minutes
    }
  }
} catch (e) {
  // Non-fatal
}
```

## 3. Wire Approvals into Task Submission

### Approval Check at Submission

In the task submission handler, after the task is created but before it enters the queue. The existing `checkApprovalRequired()` function already creates the `approval_requests` row and sets `approval_status = 'pending'` on the task inside a transaction — we only need to call it and record the coordination event:

```javascript
try {
  const approvalResult = db.checkApprovalRequired(task);
  if (approvalResult && approvalResult.required) {
    // checkApprovalRequired already set approval_status and created the request
    // Just record the coordination event
    db.recordCoordinationEvent(
      'approval_requested',
      args.__sessionId || null,
      taskId,
      JSON.stringify({ rule_id: approvalResult.rule_id })
    );
  }
} catch (e) {
  // Non-fatal — if approval check fails, task proceeds without approval gate
}
```

The existing queue scheduler already blocks tasks with `approval_status: 'pending'` (line 273 of `queue-scheduler.js`). This code path is confirmed working — it just never sees pending approvals because none were ever created.

### Template Rules — Shipped Disabled

Seed `approval_rules` table during schema initialization with useful templates, all `enabled: 0`.

**Note:** `schema-seeds.js` already seeds 4 approval rules that are enabled (`large-file-shrink`, `tiny-new-file`, `mass-line-deletion`, `validation-failure`). These are safeguard rules focused on output validation, not pre-submission gates. The new template rules below are pre-submission gates focused on task characteristics. Both sets coexist — different purposes, no overlap.

| Rule Name | Condition | Default Timeout | Description |
|-----------|-----------|----------------|-------------|
| High file count | `files_touched > 10` | 30 min | Tasks modifying many files |
| Security tag | `tags contains 'security'` | null (explicit only) | Security-sensitive tasks |
| Complex classification | `complexity = 'complex'` | 30 min | Tasks classified as complex |
| Cloud provider cost | `provider in ('anthropic', 'deepinfra')` | 30 min | Paid cloud API tasks |
| Large context | `context_tokens > 50000` | 30 min | Very large prompts |

Users see these in the dashboard, toggle on what they want.

### Auto-Approve Timeout

`auto_approve_after_minutes` is nullable:

- **Number (e.g., 30)** — task auto-approves after 30 minutes if no human acts
- **null** — task stays pending indefinitely until explicitly approved or rejected

**Implementation note:** The current `processAutoApprovals()` query filters `auto_approve_after_minutes IS NOT NULL`. A value of `0` would pass this filter and the `'+0 minutes'` comparison would cause immediate auto-approval. To avoid confusion, treat `0` the same as `null` — add `AND auto_approve_after_minutes > 0` to the query. This is a one-line SQL fix in `scheduling-automation.js`.

### Dashboard Exposure

The approvals section in the dashboard shows each rule with:
- On/off toggle
- `auto_approve_after_minutes` input (number field)
- "Require explicit approval" checkbox (sets timeout to null)
- Pending approvals with countdown timer (or "Waiting for manual review" when timeout is null)

The backend `updateApprovalRule()` function already exists. The dashboard needs to expose the `auto_approve_after_minutes` field — no new API endpoints.

## Files Modified

| File | Change |
|------|--------|
| `server/mcp-sse.js` | Auto-register session as agent on connect, inject `__sessionId` into args, update name on first tool call, mark offline on disconnect |
| `server/index.js` | Add startup sweep (mark all agents offline), extend coordination scheduler with lease renewal |
| `server/handlers/task/operations.js` or submit handler | Store `submitted_by_agent` in metadata, call `checkApprovalRequired()`, record events |
| `server/execution/slot-pull-scheduler.js` | Create claim when task starts executing |
| `server/execution/completion-pipeline.js` | Release claim on terminal status |
| `server/hooks/event-dispatch.js` | Record coordination events with correct positional signature |
| `server/db/coordination.js` | Add `task_id` filter to `listClaims()` |
| `server/db/scheduling-automation.js` | Fix `processAutoApprovals()` to skip `auto_approve_after_minutes = 0`, add `AND > 0` to query |
| `server/db/schema-seeds.js` | Seed 5 template approval rules (disabled) |
| Dashboard HTML/JS | Expose `auto_approve_after_minutes` field on approval rules |

## Testing Strategy

### Session registration
- SSE connect creates agent record with correct fields
- SSE disconnect sets agent to offline
- Agent name updates on first tool call with working_directory (only once, flag prevents re-check)
- Registration failure doesn't block SSE session
- Server startup marks all agents offline

### Session-to-handler threading
- `__sessionId` is present in args for tool calls from SSE sessions
- `__sessionId` is undefined for REST API calls
- Existing `__shutdownSignal` pattern is not disrupted

### Task claims
- Claim created when task starts executing (agent exists)
- Claim skipped when agent doesn't exist (registration failed)
- Claim links to the submitting session's agent ID
- Claim released on task completion/failure
- No claim for tasks without a session (REST API submissions)
- Claim renewal extends lease for running tasks
- `listClaims` supports `task_id` filter

### Coordination events
- All 11 event types recorded at correct trigger points
- Events use correct positional signature: `(eventType, agentId, taskId, details)`
- Event names match bare names from dispatchTaskEvent (no `task_` prefix)
- Event recording failure doesn't block task flow

### Approval wiring
- Task with matching enabled rule gets approval_status: 'pending' (set by checkApprovalRequired)
- Pending task is blocked from execution by queue scheduler
- Approved task proceeds to execution
- Rejected task is marked failed
- Auto-approve fires after timeout (> 0)
- Auto-approve skipped when timeout is null
- Auto-approve skipped when timeout is 0
- No rules enabled = no blocking (default)
- Template rules are seeded but disabled
- Existing safeguard rules (enabled) are not affected
- Dashboard can toggle rules and set timeout

### Integration
- Full flow: connect session → submit task → approval check → claim on start → events recorded → completion → claim released
- Coordination dashboard shows live data after submitting a real task
