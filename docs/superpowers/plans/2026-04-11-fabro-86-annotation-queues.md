# Fabro #86: Annotation Queues (LangSmith)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add **human annotation queues** on top of Plan 68 observability: operators see a queue of task/trace records filtered by rubric or failure class, apply rubric-driven scores + comments + corrections, and either resolve or promote items to a dataset (Plan 68). Supports reviewer assignment, reservations (prevent double-review), and pairwise A/B comparison. Inspired by LangSmith.

**Architecture:** A new `annotation_queues` table defines a queue with `name`, `filter_json`, `rubric_json`. An `annotation_queue_items` table rows reference a subject (task/trace/experiment-row) and carry `reviewer_id`, `status` (pending/reserved/completed), `reservation_expires_at`. Dashboard view shows next-item-for-reviewer with a keyboard-driven rubric form. Submissions flow back into Plan 68 `scores` + an optional "promote to dataset" action.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 38 (domains), 68 (observability scores + datasets).

---

## File Structure

**New files:**
- `server/migrations/0NN-annotation-queues.sql`
- `server/annotation/queue-store.js`
- `server/annotation/reservation-manager.js`
- `server/annotation/pairwise.js`
- `server/tests/queue-store.test.js`
- `server/tests/reservation-manager.test.js`
- `dashboard/src/views/AnnotationQueue.jsx`
- `dashboard/src/components/RubricForm.jsx`

**Modified files:**
- `server/handlers/mcp-tools.js` — `create_queue`, `next_item`, `submit_annotation`, `promote_to_dataset`

---

## Task 1: Migration + queue store

- [ ] **Step 1: Migration**

`server/migrations/0NN-annotation-queues.sql`:

```sql
CREATE TABLE IF NOT EXISTS annotation_queues (
  queue_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rubric_json TEXT NOT NULL,
  filter_json TEXT,
  domain_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS annotation_queue_items (
  item_id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,          -- 'task' | 'trace' | 'experiment_row'
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'reserved' | 'completed' | 'skipped'
  reviewer_id TEXT,
  reservation_expires_at TEXT,
  response_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (queue_id) REFERENCES annotation_queues(queue_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_items_status ON annotation_queue_items(queue_id, status);
```

- [ ] **Step 2: Tests**

Create `server/tests/queue-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createQueueStore } = require('../annotation/queue-store');

describe('queueStore', () => {
  let db, store;
  beforeEach(() => { db = setupTestDb(); store = createQueueStore({ db }); });

  it('create + enqueue + nextPending', () => {
    const qid = store.create({ name: 'failed-verify', rubric: { criteria: ['correctness', 'helpfulness'] } });
    const iid = store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    const next = store.nextPending({ queueId: qid });
    expect(next.item_id).toBe(iid);
    expect(next.subject_type).toBe('task');
  });

  it('dedup enqueue by (queue, subject) returns existing item', () => {
    const qid = store.create({ name: 'q', rubric: {} });
    const a = store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    const b = store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    expect(a).toBe(b);
  });

  it('completeItem stores response + timestamps', () => {
    const qid = store.create({ name: 'q', rubric: {} });
    const iid = store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    store.completeItem(iid, { scores: { correctness: 0.9 }, comment: 'good' });
    const row = store.get(iid);
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.response_json).scores.correctness).toBe(0.9);
  });

  it('stats returns counts per status', () => {
    const qid = store.create({ name: 'q', rubric: {} });
    store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    const i2 = store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't2' });
    store.completeItem(i2, { scores: {} });
    const s = store.stats(qid);
    expect(s.pending).toBe(1);
    expect(s.completed).toBe(1);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/annotation/queue-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createQueueStore({ db }) {
  function create({ name, rubric, filter = null, description = null, domainId = null }) {
    const id = `queue_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO annotation_queues (queue_id, name, description, rubric_json, filter_json, domain_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description, JSON.stringify(rubric), filter && JSON.stringify(filter), domainId);
    return id;
  }

  function enqueue({ queueId, subjectType, subjectId }) {
    const existing = db.prepare(`SELECT item_id FROM annotation_queue_items WHERE queue_id = ? AND subject_type = ? AND subject_id = ?`)
      .get(queueId, subjectType, subjectId);
    if (existing) return existing.item_id;
    const id = `item_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO annotation_queue_items (item_id, queue_id, subject_type, subject_id) VALUES (?, ?, ?, ?)`)
      .run(id, queueId, subjectType, subjectId);
    return id;
  }

  function get(itemId) {
    return db.prepare('SELECT * FROM annotation_queue_items WHERE item_id = ?').get(itemId);
  }

  function nextPending({ queueId, reviewerId = null }) {
    return db.prepare(`
      SELECT * FROM annotation_queue_items
      WHERE queue_id = ? AND status = 'pending'
      ORDER BY created_at ASC LIMIT 1
    `).get(queueId) || null;
  }

  function completeItem(itemId, response) {
    db.prepare(`
      UPDATE annotation_queue_items SET status = 'completed', response_json = ?, completed_at = datetime('now')
      WHERE item_id = ?
    `).run(JSON.stringify(response), itemId);
  }

  function skipItem(itemId, reason = null) {
    db.prepare(`UPDATE annotation_queue_items SET status = 'skipped', response_json = ?, completed_at = datetime('now') WHERE item_id = ?`)
      .run(JSON.stringify({ skipped_reason: reason }), itemId);
  }

  function stats(queueId) {
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM annotation_queue_items WHERE queue_id = ? GROUP BY status`).all(queueId);
    const out = { pending: 0, reserved: 0, completed: 0, skipped: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  return { create, enqueue, get, nextPending, completeItem, skipItem, stats };
}

module.exports = { createQueueStore };
```

Run tests → PASS. Commit: `feat(annotation): queue store with enqueue/next/complete/stats`.

---

## Task 2: Reservation manager (prevent double-review)

- [ ] **Step 1: Tests**

Create `server/tests/reservation-manager.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createQueueStore } = require('../annotation/queue-store');
const { createReservationManager } = require('../annotation/reservation-manager');

describe('reservationManager', () => {
  let db, store, mgr, qid;
  beforeEach(() => {
    db = setupTestDb();
    store = createQueueStore({ db });
    mgr = createReservationManager({ db, ttlMs: 10 * 60 * 1000 });
    qid = store.create({ name: 'q', rubric: {} });
    store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't1' });
    store.enqueue({ queueId: qid, subjectType: 'task', subjectId: 't2' });
  });

  it('reserveNext picks a pending item + marks reserved', () => {
    const r = mgr.reserveNext({ queueId: qid, reviewerId: 'alice' });
    expect(r.subject_id).toBe('t1');
    expect(r.status).toBe('reserved');
    expect(r.reviewer_id).toBe('alice');
  });

  it('two reviewers cannot reserve the same item', () => {
    const a = mgr.reserveNext({ queueId: qid, reviewerId: 'alice' });
    const b = mgr.reserveNext({ queueId: qid, reviewerId: 'bob' });
    expect(a.subject_id).not.toBe(b.subject_id);
  });

  it('release returns an item to pending', () => {
    const r = mgr.reserveNext({ queueId: qid, reviewerId: 'alice' });
    mgr.release(r.item_id);
    const row = db.prepare('SELECT status FROM annotation_queue_items WHERE item_id = ?').get(r.item_id);
    expect(row.status).toBe('pending');
  });

  it('sweepExpired releases reservations past their TTL', () => {
    const r = mgr.reserveNext({ queueId: qid, reviewerId: 'alice' });
    // Force expiry
    db.prepare(`UPDATE annotation_queue_items SET reservation_expires_at = datetime('now', '-1 minute') WHERE item_id = ?`).run(r.item_id);
    const freed = mgr.sweepExpired();
    expect(freed).toContain(r.item_id);
    expect(db.prepare('SELECT status FROM annotation_queue_items WHERE item_id = ?').get(r.item_id).status).toBe('pending');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/annotation/reservation-manager.js`:

```js
'use strict';

function createReservationManager({ db, ttlMs = 10 * 60 * 1000 }) {
  function reserveNext({ queueId, reviewerId }) {
    // Atomic claim: pick the oldest pending row, set status=reserved in a transaction
    const tx = db.transaction(() => {
      const row = db.prepare(`
        SELECT item_id FROM annotation_queue_items
        WHERE queue_id = ? AND status = 'pending'
        ORDER BY created_at ASC LIMIT 1
      `).get(queueId);
      if (!row) return null;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      db.prepare(`UPDATE annotation_queue_items SET status = 'reserved', reviewer_id = ?, reservation_expires_at = ? WHERE item_id = ?`)
        .run(reviewerId, expiresAt, row.item_id);
      return db.prepare('SELECT * FROM annotation_queue_items WHERE item_id = ?').get(row.item_id);
    });
    return tx();
  }

  function release(itemId) {
    db.prepare(`UPDATE annotation_queue_items SET status = 'pending', reviewer_id = NULL, reservation_expires_at = NULL WHERE item_id = ?`)
      .run(itemId);
  }

  function sweepExpired() {
    const rows = db.prepare(`
      SELECT item_id FROM annotation_queue_items
      WHERE status = 'reserved' AND reservation_expires_at <= datetime('now')
    `).all();
    for (const r of rows) release(r.item_id);
    return rows.map(r => r.item_id);
  }

  return { reserveNext, release, sweepExpired };
}

module.exports = { createReservationManager };
```

Run tests → PASS. Commit: `feat(annotation): reservation manager with TTL + sweep`.

---

## Task 3: MCP + dashboard + promote-to-dataset

- [ ] **Step 1: MCP tools**

```js
create_queue: { description: 'Create a new annotation queue with a rubric.', inputSchema: {...} },
next_item: { description: 'Reserve the next pending item for a reviewer.', inputSchema: { type: 'object', required: ['queue_id', 'reviewer_id'], properties: { queue_id: { type: 'string' }, reviewer_id: { type: 'string' } } } },
submit_annotation: {
  description: 'Submit rubric response for a reserved item. Also writes scores into Plan 68 score store.',
  inputSchema: { type: 'object', required: ['item_id', 'response'], properties: { item_id: { type: 'string' }, response: { type: 'object' } } },
},
promote_to_dataset: {
  description: 'Promote an annotated item into a dataset (with the operator\'s correction as expected output).',
  inputSchema: { type: 'object', required: ['item_id', 'dataset_id'], properties: { item_id: { type: 'string' }, dataset_id: { type: 'string' }, corrected_output: {} } },
},
queue_stats: { description: 'Return counts per status for a queue.', inputSchema: { type: 'object', required: ['queue_id'], properties: { queue_id: { type: 'string' } } } },
```

Handler for `submit_annotation` writes each rubric field as a separate Plan 68 score:

```js
case 'submit_annotation': {
  const store = defaultContainer.get('queueStore');
  const scoreStore = defaultContainer.get('scoreStore');
  const item = store.get(args.item_id);
  if (!item) return { ok: false, error: 'unknown item' };
  store.completeItem(args.item_id, args.response);
  for (const [name, value] of Object.entries(args.response.scores || {})) {
    if (typeof value === 'number') {
      scoreStore.record({
        subjectType: item.subject_type, subjectId: item.subject_id,
        name, value, source: 'human',
        metadata: { queue_id: item.queue_id, reviewer_id: item.reviewer_id, comment: args.response.comment },
      });
    }
  }
  return { ok: true };
}
```

- [ ] **Step 2: Dashboard**

Create `dashboard/src/views/AnnotationQueue.jsx`:
- Queue selector
- Reviewer identity (from current user)
- "Claim next" button → calls `next_item` → renders subject context + `RubricForm`
- Keyboard shortcuts: `1-9` to score current rubric field, `Enter` to submit, `S` to skip

`RubricForm.jsx` renders inputs based on the queue's rubric schema (radio buttons for categorical, slider for 0-1, textarea for comments, "Corrected output" editor for promotion).

- [ ] **Step 3: Periodic reservation sweep**

In `server/maintenance/orphan-cleanup.js`:

```js
const resMgr = defaultContainer.get('reservationManager');
setInterval(() => resMgr.sweepExpired(), 60 * 1000);
```

`await_restart`. Smoke: create a queue filtered on `failure_class='verify_failed'`, enqueue 5 failing tasks, claim + annotate 2. Confirm scores appear in Plan 68 store with `source='human'`. Test reservation: two reviewers in parallel — each gets a different item.

Commit: `feat(annotation): MCP + dashboard + promote-to-dataset + reservation sweep`.
