# Fabro #40: Detached Child Workflows + Parent-Close Policies (Cadence)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `parent_close_policy` to child workflow spawns: `WAIT` (default, parent waits), `ABANDON` (child runs independently after parent ends), `REQUEST_CANCEL` (parent end requests child cancel), `TERMINATE` (parent end forcibly stops child). Lets a workflow kick off long-lived watchers, remediation loops, or human-follow-ups that should outlive — or be cleaned up with — the parent. Inspired by Cadence.

**Architecture:** Builds on Plan 22 (sub-workflows). Adds `parent_close_policy` and `child_workflow_id` columns to the `workflow_links` table. When the parent transitions to a terminal state, a `parent-close-handler.js` reads each child link and applies the configured policy. ABANDON children become detached top-level workflows (parent_workflow_id is cleared in the child's status). TERMINATE / REQUEST_CANCEL invoke the existing cancel API.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 14 (events), 22 (sub-workflows).

---

## File Structure

**New files:**
- `server/migrations/0NN-parent-close-policy.sql`
- `server/workflows/parent-close-handler.js`
- `server/tests/parent-close-handler.test.js`

**Modified files:**
- `server/handlers/workflow/spawn-child.js` — accept `parent_close_policy`
- `server/tool-defs/workflow-defs.js`
- `server/execution/workflow-finalizer.js` — call parent-close-handler when workflow ends
- `dashboard/src/views/WorkflowDetail.jsx` — show child policies

---

## Task 1: Migration + policy module

- [ ] **Step 1: Migration**

`server/migrations/0NN-parent-close-policy.sql`:

```sql
ALTER TABLE workflow_links ADD COLUMN parent_close_policy TEXT NOT NULL DEFAULT 'WAIT';
-- Existing schema assumes workflow_links exists; if not, create it now:
CREATE TABLE IF NOT EXISTS workflow_links (
  link_id TEXT PRIMARY KEY,
  parent_workflow_id TEXT NOT NULL,
  child_workflow_id TEXT NOT NULL,
  parent_close_policy TEXT NOT NULL DEFAULT 'WAIT',
  spawned_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (child_workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_links_parent ON workflow_links(parent_workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_links_child  ON workflow_links(child_workflow_id);
```

- [ ] **Step 2: Tests**

Create `server/tests/parent-close-handler.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createParentCloseHandler } = require('../workflows/parent-close-handler');

function seedParentChild(db, parentId, childId, policy) {
  db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES (?, ?, ?)`).run(parentId, 'p', 'completed');
  db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES (?, ?, ?)`).run(childId, 'c', 'running');
  db.prepare(`INSERT INTO workflow_links (link_id, parent_workflow_id, child_workflow_id, parent_close_policy)
              VALUES (?, ?, ?, ?)`).run(`lnk_${parentId}_${childId}`, parentId, childId, policy);
}

describe('parentCloseHandler', () => {
  let db, handler, cancelMock;
  beforeEach(() => {
    db = setupTestDb();
    cancelMock = vi.fn(async () => ({ ok: true }));
    handler = createParentCloseHandler({ db, cancelWorkflow: cancelMock });
  });

  it('WAIT policy is a no-op (caller already waited)', async () => {
    seedParentChild(db, 'p1', 'c1', 'WAIT');
    const r = await handler.handleParentClose('p1');
    expect(cancelMock).not.toHaveBeenCalled();
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].action).toBe('none');
  });

  it('ABANDON detaches the child (clears parent link)', async () => {
    seedParentChild(db, 'p1', 'c1', 'ABANDON');
    const r = await handler.handleParentClose('p1');
    expect(cancelMock).not.toHaveBeenCalled();
    expect(r.actions[0].action).toBe('detached');
    const link = db.prepare(`SELECT * FROM workflow_links WHERE child_workflow_id = ?`).get('c1');
    expect(link).toBeUndefined(); // link removed
  });

  it('REQUEST_CANCEL invokes cancel with graceful=true', async () => {
    seedParentChild(db, 'p1', 'c1', 'REQUEST_CANCEL');
    await handler.handleParentClose('p1');
    expect(cancelMock).toHaveBeenCalledWith('c1', { graceful: true });
  });

  it('TERMINATE invokes cancel with graceful=false', async () => {
    seedParentChild(db, 'p1', 'c1', 'TERMINATE');
    await handler.handleParentClose('p1');
    expect(cancelMock).toHaveBeenCalledWith('c1', { graceful: false });
  });

  it('skips children that are already in terminal state', async () => {
    seedParentChild(db, 'p1', 'c1', 'TERMINATE');
    db.prepare('UPDATE workflows SET status = ? WHERE workflow_id = ?').run('completed', 'c1');
    const r = await handler.handleParentClose('p1');
    expect(cancelMock).not.toHaveBeenCalled();
    expect(r.actions[0].action).toBe('skipped_terminal');
  });

  it('handles multiple children with mixed policies', async () => {
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('p1','p','completed')`).run();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('c1','c','running'),('c2','c','running'),('c3','c','running')`).run();
    db.prepare(`INSERT INTO workflow_links (link_id, parent_workflow_id, child_workflow_id, parent_close_policy)
      VALUES ('l1','p1','c1','ABANDON'),('l2','p1','c2','TERMINATE'),('l3','p1','c3','WAIT')`).run();

    const r = await handler.handleParentClose('p1');
    expect(r.actions).toHaveLength(3);
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledWith('c2', { graceful: false });
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workflows/parent-close-handler.js`:

```js
'use strict';

const POLICIES = new Set(['WAIT', 'ABANDON', 'REQUEST_CANCEL', 'TERMINATE']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function createParentCloseHandler({ db, cancelWorkflow, logger = console }) {
  async function handleParentClose(parentWorkflowId) {
    const links = db.prepare(`
      SELECT wl.link_id, wl.child_workflow_id, wl.parent_close_policy, w.status AS child_status
      FROM workflow_links wl
      JOIN workflows w ON w.workflow_id = wl.child_workflow_id
      WHERE wl.parent_workflow_id = ?
    `).all(parentWorkflowId);

    const actions = [];
    for (const link of links) {
      const policy = POLICIES.has(link.parent_close_policy) ? link.parent_close_policy : 'WAIT';
      if (TERMINAL_STATUSES.has(link.child_status)) {
        actions.push({ child_workflow_id: link.child_workflow_id, action: 'skipped_terminal', policy });
        continue;
      }
      switch (policy) {
        case 'WAIT':
          actions.push({ child_workflow_id: link.child_workflow_id, action: 'none', policy });
          break;
        case 'ABANDON':
          db.prepare(`DELETE FROM workflow_links WHERE link_id = ?`).run(link.link_id);
          actions.push({ child_workflow_id: link.child_workflow_id, action: 'detached', policy });
          logger.info('child workflow detached', { parentWorkflowId, childId: link.child_workflow_id });
          break;
        case 'REQUEST_CANCEL':
          await cancelWorkflow(link.child_workflow_id, { graceful: true });
          actions.push({ child_workflow_id: link.child_workflow_id, action: 'cancel_requested', policy });
          break;
        case 'TERMINATE':
          await cancelWorkflow(link.child_workflow_id, { graceful: false });
          actions.push({ child_workflow_id: link.child_workflow_id, action: 'terminated', policy });
          break;
      }
    }
    return { parent_workflow_id: parentWorkflowId, actions };
  }

  return { handleParentClose };
}

module.exports = { createParentCloseHandler, POLICIES };
```

Run tests → PASS. Commit: `feat(workflows): parent-close-handler with WAIT/ABANDON/REQUEST_CANCEL/TERMINATE`.

---

## Task 2: Wire spawn + finalizer

- [ ] **Step 1: Tool def field**

In `server/tool-defs/workflow-defs.js` for the spawn-child tool:

```js
parent_close_policy: {
  type: 'string',
  enum: ['WAIT', 'ABANDON', 'REQUEST_CANCEL', 'TERMINATE'],
  default: 'WAIT',
  description: 'How to handle this child when its parent workflow ends. WAIT (default) blocks parent until child completes. ABANDON detaches it. REQUEST_CANCEL/TERMINATE stop the child.',
},
```

- [ ] **Step 2: Spawn handler stores policy**

In `server/handlers/workflow/spawn-child.js` after creating the link row:

```js
const policy = params.parent_close_policy || 'WAIT';
db.prepare(`UPDATE workflow_links SET parent_close_policy = ? WHERE link_id = ?`).run(policy, linkId);
```

- [ ] **Step 3: Workflow finalizer triggers handler**

In `server/execution/workflow-finalizer.js` when the workflow transitions to terminal:

```js
const handler = defaultContainer.get('parentCloseHandler');
const result = await handler.handleParentClose(workflowId);
logger.info('parent close handled', { workflowId, actionCount: result.actions.length });
```

- [ ] **Step 4: Container**

```js
container.factory('parentCloseHandler', (c) => {
  const { createParentCloseHandler } = require('./workflows/parent-close-handler');
  return createParentCloseHandler({
    db: c.get('db'),
    cancelWorkflow: (id, opts) => c.get('workflowCanceller').cancel(id, opts),
    logger: c.get('logger'),
  });
});
```

Commit: `feat(workflows): parent-close-handler invoked from finalizer`.

---

## Task 3: Dashboard surface + REST

- [ ] **Step 1: REST**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/children', (req, res) => {
  const links = defaultContainer.get('db').prepare(`
    SELECT wl.child_workflow_id, wl.parent_close_policy, wl.spawned_at, w.status, w.name
    FROM workflow_links wl
    JOIN workflows w ON w.workflow_id = wl.child_workflow_id
    WHERE wl.parent_workflow_id = ?
    ORDER BY wl.spawned_at DESC
  `).all(req.params.id);
  res.json({ parent: req.params.id, children: links });
});
```

- [ ] **Step 2: Dashboard child list**

In `dashboard/src/views/WorkflowDetail.jsx` add a "Children" panel:

```jsx
{children.map(c => (
  <tr key={c.child_workflow_id}>
    <td><Link to={`/workflows/${c.child_workflow_id}`}>{c.name}</Link></td>
    <td>{c.status}</td>
    <td><span className={policyBadgeClass(c.parent_close_policy)}>{c.parent_close_policy}</span></td>
    <td>{c.spawned_at}</td>
  </tr>
))}
```

`await_restart`. Smoke: spawn a long-running child with `parent_close_policy: 'ABANDON'`, complete the parent. Confirm child keeps running and shows up in `GET /api/workflows` with `parent_workflow_id` cleared from its link table.

Commit: `feat(workflows): REST + dashboard for child policies`.

---

## Task 4: Docs

- [ ] **Step 1: Add policy guide**

Create `docs/parent-close-policies.md`:

````markdown
# Parent-Close Policies

When a workflow spawns a child workflow, you choose what happens to that child if the parent ends before the child does.

| Policy | Behavior | Use when |
|--------|----------|----------|
| `WAIT` (default) | Parent stays in `running` until child completes | Child is on the critical path |
| `ABANDON` | Child becomes a top-level workflow when parent ends | Long-lived watcher, post-merge follow-ups, async cleanup |
| `REQUEST_CANCEL` | Parent end calls cancel(graceful=true) on the child | Best-effort linked work, child can stop cleanly |
| `TERMINATE` | Parent end calls cancel(graceful=false) on the child | Hard tie — parent failure must immediately stop the child |

## Example

```js
spawn_child_workflow({
  parent_workflow_id: "wf-1",
  workflow_template: "release-publish",
  parent_close_policy: "ABANDON"   // continue publishing even if parent factory shuts down
});
```
````

`await_restart`. Smoke: end-to-end test with each of the 4 policies. Confirm child status and link-table state matches docs.

Commit: `docs(workflows): parent-close-policy guide`.
