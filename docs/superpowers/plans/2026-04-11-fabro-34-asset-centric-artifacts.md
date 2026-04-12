# Fabro #34: Asset-Centric Artifact Model (Dagster)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make code patches, test results, docs, telemetry bundles, and release artifacts first-class **assets** with explicit identity, lineage, and quality checks — so downstream tasks declare which assets they depend on (not which tasks they wait on), and operators can ask "what produced this artifact and is it fresh?". Inspired by Dagster.

**Architecture:** A new `assets` table records each declared asset by `asset_key` (e.g., `code:server/app.js`, `test:server/tests/app.test.js`, `bundle:release-2026-04-12`). A new `asset_materializations` table records each time a task produces or refreshes an asset, with `task_id`, `produced_at`, and content hash. A new `asset_checks` table records per-asset quality checks (`check_name`, `passed`, `metadata`). Workflow tasks declare `produces: [asset_key, ...]` and `consumes: [asset_key, ...]`. Downstream task dispatch waits for upstream materializations rather than upstream task statuses, so partial recomputes only refresh the affected slice of the asset graph.

**Tech Stack:** Node.js, better-sqlite3. Builds on plans 14 (events), 27 (state), 29 (journal).

---

## File Structure

**New files:**
- `server/migrations/0NN-assets.sql`
- `server/assets/asset-store.js`
- `server/assets/asset-graph.js` — produces/consumes resolution
- `server/assets/asset-checks.js`
- `server/tests/asset-store.test.js`
- `server/tests/asset-graph.test.js`
- `dashboard/src/views/AssetGraph.jsx`
- `server/api/routes/assets.js`

**Modified files:**
- `server/handlers/workflow/index.js` — accept `produces`/`consumes` per task
- `server/tool-defs/workflow-defs.js`
- `server/execution/dependency-resolver.js` — wait on materializations
- `server/execution/task-finalizer.js` — record materialization on success

---

## Task 1: Migration + asset store

- [ ] **Step 1: Migration**

`server/migrations/0NN-assets.sql`:

```sql
CREATE TABLE IF NOT EXISTS assets (
  asset_key TEXT PRIMARY KEY,         -- e.g., 'code:server/app.js'
  description TEXT,
  kind TEXT,                          -- 'code' | 'test' | 'docs' | 'bundle' | 'report'
  partition_key TEXT,                 -- optional (Plan 35 uses this)
  metadata_json TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_materializations (
  materialization_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL,
  task_id TEXT,
  workflow_id TEXT,
  content_hash TEXT,
  metadata_json TEXT,
  produced_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_materializations_asset_time ON asset_materializations(asset_key, produced_at);

CREATE TABLE IF NOT EXISTS asset_checks (
  check_id TEXT PRIMARY KEY,
  asset_key TEXT NOT NULL,
  check_name TEXT NOT NULL,
  passed INTEGER NOT NULL,            -- 0 | 1
  severity TEXT,                      -- 'error' | 'warn' | 'info'
  task_id TEXT,
  metadata_json TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_checks_asset_time ON asset_checks(asset_key, checked_at);

CREATE TABLE IF NOT EXISTS asset_dependencies (
  asset_key TEXT NOT NULL,
  depends_on_asset_key TEXT NOT NULL,
  PRIMARY KEY (asset_key, depends_on_asset_key)
);
```

- [ ] **Step 2: Tests**

Create `server/tests/asset-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createAssetStore } = require('../assets/asset-store');

describe('assetStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    store = createAssetStore({ db });
  });

  it('declareAsset is idempotent', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE asset_key = ?').get('code:foo.js').n).toBe(1);
  });

  it('recordMaterialization stores task + hash and is queryable as latest', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't1', contentHash: 'abc' });
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't2', contentHash: 'def' });

    const latest = store.getLatestMaterialization('code:foo.js');
    expect(latest.task_id).toBe('t2');
    expect(latest.content_hash).toBe('def');
  });

  it('isFresh returns true if materialized after a given timestamp', () => {
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    const before = new Date().toISOString();
    store.recordMaterialization({ assetKey: 'code:foo.js', taskId: 't1' });
    expect(store.isFresh('code:foo.js', before)).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(store.isFresh('code:foo.js', future)).toBe(false);
  });

  it('declareDependency records edges in asset_dependencies', () => {
    store.declareAsset({ assetKey: 'test:foo.test.js', kind: 'test' });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
    store.declareDependency('test:foo.test.js', 'code:foo.js');
    const upstream = store.getUpstream('test:foo.test.js');
    expect(upstream).toEqual(['code:foo.js']);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/assets/asset-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createAssetStore({ db }) {
  function declareAsset({ assetKey, kind = null, description = null, partitionKey = null, metadata = null }) {
    db.prepare(`
      INSERT INTO assets (asset_key, kind, description, partition_key, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_key) DO UPDATE SET
        kind = COALESCE(excluded.kind, kind),
        description = COALESCE(excluded.description, description),
        partition_key = COALESCE(excluded.partition_key, partition_key),
        metadata_json = COALESCE(excluded.metadata_json, metadata_json)
    `).run(assetKey, kind, description, partitionKey, metadata ? JSON.stringify(metadata) : null);
  }

  function recordMaterialization({ assetKey, taskId = null, workflowId = null, contentHash = null, metadata = null }) {
    declareAsset({ assetKey });
    const id = `mat_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO asset_materializations (materialization_id, asset_key, task_id, workflow_id, content_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, assetKey, taskId, workflowId, contentHash, metadata ? JSON.stringify(metadata) : null);
    return id;
  }

  function getLatestMaterialization(assetKey) {
    return db.prepare(`
      SELECT * FROM asset_materializations WHERE asset_key = ?
      ORDER BY produced_at DESC LIMIT 1
    `).get(assetKey);
  }

  function isFresh(assetKey, sinceIso) {
    const row = db.prepare(`
      SELECT 1 FROM asset_materializations WHERE asset_key = ? AND produced_at > ? LIMIT 1
    `).get(assetKey, sinceIso);
    return !!row;
  }

  function declareDependency(assetKey, dependsOnAssetKey) {
    db.prepare(`INSERT OR IGNORE INTO asset_dependencies (asset_key, depends_on_asset_key) VALUES (?, ?)`)
      .run(assetKey, dependsOnAssetKey);
  }

  function getUpstream(assetKey) {
    return db.prepare(`SELECT depends_on_asset_key FROM asset_dependencies WHERE asset_key = ?`)
      .all(assetKey).map(r => r.depends_on_asset_key);
  }

  function getDownstream(assetKey) {
    return db.prepare(`SELECT asset_key FROM asset_dependencies WHERE depends_on_asset_key = ?`)
      .all(assetKey).map(r => r.asset_key);
  }

  return {
    declareAsset, recordMaterialization, getLatestMaterialization,
    isFresh, declareDependency, getUpstream, getDownstream,
  };
}

module.exports = { createAssetStore };
```

Run tests → PASS. Commit: `feat(assets): asset/materialization store`.

---

## Task 2: Asset checks

- [ ] **Step 1: Tests**

Create `server/tests/asset-graph.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createAssetStore } = require('../assets/asset-store');
const { createAssetChecks } = require('../assets/asset-checks');

describe('assetChecks', () => {
  let db, store, checks;
  beforeEach(() => {
    db = setupTestDb();
    store = createAssetStore({ db });
    checks = createAssetChecks({ db });
    store.declareAsset({ assetKey: 'code:foo.js', kind: 'code' });
  });

  it('record stores a check verdict', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true, severity: 'error' });
    const latest = checks.latestForAsset('code:foo.js');
    expect(latest.lint.passed).toBe(true);
  });

  it('latestForAsset returns most recent of each check_name', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: false });
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true });
    checks.record({ assetKey: 'code:foo.js', checkName: 'tsc', passed: true });
    const latest = checks.latestForAsset('code:foo.js');
    expect(latest.lint.passed).toBe(true);
    expect(latest.tsc.passed).toBe(true);
  });

  it('isHealthy returns false when any error-severity check fails', () => {
    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: false, severity: 'error' });
    expect(checks.isHealthy('code:foo.js')).toBe(false);

    checks.record({ assetKey: 'code:foo.js', checkName: 'lint', passed: true, severity: 'error' });
    checks.record({ assetKey: 'code:foo.js', checkName: 'cosmetic', passed: false, severity: 'warn' });
    expect(checks.isHealthy('code:foo.js')).toBe(true); // warn-only failure doesn't fail health
  });
});
```

- [ ] **Step 2: Implement**

Create `server/assets/asset-checks.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createAssetChecks({ db }) {
  function record({ assetKey, checkName, passed, severity = 'error', taskId = null, metadata = null }) {
    const id = `chk_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO asset_checks (check_id, asset_key, check_name, passed, severity, task_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, assetKey, checkName, passed ? 1 : 0, severity, taskId, metadata ? JSON.stringify(metadata) : null);
    return id;
  }

  function latestForAsset(assetKey) {
    const rows = db.prepare(`
      SELECT a.* FROM asset_checks a
      INNER JOIN (
        SELECT check_name, MAX(checked_at) AS max_at FROM asset_checks WHERE asset_key = ? GROUP BY check_name
      ) m ON a.check_name = m.check_name AND a.checked_at = m.max_at
      WHERE a.asset_key = ?
    `).all(assetKey, assetKey);
    const map = {};
    for (const r of rows) {
      map[r.check_name] = { passed: !!r.passed, severity: r.severity, checked_at: r.checked_at, metadata: r.metadata_json && JSON.parse(r.metadata_json) };
    }
    return map;
  }

  function isHealthy(assetKey) {
    const latest = latestForAsset(assetKey);
    for (const c of Object.values(latest)) {
      if (!c.passed && c.severity === 'error') return false;
    }
    return true;
  }

  return { record, latestForAsset, isHealthy };
}

module.exports = { createAssetChecks };
```

Run tests → PASS. Commit: `feat(assets): asset checks with severity-aware health`.

---

## Task 3: produces/consumes on workflow tasks

- [ ] **Step 1: Tool def**

In `server/tool-defs/workflow-defs.js` task fields:

```js
produces: { type: 'array', items: { type: 'string' }, description: 'Asset keys this task materializes on success.' },
consumes: { type: 'array', items: { type: 'string' }, description: 'Asset keys this task depends on. Replaces or augments depends_on (task-id) edges.' },
```

- [ ] **Step 2: Workflow handler stores them**

In `buildWorkflowTaskMetadata`:

```js
if (Array.isArray(taskLike.produces)) metaObj.produces = taskLike.produces;
if (Array.isArray(taskLike.consumes)) metaObj.consumes = taskLike.consumes;
```

After workflow creation, declare assets and dependencies:

```js
const store = defaultContainer.get('assetStore');
for (const t of params.tasks) {
  for (const a of (t.produces || [])) store.declareAsset({ assetKey: a });
  for (const a of (t.consumes || [])) store.declareAsset({ assetKey: a });
  for (const downstream of (t.produces || [])) {
    for (const upstream of (t.consumes || [])) {
      store.declareDependency(downstream, upstream);
    }
  }
}
```

- [ ] **Step 3: Dependency resolver waits on materializations**

In `server/execution/dependency-resolver.js` — when checking if a task is ready:

```js
const meta = parseTaskMetadata(task);
const consumes = Array.isArray(meta.consumes) ? meta.consumes : [];
if (consumes.length > 0) {
  const store = defaultContainer.get('assetStore');
  const workflowStartedAt = workflow.created_at;
  for (const upstream of consumes) {
    if (!store.isFresh(upstream, workflowStartedAt)) {
      return false; // upstream asset hasn't been materialized in this workflow
    }
  }
}
return true; // all upstream assets fresh OR no asset deps declared
```

- [ ] **Step 4: Finalizer records materializations**

In `server/execution/task-finalizer.js` on success:

```js
const meta = parseTaskMetadata(task);
const produces = Array.isArray(meta.produces) ? meta.produces : [];
const store = defaultContainer.get('assetStore');
for (const a of produces) {
  store.recordMaterialization({
    assetKey: a, taskId, workflowId: task.workflow_id,
    contentHash: hashOutput(finalOutput),
  });
}
```

- [ ] **Step 5: Container**

```js
container.factory('assetStore', (c) => require('./assets/asset-store').createAssetStore({ db: c.get('db') }));
container.factory('assetChecks', (c) => require('./assets/asset-checks').createAssetChecks({ db: c.get('db') }));
```

Commit: `feat(assets): workflows declare produces/consumes, dispatch waits on materializations`.

---

## Task 4: REST + dashboard graph

- [ ] **Step 1: REST**

Create `server/api/routes/assets.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.get('/', (req, res) => {
  const rows = defaultContainer.get('db').prepare('SELECT * FROM assets ORDER BY asset_key').all();
  res.json({ assets: rows });
});

router.get('/:key', (req, res) => {
  const store = defaultContainer.get('assetStore');
  const checks = defaultContainer.get('assetChecks');
  const key = decodeURIComponent(req.params.key);
  const asset = defaultContainer.get('db').prepare('SELECT * FROM assets WHERE asset_key = ?').get(key);
  if (!asset) return res.status(404).json({ error: 'unknown asset' });
  res.json({
    asset,
    latest_materialization: store.getLatestMaterialization(key),
    upstream: store.getUpstream(key),
    downstream: store.getDownstream(key),
    checks: checks.latestForAsset(key),
    healthy: checks.isHealthy(key),
  });
});

router.get('/:key/materializations', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const rows = defaultContainer.get('db').prepare(`
    SELECT * FROM asset_materializations WHERE asset_key = ? ORDER BY produced_at DESC LIMIT 100
  `).all(key);
  res.json({ asset_key: key, materializations: rows });
});

module.exports = router;
```

- [ ] **Step 2: Dashboard view**

Create `dashboard/src/views/AssetGraph.jsx`:

```jsx
import { useEffect, useState } from 'react';

export default function AssetGraph() {
  const [assets, setAssets] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/assets').then(r => r.json()).then(d => setAssets(d.assets));
  }, []);

  const filtered = filter ? assets.filter(a => a.asset_key.includes(filter)) : assets;

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-2">Assets ({assets.length})</h2>
      <input
        placeholder="filter by asset_key"
        value={filter} onChange={e => setFilter(e.target.value)}
        className="border rounded px-2 py-1 mb-3 w-full max-w-md"
      />
      <table className="w-full text-sm">
        <thead className="bg-gray-100"><tr>
          <th className="text-left px-2 py-1">key</th>
          <th className="text-left px-2 py-1">kind</th>
          <th className="text-left px-2 py-1">partition</th>
          <th className="text-left px-2 py-1">registered</th>
        </tr></thead>
        <tbody>
          {filtered.map(a => (
            <tr key={a.asset_key} className="border-t">
              <td className="px-2 py-1 font-mono"><a href={`/assets/${encodeURIComponent(a.asset_key)}`} className="text-blue-600 hover:underline">{a.asset_key}</a></td>
              <td className="px-2 py-1">{a.kind || '-'}</td>
              <td className="px-2 py-1">{a.partition_key || '-'}</td>
              <td className="px-2 py-1 text-xs text-gray-500">{a.registered_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`await_restart`. Smoke: create a workflow with `produces: ['code:foo.js']` on task A and `consumes: ['code:foo.js']` on task B. Run it, then `GET /api/assets/code:foo.js` and confirm latest_materialization points to task A.

Commit: `feat(assets): REST + dashboard list/detail`.
