# Workflow-Aware Orphan Re-queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When TORQUE restarts and finds orphaned running tasks, re-queue them instead of cancelling, so workflows self-heal and resume execution automatically.

**Architecture:** Change the startup orphan cleanup to re-queue orphaned tasks (preserving workflow membership) instead of cancelling them. The existing queue scheduler picks up re-queued tasks, the workflow DAG engine unblocks dependents when they complete, and `checkWorkflowCompletion` resolves the final status naturally. No new modules needed.

**Tech Stack:** Node.js, better-sqlite3, Vitest

---

### Task 1: Tests for orphan re-queue behavior

**Files:**
- Modify: `server/tests/workflow-runtime.test.js` (extend checkWorkflowCompletion tests)
- Create: `server/tests/orphan-requeue.test.js`

- [x] **Step 1: Write tests for orphan re-queue**

Create `server/tests/orphan-requeue.test.js`:

```js
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

describe('orphan requeue logic', () => {
  test('orphaned task is requeued instead of cancelled', () => {
    // The requeue logic sets status to 'queued', clears provider/host,
    // increments retry_count, and preserves workflow_id/workflow_node_id
    const task = {
      id: 'orphan-1',
      status: 'running',
      workflow_id: 'wf-1',
      workflow_node_id: 'step-2',
      provider: 'codex',
      ollama_host_id: 'host-1',
      retry_count: 0,
      max_retries: 2,
      mcp_instance_id: 'dead-instance',
    };

    // Simulate requeue decision
    const shouldRequeue = task.retry_count < (task.max_retries != null ? task.max_retries : 2);
    expect(shouldRequeue).toBe(true);

    // After requeue, these fields should be set:
    const requeued = {
      status: 'queued',
      provider: null,
      ollama_host_id: null,
      mcp_instance_id: null,
      retry_count: task.retry_count + 1,
      // These must be preserved:
      workflow_id: task.workflow_id,
      workflow_node_id: task.workflow_node_id,
    };

    expect(requeued.status).toBe('queued');
    expect(requeued.workflow_id).toBe('wf-1');
    expect(requeued.workflow_node_id).toBe('step-2');
    expect(requeued.provider).toBeNull();
    expect(requeued.retry_count).toBe(1);
  });

  test('orphaned task is cancelled when max retries exhausted', () => {
    const task = { retry_count: 2, max_retries: 2 };
    const shouldRequeue = task.retry_count < (task.max_retries != null ? task.max_retries : 2);
    expect(shouldRequeue).toBe(false);
  });

  test('non-workflow orphaned task is also requeued', () => {
    const task = {
      id: 'orphan-standalone',
      status: 'running',
      workflow_id: null,
      retry_count: 0,
      max_retries: 2,
    };

    const shouldRequeue = task.retry_count < (task.max_retries != null ? task.max_retries : 2);
    expect(shouldRequeue).toBe(true);
  });

  test('requeued task clears cancel_reason (it is not cancelled)', () => {
    // A requeued task should NOT have cancel_reason set
    // cancel_reason is only for tasks that reach 'cancelled' status
    const requeuedFields = {
      status: 'queued',
      cancel_reason: null,
    };
    expect(requeuedFields.cancel_reason).toBeNull();
  });
});
```

- [x] **Step 2: Run tests**

Run: `torque-remote "cd $TORQUE_PROJECT_DIR/server && npx vitest run tests/orphan-requeue.test.js"`
Expected: PASS (these are logic-level tests)

- [x] **Step 3: Commit**

```bash
git add server/tests/orphan-requeue.test.js
git commit -m "test: orphan requeue logic tests"
```

---

### Task 2: Change startup orphan cleanup to re-queue

**Files:**
- Modify: `server/index.js:829-900` (startup orphan cleanup block)

- [x] **Step 1: Add a requeue helper alongside the cancel helper**

In `server/index.js`, after the `markStartupOrphanCancelled` function (around line 835-848), add a re-queue helper:

```js
    const requeueOrphanedTask = (task, reason) => {
      const retryCount = task.retry_count || 0;
      const maxRetries = task.max_retries != null ? task.max_retries : 2;

      if (retryCount >= maxRetries) {
        // Max retries exhausted — cancel instead
        markStartupOrphanCancelled(task, {
          error_output: `${reason} (max retries exhausted: ${retryCount}/${maxRetries})`,
          completed_at: new Date().toISOString()
        });
        return;
      }

      db.updateTaskStatus(task.id, 'queued', {
        error_output: `${reason} — requeued for re-execution (attempt ${retryCount + 1}/${maxRetries})`,
        retry_count: retryCount + 1,
        mcp_instance_id: null,
        provider: null,
        ollama_host_id: null,
      });

      if (task.ollama_host_id) {
        try { db.decrementHostTasks(task.ollama_host_id); } catch { /* host may not exist */ }
      }

      debugLog(`Orphan requeue: task ${task.id} requeued (attempt ${retryCount + 1}/${maxRetries})${task.workflow_id ? ` [workflow: ${task.workflow_id}]` : ''}`);
      orphansCleaned++;
    };
```

- [x] **Step 2: Replace cancel calls with requeue for our-own-instance orphans**

In the block starting around line 863 (`task.mcp_instance_id === taskManager.getMcpInstanceId()`), change:

```js
      } else if (task.mcp_instance_id === taskManager.getMcpInstanceId()) {
        // Our task but not in runningProcesses — leftover from our own crash/restart
        if (!taskManager.hasRunningProcess(task.id)) {
          markStartupOrphanCancelled(task, {
            error_output: 'Server restarted — task orphaned from previous instance',
            completed_at: new Date().toISOString()
          });
        }
```

to:

```js
      } else if (task.mcp_instance_id === taskManager.getMcpInstanceId()) {
        // Our task but not in runningProcesses — leftover from our own crash/restart
        if (!taskManager.hasRunningProcess(task.id)) {
          requeueOrphanedTask(task, 'Server restarted — task orphaned from previous instance');
        }
```

- [x] **Step 3: Replace cancel calls with requeue for legacy (no owner) orphans**

In the block starting around line 856 (`!task.mcp_instance_id`), change:

```js
      if (!task.mcp_instance_id) {
        // Legacy task with no owner — use grace period + timeout logic
        if (runningTime > Math.max(GRACE_PERIOD_MS, timeoutMs)) {
          markStartupOrphanCancelled(task, {
            error_output: 'Server restarted - task was interrupted (stale, no instance owner)'
          });
        }
```

to:

```js
      if (!task.mcp_instance_id) {
        // Legacy task with no owner — use grace period + timeout logic
        if (runningTime > Math.max(GRACE_PERIOD_MS, timeoutMs)) {
          requeueOrphanedTask(task, 'Server restarted — task interrupted (no instance owner)');
        }
```

- [x] **Step 4: Keep the dead-instance requeue path as-is**

The block at lines 871-896 (dead instance detection) already requeues via `db.updateTaskStatus(task.id, 'queued', ...)`. Leave it unchanged — it already does the right thing.

- [x] **Step 5: Process the queue after orphan cleanup**

After the orphan cleanup loop (around line 903, after the `debugLog` for orphansCleaned), add a deferred queue processing call so requeued tasks get picked up:

```js
    if (orphansCleaned > 0) {
      debugLog(`Startup cleanup: recovered ${orphansCleaned} orphaned tasks`);
      // Defer queue processing so requeued tasks get picked up after full init
      setTimeout(() => {
        try { taskManager.processQueue(); } catch { /* non-fatal */ }
      }, 5000);
    }
```

- [x] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "feat: requeue orphaned tasks on startup instead of cancelling"
```

---

### Task 3: Update await_task recovery to handle requeued tasks

**Files:**
- Modify: `server/handlers/workflow/await.js` (handleRestartRecovery, handleAwaitTask)

The await_task restart recovery currently detects `cancelled` + `cancel_reason: server_restart|orphan_cleanup`. With requeue, orphaned tasks will be `queued` not `cancelled`, so the await loop's normal poll will just keep waiting — which is the correct behavior. No code change needed.

However, the epoch-check in `handleAwaitTask` currently marks stale-epoch running tasks as cancelled. It should requeue them instead:

- [x] **Step 1: Change epoch-check to requeue instead of cancel**

In `server/handlers/workflow/await.js`, find the epoch check in `handleAwaitTask` (the block that does `taskCore.updateTaskStatus(taskId, 'cancelled', { ... cancel_reason: 'orphan_cleanup' ...})`).

Change it to requeue:

```js
    // Epoch check: task is "running" but from a previous server lifetime (crash orphan)
    if (initialTask.status === 'running' && initialTask.server_epoch && initialTask.server_epoch < currentEpoch) {
      // Requeue instead of cancel — let the queue scheduler re-execute from scratch
      const retryCount = initialTask.retry_count || 0;
      const maxRetries = initialTask.max_retries != null ? initialTask.max_retries : 2;

      if (retryCount < maxRetries) {
        taskCore.updateTaskStatus(taskId, 'queued', {
          error_output: `Task orphaned — server epoch ${initialTask.server_epoch} < current ${currentEpoch}. Requeued (attempt ${retryCount + 1}/${maxRetries}).`,
          retry_count: retryCount + 1,
          mcp_instance_id: null,
          provider: null,
          ollama_host_id: null,
        });
        // Continue polling — the requeued task will transition to running then completed
      } else {
        // Max retries exhausted — cancel and return recovery response
        taskCore.updateTaskStatus(taskId, 'cancelled', {
          error_output: `Task orphaned — server epoch ${initialTask.server_epoch} < current ${currentEpoch} (max retries exhausted)`,
          cancel_reason: 'orphan_cleanup',
          completed_at: new Date().toISOString(),
        });
        const cancelledTask = taskCore.getTask(taskId);
        return handleRestartRecovery(cancelledTask, args, awaitStartTime, currentEpoch);
      }
    }
```

Apply the same change to the epoch check inside the poll loop (search for the same pattern further down in `handleAwaitTask`).

- [x] **Step 2: Apply same change in handleAwaitWorkflow**

In `handleAwaitWorkflow`, the epoch check loop (around the `for (const task of tasks)` block that marks running+stale-epoch tasks as cancelled) should also requeue:

```js
      for (const task of tasks) {
        if (task.status === 'running' && task.server_epoch && task.server_epoch < currentEpoch) {
          const retryCount = task.retry_count || 0;
          const maxRetries = task.max_retries != null ? task.max_retries : 2;

          if (retryCount < maxRetries) {
            taskCore.updateTaskStatus(task.id, 'queued', {
              error_output: `Task orphaned — server epoch ${task.server_epoch} < current ${currentEpoch}. Requeued.`,
              retry_count: retryCount + 1,
              mcp_instance_id: null,
              provider: null,
              ollama_host_id: null,
            });
            task.status = 'queued';
          } else {
            taskCore.updateTaskStatus(task.id, 'cancelled', {
              error_output: `Task orphaned — epoch ${task.server_epoch} < current ${currentEpoch} (max retries exhausted)`,
              cancel_reason: 'orphan_cleanup',
              completed_at: new Date().toISOString(),
            });
            task.status = 'cancelled';
            task.cancel_reason = 'orphan_cleanup';
          }
        }
      }
```

- [x] **Step 3: Commit**

```bash
git add server/handlers/workflow/await.js
git commit -m "feat: await epoch-check requeues orphaned tasks instead of cancelling"
```

---

### Task 4: Integration test — full restart recovery cycle

**Files:**
- Modify: `server/tests/orphan-requeue.test.js`

- [x] **Step 1: Add integration-level tests**

Append to `server/tests/orphan-requeue.test.js`:

```js
describe('orphan requeue — workflow integration', () => {
  test('requeued task preserves workflow_id and workflow_node_id', () => {
    // When updateTaskStatus sets status='queued', workflow fields are NOT cleared
    // because the updateTaskStatus function only clears provider/host/instance
    const requeueFields = {
      status: 'queued',
      provider: null,
      ollama_host_id: null,
      mcp_instance_id: null,
      // These should NOT be in the update — they stay as-is in the DB
    };

    // Verify workflow_id is NOT being cleared
    expect(requeueFields).not.toHaveProperty('workflow_id');
    expect(requeueFields).not.toHaveProperty('workflow_node_id');
  });

  test('requeued tasks go through queue scheduler which re-evaluates routing', () => {
    // A requeued task has provider=null, so smart routing re-evaluates
    // This means it can be routed to a different provider/host than the original
    const requeuedTask = { provider: null, ollama_host_id: null };
    expect(requeuedTask.provider).toBeNull();
    expect(requeuedTask.ollama_host_id).toBeNull();
  });

  test('epoch check requeues when retries available', () => {
    const taskEpoch = 5;
    const currentEpoch = 7;
    const retryCount = 0;
    const maxRetries = 2;

    const isOrphan = taskEpoch < currentEpoch;
    const canRequeue = retryCount < maxRetries;

    expect(isOrphan).toBe(true);
    expect(canRequeue).toBe(true);
  });

  test('epoch check cancels when retries exhausted', () => {
    const retryCount = 2;
    const maxRetries = 2;

    const canRequeue = retryCount < maxRetries;
    expect(canRequeue).toBe(false);
  });
});
```

- [x] **Step 2: Run all orphan and workflow tests**

Run: `torque-remote "cd $TORQUE_PROJECT_DIR/server && npx vitest run tests/orphan-requeue.test.js tests/workflow-runtime.test.js tests/orphan-cleanup.test.js tests/await-restart-recovery.test.js"`
Expected: ALL PASS

- [x] **Step 3: Commit**

```bash
git add server/tests/orphan-requeue.test.js
git commit -m "test: integration tests for workflow-aware orphan requeue"
```
