# Fabro #30: Signals, Queries, and Updates for Live Workflows (Temporal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split live workflow interaction into three sharply-different contracts — **queries** (cheap, read-only inspections that don't touch history), **signals** (fire-and-forget mutations recorded in the journal), and **updates** (synchronous, tracked mutations whose completion or failure is returned to the caller). Inspired by Temporal.

**Architecture:** A new module `workflow-control.js` exposes `query()`, `signal()`, and `update()` functions over the existing workflow-state + journal layers (Plans 27, 29). Workflows declare named handlers in a `control_handlers` config: `{ queries: { current_round: 'state.round' }, signals: { add_critic: 'state.roles.append' }, updates: { merge_review: 'state.review.merge_object' } }`. REST + MCP surfaces add `POST /api/workflows/:id/control/{query,signal,update}` endpoints. Updates block the caller until the next finalizer cycle stamps a result.

**Tech Stack:** Node.js, Express, MCP. Builds on plans 27 (state), 29 (journal), 14 (events).

---

## File Structure

**New files:**
- `server/control/workflow-control.js` — query/signal/update dispatcher
- `server/control/handler-resolver.js` — parses handler DSL ("state.round", "state.roles.append")
- `server/tests/workflow-control.test.js`
- `server/tests/handler-resolver.test.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `control_handlers` on workflow create
- `server/api/routes/workflows.js` — add 3 control endpoints
- `server/handlers/mcp-tools.js` — register `workflow_query`, `workflow_signal`, `workflow_update`
- `server/tool-defs/workflow-defs.js` — control tool schemas
- `dashboard/src/views/WorkflowDetail.jsx` — control panel

---

## Task 1: Handler resolver

- [ ] **Step 1: Tests**

Create `server/tests/handler-resolver.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { resolveHandler } = require('../control/handler-resolver');

describe('resolveHandler', () => {
  it('parses "state.<path>" as a query', () => {
    const h = resolveHandler('state.user.name');
    expect(h.kind).toBe('query');
    expect(h.statePath).toBe('user.name');
  });

  it('parses "state.<path>.<reducer>" as a write with reducer', () => {
    const h = resolveHandler('state.roles.append');
    expect(h.kind).toBe('write');
    expect(h.statePath).toBe('roles');
    expect(h.reducer).toBe('append');
  });

  it('write reducers must be one of the known set', () => {
    const ok = resolveHandler('state.x.replace');
    expect(ok.reducer).toBe('replace');
    const bad = resolveHandler('state.x.bogus');
    expect(bad).toBeNull();
  });

  it('returns null for malformed handler strings', () => {
    expect(resolveHandler('')).toBeNull();
    expect(resolveHandler('not-a-handler')).toBeNull();
    expect(resolveHandler('state.')).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

Create `server/control/handler-resolver.js`:

```js
'use strict';

const REDUCERS = new Set(['replace', 'append', 'merge_object', 'last_write_wins', 'numeric_sum']);

function resolveHandler(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('state.') || spec === 'state.') return null;

  const rest = spec.slice('state.'.length);
  const parts = rest.split('.');
  if (parts.length === 0 || parts.some(p => p === '')) return null;

  const tail = parts[parts.length - 1];
  if (REDUCERS.has(tail)) {
    if (parts.length < 2) return null;
    return {
      kind: 'write',
      statePath: parts.slice(0, -1).join('.'),
      reducer: tail,
    };
  }

  return { kind: 'query', statePath: parts.join('.') };
}

module.exports = { resolveHandler, REDUCERS };
```

Run tests → PASS. Commit: `feat(control): handler DSL resolver for query/write specs`.

---

## Task 2: Workflow control dispatcher

- [ ] **Step 1: Tests**

Create `server/tests/workflow-control.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkflowState } = require('../workflow-state/workflow-state');
const { createJournalWriter } = require('../journal/journal-writer');
const { createWorkflowControl } = require('../control/workflow-control');

function setupWorkflow(db) {
  db.prepare(`INSERT INTO workflows (workflow_id, name, status, control_handlers_json) VALUES (?, ?, ?, ?)`).run(
    'wf-1',
    'test',
    'running',
    JSON.stringify({
      queries: { current_round: 'state.round', all_logs: 'state.logs' },
      signals: { add_log: 'state.logs.append', set_round: 'state.round.replace' },
      updates: { merge_config: 'state.config.merge_object' },
    }),
  );
}

describe('workflowControl', () => {
  let db, ws, journal, control;
  beforeEach(() => {
    db = setupTestDb();
    ws = createWorkflowState({ db });
    journal = createJournalWriter({ db });
    control = createWorkflowControl({ db, workflowState: ws, journal });
    setupWorkflow(db);
    ws.setStateSchema('wf-1', null, { logs: 'append', round: 'replace', config: 'merge_object' });
  });

  describe('query', () => {
    it('returns the value at the resolved state path', () => {
      ws.applyPatch('wf-1', { round: 7 });
      const r = control.query('wf-1', 'current_round');
      expect(r.ok).toBe(true);
      expect(r.value).toBe(7);
    });

    it('does NOT write to the journal', () => {
      ws.applyPatch('wf-1', { round: 7 });
      const before = journal.readJournal('wf-1').length;
      control.query('wf-1', 'current_round');
      const after = journal.readJournal('wf-1').length;
      expect(after).toBe(before);
    });

    it('errors when the named query is not declared', () => {
      const r = control.query('wf-1', 'unknown');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not registered/i);
    });
  });

  describe('signal', () => {
    it('applies the patch via reducer and journals a signal_received event', () => {
      const r = control.signal('wf-1', 'add_log', 'hello');
      expect(r.ok).toBe(true);
      expect(ws.getState('wf-1').logs).toEqual(['hello']);
      const events = journal.readJournal('wf-1');
      expect(events.some(e => e.event_type === 'signal_received' && e.payload?.signal === 'add_log')).toBe(true);
    });

    it('multiple signals accumulate per reducer', () => {
      control.signal('wf-1', 'add_log', 'a');
      control.signal('wf-1', 'add_log', 'b');
      control.signal('wf-1', 'set_round', 5);
      expect(ws.getState('wf-1')).toEqual({ logs: ['a', 'b'], round: 5 });
    });

    it('errors when the named signal is not declared', () => {
      expect(control.signal('wf-1', 'unknown', 'x').ok).toBe(false);
    });
  });

  describe('update', () => {
    it('applies the patch and returns the new state synchronously', async () => {
      const r = await control.update('wf-1', 'merge_config', { mode: 'fast' });
      expect(r.ok).toBe(true);
      expect(r.state.config).toEqual({ mode: 'fast' });
    });

    it('returns validation error when state schema rejects the patch', async () => {
      ws.setStateSchema('wf-1', { type: 'object', properties: { config: { type: 'string' } } }, { config: 'replace' });
      const r = await control.update('wf-1', 'merge_config', { wrong: 'shape' });
      expect(r.ok).toBe(false);
      expect(r.errors).toBeDefined();
    });

    it('journals an update_applied event', async () => {
      await control.update('wf-1', 'merge_config', { mode: 'safe' });
      const events = journal.readJournal('wf-1');
      expect(events.some(e => e.event_type === 'update_applied' && e.payload?.update === 'merge_config')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Migration for `control_handlers_json`**

`server/migrations/0NN-workflow-control-handlers.sql`:

```sql
ALTER TABLE workflows ADD COLUMN control_handlers_json TEXT;
```

- [ ] **Step 3: Implement**

Create `server/control/workflow-control.js`:

```js
'use strict';
const { resolveHandler } = require('./handler-resolver');
const { reduceField } = require('../workflow-state/reducers');

function getPath(obj, path) {
  if (!path) return obj;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  if (!path) return value;
  const parts = path.split('.');
  const root = { ...obj };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...(cur[parts[i]] || {}) };
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function createWorkflowControl({ db, workflowState, journal }) {
  function loadHandlers(workflowId) {
    const row = db.prepare('SELECT control_handlers_json FROM workflows WHERE workflow_id = ?').get(workflowId);
    if (!row || !row.control_handlers_json) return { queries: {}, signals: {}, updates: {} };
    try {
      const parsed = JSON.parse(row.control_handlers_json);
      return {
        queries: parsed.queries || {},
        signals: parsed.signals || {},
        updates: parsed.updates || {},
      };
    } catch { return { queries: {}, signals: {}, updates: {} }; }
  }

  function query(workflowId, name) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.queries[name];
    if (!spec) return { ok: false, error: `Query '${name}' not registered for workflow ${workflowId}` };
    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'query') return { ok: false, error: `Query '${name}' has invalid handler spec '${spec}'` };
    const state = workflowState.getState(workflowId);
    return { ok: true, value: getPath(state, resolved.statePath) };
  }

  function signal(workflowId, name, value) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.signals[name];
    if (!spec) return { ok: false, error: `Signal '${name}' not registered` };
    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'write') return { ok: false, error: `Signal '${name}' has invalid handler '${spec}'` };

    const state = workflowState.getState(workflowId);
    const current = getPath(state, resolved.statePath);
    const reduced = reduceField(resolved.reducer, current, value);
    const patch = setPath({}, resolved.statePath, reduced);
    // Strip the path so the reducer key matches a top-level field
    const topKey = resolved.statePath.split('.')[0];
    const topPatch = { [topKey]: patch[topKey] };

    const result = workflowState.applyPatch(workflowId, topPatch);
    journal.write({
      workflowId, type: 'signal_received',
      payload: { signal: name, spec, value, applied: result.ok, errors: result.errors },
    });
    return result.ok ? { ok: true } : { ok: false, errors: result.errors };
  }

  async function update(workflowId, name, value) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.updates[name];
    if (!spec) return { ok: false, error: `Update '${name}' not registered` };
    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'write') return { ok: false, error: `Update '${name}' has invalid handler '${spec}'` };

    const state = workflowState.getState(workflowId);
    const current = getPath(state, resolved.statePath);
    const reduced = reduceField(resolved.reducer, current, value);
    const topKey = resolved.statePath.split('.')[0];
    const patch = { [topKey]: setPath({}, resolved.statePath, reduced)[topKey] };

    const result = workflowState.applyPatch(workflowId, patch);
    journal.write({
      workflowId, type: 'update_applied',
      payload: { update: name, spec, value, applied: result.ok, errors: result.errors },
    });
    if (!result.ok) return { ok: false, errors: result.errors };
    return { ok: true, state: result.state };
  }

  return { query, signal, update };
}

module.exports = { createWorkflowControl };
```

Add `signal_received` and `update_applied` to `VALID_EVENT_TYPES` in `server/journal/journal-writer.js`.

Run tests → PASS. Commit: `feat(control): query/signal/update dispatcher`.

---

## Task 3: REST endpoints + container wiring

- [ ] **Step 1: Container**

In `server/container.js`:

```js
container.factory('workflowControl', (c) => {
  const { createWorkflowControl } = require('./control/workflow-control');
  return createWorkflowControl({
    db: c.get('db'),
    workflowState: c.get('workflowState'),
    journal: c.get('journalWriter'),
  });
});
```

- [ ] **Step 2: REST**

In `server/api/routes/workflows.js`:

```js
router.post('/:id/control/query', express.json(), (req, res) => {
  const ctrl = defaultContainer.get('workflowControl');
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(ctrl.query(req.params.id, name));
});

router.post('/:id/control/signal', express.json(), (req, res) => {
  const ctrl = defaultContainer.get('workflowControl');
  const { name, value } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(ctrl.signal(req.params.id, name, value));
});

router.post('/:id/control/update', express.json(), async (req, res) => {
  const ctrl = defaultContainer.get('workflowControl');
  const { name, value } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = await ctrl.update(req.params.id, name, value);
  res.status(r.ok ? 200 : 400).json(r);
});
```

Commit: `feat(control): REST endpoints for query/signal/update`.

---

## Task 4: MCP tools

- [ ] **Step 1: Tool defs**

In `server/tool-defs/workflow-defs.js` add 3 tools:

```js
workflow_query: {
  description: 'Read-only inspection of a running workflow. Returns a value resolved from workflow state. Does not affect execution or history.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id', 'name'],
    properties: {
      workflow_id: { type: 'string' },
      name: { type: 'string', description: 'Name of the registered query handler' },
    },
  },
},
workflow_signal: {
  description: 'Asynchronous fire-and-forget mutation to a running workflow. Recorded in the journal. Returns immediately.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id', 'name'],
    properties: {
      workflow_id: { type: 'string' },
      name: { type: 'string' },
      value: {},
    },
  },
},
workflow_update: {
  description: 'Synchronous tracked mutation. Blocks until the patch is applied or rejected. Returns the new state on success.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id', 'name'],
    properties: {
      workflow_id: { type: 'string' },
      name: { type: 'string' },
      value: {},
    },
  },
},
```

- [ ] **Step 2: Handlers**

In `server/handlers/mcp-tools.js`:

```js
case 'workflow_query': {
  return defaultContainer.get('workflowControl').query(args.workflow_id, args.name);
}
case 'workflow_signal': {
  return defaultContainer.get('workflowControl').signal(args.workflow_id, args.name, args.value);
}
case 'workflow_update': {
  return await defaultContainer.get('workflowControl').update(args.workflow_id, args.name, args.value);
}
```

Commit: `feat(control): MCP tools for workflow_query/signal/update`.

---

## Task 5: Workflow create accepts handlers

- [ ] **Step 1: Schema**

In `server/tool-defs/workflow-defs.js` workflow create:

```js
control_handlers: {
  type: 'object',
  description: 'Named handlers exposing this workflow to live control. queries are read-only; signals are fire-and-forget writes; updates are synchronous tracked writes.',
  properties: {
    queries: { type: 'object', additionalProperties: { type: 'string' } },
    signals: { type: 'object', additionalProperties: { type: 'string' } },
    updates: { type: 'object', additionalProperties: { type: 'string' } },
  },
},
```

- [ ] **Step 2: Handler stores it**

In `server/handlers/workflow/index.js` after the workflow row is inserted:

```js
if (params.control_handlers) {
  db.prepare('UPDATE workflows SET control_handlers_json = ? WHERE workflow_id = ?')
    .run(JSON.stringify(params.control_handlers), workflowId);
}
```

- [ ] **Step 3: Dashboard control panel**

Add a "Control" tab to `dashboard/src/views/WorkflowDetail.jsx` that lists the handler names and provides forms for query/signal/update calls. Show responses inline.

`await_restart`. Smoke: create workflow with `control_handlers: { queries: { count: 'state.count' }, signals: { incr: 'state.count.numeric_sum' } }`, call `workflow_signal({name:'incr', value:1})` three times, then `workflow_query({name:'count'})` and confirm value `3`.

Commit: `feat(control): workflows accept control_handlers + dashboard panel`.
