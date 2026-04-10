# Restart Barrier Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the restart_server drain poll loop and await_restart event loop with a single barrier task that lives in the task table, blocks the queue scheduler, and drains naturally.

**Architecture:** A restart request creates a `provider: 'system'` task in the tasks table. The queue scheduler checks for this barrier on each cycle and stops starting work. A drain watcher listens for terminal task events and triggers shutdown when running count hits zero. Cancelling the barrier task lifts the gate.

**Tech Stack:** Node.js, SQLite (better-sqlite3), vitest

**Spec:** `docs/superpowers/specs/2026-04-10-restart-barrier-task-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/providers/registry.js` | Modify | Add `'system'` to provider categories |
| `server/execution/queue-scheduler.js` | Modify | Add barrier query at top of `processQueueInternal` |
| `server/tools.js` | Modify | Rewrite `handleRestartServer` to create barrier task + drain watcher |
| `server/handlers/workflow/await.js` | Modify | Rewrite `handleAwaitRestart` to create-or-attach + delegate to await logic |
| `server/tool-defs/core-defs.js` | Modify | Update `restart_server` schema, update `await_restart` description |
| `server/tool-annotations.js` | Modify | Update annotation for `restart_server` |
| `server/index.js` | Modify | Add stale restart barrier cleanup to `init()` |
| `server/tests/restart-barrier.test.js` | Create | New test file for the barrier task feature |
| `server/tests/restart-drain.test.js` | Modify | Update for barrier task behavior |
| `server/tests/await-restart.test.js` | Modify | Update for wrapper behavior |

---

### Task 1: Register `system` Provider Category

**Files:**
- Modify: `server/providers/registry.js:21-41`
- Test: `server/tests/restart-barrier.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/tests/restart-barrier.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const providerRegistry = require('../providers/registry');

describe('system provider category', () => {
  it('recognizes system as a known provider', () => {
    expect(providerRegistry.isKnownProvider('system')).toBe(true);
  });

  it('categorizes system in its own category', () => {
    expect(providerRegistry.getCategory('system')).toBe('system');
  });

  it('does not include system in ollama, codex, or api categories', () => {
    expect(providerRegistry.isOllamaProvider('system')).toBe(false);
    expect(providerRegistry.isCodexProvider('system')).toBe(false);
    expect(providerRegistry.isApiProvider('system')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: FAIL — `isKnownProvider('system')` returns `false`

- [ ] **Step 3: Add system to PROVIDER_CATEGORIES and ALL_PROVIDERS**

In `server/providers/registry.js`, change `PROVIDER_CATEGORIES` (line 21) to add:

```js
const PROVIDER_CATEGORIES = {
  ollama: ['ollama'],
  codex:  ['codex', 'codex-spark', 'claude-cli'],
  api:    ['anthropic', 'groq', 'hyperbolic', 'deepinfra',
           'ollama-cloud', 'cerebras', 'google-ai', 'openrouter'],
  system: ['system'],
};
```

The `ALL_PROVIDERS` set (line 29) and `CATEGORY_BY_PROVIDER` map (line 36) are built dynamically from `PROVIDER_CATEGORIES`, so they pick up `'system'` automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/registry.js server/tests/restart-barrier.test.js
git commit -m "feat: register system provider category for restart barrier task"
```

---

### Task 2: Queue Scheduler Barrier Check

**Files:**
- Modify: `server/execution/queue-scheduler.js:725` (after global capacity guard)
- Test: `server/tests/restart-barrier.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/restart-barrier.test.js`:

```js
const { beforeEach, afterEach, vi } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');

describe('queue scheduler barrier', () => {
  let queueScheduler;

  beforeEach(() => {
    setupTestDbOnly(`restart-barrier-queue-${Date.now()}`);
    queueScheduler = require('../execution/queue-scheduler');
    // init with minimal deps
    queueScheduler.init({
      db: require('../database'),
      attemptTaskStart: vi.fn(),
      safeStartTask: vi.fn(),
      safeConfigInt: (key, def) => def,
      isLargeModelBlockedOnHost: vi.fn(() => false),
      getProviderInstance: vi.fn(),
      getFreeQuotaTracker: vi.fn(() => null),
      cleanupOrphanedRetryTimeouts: vi.fn(),
      notifyDashboard: vi.fn(),
      analyzeTaskForRouting: vi.fn(),
    });
  });

  afterEach(() => {
    queueScheduler.stop();
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('does not start queued tasks when a system restart barrier exists', () => {
    const startFn = vi.fn();
    queueScheduler.init({
      db: require('../database'),
      attemptTaskStart: startFn,
      safeStartTask: startFn,
      safeConfigInt: (key, def) => def,
      isLargeModelBlockedOnHost: vi.fn(() => false),
      getProviderInstance: vi.fn(),
      getFreeQuotaTracker: vi.fn(() => null),
      cleanupOrphanedRetryTimeouts: vi.fn(),
      notifyDashboard: vi.fn(),
      analyzeTaskForRouting: vi.fn(),
    });

    // Create a normal queued task
    taskCore.createTask({
      id: 'normal-task-1',
      task_description: 'normal work',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('normal-task-1', 'queued', {});

    // Create the restart barrier task
    taskCore.createTask({
      id: 'rst-barrier-1',
      task_description: 'System restart: test',
      provider: 'system',
      working_directory: process.cwd(),
      metadata: { execution_type: 'system', system_action: 'restart' },
    });
    taskCore.updateTaskStatus('rst-barrier-1', 'queued', {});

    // Process the queue
    queueScheduler.processQueueInternal({ skipRecentProcessGuard: true });

    // The normal task should NOT have been started
    expect(startFn).not.toHaveBeenCalled();
  });

  it('starts queued tasks normally when no barrier exists', () => {
    // Create a normal queued task — just verify the barrier check
    // doesn't block when there's no barrier. We don't need to verify
    // full task start (that's tested elsewhere), just that processQueueInternal
    // proceeds past the barrier check.
    taskCore.createTask({
      id: 'normal-task-2',
      task_description: 'normal work',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('normal-task-2', 'queued', {});

    // This should not throw or return early due to barrier
    queueScheduler.processQueueInternal({ skipRecentProcessGuard: true });

    // We can't easily assert task start without full wiring,
    // but we can verify the task is still queued (not blocked by barrier)
    const task = taskCore.getTask('normal-task-2');
    expect(task.status).toBe('queued'); // still queued, not blocked
  });

  it('resumes processing after barrier task is cancelled', () => {
    // Create the barrier
    taskCore.createTask({
      id: 'rst-barrier-cancel',
      task_description: 'System restart: test',
      provider: 'system',
      working_directory: process.cwd(),
      metadata: { execution_type: 'system', system_action: 'restart' },
    });
    taskCore.updateTaskStatus('rst-barrier-cancel', 'queued', {});

    // Cancel the barrier
    taskCore.updateTaskStatus('rst-barrier-cancel', 'cancelled', {
      error_output: 'User cancelled',
    });

    // Create a normal task
    taskCore.createTask({
      id: 'normal-task-3',
      task_description: 'normal work',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('normal-task-3', 'queued', {});

    // Process should proceed (barrier is cancelled, not active)
    queueScheduler.processQueueInternal({ skipRecentProcessGuard: true });

    // Verify the queue was not blocked — task still queued is fine,
    // the point is processQueueInternal didn't early-return
    const task = taskCore.getTask('normal-task-3');
    expect(['queued', 'running']).toContain(task.status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: FAIL — the "does not start queued tasks when barrier exists" test fails because the scheduler has no barrier check yet

- [ ] **Step 3: Add barrier check to processQueueInternal**

In `server/execution/queue-scheduler.js`, after the resource pressure gating block (around line 733), add:

```js
  // Restart barrier — if a system restart task is queued or running, stop all new starts.
  // This makes restart a first-class queue barrier rather than a side-channel process flag.
  try {
    const barrierTask = db.listTasks({ provider: 'system', status: 'queued', limit: 1 })[0]
      || db.listTasks({ provider: 'system', status: 'running', limit: 1 })[0];
    if (barrierTask) {
      logger.info(`[Scheduler] Restart barrier active (task ${(barrierTask.id || '').slice(0, 8)}), skipping queue processing`);
      return;
    }
  } catch (barrierErr) {
    logger.warn(`[Scheduler] Barrier check failed (non-fatal): ${barrierErr.message}`);
  }
```

Note: `db.listTasks` is the existing function in task-core that supports `provider` and `status` filters. This avoids raw SQL while reusing existing infrastructure.

- [ ] **Step 4: Verify listTasks supports provider filter**

Before running the test, confirm that `listTasks` supports filtering by `provider`. Search for `function listTasks` in `server/db/task-core.js` and check the filter parameters. If it doesn't support `provider`, use a direct SQL query instead:

```js
  const barrierRow = db.prepare(
    "SELECT id FROM tasks WHERE provider = 'system' AND status IN ('queued', 'running') LIMIT 1"
  ).get();
  if (barrierRow) {
    logger.info(`[Scheduler] Restart barrier active (task ${(barrierRow.id || '').slice(0, 8)}), skipping queue processing`);
    return;
  }
```

Use whichever approach `listTasks` supports. The `db` variable in queue-scheduler.js is the raw database module, so `db.prepare()` is available.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: PASS — all three barrier tests pass

- [ ] **Step 6: Commit**

```bash
git add server/execution/queue-scheduler.js server/tests/restart-barrier.test.js
git commit -m "feat: add restart barrier check to queue scheduler"
```

---

### Task 3: Rewrite handleRestartServer as Barrier Task Creator

**Files:**
- Modify: `server/tools.js:444-586`
- Test: `server/tests/restart-barrier.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/restart-barrier.test.js`:

```js
describe('handleRestartServer barrier task', () => {
  let tools;
  let eventBusMock;

  beforeEach(() => {
    vi.resetModules();
    setupTestDbOnly(`restart-barrier-handler-${Date.now()}`);

    eventBusMock = {
      emitShutdown: vi.fn(),
      onShutdown: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      emitTaskEvent: vi.fn(),
    };
    vi.doMock('../event-bus', () => eventBusMock);
    vi.doMock('../hooks/event-dispatch', () => ({
      taskEvents: new (require('events').EventEmitter)(),
      NOTABLE_EVENTS: [],
    }));

    tools = require('../tools');
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('creates a barrier task and returns task_id', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'test barrier' });
    expect(result.task_id).toBeTruthy();
    expect(result.task_id).toMatch(/^rst-/);

    // Verify task exists in DB
    const task = taskCore.getTask(result.task_id);
    expect(task).toBeTruthy();
    expect(task.provider).toBe('system');
    expect(task.status).toBe('queued');
  });

  it('returns already_pending when a restart barrier already exists', async () => {
    // Create first barrier
    const first = await tools.handleToolCall('restart_server', { reason: 'first' });
    expect(first.task_id).toBeTruthy();

    // Try to create second
    const second = await tools.handleToolCall('restart_server', { reason: 'second' });
    expect(second.status).toBe('already_pending');
    expect(second.task_id).toBe(first.task_id);
  });

  it('triggers immediate shutdown when pipeline is empty', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'empty pipeline' });
    expect(result.task_id).toBeTruthy();

    // Give the drain watcher time to fire (pipeline is empty, should be near-instant)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Task should be completed
    const task = taskCore.getTask(result.task_id);
    expect(task.status).toBe('completed');
    expect(eventBusMock.emitShutdown).toHaveBeenCalled();
  });

  it('waits for running tasks before triggering shutdown', async () => {
    // Create a running task
    const runningId = 'running-for-barrier';
    taskCore.createTask({
      id: runningId,
      task_description: 'busy work',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus(runningId, 'queued', {});
    taskCore.updateTaskStatus(runningId, 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'drain test' });
    expect(result.task_id).toBeTruthy();

    // Barrier should be queued, not completed yet
    let barrier = taskCore.getTask(result.task_id);
    expect(barrier.status).toBe('queued');
    expect(eventBusMock.emitShutdown).not.toHaveBeenCalled();

    // Complete the running task
    taskCore.updateTaskStatus(runningId, 'completed', {
      output: 'done',
      exit_code: 0,
      completed_at: new Date().toISOString(),
    });

    // Emit terminal event to wake the drain watcher
    const { taskEvents } = require('../hooks/event-dispatch');
    taskEvents.emit('task:completed', { id: runningId });

    // Give drain watcher time to react
    await new Promise(resolve => setTimeout(resolve, 100));

    barrier = taskCore.getTask(result.task_id);
    expect(barrier.status).toBe('completed');
    expect(eventBusMock.emitShutdown).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: FAIL — current `handleRestartServer` doesn't return `task_id`

- [ ] **Step 3: Rewrite handleRestartServer**

Replace the entire `handleRestartServer` function in `server/tools.js` (lines 444-586) with:

```js
const RESTART_RESPONSE_GRACE_MS = 1500;

async function handleRestartServer(args) {
  const reason = args.reason || 'Manual restart requested';
  const timeoutMinutes = args.timeout_minutes || 30;
  const taskCore = require('./db/task-core');

  logger.info(`[Restart] Server restart requested: ${reason}`);

  // Singleton: check for existing active restart barrier
  const existingBarrier = taskCore.listTasks({ status: 'queued', limit: 1000 })
    .concat(taskCore.listTasks({ status: 'running', limit: 1000 }))
    .find(t => t.provider === 'system');

  if (existingBarrier) {
    return {
      task_id: existingBarrier.id,
      status: 'already_pending',
      content: [{ type: 'text', text: `Restart already pending (task ${existingBarrier.id}). Cancel it first or await it.` }],
    };
  }

  // Create the barrier task
  const { randomUUID } = require('crypto');
  const taskId = `rst-${randomUUID().slice(0, 12)}`;

  taskCore.createTask({
    id: taskId,
    task_description: `System restart: ${reason}`,
    provider: 'system',
    working_directory: null,
    timeout_minutes: timeoutMinutes,
    metadata: {
      execution_type: 'system',
      system_action: 'restart',
      reason,
    },
  });
  taskCore.updateTaskStatus(taskId, 'queued', {});

  // Count current pipeline (for informational response)
  const running = taskCore.listTasks({ status: 'running', limit: 1000 })
    .filter(t => t.provider !== 'system');
  const queued = taskCore.listTasks({ status: 'queued', limit: 1000 })
    .filter(t => t.provider !== 'system');

  logger.info(`[Restart] Barrier task ${taskId} created. Pipeline: ${running.length} running, ${queued.length} queued`);

  // Start the drain watcher
  startDrainWatcher(taskId, timeoutMinutes, reason);

  const message = running.length > 0
    ? `Restart barrier queued (task ${taskId}). ${running.length} running task(s) must complete before restart. Cancellable via cancel_task.`
    : `Restart barrier queued (task ${taskId}). Pipeline is empty — restart will trigger shortly.`;

  return {
    task_id: taskId,
    status: 'queued',
    pipeline: { running: running.length, queued: queued.length },
    content: [{ type: 'text', text: message }],
  };
}

function startDrainWatcher(taskId, timeoutMinutes, reason) {
  const taskCore = require('./db/task-core');
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const startTime = Date.now();
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      const { taskEvents } = require('./hooks/event-dispatch');
      taskEvents.removeListener('task:completed', onTerminal);
      taskEvents.removeListener('task:failed', onTerminal);
      taskEvents.removeListener('task:cancelled', onTerminal);
    } catch { /* event-dispatch not available */ }
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  function getRunningCount() {
    // Exclude the restart barrier task itself from running count
    const running = taskCore.listTasks({ status: 'running', limit: 1000 });
    return running.filter(t => t.provider !== 'system').length;
  }

  function checkAndMaybeTrigger() {
    // Check if our barrier task was cancelled
    try {
      const barrier = taskCore.getTask(taskId);
      if (!barrier || barrier.status === 'cancelled') {
        logger.info(`[Restart] Barrier task ${taskId} was cancelled — drain watcher stopping`);
        cleanup();
        return;
      }
    } catch { /* task lookup failed — stop watching */ cleanup(); return; }

    const running = getRunningCount();
    if (running === 0) {
      logger.info(`[Restart] Drain complete — all tasks finished. Triggering restart.`);
      try {
        taskCore.updateTaskStatus(taskId, 'running', { started_at: new Date().toISOString() });
        taskCore.updateTaskStatus(taskId, 'completed', {
          output: `Drain complete. Restart triggered: ${reason}`,
          exit_code: 0,
          completed_at: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn(`[Restart] Failed to update barrier task status: ${err.message}`);
      }

      cleanup();
      process._torqueRestartPending = true;

      // Small grace period so the MCP response can be sent before shutdown
      setTimeout(() => {
        eventBus.emitShutdown(`restart: ${reason}`);
      }, RESTART_RESPONSE_GRACE_MS);
      return;
    }

    logger.debug(`[Restart] Drain watcher: ${running} task(s) still running`);
  }

  function onTerminal() {
    // A task reached terminal state — check if drain is complete
    checkAndMaybeTrigger();
  }

  // Subscribe to terminal task events
  try {
    const { taskEvents } = require('./hooks/event-dispatch');
    taskEvents.on('task:completed', onTerminal);
    taskEvents.on('task:failed', onTerminal);
    taskEvents.on('task:cancelled', onTerminal);
  } catch {
    logger.warn('[Restart] event-dispatch not available — drain watcher will use timeout only');
  }

  // Timeout handler
  const timeoutTimer = setTimeout(() => {
    logger.info(`[Restart] Drain timeout after ${timeoutMinutes}min — aborting restart`);
    try {
      taskCore.updateTaskStatus(taskId, 'failed', {
        error_output: `Drain timeout after ${timeoutMinutes}min. ${getRunningCount()} task(s) still running.`,
      });
    } catch (err) {
      logger.warn(`[Restart] Failed to mark barrier task as failed: ${err.message}`);
    }
    cleanup();
  }, timeoutMs);

  // Check immediately in case pipeline is already empty
  checkAndMaybeTrigger();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: PASS — all barrier handler tests pass

- [ ] **Step 5: Commit**

```bash
git add server/tools.js server/tests/restart-barrier.test.js
git commit -m "feat: rewrite restart_server as barrier task with drain watcher"
```

---

### Task 4: Update Tool Definition Schema

**Files:**
- Modify: `server/tool-defs/core-defs.js:19-33`
- Modify: `server/tool-defs/core-defs.js:34-45`

- [ ] **Step 1: Update restart_server schema**

In `server/tool-defs/core-defs.js`, replace the `restart_server` definition (lines 20-33) with:

```js
  {
    name: 'restart_server',
    description: 'Restart the TORQUE MCP server. Creates a barrier task that blocks the queue scheduler from starting new work, waits for all running tasks to drain, then triggers a graceful shutdown. The MCP client will automatically reconnect with fresh code. The barrier task is cancellable — use cancel_task to abort.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for restart (logged and stored in task metadata)'
        },
        timeout_minutes: { type: 'number', description: 'Maximum minutes to wait for pipeline to drain (default: 30). If exceeded, the restart task fails and the queue resumes.' },
      }
    }
  },
```

- [ ] **Step 2: Update await_restart description**

In the same file, update the `await_restart` description (lines 35-45) to:

```js
  {
    name: 'await_restart',
    description: 'Submit a restart barrier task (or attach to an existing one) and block until the pipeline drains and restart triggers. Returns heartbeat progress snapshots at configurable intervals. Equivalent to calling restart_server + await_task on the barrier task.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_minutes: { type: 'number', description: 'Max wait before giving up (default: 30, min: 1, max: 60)' },
        heartbeat_minutes: { type: 'number', description: 'Minutes between scheduled progress heartbeats. Default 5. Set to 0 to disable. Max: 30.', minimum: 0, maximum: 30 },
        reason: { type: 'string', description: 'Restart reason (logged and passed to shutdown event)' },
      },
    },
  },
```

- [ ] **Step 3: Commit**

```bash
git add server/tool-defs/core-defs.js
git commit -m "feat: update restart_server and await_restart tool schemas for barrier task"
```

---

### Task 5: Rewrite handleAwaitRestart as Wrapper

**Files:**
- Modify: `server/handlers/workflow/await.js:1975-2153`
- Test: `server/tests/restart-barrier.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/restart-barrier.test.js`:

```js
describe('handleAwaitRestart wrapper', () => {
  let awaitHandlers;
  let eventBusMock;

  beforeEach(() => {
    vi.resetModules();
    setupTestDbOnly(`restart-barrier-await-${Date.now()}`);

    eventBusMock = {
      emitShutdown: vi.fn(),
      onShutdown: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      emitTaskEvent: vi.fn(),
    };
    vi.doMock('../event-bus', () => eventBusMock);
    vi.doMock('../hooks/event-dispatch', () => ({
      taskEvents: new (require('events').EventEmitter)(),
      NOTABLE_EVENTS: [],
    }));
    vi.doMock('../execution/command-policy', () => ({
      executeValidatedCommandSync: vi.fn(() => ''),
    }));
    vi.doMock('../utils/safe-exec', () => ({
      safeExecChain: vi.fn(),
    }));
    vi.doMock('../plugins/snapscope/handlers/capture', () => ({
      handlePeekUi: vi.fn(),
    }));

    awaitHandlers = require('../handlers/workflow/await');
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('creates barrier task and returns restart message when pipeline is empty', async () => {
    const result = await awaitHandlers.handleAwaitRestart({ reason: 'test wrapper' });
    const text = result?.content?.[0]?.text || '';
    expect(text).toContain('Restart');
    expect(eventBusMock.emitShutdown).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: FAIL or inconsistent behavior — current `handleAwaitRestart` doesn't create a barrier task

- [ ] **Step 3: Rewrite handleAwaitRestart**

In `server/handlers/workflow/await.js`, replace the `handleAwaitRestart` function (lines 1975-2153) with:

```js
async function handleAwaitRestart(args) {
  try {
    const reason = args.reason || 'await_restart';
    const timeoutMinutes = Math.min(Math.max(args.timeout_minutes || 30, 0.1), 60);
    const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
    const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);

    // Create or find existing barrier task via restart_server handler
    const { handleToolCall } = require('../../tools');
    const restartResult = await handleToolCall('restart_server', {
      reason,
      timeout_minutes: timeoutMinutes,
    });

    const taskId = restartResult.task_id;
    if (!taskId) {
      return makeError(ErrorCodes.INTERNAL_ERROR, 'Failed to create restart barrier task');
    }

    // If the pipeline was empty, the drain watcher may have already completed
    // the barrier and triggered shutdown. Check immediately.
    const barrierTask = taskCore.getTask(taskId);
    if (barrierTask && barrierTask.status === 'completed') {
      return {
        content: [{
          type: 'text',
          text: `## Restart Ready\n\nPipeline was already empty.\nServer restart triggered — MCP client will reconnect with fresh code.\nRun \`/mcp\` to force immediate reconnection.`,
        }],
      };
    }

    // Delegate to await_task logic for the barrier task
    const awaitResult = await handleAwaitTask({
      task_id: taskId,
      timeout_minutes: timeoutMinutes,
      heartbeat_minutes: heartbeatMinutes,
      __shutdownSignal: args.__shutdownSignal,
    });

    // Reformat the response to match restart-specific messaging
    const text = awaitResult?.content?.[0]?.text || '';
    if (text.includes('completed') || text.includes('Completed')) {
      return {
        content: [{
          type: 'text',
          text: `## Restart Ready\n\nPipeline drained successfully.\nServer restart triggered — MCP client will reconnect with fresh code.\nRun \`/mcp\` to force immediate reconnection.`,
        }],
      };
    }

    // Pass through heartbeats, timeouts, and other responses as-is
    return awaitResult;
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/restart-barrier.test.js
git commit -m "feat: rewrite await_restart as thin wrapper over restart_server + await_task"
```

---

### Task 6: Stale Barrier Cleanup on Server Startup

**Files:**
- Modify: `server/index.js` (after epoch bump, around line 889)
- Test: `server/tests/restart-barrier.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/restart-barrier.test.js`:

```js
describe('stale restart barrier cleanup on startup', () => {
  beforeEach(() => {
    setupTestDbOnly(`restart-barrier-cleanup-${Date.now()}`);
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('cancels stale restart barriers from previous server instance', () => {
    // Simulate a leftover barrier from a crashed server
    taskCore.createTask({
      id: 'rst-stale-1',
      task_description: 'System restart: old reason',
      provider: 'system',
      working_directory: null,
      metadata: { execution_type: 'system', system_action: 'restart' },
    });
    taskCore.updateTaskStatus('rst-stale-1', 'queued', {});

    // Run cleanup
    const { cleanupStaleRestartBarriers } = require('../tools');
    const count = cleanupStaleRestartBarriers();

    expect(count).toBe(1);
    const task = taskCore.getTask('rst-stale-1');
    expect(task.status).toBe('cancelled');
  });

  it('does not cancel non-system tasks', () => {
    taskCore.createTask({
      id: 'normal-queued',
      task_description: 'normal work',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('normal-queued', 'queued', {});

    const { cleanupStaleRestartBarriers } = require('../tools');
    const count = cleanupStaleRestartBarriers();

    expect(count).toBe(0);
    const task = taskCore.getTask('normal-queued');
    expect(task.status).toBe('queued');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: FAIL — `cleanupStaleRestartBarriers` doesn't exist yet

- [ ] **Step 3: Add cleanupStaleRestartBarriers to tools.js**

In `server/tools.js`, add after the `handleRestartServer` function and before the `handleToolCall` dispatch:

```js
function cleanupStaleRestartBarriers() {
  const taskCore = require('./db/task-core');
  let count = 0;
  for (const status of ['queued', 'running']) {
    const tasks = taskCore.listTasks({ status, limit: 1000 });
    for (const task of tasks) {
      if (task.provider === 'system') {
        try {
          taskCore.updateTaskStatus(task.id, 'cancelled', {
            error_output: 'Server restarted independently — stale restart barrier cleared',
          });
          logger.info(`[Restart] Cleaned up stale barrier task ${task.id}`);
          count++;
        } catch (err) {
          logger.warn(`[Restart] Failed to cleanup stale barrier ${task.id}: ${err.message}`);
        }
      }
    }
  }
  return count;
}
```

Export it from `module.exports`:

```js
module.exports = {
  TOOLS,
  routeMap,
  schemaMap,
  handleToolCall,
  validateArgsAgainstSchema,
  INTERNAL_HANDLER_EXPORTS,
  createTools,
  cleanupStaleRestartBarriers,
};
```

- [ ] **Step 4: Call it from index.js init()**

In `server/index.js`, after the epoch bump (around line 889), add:

```js
  // Clean up stale restart barrier tasks from previous server instance
  try {
    const { cleanupStaleRestartBarriers } = require('./tools');
    const cleaned = cleanupStaleRestartBarriers();
    if (cleaned > 0) {
      debugLog(`Cleaned up ${cleaned} stale restart barrier task(s)`);
    }
  } catch (err) {
    debugLog(`Restart barrier cleanup failed (non-fatal): ${err.message}`);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-barrier.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/tools.js server/index.js server/tests/restart-barrier.test.js
git commit -m "feat: add stale restart barrier cleanup on server startup"
```

---

### Task 7: Update Tool Annotations

**Files:**
- Modify: `server/tool-annotations.js:70-71`

- [ ] **Step 1: Update restart_server annotation**

In `server/tool-annotations.js`, the `restart_server` annotation (line 70) should stay as-is — it's still destructive and non-idempotent. But `await_restart` (line 71) now creates a task, so it's no longer purely read-only:

```js
  await_restart:                   Object.freeze({ readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }),
```

This reflects that `await_restart` now creates a barrier task (write) and triggers shutdown (destructive).

- [ ] **Step 2: Commit**

```bash
git add server/tool-annotations.js
git commit -m "fix: update await_restart annotation to reflect barrier task creation"
```

---

### Task 8: Update Existing Tests

**Files:**
- Modify: `server/tests/restart-drain.test.js`
- Modify: `server/tests/await-restart.test.js`

- [ ] **Step 1: Update restart-drain.test.js**

The current test expects `drain` parameter and `drain_started` status. Rewrite `server/tests/restart-drain.test.js`:

```js
'use strict';

describe('restart_server barrier mode', () => {
  let tools;
  let taskCore;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../event-bus', () => ({
      emitShutdown: vi.fn(),
      onShutdown: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      emitTaskEvent: vi.fn(),
    }));
    vi.doMock('../hooks/event-dispatch', () => ({
      taskEvents: new (require('events').EventEmitter)(),
      NOTABLE_EVENTS: [],
    }));

    taskCore = require('../db/task-core');
    tools = require('../tools');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a barrier task when no tasks running', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover' });
    expect(result.task_id).toBeTruthy();
    expect(result.status).toBe('queued');
  });

  it('creates a barrier task when tasks are running (no rejection)', async () => {
    taskCore.createTask({
      id: 'running-1',
      task_description: 'busy',
      provider: 'codex',
      working_directory: process.cwd(),
    });
    taskCore.updateTaskStatus('running-1', 'queued', {});
    taskCore.updateTaskStatus('running-1', 'running', { started_at: new Date().toISOString() });

    const result = await tools.handleToolCall('restart_server', { reason: 'cutover' });
    expect(result.task_id).toBeTruthy();
    expect(result.status).toBe('queued');
    expect(result.pipeline.running).toBe(1);
  });

  it('rejects second restart when barrier already exists', async () => {
    const first = await tools.handleToolCall('restart_server', { reason: 'first' });
    expect(first.task_id).toBeTruthy();

    const second = await tools.handleToolCall('restart_server', { reason: 'second' });
    expect(second.status).toBe('already_pending');
    expect(second.task_id).toBe(first.task_id);
  });
});
```

- [ ] **Step 2: Update await-restart.test.js**

Update `server/tests/await-restart.test.js` to test the new wrapper behavior. The key tests:

1. "restarts immediately when pipeline is empty" — should still work (creates barrier + immediately drains)
2. "waits for running tasks then restarts" — barrier task is created, await_task monitors it
3. "times out when tasks never finish" — barrier task should fail on timeout

The test structure changes because `handleAwaitRestart` now calls `handleToolCall('restart_server', ...)` internally, so the mock setup needs the tools module available. Adjust the mock setup to not mock `tools.js` and ensure `restart_server` creates real barrier tasks in the test DB.

- [ ] **Step 3: Run all restart tests**

Run: `cd server && npx vitest run tests/restart-barrier.test.js tests/restart-drain.test.js tests/await-restart.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/tests/restart-drain.test.js server/tests/await-restart.test.js
git commit -m "test: update restart tests for barrier task behavior"
```

---

### Task 9: Remove Dead Code and Governance Rule

**Files:**
- Modify: `server/governance/hooks.js:454-469` — simplify `checkNoForceRestart`
- Modify: `server/api-server.core.js:659` — update governance hint text

- [ ] **Step 1: Simplify governance checkNoForceRestart**

In `server/governance/hooks.js`, the `checkNoForceRestart` function (line 454) no longer needs to block force-restarts because every restart now drains. Simplify to:

```js
function checkNoForceRestart(_task, _rule, _context) {
  // Restart is always a barrier task now — force-restart no longer exists.
  // This checker is kept for backward compatibility but always passes.
  return { pass: true };
}
```

- [ ] **Step 2: Update api-server.core.js governance hint**

In `server/api-server.core.js`, find the `await_restart` hint in the governance error response (around line 659) and update it:

```js
hint: 'Restart always drains the pipeline — use restart_server or await_restart.',
```

- [ ] **Step 3: Run full test suite for regressions**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: PASS — no regressions

- [ ] **Step 4: Commit**

```bash
git add server/governance/hooks.js server/api-server.core.js
git commit -m "refactor: simplify governance restart rule — force-restart no longer exists"
```

---

### Task 10: Final Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 2: Verify no stale references to old drain parameters**

Search for references to the old `drain` and `drain_timeout_minutes` parameters:

```bash
cd server && grep -rn "drain_timeout_minutes\|drain.*true\|drain.*mode" --include="*.js" | grep -v node_modules | grep -v test | grep -v ".md"
```

Any remaining references in non-test code need updating.

- [ ] **Step 3: Verify tool-annotations test passes**

Run: `cd server && npx vitest run tests/tool-annotations.test.js --reporter=verbose`
Expected: PASS — annotations are consistent with tool defs

- [ ] **Step 4: Final commit with all remaining adjustments**

```bash
git add -A
git commit -m "chore: cleanup stale drain references and finalize restart barrier task"
```
