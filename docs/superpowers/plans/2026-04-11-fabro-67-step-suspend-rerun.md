> **STALE — needs rewrite (2026-05-01).** Layered on unshipped fabro-30 (signals/queries) and fabro-43 (human tasks). Refresh focus: collapse 30/43/67 into one in-flight-pause primitive.

# Fabro #67: Step-Native Suspend + Rerun (Pipedream)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a task mid-execution call `suspend({ resume_token, timeout_ms })` — the task's process stops, its position in the workflow is saved, and it receives a `resume_url`. When `POST /api/tasks/resume/:token` is called (by a webhook, human, or external callback), the task resumes with the inbound payload. Complementary to Plan 30 signals and Plan 43 human tasks; this is **in-step** suspension. Inspired by Pipedream's `$.flow.suspend` / `$.flow.rerun`.

**Architecture:** A new `suspended_tasks` table stores `(task_id, resume_token, context_json, resume_payload_json, suspended_at, resumed_at, timeout_at)`. When a task calls suspend via an MCP tool, the runtime stops its active process, records the suspension, and returns a `resume_url`. A REST `POST /resume/:token` endpoint validates the token, records the inbound payload, and re-enqueues the task. On resume, the task sees the payload in its prompt context as `$.resume_payload`.

**Tech Stack:** Node.js, Express, better-sqlite3. Builds on plans 14 (events), 27 (state), 30 (signals), 31 (activities).

---

## File Structure

**New files:**
- `server/migrations/0NN-suspended-tasks.sql`
- `server/suspension/suspension-manager.js`
- `server/tests/suspension-manager.test.js`
- `server/api/routes/resume.js`

**Modified files:**
- `server/handlers/mcp-tools.js` — `suspend_task`, `list_suspended`
- `server/execution/task-startup.js` — inject $.resume_payload, handle re-entry
- `server/maintenance/` — timeout sweeper

---

## Task 1: Migration + manager

- [ ] **Step 1: Migration**

`server/migrations/0NN-suspended-tasks.sql`:

```sql
CREATE TABLE IF NOT EXISTS suspended_tasks (
  resume_token TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT,
  suspend_reason TEXT,
  context_json TEXT,
  resume_payload_json TEXT,
  suspended_at TEXT NOT NULL DEFAULT (datetime('now')),
  resumed_at TEXT,
  timeout_at TEXT,
  status TEXT NOT NULL DEFAULT 'suspended'   -- 'suspended' | 'resumed' | 'timed_out' | 'cancelled'
);

CREATE INDEX IF NOT EXISTS idx_suspended_tasks_status ON suspended_tasks(status);
CREATE INDEX IF NOT EXISTS idx_suspended_tasks_timeout ON suspended_tasks(timeout_at);
```

- [ ] **Step 2: Tests**

Create `server/tests/suspension-manager.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createSuspensionManager } = require('../suspension/suspension-manager');

describe('suspensionManager', () => {
  let db, mgr;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO tasks (task_id, status) VALUES ('t1','running')`).run();
    mgr = createSuspensionManager({ db, publicBaseUrl: 'http://localhost:3457' });
  });

  it('suspend creates a token and moves task to suspended status', () => {
    const r = mgr.suspend({ taskId: 't1', context: { attempt: 1 }, timeoutMs: 60000 });
    expect(r.resume_token).toMatch(/^res_/);
    expect(r.resume_url).toMatch(/http:\/\/localhost:3457\/api\/tasks\/resume\/res_/);
    const t = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('t1');
    expect(t.status).toBe('suspended');
  });

  it('suspend persists context for resume', () => {
    const r = mgr.suspend({ taskId: 't1', context: { poll_cursor: 'abc123' } });
    const row = db.prepare('SELECT context_json FROM suspended_tasks WHERE resume_token = ?').get(r.resume_token);
    expect(JSON.parse(row.context_json).poll_cursor).toBe('abc123');
  });

  it('resume stores payload + marks as resumed + returns task_id', () => {
    const r = mgr.suspend({ taskId: 't1' });
    const resumeResult = mgr.resume(r.resume_token, { external_result: 42 });
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.task_id).toBe('t1');
    const row = db.prepare('SELECT status, resume_payload_json FROM suspended_tasks WHERE resume_token = ?').get(r.resume_token);
    expect(row.status).toBe('resumed');
    expect(JSON.parse(row.resume_payload_json).external_result).toBe(42);
  });

  it('resume with invalid token returns ok=false', () => {
    expect(mgr.resume('bogus', {}).ok).toBe(false);
  });

  it('resume on already-resumed token is idempotent — returns ok=false', () => {
    const r = mgr.suspend({ taskId: 't1' });
    mgr.resume(r.resume_token, { x: 1 });
    const second = mgr.resume(r.resume_token, { x: 2 });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already/i);
  });

  it('sweepTimeouts marks expired suspensions as timed_out', () => {
    const r = mgr.suspend({ taskId: 't1', timeoutMs: -1 });
    const swept = mgr.sweepTimeouts();
    expect(swept).toContain(r.resume_token);
    const row = db.prepare('SELECT status FROM suspended_tasks WHERE resume_token = ?').get(r.resume_token);
    expect(row.status).toBe('timed_out');
  });

  it('listSuspended returns current suspended tasks', () => {
    mgr.suspend({ taskId: 't1' });
    const list = mgr.listSuspended();
    expect(list).toHaveLength(1);
    expect(list[0].task_id).toBe('t1');
  });
});
```

- [ ] **Step 3: Implement**

Create `server/suspension/suspension-manager.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createSuspensionManager({ db, publicBaseUrl, onResume = () => {}, logger = console }) {
  function suspend({ taskId, workflowId = null, context = null, reason = null, timeoutMs = null }) {
    const token = `res_${randomUUID().replace(/-/g, '')}`;
    const timeoutAt = timeoutMs != null ? new Date(Date.now() + timeoutMs).toISOString() : null;
    db.prepare(`
      INSERT INTO suspended_tasks (resume_token, task_id, workflow_id, suspend_reason, context_json, timeout_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, taskId, workflowId, reason, context ? JSON.stringify(context) : null, timeoutAt);
    db.prepare(`UPDATE tasks SET status = 'suspended' WHERE task_id = ?`).run(taskId);
    return {
      resume_token: token,
      resume_url: `${publicBaseUrl.replace(/\/+$/, '')}/api/tasks/resume/${token}`,
      cancel_url: `${publicBaseUrl.replace(/\/+$/, '')}/api/tasks/resume/${token}?action=cancel`,
      timeout_at: timeoutAt,
    };
  }

  function resume(token, payload) {
    const row = db.prepare('SELECT * FROM suspended_tasks WHERE resume_token = ?').get(token);
    if (!row) return { ok: false, reason: 'unknown token' };
    if (row.status !== 'suspended') return { ok: false, reason: `token already ${row.status}` };
    db.prepare(`
      UPDATE suspended_tasks SET status = 'resumed', resumed_at = datetime('now'), resume_payload_json = ?
      WHERE resume_token = ?
    `).run(JSON.stringify(payload || {}), token);
    // Hand back to runtime so it can re-enqueue the task
    try { onResume({ taskId: row.task_id, workflowId: row.workflow_id, payload, context: row.context_json && JSON.parse(row.context_json) }); }
    catch (err) { logger.warn('onResume callback failed', err); }
    return { ok: true, task_id: row.task_id };
  }

  function cancel(token, reason = null) {
    const row = db.prepare('SELECT status, task_id FROM suspended_tasks WHERE resume_token = ?').get(token);
    if (!row) return { ok: false, reason: 'unknown token' };
    if (row.status !== 'suspended') return { ok: false, reason: `token already ${row.status}` };
    db.prepare(`UPDATE suspended_tasks SET status = 'cancelled', resumed_at = datetime('now') WHERE resume_token = ?`).run(token);
    db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE task_id = ?`).run(row.task_id);
    return { ok: true, task_id: row.task_id };
  }

  function sweepTimeouts() {
    const expired = db.prepare(`
      SELECT resume_token, task_id FROM suspended_tasks
      WHERE status = 'suspended' AND timeout_at IS NOT NULL AND timeout_at < datetime('now')
    `).all();
    for (const e of expired) {
      db.prepare(`UPDATE suspended_tasks SET status = 'timed_out' WHERE resume_token = ?`).run(e.resume_token);
      db.prepare(`UPDATE tasks SET status = 'failed', error_output = 'suspension timed out' WHERE task_id = ?`).run(e.task_id);
    }
    return expired.map(e => e.resume_token);
  }

  function listSuspended() {
    return db.prepare(`SELECT * FROM suspended_tasks WHERE status = 'suspended' ORDER BY suspended_at DESC`).all();
  }

  return { suspend, resume, cancel, sweepTimeouts, listSuspended };
}

module.exports = { createSuspensionManager };
```

Run tests → PASS. Commit: `feat(suspension): manager with suspend/resume/cancel/timeout`.

---

## Task 2: MCP tool + REST + wiring

- [ ] **Step 1: REST**

Create `server/api/routes/resume.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.post('/:token', express.json(), (req, res) => {
  const mgr = defaultContainer.get('suspensionManager');
  if (req.query.action === 'cancel') {
    return res.json(mgr.cancel(req.params.token));
  }
  const r = mgr.resume(req.params.token, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/:token', (req, res) => {
  // Useful for browser-based forms to pre-fetch context
  const { defaultContainer } = require('../../container');
  const row = defaultContainer.get('db').prepare('SELECT status, suspend_reason, context_json FROM suspended_tasks WHERE resume_token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'unknown token' });
  res.json({
    status: row.status,
    reason: row.suspend_reason,
    context: row.context_json ? JSON.parse(row.context_json) : null,
  });
});

module.exports = router;
```

- [ ] **Step 2: MCP tool**

```js
suspend_task: {
  description: 'Suspend the currently running task. Returns a resume_url (and timeout). The task resumes when the URL receives a POST — the body becomes the resume_payload available to the re-entering task.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      context: { type: 'object', description: 'Arbitrary JSON state preserved across suspension.' },
      timeout_ms: { type: 'integer' },
    },
  },
},
list_suspended: { description: 'List currently suspended tasks.', inputSchema: { type: 'object', properties: {} } },
```

Handler:

```js
case 'suspend_task': {
  const mgr = defaultContainer.get('suspensionManager');
  return mgr.suspend({
    taskId: ctx.taskId, workflowId: ctx.workflowId,
    reason: args.reason, context: args.context, timeoutMs: args.timeout_ms,
  });
}
case 'list_suspended':
  return { suspended: defaultContainer.get('suspensionManager').listSuspended() };
```

- [ ] **Step 3: Re-entry — inject resume_payload on restart**

In `server/execution/task-startup.js` when a task transitions from suspended back to running:

```js
const suspended = db.prepare(`
  SELECT context_json, resume_payload_json FROM suspended_tasks
  WHERE task_id = ? AND status = 'resumed'
  ORDER BY resumed_at DESC LIMIT 1
`).get(taskId);
if (suspended) {
  const payload = suspended.resume_payload_json ? JSON.parse(suspended.resume_payload_json) : {};
  const context = suspended.context_json ? JSON.parse(suspended.context_json) : {};
  task.task_description += `\n\n---\n\n## Resume payload\n${JSON.stringify(payload, null, 2)}\n\n## Prior context\n${JSON.stringify(context, null, 2)}\n\nContinue from where you left off.`;
}
```

- [ ] **Step 4: Container + sweep**

```js
container.factory('suspensionManager', (c) => {
  const { createSuspensionManager } = require('./suspension/suspension-manager');
  return createSuspensionManager({
    db: c.get('db'),
    publicBaseUrl: c.get('serverConfig').get('public_base_url') || 'http://localhost:3457',
    onResume: ({ taskId }) => c.get('queueScheduler').enqueueTask(taskId),
    logger: c.get('logger'),
  });
});

setInterval(() => defaultContainer.get('suspensionManager').sweepTimeouts(), 30 * 1000);
```

`await_restart`. Smoke: task prompt "Call suspend_task with reason='await human' then wait", observe it stops mid-execution. curl `POST /api/tasks/resume/:token -d '{"approved":true}'`. Confirm task resumes and sees `approved: true` in its prompt.

Commit: `feat(suspension): MCP tool + REST endpoint + re-entry hook`.
