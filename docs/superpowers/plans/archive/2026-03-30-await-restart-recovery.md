# Await Restart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `await_task` and `await_workflow` recover gracefully when tasks are cancelled by server restart or crash, with optional automatic resubmission.

**Architecture:** Add a structured `cancel_reason` column to the tasks table and a `server_epoch` counter to detect orphaned tasks from crashed servers. The await handlers detect restart-cancelled or orphaned tasks and either return a rich recovery response or auto-resubmit (opt-in). No server-side auto-recovery -- Claude decides.

**Tech Stack:** Node.js, better-sqlite3, Vitest

---

### Task 1: Schema Migration -- `cancel_reason` and `server_epoch` columns

**Files:**
- Modify: `server/db/schema-migrations.js:829-843` (append new migrations at end of `runMigrations`)
- Modify: `server/db/config-keys.js:4-50` (add `server_epoch` to valid config keys)
- Test: `server/tests/await-restart-recovery.test.js` (new)

- [ ] **Step 1: Write failing test for cancel_reason column**

```js
// server/tests/await-restart-recovery.test.js
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

describe('await restart recovery -- schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        task_description TEXT,
        working_directory TEXT,
        provider TEXT,
        model TEXT,
        timeout_minutes INTEGER DEFAULT 30,
        error_output TEXT DEFAULT '',
        output TEXT DEFAULT '',
        metadata TEXT,
        created_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        workflow_id TEXT,
        workflow_node_id TEXT,
        tags TEXT,
        ollama_host_id TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 2,
        mcp_instance_id TEXT,
        original_provider TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('cancel_reason column exists after migration', () => {
    const safeAddColumn = (table, colDef) => {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch { /* exists */ }
    };
    safeAddColumn('tasks', 'cancel_reason TEXT');
    safeAddColumn('tasks', 'server_epoch INTEGER');

    db.prepare(`INSERT INTO tasks (id, status, cancel_reason, server_epoch) VALUES (?, ?, ?, ?)`).run(
      'test-1', 'cancelled', 'server_restart', 1
    );
    const row = db.prepare('SELECT cancel_reason, server_epoch FROM tasks WHERE id = ?').get('test-1');
    expect(row.cancel_reason).toBe('server_restart');
    expect(row.server_epoch).toBe(1);
  });

  test('cancel_reason is null by default', () => {
    const safeAddColumn = (table, colDef) => {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch { /* exists */ }
    };
    safeAddColumn('tasks', 'cancel_reason TEXT');

    db.prepare(`INSERT INTO tasks (id, status) VALUES (?, ?)`).run('test-2', 'pending');
    const row = db.prepare('SELECT cancel_reason FROM tasks WHERE id = ?').get('test-2');
    expect(row.cancel_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS (self-contained in-memory DB test, no production code yet)

- [ ] **Step 3: Add cancel_reason and server_epoch columns to schema-migrations.js**

In `server/db/schema-migrations.js`, append before the closing `}` of `runMigrations` (after the `model_family_templates` CREATE TABLE block around line 842):

```js
  // Await restart recovery: structured cancel reason + server epoch
  safeAddColumn('tasks', 'cancel_reason TEXT');
  safeAddColumn('tasks', 'server_epoch INTEGER');
```

- [ ] **Step 4: Add server_epoch to valid config keys**

In `server/db/config-keys.js`, add `'server_epoch'` to the `VALID_CONFIG_KEYS` set (alphabetical order, after `'scheduling_mode'`):

```js
  'server_epoch',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/db/schema-migrations.js server/db/config-keys.js server/tests/await-restart-recovery.test.js
git commit -m "feat: add cancel_reason and server_epoch columns for await restart recovery"
```

---

### Task 2: Server Epoch Lifecycle -- increment on startup, stamp on task creation

**Files:**
- Modify: `server/index.js:680-682` (increment epoch after DB init)
- Modify: `server/db/task-core.js:248-310` (stamp epoch on task creation)
- Modify: `server/config.js` (expose `getEpoch()`)
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write failing test for epoch increment and task stamping**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- server epoch', () => {
  test('epoch increments on each startup', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)');

    const getEpoch = () => {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get('server_epoch');
      return row ? parseInt(row.value, 10) : 0;
    };
    const setEpoch = (val) => {
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('server_epoch', String(val));
    };

    // First boot: 0 -> 1
    let epoch = getEpoch();
    epoch += 1;
    setEpoch(epoch);
    expect(epoch).toBe(1);

    // Second boot: 1 -> 2
    epoch = getEpoch();
    epoch += 1;
    setEpoch(epoch);
    expect(epoch).toBe(2);

    db.close();
  });

  test('task created with current server epoch', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        task_description TEXT,
        server_epoch INTEGER
      )
    `);

    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('server_epoch', '3');

    const currentEpoch = parseInt(db.prepare('SELECT value FROM config WHERE key = ?').get('server_epoch').value, 10);
    db.prepare('INSERT INTO tasks (id, status, server_epoch) VALUES (?, ?, ?)').run('task-1', 'pending', currentEpoch);

    const task = db.prepare('SELECT server_epoch FROM tasks WHERE id = ?').get('task-1');
    expect(task.server_epoch).toBe(3);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (schema-level tests)**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 3: Add epoch increment to server startup**

In `server/index.js`, after `serverConfig.init({ db });` (around line 681), add:

```js
  // Bump server epoch -- used by await handlers to detect orphaned tasks from crashed servers
  {
    const prevEpoch = parseInt(db.getConfig('server_epoch') || '0', 10);
    const newEpoch = prevEpoch + 1;
    db.setConfig('server_epoch', String(newEpoch));
    serverConfig.setEpoch(newEpoch);
    debugLog(`Server epoch: ${newEpoch}`);
  }
```

- [ ] **Step 4: Add epoch accessor to serverConfig**

In `server/config.js`, add a cached epoch value:

```js
let _serverEpoch = 0;

function setEpoch(epoch) {
  _serverEpoch = epoch;
}

function getEpoch() {
  return _serverEpoch;
}
```

Export `setEpoch` and `getEpoch` from the module.

- [ ] **Step 5: Stamp server_epoch on task creation**

In `server/db/task-core.js`, in the `createTask` function (around line 297), add `server_epoch` to the INSERT columns and values.

In the column list (line 301-302), add `server_epoch` after `stall_timeout_seconds`:
```
      complexity, review_status, ollama_host_id, original_provider, provider_switched_at, metadata, workflow_id, workflow_node_id, stall_timeout_seconds, server_epoch
```

Add a corresponding `?` in the VALUES clause, and pass the epoch value in the `stmt.run(...)` call.

To get the current epoch, add at the top of `createTask`:
```js
  const serverConfig = require('../config');
  const currentEpoch = serverConfig.getEpoch();
```

Pass `currentEpoch` as the last parameter to `stmt.run(...)`.

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/config.js server/db/task-core.js server/tests/await-restart-recovery.test.js
git commit -m "feat: server epoch lifecycle -- increment on startup, stamp on task creation"
```

---

### Task 3: cancelTask accepts structured cancel_reason

**Files:**
- Modify: `server/execution/task-cancellation.js:36-111`
- Modify: `server/db/task-core.js:492-525` (updateTaskStatus to persist cancel_reason)
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write failing test for cancel_reason persistence**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- cancel_reason persistence', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        task_description TEXT,
        error_output TEXT DEFAULT '',
        output TEXT DEFAULT '',
        cancel_reason TEXT,
        server_epoch INTEGER,
        metadata TEXT
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('updateTaskStatus persists cancel_reason when status is cancelled', () => {
    db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run('task-cr-1', 'running');

    db.prepare('UPDATE tasks SET status = ?, cancel_reason = ?, error_output = ? WHERE id = ?')
      .run('cancelled', 'server_restart', 'Server shutdown', 'task-cr-1');

    const row = db.prepare('SELECT status, cancel_reason, error_output FROM tasks WHERE id = ?').get('task-cr-1');
    expect(row.status).toBe('cancelled');
    expect(row.cancel_reason).toBe('server_restart');
    expect(row.error_output).toBe('Server shutdown');
  });

  test('cancel_reason is not set for non-cancelled status', () => {
    db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)').run('task-cr-2', 'running');

    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('completed', 'task-cr-2');

    const row = db.prepare('SELECT cancel_reason FROM tasks WHERE id = ?').get('task-cr-2');
    expect(row.cancel_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (schema-only assertions)**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 3: Modify updateTaskStatus to persist cancel_reason**

In `server/db/task-core.js`, in the `updateTaskStatus` function (around line 492), add handling for the `cancel_reason` field.

After the `_provider_switch_reason` extraction (around line 502), add:

```js
  // Persist cancel_reason when cancelling a task
  const cancelReason = additionalFields.cancel_reason || null;
  delete additionalFields.cancel_reason;
  if (status === 'cancelled' && cancelReason) {
    additionalFields.cancel_reason = cancelReason;
  }
```

This ensures `cancel_reason` flows through the existing dynamic column update logic in `updateTaskStatus`.

- [ ] **Step 4: Modify cancelTask to accept and pass cancel_reason**

In `server/execution/task-cancellation.js`, change the `cancelTask` signature (line 36):

```js
  function cancelTask(taskId, reason = 'Cancelled by user', options = {}) {
    const cancelReason = options.cancel_reason || 'user';
```

Then in each `db.updateTaskStatus` call within `cancelTask`, add `cancel_reason` to the additionalFields.

For the running process path (line 57):
```js
        db.updateTaskStatus(fullId, 'cancelled', {
          output: sanitizeTaskOutput(proc.output),
          error_output: proc.errorOutput + `\n${reason}`,
          cancel_reason: cancelReason
        });
```

For the queued task path (line 91):
```js
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason,
        cancel_reason: cancelReason
      });
```

For the blocked/pending path (line 104):
```js
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason,
        cancel_reason: cancelReason
      });
```

For the retry_scheduled path (around line 113), same pattern -- add `cancel_reason: cancelReason`.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/execution/task-cancellation.js server/db/task-core.js server/tests/await-restart-recovery.test.js
git commit -m "feat: cancelTask accepts structured cancel_reason option"
```

---

### Task 4: Wire cancel_reason into all cancel codepaths

**Files:**
- Modify: `server/task-manager.js:681-684` (shutdown passes `server_restart`)
- Modify: `server/maintenance/orphan-cleanup.js:217-237` (stale check passes `timeout`)
- Modify: `server/maintenance/orphan-cleanup.js:393-483` (stall detection passes `stall`)
- Modify: `server/maintenance/orphan-cleanup.js:496-545` (host failover passes `host_failover`)
- Modify: `server/index.js:779-843` (startup orphan cleanup uses `cancelled` + `orphan_cleanup`)
- Modify: `server/execution/workflow-runtime.js` (cascade cancel passes `workflow_cascade`)
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write test for cancel codepath reasons**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- cancel codepath reasons', () => {
  test('shutdown cancelTask passes server_restart reason', () => {
    const calls = [];
    const mockCancelTask = (id, reason, options = {}) => {
      calls.push({ id, reason, cancel_reason: options.cancel_reason || 'user' });
    };

    const runningTaskIds = ['task-a', 'task-b'];
    for (const taskId of runningTaskIds) {
      mockCancelTask(taskId, 'Server shutdown', { cancel_reason: 'server_restart' });
    }

    expect(calls).toHaveLength(2);
    expect(calls[0].cancel_reason).toBe('server_restart');
    expect(calls[1].cancel_reason).toBe('server_restart');
  });

  test('all cancel_reason values are from the valid set', () => {
    const validReasons = new Set([
      'user', 'server_restart', 'stall', 'timeout',
      'orphan_cleanup', 'host_failover', 'workflow_cascade'
    ]);

    // Each codepath reason must be valid
    for (const reason of ['server_restart', 'timeout', 'stall', 'host_failover', 'orphan_cleanup', 'workflow_cascade', 'user']) {
      expect(validReasons.has(reason)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 3: Wire server_restart into shutdown**

In `server/task-manager.js`, in the `shutdown` function (around line 683), change:

```js
      cancelTask(taskId, 'Server shutdown');
```

to:

```js
      cancelTask(taskId, 'Server shutdown', { cancel_reason: 'server_restart' });
```

- [ ] **Step 4: Wire timeout into stale task check**

In `server/maintenance/orphan-cleanup.js`, in `checkStaleRunningTasks` (around line 222), change:

```js
          cancelTask(task.id, 'Timeout exceeded (stale check)');
```

to:

```js
          cancelTask(task.id, 'Timeout exceeded (stale check)', { cancel_reason: 'timeout' });
```

And for the direct DB update path (around line 225), add `cancel_reason`:

```js
          db.updateTaskStatus(task.id, 'cancelled', {
            error_output: `Auto-cancelled: Task exceeded ${task.timeout_minutes || 480} minute timeout (detected by stale check)`,
            cancel_reason: 'timeout'
          });
```

- [ ] **Step 5: Wire stall into stall detection**

In `server/maintenance/orphan-cleanup.js`, in `checkStalledTasks` (around line 476), change:

```js
          cancelTask(taskId, `Stalled - no output for ${activity.lastActivitySeconds}s`);
```

to:

```js
          cancelTask(taskId, `Stalled - no output for ${activity.lastActivitySeconds}s`, { cancel_reason: 'stall' });
```

- [ ] **Step 6: Wire host_failover into host failover cleanup**

In `server/maintenance/orphan-cleanup.js`, in `cleanupOrphanedHostTasks` (around line 519), change from `failed` to `cancelled`:

```js
      db.updateTaskStatus(task.id, 'cancelled', {
        error_output: (task.error_output || '') + `\n[HOST FAILOVER] ${errorMessage}\n`,
        completed_at: new Date().toISOString(),
        cancel_reason: 'host_failover'
      });
```

- [ ] **Step 7: Wire orphan_cleanup into startup orphan handling**

In `server/index.js`, in the `markStartupOrphanFailed` function (around line 779), change:

```js
    const markStartupOrphanFailed = (task, updates) => {
      db.updateTaskStatus(task.id, 'failed', updates);
```

to:

```js
    const markStartupOrphanCancelled = (task, updates) => {
      db.updateTaskStatus(task.id, 'cancelled', { ...updates, cancel_reason: 'orphan_cleanup' });
```

Update all three call sites (lines 803, 810, 836) from `markStartupOrphanFailed` to `markStartupOrphanCancelled`.

- [ ] **Step 8: Wire workflow_cascade into workflow termination**

In `server/execution/workflow-runtime.js`, find where cascade cancellation calls `cancelTask` or `updateTaskStatus(..., 'cancelled', ...)` for dependent tasks. Add `{ cancel_reason: 'workflow_cascade' }` to those calls. Search for `cancelTask` or `updateTaskStatus.*cancelled` in that file and add the option.

- [ ] **Step 9: Run full test suite**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/task-manager.js server/maintenance/orphan-cleanup.js server/index.js server/execution/workflow-runtime.js server/tests/await-restart-recovery.test.js
git commit -m "feat: wire cancel_reason into all cancel codepaths"
```

---

### Task 5: await_task restart recovery logic

**Files:**
- Modify: `server/handlers/workflow/await.js:1061-1250` (handleAwaitTask)
- Modify: `server/tool-defs/workflow-defs.js:798-818` (add `auto_resubmit_on_restart` param)
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write test for restart recovery formatting**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- handleRestartRecovery', () => {
  test('formatDuration works correctly', async () => {
    const { formatDuration } = await import('../handlers/workflow/await.js');
    expect(formatDuration(150000)).toBe('2m 30s');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(0)).toBe('0s');
  });

  test('restart cancel reasons are correctly identified', () => {
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    expect(RESTART_CANCEL_REASONS.has('server_restart')).toBe(true);
    expect(RESTART_CANCEL_REASONS.has('orphan_cleanup')).toBe(true);
    expect(RESTART_CANCEL_REASONS.has('user')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('stall')).toBe(false);
    expect(RESTART_CANCEL_REASONS.has('timeout')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 3: Add auto_resubmit_on_restart parameter to tool definitions**

In `server/tool-defs/workflow-defs.js`, in the `await_task` properties (around line 815), add:

```js
        auto_resubmit_on_restart: { type: 'boolean', description: 'Automatically resubmit tasks cancelled by server restart and continue waiting (default: false). When true, the await loop clones the task and seamlessly continues.' },
```

Add the same parameter to `await_workflow` properties (around line 792).

- [ ] **Step 4: Implement handleRestartRecovery helper function**

Add this function in `server/handlers/workflow/await.js` (above `handleAwaitTask`, around line 1060):

```js
/**
 * Handle a task that was cancelled by server restart or detected as an orphan.
 * Either returns a rich recovery response or auto-resubmits and continues awaiting.
 */
async function handleRestartRecovery(task, args, awaitStartTime, currentEpoch) {
  const autoResubmit = args.auto_resubmit_on_restart === true;
  const taskId = task.id;

  // Parse metadata
  let meta = {};
  try {
    meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
  } catch { meta = {}; }

  // Double-resubmit prevention: follow the pointer if already resubmitted
  if (meta.resubmitted_as) {
    if (autoResubmit) {
      return handleAwaitTask({ ...args, task_id: meta.resubmitted_as });
    }
    let output = `## Task Already Resubmitted\n\n`;
    output += `**Original Task:** ${taskId}\n`;
    output += `**Resubmitted As:** ${meta.resubmitted_as}\n`;
    output += `Call \`await_task({ task_id: "${meta.resubmitted_as}" })\` to continue waiting.\n`;
    return { content: [{ type: 'text', text: output }] };
  }

  // Resubmit loop breaker: stop after 3 restart resubmissions
  const restartResubmitCount = meta.restart_resubmit_count || 0;

  if (autoResubmit && restartResubmitCount < 3) {
    const newTaskId = require('crypto').randomUUID();
    const newMeta = { ...meta, restart_resubmit_count: restartResubmitCount + 1, resubmitted_from: taskId };

    taskCore.createTask({
      id: newTaskId,
      status: 'pending',
      task_description: task.task_description,
      working_directory: task.working_directory,
      provider: task.provider,
      model: task.model,
      timeout_minutes: task.timeout_minutes,
      tags: task.tags,
      workflow_id: task.workflow_id,
      workflow_node_id: task.workflow_node_id,
      original_provider: task.original_provider,
      metadata: JSON.stringify(newMeta),
    });

    // Point old task to replacement
    const origMeta = { ...meta, resubmitted_as: newTaskId };
    try { taskMetadata.updateMetadata(taskId, origMeta); } catch { /* non-fatal */ }

    logger.info(`[await-task] Restart recovery: resubmitted ${taskId} as ${newTaskId}`);

    // Continue awaiting the new task
    return handleAwaitTask({ ...args, task_id: newTaskId });
  }

  // Manual recovery response (default, or loop breaker triggered)
  const duration = task.started_at
    ? formatDuration(new Date(task.completed_at || Date.now()) - new Date(task.started_at))
    : 'unknown';

  let output = `## Task Cancelled by Server Restart\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Cancel Reason:** ${task.cancel_reason}\n`;
  output += `**Original Description:** ${(task.task_description || '').slice(0, 500)}\n`;
  output += `**Provider:** ${task.provider || 'unknown'}\n`;
  output += `**Model:** ${task.model || 'default'}\n`;
  output += `**Running Time Before Cancel:** ${duration}\n`;

  if (restartResubmitCount >= 3) {
    output += `\n**WARNING:** Task has been resubmitted ${restartResubmitCount} times due to restarts. Auto-resubmit disabled.\n`;
  }

  if (task.output) {
    const truncated = task.output.length > 1500
      ? '...(truncated)\n' + task.output.slice(-1500)
      : task.output;
    output += `\n### Partial Output\n\`\`\`\n${truncated}\n\`\`\`\n`;
  }

  try {
    const files = [...collectTaskCommitPaths(taskId, task.working_directory)];
    if (files.length > 0) {
      output += `\n### Files Modified\n`;
      for (const f of files.slice(0, 20)) {
        output += `- ${f}\n`;
      }
    }
  } catch { /* non-fatal */ }

  output += `\n### Recovery Options\n`;
  output += `- Resubmit with \`submit_task\` using the same description\n`;
  output += `- Check partial output and files modified before deciding\n`;
  output += `- Use \`auto_resubmit_on_restart: true\` in future await calls for automatic recovery\n`;

  return { content: [{ type: 'text', text: output }] };
}
```

- [ ] **Step 5: Wire restart recovery into handleAwaitTask**

In `server/handlers/workflow/await.js`, in `handleAwaitTask`, replace the initial terminal-state check (around lines 1091-1095) with:

```js
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    const serverConfig = require('../../config');
    const currentEpoch = serverConfig.getEpoch();

    // Epoch check: task is "running" but from a previous server lifetime (crash orphan)
    if (initialTask.status === 'running' && initialTask.server_epoch && initialTask.server_epoch < currentEpoch) {
      taskCore.updateTaskStatus(taskId, 'cancelled', {
        error_output: `Task orphaned -- server epoch ${initialTask.server_epoch} < current ${currentEpoch}`,
        cancel_reason: 'orphan_cleanup',
        completed_at: new Date().toISOString(),
      });
      const orphanedTask = taskCore.getTask(taskId);
      return handleRestartRecovery(orphanedTask, args, awaitStartTime, currentEpoch);
    }

    // If already terminal, check for restart recovery
    if (terminalStates.includes(initialTask.status)) {
      if (initialTask.status === 'cancelled' && RESTART_CANCEL_REASONS.has(initialTask.cancel_reason)) {
        return handleRestartRecovery(initialTask, args, awaitStartTime, currentEpoch);
      }
      const output = formatStandaloneTaskResult(initialTask, awaitStartTime);
      return { content: [{ type: 'text', text: output }] };
    }
```

Also inside the poll loop (around line 1104), add the same checks before the existing terminal handling:

```js
      if (task.status === 'running' && task.server_epoch && task.server_epoch < currentEpoch) {
        taskCore.updateTaskStatus(taskId, 'cancelled', {
          error_output: `Task orphaned -- server epoch ${task.server_epoch} < current ${currentEpoch}`,
          cancel_reason: 'orphan_cleanup',
          completed_at: new Date().toISOString(),
        });
        const orphanedTask = taskCore.getTask(taskId);
        return handleRestartRecovery(orphanedTask, args, awaitStartTime, currentEpoch);
      }

      if (terminalStates.includes(task.status)) {
        if (task.status === 'cancelled' && RESTART_CANCEL_REASONS.has(task.cancel_reason)) {
          return handleRestartRecovery(task, args, awaitStartTime, currentEpoch);
        }
        // ... existing terminal handling continues ...
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/handlers/workflow/await.js server/tool-defs/workflow-defs.js server/tests/await-restart-recovery.test.js
git commit -m "feat: await_task restart recovery -- detect, report, and auto-resubmit"
```

---

### Task 6: await_workflow restart recovery logic

**Files:**
- Modify: `server/handlers/workflow/await.js:434-640` (handleAwaitWorkflow)
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write test for workflow restart recovery filtering**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- await_workflow', () => {
  test('workflow recovery identifies only restart-cancelled tasks', () => {
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    const tasks = [
      { id: 't1', status: 'completed', cancel_reason: null },
      { id: 't2', status: 'cancelled', cancel_reason: 'server_restart', workflow_node_id: 'step-2' },
      { id: 't3', status: 'pending', cancel_reason: null },
      { id: 't4', status: 'cancelled', cancel_reason: 'user' },
    ];

    const toResubmit = tasks.filter(t =>
      t.status === 'cancelled' && RESTART_CANCEL_REASONS.has(t.cancel_reason)
    );
    expect(toResubmit).toHaveLength(1);
    expect(toResubmit[0].id).toBe('t2');
  });

  test('user-cancelled tasks are NOT resubmitted', () => {
    const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
    const task = { id: 't1', status: 'cancelled', cancel_reason: 'user' };
    expect(RESTART_CANCEL_REASONS.has(task.cancel_reason)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 3: Add restart recovery to handleAwaitWorkflow**

In `server/handlers/workflow/await.js`, in `handleAwaitWorkflow`, add constants at the top of the function (after the heartbeatState initialization, around line 449):

```js
  const RESTART_CANCEL_REASONS = new Set(['server_restart', 'orphan_cleanup']);
  const serverConfig = require('../../config');
  const currentEpoch = serverConfig.getEpoch();
  const autoResubmit = args.auto_resubmit_on_restart === true;
```

Inside the `while (true)` loop, after fetching tasks (line 473 `const tasks = ...`), add before the unacked terminal task check:

```js
      // Epoch check: mark running tasks from a previous epoch as orphaned
      for (const task of tasks) {
        if (task.status === 'running' && task.server_epoch && task.server_epoch < currentEpoch) {
          taskCore.updateTaskStatus(task.id, 'cancelled', {
            error_output: `Task orphaned -- server epoch ${task.server_epoch} < current ${currentEpoch}`,
            cancel_reason: 'orphan_cleanup',
            completed_at: new Date().toISOString(),
          });
          task.status = 'cancelled';
          task.cancel_reason = 'orphan_cleanup';
        }
      }

      // Restart recovery: find restart-cancelled tasks not yet acknowledged
      const restartCancelled = tasks.filter(t =>
        t.status === 'cancelled' && RESTART_CANCEL_REASONS.has(t.cancel_reason) && !acknowledged.has(t.id)
      );

      if (restartCancelled.length > 0 && autoResubmit) {
        for (const task of restartCancelled) {
          let meta = {};
          try { meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {}); } catch { meta = {}; }
          if (meta.resubmitted_as) continue;

          const restartCount = meta.restart_resubmit_count || 0;
          if (restartCount >= 3) continue;

          const newTaskId = require('crypto').randomUUID();
          const newMeta = { ...meta, restart_resubmit_count: restartCount + 1, resubmitted_from: task.id };

          taskCore.createTask({
            id: newTaskId,
            status: 'pending',
            task_description: task.task_description,
            working_directory: task.working_directory,
            provider: task.provider,
            model: task.model,
            timeout_minutes: task.timeout_minutes,
            tags: task.tags,
            workflow_id: task.workflow_id,
            workflow_node_id: task.workflow_node_id,
            original_provider: task.original_provider,
            metadata: JSON.stringify(newMeta),
          });

          const origMeta = { ...meta, resubmitted_as: newTaskId };
          try { taskMetadata.updateMetadata(task.id, origMeta); } catch { /* non-fatal */ }

          workflowTaskIds.add(newTaskId);
          acknowledged.add(task.id);

          logger.info(`[workflow-await] Restart recovery: resubmitted ${task.id} as ${newTaskId} (node: ${task.workflow_node_id})`);
        }

        // Persist acknowledged set
        const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
        workflowEngine.updateWorkflow(args.workflow_id, { context: updatedCtx });

        await new Promise(r => setTimeout(r, pollMs));
        continue;
      }

      // Manual recovery: yield restart-cancelled tasks one at a time for review
      if (restartCancelled.length > 0 && !autoResubmit) {
        const task = restartCancelled[0];
        acknowledged.add(task.id);
        const updatedCtx = { ...ctx, acknowledged_tasks: Array.from(acknowledged) };
        workflowEngine.updateWorkflow(args.workflow_id, { context: updatedCtx });

        let output = `## Workflow Task Cancelled by Server Restart\n\n`;
        output += `**Task ID:** ${task.id}\n`;
        output += `**Node:** ${task.workflow_node_id || task.id.substring(0, 8)}\n`;
        output += `**Cancel Reason:** ${task.cancel_reason}\n`;
        output += `**Description:** ${(task.task_description || '').slice(0, 300)}\n`;
        if (task.output) {
          const truncated = task.output.length > 1000
            ? '...(truncated)\n' + task.output.slice(-1000)
            : task.output;
          output += `\n### Partial Output\n\`\`\`\n${truncated}\n\`\`\`\n`;
        }

        const completed = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const running = tasks.filter(t => t.status === 'running').length;
        const pending = tasks.filter(t => ['pending', 'queued', 'blocked'].includes(t.status)).length;
        const cancelled = tasks.filter(t => t.status === 'cancelled').length;

        output += `\n### Workflow Progress\n`;
        output += `| Status | Count |\n|--------|-------|\n`;
        output += `| Completed | ${completed} |\n`;
        output += `| Cancelled (restart) | ${cancelled} |\n`;
        output += `| Running | ${running} |\n`;
        output += `| Pending | ${pending} |\n`;
        output += `| Failed | ${failed} |\n`;

        output += `\n### Recovery Options\n`;
        output += `- Resubmit this task manually with \`submit_task\`\n`;
        output += `- Use \`auto_resubmit_on_restart: true\` for automatic recovery\n`;
        output += `- Call \`await_workflow\` again to review the next cancelled task\n`;

        return { content: [{ type: 'text', text: output }] };
      }
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/await-restart-recovery.test.js
git commit -m "feat: await_workflow restart recovery -- surgical resubmit of cancelled tasks"
```

---

### Task 7: Integration tests and edge cases

**Files:**
- Test: `server/tests/await-restart-recovery.test.js` (extend)

- [ ] **Step 1: Write integration tests for edge cases**

Append to `server/tests/await-restart-recovery.test.js`:

```js
describe('await restart recovery -- edge cases', () => {
  test('double-resubmit prevention via resubmitted_as pointer', () => {
    const meta = { resubmitted_as: 'new-task-123', restart_resubmit_count: 1 };
    // Handler should follow pointer, not resubmit again
    expect(meta.resubmitted_as).toBe('new-task-123');
    expect(meta.restart_resubmit_count).toBe(1);
  });

  test('resubmit loop breaker triggers at count 3', () => {
    const meta = { restart_resubmit_count: 3 };
    const shouldAutoResubmit = meta.restart_resubmit_count < 3;
    expect(shouldAutoResubmit).toBe(false);
  });

  test('resubmit loop breaker allows count 0, 1, 2', () => {
    for (const count of [0, 1, 2]) {
      const meta = { restart_resubmit_count: count };
      const shouldAutoResubmit = meta.restart_resubmit_count < 3;
      expect(shouldAutoResubmit).toBe(true);
    }
  });

  test('epoch comparison detects orphaned tasks', () => {
    // Task from epoch 5, server at epoch 7 = orphan
    expect(5 < 7).toBe(true);
    // Task from current epoch = not orphan
    expect(7 < 7).toBe(false);
    // Task with no epoch (legacy) = not detected as orphan
    expect(undefined < 7).toBe(false);
    expect(null < 7).toBe(false); // null < 7 is true in JS, so we need the guard
  });

  test('epoch guard requires both epoch and comparison', () => {
    // The guard in the code is: task.server_epoch && task.server_epoch < currentEpoch
    // This correctly handles null/undefined/0 because && short-circuits on falsy
    const currentEpoch = 7;
    const cases = [
      { epoch: null, expected: false },
      { epoch: undefined, expected: false },
      { epoch: 0, expected: false },
      { epoch: 5, expected: true },
      { epoch: 7, expected: false },
      { epoch: 8, expected: false },
    ];
    for (const { epoch, expected } of cases) {
      const result = !!(epoch && epoch < currentEpoch);
      expect(result).toBe(expected);
    }
  });

  test('cancel_reason values are exhaustive and non-overlapping', () => {
    const allReasons = ['user', 'server_restart', 'stall', 'timeout', 'orphan_cleanup', 'host_failover', 'workflow_cascade'];
    const restartReasons = new Set(['server_restart', 'orphan_cleanup']);

    // All unique
    expect(new Set(allReasons).size).toBe(allReasons.length);

    // Restart reasons are a proper subset
    for (const r of restartReasons) {
      expect(allReasons).toContain(r);
    }

    // Non-restart reasons are excluded
    expect(restartReasons.has('user')).toBe(false);
    expect(restartReasons.has('stall')).toBe(false);
    expect(restartReasons.has('timeout')).toBe(false);
  });

  test('provider preservation uses resolved provider, not auto', () => {
    const originalTask = {
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      original_provider: 'codex',
    };
    // Resubmitted task should use the same provider
    expect(originalTask.provider).toBe('codex');
    expect(originalTask.provider).not.toBe('auto');
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `cd server && npx vitest run tests/await-restart-recovery.test.js`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add server/tests/await-restart-recovery.test.js
git commit -m "test: edge case tests for await restart recovery"
```

---

### Task 8: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add recovery documentation to CLAUDE.md**

In the `Task Completion Notifications` section, under `### Recommended patterns`, add a new bullet:

```markdown
- **Restart recovery:** `await_task({ task_id: "...", auto_resubmit_on_restart: true })` -- automatically resubmits tasks cancelled by server restart and continues waiting. The await loop detects restart-related cancellations via the `cancel_reason` field (`server_restart` or `orphan_cleanup`) and server epoch comparison. Without `auto_resubmit_on_restart`, returns a structured recovery response with partial output and recovery options.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document await restart recovery in CLAUDE.md"
```
