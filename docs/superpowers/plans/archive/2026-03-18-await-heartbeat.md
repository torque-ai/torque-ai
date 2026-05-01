# Await Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add periodic heartbeat yields to `await_task` and `await_workflow` so Claude gets progress check-ins instead of blocking silently for minutes.

**Architecture:** The await handlers gain a heartbeat timer that fires alongside existing event-bus listeners. When the timer fires (or a notable event occurs), the handler returns a structured heartbeat response. Claude processes it and re-invokes. New non-terminal events (`task:started`, `task:stall_warning`, `task:fallback`) are emitted from existing code paths. A `partial_output` column on the tasks table stores streaming output for inclusion in heartbeats.

**Tech Stack:** Node.js, SQLite (better-sqlite3), EventEmitter, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-await-heartbeat-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/db/schema-migrations.js` | Modify | Add `partial_output` column migration |
| `server/hooks/event-dispatch.js` | Modify | Reclassify `task:retry` as non-terminal; export event classification lists |
| `server/database.js` | Modify | Emit `task:started` when task transitions to running |
| `server/execution/fallback-retry.js` | Modify | Emit `task:fallback` on provider reroute |
| `server/maintenance/orphan-cleanup.js` | Modify | Emit `task:stall_warning` at 80% threshold |
| `server/utils/activity-monitoring.js` | Modify | Expose stall threshold for warning calculation |
| `server/handlers/workflow/await.js` | Modify | Add heartbeat timer, notable event listeners, heartbeat formatting |
| `server/tool-defs/workflow-defs.js` | Modify | Add `heartbeat_minutes` parameter to both await tools |
| `server/tests/event-dispatch-heartbeat.test.js` | Create | Tests for new event emissions |
| `server/tests/await-heartbeat.test.js` | Create | Tests for heartbeat timer, notable events, formatting |

---

## Task 1: Database Migration — `partial_output` Column

**Files:**
- Modify: `server/db/schema-migrations.js` (add migration after last existing migration)
- Modify: `server/db/schema-tables.js:235-266` (add column to CREATE TABLE for fresh installs)

- [ ] **Step 1: Write the failing test**

Create test in `server/tests/schema-tables.test.js` (append to existing file):

```javascript
test('tasks table has partial_output column', () => {
  const info = db.pragma('table_info(tasks)');
  const col = info.find(c => c.name === 'partial_output');
  expect(col).toBeDefined();
  expect(col.type).toBe('TEXT');
  expect(col.dflt_value).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/schema-tables.test.js -t "partial_output"`
Expected: FAIL — column does not exist yet

- [ ] **Step 3: Add migration**

In `server/db/schema-migrations.js`, find the last migration block (pattern: `safeAlterTable(db, 'tasks', 'ADD COLUMN ...')`) and add after it:

```javascript
  // Heartbeat: partial output capture for streaming providers
  safeAlterTable(db, 'tasks', 'ADD COLUMN partial_output TEXT DEFAULT NULL');
```

- [ ] **Step 4: Add column to CREATE TABLE for fresh installs**

In `server/db/schema-tables.js:265`, before the closing `)` of the tasks CREATE TABLE statement, add:

```sql
        -- Heartbeat: partial output from streaming providers
        partial_output TEXT
```

This goes after the `provider_switched_at TEXT` line (line 265).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/schema-tables.test.js -t "partial_output"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/db/schema-migrations.js server/db/schema-tables.js server/tests/schema-tables.test.js
git commit -m "feat(heartbeat): add partial_output column to tasks table"
```

---

## Task 2: Event Classification — Reclassify `task:retry` and Export Lists

**Files:**
- Modify: `server/hooks/event-dispatch.js:233-268`

- [ ] **Step 1: Write the failing test**

Create `server/tests/event-dispatch-heartbeat.test.js`:

```javascript
import { describe, test, expect } from 'vitest';

describe('event classification exports', () => {
  test('TERMINAL_EVENTS and NOTABLE_EVENTS are exported', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toBeDefined();
    expect(mod.NOTABLE_EVENTS).toBeDefined();
  });

  test('retry is classified as non-terminal (notable)', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).not.toContain('retry');
    expect(mod.NOTABLE_EVENTS).toContain('retry');
  });

  test('TERMINAL_EVENTS contains completed, failed, cancelled, skipped', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toEqual(
      expect.arrayContaining(['completed', 'failed', 'cancelled', 'skipped'])
    );
  });

  test('NOTABLE_EVENTS contains started, stall_warning, retry, fallback', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.NOTABLE_EVENTS).toEqual(
      expect.arrayContaining(['started', 'stall_warning', 'retry', 'fallback'])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js`
Expected: FAIL — exports don't exist

- [ ] **Step 3: Add event classification exports**

In `server/hooks/event-dispatch.js`, near the top of the file (after the imports/requires, before `dispatchTaskEvent`), add:

```javascript
/** Terminal events — task has reached a final state */
const TERMINAL_EVENTS = ['completed', 'failed', 'cancelled', 'skipped'];

/** Non-terminal notable events — interesting state changes worth reporting */
const NOTABLE_EVENTS = ['started', 'stall_warning', 'retry', 'fallback'];
```

Then in the `module.exports` block at the bottom, add `TERMINAL_EVENTS` and `NOTABLE_EVENTS` to the exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/hooks/event-dispatch.js server/tests/event-dispatch-heartbeat.test.js
git commit -m "feat(heartbeat): export TERMINAL_EVENTS and NOTABLE_EVENTS classifications"
```

---

## Task 3: Emit `task:started` Event

**Files:**
- Modify: `server/database.js:871-874` (where `started_at` is set on status to running)
- Test: `server/tests/event-dispatch-heartbeat.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/event-dispatch-heartbeat.test.js`:

```javascript
import { vi } from 'vitest';

describe('task:started event', () => {
  test('task:started is emitted when task transitions to running', async () => {
    const { taskEvents } = await import('../hooks/event-dispatch.js');
    const handler = vi.fn();
    taskEvents.on('task:started', handler);

    // Trigger the updateTaskStatus path that sets started_at
    // The exact approach depends on how database.js is structured
    // Create a task first, then update its status to 'running'
    const db = (await import('../database.js')).default || (await import('../database.js'));
    const taskId = 'test-started-' + Date.now();

    // Create a pending task
    db.createTask({
      id: taskId,
      task_description: 'Test task for started event',
      status: 'pending',
      working_directory: '/tmp'
    });

    // Transition to running — should emit task:started
    db.updateTaskStatus(taskId, 'running');

    // Give event a tick to emit
    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId })
    );

    taskEvents.removeListener('task:started', handler);
  });
});
```

Note: Adapt the import/mock pattern from existing tests in `server/tests/test-helpers.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js -t "task:started"`
Expected: FAIL — event not emitted

- [ ] **Step 3: Add task:started emission**

In `server/database.js`, find the `updateTaskStatus` function (around line 871). After the line that sets `started_at` when status is `'running'`, add:

```javascript
    // Emit task:started for heartbeat notifications
    if (status === 'running') {
      try {
        const { dispatchTaskEvent } = require('./hooks/event-dispatch');
        const updatedTask = this.getTask(id);
        if (updatedTask) {
          dispatchTaskEvent('started', updatedTask);
        }
      } catch (e) {
        // Non-fatal — never block status transition
      }
    }
```

Important: Use `require()` inside the function to avoid circular dependency issues (database.js is loaded very early). Wrap in try/catch because this must never block the status update.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js -t "task:started"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/database.js server/tests/event-dispatch-heartbeat.test.js
git commit -m "feat(heartbeat): emit task:started when task transitions to running"
```

---

## Task 4: Emit `task:stall_warning` Event

**Files:**
- Modify: `server/maintenance/orphan-cleanup.js:450-493` (checkStalledTasks loop)
- Test: `server/tests/event-dispatch-heartbeat.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/event-dispatch-heartbeat.test.js`:

```javascript
describe('task:stall_warning event', () => {
  test('task:stall_warning event has correct shape', async () => {
    const { taskEvents } = await import('../hooks/event-dispatch.js');
    const handler = vi.fn();
    taskEvents.on('task:stall_warning', handler);

    // Emit directly to validate the event contract
    taskEvents.emit('task:stall_warning', {
      taskId: 'test-stall-warn',
      provider: 'ollama',
      elapsed: 144,
      threshold: 180,
      description: 'Test task'
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'test-stall-warn',
        elapsed: 144,
        threshold: 180
      })
    );

    taskEvents.removeListener('task:stall_warning', handler);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (direct emit test)**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js -t "stall_warning"`
Expected: PASS — this validates the event contract shape

- [ ] **Step 3: Add stall warning emission to checkStalledTasks**

In `server/maintenance/orphan-cleanup.js`, add at module scope (near the top):

```javascript
// Track tasks that have already received a stall warning (prevent duplicates)
const _stallWarningEmitted = new Set();
```

Inside the `for` loop in `checkStalledTasks` (line 456), before `if (isStalled)` (line 475), add:

Note: The stall threshold is available as `activity.stallThreshold` (returned by `getTaskActivity` at `activity-monitoring.js:260`). Use this value directly — do not reference a `threshold` local variable.

```javascript
    // Emit stall warning at 80% of threshold (once per task)
    const stallThreshold = activity.stallThreshold;
    if (!isStalled && stallThreshold !== null && !_stallWarningEmitted.has(taskId)) {
      const warningThreshold = stallThreshold * 0.8;
      if (activity.lastActivitySeconds >= warningThreshold) {
        _stallWarningEmitted.add(taskId);
        try {
          const { taskEvents } = require('../hooks/event-dispatch');
          taskEvents.emit('task:stall_warning', {
            taskId,
            provider: proc?.provider || 'unknown',
            elapsed: activity.lastActivitySeconds,
            threshold: Math.round(stallThreshold),
            description: proc?.description || ''
          });
        } catch (e) {
          // Non-fatal
        }
      }
    }
```

Note: The `threshold` variable is available from the existing stall detection code (`activity-monitoring.js` returns it). Check `getTaskActivity` return value — it includes `stallThreshold`. If not directly available in this scope, read it from the activity object. See `server/utils/activity-monitoring.js:236` where `isStalled` is computed — the `threshold` variable is in that scope but may not be returned. If it is not returned, modify `getTaskActivity` to include `threshold` in its return value.

Also add cleanup: find where `runningProcesses.delete(taskId)` is called in `orphan-cleanup.js` and add `_stallWarningEmitted.delete(taskId)` there. Export `_stallWarningEmitted` (or a `clearStallWarnings()` function) for testing.

- [ ] **Step 4: Run tests**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/maintenance/orphan-cleanup.js server/utils/activity-monitoring.js server/tests/event-dispatch-heartbeat.test.js
git commit -m "feat(heartbeat): emit task:stall_warning at 80% of stall threshold"
```

---

## Task 5: Emit `task:fallback` Event

**Files:**
- Modify: `server/execution/fallback-retry.js` (emit in fallback functions)
- Test: `server/tests/event-dispatch-heartbeat.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/event-dispatch-heartbeat.test.js`:

```javascript
describe('task:fallback event', () => {
  test('task:fallback event shape is correct via dispatchTaskEvent', async () => {
    const { taskEvents, dispatchTaskEvent } = await import('../hooks/event-dispatch.js');
    const handler = vi.fn();
    taskEvents.on('task:fallback', handler);

    const mockTask = {
      id: 'test-fallback-1',
      status: 'pending',
      provider: 'deepinfra',
      original_provider: 'ollama',
      task_description: 'Test fallback task'
    };
    dispatchTaskEvent('fallback', mockTask);

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-fallback-1' })
    );

    taskEvents.removeListener('task:fallback', handler);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (dispatchTaskEvent handles arbitrary event names)**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js -t "task:fallback"`
Expected: PASS

- [ ] **Step 3: Add task:fallback emission to fallback functions**

In `server/execution/fallback-retry.js`, find the three main fallback functions:
- `tryOllamaCloudFallback` (line 91)
- `tryLocalFirstFallback` (line 187)
- `tryHashlineTieredFallback` (line 582)

In each function, after the task's provider is updated in the DB and before the task is re-queued, add:

```javascript
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      const updatedTask = deps.db.getTask(taskId);
      if (updatedTask) {
        dispatchTaskEvent('fallback', updatedTask);
      }
    } catch (e) {
      // Non-fatal
    }
```

Find the exact insertion point by looking for where the provider is changed (e.g., `db.updateTask(taskId, { provider: newProvider })` or similar pattern).

- [ ] **Step 4: Run full event dispatch test suite**

Run: `cd /path/to/torque && npx vitest run server/tests/event-dispatch-heartbeat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/fallback-retry.js server/tests/event-dispatch-heartbeat.test.js
git commit -m "feat(heartbeat): emit task:fallback on provider reroute"
```

---

## Task 6: Tool Definition — Add `heartbeat_minutes` Parameter

**Files:**
- Modify: `server/tool-defs/workflow-defs.js:769-803`

- [ ] **Step 1: Write the failing test**

Create `server/tests/await-heartbeat.test.js`:

```javascript
import { describe, test, expect } from 'vitest';

describe('await tool definitions', () => {
  test('await_workflow has heartbeat_minutes parameter', async () => {
    const defs = await import('../tool-defs/workflow-defs.js');
    const tools = defs.default || defs;

    // Find await_workflow definition — adapt to actual export shape
    const toolList = Array.isArray(tools) ? tools : tools.tools || [];
    const awaitWorkflow = toolList.find(t => t.name === 'await_workflow');

    expect(awaitWorkflow).toBeDefined();
    const props = awaitWorkflow.inputSchema?.properties || {};
    expect(props.heartbeat_minutes).toBeDefined();
    expect(props.heartbeat_minutes.type).toBe('number');
    expect(props.heartbeat_minutes.default).toBe(5);
  });

  test('await_task has heartbeat_minutes parameter', async () => {
    const defs = await import('../tool-defs/workflow-defs.js');
    const tools = defs.default || defs;

    const toolList = Array.isArray(tools) ? tools : tools.tools || [];
    const awaitTask = toolList.find(t => t.name === 'await_task');

    expect(awaitTask).toBeDefined();
    const props = awaitTask.inputSchema?.properties || {};
    expect(props.heartbeat_minutes).toBeDefined();
    expect(props.heartbeat_minutes.type).toBe('number');
    expect(props.heartbeat_minutes.default).toBe(5);
  });
});
```

Note: Adapt the import pattern based on how `workflow-defs.js` exports. Check `server/tests/workflow-await.test.js` for patterns.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "heartbeat_minutes"`
Expected: FAIL — parameter doesn't exist

- [ ] **Step 3: Add heartbeat_minutes to both tool schemas**

In `server/tool-defs/workflow-defs.js`, find `await_workflow` (line 769). In its `inputSchema.properties`, add:

```javascript
        heartbeat_minutes: {
          type: 'number',
          description: 'Minutes between scheduled progress heartbeats. Default 5. Set to 0 to disable.',
          default: 5
        },
```

Do the same for `await_task` (line 787).

Update both tool descriptions to mention heartbeats:
- Add "Returns heartbeat progress snapshots every N minutes while waiting." to each description.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/workflow-defs.js server/tests/await-heartbeat.test.js
git commit -m "feat(heartbeat): add heartbeat_minutes parameter to await tool schemas"
```

---

## Task 7: Heartbeat Formatter

**Files:**
- Modify: `server/handlers/workflow/await.js` (add formatHeartbeat function)
- Test: `server/tests/await-heartbeat.test.js` (append)

This is the formatting function that builds the heartbeat response text. Implement it before wiring it into the handler flow.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/await-heartbeat.test.js`:

```javascript
describe('formatHeartbeat', () => {
  test('scheduled heartbeat includes reason and task progress', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'abc123',
      reason: 'scheduled',
      elapsedMs: 272000, // 4m 32s
      runningTasks: [{
        id: 'abc123',
        provider: 'codex',
        host: 'cloud',
        elapsedMs: 272000,
        description: 'Write unit tests for auth module'
      }],
      taskCounts: { completed: 2, failed: 0, running: 1, pending: 3 },
      partialOutput: 'Creating test file auth.test.js...\nWriting test cases...',
      alerts: []
    });

    expect(result).toContain('Heartbeat');
    expect(result).toContain('scheduled');
    expect(result).toContain('4m 32s');
    expect(result).toContain('2 completed');
    expect(result).toContain('abc123');
    expect(result).toContain('codex');
    expect(result).toContain('Writing test cases');
  });

  test('stall_warning heartbeat includes alert', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'def456',
      reason: 'stall_warning',
      elapsedMs: 144000,
      runningTasks: [{
        id: 'def456',
        provider: 'ollama',
        host: 'local',
        elapsedMs: 144000,
        description: 'Generate data models'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: null,
      alerts: ['Approaching stall threshold (144s / 180s)']
    });

    expect(result).toContain('stall_warning');
    expect(result).toContain('Approaching stall threshold');
    expect(result).toContain('No output captured yet');
  });

  test('heartbeat with no partial output says so', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const result = formatHeartbeat({
      taskId: 'ghi789',
      reason: 'task_started',
      elapsedMs: 1000,
      runningTasks: [{
        id: 'ghi789',
        provider: 'codex',
        host: 'cloud',
        elapsedMs: 1000,
        description: 'Test task'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: null,
      alerts: []
    });

    expect(result).toContain('No output captured yet');
  });

  test('partial output is capped at 1500 chars', async () => {
    const { formatHeartbeat } = await import('../handlers/workflow/await.js');

    const longOutput = 'x'.repeat(3000);
    const result = formatHeartbeat({
      taskId: 'jkl012',
      reason: 'scheduled',
      elapsedMs: 300000,
      runningTasks: [{
        id: 'jkl012',
        provider: 'ollama',
        host: 'local',
        elapsedMs: 300000,
        description: 'Long task'
      }],
      taskCounts: { completed: 0, failed: 0, running: 1, pending: 0 },
      partialOutput: longOutput,
      alerts: []
    });

    // Should not contain more than 1500 consecutive x's
    expect(result).not.toContain('x'.repeat(2000));
    // But should contain some
    expect(result).toContain('x'.repeat(100));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "formatHeartbeat"`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement formatHeartbeat**

In `server/handlers/workflow/await.js`, add near the other format functions (around line 168):

```javascript
/**
 * Format a heartbeat response for await_task or await_workflow.
 * @param {Object} opts
 * @param {string} opts.taskId - Primary task or workflow ID
 * @param {string} opts.reason - scheduled|task_started|stall_warning|task_retried|provider_fallback
 * @param {number} opts.elapsedMs - Total elapsed time in ms
 * @param {Array} opts.runningTasks - [{id, provider, host, elapsedMs, description}]
 * @param {Object} opts.taskCounts - {completed, failed, running, pending}
 * @param {string|null} opts.partialOutput - Partial stdout or null
 * @param {Array<string>} opts.alerts - Alert messages
 * @param {Array} [opts.nextUpTasks] - Pending/queued tasks (workflow only)
 * @returns {string}
 */
function formatHeartbeat(opts) {
  const {
    taskId, reason, elapsedMs, runningTasks = [], taskCounts = {},
    partialOutput, alerts = [], nextUpTasks
  } = opts;

  const elapsed = formatDuration(elapsedMs);
  const lines = [];

  const context = opts.isWorkflow ? 'Await Workflow' : 'Await Task';
  lines.push(`## Heartbeat — ${context} ${taskId}`);
  lines.push('');
  lines.push(`**Reason:** ${reason}`);
  lines.push(`**Elapsed:** ${elapsed}`);
  lines.push(`**Tasks:** ${taskCounts.completed || 0} completed, ${taskCounts.failed || 0} failed, ${taskCounts.running || 0} running, ${taskCounts.pending || 0} pending`);
  lines.push('');

  if (runningTasks.length > 0) {
    lines.push('### Running Tasks');
    lines.push('| Task | Provider | Host | Elapsed | Description |');
    lines.push('|------|----------|------|---------|-------------|');
    for (const t of runningTasks) {
      const desc = (t.description || '').slice(0, 80);
      lines.push(`| ${t.id} | ${t.provider || '-'} | ${t.host || '-'} | ${formatDuration(t.elapsedMs)} | ${desc} |`);
    }
    lines.push('');
  }

  lines.push('### Partial Output');
  if (partialOutput && partialOutput.length > 0) {
    const truncated = partialOutput.length > 1500
      ? '...(truncated)\n' + partialOutput.slice(-1500)
      : partialOutput;
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
  } else {
    lines.push('No output captured yet (provider buffers until completion)');
  }
  lines.push('');

  if (alerts.length > 0) {
    lines.push('### Alerts');
    for (const alert of alerts) {
      lines.push(`- ${alert}`);
    }
    lines.push('');
  }

  if (nextUpTasks && nextUpTasks.length > 0) {
    lines.push('### Next Up');
    for (const t of nextUpTasks.slice(0, 5)) {
      lines.push(`- ${t.id}: ${(t.description || '').slice(0, 60)}`);
    }
    lines.push('');
  }

  lines.push('### Action');
  lines.push('Re-invoke to continue waiting, or take action (cancel, resubmit, etc.)');

  return lines.join('\n');
}
```

Add a `formatDuration` helper if not already present:

```javascript
function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
```

Export `formatHeartbeat` from the module.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "formatHeartbeat"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/await-heartbeat.test.js
git commit -m "feat(heartbeat): implement formatHeartbeat response builder"
```

---

## Task 8: Heartbeat Logic in `handleAwaitTask`

**Files:**
- Modify: `server/handlers/workflow/await.js:639-835` (handleAwaitTask)
- Test: `server/tests/await-heartbeat.test.js` (append)

This is the core handler change. The existing poll loop gains heartbeat timer and notable event listeners.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/await-heartbeat.test.js`. Use the mock patterns from `server/tests/workflow-await.test.js` for DB and event bus mocking:

```javascript
describe('handleAwaitTask heartbeat', () => {
  // Set up mocks following workflow-await.test.js patterns
  // (mockDb, mockTaskEvents, installCjsModuleMock, etc.)

  test('returns heartbeat after heartbeat_minutes interval', async () => {
    // 1. Create a task with status 'running'
    // 2. Call handleAwaitTask with heartbeat_minutes: 1
    // 3. Advance timer past 60 seconds
    // 4. Verify heartbeat returned with reason 'scheduled'
  });

  test('heartbeat_minutes=0 disables heartbeats', async () => {
    // 1. Create a running task
    // 2. Call handleAwaitTask with heartbeat_minutes: 0, timeout_minutes: 1
    // 3. Advance past 5 minutes (default heartbeat would fire)
    // 4. Advance to timeout
    // 5. Verify timeout returned, not heartbeat
  });

  test('notable event triggers immediate heartbeat', async () => {
    // 1. Create a queued task
    // 2. Call handleAwaitTask with heartbeat_minutes: 5
    // 3. Emit task:started for the task after 2 seconds
    // 4. Verify heartbeat returned with reason 'task_started'
  });

  test('terminal event returns completion, not heartbeat', async () => {
    // 1. Create a running task
    // 2. Call handleAwaitTask with heartbeat_minutes: 5
    // 3. Emit task:completed after 1 second
    // 4. Verify completion returned (not heartbeat)
  });

  test('notable event for wrong task_id is ignored', async () => {
    // 1. Create task A (running)
    // 2. Call handleAwaitTask for task A
    // 3. Emit task:started for task B (different id)
    // 4. Verify no immediate return
    // 5. Advance to heartbeat interval
    // 6. Verify scheduled heartbeat returned
  });

  test('heartbeat includes partial_output from DB', async () => {
    // 1. Create running task with partial_output = 'test output data'
    // 2. Call handleAwaitTask
    // 3. Advance to heartbeat interval
    // 4. Verify heartbeat contains 'test output data'
  });

  test('heartbeat timer clamped to remaining timeout', async () => {
    // heartbeat_minutes: 10, timeout_minutes: 3
    // Should timeout at 3 minutes, never get heartbeat
  });

  test('task:retry triggers heartbeat, not completion', async () => {
    // 1. Create a running task
    // 2. Call handleAwaitTask with heartbeat_minutes: 5
    // 3. Emit task:retry for the task after 2 seconds
    // 4. Verify heartbeat returned with reason 'task_retried' (NOT completion)
    // This validates the retry reclassification from terminal to non-terminal
  });

  test('heartbeat_minutes out of range is clamped', async () => {
    // heartbeat_minutes: -5 should become 0 (disabled)
    // heartbeat_minutes: 60 should become 30
    // Verify by checking behavior matches the clamped value
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "handleAwaitTask heartbeat"`
Expected: FAIL

- [ ] **Step 3: Implement heartbeat in handleAwaitTask**

In `server/handlers/workflow/await.js`, modify `handleAwaitTask` (line 639):

**A. Add constants** (near top of function):
```javascript
    const heartbeatMinutes = Math.max(0, Math.min(30, args.heartbeat_minutes ?? 5));
    const heartbeatMs = heartbeatMinutes > 0 ? heartbeatMinutes * 60 * 1000 : 0;
    const awaitStartTime = Date.now();
    const REASON_MAP = {
      started: 'task_started',
      stall_warning: 'stall_warning',
      retry: 'task_retried',
      fallback: 'provider_fallback'
    };
```

Import `NOTABLE_EVENTS` from `event-dispatch.js` at the top of the file.

**B. Replace the entire wait Promise** (lines 778-831):

This is a full replacement of the existing ~50-line Promise block, not an incremental modification. The existing `handlerRef` comparator has a pre-existing issue (compares a task object to a string ID — works only via poll fallback). The replacement fixes this for both terminal and notable handlers by extracting `.id` or `.taskId` from the payload.

Key listener management: each notable event gets a **named handler stored in a Map** to ensure cleanup can remove the exact function reference. Anonymous listeners in a loop would leak.

```javascript
    let signalType = null;
    let notablePayload = null;

    await new Promise(resolve => {
      // Store all listener refs for guaranteed cleanup
      const notableHandlers = new Map(); // event name -> handler fn

      const cleanup = () => {
        clearTimeout(pollTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        for (const ev of terminalStates) {
          taskEventsRef.removeListener('task:' + ev, terminalHandler);
        }
        for (const [ev, handler] of notableHandlers) {
          taskEventsRef.removeListener('task:' + ev, handler);
        }
        notableHandlers.clear();
        // ... shutdown listener cleanup
      };

      const done = (type, payload) => {
        if (signalType !== null) return; // first signal wins
        signalType = type;
        notablePayload = payload || null;
        cleanup();
        resolve();
      };

      // Terminal events — extract task ID from payload object
      const terminalHandler = (payload) => {
        const eid = payload?.id || payload?.taskId;
        if (eid && eid !== taskId) return;
        done('terminal', payload);
      };
      for (const ev of terminalStates) {
        taskEventsRef.on('task:' + ev, terminalHandler);
      }

      // Notable events — each gets a named handler in the Map for cleanup
      if (heartbeatMs > 0) {
        for (const ev of NOTABLE_EVENTS) {
          const handler = (payload) => {
            const eid = payload?.id || payload?.taskId;
            if (eid && eid !== taskId) return;
            done('notable:' + ev, payload);
          };
          notableHandlers.set(ev, handler);
          taskEventsRef.on('task:' + ev, handler);
        }
      }

      // Heartbeat timer (clamped to remaining timeout)
      let heartbeatTimer = null;
      if (heartbeatMs > 0) {
        const remaining = (timeoutMinutes * 60 * 1000) - (Date.now() - awaitStartTime);
        const hbDelay = Math.min(heartbeatMs, remaining > 0 ? remaining : heartbeatMs);
        heartbeatTimer = setTimeout(() => done('heartbeat'), hbDelay);
      }

      // Poll fallback timer
      const pollTimer = setTimeout(() => done('poll'), pollMs);

      // Shutdown
      if (shutdownSignal) {
        shutdownSignal.addEventListener('abort', () => done('shutdown'), { once: true });
      }
    });
```

**C. Handle heartbeat signal** (after the Promise resolves, before existing terminal check):

```javascript
    if (signalType === 'heartbeat' || (signalType && signalType.startsWith('notable:'))) {
      const currentTask = db.getTask(taskId);
      const reason = signalType === 'heartbeat'
        ? 'scheduled'
        : REASON_MAP[signalType.replace('notable:', '')] || signalType;

      const runningTasks = [];
      if (currentTask && currentTask.status === 'running') {
        runningTasks.push({
          id: currentTask.id,
          provider: currentTask.provider,
          host: currentTask.ollama_host || '-',
          elapsedMs: currentTask.started_at
            ? Date.now() - new Date(currentTask.started_at).getTime() : 0,
          description: currentTask.task_description
        });
      }

      const alerts = [];
      if (signalType === 'notable:stall_warning' && notablePayload) {
        alerts.push(
          `Approaching stall threshold (${notablePayload.elapsed}s / ${notablePayload.threshold}s) — consider cancelling if no progress`
        );
      }

      const counts = {
        completed: 0, failed: 0,
        running: currentTask?.status === 'running' ? 1 : 0,
        pending: ['pending', 'queued'].includes(currentTask?.status) ? 1 : 0
      };

      const text = formatHeartbeat({
        taskId,
        reason,
        elapsedMs: Date.now() - awaitStartTime,
        runningTasks,
        taskCounts: counts,
        partialOutput: currentTask?.partial_output || null,
        alerts
      });

      return { content: [{ type: 'text', text }] };
    }
```

The existing terminal-event handling code stays unchanged after this block.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "handleAwaitTask heartbeat"`
Expected: PASS

- [ ] **Step 5: Run existing await tests for regression**

Run: `cd /path/to/torque && npx vitest run server/tests/workflow-await.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/await-heartbeat.test.js
git commit -m "feat(heartbeat): add heartbeat timer and notable events to handleAwaitTask"
```

---

## Task 9: Heartbeat Logic in `handleAwaitWorkflow`

**Files:**
- Modify: `server/handlers/workflow/await.js:246-408` (handleAwaitWorkflow)
- Test: `server/tests/await-heartbeat.test.js` (append)

Same heartbeat pattern but for workflows. Key differences: includes all running tasks, task yields take priority, no per-task filtering on notable events.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/await-heartbeat.test.js`. Use mock patterns from `server/tests/await-workflow-yield.test.js`:

```javascript
describe('handleAwaitWorkflow heartbeat', () => {
  test('workflow heartbeat includes all running tasks', async () => {
    // 1. Create workflow with 3 tasks: 1 completed, 1 running, 1 pending
    // 2. Call handleAwaitWorkflow with heartbeat_minutes: 1
    // 3. Advance timer past 60 seconds
    // 4. Verify heartbeat includes the running task and correct counts
  });

  test('task yield takes priority over scheduled heartbeat', async () => {
    // 1. Create workflow with 2 tasks
    // 2. Complete task 1 just before heartbeat timer
    // 3. Verify task yield returned, not heartbeat
  });

  test('workflow heartbeat shows next-up tasks', async () => {
    // 1. Create workflow with pending tasks
    // 2. Trigger heartbeat
    // 3. Verify 'Next Up' section is present with pending tasks
  });

  test('notable events for any workflow task trigger heartbeat', async () => {
    // 1. Create workflow with tasks A and B
    // 2. Emit task:started for task B
    // 3. Verify heartbeat returned (no per-task filtering in workflow mode)
  });

  test('rapid notable events are coalesced into one heartbeat', async () => {
    // 1. Create workflow with 3 pending tasks
    // 2. Call handleAwaitWorkflow with heartbeat_minutes: 5
    // 3. Emit task:started for all 3 tasks in rapid succession (within 100ms)
    // 4. Verify only ONE heartbeat returned (first event wins)
    // 5. Heartbeat should show all 3 tasks as running (via DB query coalesce)
    // This validates the debounce behavior from the spec
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "handleAwaitWorkflow heartbeat"`
Expected: FAIL

- [ ] **Step 3: Implement heartbeat in handleAwaitWorkflow**

In `server/handlers/workflow/await.js`, modify `handleAwaitWorkflow` (line 246):

**A. Parse heartbeat params** (after line 252):
```javascript
    const heartbeatMinutes = Math.max(0, Math.min(30, args.heartbeat_minutes ?? 5));
    const heartbeatMs = heartbeatMinutes > 0 ? heartbeatMinutes * 60 * 1000 : 0;
    const awaitStartTime = Date.now();
```

**B. Replace the wait Promise** (lines 354-402):

This is a full replacement of the existing Promise block, same as Task 8. Key differences from the `await_task` version:

1. Notable event listeners do NOT filter by task_id. Instead, build a Set of workflow task IDs at the start: `const workflowTaskIds = new Set(db.getWorkflowTasks(workflowId).map(t => t.id))`. Notable handlers check `workflowTaskIds.has(eid)`.
2. Use the same Map-based listener storage pattern as Task 8 for cleanup safety.
3. The `done()` callback uses the same `signalType` / `notablePayload` tracking.

```javascript
    const workflowTaskIds = new Set(
      db.getWorkflowTasks(workflowId).map(t => t.id)
    );
    let signalType = null;
    let notablePayload = null;

    await new Promise(resolve => {
      const notableHandlers = new Map();

      const cleanup = () => {
        clearTimeout(pollTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        for (const ev of terminalStates) {
          taskEventsRef.removeListener('task:' + ev, terminalHandler);
        }
        for (const [ev, handler] of notableHandlers) {
          taskEventsRef.removeListener('task:' + ev, handler);
        }
        notableHandlers.clear();
      };

      const done = (type, payload) => {
        if (signalType !== null) return;
        signalType = type;
        notablePayload = payload || null;
        cleanup();
        resolve();
      };

      // Terminal — any workflow task completing wakes us
      const terminalHandler = (payload) => {
        const eid = payload?.id || payload?.taskId;
        if (eid && !workflowTaskIds.has(eid)) return;
        done('terminal', payload);
      };
      for (const ev of terminalStates) {
        taskEventsRef.on('task:' + ev, terminalHandler);
      }

      // Notable — any workflow task, no per-task filtering
      if (heartbeatMs > 0) {
        for (const ev of NOTABLE_EVENTS) {
          const handler = (payload) => {
            const eid = payload?.id || payload?.taskId;
            if (eid && !workflowTaskIds.has(eid)) return;
            done('notable:' + ev, payload);
          };
          notableHandlers.set(ev, handler);
          taskEventsRef.on('task:' + ev, handler);
        }
      }

      // Timers (same as Task 8)
      let heartbeatTimer = null;
      if (heartbeatMs > 0) {
        const remaining = (timeoutMinutes * 60 * 1000) - (Date.now() - awaitStartTime);
        const hbDelay = Math.min(heartbeatMs, remaining > 0 ? remaining : heartbeatMs);
        heartbeatTimer = setTimeout(() => done('heartbeat'), hbDelay);
      }
      const pollTimer = setTimeout(() => done('poll'), pollMs);

      if (shutdownSignal) {
        shutdownSignal.addEventListener('abort', () => done('shutdown'), { once: true });
      }
    });
```

**C. Check priority** after Promise resolves — this is the key difference from `await_task`:

1. **First:** Check for unacknowledged terminal tasks (existing yield logic at lines 269-317). If any exist, return task yield (existing behavior, unchanged).
2. **Second:** If no new completions AND signal was heartbeat/notable, build and return workflow heartbeat.
3. **Third:** If all tasks terminal + all acknowledged, return final summary (existing behavior).

```javascript
    // Priority: task yield > heartbeat > final summary
    // (existing yield check goes here — unchanged from current code)

    // If no yield, check for heartbeat signal
    if (signalType === 'heartbeat' || (signalType && signalType.startsWith('notable:'))) {
      // Build workflow heartbeat...
    }
```

Build heartbeat with full workflow state:

```javascript
    const workflowTasks = db.getWorkflowTasks(workflowId);
    const runningTasks = workflowTasks
      .filter(t => t.status === 'running')
      .map(t => ({
        id: t.id,
        provider: t.provider,
        host: t.ollama_host || '-',
        elapsedMs: t.started_at ? Date.now() - new Date(t.started_at).getTime() : 0,
        description: t.task_description
      }));

    const counts = {
      completed: workflowTasks.filter(t => t.status === 'completed').length,
      failed: workflowTasks.filter(t => t.status === 'failed').length,
      running: workflowTasks.filter(t => t.status === 'running').length,
      pending: workflowTasks.filter(t => ['pending', 'queued'].includes(t.status)).length
    };

    const nextUpTasks = workflowTasks
      .filter(t => ['pending', 'queued'].includes(t.status))
      .slice(0, 5)
      .map(t => ({ id: t.id, description: t.task_description }));

    // Use longest-running task's partial output
    const primaryRunning = runningTasks.sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
    const primaryTask = primaryRunning ? db.getTask(primaryRunning.id) : null;

    const text = formatHeartbeat({
      taskId: workflowId,
      isWorkflow: true,
      reason,
      elapsedMs: Date.now() - awaitStartTime,
      runningTasks,
      taskCounts: counts,
      partialOutput: primaryTask?.partial_output || null,
      alerts,
      nextUpTasks
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js -t "handleAwaitWorkflow heartbeat"`
Expected: PASS

- [ ] **Step 5: Run existing workflow await tests for regression**

Run: `cd /path/to/torque && npx vitest run server/tests/await-workflow-yield.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/await-heartbeat.test.js
git commit -m "feat(heartbeat): add heartbeat timer and notable events to handleAwaitWorkflow"
```

---

## Task 10: Integration Tests — End-to-End Heartbeat

**Files:**
- Test: `server/tests/await-heartbeat.test.js` (append)

- [ ] **Step 1: Write integration tests**

Append to `server/tests/await-heartbeat.test.js`:

```javascript
describe('heartbeat integration', () => {
  test('full cycle: heartbeat then completion', async () => {
    // 1. Create a running task
    // 2. Call handleAwaitTask with heartbeat_minutes: 1
    // 3. Advance 61 seconds — verify heartbeat returned
    // 4. Re-invoke handleAwaitTask (same params)
    // 5. Emit task:completed
    // 6. Verify completion returned on second call
  });

  test('stall_warning event includes correct alert text', async () => {
    // 1. Create a running task
    // 2. Call handleAwaitTask with heartbeat_minutes: 10
    // 3. Emit task:stall_warning with {taskId, elapsed: 144, threshold: 180}
    // 4. Verify heartbeat has reason 'stall_warning'
    // 5. Verify alert text contains '144s / 180s'
  });

  test('partial_output from DB included in heartbeat', async () => {
    // 1. Create running task, set partial_output in DB
    // 2. Call handleAwaitTask, trigger heartbeat
    // 3. Verify heartbeat text contains the partial output
  });
});
```

- [ ] **Step 2: Implement tests with real mock infrastructure**

Follow patterns from existing test files. Use `vi.useFakeTimers()` for timer control.

- [ ] **Step 3: Run all heartbeat tests**

Run: `cd /path/to/torque && npx vitest run server/tests/await-heartbeat.test.js`
Expected: ALL PASS

- [ ] **Step 4: Run full regression suite**

Run: `cd /path/to/torque && npx vitest run server/tests/workflow-await.test.js server/tests/await-workflow-yield.test.js server/tests/await-heartbeat.test.js server/tests/event-dispatch-heartbeat.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/tests/await-heartbeat.test.js
git commit -m "test(heartbeat): integration tests for full heartbeat cycle"
```

---

## Task 11: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the recommended patterns section**

In `CLAUDE.md`, find the "Task Completion Notifications" section. Update recommended patterns:

```markdown
### Recommended patterns

- **Single task:** Submit -> `await_task` (heartbeats every 5 min, wakes instantly on completion) -> review result or heartbeat -> re-invoke if heartbeat
- **Workflow:** Submit workflow -> `await_workflow` (heartbeats every 5 min, wakes instantly per task) -> review each yield/heartbeat -> re-invoke
- **Batch monitoring:** `subscribe_task_events` with no task_ids -> `check_notifications` periodically
```

- [ ] **Step 2: Add heartbeat documentation**

Add after "Do NOT" section:

```markdown
### Heartbeat check-ins

`await_task` and `await_workflow` return periodic **heartbeat** responses (default: every 5 minutes) with progress snapshots including running tasks, elapsed time, partial output, and alerts. Notable events (task started, stall warning, retry, provider fallback) trigger an immediate heartbeat.

On receiving a heartbeat:
- Update the user on progress
- Check alerts — if stall warning, consider cancelling/resubmitting
- Re-invoke the await tool to continue waiting

Set `heartbeat_minutes: 0` to disable heartbeats (legacy behavior).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document heartbeat check-ins in CLAUDE.md"
```

---

## Dependency Graph

```
Task 1 (DB migration) ─────────────────────────────────────────┐
Task 2 (event classification) ────┐                             │
Task 3 (task:started emission) ───┤                             │
Task 4 (task:stall_warning) ──────┼── Task 7 (formatter) ──── Task 8 (await_task) ───┐
Task 5 (task:fallback emission) ──┤                             Task 9 (await_wf) ───┼── Task 10 (integration)
Task 6 (tool definitions) ────────┘                                                   │   Task 11 (docs)
                                                                                      │
```

**Parallelizable:** Tasks 1-6 have no dependencies on each other — all can run concurrently.
**Sequential:** Task 7 before 8-9. Tasks 8-9 before 10. Task 11 last.

---

## Phase 2 Boundary (Not In This Plan)

This plan implements **Phase 1** from the spec: heartbeat infrastructure, notable events, scheduled heartbeats, and DB-backed partial output reading. The `partial_output` column will exist but will be NULL for all providers until Phase 2 instruments the streaming write path.

**Phase 2 (separate plan):** Instrument each streaming provider to write partial output to the DB:
- Phase 2a: ollama / hashline-ollama (HTTP streaming chunks)
- Phase 2b: aider-ollama (subprocess stdout pipe)
- Phase 2c: Cloud API providers (SSE / chunked HTTP)

Phase 2 is independent — heartbeats work without it (they just say "No output captured yet"). Plan it when the heartbeat infrastructure is proven in production.
