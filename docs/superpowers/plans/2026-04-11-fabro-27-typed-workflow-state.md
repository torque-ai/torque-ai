# Fabro #27: Typed Shared Workflow State (LangGraph StateGraph)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every workflow a typed, shared state object that tasks can read and mutate via reducers, instead of passing data only through task outputs and metadata. Inspired by LangGraph's StateGraph.

**Architecture:** A workflow declares a `state_schema` (JSON Schema) and optional `state_reducers` (per-field merge strategies: `replace`, `append`, `merge_object`, `last_write_wins`, `numeric_sum`). The state is persisted in a new `workflow_state` table keyed by `workflow_id`. Each task reads the current state via `$state.<path>` interpolation in its prompt and may emit a `state_patch` JSON in its output that is reduced into the state at completion. Downstream tasks see the merged state. The state survives restarts and is queryable from the dashboard.

**Tech Stack:** Node.js, better-sqlite3, Ajv, existing workflow engine. Builds on plans 14 (typed event backbone) and 23 (typed signatures).

---

## File Structure

**New files:**
- `server/workflow-state/workflow-state.js` — read/write/reduce module
- `server/workflow-state/reducers.js` — built-in reducer implementations
- `server/workflow-state/state-interpolator.js` — `$state.path` substitution in prompts
- `server/migrations/0NN-workflow-state.sql`
- `server/tests/workflow-state.test.js`
- `server/tests/state-reducers.test.js`
- `dashboard/src/views/WorkflowState.jsx` — readonly inspector

**Modified files:**
- `server/handlers/workflow/index.js` — accept `state_schema` + `state_reducers`
- `server/tool-defs/workflow-defs.js`
- `server/execution/task-startup.js` — interpolate `$state.*` into prompt
- `server/execution/task-finalizer.js` — extract `state_patch` from output, reduce
- `server/api/routes/workflows.js` — `GET /api/workflows/:id/state`
- `dashboard/src/views/WorkflowDetail.jsx` — link to state inspector

---

## Task 1: Migration + table

- [ ] **Step 1: Create migration**

`server/migrations/0NN-workflow-state.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_state (
  workflow_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL DEFAULT '{}',
  schema_json TEXT,
  reducers_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_state_updated ON workflow_state(updated_at);
```

- [ ] **Step 2: Run migration test**

```bash
npm run migrate -- --test && sqlite3 .torque/test.db ".schema workflow_state"
```

Expected: schema printed.

Commit: `feat(workflow-state): migration for typed shared workflow state`.

---

## Task 2: Reducer implementations

- [ ] **Step 1: Tests**

Create `server/tests/state-reducers.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { reduceField } = require('../workflow-state/reducers');

describe('reduceField', () => {
  it('replace: new value overwrites old', () => {
    expect(reduceField('replace', 'old', 'new')).toBe('new');
    expect(reduceField('replace', { a: 1 }, { b: 2 })).toEqual({ b: 2 });
  });

  it('append: pushes new value (or values) onto array', () => {
    expect(reduceField('append', [1, 2], 3)).toEqual([1, 2, 3]);
    expect(reduceField('append', [1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
    expect(reduceField('append', undefined, 'x')).toEqual(['x']);
  });

  it('merge_object: shallow merge, new values win', () => {
    expect(reduceField('merge_object', { a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    expect(reduceField('merge_object', null, { x: 1 })).toEqual({ x: 1 });
  });

  it('last_write_wins: same as replace but explicit semantics', () => {
    expect(reduceField('last_write_wins', 'a', 'b')).toBe('b');
  });

  it('numeric_sum: adds numeric values, treats undefined as 0', () => {
    expect(reduceField('numeric_sum', 5, 3)).toBe(8);
    expect(reduceField('numeric_sum', undefined, 7)).toBe(7);
    expect(reduceField('numeric_sum', 10, undefined)).toBe(10);
  });

  it('unknown reducer falls back to replace', () => {
    expect(reduceField('not_a_reducer', 'old', 'new')).toBe('new');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workflow-state/reducers.js`:

```js
'use strict';

function reduceField(strategy, current, incoming) {
  switch (strategy) {
    case 'append': {
      const base = Array.isArray(current) ? current : (current === undefined ? [] : [current]);
      return Array.isArray(incoming) ? base.concat(incoming) : base.concat([incoming]);
    }
    case 'merge_object': {
      const base = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
      const inc = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) ? incoming : {};
      return { ...base, ...inc };
    }
    case 'numeric_sum': {
      const a = typeof current === 'number' ? current : 0;
      const b = typeof incoming === 'number' ? incoming : 0;
      return a + b;
    }
    case 'last_write_wins':
    case 'replace':
    default:
      return incoming === undefined ? current : incoming;
  }
}

function reduceState(currentState, patch, reducers = {}) {
  const next = { ...currentState };
  for (const [key, value] of Object.entries(patch || {})) {
    const strategy = reducers[key] || 'replace';
    next[key] = reduceField(strategy, currentState[key], value);
  }
  return next;
}

module.exports = { reduceField, reduceState };
```

Run tests → PASS. Commit: `feat(workflow-state): per-field reducer strategies`.

---

## Task 3: State module (read/write)

- [ ] **Step 1: Tests**

Create `server/tests/workflow-state.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkflowState } = require('../workflow-state/workflow-state');

describe('workflowState', () => {
  let ws, db;
  beforeEach(() => {
    db = setupTestDb();
    ws = createWorkflowState({ db });
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1', 'test', 'created')`).run();
  });

  it('getState returns empty object for new workflow', () => {
    expect(ws.getState('wf-1')).toEqual({});
  });

  it('setStateSchema persists schema and reducers', () => {
    ws.setStateSchema('wf-1', { type: 'object', properties: { count: { type: 'integer' } } }, { count: 'numeric_sum' });
    const row = db.prepare('SELECT schema_json, reducers_json FROM workflow_state WHERE workflow_id = ?').get('wf-1');
    expect(JSON.parse(row.schema_json).properties.count.type).toBe('integer');
    expect(JSON.parse(row.reducers_json).count).toBe('numeric_sum');
  });

  it('applyPatch merges per reducers', () => {
    ws.setStateSchema('wf-1', null, { count: 'numeric_sum', tags: 'append' });
    ws.applyPatch('wf-1', { count: 3, tags: ['a'] });
    ws.applyPatch('wf-1', { count: 2, tags: ['b'] });
    expect(ws.getState('wf-1')).toEqual({ count: 5, tags: ['a', 'b'] });
  });

  it('applyPatch validates against schema and rejects invalid patches', () => {
    ws.setStateSchema('wf-1', { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false }, {});
    const result = ws.applyPatch('wf-1', { count: 'not a number' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/count/);
  });

  it('version increments on each applyPatch', () => {
    ws.setStateSchema('wf-1', null, {});
    ws.applyPatch('wf-1', { a: 1 });
    ws.applyPatch('wf-1', { b: 2 });
    const row = db.prepare('SELECT version FROM workflow_state WHERE workflow_id = ?').get('wf-1');
    expect(row.version).toBe(3); // initial 1 + 2 patches
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workflow-state/workflow-state.js`:

```js
'use strict';
const Ajv = require('ajv');
const { reduceState } = require('./reducers');
const ajv = new Ajv({ strict: false, allErrors: true });

function createWorkflowState({ db }) {
  function ensureRow(workflowId) {
    db.prepare(`
      INSERT OR IGNORE INTO workflow_state (workflow_id, state_json, version, updated_at)
      VALUES (?, '{}', 1, datetime('now'))
    `).run(workflowId);
  }

  function getState(workflowId) {
    const row = db.prepare('SELECT state_json FROM workflow_state WHERE workflow_id = ?').get(workflowId);
    if (!row) return {};
    try { return JSON.parse(row.state_json); } catch { return {}; }
  }

  function getMeta(workflowId) {
    const row = db.prepare('SELECT schema_json, reducers_json FROM workflow_state WHERE workflow_id = ?').get(workflowId);
    if (!row) return { schema: null, reducers: {} };
    return {
      schema: row.schema_json ? safeParse(row.schema_json) : null,
      reducers: row.reducers_json ? safeParse(row.reducers_json) : {},
    };
  }

  function setStateSchema(workflowId, schema, reducers) {
    ensureRow(workflowId);
    db.prepare(`
      UPDATE workflow_state SET schema_json = ?, reducers_json = ?, updated_at = datetime('now')
      WHERE workflow_id = ?
    `).run(
      schema ? JSON.stringify(schema) : null,
      reducers ? JSON.stringify(reducers) : null,
      workflowId,
    );
  }

  function applyPatch(workflowId, patch) {
    ensureRow(workflowId);
    const { schema, reducers } = getMeta(workflowId);
    const current = getState(workflowId);
    const next = reduceState(current, patch, reducers);

    if (schema) {
      const validate = ajv.compile(schema);
      if (!validate(next)) {
        return { ok: false, errors: validate.errors.map(e => `${e.instancePath || e.schemaPath}: ${e.message}`) };
      }
    }

    db.prepare(`
      UPDATE workflow_state SET state_json = ?, version = version + 1, updated_at = datetime('now')
      WHERE workflow_id = ?
    `).run(JSON.stringify(next), workflowId);
    return { ok: true, state: next };
  }

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  return { getState, getMeta, setStateSchema, applyPatch };
}

module.exports = { createWorkflowState };
```

Run tests → PASS. Commit: `feat(workflow-state): typed state module with Ajv validation`.

---

## Task 4: `$state.*` interpolation

- [ ] **Step 1: Tests**

Add to `server/tests/workflow-state.test.js`:

```js
const { interpolateState } = require('../workflow-state/state-interpolator');

describe('interpolateState', () => {
  it('replaces $state.path tokens with values from state', () => {
    const state = { user: { name: 'Alice' }, counts: [1, 2, 3] };
    expect(interpolateState('Hello $state.user.name, you have $state.counts.length items', state))
      .toBe('Hello Alice, you have 3 items');
  });

  it('serializes objects/arrays as JSON', () => {
    const state = { config: { mode: 'fast' } };
    expect(interpolateState('Config: $state.config', state)).toBe('Config: {"mode":"fast"}');
  });

  it('leaves missing paths as <undefined> sentinel', () => {
    expect(interpolateState('Value: $state.missing.path', {})).toBe('Value: <undefined>');
  });

  it('does not touch text without $state. tokens', () => {
    expect(interpolateState('No tokens here', { a: 1 })).toBe('No tokens here');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workflow-state/state-interpolator.js`:

```js
'use strict';

function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === 'length' && (Array.isArray(cur) || typeof cur === 'string')) return cur.length;
    cur = cur[p];
  }
  return cur;
}

function interpolateState(text, state) {
  if (typeof text !== 'string' || !text.includes('$state.')) return text;
  return text.replace(/\$state\.([a-zA-Z0-9_.]+)/g, (_, path) => {
    const value = getPath(state, path);
    if (value === undefined) return '<undefined>';
    if (value === null) return 'null';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

module.exports = { interpolateState };
```

Run tests → PASS. Commit: `feat(workflow-state): $state.path interpolation in prompts`.

---

## Task 5: Wire into task lifecycle

- [ ] **Step 1: Tool def — accept state_schema/state_reducers**

In `server/tool-defs/workflow-defs.js` workflow create schema:

```js
state_schema: { type: 'object', description: 'JSON Schema for shared workflow state.' },
state_reducers: {
  type: 'object',
  description: 'Map of field name to reducer strategy: replace | append | merge_object | last_write_wins | numeric_sum.',
  additionalProperties: { type: 'string', enum: ['replace', 'append', 'merge_object', 'last_write_wins', 'numeric_sum'] },
},
```

- [ ] **Step 2: Workflow handler**

In `server/handlers/workflow/index.js`, after a workflow is created:

```js
if (params.state_schema || params.state_reducers) {
  const ws = defaultContainer.get('workflowState');
  ws.setStateSchema(workflowId, params.state_schema || null, params.state_reducers || {});
}
```

- [ ] **Step 3: Task startup — interpolate**

In `server/execution/task-startup.js` after the prompt is built:

```js
const { interpolateState } = require('../workflow-state/state-interpolator');
const ws = defaultContainer.get('workflowState');
if (task.workflow_id) {
  const state = ws.getState(task.workflow_id);
  task.task_description = interpolateState(task.task_description, state);
}
```

- [ ] **Step 4: Task finalizer — extract patch**

In `server/execution/task-finalizer.js` after the task completes successfully:

```js
const ws = defaultContainer.get('workflowState');
if (task.workflow_id && finalOutput) {
  const patch = extractStatePatch(finalOutput);
  if (patch) {
    const result = ws.applyPatch(task.workflow_id, patch);
    if (!result.ok) {
      logger.warn('state patch validation failed', { taskId, errors: result.errors });
      // Tag the task but don't fail it — patch was best-effort
      addTaskTag(taskId, 'state:invalid_patch');
    } else {
      addTaskTag(taskId, 'state:patched');
    }
  }
}

function extractStatePatch(output) {
  // Look for ```json with a "state_patch" key, or trailing JSON block
  const blockMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
  if (blockMatch) {
    try {
      const obj = JSON.parse(blockMatch[1]);
      return obj.state_patch || null;
    } catch { return null; }
  }
  return null;
}
```

- [ ] **Step 5: Container registration**

In `server/container.js`:

```js
container.factory('workflowState', (c) => {
  const { createWorkflowState } = require('./workflow-state/workflow-state');
  return createWorkflowState({ db: c.get('db') });
});
```

Commit: `feat(workflow-state): wire state into task startup + finalizer`.

---

## Task 6: REST + dashboard

- [ ] **Step 1: REST route**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/state', (req, res) => {
  const ws = defaultContainer.get('workflowState');
  const state = ws.getState(req.params.id);
  const meta = ws.getMeta(req.params.id);
  res.json({ workflow_id: req.params.id, state, schema: meta.schema, reducers: meta.reducers });
});
```

- [ ] **Step 2: Dashboard inspector**

Create `dashboard/src/views/WorkflowState.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowState() {
  const { id } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}/state`)
      .then(r => r.json())
      .then(setData);
  }, [id]);

  if (!data) return <div className="p-4">Loading…</div>;
  return (
    <div className="p-4 max-w-4xl">
      <h2 className="text-xl font-semibold mb-3">Workflow State: {id}</h2>
      <section className="mb-4">
        <h3 className="font-medium mb-1">Current state</h3>
        <pre className="bg-gray-900 text-gray-100 p-3 rounded text-xs overflow-auto">{JSON.stringify(data.state, null, 2)}</pre>
      </section>
      {data.schema && (
        <section className="mb-4">
          <h3 className="font-medium mb-1">Schema</h3>
          <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto">{JSON.stringify(data.schema, null, 2)}</pre>
        </section>
      )}
      {data.reducers && Object.keys(data.reducers).length > 0 && (
        <section>
          <h3 className="font-medium mb-1">Reducers</h3>
          <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto">{JSON.stringify(data.reducers, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
```

Add a route in `dashboard/src/App.jsx` and a link from `WorkflowDetail.jsx` (`<Link to={\`/workflows/\${id}/state\`}>State</Link>`).

`await_restart`. Smoke: create a workflow with `state_schema: { type: 'object', properties: { round: { type: 'integer' } } }` and `state_reducers: { round: 'numeric_sum' }`. Submit two tasks that emit `{"state_patch": {"round": 1}}`. Confirm `/api/workflows/<id>/state` shows `round: 2`.

Commit: `feat(workflow-state): REST + dashboard inspector for shared state`.
