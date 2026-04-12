# Fabro #38: Project Domains — First-Class Tenant Boundary (Cadence)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Promote `project` from a free-form string scattered across tasks/workflows/schedules into a first-class **domain** object that owns retention policy, default provider/routing, MCP exposure, archival rules, and (in the future) regional placement. Inspired by Cadence domains.

**Architecture:** A new `domains` table replaces the current ad-hoc project-name pattern. Each task, workflow, and schedule references a `domain_id`. Domain settings include `retention_days`, `default_provider`, `default_routing_template`, `archival_uri`, `tags_allow_list`, `concurrency_limit`, `description`. A migration backfills existing rows by creating a domain per distinct project name. A new admin REST + dashboard surface lets operators inspect and edit domain settings.

**Tech Stack:** Node.js, better-sqlite3. Builds on Plan 33 (concurrency keys), Plan 36 (deployments/work-pools).

---

## File Structure

**New files:**
- `server/migrations/0NN-domains.sql` (table)
- `server/migrations/0NN-domains-backfill.sql` (data migration)
- `server/domains/domain-store.js`
- `server/tests/domain-store.test.js`
- `server/tests/domains-backfill.test.js`
- `dashboard/src/views/Domains.jsx`

**Modified files:**
- `server/handlers/task/submit.js` — accept `domain_id` (or fall back to project name lookup)
- `server/handlers/workflow/index.js`
- `server/scheduling/scheduler.js` — same
- `server/api/routes/admin.js` — `/api/admin/domains/*`
- `server/maintenance/retention-cleanup.js` — apply retention_days

---

## Task 1: Migration + backfill

- [ ] **Step 1: Schema migration**

`server/migrations/0NN-domains.sql`:

```sql
CREATE TABLE IF NOT EXISTS domains (
  domain_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  retention_days INTEGER NOT NULL DEFAULT 30,
  default_provider TEXT,
  default_routing_template TEXT,
  archival_uri TEXT,
  concurrency_limit INTEGER,
  tags_allow_list_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks      ADD COLUMN domain_id TEXT REFERENCES domains(domain_id);
ALTER TABLE workflows  ADD COLUMN domain_id TEXT REFERENCES domains(domain_id);
ALTER TABLE schedules  ADD COLUMN domain_id TEXT REFERENCES domains(domain_id);

CREATE INDEX IF NOT EXISTS idx_tasks_domain      ON tasks(domain_id);
CREATE INDEX IF NOT EXISTS idx_workflows_domain  ON workflows(domain_id);
CREATE INDEX IF NOT EXISTS idx_schedules_domain  ON schedules(domain_id);
```

- [ ] **Step 2: Backfill**

`server/migrations/0NN-domains-backfill.sql`:

```sql
-- Create a domain row per distinct project name in tasks/workflows/schedules
INSERT OR IGNORE INTO domains (domain_id, name)
SELECT 'dom_' || lower(hex(randomblob(6))), DISTINCT project
FROM tasks WHERE project IS NOT NULL AND project != '';

INSERT OR IGNORE INTO domains (domain_id, name)
SELECT 'dom_' || lower(hex(randomblob(6))), DISTINCT project
FROM workflows WHERE project IS NOT NULL AND project != '';

UPDATE tasks SET domain_id = (SELECT domain_id FROM domains WHERE name = tasks.project) WHERE domain_id IS NULL AND project IS NOT NULL;
UPDATE workflows SET domain_id = (SELECT domain_id FROM domains WHERE name = workflows.project) WHERE domain_id IS NULL AND project IS NOT NULL;
UPDATE schedules SET domain_id = (SELECT domain_id FROM domains WHERE name = schedules.project) WHERE domain_id IS NULL AND project IS NOT NULL;
```

(Adjust column names if the existing schema uses `project_name` or similar.)

- [ ] **Step 3: Backfill test**

Create `server/tests/domains-backfill.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { setupTestDb, runMigration } = require('./helpers/test-db');

describe('domains backfill migration', () => {
  it('creates one domain per distinct project name', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO tasks (task_id, project, status) VALUES ('t1','alpha','completed'),('t2','alpha','completed'),('t3','beta','completed')`).run();

    runMigration(db, 'domains');
    runMigration(db, 'domains-backfill');

    const domains = db.prepare('SELECT name FROM domains ORDER BY name').all();
    expect(domains.map(d => d.name)).toEqual(['alpha', 'beta']);
  });

  it('backfills domain_id on existing tasks', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO tasks (task_id, project, status) VALUES ('t1','alpha','completed')`).run();
    runMigration(db, 'domains');
    runMigration(db, 'domains-backfill');
    const t = db.prepare('SELECT domain_id FROM tasks WHERE task_id = ?').get('t1');
    expect(t.domain_id).toMatch(/^dom_/);
  });
});
```

Run tests → PASS. Commit: `feat(domains): table + backfill from existing project names`.

---

## Task 2: Domain store

- [ ] **Step 1: Tests**

Create `server/tests/domain-store.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createDomainStore } = require('../domains/domain-store');

describe('domainStore', () => {
  let db, store;
  beforeEach(() => {
    db = setupTestDb();
    store = createDomainStore({ db });
  });

  it('create returns id and stores name', () => {
    const id = store.create({ name: 'acme', description: 'Acme Corp' });
    expect(id).toMatch(/^dom_/);
    const got = store.get(id);
    expect(got.name).toBe('acme');
  });

  it('getByName resolves a domain by its unique name', () => {
    store.create({ name: 'beta' });
    const d = store.getByName('beta');
    expect(d).not.toBeNull();
    expect(d.name).toBe('beta');
  });

  it('update only allows whitelisted fields', () => {
    const id = store.create({ name: 'gamma' });
    store.update(id, { retention_days: 90, default_provider: 'codex' });
    const got = store.get(id);
    expect(got.retention_days).toBe(90);
    expect(got.default_provider).toBe('codex');
  });

  it('list returns enabled domains by default', () => {
    store.create({ name: 'a' });
    const id = store.create({ name: 'b' });
    store.setEnabled(id, false);
    expect(store.list().map(d => d.name)).toEqual(['a']);
    expect(store.list({ includeDisabled: true }).map(d => d.name).sort()).toEqual(['a','b']);
  });

  it('listExpiredItems returns ids of items past retention', () => {
    const id = store.create({ name: 'a', retentionDays: 1 });
    db.prepare(`INSERT INTO tasks (task_id, domain_id, status, created_at) VALUES ('t1', ?, 'completed', datetime('now', '-7 days'))`).run(id);
    db.prepare(`INSERT INTO tasks (task_id, domain_id, status, created_at) VALUES ('t2', ?, 'completed', datetime('now'))`).run(id);
    const expired = store.listExpiredItems();
    expect(expired.tasks).toContain('t1');
    expect(expired.tasks).not.toContain('t2');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/domains/domain-store.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

const ALLOWED_UPDATE_FIELDS = new Set([
  'description', 'retention_days', 'default_provider', 'default_routing_template',
  'archival_uri', 'concurrency_limit', 'tags_allow_list_json',
]);

function createDomainStore({ db }) {
  function create({ name, description = null, retentionDays = 30, defaultProvider = null,
                    defaultRoutingTemplate = null, archivalUri = null, concurrencyLimit = null }) {
    const id = `dom_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO domains (domain_id, name, description, retention_days, default_provider,
        default_routing_template, archival_uri, concurrency_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description, retentionDays, defaultProvider, defaultRoutingTemplate, archivalUri, concurrencyLimit);
    return id;
  }

  function get(id) { return db.prepare('SELECT * FROM domains WHERE domain_id = ?').get(id) || null; }
  function getByName(name) { return db.prepare('SELECT * FROM domains WHERE name = ?').get(name) || null; }

  function list({ includeDisabled = false } = {}) {
    const sql = `SELECT * FROM domains ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY name`;
    return db.prepare(sql).all();
  }

  function update(id, fields) {
    const updates = Object.entries(fields).filter(([k]) => ALLOWED_UPDATE_FIELDS.has(k));
    if (updates.length === 0) return;
    const sql = `UPDATE domains SET ${updates.map(([k]) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE domain_id = ?`;
    db.prepare(sql).run(...updates.map(([, v]) => v), id);
  }

  function setEnabled(id, enabled) {
    db.prepare(`UPDATE domains SET enabled = ?, updated_at = datetime('now') WHERE domain_id = ?`).run(enabled ? 1 : 0, id);
  }

  function listExpiredItems() {
    const tasks = db.prepare(`
      SELECT t.task_id FROM tasks t
      JOIN domains d ON t.domain_id = d.domain_id
      WHERE t.status IN ('completed', 'failed', 'cancelled')
        AND (julianday('now') - julianday(t.created_at)) > d.retention_days
    `).all().map(r => r.task_id);

    const workflows = db.prepare(`
      SELECT w.workflow_id FROM workflows w
      JOIN domains d ON w.domain_id = d.domain_id
      WHERE w.status IN ('completed', 'failed', 'cancelled')
        AND (julianday('now') - julianday(w.created_at)) > d.retention_days
    `).all().map(r => r.workflow_id);

    return { tasks, workflows };
  }

  return { create, get, getByName, list, update, setEnabled, listExpiredItems };
}

module.exports = { createDomainStore };
```

Run tests → PASS. Commit: `feat(domains): domain store with retention awareness`.

---

## Task 3: Wire submission to resolve domain

- [ ] **Step 1: submitTask resolves project → domain_id**

In `server/handlers/task/submit.js`:

```js
const store = defaultContainer.get('domainStore');
let domainId = params.domain_id;
if (!domainId && params.project) {
  let dom = store.getByName(params.project);
  if (!dom) {
    domainId = store.create({ name: params.project });
  } else {
    domainId = dom.domain_id;
    // Apply domain defaults if caller didn't override
    if (!params.provider && dom.default_provider) params.provider = dom.default_provider;
    if (!params.routing_template && dom.default_routing_template) params.routing_template = dom.default_routing_template;
  }
}
db.prepare('UPDATE tasks SET domain_id = ? WHERE task_id = ?').run(domainId || null, taskId);
```

Mirror this in workflow + schedule submission.

- [ ] **Step 2: Container**

```js
container.factory('domainStore', (c) => require('./domains/domain-store').createDomainStore({ db: c.get('db') }));
```

Commit: `feat(domains): submission resolves domain + applies defaults`.

---

## Task 4: Retention cleanup + REST + dashboard

- [ ] **Step 1: Retention sweep**

In `server/maintenance/retention-cleanup.js` (new file):

```js
'use strict';

function startRetentionSweep({ defaultContainer, intervalMs = 6 * 60 * 60 * 1000, logger = console }) {
  function tick() {
    const store = defaultContainer.get('domainStore');
    const db = defaultContainer.get('db');
    const expired = store.listExpiredItems();

    if (expired.tasks.length > 0) {
      const placeholders = expired.tasks.map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks WHERE task_id IN (${placeholders})`).run(...expired.tasks);
      logger.info('retention swept tasks', { count: expired.tasks.length });
    }
    if (expired.workflows.length > 0) {
      const placeholders = expired.workflows.map(() => '?').join(',');
      db.prepare(`DELETE FROM workflows WHERE workflow_id IN (${placeholders})`).run(...expired.workflows);
      logger.info('retention swept workflows', { count: expired.workflows.length });
    }
  }

  tick(); // initial run
  return setInterval(tick, intervalMs);
}

module.exports = { startRetentionSweep };
```

Wire into `server/index.js`:

```js
const { startRetentionSweep } = require('./maintenance/retention-cleanup');
startRetentionSweep({ defaultContainer, logger });
```

- [ ] **Step 2: REST**

In `server/api/routes/admin.js`:

```js
router.get('/domains', (req, res) => {
  res.json({ domains: defaultContainer.get('domainStore').list({ includeDisabled: true }) });
});

router.post('/domains', express.json(), (req, res) => {
  const { name, description, retention_days, default_provider } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = defaultContainer.get('domainStore').create({
    name, description, retentionDays: retention_days, defaultProvider: default_provider,
  });
  res.json({ domain_id: id });
});

router.patch('/domains/:id', express.json(), (req, res) => {
  defaultContainer.get('domainStore').update(req.params.id, req.body || {});
  res.json({ ok: true });
});
```

- [ ] **Step 3: Dashboard view**

Create `dashboard/src/views/Domains.jsx` showing one row per domain with editable retention + provider defaults, item counts, and "Disable" toggle.

`await_restart`. Smoke: open `/admin/domains`, change retention to 7 days for an old project, wait one sweep cycle, confirm 30+ day-old completed tasks are deleted.

Commit: `feat(domains): retention sweep + admin REST + dashboard`.
