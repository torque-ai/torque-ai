# await_restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `await_restart` MCP tool that blocks until the task pipeline drains, then triggers a server restart — eliminating manual polling during drain restarts.

**Architecture:** Single async handler in `server/handlers/workflow/await.js` using the same event-bus + heartbeat pattern as `handleAwaitTask`. Tool def in `core-defs.js`, always-available via `TIER_1` in `core-tools.js`.

**Tech Stack:** Node.js, event-bus listeners (`taskEvents`), MCP tool protocol

**Spec:** `docs/superpowers/specs/2026-03-31-await-restart-design.md`

---

### Task 1: Tool definition and wiring (~3 min)

Register the tool schema, add it to Tier 1, and add its annotation.

**Files:**
- Modify: `server/tool-defs/core-defs.js`
- Modify: `server/core-tools.js`
- Modify: `server/tool-annotations.js`

- [ ] **Step 1: Add tool definition to core-defs.js**

In `server/tool-defs/core-defs.js`, add this entry after the `restart_server` definition (after the closing `}` on ~line 33, before the `unlock_all_tools` entry):

```js
  {
    name: 'await_restart',
    description: 'Block until the task pipeline drains (all running/queued/pending/blocked tasks finish), then trigger a server restart. Returns heartbeat progress snapshots at configurable intervals. Use instead of restart_server with drain:true to avoid manual polling.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_minutes: { type: 'number', description: 'Max wait before giving up (default: 30, min: 1, max: 60)' },
        heartbeat_minutes: { type: 'number', description: 'Progress snapshot interval in minutes (default: 5, 0 to disable, max: 30)' },
        reason: { type: 'string', description: 'Restart reason (logged and passed to shutdown event)' },
      },
    },
  },
```

- [ ] **Step 2: Add to TIER_1 in core-tools.js**

In `server/core-tools.js`, add `'await_restart'` to the `TIER_1` array, after `'restart_server'` on line 18:

```js
  'ping', 'restart_server', 'await_restart', 'unlock_all_tools', 'unlock_tier',
```

- [ ] **Step 3: Add annotation in tool-annotations.js**

In `server/tool-annotations.js`, add this entry in the `OVERRIDES` object (after the `restart_server` line ~70):

```js
  await_restart:                   Object.freeze({ readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }),
```

- [ ] **Step 4: Commit**

```bash
git add server/tool-defs/core-defs.js server/core-tools.js server/tool-annotations.js
git commit -m "feat(await_restart): add tool definition, tier 1 wiring, annotation"
```

---

### Task 2: Write the failing test (~5 min)

Write the test file first. Tests cover: immediate restart when pipeline empty, heartbeat on progress, timeout, and event-bus wakeup.

**Files:**
- Create: `server/tests/await-restart.test.js`

- [ ] **Step 1: Create the test file**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the handler
vi.mock('../../db/task-core', () => ({
  listTasks: vi.fn(() => []),
}));

vi.mock('../../hooks/event-dispatch', () => {
  const { EventEmitter } = require('events');
  const taskEvents = new EventEmitter();
  taskEvents.setMaxListeners(50);
  return {
    taskEvents,
    NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
  };
});

vi.mock('../../event-bus', () => ({
  emitShutdown: vi.fn(),
}));

vi.mock('../../config', () => ({
  getEpoch: vi.fn(() => 1),
}));

describe('await_restart', () => {
  let handleAwaitRestart;
  let taskCore;
  let eventBus;
  let taskEvents;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    taskCore = (await import('../../db/task-core')).default || await import('../../db/task-core');
    eventBus = (await import('../../event-bus')).default || await import('../../event-bus');
    const dispatch = await import('../../hooks/event-dispatch');
    taskEvents = dispatch.taskEvents;
    const awaitModule = await import('../workflow/await.js');
    handleAwaitRestart = awaitModule.handleAwaitRestart;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    taskEvents.removeAllListeners();
  });

  it('restarts immediately when pipeline is empty', async () => {
    taskCore.listTasks.mockReturnValue([]);

    const result = await handleAwaitRestart({ reason: 'test' });
    const text = result.content[0].text;

    expect(text).toContain('Restart Ready');
    expect(eventBus.emitShutdown).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('waits for running tasks then restarts', async () => {
    // First call: 1 running task
    taskCore.listTasks
      .mockReturnValueOnce([{ id: 'r1', status: 'running' }]) // running
      .mockReturnValueOnce([])  // queued
      .mockReturnValueOnce([])  // pending
      .mockReturnValueOnce([])  // blocked
      // After event fires, recount — all empty
      .mockReturnValue([]);

    const promise = handleAwaitRestart({
      reason: 'code update',
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    // Let the event loop settle so the handler enters its await
    await vi.advanceTimersByTimeAsync(100);

    // Simulate task completion
    taskEvents.emit('task:completed', { id: 'r1' });

    const result = await promise;
    const text = result.content[0].text;

    expect(text).toContain('Restart Ready');
    expect(eventBus.emitShutdown).toHaveBeenCalled();
  });

  it('times out when tasks never finish', async () => {
    // Always return 1 running task
    taskCore.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'stuck', status: 'running' }];
      return [];
    });

    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0,
      timeout_minutes: 0.02, // ~1.2 seconds
    });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    const text = result.content[0].text;

    expect(text).toContain('Drain Timed Out');
    expect(eventBus.emitShutdown).not.toHaveBeenCalled();
  });

  it('returns heartbeat with pipeline counts', async () => {
    taskCore.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'r1', status: 'running', provider: 'codex', task_description: 'build thing' }];
      if (status === 'queued') return [{ id: 'q1', status: 'queued' }];
      if (status === 'blocked') return [{ id: 'b1', status: 'blocked' }];
      return [];
    });

    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0.01, // ~0.6 seconds
      timeout_minutes: 1,
    });

    // Advance to heartbeat
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    const text = result.content[0].text;

    expect(text).toContain('Restart Drain');
    expect(text).toContain('Heartbeat');
    expect(text).toContain('Running');
    expect(text).toContain('1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `torque-remote npx vitest run server/tests/await-restart.test.js --reporter=verbose`

Expected: FAIL — `handleAwaitRestart` is not exported from `await.js`

- [ ] **Step 3: Commit**

```bash
git add server/tests/await-restart.test.js
git commit -m "test(await_restart): add failing tests for pipeline drain await"
```

---

### Task 3: Implement handleAwaitRestart (~5 min)

Add the handler function to `server/handlers/workflow/await.js` and export it.

**Files:**
- Modify: `server/handlers/workflow/await.js`

- [ ] **Step 1: Add handleAwaitRestart function**

Add this function before the `createWorkflowAwaitHandlers` function (before ~line 1765):

```js
/**
 * Block until the task pipeline is empty, then trigger a server restart.
 * Returns heartbeat progress snapshots at configurable intervals.
 * Does NOT cancel tasks — only waits.
 */
async function handleAwaitRestart(args) {
  try {
    const timeoutMinutes = Math.min(Math.max(args.timeout_minutes || 30, 0.1), 60);
    const timeoutMs = timeoutMinutes * 60000;
    const startTime = Date.now();
    const shutdownSignal = args.__shutdownSignal;
    const reason = args.reason || 'await_restart';

    const rawHeartbeat = args.heartbeat_minutes != null ? args.heartbeat_minutes : 5;
    const heartbeatMinutes = Math.min(Math.max(rawHeartbeat, 0), 30);
    const heartbeatEnabled = heartbeatMinutes > 0;
    const heartbeatMs = heartbeatMinutes * 60 * 1000;
    let heartbeatCount = 0;

    const terminalTaskStates = ['completed', 'failed', 'cancelled', 'skipped'];
    const pollMs = 5000;

    const eventBus = require('../../event-bus');

    function countPipeline() {
      const running = taskCore.listTasks({ status: 'running', limit: 1000 });
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 });
      const pending = taskCore.listTasks({ status: 'pending', limit: 1000 });
      const blocked = taskCore.listTasks({ status: 'blocked', limit: 1000 });
      return {
        running, queued, pending, blocked,
        total: running.length + queued.length + pending.length + blocked.length,
      };
    }

    // If pipeline is already empty, restart immediately
    const initial = countPipeline();
    if (initial.total === 0) {
      process._torqueRestartPending = true;
      eventBus.emitShutdown(`restart: ${reason}`);
      return {
        content: [{
          type: 'text',
          text: `## Restart Ready\n\nPipeline was already empty.\nServer restart triggered — MCP client will reconnect with fresh code.\nRun \`/mcp\` to force immediate reconnection.`,
        }],
      };
    }

    const initialTotal = initial.total;

    // Await loop — wake on task events, heartbeat, or timeout
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        const counts = countPipeline();
        return {
          content: [{
            type: 'text',
            text: `## Drain Timed Out\n\nWaited ${formatDuration(elapsed)} — ${counts.total} tasks still in pipeline (${counts.running.length} running, ${counts.queued.length} queued, ${counts.pending.length} pending, ${counts.blocked.length} blocked).\nServer was NOT restarted. Cancel remaining tasks or increase timeout.`,
          }],
        };
      }

      // Wait for event-bus wakeup, heartbeat timer, or poll interval
      let signalType = 'poll';

      await new Promise(resolve => {
        let resolved = false;
        let taskEventsRef = null;
        let terminalHandlerRef = null;
        let shutdownRef = null;

        const cleanup = () => {
          if (taskEventsRef && terminalHandlerRef) {
            for (const ev of terminalTaskStates) {
              taskEventsRef.removeListener(`task:${ev}`, terminalHandlerRef);
            }
          }
          if (shutdownSignal && shutdownRef) {
            shutdownSignal.removeEventListener('abort', shutdownRef);
            shutdownRef = null;
          }
        };

        const done = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanup();
            resolve();
          }
        };

        // Timer: heartbeat interval if enabled, else poll interval
        let timerDelay = pollMs;
        let timerSignal = 'poll';
        if (heartbeatEnabled) {
          const remaining = timeoutMs - (Date.now() - startTime);
          if (remaining > heartbeatMs) {
            timerDelay = heartbeatMs;
            timerSignal = 'heartbeat';
          }
        }

        const timer = setTimeout(() => {
          signalType = timerSignal;
          done();
        }, timerDelay);

        // Wake on shutdown signal
        if (shutdownSignal) {
          if (shutdownSignal.aborted) { signalType = 'shutdown'; done(); return; }
          shutdownRef = () => { signalType = 'shutdown'; done(); };
          shutdownSignal.addEventListener('abort', shutdownRef, { once: true });
        }

        // Wake on task terminal events
        try {
          const { taskEvents } = require('../../hooks/event-dispatch');
          taskEventsRef = taskEvents;
          terminalHandlerRef = () => {
            signalType = 'terminal';
            done();
          };
          for (const ev of terminalTaskStates) {
            taskEvents.on(`task:${ev}`, terminalHandlerRef);
          }
        } catch {
          // event-dispatch not available — fall back to timer
        }
      });

      if (signalType === 'shutdown') {
        return {
          content: [{
            type: 'text',
            text: '## Await Cancelled\n\nServer shutdown signal received. Await aborted.',
          }],
        };
      }

      // Check pipeline
      const counts = countPipeline();
      if (counts.total === 0) {
        const elapsed = Date.now() - startTime;
        process._torqueRestartPending = true;
        eventBus.emitShutdown(`restart: ${reason}`);
        return {
          content: [{
            type: 'text',
            text: `## Restart Ready\n\nPipeline drained in ${formatDuration(elapsed)} (started with ${initialTotal} tasks).\nServer restart triggered — MCP client will reconnect with fresh code.\nRun \`/mcp\` to force immediate reconnection.`,
          }],
        };
      }

      // Return heartbeat if that's what woke us
      if (signalType === 'heartbeat') {
        heartbeatCount++;
        const elapsed = Date.now() - startTime;

        const runningDescs = counts.running.slice(0, 5).map(t => {
          const desc = (t.task_description || t.description || '').slice(0, 60);
          const provider = t.provider || '?';
          return `- ${t.id.substring(0, 8)} (${provider}) ${desc}`;
        }).join('\n');

        let text = `## Restart Drain — Heartbeat #${heartbeatCount}\n\n`;
        text += `| Status | Count |\n|--------|-------|\n`;
        text += `| Running | ${counts.running.length} |\n`;
        text += `| Queued | ${counts.queued.length} |\n`;
        text += `| Pending | ${counts.pending.length} |\n`;
        text += `| Blocked | ${counts.blocked.length} |\n\n`;
        text += `**Elapsed:** ${formatDuration(elapsed)} / ${formatDuration(timeoutMs)} timeout\n\n`;
        if (runningDescs) {
          text += `### Running\n${runningDescs}\n\n`;
        }
        text += `Re-invoke \`await_restart\` to continue waiting.`;

        return { content: [{ type: 'text', text }] };
      }

      // Poll/terminal signal — loop back and recheck
    }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}
```

- [ ] **Step 2: Add to exports**

In the `createWorkflowAwaitHandlers` return object (~line 1766), add `handleAwaitRestart`:

```js
function createWorkflowAwaitHandlers(_deps) {
  return {
    formatDuration,
    formatHeartbeat,
    formatTaskYield,
    handleAwaitWorkflow,
    handleAwaitTask,
    handleAwaitRestart,
    formatFinalSummary,
    detectRepeatedErrors,
    recommendAction,
  };
}
```

And in `module.exports` (~line 1778), add `handleAwaitRestart`:

```js
module.exports = {
  formatDuration,
  formatHeartbeat,
  formatTaskYield,
  handleAwaitWorkflow,
  handleAwaitTask,
  handleAwaitRestart,
  formatFinalSummary,
  createWorkflowAwaitHandlers,
  detectRepeatedErrors,
  recommendAction,
};
```

- [ ] **Step 3: Run tests**

Run: `torque-remote npx vitest run server/tests/await-restart.test.js --reporter=verbose`

Expected: All 4 tests PASS

- [ ] **Step 4: Run existing await tests to check for regressions**

Run: `torque-remote npx vitest run server/tests/await-heartbeat.test.js server/tests/workflow-await.test.js --reporter=verbose`

Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/handlers/workflow/await.js
git commit -m "feat(await_restart): implement handleAwaitRestart with event-bus wakeup and heartbeats"
```

---

### Task 4: Update test counts and run full validation (~2 min)

Existing tests that count tools, routes, or tier membership need updating.

**Files:**
- Modify: `server/tests/tools-aggregator.test.js` (if it checks TIER_1 count)
- Modify: `server/tests/core-tools.test.js` (if it checks CORE_TOOL_NAMES contents)
- Modify: `server/tests/tool-annotations.test.js` (if it checks annotation counts)

- [ ] **Step 1: Search for hardcoded counts**

Run: `grep -n "TIER_1\|CORE_TOOL_NAMES\|core-defs" server/tests/core-tools.test.js server/tests/tools-aggregator.test.js server/tests/tool-annotations.test.js`

Fix any hardcoded counts that need incrementing by 1 (for the new `await_restart` tool). The exact lines will depend on what the grep finds — increment any count that reflects the number of core/tier-1 tools.

- [ ] **Step 2: Run full test suite for affected files**

Run: `torque-remote npx vitest run server/tests/core-tools.test.js server/tests/tools-aggregator.test.js server/tests/tool-annotations.test.js server/tests/await-restart.test.js --reporter=verbose`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add -A server/tests/
git commit -m "test(await_restart): fix tool count assertions for new await_restart tool"
```

---

### Task 5: Push and verify on remote (~1 min)

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Run broader test sweep on remote**

Run: `torque-remote npx vitest run server/tests/await-restart.test.js server/tests/core-tools.test.js server/tests/restart-drain.test.js server/tests/restart-server-tool.test.js --reporter=verbose`

Expected: All PASS

- [ ] **Step 3: Restart TORQUE and test the new tool live**

Call `await_restart` to verify it works end-to-end. If the pipeline is empty, it should restart immediately. If tasks are running, it should return heartbeats.
