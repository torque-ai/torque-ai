# Fabro #56: Error Workflows with Structured Failure Metadata (n8n)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a workflow fails, automatically invoke a configured **error-handler workflow** with structured failure context (execution id, retry ancestry, failing node/task, stack, error_output). This separates recovery logic (notifications, escalations, compensating actions) from main DAGs while preserving full context. Inspired by n8n.

**Architecture:** Each workflow can declare `error_workflow_id` pointing at another workflow. When the primary workflow ends in `failed` state, a new `error-workflow-dispatcher.js` launches the configured error handler with params `{ source_workflow_id, source_execution_id, failing_task_id, failure_class, error_output, retry_ancestry, timestamp }`. The error workflow is just a normal workflow that can send Slack alerts, open GitHub issues, open debug sessions (Plan 42), or trigger cleanup.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 4 (failure classes), 42 (debug sessions), 53 (boundary errors).

---

## File Structure

**New files:**
- `server/migrations/0NN-error-workflow-link.sql`
- `server/workflows/error-workflow-dispatcher.js`
- `server/tests/error-workflow-dispatcher.test.js`

**Modified files:**
- `server/tool-defs/workflow-defs.js` — `error_workflow_id` field on workflow create
- `server/execution/workflow-finalizer.js` — dispatch on failure
- `dashboard/src/views/WorkflowDetail.jsx` — show linked error workflow + history

---

## Task 1: Migration + dispatcher

- [ ] **Step 1: Migration**

`server/migrations/0NN-error-workflow-link.sql`:

```sql
ALTER TABLE workflows ADD COLUMN error_workflow_id TEXT REFERENCES workflows(workflow_id);

CREATE TABLE IF NOT EXISTS error_workflow_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  source_workflow_id TEXT NOT NULL,
  error_workflow_id TEXT NOT NULL,
  error_run_id TEXT,
  failure_context_json TEXT,
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_dispatches_source ON error_workflow_dispatches(source_workflow_id);
```

- [ ] **Step 2: Tests**

Create `server/tests/error-workflow-dispatcher.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createErrorWorkflowDispatcher } = require('../workflows/error-workflow-dispatcher');

describe('errorWorkflowDispatcher', () => {
  let db, dispatcher, enqueueMock;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status, error_workflow_id) VALUES ('wf-source','src','failed','wf-handler')`).run();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-handler','err','created')`).run();
    enqueueMock = vi.fn(async (wfId, params) => ({ workflow_run_id: `run-${Date.now()}` }));
    dispatcher = createErrorWorkflowDispatcher({ db, enqueueWorkflowRun: enqueueMock });
  });

  it('dispatch enqueues the configured error workflow with structured context', async () => {
    const r = await dispatcher.dispatchOnFailure({
      sourceWorkflowId: 'wf-source',
      failingTaskId: 't42',
      failureClass: 'verify_failed',
      errorOutput: 'TS2322 in foo.ts',
    });
    expect(r.dispatched).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith('wf-handler', expect.objectContaining({
      parameters: expect.objectContaining({
        source_workflow_id: 'wf-source',
        failing_task_id: 't42',
        failure_class: 'verify_failed',
        error_output: 'TS2322 in foo.ts',
      }),
    }));
    const row = db.prepare('SELECT * FROM error_workflow_dispatches WHERE source_workflow_id = ?').get('wf-source');
    expect(row.error_workflow_id).toBe('wf-handler');
  });

  it('is a no-op when no error_workflow_id is configured', async () => {
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('plain-wf','x','failed')`).run();
    const r = await dispatcher.dispatchOnFailure({ sourceWorkflowId: 'plain-wf' });
    expect(r.dispatched).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('prevents recursive error-handler loops (self-reference)', async () => {
    db.prepare(`UPDATE workflows SET error_workflow_id = 'wf-source' WHERE workflow_id = 'wf-source'`).run();
    const r = await dispatcher.dispatchOnFailure({ sourceWorkflowId: 'wf-source' });
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/recursive/i);
  });

  it('records retry ancestry when provided', async () => {
    await dispatcher.dispatchOnFailure({
      sourceWorkflowId: 'wf-source',
      retryAncestry: ['run-1', 'run-2', 'run-3'],
    });
    const row = db.prepare('SELECT failure_context_json FROM error_workflow_dispatches WHERE source_workflow_id = ?').get('wf-source');
    expect(JSON.parse(row.failure_context_json).retry_ancestry).toEqual(['run-1', 'run-2', 'run-3']);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workflows/error-workflow-dispatcher.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createErrorWorkflowDispatcher({ db, enqueueWorkflowRun, logger = console }) {
  async function dispatchOnFailure({
    sourceWorkflowId,
    sourceExecutionId = null,
    failingTaskId = null,
    failureClass = null,
    errorOutput = null,
    retryAncestry = null,
  }) {
    const source = db.prepare('SELECT error_workflow_id FROM workflows WHERE workflow_id = ?').get(sourceWorkflowId);
    if (!source || !source.error_workflow_id) {
      return { dispatched: false, reason: 'no error_workflow_id configured' };
    }
    if (source.error_workflow_id === sourceWorkflowId) {
      logger.warn('error workflow self-reference, refusing to dispatch', { sourceWorkflowId });
      return { dispatched: false, reason: 'recursive (self-reference)' };
    }

    const context = {
      source_workflow_id: sourceWorkflowId,
      source_execution_id: sourceExecutionId,
      failing_task_id: failingTaskId,
      failure_class: failureClass,
      error_output: errorOutput,
      retry_ancestry: retryAncestry,
      timestamp: new Date().toISOString(),
    };

    const dispatchId = `ewd_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO error_workflow_dispatches (dispatch_id, source_workflow_id, error_workflow_id, failure_context_json)
      VALUES (?, ?, ?, ?)
    `).run(dispatchId, sourceWorkflowId, source.error_workflow_id, JSON.stringify(context));

    try {
      const result = await enqueueWorkflowRun(source.error_workflow_id, {
        parameters: context,
        triggered_by: `error_of:${sourceWorkflowId}`,
      });
      db.prepare(`UPDATE error_workflow_dispatches SET error_run_id = ? WHERE dispatch_id = ?`)
        .run(result.workflow_run_id, dispatchId);
      return { dispatched: true, dispatch_id: dispatchId, error_run_id: result.workflow_run_id };
    } catch (err) {
      logger.error('error workflow dispatch failed', { sourceWorkflowId, error: err.message });
      return { dispatched: false, reason: err.message };
    }
  }

  function listForSource(sourceWorkflowId) {
    return db.prepare(`SELECT * FROM error_workflow_dispatches WHERE source_workflow_id = ? ORDER BY dispatched_at DESC`)
      .all(sourceWorkflowId);
  }

  return { dispatchOnFailure, listForSource };
}

module.exports = { createErrorWorkflowDispatcher };
```

Run tests → PASS. Commit: `feat(error-workflows): dispatcher with self-reference guard + structured context`.

---

## Task 2: Wire into workflow finalizer + MCP + dashboard

- [ ] **Step 1: Tool def fields**

In `server/tool-defs/workflow-defs.js`:

```js
error_workflow_id: { type: 'string', description: 'ID of another workflow to invoke when this workflow ends in failed state. Receives structured failure context as parameters.' },
```

- [ ] **Step 2: Finalizer dispatches**

In `server/execution/workflow-finalizer.js` on transition to 'failed':

```js
const dispatcher = defaultContainer.get('errorWorkflowDispatcher');
await dispatcher.dispatchOnFailure({
  sourceWorkflowId: workflowId,
  failingTaskId: latestFailedTaskId,
  failureClass: latestFailureClass,
  errorOutput: latestErrorOutput,
  retryAncestry: retryChainIds || null,
});
```

- [ ] **Step 3: Container**

```js
container.factory('errorWorkflowDispatcher', (c) => {
  const { createErrorWorkflowDispatcher } = require('./workflows/error-workflow-dispatcher');
  return createErrorWorkflowDispatcher({
    db: c.get('db'),
    enqueueWorkflowRun: c.get('workflowRunner').runOnce,
    logger: c.get('logger'),
  });
});
```

- [ ] **Step 4: Dashboard**

On `WorkflowDetail.jsx`:
- Show the linked error workflow (if any) as a badge + link.
- Show a history panel listing the last N error-workflow dispatches with timestamp + link to the error run.

- [ ] **Step 5: REST**

```js
router.get('/:id/error-dispatches', (req, res) => {
  res.json({ dispatches: defaultContainer.get('errorWorkflowDispatcher').listForSource(req.params.id) });
});
```

`await_restart`. Smoke: create workflow B that accepts `{source_workflow_id, failure_class}` params and just logs them. Create workflow A with `error_workflow_id: 'B'` and a failing task. Run A, confirm it fails, confirm B is enqueued with the right context. Call `GET /api/workflows/A/error-dispatches` and confirm history.

Commit: `feat(error-workflows): wire finalizer → dispatcher + dashboard surface`.
