# Fabro #29: Workflow Event Timeline (Extension of task_events)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small remaining gap between the original "event-history-backed replay" proposal and what TORQUE already ships. Add the two missing event types (`workflow.state_patched`, `workflow.dependency_unblocked`), emit them from the existing runtime sites, expose a per-workflow event read path (REST + dashboard), and derive a stable per-workflow `seq` at read time. No new table, no new replay engine — both already exist.

**Architecture:** Extension of three existing systems:

- **`task_events` table + `events/event-emitter.js`** (Plan 14, shipped) is already the append-only journal: `(id, task_id, workflow_id, ts, type, actor, payload_json)` indexed for `(workflow_id, ts)` reads via `listEvents`. Nineteen typed events fire today across the task lifecycle (created/queued/running/completed/failed/cancelled/skipped/requeued, tool.called, provider.routed/failover, verify.ran, retry.scheduled, goal_gate.evaluated, workflow.started/completed/failed, budget.breached).
- **`workflow_checkpoints` table** (migration 035 + Plan 28, shipped) snapshots full reduced state after every completion and is already the source of truth for replay-from-arbitrary-point — `forker.fork({ checkpointId, state_overrides })` rebuilds a fresh workflow with seeded state and cloned downstream steps.
- **`runs/<workflow_id>/` artifact bundle** (Plan 15, shipped) already serializes events.jsonl + per-task snapshots + manifest at terminal transitions.

The original Fabro #29 plan proposed a parallel `workflow_events` store with monotonic per-workflow `seq`, plus a state-fold replay engine. Both are redundant: `task_events` already carries `workflow_id` + `ts` + autoincrement `id` (totally ordered) and the checkpoint store already snapshots reduced state after every completion (no need to fold events back into state). What is genuinely missing is **(a)** two event-type emissions, **(b)** a workflow-scoped read API, and **(c)** a derived `seq` field so consumers can address events by ordinal position. This plan delivers exactly that.

**Tech Stack:** Node.js, better-sqlite3, React. Builds on Plans 14 (event backbone), 15 (artifact bundles), 27 (typed state), 28 (checkpoints + forker).

**Spec:** `docs/superpowers/specs/2026-04-11-fabro-29-event-history-replay-design.md` (refresh against the gap analysis above before authoring; the original spec assumed a new table).

**Branch:** `feat/fabro-29-workflow-event-timeline` (worktree: `.worktrees/feat-fabro-29-workflow-event-timeline/`)

**Verify command (remote):** `torque-remote npx vitest run server/tests/`

## Sandbox-tolerant verify fallback

Each task below has Run-tests steps. Execute in this priority order:

1. **Preferred:** `torque-remote npx vitest run <path/to/test>` — runs on the remote workstation.
2. **Fallback 1:** `npx vitest run <path/to/test> --pool=threads --no-coverage` — avoids the fork-pool that sometimes hits `spawn EPERM`.
3. **Fallback 2:** If both fail with spawn / access errors, note the exact error text, skip the run step, and proceed to the commit step. The host's post-task verification will surface regressions. Include "verify step skipped due to sandbox spawn restriction" in your final output.

Do not let a blocked vitest invocation prevent you from committing a correct code change.

---

## File Structure

**New files:**

- `server/tests/workflow-event-timeline-emit.test.js` — asserts state_patched + dependency_unblocked emit
- `server/tests/workflow-event-timeline-read.test.js` — asserts list-by-workflow returns derived `seq`
- `server/tests/workflow-event-timeline-route.test.js` — REST endpoint smoke
- `dashboard/src/views/WorkflowEventTimeline.jsx` — table view backed by the new endpoint

**Modified files:**

- `server/events/event-types.js` — add `WORKFLOW_STATE_PATCHED`, `WORKFLOW_DEPENDENCY_UNBLOCKED`
- `server/events/event-emitter.js` — extend `listEvents` to return derived `seq`; add `listWorkflowEvents` convenience
- `server/workflow-state/workflow-state.js` — emit `workflow.state_patched` after successful patch
- `server/execution/workflow-runtime.js` — emit `workflow.dependency_unblocked` when a blocked task transitions to runnable
- `server/api/routes/workflows.js` (or the routes-passthrough table if no per-resource file exists yet) — `GET /:id/events`
- `server/handlers/event-handlers.js` — extend `handleListTaskEvents` so workflow-scoped reads return `seq`
- `dashboard/src/views/WorkflowDetail.jsx` — link to the timeline view
- `dashboard/src/App.jsx` — register the timeline route

No migrations. No new tables.

---

## Task 1: Add the two missing event types

**Acceptance:** `EVENT_TYPES` in `server/events/event-types.js` exports `WORKFLOW_STATE_PATCHED = 'workflow.state_patched'` and `WORKFLOW_DEPENDENCY_UNBLOCKED = 'workflow.dependency_unblocked'`. A test asserts both are present and `KNOWN_TYPES` in `event-emitter.js` accepts them.

**Files:**
- Modify: `server/events/event-types.js`
- Test: `server/tests/workflow-event-timeline-emit.test.js` (create — covers Tasks 1-3)

- [ ] **Step 1.1: Write the failing test (event-type contract only)**

Create `server/tests/workflow-event-timeline-emit.test.js` with the type-contract block:

```javascript
import { describe, it, expect } from 'vitest';

const { EVENT_TYPES } = require('../events/event-types');

describe('event-types: workflow lifecycle additions', () => {
  it('exports WORKFLOW_STATE_PATCHED', () => {
    expect(EVENT_TYPES.WORKFLOW_STATE_PATCHED).toBe('workflow.state_patched');
  });
  it('exports WORKFLOW_DEPENDENCY_UNBLOCKED', () => {
    expect(EVENT_TYPES.WORKFLOW_DEPENDENCY_UNBLOCKED).toBe('workflow.dependency_unblocked');
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

`torque-remote npx vitest run server/tests/workflow-event-timeline-emit.test.js`. Expected: FAIL — `expected undefined to be 'workflow.state_patched'`.

- [ ] **Step 1.3: Add the two constants**

In `server/events/event-types.js`, append two members to the `EVENT_TYPES` object:

```javascript
WORKFLOW_STATE_PATCHED: 'workflow.state_patched',
WORKFLOW_DEPENDENCY_UNBLOCKED: 'workflow.dependency_unblocked',
```

The existing `KNOWN_TYPES = new Set(Object.values(EVENT_TYPES))` in `event-emitter.js` picks them up automatically.

- [ ] **Step 1.4: Re-run the test**

Expected: 2 passing.

- [ ] **Step 1.5: Commit**

```bash
git add server/events/event-types.js server/tests/workflow-event-timeline-emit.test.js
git commit -m "feat(events): add workflow.state_patched and workflow.dependency_unblocked types"
```

---

## Task 2: Emit `workflow.state_patched` from `applyPatch`

**Acceptance:** `workflow-state.js` `applyPatch(workflowId, patch)` emits `workflow.state_patched` on every successful patch, with `payload = { patch, reducers, version }`. Failure paths (validation errors, JSON failures) do not emit. Existing applyPatch tests still pass.

**Important constraint:** `task_events.task_id` is `NOT NULL`. Workflow-scoped events without a task_id are not legal in the current schema. For state_patched, use the workflow_id as a synthetic task_id sentinel of the form `wf:<workflow_id>` — the read path filters on `workflow_id` (not task_id), so this is invisible to consumers, but it preserves the NOT NULL invariant. Document the convention as a code comment.

**Files:**
- Modify: `server/workflow-state/workflow-state.js`
- Test: extend `server/tests/workflow-event-timeline-emit.test.js`

- [ ] **Step 2.1: Extend the failing test**

Append to `workflow-event-timeline-emit.test.js`:

```javascript
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createWorkflowState } = require('../workflow-state/workflow-state');
const { listEvents } = require('../events/event-emitter');

describe('workflow-state: applyPatch emits workflow.state_patched', () => {
  let db;
  beforeAll(() => { ({ db } = setupTestDbOnly('wf-event-emit')); });
  afterAll(() => teardownTestDb());

  it('emits exactly one workflow.state_patched per successful patch', () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, 't', 'running', ?)`)
      .run(wfId, new Date().toISOString());
    const ws = createWorkflowState({ db });
    ws.setStateSchema(wfId, null, { count: 'numeric_sum' });
    ws.applyPatch(wfId, { count: 1 });
    ws.applyPatch(wfId, { count: 2 });
    const events = listEvents({ workflow_id: wfId, type: 'workflow.state_patched' });
    expect(events).toHaveLength(2);
    expect(events[0].payload.patch).toEqual({ count: 1 });
    expect(events[0].payload.reducers).toEqual({ count: 'numeric_sum' });
    expect(events[0].payload.version).toBeGreaterThan(0);
  });

  it('does not emit when patch validation fails', () => {
    const wfId = randomUUID();
    db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, 't', 'running', ?)`)
      .run(wfId, new Date().toISOString());
    const ws = createWorkflowState({ db });
    ws.setStateSchema(
      wfId,
      { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      { count: 'replace' },
    );
    expect(() => ws.applyPatch(wfId, { count: 'not-a-number' })).toThrow();
    const events = listEvents({ workflow_id: wfId, type: 'workflow.state_patched' });
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2.2: Run — expect FAIL**

`torque-remote npx vitest run server/tests/workflow-event-timeline-emit.test.js`. Expect both new tests to fail (no events found).

- [ ] **Step 2.3: Implement emission in `applyPatch`**

In `server/workflow-state/workflow-state.js`, locate `function applyPatch(workflowId, patch)` (around line 128). After the row is committed and the new state has been read back successfully, add:

```javascript
// Emit workflow.state_patched (Plan 29). task_events.task_id is NOT NULL, so we
// use a `wf:<id>` sentinel; the read path filters by workflow_id, never by task_id.
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: `wf:${normalizedWorkflowId}`,
    workflow_id: normalizedWorkflowId,
    type: EVENT_TYPES.WORKFLOW_STATE_PATCHED,
    actor: 'workflow-state',
    payload: { patch, reducers: meta.reducers || null, version: nextVersion },
  });
} catch (err) {
  // Event emission must not fail the state write. Log via the module logger if available,
  // otherwise swallow — the write itself succeeded.
}
```

`nextVersion` and `meta` are local variables already in scope inside `applyPatch`; if their names differ in the current file, use whatever the success branch already computed (the version returned to the caller, and the reducers map looked up for this workflow). Read the function body before editing — do not guess names.

- [ ] **Step 2.4: Re-run the test**

Expected: 4 passing in `workflow-event-timeline-emit.test.js`. Also re-run any existing `workflow-state.test.js` to confirm no regression.

- [ ] **Step 2.5: Commit**

```bash
git add server/workflow-state/workflow-state.js server/tests/workflow-event-timeline-emit.test.js
git commit -m "feat(workflow-state): emit workflow.state_patched on every successful patch"
```

---

## Task 3: Emit `workflow.dependency_unblocked` from the runtime

**Acceptance:** When the workflow runtime transitions a previously-blocked task to runnable, exactly one `workflow.dependency_unblocked` event is emitted with `payload = { unblocked_task_id, dependencies_resolved: [task_id, ...] }`. Tasks that were never blocked (no dependencies) do not emit.

**Files:**
- Modify: `server/execution/workflow-runtime.js`
- Test: extend `server/tests/workflow-event-timeline-emit.test.js`

- [ ] **Step 3.1: Find the unblock site**

Read `server/execution/workflow-runtime.js`. Search for the function that transitions tasks from a blocked/pending state to runnable after a dependency completes — typical names: `unblockTasks`, `markRunnable`, `evaluateDependencies`. Verify the exact function before editing. The site to instrument is the place where status flips from `pending`/`blocked` to `queued` or `runnable` *because* a dependency completed.

- [ ] **Step 3.2: Write the failing test**

Append to `workflow-event-timeline-emit.test.js`. The test should drive a 2-task workflow, complete task A, observe that the runtime unblocks task B, and assert one `workflow.dependency_unblocked` event with task B's id in the payload. If the runtime is awkward to drive directly in a unit test, mock at the level of the unblock helper (read the file first to choose the right seam).

- [ ] **Step 3.3: Implement the emit**

At the unblock site, after the status update succeeds, emit:

```javascript
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: unblockedTaskId,
    workflow_id: workflowId,
    type: EVENT_TYPES.WORKFLOW_DEPENDENCY_UNBLOCKED,
    actor: 'workflow-runtime',
    payload: { unblocked_task_id: unblockedTaskId, dependencies_resolved: completedDepIds },
  });
} catch { /* fail-open */ }
```

If multiple tasks become runnable in a single tick, emit one event per task — do not batch.

- [ ] **Step 3.4: Run the test, then run the full workflow-runtime test file to catch regressions**

`torque-remote npx vitest run server/tests/workflow-event-timeline-emit.test.js server/tests/workflow-runtime.test.js`. Expected: all green.

- [ ] **Step 3.5: Commit**

```bash
git add server/execution/workflow-runtime.js server/tests/workflow-event-timeline-emit.test.js
git commit -m "feat(workflow-runtime): emit workflow.dependency_unblocked when deps clear"
```

---

## Task 4: Workflow-scoped read API with derived `seq`

**Acceptance:** `listEvents({ workflow_id })` (or a new sibling `listWorkflowEvents(workflowId, opts)`) returns events ordered by `(ts ASC, id ASC)` with a derived integer `seq` field starting at 1. `seq` is computed in the read path — no schema change. `from_seq` / `to_seq` filters work and produce a contiguous subrange.

**Files:**
- Modify: `server/events/event-emitter.js`
- Test: `server/tests/workflow-event-timeline-read.test.js` (create)

- [ ] **Step 4.1: Write the failing test**

Create `server/tests/workflow-event-timeline-read.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { emitTaskEvent, listEvents, listWorkflowEvents } = require('../events/event-emitter');
const { EVENT_TYPES } = require('../events/event-types');

let db, wfA, wfB;

beforeAll(() => {
  ({ db } = setupTestDbOnly('wf-event-read'));
  wfA = randomUUID();
  wfB = randomUUID();
  for (const id of [wfA, wfB]) {
    db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, 't', 'running', ?)`)
      .run(id, new Date().toISOString());
  }
  // Interleave events across two workflows
  emitTaskEvent({ task_id: `wf:${wfA}`, workflow_id: wfA, type: EVENT_TYPES.WORKFLOW_STARTED, payload: {} });
  emitTaskEvent({ task_id: `wf:${wfB}`, workflow_id: wfB, type: EVENT_TYPES.WORKFLOW_STARTED, payload: {} });
  emitTaskEvent({ task_id: `wf:${wfA}`, workflow_id: wfA, type: EVENT_TYPES.WORKFLOW_STATE_PATCHED, payload: { patch: { x: 1 } } });
  emitTaskEvent({ task_id: `wf:${wfA}`, workflow_id: wfA, type: EVENT_TYPES.WORKFLOW_STATE_PATCHED, payload: { patch: { x: 2 } } });
  emitTaskEvent({ task_id: `wf:${wfB}`, workflow_id: wfB, type: EVENT_TYPES.WORKFLOW_COMPLETED, payload: {} });
});
afterAll(() => teardownTestDb());

describe('listWorkflowEvents derives per-workflow seq', () => {
  it('returns events for one workflow with seq 1..N', () => {
    const events = listWorkflowEvents(wfA);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(events.map(e => e.type)).toEqual([
      'workflow.started', 'workflow.state_patched', 'workflow.state_patched',
    ]);
  });

  it('seq is independent per workflow', () => {
    const a = listWorkflowEvents(wfA);
    const b = listWorkflowEvents(wfB);
    expect(a[0].seq).toBe(1);
    expect(b[0].seq).toBe(1);
    expect(b).toHaveLength(2);
  });

  it('respects from_seq / to_seq window', () => {
    const events = listWorkflowEvents(wfA, { from_seq: 2, to_seq: 3 });
    expect(events.map(e => e.seq)).toEqual([2, 3]);
  });

  it('listEvents({ workflow_id }) also exposes derived seq', () => {
    const events = listEvents({ workflow_id: wfA });
    expect(events[0].seq).toBe(1);
    expect(events[events.length - 1].seq).toBe(events.length);
  });
});
```

- [ ] **Step 4.2: Run — expect FAIL**

Expected: `listWorkflowEvents` is undefined, or `seq` is missing from results.

- [ ] **Step 4.3: Implement**

In `server/events/event-emitter.js`:

1. Modify `listEvents` so that when `workflow_id` is provided, the returned rows include `seq` (1-based ordinal in the filtered, ordered result). When `workflow_id` is not provided, `seq` is omitted (it would be meaningless across workflows).
2. Add `listWorkflowEvents(workflowId, { from_seq, to_seq, type, since, limit } = {})` — thin wrapper that calls `listEvents({ workflow_id: workflowId, type, since, limit })` then applies `from_seq` / `to_seq` filters in-memory after seq assignment.
3. Export both.

```javascript
function listWorkflowEvents(workflowId, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  const { from_seq = null, to_seq = null, ...rest } = opts;
  const events = listEvents({ workflow_id: workflowId, ...rest });
  let filtered = events;
  if (from_seq !== null) filtered = filtered.filter(e => e.seq >= from_seq);
  if (to_seq !== null) filtered = filtered.filter(e => e.seq <= to_seq);
  return filtered;
}
```

For `listEvents` itself, the seq decoration is a single `forEach` after the existing `rows.map(...)`:

```javascript
const decorated = rows.map((row) => ({ ...row, payload: parsePayload(row.payload_json) }));
if (workflow_id) {
  decorated.forEach((evt, idx) => { evt.seq = idx + 1; });
}
return decorated;
```

- [ ] **Step 4.4: Re-run, then run the existing event-emitter test file**

`torque-remote npx vitest run server/tests/workflow-event-timeline-read.test.js server/tests/event-emitter.test.js`. Both must pass.

- [ ] **Step 4.5: Commit**

```bash
git add server/events/event-emitter.js server/tests/workflow-event-timeline-read.test.js
git commit -m "feat(events): derive per-workflow seq + listWorkflowEvents convenience"
```

---

## Task 5: REST endpoint and handler

**Acceptance:** `GET /api/workflows/:id/events?from_seq=&to_seq=&type=` returns `{ workflow_id, events: [...] }` where each event has the derived `seq`. Response is JSON. Bad query params (`from_seq=abc`) return 400. Unknown workflow returns 200 with `events: []` (consistent with `listEvents`).

**Files:**
- Modify: `server/handlers/event-handlers.js` — add `handleListWorkflowEvents`
- Modify: the route table that owns `/api/workflows/...` — add the new route. If a per-resource file does not exist, register in the existing `routes-passthrough.js` table.
- Test: `server/tests/workflow-event-timeline-route.test.js` (create)

- [ ] **Step 5.1: Write the failing test**

Create `server/tests/workflow-event-timeline-route.test.js` that boots the REST app harness used elsewhere in the suite (mirror the pattern from any existing `server/tests/*-route.test.js` file — read one before authoring), seeds two events on a workflow id, and asserts `GET /api/workflows/:id/events` returns them with `seq: 1, 2`.

- [ ] **Step 5.2: Run — expect 404 / undefined route**

- [ ] **Step 5.3: Implement the handler**

In `server/handlers/event-handlers.js`:

```javascript
function handleListWorkflowEvents(args = {}) {
  const { workflow_id } = args;
  if (!workflow_id) return makeError(ErrorCodes.INVALID_PARAM, 'workflow_id is required');

  const fromSeq = parseOptionalInt(args.from_seq, 'from_seq');
  if (!fromSeq.ok) return makeError(ErrorCodes.INVALID_PARAM, fromSeq.error);
  const toSeq = parseOptionalInt(args.to_seq, 'to_seq');
  if (!toSeq.ok) return makeError(ErrorCodes.INVALID_PARAM, toSeq.error);

  try {
    const { listWorkflowEvents } = require('../events/event-emitter');
    const events = listWorkflowEvents(workflow_id, {
      from_seq: fromSeq.value, to_seq: toSeq.value,
      type: args.type || null, since: args.since || null,
      limit: args.limit || 5000,
    });
    return {
      content: [{ type: 'text', text: `${events.length} event(s) for workflow ${workflow_id}` }],
      structuredData: { workflow_id, events },
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, err.message);
  }
}
```

`parseOptionalInt` is a small local helper that returns `{ ok: true, value: null }` for empty input, `{ ok: true, value: <int> }` for a parseable integer, and `{ ok: false, error }` otherwise. Mirror the shape of `normalizeLimit` already in the file.

- [ ] **Step 5.4: Wire the route**

If `server/api/routes/workflows.js` exists, add an Express handler. If routing is table-driven (`server/api/routes-passthrough.js` or similar), add an entry like:

```javascript
{ method: 'GET', path: /^\/api\/workflows\/([^/]+)\/events$/, tool: 'list_workflow_events', mapParams: ['workflow_id'], mapQuery: ['from_seq', 'to_seq', 'type', 'since', 'limit'] },
```

Register the corresponding tool in `server/tool-defs/event-defs.js` (or wherever the existing `list_task_events` tool is defined) so MCP callers also see `list_workflow_events`. Re-use the existing dispatch wiring — do not invent a new mechanism.

- [ ] **Step 5.5: Re-run the test**

Expected: green.

- [ ] **Step 5.6: Commit**

```bash
git add server/handlers/event-handlers.js server/api/routes-passthrough.js server/tool-defs/event-defs.js server/tests/workflow-event-timeline-route.test.js
git commit -m "feat(events): GET /api/workflows/:id/events + list_workflow_events tool"
```

(Adjust the `git add` list to match the files actually touched.)

---

## Task 6: Dashboard timeline view

**Acceptance:** Visiting `/workflows/<id>/timeline` in the dashboard renders a sortable table of every event for that workflow with columns `seq`, `type`, `actor`, `task_id`, `payload preview`, `ts`. A type filter narrows the list client-side. The existing workflow detail page links to it.

**Files:**
- Create: `dashboard/src/views/WorkflowEventTimeline.jsx`
- Modify: `dashboard/src/views/WorkflowDetail.jsx` (add a link)
- Modify: `dashboard/src/App.jsx` (register the route)

- [ ] **Step 6.1: Implement the view**

Create `dashboard/src/views/WorkflowEventTimeline.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowEventTimeline() {
  const { id } = useParams();
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}/events`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => setEvents(d.events || []))
      .catch(e => setError(e.message));
  }, [id]);

  const filtered = filter
    ? events.filter(e => e.type.includes(filter) || (e.task_id && e.task_id.includes(filter)))
    : events;

  return (
    <div className="p-4 max-w-6xl">
      <h2 className="text-xl font-semibold mb-2">Event timeline: {id}</h2>
      {error && <div className="text-red-600 text-sm mb-2">{error}</div>}
      <input
        placeholder="filter by event type or task id"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="border rounded px-2 py-1 mb-3 w-full max-w-md"
      />
      <table className="w-full text-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="text-left px-2 py-1 w-12">seq</th>
            <th className="text-left px-2 py-1">type</th>
            <th className="text-left px-2 py-1">actor</th>
            <th className="text-left px-2 py-1">task</th>
            <th className="text-left px-2 py-1">payload</th>
            <th className="text-left px-2 py-1">ts</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(e => (
            <tr key={`${e.seq}-${e.id}`} className="border-t align-top">
              <td className="px-2 py-1 font-mono">{e.seq}</td>
              <td className="px-2 py-1 font-mono">{e.type}</td>
              <td className="px-2 py-1 font-mono text-xs">{e.actor || '-'}</td>
              <td className="px-2 py-1 font-mono text-xs">{e.task_id ? e.task_id.slice(0, 12) : '-'}</td>
              <td className="px-2 py-1 font-mono text-xs max-w-md truncate">
                {e.payload ? JSON.stringify(e.payload) : ''}
              </td>
              <td className="px-2 py-1 text-xs text-gray-500">{e.ts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6.2: Register the route**

In `dashboard/src/App.jsx`, add (matching the existing checkpoint timeline registration from Plan 28):

```jsx
<Route path="/workflows/:id/timeline" element={<WorkflowEventTimeline />} />
```

If the path is already taken by Plan 28's checkpoint timeline, use `/workflows/:id/events` instead and adjust the link accordingly.

- [ ] **Step 6.3: Link from `WorkflowDetail.jsx`**

Add a navigation link (`<Link to={\`/workflows/${id}/events\`}>Event timeline</Link>`) next to the existing checkpoint-timeline link.

- [ ] **Step 6.4: Smoke**

Build the dashboard (`cd dashboard && npm run build`) or rely on the dev server, navigate to `/workflows/<some-running-workflow>/events`, confirm the table renders with seq starting at 1.

- [ ] **Step 6.5: Commit**

```bash
git add dashboard/src/views/WorkflowEventTimeline.jsx dashboard/src/views/WorkflowDetail.jsx dashboard/src/App.jsx
git commit -m "feat(dashboard): workflow event timeline view"
```

---

## Task 7: Full-suite regression + docs

**Acceptance:** Full server test suite passes remotely. `docs/superpowers/skills/event-history.md` (or the existing event-backbone doc — pick the right home; do not create a new top-level doc if one exists) describes the two new event types and the workflow-scoped read API.

- [ ] **Step 7.1: Full suite**

`torque-remote npx vitest run server/tests/`. Expected: all green. Pay attention to any test that fixes the count of known event types — bump expected counts where needed.

- [ ] **Step 7.2: Documentation**

Find the existing event documentation (likely `docs/superpowers/skills/event-history.md`, `docs/events.md`, or a section in `docs/architecture.md` — grep first). Append:

- The two new event types with their payload shapes.
- The `listWorkflowEvents` API and `GET /api/workflows/:id/events` REST endpoint.
- The `wf:<workflow_id>` task_id sentinel convention for state-patched events.
- A note that replay-from-checkpoint already exists via `forker.fork` and is the supported point-in-time recovery path; the event timeline is the audit/observability surface, not a state-reconstruction substrate.

If no event-doc home exists, append to `docs/safeguards.md` under a new "Workflow Event Timeline" subsection rather than creating a fresh top-level doc.

- [ ] **Step 7.3: Commit**

```bash
git add docs/
git commit -m "docs(events): document workflow timeline + state_patched + dependency_unblocked"
```

---

## Verification

After cutover, exercise the full path against a live workflow:

1. Submit a small 3-step workflow with workflow state (`set_state_schema` + a step that calls `apply_patch`).
2. Wait for completion via `await_workflow`.
3. `GET /api/workflows/<id>/events` returns:
   - `seq=1` is `workflow.started`.
   - At least one `workflow.state_patched` per `apply_patch` call, with `payload.patch` and `payload.reducers` populated.
   - At least one `workflow.dependency_unblocked` per dependent step beyond the root.
   - Final event is `workflow.completed`.
4. Navigate to `/workflows/<id>/events` in the dashboard and confirm the table renders the same series with monotonic seq.
5. Cross-check: `forker.fork({ checkpointId: <mid-run-checkpoint> })` still works — we have not regressed the existing replay path.
6. Bundle smoke: confirm `runs/<id>/events.jsonl` already includes the two new event types (it should, automatically, because `buildBundle` reads `task_events` via `listEvents`).

## Risks

- **Disk cost.** `task_events` already grows linearly with task count; this plan adds two new emit sites. Per workflow we expect ~1 state_patched per `apply_patch` call (typically O(steps)) and ~1 dependency_unblocked per non-root step. Worst case: a 10-step workflow gains ~20 extra rows. At 100 bytes per row that is 2 KB per workflow — negligible. No retention change required at this size. Re-evaluate only if a single workflow emits >10k state patches (a sign the patch granularity is wrong, not the journal).
- **NOT NULL on task_id.** The `wf:<workflow_id>` sentinel keeps the schema honest without a migration. If a future plan wants a true workflow-only event channel, the right move is a focused migration that drops NOT NULL on `task_events.task_id`, not a parallel table.
- **`seq` is read-derived, not stored.** Two readers can disagree on `seq` if events arrive between their queries. This is acceptable for an audit/observability surface (the dashboard always re-queries) and unacceptable only for distributed consensus — which TORQUE does not need here. If that ever changes, store `seq` at write time via `COALESCE((SELECT MAX(seq) FROM task_events WHERE workflow_id = ?), 0) + 1` inside a transaction; until then, do not pay for the extra index.
- **Existing replay path is preserved.** The `runs/` bundle and `forker.fork` continue to be the supported "go back in time" mechanisms. This plan does not introduce a competing event-fold replay engine.
- **Event-emit failure must not break state writes.** The wrap in Task 2 / Task 3 is fail-open by design. Any logger noise from emit failures is preferable to a state-write that succeeded but threw.

---

## Post-plan operator rollout

1. Cut over via `scripts/worktree-cutover.sh fabro-29-workflow-event-timeline`.
2. Pick one already-running long workflow and call `GET /api/workflows/<id>/events`. Confirm at least `workflow.started` and one `workflow.dependency_unblocked` appear (older history will not have state_patched events because emission is forward-only — that is expected).
3. After 24h, count rows in `task_events` for the new types: `SELECT type, COUNT(*) FROM task_events WHERE type IN ('workflow.state_patched', 'workflow.dependency_unblocked') GROUP BY type`. Non-zero on both means the emit sites are wired correctly. Zero on `state_patched` with non-zero on `dependency_unblocked` indicates the `applyPatch` emit is on a code path no live workflow exercises — investigate before assuming success.
