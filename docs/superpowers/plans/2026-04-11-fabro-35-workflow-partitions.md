# Fabro #35: Partition-Aware Workflows (Dagster)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a workflow declare `partitions: ['repo:foo', 'repo:bar', 'repo:baz']` and materialize one or many partitions independently — so a "run tests for changed packages" workflow can reprocess only the partitions affected, with proper per-partition status tracking. Inspired by Dagster.

**Architecture:** Builds on Plan 34 (assets). Adds `workflow_partitions` table that records per-partition execution rows. A workflow can be materialized for a `partition_key` parameter; tasks within get the partition_key as a runtime variable (`$partition`) and produce/consume partitioned assets like `code:repo:foo/server.js` instead of `code:server.js`. A new MCP tool `materialize_partitions` triggers N parallel partition runs with a single call. Backfill UI in dashboard surfaces "which partitions are stale" and one-click backfill.

**Tech Stack:** Node.js, better-sqlite3, React. Builds on plans 27 (state), 34 (assets).

---

## File Structure

**New files:**
- `server/migrations/0NN-workflow-partitions.sql`
- `server/partitions/partition-runner.js` — orchestrates per-partition runs
- `server/partitions/partition-set.js` — static / dynamic key resolution
- `server/tests/partition-runner.test.js`
- `server/tests/partition-set.test.js`
- `dashboard/src/views/Backfill.jsx`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `partitions` config + `partition_key`
- `server/tool-defs/workflow-defs.js`
- `server/handlers/mcp-tools.js` — `materialize_partitions` tool
- `server/execution/task-startup.js` — `$partition` interpolation

---

## Task 1: Migration + partition set

- [ ] **Step 1: Migration**

`server/migrations/0NN-workflow-partitions.sql`:

```sql
ALTER TABLE workflows ADD COLUMN partition_set_json TEXT;

CREATE TABLE IF NOT EXISTS workflow_partitions (
  partition_run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  triggered_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, partition_key, created_at)
);

CREATE INDEX IF NOT EXISTS idx_partitions_wf_status ON workflow_partitions(workflow_id, status);
```

- [ ] **Step 2: Tests for partition-set**

Create `server/tests/partition-set.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { resolvePartitionSet } = require('../partitions/partition-set');

describe('resolvePartitionSet', () => {
  it('static array returns as-is', async () => {
    const keys = await resolvePartitionSet({ kind: 'static', keys: ['a', 'b', 'c'] });
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('dynamic from glob expands matching paths', async () => {
    const keys = await resolvePartitionSet({
      kind: 'glob', pattern: 'docs/scouting/*.md', cwd: process.cwd(),
    });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(k => k.endsWith('.md'))).toBe(true);
  });

  it('time_window generates daily keys', async () => {
    const keys = await resolvePartitionSet({
      kind: 'time_window', cadence: 'daily',
      start: '2026-04-01', end: '2026-04-03',
    });
    expect(keys).toEqual(['2026-04-01', '2026-04-02', '2026-04-03']);
  });

  it('throws on unknown kind', async () => {
    await expect(resolvePartitionSet({ kind: 'bogus' })).rejects.toThrow(/unknown partition/i);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/partitions/partition-set.js`:

```js
'use strict';
const fg = require('fast-glob');

async function resolvePartitionSet(spec) {
  if (!spec || !spec.kind) throw new Error('partition set requires kind');
  switch (spec.kind) {
    case 'static':
      return spec.keys || [];
    case 'glob': {
      const matches = await fg(spec.pattern, { cwd: spec.cwd || process.cwd() });
      return matches;
    }
    case 'time_window':
      return generateTimeKeys(spec);
    default:
      throw new Error(`Unknown partition set kind: ${spec.kind}`);
  }
}

function generateTimeKeys({ cadence = 'daily', start, end }) {
  const out = [];
  const startD = new Date(start);
  const endD = new Date(end);
  const cur = new Date(startD);
  const incrementDays = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 1;
  while (cur <= endD) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + incrementDays);
  }
  return out;
}

module.exports = { resolvePartitionSet };
```

Run tests → PASS. Commit: `feat(partitions): partition set resolution (static/glob/time_window)`.

---

## Task 2: Partition runner

- [ ] **Step 1: Tests**

Create `server/tests/partition-runner.test.js`:

```js
'use strict';
const { describe, it, expect, vi, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createPartitionRunner } = require('../partitions/partition-runner');

describe('partitionRunner', () => {
  let db, runner, runWorkflow;
  beforeEach(() => {
    db = setupTestDb();
    db.prepare(`INSERT INTO workflows (workflow_id, name, status, partition_set_json) VALUES (?,?,?,?)`)
      .run('wf-1', 't', 'created', JSON.stringify({ kind: 'static', keys: ['a','b','c'] }));
    runWorkflow = vi.fn(async ({ partitionKey }) => ({ ok: true, partition: partitionKey }));
    runner = createPartitionRunner({ db, runWorkflow });
  });

  it('materializeAll spawns one run per partition key', async () => {
    const result = await runner.materializeAll('wf-1', { triggeredBy: 'test' });
    expect(runWorkflow).toHaveBeenCalledTimes(3);
    expect(result.partitions).toEqual(['a','b','c']);
    const runs = db.prepare('SELECT partition_key, status FROM workflow_partitions WHERE workflow_id = ?').all('wf-1');
    expect(runs.length).toBe(3);
  });

  it('materialize accepts a single key', async () => {
    await runner.materialize('wf-1', 'b', { triggeredBy: 'test' });
    expect(runWorkflow).toHaveBeenCalledOnce();
    expect(runWorkflow).toHaveBeenCalledWith(expect.objectContaining({ partitionKey: 'b' }));
  });

  it('records started_at and completed_at on success', async () => {
    await runner.materialize('wf-1', 'a', { triggeredBy: 'test' });
    const row = db.prepare('SELECT started_at, completed_at, status FROM workflow_partitions WHERE workflow_id = ? AND partition_key = ?').get('wf-1','a');
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(row.status).toBe('completed');
  });

  it('records failure when runWorkflow throws', async () => {
    const failing = vi.fn(async () => { throw new Error('bad'); });
    const r = createPartitionRunner({ db, runWorkflow: failing });
    await expect(r.materialize('wf-1', 'a', { triggeredBy: 't' })).rejects.toThrow();
    const row = db.prepare('SELECT status FROM workflow_partitions WHERE workflow_id = ? AND partition_key = ?').get('wf-1','a');
    expect(row.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/partitions/partition-runner.js`:

```js
'use strict';
const { randomUUID } = require('crypto');
const { resolvePartitionSet } = require('./partition-set');

function createPartitionRunner({ db, runWorkflow }) {
  function getPartitionSet(workflowId) {
    const row = db.prepare('SELECT partition_set_json FROM workflows WHERE workflow_id = ?').get(workflowId);
    if (!row || !row.partition_set_json) throw new Error(`Workflow ${workflowId} has no partition set`);
    return JSON.parse(row.partition_set_json);
  }

  async function materialize(workflowId, partitionKey, { triggeredBy = null } = {}) {
    const id = `pr_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO workflow_partitions (partition_run_id, workflow_id, partition_key, status, triggered_by, started_at)
      VALUES (?, ?, ?, 'running', ?, datetime('now'))
    `).run(id, workflowId, partitionKey, triggeredBy);
    try {
      const result = await runWorkflow({ workflowId, partitionKey, partitionRunId: id });
      db.prepare(`UPDATE workflow_partitions SET status = 'completed', completed_at = datetime('now') WHERE partition_run_id = ?`).run(id);
      return { partition_run_id: id, partition_key: partitionKey, result };
    } catch (err) {
      db.prepare(`UPDATE workflow_partitions SET status = 'failed', completed_at = datetime('now') WHERE partition_run_id = ?`).run(id);
      throw err;
    }
  }

  async function materializeAll(workflowId, opts) {
    const spec = getPartitionSet(workflowId);
    const keys = await resolvePartitionSet(spec);
    const results = [];
    for (const k of keys) {
      try { results.push(await materialize(workflowId, k, opts)); }
      catch (e) { results.push({ partition_key: k, error: e.message }); }
    }
    return { workflow_id: workflowId, partitions: keys, results };
  }

  function listStale(workflowId) {
    return db.prepare(`
      SELECT partition_key, status, completed_at FROM workflow_partitions
      WHERE workflow_id = ? AND status IN ('failed','pending')
      ORDER BY created_at DESC
    `).all(workflowId);
  }

  return { materialize, materializeAll, listStale };
}

module.exports = { createPartitionRunner };
```

Run tests → PASS. Commit: `feat(partitions): partition runner with per-partition tracking`.

---

## Task 3: $partition interpolation + workflow accepts partition_set

- [ ] **Step 1: Tool def**

In `server/tool-defs/workflow-defs.js`:

```js
partition_set: {
  type: 'object',
  description: 'Partition set definition. Allows materialization of N independent runs of this workflow.',
  properties: {
    kind: { type: 'string', enum: ['static', 'glob', 'time_window'] },
    keys: { type: 'array', items: { type: 'string' } },
    pattern: { type: 'string' },
    cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    start: { type: 'string' },
    end: { type: 'string' },
  },
},
```

- [ ] **Step 2: Workflow handler stores it**

```js
if (params.partition_set) {
  db.prepare('UPDATE workflows SET partition_set_json = ? WHERE workflow_id = ?')
    .run(JSON.stringify(params.partition_set), workflowId);
}
```

- [ ] **Step 3: $partition in task prompt**

In `server/execution/task-startup.js`:

```js
// If task is part of a partition run, inject it
const partitionRunId = task.metadata && JSON.parse(task.metadata)?.partition_run_id;
if (partitionRunId) {
  const row = db.prepare('SELECT partition_key FROM workflow_partitions WHERE partition_run_id = ?').get(partitionRunId);
  if (row) {
    task.task_description = task.task_description.replace(/\$partition/g, row.partition_key);
  }
}
```

- [ ] **Step 4: MCP tool**

In `server/tool-defs/workflow-defs.js`:

```js
materialize_partitions: {
  description: 'Materialize one or all partitions of a partitioned workflow. Each partition becomes a separate workflow run.',
  inputSchema: {
    type: 'object',
    required: ['workflow_id'],
    properties: {
      workflow_id: { type: 'string' },
      partition_keys: { type: 'array', items: { type: 'string' }, description: 'Specific keys to materialize. Omit to materialize all.' },
    },
  },
},
```

In `server/handlers/mcp-tools.js`:

```js
case 'materialize_partitions': {
  const runner = defaultContainer.get('partitionRunner');
  if (Array.isArray(args.partition_keys) && args.partition_keys.length > 0) {
    const results = [];
    for (const k of args.partition_keys) {
      try { results.push(await runner.materialize(args.workflow_id, k, { triggeredBy: 'mcp' })); }
      catch (e) { results.push({ partition_key: k, error: e.message }); }
    }
    return { workflow_id: args.workflow_id, results };
  }
  return await runner.materializeAll(args.workflow_id, { triggeredBy: 'mcp' });
}
```

- [ ] **Step 5: Container**

```js
container.factory('partitionRunner', (c) => {
  const { createPartitionRunner } = require('./partitions/partition-runner');
  // runWorkflow injected from existing workflow runner
  return createPartitionRunner({
    db: c.get('db'),
    runWorkflow: ({ workflowId, partitionKey, partitionRunId }) => {
      // Stamp partition_run_id into a fresh workflow run
      return c.get('workflowRunner').runOnce({ workflowId, partitionRunId, partitionKey });
    },
  });
});
```

`await_restart`. Smoke: create a workflow with `partition_set: { kind: 'static', keys: ['repo:a','repo:b'] }` and a task whose description mentions `$partition`. Call `materialize_partitions({workflow_id})`. Confirm two runs created, each with `$partition` substituted.

Commit: `feat(partitions): wire into workflow runtime, MCP tool, $partition interpolation`.

---

## Task 4: Backfill dashboard

- [ ] **Step 1: REST**

In `server/api/routes/workflows.js`:

```js
router.get('/:id/partitions', (req, res) => {
  const rows = defaultContainer.get('db').prepare(`
    SELECT partition_key, status, started_at, completed_at, partition_run_id
    FROM workflow_partitions WHERE workflow_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json({ workflow_id: req.params.id, partitions: rows });
});

router.post('/:id/backfill', express.json(), async (req, res) => {
  const runner = defaultContainer.get('partitionRunner');
  const keys = req.body?.partition_keys;
  try {
    const result = keys
      ? await Promise.all(keys.map(k => runner.materialize(req.params.id, k, { triggeredBy: 'backfill' })))
      : await runner.materializeAll(req.params.id, { triggeredBy: 'backfill' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Dashboard**

Create `dashboard/src/views/Backfill.jsx` with:
- Per-partition status grid (green/yellow/red)
- Multi-select + "Backfill selected"
- "Backfill all stale" button

`await_restart`. Smoke: kick off a partitioned workflow, intentionally fail one partition, click "Backfill failed". Confirm only the failed partitions re-run.

Commit: `feat(partitions): backfill REST + dashboard grid`.
