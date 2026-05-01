# Workflow Status Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `completed_with_errors` workflow status so workflows with mixed success/failure show a distinct state from total failure.

**Architecture:** Change the status resolution logic in two places (`checkWorkflowCompletion` and `reconcileStaleWorkflows`) to filter out superseded restart-cancelled tasks and resolve to three outcomes instead of two. Add the new status to dashboard constants.

**Tech Stack:** Node.js, better-sqlite3, Vitest, React (dashboard constants only)

---

### Task 1: Tests for new workflow status resolution logic

**Files:**
- Modify: `server/tests/workflow-runtime.test.js:682-711`
- Read: `server/execution/workflow-runtime.js:1065-1098`

- [ ] **Step 1: Write tests for new status outcomes**

In `server/tests/workflow-runtime.test.js`, inside the existing `describe('checkWorkflowCompletion', ...)` block (after the deadlock test at line 711), add:

```js
    it('marks workflow completed_with_errors when some tasks failed', () => {
      const workflowId = createWorkflow({ name: 'wf-partial-fail' });
      createWorkflowTask(workflowId, 'A', 'completed');
      createWorkflowTask(workflowId, 'B', 'completed');
      createWorkflowTask(workflowId, 'C', 'failed');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed_with_errors');
      expect(workflow.completed_at).toBeTruthy();
    });

    it('marks workflow completed_with_errors when some tasks cancelled', () => {
      const workflowId = createWorkflow({ name: 'wf-partial-cancel' });
      createWorkflowTask(workflowId, 'A', 'completed');
      createWorkflowTask(workflowId, 'B', 'cancelled');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed_with_errors');
    });

    it('marks workflow failed when zero tasks completed', () => {
      const workflowId = createWorkflow({ name: 'wf-total-fail' });
      createWorkflowTask(workflowId, 'A', 'failed');
      createWorkflowTask(workflowId, 'B', 'failed');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('failed');
    });

    it('ignores superseded restart-cancelled tasks for status resolution', () => {
      const workflowId = createWorkflow({ name: 'wf-restart-recovered' });
      // Original task: cancelled by restart, but has a replacement
      createWorkflowTask(workflowId, 'A', 'cancelled', {
        metadata: JSON.stringify({ resubmitted_as: 'replacement-id', restart_resubmit_count: 1 }),
      });
      // Replacement task: completed
      createWorkflowTask(workflowId, 'A-retry', 'completed');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed');
    });

    it('marks workflow completed when all tasks completed or skipped (unchanged)', () => {
      const workflowId = createWorkflow({ name: 'wf-all-good' });
      createWorkflowTask(workflowId, 'A', 'completed');
      createWorkflowTask(workflowId, 'B', 'completed');
      createWorkflowTask(workflowId, 'C', 'skipped');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed');
    });

    it('early-exits for completed_with_errors status', () => {
      const workflowId = createWorkflow({ name: 'wf-already-partial', status: 'completed_with_errors' });
      createWorkflowTask(workflowId, 'A', 'completed');

      mod.checkWorkflowCompletion(workflowId);

      // Should not change status
      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed_with_errors');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `torque-remote "cd $TORQUE_PROJECT_DIR/server && npx vitest run tests/workflow-runtime.test.js"`
Expected: FAIL on the new tests (completed_with_errors not produced by current code)

- [ ] **Step 3: Commit failing tests**

```bash
git add server/tests/workflow-runtime.test.js
git commit -m "test: add workflow status resolution tests for completed_with_errors"
```

---

### Task 2: Implement status resolution in checkWorkflowCompletion

**Files:**
- Modify: `server/execution/workflow-runtime.js:1065-1098`

- [ ] **Step 1: Add completed_with_errors to the early-exit guard**

In `server/execution/workflow-runtime.js`, line 1067, change:

```js
  if (!workflow || workflow.status === 'completed' || workflow.status === 'failed' || workflow.status === 'cancelled') {
```

to:

```js
  if (!workflow || workflow.status === 'completed' || workflow.status === 'completed_with_errors' || workflow.status === 'failed' || workflow.status === 'cancelled') {
```

- [ ] **Step 2: Replace the status resolution ternary**

Replace lines 1071-1094 (from `// Count tasks by status` through the `finalStatus` ternary):

```js
  // Count tasks by status, filtering out superseded restart-cancelled tasks
  const tasks = db.getWorkflowTasks(workflowId);

  // A cancelled task is "superseded" when it was restart-cancelled and has a replacement
  const isSuperseded = (task) => {
    if (task.status !== 'cancelled') return false;
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
      return !!meta.resubmitted_as;
    } catch { return false; }
  };

  const effectiveTasks = tasks.filter(t => !isSuperseded(t));
  const stats = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    skipped: tasks.filter(t => t.status === 'skipped').length
  };
  const effectiveCompleted = effectiveTasks.filter(t => t.status === 'completed').length;
  const effectiveFailed = effectiveTasks.filter(t => t.status === 'failed').length;
  const effectiveCancelled = effectiveTasks.filter(t => t.status === 'cancelled').length;
```

Keep the `db.updateWorkflow` for counters unchanged (it uses `stats` which counts all tasks including superseded).

Then replace the `finalStatus` ternary (line 1094):

```js
    let finalStatus;
    if (effectiveFailed === 0 && effectiveCancelled === 0) {
      finalStatus = 'completed';
    } else if (effectiveCompleted > 0) {
      finalStatus = 'completed_with_errors';
    } else {
      finalStatus = 'failed';
    }
```

- [ ] **Step 3: Run conflict resolution on completed_with_errors too**

Change line 1102 from:

```js
    if (finalStatus === 'completed') {
```

to:

```js
    if (finalStatus === 'completed' || finalStatus === 'completed_with_errors') {
```

This ensures file conflict detection runs even when some tasks failed, since the completed tasks may have written conflicting files.

- [ ] **Step 4: Run tests**

Run: `torque-remote "cd $TORQUE_PROJECT_DIR/server && npx vitest run tests/workflow-runtime.test.js"`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/workflow-runtime.js
git commit -m "feat: workflow status resolution with completed_with_errors"
```

---

### Task 3: Fix reconcileStaleWorkflows with same logic

**Files:**
- Modify: `server/db/workflow-engine.js:285-315`

- [ ] **Step 1: Update the reconcile SQL and status logic**

In `server/db/workflow-engine.js`, the `reconcileStaleWorkflows` function (line 285) uses a SQL query that counts `failed_count` and `cancelled_count`, then resolves with a ternary at line 310.

Add `completed_count` to the SQL SELECT (after the `cancelled_count` line 297):

```sql
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END)          AS completed_count,
```

Note: This function cannot easily filter superseded tasks via SQL (metadata is JSON text). Instead, apply the same logic using the counts available.

Replace the finalStatus ternary (lines 310-312):

```js
    const finalStatus = row.failed_count > 0 ? 'failed'
      : row.cancelled_count === row.total ? 'cancelled'
        : 'completed';
```

with:

```js
    let finalStatus;
    const hasFailuresOrCancels = row.failed_count > 0 || row.cancelled_count > 0;
    if (!hasFailuresOrCancels) {
      finalStatus = 'completed';
    } else if (row.completed_count > 0) {
      finalStatus = 'completed_with_errors';
    } else {
      finalStatus = 'failed';
    }
```

Note: The reconcile path doesn't filter superseded tasks (it only has aggregate counts from SQL). This is acceptable -- reconcile is a recovery path for stale workflows, not the primary completion handler.

- [ ] **Step 2: Run tests**

Run: `torque-remote "cd $TORQUE_PROJECT_DIR/server && npx vitest run tests/workflow-runtime.test.js"`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add server/db/workflow-engine.js
git commit -m "feat: reconcileStaleWorkflows produces completed_with_errors"
```

---

### Task 4: Add completed_with_errors to dashboard constants

**Files:**
- Modify: `dashboard/src/constants.js:1-49`

- [ ] **Step 1: Add completed_with_errors to all status maps**

In `dashboard/src/constants.js`, add the new status to each map:

In `STATUS_COLORS` (after `completed` line 8):
```js
  completed_with_errors: 'text-yellow-400',
```

In `STATUS_BG_COLORS` (after `completed` line 19):
```js
  completed_with_errors: 'bg-yellow-600',
```

In `STATUS_DOT_COLORS` (after `completed` line 30):
```js
  completed_with_errors: 'bg-yellow-400',
```

In `STATUS_ICONS` (after `completed` line 41):
```js
  completed_with_errors: '\u26A0',
```

(`\u26A0` is the warning triangle character)

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/constants.js
git commit -m "feat: add completed_with_errors to dashboard status constants"
```
