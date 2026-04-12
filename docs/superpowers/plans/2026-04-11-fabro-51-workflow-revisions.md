# Fabro #51: Workflow Revisions + Rollback (Kestra)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every change to a workflow definition creates a new **revision** — inspectable, diffable, and one-click rollback-able from the dashboard. Works even when flows are mutated from UI, API, CI/CD, or Terraform, and doesn't rely solely on Git. Inspired by Kestra.

**Architecture:** A new `workflow_revisions` table stores `(workflow_id, revision_number, yaml_source, author, created_at, activated_at, notes)`. Every `create_workflow` / `update_workflow` tool call stamps a new revision. A `POST /api/workflows/:id/rollback/:rev` endpoint switches the active revision back. A dashboard view shows side-by-side diff between any two revisions. The current definition is always `MAX(activated_at)` among revisions.

**Tech Stack:** Node.js, better-sqlite3, existing YAML serializer, `diff` npm package for rendering side-by-side. Builds on Plan 1 (workflow-as-code).

---

## File Structure

**New files:**
- `server/migrations/0NN-workflow-revisions.sql`
- `server/workflows/revision-store.js`
- `server/tests/revision-store.test.js`
- `dashboard/src/views/WorkflowRevisions.jsx`

**Modified files:**
- `server/handlers/workflow/index.js` — stamp a revision on create/update
- `server/api/routes/workflows.js` — `GET /:id/revisions`, `POST /:id/rollback/:rev`

---

## Task 1: Migration + store

- [ ] **Step 1: Migration**

`server/migrations/0NN-workflow-revisions.sql`:

```sql
CREATE TABLE IF NOT EXISTS workflow_revisions (
  workflow_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  yaml_source TEXT NOT NULL,
  spec_hash TEXT,
  author TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  PRIMARY KEY (workflow_id, revision_number),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revisions_active ON workflow_revisions(workflow_id, activated_at);
```

- [ ] **Step 2: Tests**

Create `server/tests/revision-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createRevisionStore } = require('../workflows/revision-store');

describe('revisionStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status) VALUES ('wf-1','t','created')`).run();
    store = createRevisionStore({ db });
  });

  it('record assigns incrementing revision numbers', () => {
    const r1 = store.record('wf-1', 'version1:', { author: 'a', notes: 'first' });
    const r2 = store.record('wf-1', 'version2:', { author: 'a', notes: 'second' });
    expect(r1.revision_number).toBe(1);
    expect(r2.revision_number).toBe(2);
  });

  it('record auto-activates the new revision', () => {
    store.record('wf-1', 'v1', {});
    store.record('wf-1', 'v2', {});
    const active = store.getActive('wf-1');
    expect(active.yaml_source).toBe('v2');
  });

  it('rollbackTo re-activates an older revision', () => {
    store.record('wf-1', 'v1', {});
    store.record('wf-1', 'v2', {});
    store.rollbackTo('wf-1', 1, { author: 'ops', notes: 'reverting' });
    const active = store.getActive('wf-1');
    expect(active.yaml_source).toBe('v1');
    // revision numbers continue monotonically (rollback creates a new revision pointing at old content)
    const all = store.list('wf-1');
    expect(all.length).toBe(3);
    expect(all[2].yaml_source).toBe('v1');
  });

  it('list returns all revisions ordered newest first', () => {
    store.record('wf-1', 'v1', {});
    store.record('wf-1', 'v2', {});
    const all = store.list('wf-1');
    expect(all.map(r => r.revision_number)).toEqual([2, 1]);
  });

  it('diff returns the text diff between two revisions', () => {
    store.record('wf-1', 'name: Alice\nrole: dev\n', {});
    store.record('wf-1', 'name: Alice\nrole: lead\n', {});
    const d = store.diff('wf-1', 1, 2);
    expect(d).toMatch(/-role: dev/);
    expect(d).toMatch(/\+role: lead/);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/workflows/revision-store.js`:

```js
'use strict';
const crypto = require('crypto');
const { createPatch } = require('diff');

function createRevisionStore({ db }) {
  function record(workflowId, yamlSource, { author = null, notes = null } = {}) {
    const next = (db.prepare(`SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM workflow_revisions WHERE workflow_id = ?`).get(workflowId)).n;
    const specHash = crypto.createHash('sha256').update(yamlSource).digest('hex').slice(0, 16);
    db.prepare(`
      INSERT INTO workflow_revisions (workflow_id, revision_number, yaml_source, spec_hash, author, notes, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(workflowId, next, yamlSource, specHash, author, notes);
    return { revision_number: next, spec_hash: specHash };
  }

  function getActive(workflowId) {
    return db.prepare(`
      SELECT * FROM workflow_revisions
      WHERE workflow_id = ? AND activated_at IS NOT NULL
      ORDER BY activated_at DESC LIMIT 1
    `).get(workflowId);
  }

  function get(workflowId, revisionNumber) {
    return db.prepare(`SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision_number = ?`).get(workflowId, revisionNumber);
  }

  function list(workflowId) {
    return db.prepare(`SELECT * FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision_number DESC`).all(workflowId);
  }

  function rollbackTo(workflowId, revisionNumber, { author = null, notes = null } = {}) {
    const target = get(workflowId, revisionNumber);
    if (!target) throw new Error(`Revision ${revisionNumber} not found for workflow ${workflowId}`);
    return record(workflowId, target.yaml_source, {
      author, notes: notes || `Rollback to revision ${revisionNumber}`,
    });
  }

  function diff(workflowId, revA, revB) {
    const a = get(workflowId, revA);
    const b = get(workflowId, revB);
    if (!a || !b) throw new Error('Revision(s) not found');
    return createPatch(`${workflowId}.yaml`, a.yaml_source, b.yaml_source, `rev${revA}`, `rev${revB}`);
  }

  return { record, getActive, get, list, rollbackTo, diff };
}

module.exports = { createRevisionStore };
```

Run tests → PASS. Commit: `feat(revisions): revision store with auto-activate + rollback-via-new-revision`.

---

## Task 2: Wire into workflow handler + REST

- [ ] **Step 1: Stamp on create/update**

In `server/handlers/workflow/index.js` at the end of `createWorkflow` and `updateWorkflow`:

```js
const rev = defaultContainer.get('revisionStore');
const yaml = yamlStringify(params); // existing helper
rev.record(workflowId, yaml, { author: ctx.user || 'system', notes: params.revision_notes });
```

- [ ] **Step 2: REST**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/revisions', (req, res) => {
  res.json({ revisions: defaultContainer.get('revisionStore').list(req.params.id) });
});

router.get('/:id/revisions/:rev', (req, res) => {
  const r = defaultContainer.get('revisionStore').get(req.params.id, parseInt(req.params.rev, 10));
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

router.get('/:id/revisions/:a/diff/:b', (req, res) => {
  try {
    const d = defaultContainer.get('revisionStore').diff(req.params.id, parseInt(req.params.a, 10), parseInt(req.params.b, 10));
    res.type('text/plain').send(d);
  } catch (err) { res.status(404).json({ error: err.message }); }
});

router.post('/:id/rollback/:rev', express.json(), (req, res) => {
  try {
    const r = defaultContainer.get('revisionStore').rollbackTo(req.params.id, parseInt(req.params.rev, 10), {
      author: req.body?.author, notes: req.body?.notes,
    });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

Commit: `feat(revisions): wire into workflow handler + REST endpoints`.

---

## Task 3: Dashboard — revisions list + diff view

- [ ] **Step 1: Dashboard view**

Create `dashboard/src/views/WorkflowRevisions.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowRevisions() {
  const { id } = useParams();
  const [revs, setRevs] = useState([]);
  const [compare, setCompare] = useState({ a: null, b: null });
  const [diff, setDiff] = useState(null);

  useEffect(() => {
    fetch(`/api/workflows/${id}/revisions`).then(r => r.json()).then(d => setRevs(d.revisions));
  }, [id]);

  async function runDiff() {
    if (!compare.a || !compare.b) return;
    const t = await fetch(`/api/workflows/${id}/revisions/${compare.a}/diff/${compare.b}`).then(r => r.text());
    setDiff(t);
  }

  async function rollback(rev) {
    if (!confirm(`Rollback workflow to revision ${rev}? (creates a new revision)`)) return;
    await fetch(`/api/workflows/${id}/rollback/${rev}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: `Rollback from dashboard` }),
    });
    location.reload();
  }

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-2">Revisions: {id}</h2>
      <table className="w-full text-sm mb-4">
        <thead className="bg-gray-100"><tr>
          <th className="text-left px-2 py-1">#</th>
          <th className="text-left px-2 py-1">author</th>
          <th className="text-left px-2 py-1">notes</th>
          <th className="text-left px-2 py-1">created</th>
          <th className="text-left px-2 py-1">active</th>
          <th className="text-left px-2 py-1">compare</th>
          <th className="text-left px-2 py-1">actions</th>
        </tr></thead>
        <tbody>
          {revs.map(r => (
            <tr key={r.revision_number} className="border-t">
              <td className="px-2 py-1">{r.revision_number}</td>
              <td className="px-2 py-1">{r.author || '-'}</td>
              <td className="px-2 py-1">{r.notes || '-'}</td>
              <td className="px-2 py-1 text-xs text-gray-500">{r.created_at}</td>
              <td className="px-2 py-1">{r.activated_at ? '✓' : ''}</td>
              <td className="px-2 py-1">
                <input type="radio" name="a" onChange={() => setCompare(s => ({...s, a: r.revision_number}))} /> A{' '}
                <input type="radio" name="b" onChange={() => setCompare(s => ({...s, b: r.revision_number}))} /> B
              </td>
              <td className="px-2 py-1">
                <button onClick={() => rollback(r.revision_number)} className="text-blue-600 hover:underline">Rollback</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={runDiff} className="px-3 py-1 bg-blue-600 text-white rounded mr-2">Diff A ↔ B</button>
      {diff && <pre className="bg-gray-900 text-gray-100 p-3 rounded text-xs mt-3 overflow-auto">{diff}</pre>}
    </div>
  );
}
```

`await_restart`. Smoke: edit a workflow 3 times, visit `/workflows/<id>/revisions`, compare rev 1 vs rev 3, click rollback to rev 1, confirm a new rev 4 appears that matches rev 1.

Commit: `feat(revisions): dashboard list + diff + rollback UI`.
