> **STALE — needs rewrite (2026-05-01).** Current task table + decision_log already cover ~70% of this. Refresh focus: gap analysis vs existing decision_log + workflow_checkpoints (shipped via fabro-28) before deciding to extend or build a parallel store.

# Fabro #29: Event-History-Backed Workflow Replay (Temporal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist every workflow as an append-only event journal — task-started, task-output, state-patched, dependency-unblocked, etc. — and use that journal as the source of truth for recovery, audit, and deterministic replay. Inspired by Temporal's Event History.

**Architecture:** A new `workflow_events` table records one row per significant runtime event with monotonically increasing `seq` per workflow. Events are written by a `journal-writer.js` module called from `task-startup.js`, `task-finalizer.js`, `workflow-state.js`, and the dependency unblocker. On restart the workflow runtime can call `replayWorkflow(workflowId)` to reconstruct in-memory state from events alone (no reliance on cached aggregates). A `GET /api/workflows/:id/events` route exposes the history; the dashboard adds a "raw event log" tab.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 14 (typed event backbone), 27 (typed state), 28 (checkpoints).

---

## File Structure

**New files:**
- `server/migrations/0NN-workflow-events.sql`
- `server/journal/journal-writer.js`
- `server/journal/journal-replay.js`
- `server/tests/journal-writer.test.js`
- `server/tests/journal-replay.test.js`
- `dashboard/src/views/WorkflowEventLog.jsx`

**Modified files:**
- `server/execution/task-startup.js` — emit `task_started` event
- `server/execution/task-finalizer.js` — emit `task_completed` / `task_failed`, `state_patched`
- `server/workflow-state/workflow-state.js` — emit `state_patched` (move into module)
- `server/execution/dependency-resolver.js` (or equivalent) — emit `dependency_unblocked`
- `server/api/routes/workflows.js` — `GET /:id/events`
- `dashboard/src/views/WorkflowDetail.jsx` — events tab link

---

## Task 1: Migration

- [ ] **Step 1: Create migration**

`server/migrations/0NN-workflow-events.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  step_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, seq),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_wf_seq ON workflow_events(workflow_id, seq);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON workflow_events(event_type);
CREATE INDEX IF NOT EXISTS idx_workflow_events_task ON workflow_events(task_id);
```

Commit: `feat(journal): workflow_events table for event-sourced replay`.

---

## Task 2: Journal writer

- [ ] **Step 1: Tests**

Create `server/tests/journal-writer.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createJournalWriter } = require('../journal/journal-writer');

describe('journalWriter', () => {
  let db, journal;
  beforeEach(() => {
    db = setupTestDb();
    journal = createJournalWriter({ db });
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1', 't', 'running')`).run();
  });

  it('write assigns monotonically increasing seq per workflow', () => {
    const e1 = journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    const e2 = journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    const e3 = journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't2' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('seq counters are independent per workflow', () => {
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-2', 't', 'running')`).run();
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    const first = journal.write({ workflowId: 'wf-2', type: 'task_started', taskId: 'tA' });
    expect(first.seq).toBe(1);
  });

  it('payload is serialized as JSON', () => {
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { delta: { count: 1 } } });
    const row = db.prepare('SELECT payload_json FROM workflow_events WHERE workflow_id = ? LIMIT 1').get('wf-1');
    expect(JSON.parse(row.payload_json).delta.count).toBe(1);
  });

  it('readJournal returns all events in seq order', () => {
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { x: 1 } });
    const events = journal.readJournal('wf-1');
    expect(events.map(e => e.event_type)).toEqual(['task_started', 'task_completed', 'state_patched']);
  });

  it('write is atomic — concurrent writes get distinct seq values', () => {
    // Simulated: 10 parallel writes (single-threaded JS but exercises the SQL transaction)
    const seqs = [];
    for (let i = 0; i < 10; i++) {
      seqs.push(journal.write({ workflowId: 'wf-1', type: 'noop' }).seq);
    }
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(seqs).size).toBe(10);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/journal/journal-writer.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

const VALID_EVENT_TYPES = new Set([
  'workflow_created',
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'task_created',
  'task_started',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_retried',
  'dependency_unblocked',
  'state_patched',
  'state_validation_failed',
  'checkpoint_taken',
  'fork_created',
  'noop', // for tests
]);

function createJournalWriter({ db, logger = console }) {
  // SQLite transaction guarantees seq monotonicity per workflow
  const writeStmt = db.prepare(`
    INSERT INTO workflow_events (event_id, workflow_id, seq, event_type, task_id, step_id, payload_json)
    VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM workflow_events WHERE workflow_id = ?), 0) + 1, ?, ?, ?, ?)
  `);
  const readSeqStmt = db.prepare(`SELECT seq FROM workflow_events WHERE event_id = ?`);

  function write({ workflowId, type, taskId = null, stepId = null, payload = null }) {
    if (!VALID_EVENT_TYPES.has(type)) {
      logger.warn?.('unknown event type, recording anyway', { type });
    }
    const eventId = `ev_${randomUUID().slice(0, 12)}`;
    const tx = db.transaction(() => {
      writeStmt.run(
        eventId,
        workflowId,
        workflowId,
        type,
        taskId,
        stepId,
        payload ? JSON.stringify(payload) : null,
      );
      return readSeqStmt.get(eventId).seq;
    });
    const seq = tx();
    return { event_id: eventId, seq };
  }

  function readJournal(workflowId, { fromSeq = null, toSeq = null } = {}) {
    let sql = 'SELECT * FROM workflow_events WHERE workflow_id = ?';
    const params = [workflowId];
    if (fromSeq !== null) { sql += ' AND seq >= ?'; params.push(fromSeq); }
    if (toSeq !== null) { sql += ' AND seq <= ?'; params.push(toSeq); }
    sql += ' ORDER BY seq ASC';
    return db.prepare(sql).all(...params).map(row => ({
      ...row,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    }));
  }

  return { write, readJournal };
}

module.exports = { createJournalWriter, VALID_EVENT_TYPES };
```

Run tests → PASS. Commit: `feat(journal): writer with per-workflow monotonic seq`.

---

## Task 3: Replay reconstructs state

- [ ] **Step 1: Tests**

Create `server/tests/journal-replay.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createJournalWriter } = require('../journal/journal-writer');
const { replayWorkflow } = require('../journal/journal-replay');

describe('replayWorkflow', () => {
  let db, journal;
  beforeEach(() => {
    db = setupTestDb();
    journal = createJournalWriter({ db });
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1', 't', 'running')`).run();
  });

  it('reconstructs task statuses from start/complete/fail events', () => {
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't2' });
    journal.write({ workflowId: 'wf-1', type: 'task_failed', taskId: 't2', payload: { reason: 'oom' } });

    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.tasks.t1.status).toBe('completed');
    expect(replay.tasks.t2.status).toBe('failed');
    expect(replay.tasks.t2.failure_payload.reason).toBe('oom');
  });

  it('reconstructs state by folding state_patched events through reducers', () => {
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { count: 1 }, reducers: { count: 'numeric_sum' } } });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { count: 2 }, reducers: { count: 'numeric_sum' } } });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { tag: 'x' }, reducers: { tag: 'replace' } } });

    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.state).toEqual({ count: 3, tag: 'x' });
  });

  it('records last event seq seen', () => {
    for (let i = 0; i < 4; i++) journal.write({ workflowId: 'wf-1', type: 'noop' });
    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.last_seq).toBe(4);
  });

  it('can replay up to a specific seq (point-in-time view)', () => {
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } } });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } } });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } } });

    const replay = replayWorkflow({ db, workflowId: 'wf-1', toSeq: 2 });
    expect(replay.state.x).toBe(2);
    expect(replay.last_seq).toBe(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/journal/journal-replay.js`:

```js
'use strict';
const { reduceState } = require('../workflow-state/reducers');
const { createJournalWriter } = require('./journal-writer');

function replayWorkflow({ db, workflowId, toSeq = null }) {
  const journal = createJournalWriter({ db });
  const events = journal.readJournal(workflowId, { toSeq });

  const tasks = {};
  let state = {};
  let unblocked = new Set();

  for (const ev of events) {
    switch (ev.event_type) {
      case 'task_created':
        tasks[ev.task_id] = { status: 'pending', payload: ev.payload || {} };
        break;
      case 'task_started':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'running', started_at: ev.created_at };
        break;
      case 'task_completed':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'completed', completed_at: ev.created_at, output: ev.payload?.output };
        break;
      case 'task_failed':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'failed', failed_at: ev.created_at, failure_payload: ev.payload };
        break;
      case 'task_cancelled':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'cancelled' };
        break;
      case 'state_patched': {
        const patch = ev.payload?.patch || {};
        const reducers = ev.payload?.reducers || {};
        state = reduceState(state, patch, reducers);
        break;
      }
      case 'dependency_unblocked':
        unblocked.add(ev.task_id);
        break;
      // workflow_*, noop, etc. are observability-only here
    }
  }

  return {
    workflow_id: workflowId,
    tasks,
    state,
    unblocked: Array.from(unblocked),
    last_seq: events.length ? events[events.length - 1].seq : 0,
    event_count: events.length,
  };
}

module.exports = { replayWorkflow };
```

Run tests → PASS. Commit: `feat(journal): replay reconstructs state from events`.

---

## Task 4: Wire emit calls into runtime

- [ ] **Step 1: Container registration**

In `server/container.js`:

```js
container.factory('journalWriter', (c) => {
  const { createJournalWriter } = require('./journal/journal-writer');
  return createJournalWriter({ db: c.get('db'), logger: c.get('logger') });
});
```

- [ ] **Step 2: Emit from task-startup**

In `server/execution/task-startup.js` after a task transitions to running:

```js
const journal = defaultContainer.get('journalWriter');
if (task.workflow_id) {
  journal.write({
    workflowId: task.workflow_id,
    type: 'task_started',
    taskId,
    stepId: task.node_id || null,
    payload: { provider: task.provider, model: task.model },
  });
}
```

- [ ] **Step 3: Emit from task-finalizer**

In `server/execution/task-finalizer.js` for both completion and failure paths:

```js
const journal = defaultContainer.get('journalWriter');
if (task.workflow_id) {
  if (status === 'completed') {
    journal.write({
      workflowId: task.workflow_id, type: 'task_completed', taskId, stepId: task.node_id,
      payload: { exit_code: rawExitCode, has_output: !!finalOutput },
    });
  } else if (status === 'failed') {
    journal.write({
      workflowId: task.workflow_id, type: 'task_failed', taskId, stepId: task.node_id,
      payload: { failure_class: failureClass, error_output: errorOutput },
    });
  }
}
```

- [ ] **Step 4: Emit state_patched**

In `server/workflow-state/workflow-state.js` `applyPatch` — accept an optional `journal` and emit:

```js
function applyPatch(workflowId, patch) {
  // ... existing logic ...
  if (journal) {
    journal.write({
      workflowId, type: 'state_patched',
      payload: { patch, reducers: getMeta(workflowId).reducers },
    });
  }
  return { ok: true, state: next };
}
```

Wire `journalWriter` into the `createWorkflowState` factory in container.js.

- [ ] **Step 5: Emit dependency_unblocked**

In `server/execution/dependency-resolver.js` (or wherever a task transitions from blocked to runnable) after the unblock:

```js
journal.write({
  workflowId: task.workflow_id, type: 'dependency_unblocked', taskId: task.task_id,
  payload: { unblocked_at: new Date().toISOString() },
});
```

Commit: `feat(journal): emit task lifecycle + state events from runtime`.

---

## Task 5: REST + dashboard

- [ ] **Step 1: REST**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/events', (req, res) => {
  const journal = defaultContainer.get('journalWriter');
  const fromSeq = req.query.from_seq ? parseInt(req.query.from_seq, 10) : null;
  const toSeq = req.query.to_seq ? parseInt(req.query.to_seq, 10) : null;
  res.json({ workflow_id: req.params.id, events: journal.readJournal(req.params.id, { fromSeq, toSeq }) });
});

router.get('/:id/replay', (req, res) => {
  const { replayWorkflow } = require('../../journal/journal-replay');
  const toSeq = req.query.to_seq ? parseInt(req.query.to_seq, 10) : null;
  res.json(replayWorkflow({ db: defaultContainer.get('db'), workflowId: req.params.id, toSeq }));
});
```

- [ ] **Step 2: Dashboard log view**

Create `dashboard/src/views/WorkflowEventLog.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowEventLog() {
  const { id } = useParams();
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch(`/api/workflows/${id}/events`).then(r => r.json()).then(d => setEvents(d.events || []));
  }, [id]);

  const filtered = filter ? events.filter(e => e.event_type.includes(filter) || e.task_id?.includes(filter)) : events;

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-2">Event log: {id}</h2>
      <input
        placeholder="filter by event_type or task_id"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="border rounded px-2 py-1 mb-3 w-full max-w-md"
      />
      <table className="w-full text-sm">
        <thead className="bg-gray-100"><tr>
          <th className="text-left px-2 py-1 w-12">seq</th>
          <th className="text-left px-2 py-1">type</th>
          <th className="text-left px-2 py-1">task</th>
          <th className="text-left px-2 py-1">payload</th>
          <th className="text-left px-2 py-1">at</th>
        </tr></thead>
        <tbody>
          {filtered.map(e => (
            <tr key={e.event_id} className="border-t">
              <td className="px-2 py-1 font-mono">{e.seq}</td>
              <td className="px-2 py-1 font-mono">{e.event_type}</td>
              <td className="px-2 py-1 font-mono text-xs">{e.task_id || '-'}</td>
              <td className="px-2 py-1 font-mono text-xs max-w-md truncate">{e.payload ? JSON.stringify(e.payload) : ''}</td>
              <td className="px-2 py-1 text-xs text-gray-500">{e.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Add route + link from `WorkflowDetail.jsx`.

`await_restart`. Smoke: run any workflow, then call `GET /api/workflows/<id>/events` and `GET /api/workflows/<id>/replay`. Confirm replayed state matches `GET /api/workflows/<id>/state` from Plan 27.

Commit: `feat(journal): REST + dashboard for event history and replay`.
