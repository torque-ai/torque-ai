# Fabro #28: Workflow Time-Travel + Forked Debugging (LangGraph)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an operator pick any historical checkpoint of a workflow, optionally edit the state at that point, and re-run the workflow forward from there as a forked branch — without disturbing the original run. Inspired by LangGraph's time-travel + forks.

**Architecture:** Builds on Plan 10 (workflow resume/replay) and Plan 27 (typed workflow state). Adds `workflow_checkpoints` table that snapshots `(workflow_id, step_id, state_json, taken_at)` after each task completion. New REST endpoint `POST /api/workflows/:id/fork` creates a *new* workflow whose state is initialized from the chosen checkpoint and whose DAG resumes execution from that step. Dashboard adds a "checkpoint timeline" with a fork button.

**Tech Stack:** Node.js, better-sqlite3, React. Builds on plans 10, 14, 27.

---

## File Structure

**New files:**
- `server/migrations/0NN-workflow-checkpoints.sql`
- `server/workflow-state/checkpoint-store.js`
- `server/workflow-state/forker.js`
- `server/tests/checkpoint-store.test.js`
- `server/tests/forker.test.js`
- `dashboard/src/views/WorkflowTimeline.jsx`

**Modified files:**
- `server/execution/task-finalizer.js` — write checkpoint after state patch is reduced
- `server/api/routes/workflows.js` — `GET /:id/checkpoints`, `POST /:id/fork`
- `dashboard/src/views/WorkflowDetail.jsx` — link to timeline

---

## Task 1: Migration + checkpoint store

- [ ] **Step 1: Migration**

`server/migrations/0NN-workflow-checkpoints.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_id TEXT,
  task_id TEXT,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  taken_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_wf_time ON workflow_checkpoints(workflow_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_step ON workflow_checkpoints(workflow_id, step_id);
```

- [ ] **Step 2: Tests for checkpoint-store**

Create `server/tests/checkpoint-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createCheckpointStore } = require('../workflow-state/checkpoint-store');

describe('checkpoint-store', () => {
  let store, db;
  beforeEach(() => {
    db = setupTestDb();
    store = createCheckpointStore({ db });
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1', 't', 'running')`).run();
  });

  it('writeCheckpoint persists a snapshot and returns its id', () => {
    const id = store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'plan', taskId: 't-1', state: { x: 1 }, version: 2 });
    expect(id).toMatch(/^cp_/);
    const row = db.prepare('SELECT * FROM workflow_checkpoints WHERE checkpoint_id = ?').get(id);
    expect(JSON.parse(row.state_json)).toEqual({ x: 1 });
    expect(row.state_version).toBe(2);
  });

  it('listCheckpoints returns checkpoints ordered by taken_at', () => {
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'a', state: { v: 1 }, version: 1 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'b', state: { v: 2 }, version: 2 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'c', state: { v: 3 }, version: 3 });
    const list = store.listCheckpoints('wf-1');
    expect(list).toHaveLength(3);
    expect(list.map(c => c.step_id)).toEqual(['a', 'b', 'c']);
  });

  it('getCheckpoint returns full record', () => {
    const id = store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'plan', state: { foo: 'bar' }, version: 1 });
    const cp = store.getCheckpoint(id);
    expect(cp.workflow_id).toBe('wf-1');
    expect(cp.state).toEqual({ foo: 'bar' });
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workflow-state/checkpoint-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createCheckpointStore({ db }) {
  function writeCheckpoint({ workflowId, stepId = null, taskId = null, state, version }) {
    const id = `cp_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO workflow_checkpoints (checkpoint_id, workflow_id, step_id, task_id, state_json, state_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, stepId, taskId, JSON.stringify(state || {}), version || 1);
    return id;
  }

  function listCheckpoints(workflowId) {
    return db.prepare(`
      SELECT checkpoint_id, workflow_id, step_id, task_id, state_version, taken_at
      FROM workflow_checkpoints WHERE workflow_id = ? ORDER BY taken_at ASC
    `).all(workflowId);
  }

  function getCheckpoint(checkpointId) {
    const row = db.prepare('SELECT * FROM workflow_checkpoints WHERE checkpoint_id = ?').get(checkpointId);
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state_json) };
  }

  return { writeCheckpoint, listCheckpoints, getCheckpoint };
}

module.exports = { createCheckpointStore };
```

Run tests → PASS. Commit: `feat(checkpoints): workflow_checkpoints table + store module`.

---

## Task 2: Wire checkpoint capture into finalizer

- [ ] **Step 1: Patch finalizer**

In `server/execution/task-finalizer.js` after a successful `applyPatch` call (Plan 27):

```js
if (result.ok) {
  const checkpointStore = defaultContainer.get('checkpointStore');
  checkpointStore.writeCheckpoint({
    workflowId: task.workflow_id,
    stepId: task.node_id || null,
    taskId,
    state: result.state,
    version: db.prepare('SELECT version FROM workflow_state WHERE workflow_id = ?').get(task.workflow_id)?.version || 1,
  });
}
```

- [ ] **Step 2: Container registration**

In `server/container.js`:

```js
container.factory('checkpointStore', (c) => {
  const { createCheckpointStore } = require('./workflow-state/checkpoint-store');
  return createCheckpointStore({ db: c.get('db') });
});
```

Commit: `feat(checkpoints): write checkpoint after each successful state patch`.

---

## Task 3: Forker

- [ ] **Step 1: Tests**

Create `server/tests/forker.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createForker } = require('../workflow-state/forker');
const { createCheckpointStore } = require('../workflow-state/checkpoint-store');
const { createWorkflowState } = require('../workflow-state/workflow-state');

describe('forker.fork', () => {
  let db, forker, cps, ws;
  beforeEach(() => {
    db = setupTestDb();
    cps = createCheckpointStore({ db });
    ws = createWorkflowState({ db });
    forker = createForker({ db, checkpointStore: cps, workflowState: ws });

    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-orig', 'orig', 'completed')`).run();
    db.prepare(`INSERT INTO tasks (task_id, workflow_id, node_id, status, task_description) VALUES
      ('t1', 'wf-orig', 'plan', 'completed', 'plan'),
      ('t2', 'wf-orig', 'build', 'completed', 'build'),
      ('t3', 'wf-orig', 'verify', 'completed', 'verify')`).run();
    db.prepare(`INSERT INTO workflow_dependencies (workflow_id, task_id, depends_on_task_id) VALUES
      ('wf-orig', 't2', 't1'),
      ('wf-orig', 't3', 't2')`).run();

    ws.setStateSchema('wf-orig', null, { logs: 'append' });
    ws.applyPatch('wf-orig', { logs: ['plan done'] });
    cps.writeCheckpoint({ workflowId: 'wf-orig', stepId: 'plan', state: { logs: ['plan done'] }, version: 2 });
    ws.applyPatch('wf-orig', { logs: ['build done'] });
    cps.writeCheckpoint({ workflowId: 'wf-orig', stepId: 'build', state: { logs: ['plan done', 'build done'] }, version: 3 });
  });

  it('forks from a checkpoint with a new workflow_id and seeded state', () => {
    const cp = cps.listCheckpoints('wf-orig')[0]; // after 'plan'
    const result = forker.fork({ checkpointId: cp.checkpoint_id, name: 'forked-1' });

    expect(result.new_workflow_id).toMatch(/^wf_/);
    expect(result.new_workflow_id).not.toBe('wf-orig');
    expect(result.resumes_from_step).toBe('plan');
    expect(ws.getState(result.new_workflow_id)).toEqual({ logs: ['plan done'] });
  });

  it('clones tasks and dependencies for steps after the fork point', () => {
    const cp = cps.listCheckpoints('wf-orig')[0]; // after 'plan' — fork should re-run build + verify
    const result = forker.fork({ checkpointId: cp.checkpoint_id });

    const clonedTasks = db.prepare(`SELECT node_id, status FROM tasks WHERE workflow_id = ? ORDER BY node_id`).all(result.new_workflow_id);
    const stepIds = clonedTasks.map(t => t.node_id);
    expect(stepIds).toContain('build');
    expect(stepIds).toContain('verify');
    expect(stepIds).not.toContain('plan'); // already done at checkpoint
    expect(clonedTasks.every(t => t.status === 'pending')).toBe(true);
  });

  it('applies state_overrides on fork', () => {
    const cp = cps.listCheckpoints('wf-orig')[1]; // after 'build'
    const result = forker.fork({
      checkpointId: cp.checkpoint_id,
      state_overrides: { logs: ['rewritten'] },
    });
    expect(ws.getState(result.new_workflow_id)).toEqual({ logs: ['rewritten'] });
  });
});
```

- [ ] **Step 2: Implement**

Create `server/workflow-state/forker.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createForker({ db, checkpointStore, workflowState }) {
  function fork({ checkpointId, name = null, state_overrides = null }) {
    const cp = checkpointStore.getCheckpoint(checkpointId);
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);

    const newWorkflowId = `wf_${randomUUID().slice(0, 12)}`;
    const origWorkflow = db.prepare('SELECT * FROM workflows WHERE workflow_id = ?').get(cp.workflow_id);
    if (!origWorkflow) throw new Error(`Source workflow ${cp.workflow_id} not found`);

    db.prepare(`
      INSERT INTO workflows (workflow_id, name, status, created_at, parent_workflow_id, fork_checkpoint_id)
      VALUES (?, ?, 'created', datetime('now'), ?, ?)
    `).run(newWorkflowId, name || `${origWorkflow.name} (fork)`, cp.workflow_id, checkpointId);

    // Seed state from checkpoint
    const meta = workflowState.getMeta(cp.workflow_id);
    workflowState.setStateSchema(newWorkflowId, meta.schema, meta.reducers);
    const seedState = state_overrides || cp.state;
    db.prepare('UPDATE workflow_state SET state_json = ?, version = ? WHERE workflow_id = ?')
      .run(JSON.stringify(seedState), cp.state_version, newWorkflowId);

    // Determine which steps come AFTER the fork point
    const allSteps = db.prepare(`
      SELECT task_id, node_id, task_description, provider, model, kind, metadata
      FROM tasks WHERE workflow_id = ? ORDER BY rowid
    `).all(cp.workflow_id);

    const completedAtForkTime = db.prepare(`
      SELECT DISTINCT step_id FROM workflow_checkpoints
      WHERE workflow_id = ? AND taken_at <= ?
    `).all(cp.workflow_id, cp.taken_at).map(r => r.step_id);

    const stepIdMap = new Map(); // old task_id -> new task_id
    for (const step of allSteps) {
      if (completedAtForkTime.includes(step.node_id)) continue;
      const newTaskId = `task_${randomUUID().slice(0, 12)}`;
      stepIdMap.set(step.task_id, newTaskId);
      db.prepare(`
        INSERT INTO tasks (task_id, workflow_id, node_id, task_description, provider, model, kind, metadata, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      `).run(newTaskId, newWorkflowId, step.node_id, step.task_description,
             step.provider, step.model, step.kind, step.metadata);
    }

    // Clone deps where both endpoints are in the cloned set
    const deps = db.prepare(`SELECT task_id, depends_on_task_id FROM workflow_dependencies WHERE workflow_id = ?`).all(cp.workflow_id);
    for (const dep of deps) {
      const newTask = stepIdMap.get(dep.task_id);
      const newDep = stepIdMap.get(dep.depends_on_task_id);
      if (newTask && newDep) {
        db.prepare(`INSERT INTO workflow_dependencies (workflow_id, task_id, depends_on_task_id) VALUES (?, ?, ?)`)
          .run(newWorkflowId, newTask, newDep);
      }
    }

    return {
      new_workflow_id: newWorkflowId,
      resumes_from_step: completedAtForkTime[completedAtForkTime.length - 1] || null,
      cloned_step_count: stepIdMap.size,
    };
  }

  return { fork };
}

module.exports = { createForker };
```

Add columns to workflows table if missing — in a follow-on migration:

```sql
ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT;
ALTER TABLE workflows ADD COLUMN fork_checkpoint_id TEXT;
```

Run tests → PASS. Commit: `feat(forker): fork workflow from checkpoint with state seeding + step cloning`.

---

## Task 4: REST endpoints

- [ ] **Step 1: Routes**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/checkpoints', (req, res) => {
  const cps = defaultContainer.get('checkpointStore');
  res.json({ workflow_id: req.params.id, checkpoints: cps.listCheckpoints(req.params.id) });
});

router.post('/:id/fork', express.json(), (req, res) => {
  const { checkpoint_id, name, state_overrides } = req.body || {};
  if (!checkpoint_id) return res.status(400).json({ error: 'checkpoint_id required' });
  try {
    const forker = defaultContainer.get('forker');
    const result = forker.fork({ checkpointId: checkpoint_id, name, state_overrides });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Container**

In `server/container.js`:

```js
container.factory('forker', (c) => {
  const { createForker } = require('./workflow-state/forker');
  return createForker({
    db: c.get('db'),
    checkpointStore: c.get('checkpointStore'),
    workflowState: c.get('workflowState'),
  });
});
```

Commit: `feat(checkpoints): REST endpoints for listing and forking`.

---

## Task 5: Dashboard timeline + fork UI

- [ ] **Step 1: Timeline view**

Create `dashboard/src/views/WorkflowTimeline.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowTimeline() {
  const { id } = useParams();
  const [checkpoints, setCheckpoints] = useState([]);
  const [selected, setSelected] = useState(null);
  const [overrides, setOverrides] = useState('');
  const [forkResult, setForkResult] = useState(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}/checkpoints`).then(r => r.json()).then(d => setCheckpoints(d.checkpoints || []));
  }, [id]);

  async function fork() {
    let stateOverrides = null;
    if (overrides.trim()) {
      try { stateOverrides = JSON.parse(overrides); } catch { alert('overrides must be valid JSON'); return; }
    }
    const r = await fetch(`/api/workflows/${id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpoint_id: selected.checkpoint_id, state_overrides: stateOverrides }),
    });
    setForkResult(await r.json());
  }

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-3">Timeline: {id}</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h3 className="font-medium mb-2">Checkpoints</h3>
          <ul className="space-y-1">
            {checkpoints.map(cp => (
              <li key={cp.checkpoint_id}>
                <button
                  onClick={() => setSelected(cp)}
                  className={`text-left px-2 py-1 rounded w-full ${selected?.checkpoint_id === cp.checkpoint_id ? 'bg-blue-200' : 'hover:bg-gray-100'}`}
                >
                  <div className="text-sm font-mono">{cp.step_id || '(no step)'}</div>
                  <div className="text-xs text-gray-500">{cp.taken_at} · v{cp.state_version}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-medium mb-2">Fork from selected</h3>
          {!selected && <p className="text-sm text-gray-500">Pick a checkpoint to fork from.</p>}
          {selected && (
            <>
              <p className="text-sm mb-2">Forking from <strong>{selected.step_id}</strong> ({selected.taken_at})</p>
              <label className="block text-xs mb-1">Optional state overrides (JSON)</label>
              <textarea value={overrides} onChange={e => setOverrides(e.target.value)} className="w-full h-24 font-mono text-xs border rounded p-2" />
              <button onClick={fork} className="mt-2 px-3 py-1 bg-blue-600 text-white rounded">Create fork</button>
              {forkResult && (
                <pre className="mt-3 bg-gray-900 text-gray-100 p-3 rounded text-xs">{JSON.stringify(forkResult, null, 2)}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

Add route in `dashboard/src/App.jsx`: `<Route path="/workflows/:id/timeline" element={<WorkflowTimeline />} />`. Add link from `WorkflowDetail.jsx`.

`await_restart`. Smoke: create a workflow with state, run it, then call `POST /api/workflows/<id>/fork` with the second checkpoint. Confirm new workflow appears with cloned later steps and seeded state.

Commit: `feat(checkpoints): dashboard timeline + fork UI`.
