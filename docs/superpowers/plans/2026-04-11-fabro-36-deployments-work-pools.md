# Fabro #36: Deployments + Work Pools (Prefect)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate the **what** of a workflow (its definition, in code) from the **how + where** of running it (provider, schedule, parameters, concurrency, target work pool). A `deployment` is a server-side object with all the operational metadata; the same workflow definition can have many deployments. **Work pools** are the named lanes that workers pull from. Inspired by Prefect.

**Architecture:** New `deployments` table stores `{ deployment_id, workflow_id, name, parameters_json, schedule_cron, work_pool, default_provider, concurrency_limit, version }`. New `work_pools` table stores `{ pool_name, kind: 'local'|'remote', max_concurrent, queue_priorities }`. A modified scheduler reads pending tasks and assigns them to a pool — workers (local or remote) pull from the pool they're attached to. Operators promote a workflow across environments by adding a deployment with a different work pool (e.g., `prod-pool` instead of `dev-pool`) without changing the workflow code.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 1 (workflow-as-code), 33 (concurrency keys).

---

## File Structure

**New files:**
- `server/migrations/0NN-deployments.sql`
- `server/migrations/0NN-work-pools.sql`
- `server/deployments/deployment-store.js`
- `server/deployments/work-pool-store.js`
- `server/deployments/runner.js` — execute deployment-style runs
- `server/tests/deployment-store.test.js`
- `server/tests/work-pool-store.test.js`
- `dashboard/src/views/Deployments.jsx`
- `dashboard/src/views/WorkPools.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — `create_deployment`, `run_deployment`, `set_deployment_schedule`
- `server/tool-defs/workflow-defs.js`
- `server/execution/queue-scheduler.js` — pool-aware dispatch
- `server/api/routes/deployments.js`

---

## Task 1: Migrations + stores

- [ ] **Step 1: Migrations**

`server/migrations/0NN-deployments.sql`:

```sql
CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parameters_json TEXT,
  schedule_cron TEXT,
  schedule_timezone TEXT DEFAULT 'UTC',
  work_pool TEXT,
  default_provider TEXT,
  concurrency_limit INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, name)
);

CREATE INDEX IF NOT EXISTS idx_deployments_pool ON deployments(work_pool);
CREATE INDEX IF NOT EXISTS idx_deployments_workflow ON deployments(workflow_id);
```

`server/migrations/0NN-work-pools.sql`:

```sql
CREATE TABLE IF NOT EXISTS work_pools (
  pool_name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'local' | 'remote' | 'managed'
  description TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited
  queue_priorities_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks ADD COLUMN work_pool TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_work_pool ON tasks(work_pool, status);
```

- [ ] **Step 2: Tests**

Create `server/tests/deployment-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createDeploymentStore } = require('../deployments/deployment-store');

describe('deploymentStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','created')`).run();
    store = createDeploymentStore({ db });
  });

  it('create returns a new deployment_id', () => {
    const id = store.create({ workflowId: 'wf-1', name: 'prod', defaultProvider: 'codex' });
    expect(id).toMatch(/^dep_/);
    const got = store.get(id);
    expect(got.workflow_id).toBe('wf-1');
    expect(got.name).toBe('prod');
  });

  it('uniqueness on (workflow_id, name)', () => {
    store.create({ workflowId: 'wf-1', name: 'prod' });
    expect(() => store.create({ workflowId: 'wf-1', name: 'prod' })).toThrow();
  });

  it('updateParameters stamps updated_at', () => {
    const id = store.create({ workflowId: 'wf-1', name: 'staging' });
    store.updateParameters(id, { region: 'us-east-1' });
    const got = store.get(id);
    expect(JSON.parse(got.parameters_json).region).toBe('us-east-1');
  });

  it('listForWorkflow returns enabled deployments by default', () => {
    store.create({ workflowId: 'wf-1', name: 'a' });
    const id2 = store.create({ workflowId: 'wf-1', name: 'b' });
    store.setEnabled(id2, false);
    expect(store.listForWorkflow('wf-1').map(d => d.name)).toEqual(['a']);
    expect(store.listForWorkflow('wf-1', { includeDisabled: true }).map(d => d.name).sort()).toEqual(['a','b']);
  });
});
```

Create `server/tests/work-pool-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createWorkPoolStore } = require('../deployments/work-pool-store');

describe('workPoolStore', () => {
  let db, pools;
  beforeEach(() => {
    db = setupTestDb();
    pools = createWorkPoolStore({ db });
  });

  it('create persists a pool', () => {
    pools.create({ name: 'prod', kind: 'remote', maxConcurrent: 10 });
    const p = pools.get('prod');
    expect(p.kind).toBe('remote');
    expect(p.max_concurrent).toBe(10);
  });

  it('list returns pools sorted by name', () => {
    pools.create({ name: 'b', kind: 'local' });
    pools.create({ name: 'a', kind: 'remote' });
    expect(pools.list().map(p => p.pool_name)).toEqual(['a', 'b']);
  });

  it('countActiveInPool returns active task count', () => {
    pools.create({ name: 'prod', kind: 'local' });
    db.prepare(`INSERT INTO tasks (task_id, work_pool, status) VALUES ('t1','prod','running'),('t2','prod','queued'),('t3','prod','completed')`).run();
    expect(pools.countActiveInPool('prod')).toBe(2);
  });
});
```

- [ ] **Step 3: Implement stores**

Create `server/deployments/deployment-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createDeploymentStore({ db }) {
  function create({ workflowId, name, parameters = null, scheduleCron = null, scheduleTimezone = 'UTC',
                   workPool = null, defaultProvider = null, concurrencyLimit = null }) {
    const id = `dep_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO deployments (deployment_id, workflow_id, name, parameters_json, schedule_cron, schedule_timezone,
        work_pool, default_provider, concurrency_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, name, parameters && JSON.stringify(parameters), scheduleCron, scheduleTimezone,
            workPool, defaultProvider, concurrencyLimit);
    return id;
  }

  function get(id) {
    return db.prepare('SELECT * FROM deployments WHERE deployment_id = ?').get(id);
  }

  function listForWorkflow(workflowId, { includeDisabled = false } = {}) {
    const sql = `SELECT * FROM deployments WHERE workflow_id = ? ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY name`;
    return db.prepare(sql).all(workflowId);
  }

  function listAll({ includeDisabled = false } = {}) {
    const sql = `SELECT * FROM deployments ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY workflow_id, name`;
    return db.prepare(sql).all();
  }

  function updateParameters(id, parameters) {
    db.prepare(`UPDATE deployments SET parameters_json = ?, updated_at = datetime('now') WHERE deployment_id = ?`)
      .run(JSON.stringify(parameters), id);
  }

  function setSchedule(id, cron, timezone = 'UTC') {
    db.prepare(`UPDATE deployments SET schedule_cron = ?, schedule_timezone = ?, updated_at = datetime('now') WHERE deployment_id = ?`)
      .run(cron, timezone, id);
  }

  function setEnabled(id, enabled) {
    db.prepare(`UPDATE deployments SET enabled = ?, updated_at = datetime('now') WHERE deployment_id = ?`)
      .run(enabled ? 1 : 0, id);
  }

  return { create, get, listForWorkflow, listAll, updateParameters, setSchedule, setEnabled };
}

module.exports = { createDeploymentStore };
```

Create `server/deployments/work-pool-store.js`:

```js
'use strict';

function createWorkPoolStore({ db }) {
  function create({ name, kind = 'local', description = null, maxConcurrent = 0, queuePriorities = null }) {
    db.prepare(`
      INSERT INTO work_pools (pool_name, kind, description, max_concurrent, queue_priorities_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, kind, description, maxConcurrent, queuePriorities && JSON.stringify(queuePriorities));
  }

  function get(name) {
    return db.prepare('SELECT * FROM work_pools WHERE pool_name = ?').get(name);
  }

  function list() {
    return db.prepare('SELECT * FROM work_pools ORDER BY pool_name').all();
  }

  function update(name, fields) {
    const allowed = ['kind', 'description', 'max_concurrent'];
    const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (updates.length === 0) return;
    const sql = `UPDATE work_pools SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE pool_name = ?`;
    db.prepare(sql).run(...updates.map(([, v]) => v), name);
  }

  function countActiveInPool(name) {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM tasks WHERE work_pool = ? AND status IN ('running', 'queued')
    `).get(name);
    return row.n;
  }

  function remove(name) {
    db.prepare('DELETE FROM work_pools WHERE pool_name = ?').run(name);
  }

  return { create, get, list, update, countActiveInPool, remove };
}

module.exports = { createWorkPoolStore };
```

Run tests → PASS. Commit: `feat(deployments): deployment + work-pool stores`.

---

## Task 2: Pool-aware scheduler + dispatch

- [ ] **Step 1: Patch scheduler**

In `server/execution/queue-scheduler.js` — when looking for the next task to dispatch:

```js
const pools = defaultContainer.get('workPoolStore');
const allPools = pools.list();

for (const pool of allPools) {
  const max = pool.max_concurrent;
  const active = pools.countActiveInPool(pool.pool_name);
  if (max > 0 && active >= max) {
    logger.debug('pool full, skipping', { pool: pool.pool_name, active, max });
    continue;
  }

  // Find next queued task assigned to this pool
  const task = db.prepare(`
    SELECT * FROM tasks WHERE status = 'queued' AND work_pool = ?
    ORDER BY priority DESC, created_at ASC LIMIT 1
  `).get(pool.pool_name);

  if (task) {
    dispatchTask(task);
  }
}

// Also drain unassigned queued tasks (legacy / no pool)
const unassigned = db.prepare(`SELECT * FROM tasks WHERE status = 'queued' AND work_pool IS NULL ORDER BY priority DESC, created_at ASC LIMIT 1`).get();
if (unassigned) dispatchTask(unassigned);
```

- [ ] **Step 2: Submit honors deployment provider/pool**

In `server/handlers/task/submit.js`:

```js
const workPool = params.work_pool || (deploymentDefaults && deploymentDefaults.work_pool);
db.prepare('UPDATE tasks SET work_pool = ? WHERE task_id = ?').run(workPool || null, taskId);
```

Commit: `feat(deployments): scheduler honors work pools with capacity limits`.

---

## Task 3: MCP tools + run_deployment

- [ ] **Step 1: Tool defs**

In `server/tool-defs/workflow-defs.js`:

```js
create_deployment: {
  description: 'Create a deployment — a named operational instance of a workflow with parameters, schedule, work pool, and provider defaults.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id', 'name'],
    properties: {
      workflow_id: { type: 'string' },
      name: { type: 'string' },
      parameters: { type: 'object' },
      schedule_cron: { type: 'string' },
      schedule_timezone: { type: 'string' },
      work_pool: { type: 'string' },
      default_provider: { type: 'string' },
      concurrency_limit: { type: 'integer' },
    },
  },
},
run_deployment: {
  description: 'Trigger a one-off run of a deployment. Uses the deployment\'s parameters/work_pool/provider as defaults; per-call overrides allowed.',
  inputSchema: {
    type: 'object',
    required: ['deployment_id'],
    properties: {
      deployment_id: { type: 'string' },
      parameter_overrides: { type: 'object' },
    },
  },
},
create_work_pool: {
  description: 'Create a work pool — a named queue lane that workers pull from.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['local', 'remote', 'managed'] },
      max_concurrent: { type: 'integer' },
      description: { type: 'string' },
    },
  },
},
```

- [ ] **Step 2: Handlers**

In `server/handlers/mcp-tools.js`:

```js
case 'create_deployment': {
  const id = defaultContainer.get('deploymentStore').create({
    workflowId: args.workflow_id, name: args.name,
    parameters: args.parameters, scheduleCron: args.schedule_cron, scheduleTimezone: args.schedule_timezone,
    workPool: args.work_pool, defaultProvider: args.default_provider, concurrencyLimit: args.concurrency_limit,
  });
  return { deployment_id: id };
}
case 'create_work_pool': {
  defaultContainer.get('workPoolStore').create({
    name: args.name, kind: args.kind, maxConcurrent: args.max_concurrent, description: args.description,
  });
  return { ok: true };
}
case 'run_deployment': {
  return await defaultContainer.get('deploymentRunner').run(args.deployment_id, args.parameter_overrides || {});
}
```

- [ ] **Step 3: Runner**

Create `server/deployments/runner.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createDeploymentRunner({ db, deploymentStore, runWorkflow }) {
  async function run(deploymentId, parameterOverrides = {}) {
    const dep = deploymentStore.get(deploymentId);
    if (!dep) throw new Error(`Deployment not found: ${deploymentId}`);
    if (!dep.enabled) throw new Error(`Deployment disabled: ${deploymentId}`);

    const params = {
      ...(dep.parameters_json ? JSON.parse(dep.parameters_json) : {}),
      ...parameterOverrides,
    };

    return runWorkflow({
      workflowId: dep.workflow_id,
      parameters: params,
      workPool: dep.work_pool,
      defaultProvider: dep.default_provider,
      concurrencyLimit: dep.concurrency_limit,
      triggeredBy: `deployment:${deploymentId}`,
    });
  }

  return { run };
}

module.exports = { createDeploymentRunner };
```

Container wiring:

```js
container.factory('deploymentStore', (c) => require('./deployments/deployment-store').createDeploymentStore({ db: c.get('db') }));
container.factory('workPoolStore', (c) => require('./deployments/work-pool-store').createWorkPoolStore({ db: c.get('db') }));
container.factory('deploymentRunner', (c) => require('./deployments/runner').createDeploymentRunner({
  db: c.get('db'),
  deploymentStore: c.get('deploymentStore'),
  runWorkflow: c.get('workflowRunner').runOnce,
}));
```

Commit: `feat(deployments): MCP tools for deployment + work-pool lifecycle`.

---

## Task 4: REST + dashboard

- [ ] **Step 1: REST**

Create `server/api/routes/deployments.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.get('/', (req, res) => {
  const includeDisabled = req.query.include_disabled === 'true';
  res.json({ deployments: defaultContainer.get('deploymentStore').listAll({ includeDisabled }) });
});

router.get('/:id', (req, res) => {
  const d = defaultContainer.get('deploymentStore').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
});

router.post('/:id/run', express.json(), async (req, res) => {
  try {
    const result = await defaultContainer.get('deploymentRunner').run(req.params.id, req.body?.parameter_overrides || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

Add `server/api/routes/work-pools.js` similarly.

- [ ] **Step 2: Dashboard views**

Create `dashboard/src/views/Deployments.jsx` (table of all deployments with run/disable/edit-schedule actions) and `dashboard/src/views/WorkPools.jsx` (capacity bars per pool).

`await_restart`. Smoke: create work pool `dev`, create deployment `prod-of-X` pointing at that pool, call `run_deployment({deployment_id})`. Confirm tasks dispatched against the dev pool.

Commit: `feat(deployments): REST + dashboard views`.
