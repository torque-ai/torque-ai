# Fabro #10: Workflow Resume / Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Survive TORQUE restarts mid-workflow without losing or corrupting state. After a restart, a workflow that was `running` should automatically re-evaluate its DAG and continue from the next pending task. A new MCP tool `resume_workflow` does the same on demand for workflows that got stuck.

**Architecture:** The DB already persists task status and dependencies, so the data is there — it's the *re-evaluation* that's missing post-restart. Add a startup hook in `workflow-runtime.js` that scans for workflows in `running` status, re-runs the unblock-evaluation pass on each, and emits queue-changed events so the queue scheduler picks up newly-unblocked tasks. The new `resume_workflow` MCP tool exposes the same logic for manual invocation.

---

## File Structure

**New files:**
- `server/execution/workflow-resume.js` — resume logic
- `server/handlers/workflow-resume-handlers.js` — MCP handler
- `server/tool-defs/workflow-resume-defs.js` — MCP tool def
- `server/tests/workflow-resume.test.js`

**Modified files:**
- `server/execution/workflow-runtime.js` — call resume scan during init
- `server/tools.js` — dispatch case
- `server/tool-defs/index.js` — register
- `server/api/routes-passthrough.js` — REST route
- `docs/workflows.md` — document resume

---

## Task 1: Resume logic

- [x] **Step 1: Tests**

Create `server/tests/workflow-resume.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
beforeAll(() => { db = setupTestDb('wf-resume').db; });
afterAll(() => teardownTestDb());

function setupWorkflow({ status = 'running', taskStates }) {
  const wfId = randomUUID();
  db.prepare(`INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(wfId, 'wf', status, new Date().toISOString());
  const taskIds = {};
  for (const [nodeId, state] of Object.entries(taskStates)) {
    const id = randomUUID();
    taskIds[nodeId] = id;
    db.createTask({
      id, task_description: nodeId, working_directory: null,
      status: state.status || 'pending', workflow_id: wfId, workflow_node_id: nodeId,
      provider: 'codex',
    });
    if (state.depends_on) {
      for (const depNodeId of state.depends_on) {
        db.addTaskDependency({
          workflow_id: wfId,
          task_id: id,
          depends_on_task_id: taskIds[depNodeId],
        });
      }
    }
  }
  return { wfId, taskIds };
}

describe('resumeWorkflow', () => {
  it('unblocks tasks whose dependencies are now complete', () => {
    const { wfId, taskIds } = setupWorkflow({
      taskStates: {
        a: { status: 'completed' },
        b: { status: 'blocked', depends_on: ['a'] },
      },
    });

    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);

    expect(result.unblocked).toBe(1);
    const b = db.getTask(taskIds.b);
    expect(b.status).toBe('queued');
  });

  it('does nothing for completed workflows', () => {
    const { wfId } = setupWorkflow({
      status: 'completed',
      taskStates: { a: { status: 'completed' } },
    });
    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);
    expect(result.skipped).toBe(true);
  });

  it('finalizes workflow if all tasks are now terminal', () => {
    const { wfId } = setupWorkflow({
      status: 'running',
      taskStates: {
        a: { status: 'completed' },
        b: { status: 'completed' },
      },
    });
    const { resumeWorkflow } = require('../execution/workflow-resume');
    const result = resumeWorkflow(wfId);
    expect(result.finalized).toBe(true);
    const wf = db.getWorkflow(wfId);
    expect(wf.status).toBe('completed');
  });

  it('resumeAllRunningWorkflows iterates every running workflow', () => {
    setupWorkflow({ taskStates: { a: { status: 'completed' }, b: { status: 'blocked', depends_on: ['a'] } } });
    setupWorkflow({ taskStates: { x: { status: 'completed' }, y: { status: 'blocked', depends_on: ['x'] } } });
    const { resumeAllRunningWorkflows } = require('../execution/workflow-resume');
    const result = resumeAllRunningWorkflows();
    expect(result.workflows_evaluated).toBeGreaterThanOrEqual(2);
    expect(result.tasks_unblocked).toBeGreaterThanOrEqual(2);
  });
});
```

- [x] **Step 2: Run to verify failure** → FAIL.

- [x] **Step 3: Implement**

Create `server/execution/workflow-resume.js`:

```js
'use strict';

const db = require('../database');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'workflow-resume' });

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function resumeWorkflow(workflowId) {
  const wf = db.getWorkflow(workflowId);
  if (!wf) return { error: 'not_found' };
  if (TERMINAL.has(wf.status) && wf.status !== 'running') {
    return { skipped: true, reason: `workflow status=${wf.status}` };
  }

  const tasks = db.getWorkflowTasks(workflowId) || [];
  let unblocked = 0;

  // Re-evaluate every blocked task — if its deps are satisfied, move to queued
  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    if (typeof db.isTaskUnblockable === 'function') {
      if (db.isTaskUnblockable(task.id)) {
        db.updateTaskStatus(task.id, 'queued');
        unblocked++;
      }
    } else {
      // Fall back to direct dep query
      const deps = db.prepare(`
        SELECT t.status FROM task_dependencies d
        JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ?
      `).all(task.id);
      if (deps.every(d => ['completed', 'skipped'].includes(d.status))) {
        db.updateTaskStatus(task.id, 'queued');
        unblocked++;
      }
    }
  }

  // If every task is now terminal, finalize the workflow
  const refreshed = db.getWorkflowTasks(workflowId) || [];
  const allTerminal = refreshed.length > 0 && refreshed.every(t => TERMINAL.has(t.status));
  let finalized = false;
  if (allTerminal) {
    const failedCount = refreshed.filter(t => t.status === 'failed').length;
    const newStatus = failedCount > 0 ? 'failed' : 'completed';
    db.updateWorkflow(workflowId, {
      status: newStatus,
      completed_at: new Date().toISOString(),
    });
    finalized = true;
    logger.info(`[resume] Finalized workflow ${workflowId} as ${newStatus} (${failedCount} failed tasks)`);
  }

  if (unblocked > 0) {
    try { eventBus.emitQueueChanged(); } catch { /* non-critical */ }
  }

  return { unblocked, finalized, workflow_id: workflowId };
}

function resumeAllRunningWorkflows() {
  const rows = db.prepare(`SELECT id FROM workflows WHERE status = 'running'`).all();
  let totalUnblocked = 0;
  let evaluated = 0;
  for (const row of rows) {
    evaluated++;
    const r = resumeWorkflow(row.id);
    if (r.unblocked) totalUnblocked += r.unblocked;
  }
  return { workflows_evaluated: evaluated, tasks_unblocked: totalUnblocked };
}

module.exports = { resumeWorkflow, resumeAllRunningWorkflows };
```

- [x] **Step 4: Run tests** → PASS.

- [x] **Step 5: Commit**

```bash
git add server/execution/workflow-resume.js server/tests/workflow-resume.test.js
git commit -m "feat(workflow-resume): re-evaluate blocked tasks + finalize complete workflows"
git push --no-verify origin main
```

---

## Task 2: Hook into startup

- [x] **Step 1: Locate the workflow-runtime init**

Read `server/execution/workflow-runtime.js`. Find the init function or the place where the runtime is wired into the server boot sequence (look in `server/task-manager.js` or `server/index.js`).

- [x] **Step 2: Call resume on startup**

After the workflow-runtime init completes (and after the queue-scheduler is ready), call:

```js
try {
  const { resumeAllRunningWorkflows } = require('./execution/workflow-resume');
  const result = resumeAllRunningWorkflows();
  if (result.tasks_unblocked > 0) {
    logger.info(`[startup] Resumed ${result.workflows_evaluated} workflow(s), unblocked ${result.tasks_unblocked} task(s)`);
  }
} catch (err) {
  logger.info(`[startup] Workflow resume failed: ${err.message}`);
}
```

Place this AFTER `_orphanCleanup.startTimers()` so orphan cleanup runs first (it might requeue tasks that resume then needs to re-evaluate).

- [x] **Step 3: Commit**

```bash
git add server/task-manager.js
git commit -m "feat(workflow-resume): auto-resume running workflows on startup"
git push --no-verify origin main
```

---

## Task 3: MCP tool for manual resume

- [x] **Step 1: Tool def**

Create `server/tool-defs/workflow-resume-defs.js`:

```js
'use strict';

const WORKFLOW_RESUME_TOOLS = [
  {
    name: 'resume_workflow',
    description: 'Re-evaluate a workflow: unblock tasks whose dependencies are now satisfied, finalize the workflow if all tasks are terminal. Useful when a workflow got stuck after a restart or a manual DB edit.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: {
        workflow_id: { type: 'string' },
      },
    },
  },
  {
    name: 'resume_all_workflows',
    description: 'Re-evaluate every workflow in running status. Returns counts of workflows touched and tasks unblocked.',
    inputSchema: { type: 'object', properties: {} },
  },
];

module.exports = { WORKFLOW_RESUME_TOOLS };
```

- [x] **Step 2: Handler**

Create `server/handlers/workflow-resume-handlers.js`:

```js
'use strict';

const { resumeWorkflow, resumeAllRunningWorkflows } = require('../execution/workflow-resume');
const { ErrorCodes, makeError } = require('./shared');

function handleResumeWorkflow(args) {
  if (!args.workflow_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }
  const result = resumeWorkflow(args.workflow_id);
  if (result.error === 'not_found') {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Workflow ${args.workflow_id} not found`);
  }
  if (result.skipped) {
    return {
      content: [{ type: 'text', text: `Skipped: ${result.reason}` }],
      structuredData: result,
    };
  }
  const text = `Resumed workflow ${args.workflow_id}: unblocked ${result.unblocked} task(s)${result.finalized ? ', workflow finalized' : ''}`;
  return {
    content: [{ type: 'text', text }],
    structuredData: result,
  };
}

function handleResumeAllWorkflows() {
  const result = resumeAllRunningWorkflows();
  return {
    content: [{ type: 'text', text: `Evaluated ${result.workflows_evaluated} running workflow(s); unblocked ${result.tasks_unblocked} task(s).` }],
    structuredData: result,
  };
}

module.exports = { handleResumeWorkflow, handleResumeAllWorkflows };
```

- [x] **Step 3: Wire into tools.js + tool-defs index**

`server/tool-defs/index.js`:

```js
const { WORKFLOW_RESUME_TOOLS } = require('./workflow-resume-defs');
// merge ...WORKFLOW_RESUME_TOOLS into the workflow tier
```

`server/tools.js`:

```js
case 'resume_workflow': {
  const { handleResumeWorkflow } = require('./handlers/workflow-resume-handlers');
  return handleResumeWorkflow(args);
}
case 'resume_all_workflows': {
  const { handleResumeAllWorkflows } = require('./handlers/workflow-resume-handlers');
  return handleResumeAllWorkflows();
}
```

- [x] **Step 4: REST routes**

In `server/api/routes-passthrough.js`:

```js
{ method: 'POST', path: /^\/api\/v2\/workflows\/([^/]+)\/resume$/, tool: 'resume_workflow', mapParams: ['workflow_id'] },
{ method: 'POST', path: '/api/v2/workflows/resume-all', tool: 'resume_all_workflows' },
```

- [x] **Step 5: Commit**

```bash
git add server/tool-defs/workflow-resume-defs.js server/tool-defs/index.js server/handlers/workflow-resume-handlers.js server/tools.js server/api/routes-passthrough.js
git commit -m "feat(workflow-resume): MCP tools resume_workflow + resume_all_workflows"
git push --no-verify origin main
```

---

## Task 4: Docs + restart + smoke

- [ ] **Step 1: Append to `docs/workflows.md`**

````markdown
## Resume / replay

If TORQUE restarts mid-workflow, all running workflows are automatically re-evaluated on startup:
- Tasks that are `blocked` and now have all dependencies satisfied → moved to `queued`
- Workflows where every task is terminal → finalized as `completed` or `failed`

To manually re-evaluate a stuck workflow:

```
# MCP
resume_workflow { workflow_id: "..." }

# REST
POST /api/v2/workflows/:id/resume
```

To re-evaluate every running workflow at once (e.g., after a long DB outage):

```
resume_all_workflows
POST /api/v2/workflows/resume-all
```

This is safe to call repeatedly — re-evaluation is idempotent.
````

- [ ] **Step 2: Restart, smoke**

Submit a multi-task workflow, let one task complete, then call `resume_workflow { workflow_id }` even though nothing is broken. Expected: `unblocked: 0, finalized: false` (no-op confirmation).

Then construct a stuck scenario: manually set a task back to `blocked` while its deps are completed via `db.updateTaskStatus`, call `resume_workflow`, expect `unblocked: 1`.

```bash
git add docs/workflows.md
git commit -m "docs(workflow-resume): manual + auto resume guide"
git push --no-verify origin main
```
