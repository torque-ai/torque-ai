# Fabro #100: Action-First State Machine + Fork Recovery (Burr)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an **action-first state machine** primitive where each action declares `reads`, `writes`, and a pure `run(state, inputs)` that returns `(result, statePatch)`. Persist state after each action and support **fork-from-sequence** — rehydrate state at any prior step and continue with different choices. Inspired by Burr.

**Architecture:** `createAction()` factory returns action objects with explicit read/write contracts. `createApplication()` wires actions + transitions + persister. Every `step()` call persists a snapshot keyed by `(app_id, partition_key, sequence_id)`. `fork({ app_id, sequence_id })` loads the snapshot and returns a fresh application that resumes from there. Complements Plan 27 (typed-workflow-state) and Plan 28 (time-travel-replay) by giving a lighter, action-scoped alternative for small stateful agents.

**Tech Stack:** Node.js, better-sqlite3 for persistence, existing DI container. No new deps.

---

## File Structure

**New files:**
- `server/actions/action.js`
- `server/actions/application.js`
- `server/actions/state-persister.js`
- `server/migrations/0XX-action-state-snapshots.sql`
- `server/tests/action.test.js`
- `server/tests/application.test.js`
- `server/tests/state-persister.test.js`

**Modified files:**
- `server/container.js` — register `statePersister`
- `server/handlers/mcp-tools.js` — `action_app_run`, `action_app_fork`, `action_app_history`

---

## Task 1: Action primitive

- [ ] **Step 1: Tests**

Create `server/tests/action.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { createAction } = require('../actions/action');

describe('createAction', () => {
  it('requires reads, writes, run', () => {
    expect(() => createAction({ name: 'x' })).toThrow(/run/);
    expect(() => createAction({ name: 'x', run: async () => {} })).toThrow(/reads/);
  });

  it('enforces that run only reads declared keys (strict mode)', async () => {
    const a = createAction({
      name: 'greet', reads: ['name'], writes: ['greeting'],
      run: async (state) => ({ result: null, patch: { greeting: `hi ${state.name}` } }),
    });
    const { result, patch } = await a.invoke({ name: 'alice' });
    expect(patch.greeting).toBe('hi alice');
  });

  it('rejects patch containing undeclared writes', async () => {
    const a = createAction({
      name: 'bad', reads: [], writes: ['a'],
      run: async () => ({ result: null, patch: { a: 1, b: 2 } }),
    });
    await expect(a.invoke({})).rejects.toThrow(/undeclared write.*b/);
  });

  it('action metadata exposed for introspection', () => {
    const a = createAction({ name: 'sum', reads: ['x', 'y'], writes: ['z'], run: async () => ({ result: 0, patch: { z: 0 } }) });
    expect(a.name).toBe('sum');
    expect(a.reads).toEqual(['x', 'y']);
    expect(a.writes).toEqual(['z']);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/actions/action.js`:

```js
'use strict';

function createAction({ name, reads, writes, run }) {
  if (!name) throw new Error('action: name required');
  if (typeof run !== 'function') throw new Error('action: run(state,inputs) required');
  if (!Array.isArray(reads)) throw new Error('action: reads array required');
  if (!Array.isArray(writes)) throw new Error('action: writes array required');

  const writeSet = new Set(writes);

  async function invoke(state, inputs = {}) {
    const view = {};
    for (const k of reads) view[k] = state[k];
    const out = await run(view, inputs);
    if (!out || typeof out !== 'object') throw new Error(`action ${name}: run must return {result,patch}`);
    const patch = out.patch || {};
    for (const k of Object.keys(patch)) {
      if (!writeSet.has(k)) throw new Error(`action ${name}: undeclared write "${k}"`);
    }
    return { result: out.result ?? null, patch };
  }

  return { name, reads: reads.slice(), writes: writes.slice(), invoke };
}

module.exports = { createAction };
```

Run tests → PASS. Commit: `feat(actions): action primitive with explicit read/write contract`.

---

## Task 2: Persister + application + fork

- [ ] **Step 1: Migration**

Create `server/migrations/0XX-action-state-snapshots.sql`:

```sql
CREATE TABLE action_state_snapshots (
  app_id TEXT NOT NULL,
  partition_key TEXT NOT NULL DEFAULT '',
  sequence_id INTEGER NOT NULL,
  action_name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, partition_key, sequence_id)
);

CREATE INDEX idx_action_snapshots_app ON action_state_snapshots(app_id, sequence_id);
```

- [ ] **Step 2: Persister tests**

Create `server/tests/state-persister.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createStatePersister } = require('../actions/state-persister');

describe('statePersister', () => {
  let db, p;
  beforeEach(() => {
    db = setupTestDb(['0XX-action-state-snapshots.sql']);
    p = createStatePersister({ db });
  });

  it('save + load latest', () => {
    p.save({ app_id: 'app1', sequence_id: 0, action_name: 'init', state: { a: 1 } });
    p.save({ app_id: 'app1', sequence_id: 1, action_name: 'bump', state: { a: 2 } });
    const latest = p.loadLatest({ app_id: 'app1' });
    expect(latest.sequence_id).toBe(1);
    expect(latest.state).toEqual({ a: 2 });
  });

  it('loadAt retrieves a specific sequence', () => {
    p.save({ app_id: 'app1', sequence_id: 0, action_name: 'init', state: { a: 1 } });
    p.save({ app_id: 'app1', sequence_id: 1, action_name: 'bump', state: { a: 2 } });
    expect(p.loadAt({ app_id: 'app1', sequence_id: 0 }).state).toEqual({ a: 1 });
  });

  it('history returns ordered list', () => {
    p.save({ app_id: 'a', sequence_id: 0, action_name: 'x', state: {} });
    p.save({ app_id: 'a', sequence_id: 1, action_name: 'y', state: {} });
    expect(p.history({ app_id: 'a' }).map(h => h.action_name)).toEqual(['x', 'y']);
  });
});
```

- [ ] **Step 3: Implement persister + application**

Create `server/actions/state-persister.js`:

```js
'use strict';

function createStatePersister({ db }) {
  return {
    save({ app_id, partition_key = '', sequence_id, action_name, state, result = null }) {
      db.prepare(`
        INSERT INTO action_state_snapshots (app_id,partition_key,sequence_id,action_name,state_json,result_json,created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(app_id, partition_key, sequence_id, action_name, JSON.stringify(state), result === null ? null : JSON.stringify(result), Date.now());
    },
    loadLatest({ app_id, partition_key = '' }) {
      const row = db.prepare(`SELECT * FROM action_state_snapshots WHERE app_id=? AND partition_key=? ORDER BY sequence_id DESC LIMIT 1`).get(app_id, partition_key);
      return row ? hydrate(row) : undefined;
    },
    loadAt({ app_id, partition_key = '', sequence_id }) {
      const row = db.prepare(`SELECT * FROM action_state_snapshots WHERE app_id=? AND partition_key=? AND sequence_id=?`).get(app_id, partition_key, sequence_id);
      return row ? hydrate(row) : undefined;
    },
    history({ app_id, partition_key = '' }) {
      return db.prepare(`SELECT * FROM action_state_snapshots WHERE app_id=? AND partition_key=? ORDER BY sequence_id ASC`).all(app_id, partition_key).map(hydrate);
    },
  };
}

function hydrate(row) {
  return {
    app_id: row.app_id, partition_key: row.partition_key, sequence_id: row.sequence_id,
    action_name: row.action_name, state: JSON.parse(row.state_json),
    result: row.result_json ? JSON.parse(row.result_json) : null, created_at: row.created_at,
  };
}

module.exports = { createStatePersister };
```

Create `server/actions/application.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createApplication({ actions, transitions, initialState = {}, persister, app_id = `app_${randomUUID().slice(0, 10)}`, partition_key = '', resumeFrom = null }) {
  const actionMap = new Map(actions.map(a => [a.name, a]));
  let state = { ...initialState };
  let sequence_id = 0;

  if (resumeFrom !== null && persister) {
    const snap = persister.loadAt({ app_id, partition_key, sequence_id: resumeFrom });
    if (!snap) throw new Error(`no snapshot at sequence_id=${resumeFrom}`);
    state = snap.state;
    sequence_id = resumeFrom + 1;
  }

  async function step(actionName, inputs = {}) {
    const action = actionMap.get(actionName);
    if (!action) throw new Error(`unknown action: ${actionName}`);
    const { result, patch } = await action.invoke(state, inputs);
    state = { ...state, ...patch };
    if (persister) persister.save({ app_id, partition_key, sequence_id, action_name: actionName, state, result });
    sequence_id += 1;
    return { result, nextState: { ...state } };
  }

  function nextAction() {
    const t = transitions[arguments.length ? arguments[0] : lastAction()];
    if (!t) return null;
    for (const { when, next } of t) {
      if (!when || when(state)) return next;
    }
    return null;
  }
  function lastAction() {
    return persister?.loadLatest({ app_id, partition_key })?.action_name;
  }

  return { app_id, partition_key, step, getState: () => ({ ...state }), getSequence: () => sequence_id, nextAction };
}

function fork({ app_id, sequence_id, persister, actions, transitions, new_app_id = `app_${randomUUID().slice(0, 10)}` }) {
  const snap = persister.loadAt({ app_id, sequence_id });
  if (!snap) throw new Error(`no snapshot at ${app_id}:${sequence_id}`);
  return createApplication({ actions, transitions, initialState: snap.state, persister, app_id: new_app_id });
}

module.exports = { createApplication, fork };
```

- [ ] **Step 4: Application test**

Create `server/tests/application.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/setup-test-db');
const { createStatePersister } = require('../actions/state-persister');
const { createAction } = require('../actions/action');
const { createApplication, fork } = require('../actions/application');

describe('application + fork', () => {
  let db, persister;
  beforeEach(() => {
    db = setupTestDb(['0XX-action-state-snapshots.sql']);
    persister = createStatePersister({ db });
  });

  it('persists + resumes from a sequence_id', async () => {
    const inc = createAction({
      name: 'inc', reads: ['n'], writes: ['n'],
      run: async (s) => ({ result: s.n + 1, patch: { n: (s.n || 0) + 1 } }),
    });
    const app = createApplication({ actions: [inc], transitions: {}, initialState: { n: 0 }, persister, app_id: 'a1' });
    await app.step('inc'); // n=1
    await app.step('inc'); // n=2
    await app.step('inc'); // n=3
    expect(app.getState().n).toBe(3);

    const branch = fork({ app_id: 'a1', sequence_id: 0, persister, actions: [inc], transitions: {}, new_app_id: 'b1' });
    await branch.step('inc');
    expect(branch.getState().n).toBe(2); // forked from snapshot where n=1 after step 0
    expect(persister.loadLatest({ app_id: 'a1' }).state.n).toBe(3); // original untouched
  });
});
```

Run tests → PASS. Commit: `feat(actions): application runtime + per-step persister + fork(app_id, seq)`.

---

## Task 3: MCP surface

- [ ] **Step 1: Register tools**

In `server/handlers/mcp-tools.js`:

```js
action_app_run: {
  description: 'Create and run an action application. Actions are registered JS (vm2-sandboxed).',
  inputSchema: {
    type: 'object',
    required: ['actions', 'initial_state'],
    properties: {
      actions: { type: 'array', items: { type: 'object', required: ['name', 'reads', 'writes', 'run_js'], properties: { name: { type: 'string' }, reads: { type: 'array' }, writes: { type: 'array' }, run_js: { type: 'string' } } } },
      transitions: { type: 'object' },
      initial_state: { type: 'object' },
      app_id: { type: 'string' },
    },
  },
},
action_app_fork: {
  description: 'Fork an existing app at a given sequence_id into a new app.',
  inputSchema: { type: 'object', required: ['app_id', 'sequence_id'], properties: { app_id: { type: 'string' }, sequence_id: { type: 'number' }, new_app_id: { type: 'string' } } },
},
action_app_history: {
  description: 'Return the ordered history of snapshots for an app.',
  inputSchema: { type: 'object', required: ['app_id'], properties: { app_id: { type: 'string' }, partition_key: { type: 'string' } } },
},
```

Smoke: run a 3-step counter app → fork at sequence 0 → confirm branch diverges, original untouched.

Commit: `feat(actions): MCP surface for action-app run/fork/history`.
