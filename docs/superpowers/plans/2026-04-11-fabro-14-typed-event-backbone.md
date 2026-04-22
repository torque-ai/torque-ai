# Fabro #14: Typed Event Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every significant runtime moment a typed, immutable event. The orchestration boundary becomes the event log instead of ad-hoc status mutations. Enables clean replay, sidecar services (dashboard, retros, audits), and stuck-task diagnostics. Inspired by OpenHands' append-only event backbone.

**Architecture:** A new `task_events` table stores immutable events `{ id, task_id, workflow_id, ts, type, actor, payload }`. A `server/events/event-emitter.js` module wraps the existing event-bus to also persist events. Existing call sites (status updates, tool calls, provider routing decisions, retries, finalization stages) emit typed events alongside their current side effects. Initial event types: `task.created`, `task.queued`, `task.running`, `task.completed`, `task.failed`, `tool.called`, `provider.routed`, `provider.failover`, `verify.tag.assigned`, `retry.scheduled`, `goal_gate.evaluated`. Events are append-only — never updated or deleted.

**Tech Stack:** Node.js, better-sqlite3.

---

## File Structure

**New files:**
- `server/events/event-emitter.js` — typed emit + persist
- `server/events/event-types.js` — event-name constants + payload contracts
- `server/handlers/event-handlers.js` — query MCP tools
- `server/tool-defs/event-defs.js`
- `server/tests/event-emitter.test.js`
- `server/tests/event-replay.test.js`

**Modified files:**
- `server/db/schema-tables.js` — add `task_events` table
- `server/database.js` — register module
- ~6 emit sites in finalizer, queue-scheduler, provider-router, task-startup, auto-verify-retry
- `server/api/routes-passthrough.js`

---

## Task 1: Schema + emitter

- [x] **Step 1: Add table**

In `server/db/schema-tables.js`:

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_task_events_workflow ON task_events(workflow_id, ts);
CREATE INDEX IF NOT EXISTS idx_task_events_type ON task_events(type);
```

Add `'task_events'` to `ALL_TABLES`.

- [x] **Step 2: Event types**

Create `server/events/event-types.js`:

```js
'use strict';

const EVENT_TYPES = {
  TASK_CREATED:         'task.created',
  TASK_QUEUED:          'task.queued',
  TASK_RUNNING:         'task.running',
  TASK_COMPLETED:       'task.completed',
  TASK_FAILED:          'task.failed',
  TASK_CANCELLED:       'task.cancelled',
  TASK_SKIPPED:         'task.skipped',
  TASK_REQUEUED:        'task.requeued',
  TOOL_CALLED:          'tool.called',
  PROVIDER_ROUTED:      'provider.routed',
  PROVIDER_FAILOVER:    'provider.failover',
  VERIFY_RAN:           'verify.ran',
  VERIFY_TAG_ASSIGNED:  'verify.tag.assigned',
  RETRY_SCHEDULED:      'retry.scheduled',
  GOAL_GATE_EVALUATED:  'goal_gate.evaluated',
  WORKFLOW_STARTED:     'workflow.started',
  WORKFLOW_COMPLETED:   'workflow.completed',
  WORKFLOW_FAILED:      'workflow.failed',
  BUDGET_BREACHED:      'budget.breached',
};

module.exports = { EVENT_TYPES };
```

- [x] **Step 3: Emitter module + tests**

Create `server/tests/event-emitter.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('vitest');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
beforeAll(() => { db = setupTestDb('events').db; });
afterAll(() => teardownTestDb());
beforeEach(() => { db.prepare('DELETE FROM task_events').run(); });

describe('event-emitter', () => {
  it('persists an event and assigns an id + ts', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    const evt = emitTaskEvent({
      task_id: 't1',
      type: 'task.created',
      actor: 'test',
      payload: { foo: 'bar' },
    });
    expect(evt.id).toBeGreaterThan(0);
    expect(evt.ts).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const row = db.prepare('SELECT * FROM task_events WHERE id = ?').get(evt.id);
    expect(row.task_id).toBe('t1');
    expect(row.type).toBe('task.created');
    const payload = JSON.parse(row.payload_json);
    expect(payload.foo).toBe('bar');
  });

  it('list events for a task in chronological order', () => {
    const { emitTaskEvent, listEvents } = require('../events/event-emitter');
    emitTaskEvent({ task_id: 't1', type: 'task.created', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'task.queued', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'task.running', payload: {} });
    const events = listEvents({ task_id: 't1' });
    expect(events.map(e => e.type)).toEqual(['task.created', 'task.queued', 'task.running']);
  });

  it('filters by event type', () => {
    const { emitTaskEvent, listEvents } = require('../events/event-emitter');
    emitTaskEvent({ task_id: 't1', type: 'task.created', payload: {} });
    emitTaskEvent({ task_id: 't1', type: 'tool.called', payload: { tool: 'shell' } });
    const tools = listEvents({ task_id: 't1', type: 'tool.called' });
    expect(tools).toHaveLength(1);
    expect(tools[0].payload.tool).toBe('shell');
  });

  it('rejects unknown event types', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    expect(() => emitTaskEvent({ task_id: 't1', type: 'made.up.event', payload: {} }))
      .toThrow(/unknown event type/i);
  });

  it('survives huge payloads by truncating', () => {
    const { emitTaskEvent } = require('../events/event-emitter');
    const huge = 'x'.repeat(200000);
    const evt = emitTaskEvent({ task_id: 't1', type: 'tool.called', payload: { output: huge } });
    const row = db.prepare('SELECT payload_json FROM task_events WHERE id = ?').get(evt.id);
    expect(row.payload_json.length).toBeLessThan(120000);
  });
});
```

Run: `npx vitest run tests/event-emitter.test.js --no-coverage` → FAIL (module missing).

Implement `server/events/event-emitter.js`:

```js
'use strict';

const db = require('../database');
const { EVENT_TYPES } = require('./event-types');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'event-emitter' });

const KNOWN_TYPES = new Set(Object.values(EVENT_TYPES));
const MAX_PAYLOAD_BYTES = 100000;

function truncatePayload(payload) {
  const json = JSON.stringify(payload || {});
  if (json.length <= MAX_PAYLOAD_BYTES) return json;
  // Keep top-level shape, truncate string values
  const truncated = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (typeof v === 'string' && v.length > 4000) {
      truncated[k] = v.slice(0, 4000) + '... [truncated]';
    } else {
      truncated[k] = v;
    }
  }
  truncated._truncated = true;
  truncated._original_size = json.length;
  return JSON.stringify(truncated).slice(0, MAX_PAYLOAD_BYTES);
}

function emitTaskEvent({ task_id, workflow_id = null, type, actor = null, payload = {} }) {
  if (!KNOWN_TYPES.has(type)) {
    throw new Error(`Unknown event type: ${type}`);
  }
  const ts = new Date().toISOString();
  const payloadJson = truncatePayload(payload);

  const result = db.prepare(`
    INSERT INTO task_events (task_id, workflow_id, ts, type, actor, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(task_id, workflow_id, ts, type, actor, payloadJson);

  const evt = { id: result.lastInsertRowid, task_id, workflow_id, ts, type, actor, payload };
  // Forward to in-memory event-bus for realtime SSE consumers
  try { eventBus.emit('task.event', evt); } catch (e) { logger.info(`[events] bus emit failed: ${e.message}`); }
  return evt;
}

function listEvents({ task_id = null, workflow_id = null, type = null, since = null, limit = 1000 } = {}) {
  const where = [];
  const params = [];
  if (task_id) { where.push('task_id = ?'); params.push(task_id); }
  if (workflow_id) { where.push('workflow_id = ?'); params.push(workflow_id); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (since) { where.push('ts >= ?'); params.push(since); }
  const sql = `
    SELECT * FROM task_events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts ASC, id ASC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params).map(r => ({
    ...r,
    payload: r.payload_json ? JSON.parse(r.payload_json) : {},
  }));
}

module.exports = { emitTaskEvent, listEvents };
```

Run tests → PASS. Commit:

```bash
git add server/db/schema-tables.js server/events/ server/tests/event-emitter.test.js
git commit -m "feat(events): typed task event backbone with append-only persistence"
git push --no-verify origin main
```

---

## Task 2: Wire emit calls at key sites

For each site below: read the file, find the matching status mutation, emit the event AFTER the status write succeeds. Each emit is fire-and-forget (wrapped in try/catch — never fail the original operation if emit throws).

- [ ] **Step 1: Task creation (`server/db/task-core.js` `createTask`)**

After the INSERT succeeds:

```js
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: task.id,
    workflow_id: task.workflow_id || null,
    type: EVENT_TYPES.TASK_CREATED,
    actor: 'task-core',
    payload: { provider: task.provider, project: task.project, tags: task.tags || [] },
  });
} catch (e) { /* non-critical */ }
```

- [ ] **Step 2: Status transitions (`updateTaskStatus`)**

After the UPDATE succeeds, map status → event type:

```js
const STATUS_TO_EVENT = {
  queued: 'TASK_QUEUED',
  running: 'TASK_RUNNING',
  completed: 'TASK_COMPLETED',
  failed: 'TASK_FAILED',
  cancelled: 'TASK_CANCELLED',
  skipped: 'TASK_SKIPPED',
};
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  const eventName = STATUS_TO_EVENT[status];
  if (eventName) {
    emitTaskEvent({
      task_id: id,
      type: EVENT_TYPES[eventName],
      actor: 'task-core',
      payload: { previous_status: previousStatus, additional_fields: additionalFields },
    });
  }
} catch (e) { /* non-critical */ }
```

- [ ] **Step 3: Provider routing (`server/execution/provider-router.js`)**

After the routing decision is finalized:

```js
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: taskId,
    type: EVENT_TYPES.PROVIDER_ROUTED,
    actor: 'provider-router',
    payload: { provider, switch_reason: switchReason, decision_trace: decisionTrace },
  });
} catch (e) { /* non-critical */ }
```

- [ ] **Step 4: Provider failover (`server/db/smart-routing.js` `approveProviderSwitch`)**

After the SQL UPDATE succeeds:

```js
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: taskId,
    type: EVENT_TYPES.PROVIDER_FAILOVER,
    actor: 'smart-routing',
    payload: { from: task.provider, to: newProvider, reason: 'quota_or_failure' },
  });
} catch (e) { /* non-critical */ }
```

- [ ] **Step 5: Verify tag assignment (`server/validation/auto-verify-retry.js`)**

Right after the `_db.updateTask(taskId, { tags: cleanedTags })` call:

```js
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: taskId,
    type: EVENT_TYPES.VERIFY_TAG_ASSIGNED,
    actor: 'auto-verify',
    payload: { tag: verifyTag, exit_code: verifyExitCode, duration_ms: verifyResult.durationMs },
  });
} catch (e) { /* non-critical */ }
```

- [ ] **Step 6: Workflow finalization (`server/execution/workflow-runtime.js`)**

When workflow completes/fails:

```js
try {
  const { emitTaskEvent } = require('../events/event-emitter');
  const { EVENT_TYPES } = require('../events/event-types');
  emitTaskEvent({
    task_id: workflowId,  // workflow_id used as task_id when scope is workflow
    workflow_id: workflowId,
    type: status === 'completed' ? EVENT_TYPES.WORKFLOW_COMPLETED : EVENT_TYPES.WORKFLOW_FAILED,
    actor: 'workflow-runtime',
    payload: { task_count: tasks.length, failed_count: failedCount },
  });
} catch (e) { /* non-critical */ }
```

- [ ] **Step 7: Integration test**

Create `server/tests/event-replay.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { listEvents } = require('../events/event-emitter');

let db, testDir;
beforeAll(() => { const e = setupTestDb('event-replay'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('event log captures full task lifecycle', () => {
  it('emits create + queued + running + completed for a happy-path task', () => {
    const taskId = require('crypto').randomUUID();
    db.createTask({
      id: taskId, task_description: 'x', working_directory: testDir, status: 'pending', provider: 'codex',
    });
    db.updateTaskStatus(taskId, 'queued');
    db.updateTaskStatus(taskId, 'running');
    db.updateTaskStatus(taskId, 'completed', { exit_code: 0 });

    const events = listEvents({ task_id: taskId });
    const types = events.map(e => e.type);
    expect(types).toContain('task.created');
    expect(types).toContain('task.queued');
    expect(types).toContain('task.running');
    expect(types).toContain('task.completed');
  });
});
```

Run: PASS. Commit:

```bash
git add server/db/task-core.js server/execution/provider-router.js server/db/smart-routing.js server/validation/auto-verify-retry.js server/execution/workflow-runtime.js server/tests/event-replay.test.js
git commit -m "feat(events): emit at status, routing, failover, verify, workflow sites"
git push --no-verify origin main
```

---

## Task 3: MCP query tools + REST

- [ ] **Step 1: Tool defs**

Create `server/tool-defs/event-defs.js`:

```js
'use strict';
const EVENT_TOOLS = [
  {
    name: 'list_task_events',
    description: 'List the typed event log for a task (or workflow). Use this for replay, debugging, and audit trails.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        workflow_id: { type: 'string' },
        type: { type: 'string' },
        since: { type: 'string', description: 'ISO8601 timestamp' },
        limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
      },
    },
  },
];
module.exports = { EVENT_TOOLS };
```

- [ ] **Step 2: Handler**

Create `server/handlers/event-handlers.js`:

```js
'use strict';

const { listEvents } = require('../events/event-emitter');

function handleListTaskEvents(args) {
  const events = listEvents({
    task_id: args.task_id || null,
    workflow_id: args.workflow_id || null,
    type: args.type || null,
    since: args.since || null,
    limit: args.limit || 1000,
  });
  const text = `Found ${events.length} event(s):\n\n` +
    events.map(e => `- [${e.ts}] ${e.type} (${e.actor || 'unknown'}) → ${e.task_id?.slice(0, 8)}`).join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredData: { events },
  };
}

module.exports = { handleListTaskEvents };
```

- [ ] **Step 3: Wire dispatch + REST**

In `server/tools.js`:
```js
case 'list_task_events': {
  const { handleListTaskEvents } = require('./handlers/event-handlers');
  return handleListTaskEvents(args);
}
```

In `server/api/routes-passthrough.js`:
```js
{ method: 'GET', path: '/api/v2/events', tool: 'list_task_events', mapQuery: true },
```

Commit + restart:

```bash
git add server/tool-defs/event-defs.js server/tool-defs/index.js server/handlers/event-handlers.js server/tools.js server/api/routes-passthrough.js
git commit -m "feat(events): list_task_events MCP tool + REST"
git push --no-verify origin main
```

---

## Task 4: Docs + smoke

- [ ] **Step 1: `docs/events.md`**

```markdown
# Task Event Log

Every significant runtime moment is recorded as a typed, immutable event in the `task_events` table. The event log is the orchestration boundary — it survives status overwrites, restarts, and DB edits.

## Event types

`task.created` `task.queued` `task.running` `task.completed` `task.failed` `task.cancelled` `task.skipped` `task.requeued` `tool.called` `provider.routed` `provider.failover` `verify.ran` `verify.tag.assigned` `retry.scheduled` `goal_gate.evaluated` `workflow.started` `workflow.completed` `workflow.failed` `budget.breached`

## Querying

```
list_task_events { task_id: "..." }
list_task_events { workflow_id: "...", type: "provider.failover" }
GET /api/v2/events?task_id=...&since=2026-04-11T00:00:00Z
```

## Use cases

- **Replay** — reconstruct exactly what happened to a task, in order
- **Debugging** — find the moment a provider switched, a verify tag was assigned, a retry fired
- **Audit** — immutable trail of who did what, when (`actor` field)
- **Sidecar services** — retros, dashboard live updates, metrics — all consume events
```

- [ ] **Step 2: `await_restart`, smoke test**

Submit a small task. After completion, call `list_task_events { task_id: "..." }`. Expect at least: `task.created`, `provider.routed`, `task.running`, `task.completed`, `verify.tag.assigned`.

```bash
git add docs/events.md
git commit -m "docs(events): typed event backbone guide"
git push --no-verify origin main
```
