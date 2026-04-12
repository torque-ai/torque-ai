# Fabro #53: Scoped Error Boundary Events (Camunda)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate **technical failures** (timeouts, network errors, crashes — handled by retry/activities/Plan 31) from **business errors** (expected exception paths authored into the workflow). Business errors are thrown with a named code and caught by **boundary error events** at the nearest enclosing scope, triggering a declarative recovery branch. Inspired by Camunda 8.

**Architecture:** A task can `throw_business_error(code, payload)` — creating a `business_error` event on its workflow. The workflow engine walks up the DAG looking for a `boundary_error_handler` node whose `catches` list matches the code. If found, execution routes into the handler's branch; if not, an **incident** is raised (operator-visible, non-failing). Technical errors keep the existing retry + failure-class flow untouched.

**Tech Stack:** Node.js, existing workflow engine. Builds on Plans 4 (failure classes), 14 (events), 26 (crew), 31 (activities), 40 (detached children).

---

## File Structure

**New files:**
- `server/migrations/0NN-business-errors.sql`
- `server/workflows/error-boundary.js` — scope resolution
- `server/workflows/incident-manager.js` — incident creation + dashboard surface
- `server/tests/error-boundary.test.js`
- `server/tests/incident-manager.test.js`
- `dashboard/src/views/Incidents.jsx`

**Modified files:**
- `server/tool-defs/workflow-defs.js` — add `catches` + `boundary` config on tasks
- `server/execution/task-finalizer.js` — detect business_error output, route
- `server/handlers/mcp-tools.js` — `throw_business_error` tool

---

## Task 1: Migration + incident store

- [ ] **Step 1: Migration**

`server/migrations/0NN-business-errors.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_incidents (
  incident_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  task_id TEXT,
  error_code TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'handled' | 'resolved' | 'abandoned'
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON workflow_incidents(status);
```

- [ ] **Step 2: Tests**

Create `server/tests/incident-manager.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createIncidentManager } = require('../workflows/incident-manager');

describe('incidentManager', () => {
  let db, mgr;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','running')`).run();
    mgr = createIncidentManager({ db });
  });

  it('raise creates an open incident', () => {
    const id = mgr.raise({ workflowId: 'wf-1', errorCode: 'BudgetExceeded', payload: { amount: 500 } });
    expect(id).toMatch(/^inc_/);
    const row = db.prepare(`SELECT * FROM workflow_incidents WHERE incident_id = ?`).get(id);
    expect(row.status).toBe('open');
    expect(JSON.parse(row.payload_json).amount).toBe(500);
  });

  it('resolve marks incident resolved', () => {
    const id = mgr.raise({ workflowId: 'wf-1', errorCode: 'X', payload: {} });
    mgr.resolve(id, { resolvedBy: 'operator' });
    const row = db.prepare(`SELECT status FROM workflow_incidents WHERE incident_id = ?`).get(id);
    expect(row.status).toBe('resolved');
  });

  it('list returns only open by default', () => {
    const open = mgr.raise({ workflowId: 'wf-1', errorCode: 'A', payload: {} });
    const closed = mgr.raise({ workflowId: 'wf-1', errorCode: 'B', payload: {} });
    mgr.resolve(closed, {});
    expect(mgr.list().map(i => i.incident_id)).toEqual([open]);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workflows/incident-manager.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createIncidentManager({ db }) {
  function raise({ workflowId, taskId = null, errorCode, payload = null }) {
    const id = `inc_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO workflow_incidents (incident_id, workflow_id, task_id, error_code, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, workflowId, taskId, errorCode, payload ? JSON.stringify(payload) : null);
    return id;
  }

  function resolve(incidentId, { resolvedBy = null } = {}) {
    db.prepare(`
      UPDATE workflow_incidents SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now')
      WHERE incident_id = ?
    `).run(resolvedBy, incidentId);
  }

  function markHandled(incidentId) {
    db.prepare(`UPDATE workflow_incidents SET status = 'handled' WHERE incident_id = ?`).run(incidentId);
  }

  function list({ status = 'open' } = {}) {
    return db.prepare(`SELECT * FROM workflow_incidents WHERE status = ? ORDER BY created_at DESC`).all(status);
  }

  return { raise, resolve, markHandled, list };
}

module.exports = { createIncidentManager };
```

Run tests → PASS. Commit: `feat(incidents): incident store with raise/resolve/handled`.

---

## Task 2: Error boundary resolution

- [ ] **Step 1: Tests**

Create `server/tests/error-boundary.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { findMatchingHandler } = require('../workflows/error-boundary');

describe('findMatchingHandler', () => {
  let db;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','running')`).run();
  });

  function seedTask({ id, scope = null, metadata = {} }) {
    db.prepare(`INSERT INTO tasks (task_id, workflow_id, node_id, scope, metadata, status) VALUES (?,?,?,?,?,?)`)
      .run(id, 'wf-1', id, scope, JSON.stringify(metadata), 'pending');
  }

  it('finds a handler in the immediate scope', () => {
    seedTask({ id: 't1', scope: 'main' });
    seedTask({ id: 't2-handler', scope: 'main', metadata: { boundary: true, catches: ['BudgetExceeded'] } });
    const handler = findMatchingHandler(db, 'wf-1', 't1', 'BudgetExceeded');
    expect(handler?.task_id).toBe('t2-handler');
  });

  it('falls through to parent scope when immediate scope has no match', () => {
    seedTask({ id: 'root-handler', scope: null, metadata: { boundary: true, catches: ['AuthFailed'] } });
    seedTask({ id: 'inner', scope: 'subscope', metadata: {} });
    const handler = findMatchingHandler(db, 'wf-1', 'inner', 'AuthFailed');
    expect(handler?.task_id).toBe('root-handler');
  });

  it('returns null when no handler matches the code in any scope', () => {
    seedTask({ id: 't1', scope: 'main', metadata: { boundary: true, catches: ['X'] } });
    expect(findMatchingHandler(db, 'wf-1', 't1', 'Y')).toBeNull();
  });

  it('wildcard catches: ["*"] matches any code', () => {
    seedTask({ id: 'catchall', scope: 'main', metadata: { boundary: true, catches: ['*'] } });
    seedTask({ id: 'inner', scope: 'main', metadata: {} });
    const handler = findMatchingHandler(db, 'wf-1', 'inner', 'BananaError');
    expect(handler?.task_id).toBe('catchall');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workflows/error-boundary.js`:

```js
'use strict';

function findMatchingHandler(db, workflowId, sourceTaskId, errorCode) {
  const source = db.prepare('SELECT scope FROM tasks WHERE task_id = ? AND workflow_id = ?').get(sourceTaskId, workflowId);
  if (!source) return null;

  // Walk scopes outward: start with source.scope, then parent scopes (dot-separated)
  const scopesToCheck = scopesUp(source.scope);
  for (const scope of scopesToCheck) {
    const candidates = db.prepare(`
      SELECT task_id, node_id, metadata FROM tasks
      WHERE workflow_id = ? AND (scope = ? OR (? IS NULL AND scope IS NULL))
    `).all(workflowId, scope, scope);

    for (const c of candidates) {
      let meta;
      try { meta = c.metadata ? JSON.parse(c.metadata) : {}; } catch { meta = {}; }
      if (!meta.boundary) continue;
      const catches = Array.isArray(meta.catches) ? meta.catches : [];
      if (catches.includes(errorCode) || catches.includes('*')) {
        return { task_id: c.task_id, node_id: c.node_id };
      }
    }
  }
  return null;
}

function scopesUp(scope) {
  const list = [scope];
  let cur = scope;
  while (cur && cur.includes('.')) {
    cur = cur.split('.').slice(0, -1).join('.');
    list.push(cur);
  }
  list.push(null); // root scope
  return list;
}

module.exports = { findMatchingHandler, scopesUp };
```

Run tests → PASS. Commit: `feat(boundary): scope-walking handler resolver`.

---

## Task 3: Wire into finalizer + MCP tool

- [ ] **Step 1: Migration — add scope column**

Add `ALTER TABLE tasks ADD COLUMN scope TEXT` to the previous migration (or in its own).

- [ ] **Step 2: Task-def fields**

In `server/tool-defs/workflow-defs.js`:

```js
boundary: { type: 'boolean', description: 'Mark this node as a boundary error handler.' },
catches: { type: 'array', items: { type: 'string' }, description: 'Error codes this handler catches. Use "*" for any.' },
scope: { type: 'string', description: 'Dot-separated scope name. Used to resolve nearest matching boundary handler.' },
```

- [ ] **Step 3: MCP tool**

```js
throw_business_error: {
  description: 'Throw a named business error from a running task. The workflow engine will route to the nearest matching boundary handler.',
  inputSchema: {
    type: 'object',
    required: ['task_id', 'error_code'],
    properties: {
      task_id: { type: 'string' },
      error_code: { type: 'string' },
      payload: { type: 'object' },
    },
  },
},
```

Handler:

```js
case 'throw_business_error': {
  const task = defaultContainer.get('db').prepare('SELECT * FROM tasks WHERE task_id = ?').get(args.task_id);
  if (!task) return { ok: false, error: 'unknown task' };
  const { findMatchingHandler } = require('../workflows/error-boundary');
  const handler = findMatchingHandler(defaultContainer.get('db'), task.workflow_id, args.task_id, args.error_code);
  if (handler) {
    // Enqueue handler task
    defaultContainer.get('queueScheduler').enqueueTask(handler.task_id, {
      business_error_context: { error_code: args.error_code, payload: args.payload, thrown_by: args.task_id },
    });
    // Mark source task as "handled" (not failed)
    defaultContainer.get('db').prepare(`UPDATE tasks SET status = 'handled_by_boundary' WHERE task_id = ?`).run(args.task_id);
    return { ok: true, routed_to: handler.task_id };
  }
  // No handler: raise incident
  const incidentId = defaultContainer.get('incidentManager').raise({
    workflowId: task.workflow_id, taskId: args.task_id,
    errorCode: args.error_code, payload: args.payload,
  });
  defaultContainer.get('db').prepare(`UPDATE tasks SET status = 'incident' WHERE task_id = ?`).run(args.task_id);
  return { ok: true, incident_id: incidentId };
}
```

Commit: `feat(boundary): throw_business_error routes to handler or raises incident`.

---

## Task 4: Incident dashboard

- [ ] **Step 1: REST**

```js
router.get('/incidents', (req, res) => {
  const status = req.query.status || 'open';
  res.json({ incidents: defaultContainer.get('incidentManager').list({ status }) });
});

router.post('/incidents/:id/resolve', express.json(), (req, res) => {
  defaultContainer.get('incidentManager').resolve(req.params.id, { resolvedBy: req.body?.resolved_by || 'dashboard' });
  res.json({ ok: true });
});
```

- [ ] **Step 2: Dashboard**

`Incidents.jsx` lists open incidents with workflow, error_code, payload summary, and a Resolve button.

`await_restart`. Smoke: workflow with an inner task that calls `throw_business_error({error_code:'BudgetExceeded'})` plus a sibling `boundary: true, catches: ['BudgetExceeded']` node that logs the error. Confirm routing works. Remove the handler and re-run; confirm an incident is raised.

Commit: `feat(incidents): REST + dashboard for open-incident triage`.
