# Fabro #45: Unified Trigger + Admission Layer (Inngest)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge "scheduled jobs", "event-triggered workflows", "debounce", and "throttle" into one declarative **admission layer**. A single `workflow_trigger` row can declare cron schedule, event match, debounce key + window, and throttle rate — the admission layer decides when (or whether) to actually start a run. Inspired by Inngest.

**Architecture:** A new `workflow_triggers` table holds trigger definitions. A shared `admission-controller.js` checks an incoming trigger (from cron, event bus, API) against debounce/throttle state before enqueueing a workflow run. Debounce groups by a templated key (e.g., `repo:{{event.repo}}`) and delays dispatch until the window has been quiet. Throttle enforces max-runs-per-window with token-bucket accounting. Replaces/absorbs the existing scattered schedule + event trigger code.

**Tech Stack:** Node.js, better-sqlite3, existing event bus. Builds on plans 9 (scheduling), 14 (events), 38 (domains).

---

## File Structure

**New files:**
- `server/migrations/0NN-workflow-triggers.sql`
- `server/admission/admission-controller.js`
- `server/admission/debounce.js`
- `server/admission/throttle.js`
- `server/tests/admission-controller.test.js`
- `server/tests/debounce.test.js`
- `server/tests/throttle.test.js`

**Modified files:**
- `server/scheduling/scheduler.js` — route cron trigger through admission
- `server/events/event-bus.js` — route matched events through admission
- `server/handlers/mcp-tools.js` — `create_trigger`, `list_triggers`

---

## Task 1: Migration + debounce

- [ ] **Step 1: Migration**

`server/migrations/0NN-workflow-triggers.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_triggers (
  trigger_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  deployment_id TEXT,
  name TEXT NOT NULL,
  cron_schedule TEXT,
  event_match_json TEXT,
  debounce_key_template TEXT,
  debounce_window_ms INTEGER,
  throttle_max_per_window INTEGER,
  throttle_window_ms INTEGER,
  throttle_key_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admission_debounce_state (
  key TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  latest_event_json TEXT,
  fire_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admission_throttle_counters (
  key TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  window_start_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_debounce_fire ON admission_debounce_state(fire_at);
```

- [ ] **Step 2: Debounce tests**

Create `server/tests/debounce.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createDebouncer } = require('../admission/debounce');

describe('debouncer', () => {
  let db, d;
  beforeEach(() => { db = setupTestDb(); d = createDebouncer({ db }); });

  it('first event schedules a fire at now + window', () => {
    const r = d.arrive({ triggerId: 't1', key: 'repo:a', windowMs: 1000, event: { id: 1 } });
    expect(r.status).toBe('scheduled');
    expect(r.fireAtIso).toBeDefined();
  });

  it('subsequent event in same window postpones fire + replaces payload', () => {
    d.arrive({ triggerId: 't1', key: 'repo:a', windowMs: 1000, event: { id: 1 } });
    const r2 = d.arrive({ triggerId: 't1', key: 'repo:a', windowMs: 1000, event: { id: 2 } });
    expect(r2.status).toBe('postponed');
    const row = db.prepare(`SELECT latest_event_json FROM admission_debounce_state WHERE key = ?`).get('repo:a');
    expect(JSON.parse(row.latest_event_json).id).toBe(2);
  });

  it('different keys do not conflict', () => {
    d.arrive({ triggerId: 't1', key: 'repo:a', windowMs: 1000, event: {} });
    const r = d.arrive({ triggerId: 't1', key: 'repo:b', windowMs: 1000, event: {} });
    expect(r.status).toBe('scheduled');
  });

  it('dueEntries returns state rows whose fire_at is past now', () => {
    db.prepare(`INSERT INTO admission_debounce_state (key, trigger_id, latest_event_json, fire_at) VALUES (?,?,?,?)`)
      .run('repo:x', 't1', '{}', new Date(Date.now() - 100).toISOString());
    const due = d.dueEntries();
    expect(due.map(r => r.key)).toContain('repo:x');
  });

  it('clear removes an entry after firing', () => {
    db.prepare(`INSERT INTO admission_debounce_state (key, trigger_id, latest_event_json, fire_at) VALUES (?,?,?,?)`)
      .run('repo:x', 't1', '{}', new Date().toISOString());
    d.clear('repo:x');
    const row = db.prepare(`SELECT * FROM admission_debounce_state WHERE key = ?`).get('repo:x');
    expect(row).toBeUndefined();
  });
});
```

- [ ] **Step 3: Implement debouncer**

Create `server/admission/debounce.js`:

```js
'use strict';

function createDebouncer({ db }) {
  function arrive({ triggerId, key, windowMs, event }) {
    const fireAt = new Date(Date.now() + windowMs).toISOString();
    const existing = db.prepare('SELECT key FROM admission_debounce_state WHERE key = ?').get(key);
    if (existing) {
      db.prepare(`UPDATE admission_debounce_state SET latest_event_json = ?, fire_at = ?, updated_at = datetime('now') WHERE key = ?`)
        .run(JSON.stringify(event), fireAt, key);
      return { status: 'postponed', fireAtIso: fireAt };
    }
    db.prepare(`INSERT INTO admission_debounce_state (key, trigger_id, latest_event_json, fire_at) VALUES (?,?,?,?)`)
      .run(key, triggerId, JSON.stringify(event), fireAt);
    return { status: 'scheduled', fireAtIso: fireAt };
  }

  function dueEntries() {
    return db.prepare(`SELECT * FROM admission_debounce_state WHERE fire_at <= datetime('now')`).all();
  }

  function clear(key) {
    db.prepare('DELETE FROM admission_debounce_state WHERE key = ?').run(key);
  }

  return { arrive, dueEntries, clear };
}

module.exports = { createDebouncer };
```

Run tests → PASS. Commit: `feat(admission): debouncer with replace-latest + sliding window`.

---

## Task 2: Throttle

- [ ] **Step 1: Tests**

Create `server/tests/throttle.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createThrottle } = require('../admission/throttle');

describe('throttle', () => {
  let db, t;
  beforeEach(() => { db = setupTestDb(); t = createThrottle({ db }); });

  it('allows first request when counter empty', () => {
    const r = t.tryAdmit({ triggerId: 't1', key: 'k', max: 3, windowMs: 1000 });
    expect(r.admitted).toBe(true);
  });

  it('rejects once max is reached', () => {
    t.tryAdmit({ triggerId: 't1', key: 'k', max: 2, windowMs: 1000 });
    t.tryAdmit({ triggerId: 't1', key: 'k', max: 2, windowMs: 1000 });
    const r = t.tryAdmit({ triggerId: 't1', key: 'k', max: 2, windowMs: 1000 });
    expect(r.admitted).toBe(false);
    expect(r.retry_after_ms).toBeGreaterThan(0);
  });

  it('resets counter when window elapses', () => {
    t.tryAdmit({ triggerId: 't1', key: 'k', max: 1, windowMs: 50 });
    const blocked = t.tryAdmit({ triggerId: 't1', key: 'k', max: 1, windowMs: 50 });
    expect(blocked.admitted).toBe(false);
    // Simulate window passing
    db.prepare(`UPDATE admission_throttle_counters SET window_start_at = datetime('now','-10 seconds') WHERE key = ?`).run('k');
    const allowed = t.tryAdmit({ triggerId: 't1', key: 'k', max: 1, windowMs: 50 });
    expect(allowed.admitted).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/admission/throttle.js`:

```js
'use strict';

function createThrottle({ db }) {
  function tryAdmit({ triggerId, key, max, windowMs }) {
    const row = db.prepare('SELECT * FROM admission_throttle_counters WHERE key = ?').get(key);
    const now = Date.now();
    if (!row) {
      db.prepare(`INSERT INTO admission_throttle_counters (key, trigger_id, window_start_at, count) VALUES (?,?,?,1)`)
        .run(key, triggerId, new Date(now).toISOString());
      return { admitted: true };
    }
    const windowStart = new Date(row.window_start_at).getTime();
    if (now - windowStart > windowMs) {
      db.prepare(`UPDATE admission_throttle_counters SET window_start_at = ?, count = 1 WHERE key = ?`)
        .run(new Date(now).toISOString(), key);
      return { admitted: true };
    }
    if (row.count < max) {
      db.prepare('UPDATE admission_throttle_counters SET count = count + 1 WHERE key = ?').run(key);
      return { admitted: true };
    }
    return { admitted: false, retry_after_ms: Math.max(0, windowMs - (now - windowStart)) };
  }

  return { tryAdmit };
}

module.exports = { createThrottle };
```

Run tests → PASS. Commit: `feat(admission): throttle with rolling-window counters`.

---

## Task 3: Admission controller + MCP surface

- [ ] **Step 1: Controller tests**

Create `server/tests/admission-controller.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createAdmissionController } = require('../admission/admission-controller');

describe('admissionController.admit', () => {
  let db, ctrl, enqueueMock;
  beforeEach(() => {
    db = setupTestDb();
    enqueueMock = vi.fn(async (workflowId, params) => ({ workflow_run_id: 'wr_test' }));
    ctrl = createAdmissionController({ db, enqueueWorkflowRun: enqueueMock });
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','created')`).run();
  });

  it('trigger without debounce/throttle enqueues immediately', async () => {
    db.prepare(`INSERT INTO workflow_triggers (trigger_id, workflow_id, name) VALUES ('t1','wf-1','plain')`).run();
    const r = await ctrl.admit({ triggerId: 't1', event: {} });
    expect(r.status).toBe('admitted');
    expect(enqueueMock).toHaveBeenCalled();
  });

  it('trigger with debounce schedules fire, does not enqueue immediately', async () => {
    db.prepare(`INSERT INTO workflow_triggers (trigger_id, workflow_id, name, debounce_key_template, debounce_window_ms)
                VALUES ('t1','wf-1','db','repo:{{event.repo}}', 500)`).run();
    const r = await ctrl.admit({ triggerId: 't1', event: { repo: 'acme' } });
    expect(r.status).toBe('debounced');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('trigger with throttle rejects once max is reached', async () => {
    db.prepare(`INSERT INTO workflow_triggers (trigger_id, workflow_id, name, throttle_max_per_window, throttle_window_ms, throttle_key_template)
                VALUES ('t1','wf-1','th', 1, 1000, 'global')`).run();
    const a = await ctrl.admit({ triggerId: 't1', event: {} });
    const b = await ctrl.admit({ triggerId: 't1', event: {} });
    expect(a.status).toBe('admitted');
    expect(b.status).toBe('throttled');
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/admission/admission-controller.js`:

```js
'use strict';
const { createDebouncer } = require('./debounce');
const { createThrottle } = require('./throttle');

function renderTemplate(tpl, event) {
  if (!tpl) return null;
  return tpl.replace(/\{\{event\.(\w+)\}\}/g, (_, k) => String(event?.[k] ?? ''));
}

function createAdmissionController({ db, enqueueWorkflowRun, logger = console }) {
  const debouncer = createDebouncer({ db });
  const throttle = createThrottle({ db });

  function loadTrigger(triggerId) {
    return db.prepare('SELECT * FROM workflow_triggers WHERE trigger_id = ? AND enabled = 1').get(triggerId);
  }

  async function admit({ triggerId, event }) {
    const trig = loadTrigger(triggerId);
    if (!trig) return { status: 'unknown_trigger' };

    // Throttle check first — if exceeded, drop without scheduling
    if (trig.throttle_max_per_window && trig.throttle_window_ms) {
      const key = renderTemplate(trig.throttle_key_template, event) || `trigger:${triggerId}`;
      const r = throttle.tryAdmit({
        triggerId, key, max: trig.throttle_max_per_window, windowMs: trig.throttle_window_ms,
      });
      if (!r.admitted) return { status: 'throttled', retry_after_ms: r.retry_after_ms };
    }

    if (trig.debounce_window_ms && trig.debounce_key_template) {
      const key = renderTemplate(trig.debounce_key_template, event);
      const r = debouncer.arrive({ triggerId, key, windowMs: trig.debounce_window_ms, event });
      return { status: 'debounced', debounce_status: r.status, fire_at: r.fireAtIso };
    }

    const enqueued = await enqueueWorkflowRun(trig.workflow_id, { event, triggered_by: `trigger:${triggerId}` });
    return { status: 'admitted', workflow_run_id: enqueued.workflow_run_id };
  }

  async function flushDueDebounces() {
    const due = debouncer.dueEntries();
    for (const row of due) {
      const trig = loadTrigger(row.trigger_id);
      if (!trig) { debouncer.clear(row.key); continue; }
      await enqueueWorkflowRun(trig.workflow_id, {
        event: JSON.parse(row.latest_event_json),
        triggered_by: `debounced:${row.trigger_id}`,
      });
      debouncer.clear(row.key);
    }
    return due.length;
  }

  return { admit, flushDueDebounces };
}

module.exports = { createAdmissionController };
```

Run tests → PASS. Commit: `feat(admission): unified controller over triggers with debounce + throttle`.

---

## Task 4: MCP tools + scheduler wiring

- [ ] **Step 1: MCP**

In `server/tool-defs/`:

```js
create_trigger: {
  description: 'Create a unified workflow trigger. Supports cron, event match, debounce, throttle — in any combination.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id', 'name'],
    properties: {
      workflow_id: { type: 'string' },
      deployment_id: { type: 'string' },
      name: { type: 'string' },
      cron_schedule: { type: 'string' },
      event_match: { type: 'object' },
      debounce_key_template: { type: 'string' },
      debounce_window_ms: { type: 'integer' },
      throttle_max_per_window: { type: 'integer' },
      throttle_window_ms: { type: 'integer' },
      throttle_key_template: { type: 'string' },
    },
  },
},
```

- [ ] **Step 2: Scheduler tick runs debounce flusher**

In `server/scheduling/scheduler.js`:

```js
const ctrl = defaultContainer.get('admissionController');
setInterval(() => ctrl.flushDueDebounces().catch(err => logger.warn('flush failed', err)), 500);
```

- [ ] **Step 3: Cron triggers + event bus route through admission**

For cron triggers, scheduler tick calls `ctrl.admit({triggerId, event: { kind: 'cron', fired_at }})` when cron matches.

Event bus: when an event arrives, iterate triggers with `event_match_json` and call `ctrl.admit()` on matches.

Commit: `feat(admission): wire scheduler + event bus through admission controller`.
