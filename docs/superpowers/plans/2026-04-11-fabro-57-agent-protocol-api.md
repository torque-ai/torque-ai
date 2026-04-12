# Fabro #57: Agent Protocol External API (AutoGPT)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose TORQUE's workflow runtime through the **Agent Protocol** standard — a vendor-neutral HTTP contract for `POST /ap/v1/agent/tasks`, `POST /ap/v1/agent/tasks/:id/steps`, `GET /ap/v1/agent/tasks/:id/artifacts` — so external agent frontends, benchmarking harnesses (like `agbenchmark`), and third-party orchestrators can drive TORQUE workflows without speaking its internal API. Inspired by AutoGPT's Agent Protocol adoption.

**Architecture:** A new `/ap/v1` Express router maps Agent Protocol verbs onto existing TORQUE primitives: a "task" becomes a workflow run, "steps" become individual nodes, "artifacts" become produced assets (Plan 34) plus files in the working directory. The protocol is a thin translation layer — TORQUE keeps its richer internal model; the protocol surface is just a standardized adapter. Authentication uses Bearer tokens from the existing connection registry (Plan 52).

**Tech Stack:** Node.js, Express, existing workflow runtime. Builds on plans 10 (resume/replay), 34 (assets), 52 (connections).

---

## File Structure

**New files:**
- `server/api/agent-protocol/router.js` — Agent Protocol v1 routes
- `server/api/agent-protocol/translator.js` — TORQUE ↔ Agent Protocol shape mapping
- `server/tests/agent-protocol-translator.test.js`
- `server/tests/agent-protocol-router.test.js`
- `docs/agent-protocol.md`

**Modified files:**
- `server/index.js` — mount `/ap/v1` router
- `server/api/middleware/auth.js` — accept Agent Protocol Bearer tokens

---

## Task 1: Translator

- [ ] **Step 1: Tests**

Create `server/tests/agent-protocol-translator.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { workflowToApTask, nodeToApStep, assetToApArtifact } = require('../api/agent-protocol/translator');

describe('translator.workflowToApTask', () => {
  it('maps status + fields to Agent Protocol shape', () => {
    const wf = {
      workflow_id: 'wf-1', name: 'build-app', status: 'running',
      created_at: '2026-04-12T10:00:00Z',
      input_parameters_json: JSON.stringify({ goal: 'build thing' }),
    };
    const out = workflowToApTask(wf);
    expect(out).toEqual({
      task_id: 'wf-1',
      input: 'build thing',
      additional_input: { goal: 'build thing' },
      artifacts: [],
      created_at: '2026-04-12T10:00:00Z',
      modified_at: undefined,
    });
  });

  it('status=completed maps to task.finished_at', () => {
    const wf = { workflow_id: 'wf-1', name: 'x', status: 'completed', completed_at: '2026-04-12T11:00:00Z', input_parameters_json: '{}' };
    const out = workflowToApTask(wf);
    expect(out.modified_at).toBe('2026-04-12T11:00:00Z');
  });
});

describe('nodeToApStep', () => {
  it('maps TORQUE task row to Agent Protocol step', () => {
    const t = {
      task_id: 'node-1', workflow_id: 'wf-1', node_id: 'plan', status: 'completed',
      task_description: 'Plan the thing', output: 'Did plan',
      created_at: '2026-04-12T10:01:00Z', completed_at: '2026-04-12T10:02:00Z',
    };
    const out = nodeToApStep(t);
    expect(out).toEqual(expect.objectContaining({
      step_id: 'node-1', task_id: 'wf-1', name: 'plan',
      input: 'Plan the thing', output: 'Did plan',
      status: 'completed', is_last: false,
    }));
  });
});

describe('assetToApArtifact', () => {
  it('maps asset materialization to Agent Protocol artifact', () => {
    const m = {
      materialization_id: 'mat-1', asset_key: 'code:src/foo.js',
      task_id: 'n-1', produced_at: '2026-04-12T10:03:00Z',
    };
    const out = assetToApArtifact(m);
    expect(out).toEqual(expect.objectContaining({
      artifact_id: 'mat-1', file_name: 'src/foo.js', agent_created: true,
    }));
  });
});
```

- [ ] **Step 2: Implement**

Create `server/api/agent-protocol/translator.js`:

```js
'use strict';

function parseInput(wf) {
  try { return JSON.parse(wf.input_parameters_json || '{}'); } catch { return {}; }
}

function workflowToApTask(wf) {
  const input = parseInput(wf);
  return {
    task_id: wf.workflow_id,
    input: typeof input.goal === 'string' ? input.goal : (input.input || JSON.stringify(input)),
    additional_input: input,
    artifacts: [],
    created_at: wf.created_at,
    modified_at: wf.completed_at || wf.updated_at,
  };
}

function nodeToApStep(task, { isLast = false } = {}) {
  return {
    step_id: task.task_id,
    task_id: task.workflow_id,
    name: task.node_id || task.task_id,
    input: task.task_description,
    output: task.output,
    status: normalizeStatus(task.status),
    is_last: isLast,
    created_at: task.created_at,
    modified_at: task.completed_at || task.updated_at,
  };
}

function assetToApArtifact(materialization) {
  const key = materialization.asset_key || '';
  const fileName = key.includes(':') ? key.split(':').slice(1).join(':') : key;
  return {
    artifact_id: materialization.materialization_id,
    file_name: fileName,
    relative_path: fileName,
    agent_created: true,
    created_at: materialization.produced_at,
  };
}

function normalizeStatus(s) {
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'cancelled') return 'completed';
  if (s === 'running' || s === 'pending' || s === 'queued') return 'created';
  return s || 'created';
}

module.exports = { workflowToApTask, nodeToApStep, assetToApArtifact, normalizeStatus };
```

Run tests → PASS. Commit: `feat(ap): TORQUE ↔ Agent Protocol translator`.

---

## Task 2: Router

- [ ] **Step 1: Tests**

Create `server/tests/agent-protocol-router.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const request = require('supertest');
const express = require('express');

describe('Agent Protocol router', () => {
  let app, runtimeMock;
  beforeEach(() => {
    runtimeMock = {
      createTaskFromInput: vi.fn(async (input) => ({
        workflow_id: 'wf-new', name: 'generated', status: 'pending',
        input_parameters_json: JSON.stringify({ goal: input }),
        created_at: '2026-04-12T10:00:00Z',
      })),
      listTasks: vi.fn(async () => [
        { workflow_id: 'wf-1', name: 'x', status: 'running', input_parameters_json: '{}', created_at: '2026-04-12T10:00:00Z' },
      ]),
      getTask: vi.fn(async (id) => id === 'wf-1' ? {
        workflow_id: 'wf-1', name: 'x', status: 'running', input_parameters_json: '{}', created_at: '2026-04-12T10:00:00Z',
      } : null),
      executeStep: vi.fn(async (id) => ({
        task_id: 'node-2', workflow_id: id, node_id: 'build', status: 'completed',
        task_description: 'Build', output: 'built',
        created_at: '2026-04-12T10:01:00Z', completed_at: '2026-04-12T10:02:00Z',
      })),
      listArtifacts: vi.fn(async () => []),
    };

    const { createRouter } = require('../api/agent-protocol/router');
    app = express();
    app.use(express.json());
    app.use('/ap/v1', createRouter({ runtime: runtimeMock }));
  });

  it('POST /ap/v1/agent/tasks creates a task', async () => {
    const res = await request(app).post('/ap/v1/agent/tasks').send({ input: 'build a CLI' });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('wf-new');
    expect(res.body.input).toBe('build a CLI');
  });

  it('GET /ap/v1/agent/tasks lists tasks', async () => {
    const res = await request(app).get('/ap/v1/agent/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].task_id).toBe('wf-1');
  });

  it('GET /ap/v1/agent/tasks/:id returns single task', async () => {
    const res = await request(app).get('/ap/v1/agent/tasks/wf-1');
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('wf-1');
  });

  it('GET /ap/v1/agent/tasks/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/ap/v1/agent/tasks/nope');
    expect(res.status).toBe(404);
  });

  it('POST /ap/v1/agent/tasks/:id/steps executes next step', async () => {
    const res = await request(app).post('/ap/v1/agent/tasks/wf-1/steps').send({ input: 'continue' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.name).toBe('build');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/api/agent-protocol/router.js`:

```js
'use strict';
const express = require('express');
const { workflowToApTask, nodeToApStep, assetToApArtifact } = require('./translator');

function createRouter({ runtime, logger = console }) {
  const router = express.Router();

  router.post('/agent/tasks', async (req, res) => {
    try {
      const wf = await runtime.createTaskFromInput(req.body?.input || '', req.body?.additional_input);
      res.json(workflowToApTask(wf));
    } catch (err) {
      logger.warn('ap:create_task failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/agent/tasks', async (req, res) => {
    try {
      const tasks = await runtime.listTasks({
        page: parseInt(req.query.current_page || '1', 10),
        pageSize: parseInt(req.query.page_size || '10', 10),
      });
      res.json({ tasks: tasks.map(workflowToApTask) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/agent/tasks/:id', async (req, res) => {
    const t = await runtime.getTask(req.params.id);
    if (!t) return res.status(404).json({ error: 'task not found' });
    res.json(workflowToApTask(t));
  });

  router.post('/agent/tasks/:id/steps', async (req, res) => {
    try {
      const step = await runtime.executeStep(req.params.id, { input: req.body?.input });
      res.json(nodeToApStep(step, { isLast: step.is_terminal }));
    } catch (err) {
      if (err.code === 'ENOTFOUND') return res.status(404).json({ error: 'task not found' });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/agent/tasks/:id/steps', async (req, res) => {
    const steps = await runtime.listSteps(req.params.id);
    res.json({ steps: steps.map(s => nodeToApStep(s)) });
  });

  router.get('/agent/tasks/:id/artifacts', async (req, res) => {
    const arts = await runtime.listArtifacts(req.params.id);
    res.json({ artifacts: arts.map(assetToApArtifact) });
  });

  router.get('/agent/tasks/:id/artifacts/:artifact_id', async (req, res) => {
    const content = await runtime.readArtifact(req.params.id, req.params.artifact_id);
    if (!content) return res.status(404).json({ error: 'artifact not found' });
    res.type(content.mime || 'application/octet-stream').send(content.body);
  });

  return router;
}

module.exports = { createRouter };
```

Run tests → PASS. Commit: `feat(ap): Agent Protocol v1 router over TORQUE runtime`.

---

## Task 3: Runtime adapter + mount

- [ ] **Step 1: Adapter**

Create `server/api/agent-protocol/runtime-adapter.js`:

```js
'use strict';

function createRuntimeAdapter({ db, workflowRunner, assetStore }) {
  async function createTaskFromInput(input, additionalInput = {}) {
    const wfId = await workflowRunner.createSingleNode({
      name: `ap-${Date.now()}`,
      task_description: input,
      additional_input: additionalInput,
    });
    return db.prepare('SELECT * FROM workflows WHERE workflow_id = ?').get(wfId);
  }

  async function listTasks({ page = 1, pageSize = 10 } = {}) {
    return db.prepare(`SELECT * FROM workflows ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
  }

  async function getTask(id) {
    return db.prepare('SELECT * FROM workflows WHERE workflow_id = ?').get(id) || null;
  }

  async function listSteps(id) {
    return db.prepare('SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(id);
  }

  async function executeStep(id, { input }) {
    // If input provided, inject as an instruction for the next pending node
    const next = db.prepare(`SELECT * FROM tasks WHERE workflow_id = ? AND status IN ('pending','queued') ORDER BY created_at LIMIT 1`).get(id);
    if (!next) {
      const err = new Error('no runnable steps');
      err.code = 'ENOTFOUND';
      throw err;
    }
    if (input) {
      db.prepare('UPDATE tasks SET task_description = ? WHERE task_id = ?').run(input, next.task_id);
    }
    await workflowRunner.runSingleNode(next.task_id);
    const completed = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(next.task_id);
    completed.is_terminal = !db.prepare(`SELECT 1 FROM tasks WHERE workflow_id = ? AND status IN ('pending','queued','running') LIMIT 1`).get(id);
    return completed;
  }

  async function listArtifacts(id) {
    return db.prepare(`
      SELECT m.* FROM asset_materializations m
      JOIN tasks t ON t.task_id = m.task_id
      WHERE t.workflow_id = ? ORDER BY m.produced_at
    `).all(id);
  }

  async function readArtifact(taskId, artifactId) {
    const m = db.prepare('SELECT * FROM asset_materializations WHERE materialization_id = ?').get(artifactId);
    if (!m) return null;
    const fs = require('fs');
    const fileName = m.asset_key.includes(':') ? m.asset_key.split(':').slice(1).join(':') : m.asset_key;
    try {
      return { mime: 'application/octet-stream', body: fs.readFileSync(fileName) };
    } catch { return null; }
  }

  return { createTaskFromInput, listTasks, getTask, listSteps, executeStep, listArtifacts, readArtifact };
}

module.exports = { createRuntimeAdapter };
```

- [ ] **Step 2: Mount in index.js**

```js
const { createRouter } = require('./api/agent-protocol/router');
const { createRuntimeAdapter } = require('./api/agent-protocol/runtime-adapter');
const runtime = createRuntimeAdapter({
  db: defaultContainer.get('db'),
  workflowRunner: defaultContainer.get('workflowRunner'),
  assetStore: defaultContainer.get('assetStore'),
});
app.use('/ap/v1', createRouter({ runtime, logger }));
```

- [ ] **Step 3: Docs**

Create `docs/agent-protocol.md` describing endpoints, auth (Bearer from connections registry), and example curl flows.

`await_restart`. Smoke: `curl http://localhost:3457/ap/v1/agent/tasks -d '{"input":"build a recipe app"}'`. Confirm returns task_id. `POST /steps`, `GET /artifacts`.

Commit: `feat(ap): runtime adapter + mount + docs`.
