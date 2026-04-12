# Fabro #31: Activities — Durable Side-Effect Boundaries (Temporal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Treat every external side effect — provider calls, MCP tool invocations, verify commands, remote-agent shell commands — as a uniform durable **Activity** with consistent retry, timeout, heartbeat, and cancellation semantics. Inspired by Temporal's Activities.

**Architecture:** A new module `activity-runner.js` wraps any side-effect call in a uniform contract: `runActivity({ kind, name, input, options })` returns a promise and journals begin/complete/fail/heartbeat events. Options: `{ start_to_close_timeout, retry_policy, heartbeat_timeout }`. A new `activities` table records every invocation by ID with status, attempt count, last heartbeat. Existing call sites (provider router, MCP tool dispatcher, verify-runner, remote-agent runner) are wrapped to flow through `runActivity` so their failures, retries, and cancellations follow the same rules.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 14 (events), 27 (state), 29 (journal). Complements but does not replace existing provider routing.

---

## File Structure

**New files:**
- `server/migrations/0NN-activities.sql`
- `server/activities/activity-runner.js` — runner with retry/timeout/heartbeat
- `server/activities/retry-policy.js` — exponential / fixed / no-retry policy module
- `server/activities/activity-store.js` — DB read/write
- `server/tests/activity-runner.test.js`
- `server/tests/retry-policy.test.js`

**Modified files:**
- `server/execution/provider-dispatch.js` (or equivalent provider call site) — wrap in runActivity
- `server/handlers/mcp-tools.js` — wrap MCP tool invocations
- `server/validation/auto-verify-retry.js` — wrap verify command call
- `server/plugins/remote-agents/runner.js` — wrap remote shell execution

---

## Task 1: Migration + activity store

- [ ] **Step 1: Migration**

`server/migrations/0NN-activities.sql`:

```sql
CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,           -- 'provider' | 'mcp_tool' | 'verify' | 'remote_shell' | other
  name TEXT NOT NULL,           -- e.g., 'codex.runPrompt', 'snapscope.peek_ui'
  input_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed | cancelled | timed_out
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  start_to_close_timeout_ms INTEGER,
  heartbeat_timeout_ms INTEGER,
  last_heartbeat_at TEXT,
  result_json TEXT,
  error_text TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_status_heartbeat ON activities(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_activities_task ON activities(task_id);
CREATE INDEX IF NOT EXISTS idx_activities_kind ON activities(kind);
```

- [ ] **Step 2: Implement store**

Create `server/activities/activity-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createActivityStore({ db }) {
  function create({ workflowId, taskId, kind, name, input, options }) {
    const id = `act_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO activities (activity_id, workflow_id, task_id, kind, name, input_json,
        max_attempts, start_to_close_timeout_ms, heartbeat_timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, workflowId || null, taskId || null, kind, name,
      input === undefined ? null : JSON.stringify(input),
      options?.max_attempts || 1,
      options?.start_to_close_timeout_ms || null,
      options?.heartbeat_timeout_ms || null,
    );
    return id;
  }

  function markRunning(id) {
    db.prepare(`
      UPDATE activities SET status = 'running', attempt = attempt + 1, started_at = datetime('now')
      WHERE activity_id = ?
    `).run(id);
  }

  function heartbeat(id) {
    db.prepare(`UPDATE activities SET last_heartbeat_at = datetime('now') WHERE activity_id = ?`).run(id);
  }

  function complete(id, result) {
    db.prepare(`
      UPDATE activities SET status = 'completed', result_json = ?, completed_at = datetime('now')
      WHERE activity_id = ?
    `).run(result === undefined ? null : JSON.stringify(result), id);
  }

  function fail(id, errorText, finalStatus = 'failed') {
    db.prepare(`
      UPDATE activities SET status = ?, error_text = ?, completed_at = datetime('now')
      WHERE activity_id = ?
    `).run(finalStatus, errorText, id);
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM activities WHERE activity_id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      input: row.input_json ? safeParse(row.input_json) : null,
      result: row.result_json ? safeParse(row.result_json) : null,
    };
  }

  function listStale({ heartbeatGraceMs }) {
    return db.prepare(`
      SELECT activity_id FROM activities
      WHERE status = 'running'
        AND heartbeat_timeout_ms IS NOT NULL
        AND (julianday('now') - julianday(COALESCE(last_heartbeat_at, started_at))) * 86400000 > heartbeat_timeout_ms + ?
    `).all(heartbeatGraceMs).map(r => r.activity_id);
  }

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  return { create, markRunning, heartbeat, complete, fail, get, listStale };
}

module.exports = { createActivityStore };
```

Commit: `feat(activities): table + store module`.

---

## Task 2: Retry policy

- [ ] **Step 1: Tests**

Create `server/tests/retry-policy.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { computeBackoff, shouldRetry } = require('../activities/retry-policy');

describe('computeBackoff', () => {
  it('returns 0 for the first attempt', () => {
    expect(computeBackoff({ attempt: 1, initial_ms: 100 })).toBe(0);
  });

  it('exponential: doubles each attempt up to max', () => {
    const policy = { initial_ms: 100, max_ms: 10000, multiplier: 2 };
    expect(computeBackoff({ attempt: 2, ...policy })).toBe(100);
    expect(computeBackoff({ attempt: 3, ...policy })).toBe(200);
    expect(computeBackoff({ attempt: 4, ...policy })).toBe(400);
    expect(computeBackoff({ attempt: 10, ...policy })).toBe(10000);
  });

  it('fixed: same backoff every attempt', () => {
    expect(computeBackoff({ attempt: 5, initial_ms: 250, multiplier: 1 })).toBe(250);
  });
});

describe('shouldRetry', () => {
  it('returns true while attempt < max_attempts and error is retriable', () => {
    expect(shouldRetry({ attempt: 1, max_attempts: 3, error: { retriable: true } })).toBe(true);
    expect(shouldRetry({ attempt: 3, max_attempts: 3, error: { retriable: true } })).toBe(false);
  });

  it('returns false when error is non-retriable regardless of attempts', () => {
    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { retriable: false, name: 'ValidationError' } })).toBe(false);
  });

  it('non_retryable_errors list short-circuits', () => {
    const policy = { non_retryable_errors: ['ValidationError', 'AuthError'] };
    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { name: 'ValidationError' }, policy })).toBe(false);
    expect(shouldRetry({ attempt: 1, max_attempts: 5, error: { name: 'NetworkError' }, policy })).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/activities/retry-policy.js`:

```js
'use strict';

function computeBackoff({ attempt, initial_ms = 100, max_ms = 60000, multiplier = 2 }) {
  if (attempt <= 1) return 0;
  const raw = initial_ms * Math.pow(multiplier, attempt - 2);
  return Math.min(max_ms, raw);
}

function shouldRetry({ attempt, max_attempts, error, policy = {} }) {
  if (attempt >= max_attempts) return false;
  if (error?.retriable === false) return false;
  if (Array.isArray(policy.non_retryable_errors) && error?.name && policy.non_retryable_errors.includes(error.name)) return false;
  return true;
}

module.exports = { computeBackoff, shouldRetry };
```

Run tests → PASS. Commit: `feat(activities): retry policy module`.

---

## Task 3: Activity runner

- [ ] **Step 1: Tests**

Create `server/tests/activity-runner.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createActivityStore } = require('../activities/activity-store');
const { createJournalWriter } = require('../journal/journal-writer');
const { createActivityRunner } = require('../activities/activity-runner');

function setup() {
  const db = setupTestDb();
  const store = createActivityStore({ db });
  const journal = createJournalWriter({ db });
  const runner = createActivityRunner({ db, store, journal });
  db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','running')`).run();
  return { db, store, runner, journal };
}

describe('activityRunner.runActivity', () => {
  it('runs a happy-path activity once and marks completed', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => ({ value: 42 }));
    const result = await runner.runActivity({
      workflowId: 'wf-1', taskId: 't1', kind: 'mcp_tool', name: 'noop', input: { x: 1 }, fn,
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('completed');
    expect(stored.attempt).toBe(1);
  });

  it('retries up to max_attempts on retriable failure', async () => {
    const { runner, store } = setup();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('transient'), { retriable: true });
      return { ok: true };
    });
    const result = await runner.runActivity({
      workflowId: 'wf-1', kind: 'provider', name: 'codex.runPrompt', fn,
      options: { max_attempts: 3, retry_policy: { initial_ms: 1, max_ms: 5 } },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    const stored = store.get(result.activity_id);
    expect(stored.attempt).toBe(3);
  });

  it('fails after exhausting retries', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => { throw Object.assign(new Error('always fails'), { retriable: true }); });
    const result = await runner.runActivity({
      workflowId: 'wf-1', kind: 'provider', name: 'codex.runPrompt', fn,
      options: { max_attempts: 2, retry_policy: { initial_ms: 1 } },
    });
    expect(result.ok).toBe(false);
    expect(result.attempt).toBe(2);
    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('failed');
    expect(stored.error_text).toMatch(/always fails/);
  });

  it('does not retry non-retriable errors', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(async () => { throw Object.assign(new Error('validation'), { retriable: false, name: 'ValidationError' }); });
    const result = await runner.runActivity({
      workflowId: 'wf-1', kind: 'verify', name: 'tsc', fn,
      options: { max_attempts: 5 },
    });
    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    const stored = store.get(result.activity_id);
    expect(stored.attempt).toBe(1);
    expect(stored.status).toBe('failed');
  });

  it('honors start_to_close_timeout_ms', async () => {
    const { runner, store } = setup();
    const fn = vi.fn(() => new Promise(resolve => setTimeout(() => resolve('late'), 200)));
    const result = await runner.runActivity({
      workflowId: 'wf-1', kind: 'mcp_tool', name: 'slow', fn,
      options: { start_to_close_timeout_ms: 50, max_attempts: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    const stored = store.get(result.activity_id);
    expect(stored.status).toBe('timed_out');
  });

  it('journals begin/complete events with activity_id', async () => {
    const { runner, journal } = setup();
    const fn = async () => 'ok';
    const result = await runner.runActivity({
      workflowId: 'wf-1', kind: 'mcp_tool', name: 'noop', fn,
    });
    const events = journal.readJournal('wf-1');
    expect(events.some(e => e.event_type === 'activity_started' && e.payload?.activity_id === result.activity_id)).toBe(true);
    expect(events.some(e => e.event_type === 'activity_completed' && e.payload?.activity_id === result.activity_id)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/activities/activity-runner.js`:

```js
'use strict';
const { computeBackoff, shouldRetry } = require('./retry-policy');

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error(`Activity timed out after ${ms}ms`);
      err.code = 'ACTIVITY_TIMEOUT';
      err.retriable = false;
      reject(err);
    }, ms)),
  ]);
}

function createActivityRunner({ db, store, journal, logger = console }) {
  async function runActivity({ workflowId, taskId, kind, name, input, fn, options = {} }) {
    const activityId = store.create({ workflowId, taskId, kind, name, input, options });

    if (workflowId) {
      journal.write({
        workflowId, taskId, type: 'activity_started',
        payload: { activity_id: activityId, kind, name, input },
      });
    }

    const max_attempts = options.max_attempts || 1;
    const policy = options.retry_policy || {};
    let lastError = null;
    let attempt = 0;

    while (attempt < max_attempts) {
      attempt++;
      store.markRunning(activityId);

      try {
        const result = await withTimeout(Promise.resolve().then(() => fn()), options.start_to_close_timeout_ms);
        store.complete(activityId, result);
        if (workflowId) {
          journal.write({
            workflowId, taskId, type: 'activity_completed',
            payload: { activity_id: activityId, attempt, result_summary: summarize(result) },
          });
        }
        return { ok: true, value: result, activity_id: activityId, attempt };
      } catch (err) {
        lastError = err;
        const isTimeout = err.code === 'ACTIVITY_TIMEOUT';
        if (isTimeout) {
          store.fail(activityId, err.message, 'timed_out');
        }
        if (!shouldRetry({ attempt, max_attempts, error: err, policy })) break;
        const backoff = computeBackoff({ attempt: attempt + 1, ...policy });
        if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
      }
    }

    if (lastError) {
      const finalStatus = lastError.code === 'ACTIVITY_TIMEOUT' ? 'timed_out' : 'failed';
      if (finalStatus === 'failed') store.fail(activityId, lastError.message, 'failed');
      if (workflowId) {
        journal.write({
          workflowId, taskId, type: 'activity_failed',
          payload: { activity_id: activityId, attempt, error: lastError.message, status: finalStatus },
        });
      }
    }
    return { ok: false, error: lastError?.message || 'unknown', attempt, activity_id: activityId };
  }

  function heartbeat(activityId) {
    store.heartbeat(activityId);
  }

  function summarize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.slice(0, 200);
    try {
      const s = JSON.stringify(value);
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch { return '[unserializable]'; }
  }

  return { runActivity, heartbeat };
}

module.exports = { createActivityRunner };
```

Add `activity_started`, `activity_completed`, `activity_failed`, `activity_heartbeat` to `VALID_EVENT_TYPES` in `server/journal/journal-writer.js`.

Run tests → PASS. Commit: `feat(activities): runner with retry/timeout/heartbeat semantics`.

---

## Task 4: Wrap existing call sites

- [ ] **Step 1: Container registration**

In `server/container.js`:

```js
container.factory('activityStore', (c) => {
  const { createActivityStore } = require('./activities/activity-store');
  return createActivityStore({ db: c.get('db') });
});
container.factory('activityRunner', (c) => {
  const { createActivityRunner } = require('./activities/activity-runner');
  return createActivityRunner({
    db: c.get('db'),
    store: c.get('activityStore'),
    journal: c.get('journalWriter'),
    logger: c.get('logger'),
  });
});
```

- [ ] **Step 2: Wrap MCP tool dispatch**

In `server/handlers/mcp-tools.js` at the dispatcher entry:

```js
const runner = defaultContainer.get('activityRunner');
return await runner.runActivity({
  workflowId: ctx.workflowId, taskId: ctx.taskId,
  kind: 'mcp_tool', name: toolName, input: args,
  fn: () => actualToolHandler(toolName, args, ctx),
  options: { max_attempts: 1, start_to_close_timeout_ms: 60000 },
});
```

(Adjust to wrap only tools that produce side effects — read-only tools can skip the wrap.)

- [ ] **Step 3: Wrap verify command**

In `server/validation/auto-verify-retry.js` where the verify command spawns:

```js
const runner = defaultContainer.get('activityRunner');
return await runner.runActivity({
  workflowId: task.workflow_id, taskId,
  kind: 'verify', name: verifyCommand,
  input: { command: verifyCommand, cwd: workingDirectory },
  fn: () => spawnVerifyAndReturnResult(verifyCommand, workingDirectory),
  options: {
    max_attempts: 1,
    start_to_close_timeout_ms: (config.get('verify_timeout_seconds') || 600) * 1000,
  },
});
```

- [ ] **Step 4: Wrap remote shell**

In `server/plugins/remote-agents/runner.js` where SSH/HTTP exec is called:

```js
const runner = defaultContainer.get('activityRunner');
return await runner.runActivity({
  workflowId, taskId, kind: 'remote_shell', name: agentName,
  input: { command: cmd, args },
  fn: () => actualRemoteExec(cmd, args),
  options: { max_attempts: 2, retry_policy: { initial_ms: 500, max_ms: 5000 }, start_to_close_timeout_ms: 300000 },
});
```

Commit: `feat(activities): wrap mcp-tools, verify, and remote-shell call sites`.

---

## Task 5: Stale activity cleanup + REST inspection

- [ ] **Step 1: Cleanup tick**

In `server/maintenance/orphan-cleanup.js` add a periodic check:

```js
function reapStaleActivities() {
  const store = defaultContainer.get('activityStore');
  const stale = store.listStale({ heartbeatGraceMs: 30000 });
  for (const id of stale) {
    store.fail(id, 'Heartbeat timeout exceeded', 'timed_out');
    logger.warn('reaped stale activity', { activity_id: id });
  }
}
setInterval(reapStaleActivities, 30000);
```

- [ ] **Step 2: REST**

In `server/api/routes/activities.js` (new file, registered in api index):

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.get('/', (req, res) => {
  const status = req.query.status;
  const kind = req.query.kind;
  const taskId = req.query.task_id;
  const filters = [];
  const params = [];
  if (status) { filters.push('status = ?'); params.push(status); }
  if (kind)   { filters.push('kind = ?'); params.push(kind); }
  if (taskId) { filters.push('task_id = ?'); params.push(taskId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = defaultContainer.get('db').prepare(
    `SELECT activity_id, workflow_id, task_id, kind, name, status, attempt, max_attempts, started_at, completed_at
     FROM activities ${where} ORDER BY created_at DESC LIMIT 200`
  ).all(...params);
  res.json({ activities: rows });
});

router.get('/:id', (req, res) => {
  const a = defaultContainer.get('activityStore').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

module.exports = router;
```

`await_restart`. Smoke: submit a workflow that runs a verify command, then `GET /api/activities?kind=verify&task_id=<id>` and confirm the run is recorded with attempt count and timing. Tail `GET /api/workflows/<wf>/events` and confirm activity_started + activity_completed events are present.

Commit: `feat(activities): stale-reap + REST inspection`.
