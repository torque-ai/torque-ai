# Software Factory Phase 1: Health Model + Project Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the quantitative foundation for the software factory — a per-project health model that continuously scores 10 dimensions, stores time-series snapshots, and surfaces results via MCP tools, REST API, and a dashboard radar chart.

**Architecture:** New DB module (`server/db/factory-health.js`) stores health snapshots as time-series rows. MCP tools expose `register_factory_project`, `project_health`, `scan_project_health`, and `list_factory_projects`. Dashboard gets a new "Factory" top-level route with a radar chart view.

**Tech Stack:** better-sqlite3 (existing), vitest (existing), React + SVG radar chart (dashboard), existing scout/scan_project infrastructure for data collection.

---

### Task 1: Database Migration — Factory Tables

**Files:**
- Modify: `server/db/migrations.js` (append migration version 13)

- [ ] **Step 1: Read the current migration file to find the last version number**

Run: `grep "version:" server/db/migrations.js | tail -3`
Note the highest version number. The new migration will be version N+1.

- [ ] **Step 2: Write the failing test**

Create `server/tests/factory-health-migration.test.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

describe('factory health migration', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  afterEach(() => {
    db.close();
  });

  test('creates factory_projects table', () => {
    runMigrations(db);
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_projects'").get();
    expect(info).toBeTruthy();
  });

  test('creates factory_health_snapshots table', () => {
    runMigrations(db);
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_health_snapshots'").get();
    expect(info).toBeTruthy();
  });

  test('creates factory_health_findings table', () => {
    runMigrations(db);
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_health_findings'").get();
    expect(info).toBeTruthy();
  });

  test('factory_projects has expected columns', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_projects')").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'name', 'path', 'brief', 'trust_level', 'status', 'created_at', 'updated_at'
    ]));
  });

  test('factory_health_snapshots has expected columns', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_health_snapshots')").all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project_id', 'dimension', 'score', 'scan_type', 'batch_id', 'scanned_at'
    ]));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/tests/factory-health-migration.test.js`
Expected: FAIL — tables don't exist yet.

- [ ] **Step 4: Add the migration to `server/db/migrations.js`**

Append to the MIGRATIONS array (use the next version number after the current max):

```js
{
  version: 13,
  name: 'add_factory_tables',
  up: [
    [
      'CREATE TABLE IF NOT EXISTS factory_projects (',
      '  id TEXT PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      '  path TEXT NOT NULL UNIQUE,',
      '  brief TEXT,',
      "  trust_level TEXT NOT NULL DEFAULT 'supervised',",
      "  status TEXT NOT NULL DEFAULT 'paused',",
      '  config_json TEXT,',
      "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
      "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
      ')',
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS factory_health_snapshots (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  project_id TEXT NOT NULL REFERENCES factory_projects(id),',
      '  dimension TEXT NOT NULL,',
      '  score REAL NOT NULL,',
      '  details_json TEXT,',
      "  scan_type TEXT NOT NULL DEFAULT 'incremental',",
      '  batch_id TEXT,',
      "  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))",
      ')',
    ].join('\n'),
    'CREATE INDEX IF NOT EXISTS idx_fhs_project_dim ON factory_health_snapshots(project_id, dimension, scanned_at)',
    'CREATE INDEX IF NOT EXISTS idx_fhs_project_time ON factory_health_snapshots(project_id, scanned_at)',
    [
      'CREATE TABLE IF NOT EXISTS factory_health_findings (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),',
      '  severity TEXT NOT NULL,',
      '  message TEXT NOT NULL,',
      '  file_path TEXT,',
      '  details_json TEXT',
      ')',
    ].join('\n'),
    'CREATE INDEX IF NOT EXISTS idx_fhf_snapshot ON factory_health_findings(snapshot_id)',
  ].join('; '),
  down: [
    'DROP TABLE IF EXISTS factory_health_findings',
    'DROP TABLE IF EXISTS factory_health_snapshots',
    'DROP TABLE IF EXISTS factory_projects',
  ].join('; '),
},
```

Also add the three new table names to `ALLOWED_MIGRATION_TABLES` in `server/database.js`:
`'factory_projects', 'factory_health_snapshots', 'factory_health_findings'`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/factory-health-migration.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add server/db/migrations.js server/database.js server/tests/factory-health-migration.test.js
git commit -m "feat(factory): add database tables for project registry and health snapshots"
```

---

### Task 2: Factory Health DB Module

**Files:**
- Create: `server/db/factory-health.js`
- Test: `server/tests/factory-health-db.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-health-db.test.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

let factoryHealth;

describe('factory-health db module', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    runMigrations(db);

    factoryHealth = require('../db/factory-health');
    factoryHealth.setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('registerProject', () => {
    test('creates a project and returns it', () => {
      const project = factoryHealth.registerProject({
        name: 'TestApp',
        path: '/projects/test-app',
        brief: 'A test application',
      });
      expect(project.id).toBeTruthy();
      expect(project.name).toBe('TestApp');
      expect(project.path).toBe('/projects/test-app');
      expect(project.trust_level).toBe('supervised');
      expect(project.status).toBe('paused');
    });

    test('rejects duplicate paths', () => {
      factoryHealth.registerProject({ name: 'App1', path: '/projects/app' });
      expect(() => {
        factoryHealth.registerProject({ name: 'App2', path: '/projects/app' });
      }).toThrow();
    });
  });

  describe('getProject', () => {
    test('returns null for unknown project', () => {
      expect(factoryHealth.getProject('nonexistent')).toBeNull();
    });

    test('returns project by id', () => {
      const created = factoryHealth.registerProject({ name: 'App', path: '/app' });
      const fetched = factoryHealth.getProject(created.id);
      expect(fetched.name).toBe('App');
    });
  });

  describe('listProjects', () => {
    test('returns empty array when no projects', () => {
      expect(factoryHealth.listProjects()).toEqual([]);
    });

    test('returns all projects', () => {
      factoryHealth.registerProject({ name: 'A', path: '/a' });
      factoryHealth.registerProject({ name: 'B', path: '/b' });
      expect(factoryHealth.listProjects()).toHaveLength(2);
    });
  });

  describe('updateProject', () => {
    test('updates trust_level', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.updateProject(p.id, { trust_level: 'guided' });
      expect(factoryHealth.getProject(p.id).trust_level).toBe('guided');
    });

    test('updates status', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.updateProject(p.id, { status: 'running' });
      expect(factoryHealth.getProject(p.id).status).toBe('running');
    });

    test('rejects invalid trust_level', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      expect(() => {
        factoryHealth.updateProject(p.id, { trust_level: 'invalid' });
      }).toThrow();
    });
  });

  describe('recordSnapshot', () => {
    test('stores a health snapshot', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      const snap = factoryHealth.recordSnapshot({
        project_id: p.id,
        dimension: 'test_coverage',
        score: 45.5,
        scan_type: 'full',
        details: { total_files: 100, tested_files: 45 },
      });
      expect(snap.id).toBeTruthy();
      expect(snap.score).toBe(45.5);
    });
  });

  describe('getLatestScores', () => {
    test('returns latest score per dimension', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 30 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 50 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 72 });

      const scores = factoryHealth.getLatestScores(p.id);
      expect(scores.test_coverage).toBe(50);
      expect(scores.security).toBe(72);
    });
  });

  describe('getScoreHistory', () => {
    test('returns time-series for a dimension', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 30 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 50 });

      const history = factoryHealth.getScoreHistory(p.id, 'test_coverage');
      expect(history).toHaveLength(2);
      expect(history[0].score).toBe(30);
      expect(history[1].score).toBe(50);
    });
  });

  describe('getBalanceScore', () => {
    test('returns 0 when no scores', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      expect(factoryHealth.getBalanceScore(p.id)).toBe(0);
    });

    test('returns low std dev for balanced scores', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 60 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 60 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'structural', score: 60 });
      const balance = factoryHealth.getBalanceScore(p.id);
      expect(balance).toBe(0);
    });

    test('returns high std dev for imbalanced scores', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 10 });
      factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 90 });
      const balance = factoryHealth.getBalanceScore(p.id);
      expect(balance).toBeGreaterThan(30);
    });
  });

  describe('recordFindings', () => {
    test('stores findings linked to a snapshot', () => {
      const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
      const snap = factoryHealth.recordSnapshot({
        project_id: p.id, dimension: 'security', score: 60,
      });
      factoryHealth.recordFindings(snap.id, [
        { severity: 'high', message: 'No input validation on /api/users', file_path: 'src/api/users.js' },
        { severity: 'medium', message: 'Hardcoded timeout value', file_path: 'src/config.js' },
      ]);
      const findings = factoryHealth.getFindings(snap.id);
      expect(findings).toHaveLength(2);
      expect(findings[0].severity).toBe('high');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/factory-health-db.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `server/db/factory-health.js`**

```js
'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger').child({ component: 'factory-health' });

const VALID_TRUST_LEVELS = new Set(['supervised', 'guided', 'autonomous', 'dark']);
const VALID_STATUSES = new Set(['paused', 'running', 'idle']);
const VALID_DIMENSIONS = new Set([
  'structural', 'test_coverage', 'security', 'user_facing',
  'api_completeness', 'documentation', 'dependency_health',
  'build_ci', 'performance', 'debt_ratio',
]);

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function registerProject({ name, path, brief, trust_level, config }) {
  const id = uuidv4();
  const level = trust_level || 'supervised';
  if (!VALID_TRUST_LEVELS.has(level)) {
    throw new Error(`Invalid trust_level: ${level}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, brief, trust_level, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)
  `).run(id, name, path, brief || null, level, config ? JSON.stringify(config) : null, now, now);

  return getProject(id);
}

function getProject(id) {
  const row = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(id);
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function getProjectByPath(projectPath) {
  const row = db.prepare('SELECT * FROM factory_projects WHERE path = ?').get(projectPath);
  if (!row) return null;
  if (row.config_json) {
    try { row.config = JSON.parse(row.config_json); } catch { row.config = null; }
  }
  return row;
}

function listProjects(filter) {
  let sql = 'SELECT * FROM factory_projects';
  const params = [];
  if (filter?.status) {
    sql += ' WHERE status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY updated_at DESC';
  return db.prepare(sql).all(...params);
}

function updateProject(id, updates) {
  const allowed = ['name', 'brief', 'trust_level', 'status', 'config_json'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    if (key === 'trust_level' && !VALID_TRUST_LEVELS.has(value)) {
      throw new Error(`Invalid trust_level: ${value}`);
    }
    if (key === 'status' && !VALID_STATUSES.has(value)) {
      throw new Error(`Invalid status: ${value}`);
    }
    sets.push(`${key} = ?`);
    params.push(key === 'config_json' && typeof value === 'object' ? JSON.stringify(value) : value);
  }

  if (sets.length === 0) return getProject(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE factory_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id);
}

function recordSnapshot({ project_id, dimension, score, scan_type, details, batch_id }) {
  const stmt = db.prepare(`
    INSERT INTO factory_health_snapshots (project_id, dimension, score, details_json, scan_type, batch_id, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const info = stmt.run(
    project_id,
    dimension,
    score,
    details ? JSON.stringify(details) : null,
    scan_type || 'incremental',
    batch_id || null,
  );
  return { id: info.lastInsertRowid, project_id, dimension, score, scan_type: scan_type || 'incremental' };
}

function getLatestScores(projectId) {
  const rows = db.prepare(`
    SELECT dimension, score FROM factory_health_snapshots
    WHERE project_id = ? AND id IN (
      SELECT MAX(id) FROM factory_health_snapshots
      WHERE project_id = ?
      GROUP BY dimension
    )
  `).all(projectId, projectId);

  const scores = {};
  for (const row of rows) {
    scores[row.dimension] = row.score;
  }
  return scores;
}

function getScoreHistory(projectId, dimension, limit) {
  return db.prepare(`
    SELECT id, score, scan_type, batch_id, scanned_at, details_json
    FROM factory_health_snapshots
    WHERE project_id = ? AND dimension = ?
    ORDER BY scanned_at ASC
    LIMIT ?
  `).all(projectId, dimension, limit || 100);
}

function getBalanceScore(projectId) {
  const scores = getLatestScores(projectId);
  const values = Object.values(scores);
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

function recordFindings(snapshotId, findings) {
  const stmt = db.prepare(`
    INSERT INTO factory_health_findings (snapshot_id, severity, message, file_path, details_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insert = db.transaction((items) => {
    for (const f of items) {
      stmt.run(
        snapshotId,
        f.severity,
        f.message,
        f.file_path || null,
        f.details ? JSON.stringify(f.details) : null,
      );
    }
  });
  insert(findings);
}

function getFindings(snapshotId) {
  return db.prepare(
    'SELECT * FROM factory_health_findings WHERE snapshot_id = ? ORDER BY id'
  ).all(snapshotId);
}

function getProjectHealthSummary(projectId) {
  const project = getProject(projectId);
  if (!project) return null;

  const scores = getLatestScores(projectId);
  const balance = getBalanceScore(projectId);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  return {
    project,
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
    dimension_count: Object.keys(scores).length,
  };
}

module.exports = {
  setDb,
  registerProject,
  getProject,
  getProjectByPath,
  listProjects,
  updateProject,
  recordSnapshot,
  getLatestScores,
  getScoreHistory,
  getBalanceScore,
  recordFindings,
  getFindings,
  getProjectHealthSummary,
  VALID_TRUST_LEVELS,
  VALID_STATUSES,
  VALID_DIMENSIONS,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/factory-health-db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add server/db/factory-health.js server/tests/factory-health-db.test.js
git commit -m "feat(factory): add factory-health DB module with project registry and health snapshots"
```

---

### Task 3: Register in DI Container

**Files:**
- Modify: `server/container.js`
- Modify: `server/database.js`

- [ ] **Step 1: Read `server/container.js` to find where DB modules are registered**

Search for `registerValue('configCore'` to find the registration block (around line 236-300).

- [ ] **Step 2: Add factory-health to the container registration block**

In `server/container.js`, inside the `initModules` function, in the requires block near the other DB module requires, add:

```js
const factoryHealth = require('./db/factory-health');
```

And in the `registerValue` block:

```js
_defaultContainer.registerValue('factoryHealth', factoryHealth);
```

- [ ] **Step 3: Add `setDb` call in `server/database.js` init chain**

In `server/database.js`, find where `setDb` is called on other modules during initialization. Add:

```js
const factoryHealth = require('./db/factory-health');
```

to the requires, and in the init section:

```js
factoryHealth.setDb(db);
```

- [ ] **Step 4: Verify the server still starts**

Run: `node -e "require('./server/container')"`
Expected: No errors (quick smoke test that the require chain works).

- [ ] **Step 5: Commit**

```
git add server/container.js server/database.js
git commit -m "feat(factory): register factory-health module in DI container"
```

---

### Task 4: MCP Tool Definitions

**Files:**
- Create: `server/tool-defs/factory-defs.js`
- Modify: `server/tools.js` (add to TOOLS array)
- Modify: `server/tool-annotations.js` (add annotations)

- [ ] **Step 1: Create `server/tool-defs/factory-defs.js`**

```js
'use strict';

const tools = [
  {
    name: 'register_factory_project',
    description: 'Register a project with the software factory. Creates a project entry with a health model that tracks 10 quality dimensions. Projects start in supervised trust level and paused status.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable project name' },
        path: { type: 'string', description: 'Absolute path to the project root directory' },
        brief: { type: 'string', description: 'Project brief — what it is, who it is for, critical user journeys. Used by the Architect agent for product-sense prioritization.' },
        trust_level: {
          type: 'string',
          enum: ['supervised', 'guided', 'autonomous', 'dark'],
          description: 'Initial trust level. supervised=human approves priorities+plan+verify+ship, guided=human approves plan+ship, autonomous=human approves ship only, dark=fully autonomous. Default: supervised.',
        },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'list_factory_projects',
    description: 'List all projects registered with the software factory, including their trust level, status, and latest health summary.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'paused', 'idle'],
          description: 'Filter by factory status',
        },
      },
    },
  },
  {
    name: 'project_health',
    description: 'Get the current health model for a factory project. Returns scores for all 10 dimensions, balance score (standard deviation - lower is more balanced), weakest dimension, and optional trend data.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        include_trends: { type: 'boolean', description: 'Include score history for each dimension (default: false)' },
        include_findings: { type: 'boolean', description: 'Include detailed findings for each dimension (default: false)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'scan_project_health',
    description: 'Run a health scan on a factory project. Scores the specified dimensions (or all 10) using scouts and static analysis. Stores results as time-series snapshots. Use scan_type full for initial onboarding or periodic deep scans, incremental for post-batch re-scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        dimensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dimensions to scan. Default: all 10. Options: structural, test_coverage, security, user_facing, api_completeness, documentation, dependency_health, build_ci, performance, debt_ratio',
        },
        scan_type: {
          type: 'string',
          enum: ['full', 'incremental'],
          description: 'Full = deep scan across everything (expensive). Incremental = quick re-score of specified dimensions. Default: incremental.',
        },
        batch_id: { type: 'string', description: 'Link this scan to a specific batch for pre/post comparison' },
      },
      required: ['project'],
    },
  },
  {
    name: 'set_factory_trust_level',
    description: 'Change the trust level for a factory project. supervised, guided, autonomous, dark. Higher trust = more autonomy.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
        trust_level: {
          type: 'string',
          enum: ['supervised', 'guided', 'autonomous', 'dark'],
          description: 'New trust level',
        },
      },
      required: ['project', 'trust_level'],
    },
  },
  {
    name: 'pause_project',
    description: 'Pause a factory project. Freezes the factory loop - in-progress tasks complete but nothing new starts or ships. One-action emergency control.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'resume_project',
    description: 'Resume a paused factory project. The factory loop restarts from the Sense stage.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project ID or path' },
      },
      required: ['project'],
    },
  },
  {
    name: 'pause_all_projects',
    description: 'Emergency stop - pause ALL factory projects immediately. One tool call to halt everything.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'factory_status',
    description: 'Overview of all factory projects - name, trust level, status (running/paused/idle), latest health balance score. The air traffic control view for the factory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

module.exports = tools;
```

- [ ] **Step 2: Add to TOOLS array in `server/tools.js`**

Add `...require('./tool-defs/factory-defs'),` to the TOOLS array (after the last existing `...require` entry, before the closing `]`).

- [ ] **Step 3: Add explicit annotations in `server/tool-annotations.js`**

Most factory tools match prefix rules automatically. Add explicit entries for those that don't match any prefix. Find the `EXPLICIT_ANNOTATIONS` map in the file and add:

```js
'pause_project': DESTRUCTIVE,
'resume_project': LIFECYCLE,
'pause_all_projects': DESTRUCTIVE,
'factory_status': READONLY,
'project_health': READONLY,
```

- [ ] **Step 4: Run annotation coverage validation**

Run: `node -e "const t = require('./server/tool-annotations'); const tools = require('./server/tools'); console.log('loaded')"`
Expected: No errors.

- [ ] **Step 5: Commit**

```
git add server/tool-defs/factory-defs.js server/tools.js server/tool-annotations.js
git commit -m "feat(factory): add MCP tool definitions for factory project management and health"
```

---

### Task 5: MCP Tool Handlers

**Files:**
- Create: `server/handlers/factory-handlers.js`
- Modify: `server/tools.js` (wire dispatch)
- Test: `server/tests/factory-handlers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-handlers.test.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryHealth = require('../db/factory-health');

let handlers;

describe('factory handlers', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    runMigrations(db);
    factoryHealth.setDb(db);

    handlers = require('../handlers/factory-handlers');
  });

  afterEach(() => {
    db.close();
  });

  test('handleRegisterFactoryProject creates a project', async () => {
    const result = await handlers.handleRegisterFactoryProject({
      name: 'TestApp',
      path: '/test/app',
      brief: 'Test app brief',
    });
    expect(result.content[0].text).toContain('TestApp');
    expect(result.content[0].text).toContain('supervised');
  });

  test('handleListFactoryProjects returns projects', async () => {
    factoryHealth.registerProject({ name: 'A', path: '/a' });
    factoryHealth.registerProject({ name: 'B', path: '/b' });

    const result = await handlers.handleListFactoryProjects({});
    const data = JSON.parse(result.content[0].text);
    expect(data.projects).toHaveLength(2);
  });

  test('handleProjectHealth returns scores', async () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'test_coverage', score: 45 });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 72 });

    const result = await handlers.handleProjectHealth({ project: p.id });
    const data = JSON.parse(result.content[0].text);
    expect(data.scores.test_coverage).toBe(45);
    expect(data.scores.security).toBe(72);
    expect(data.balance).toBeDefined();
  });

  test('handleProjectHealth resolves project by path', async () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/my/app' });
    factoryHealth.recordSnapshot({ project_id: p.id, dimension: 'security', score: 80 });

    const result = await handlers.handleProjectHealth({ project: '/my/app' });
    const data = JSON.parse(result.content[0].text);
    expect(data.scores.security).toBe(80);
  });

  test('handlePauseProject pauses a running project', async () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });
    factoryHealth.updateProject(p.id, { status: 'running' });

    const result = await handlers.handlePauseProject({ project: p.id });
    expect(result.content[0].text).toContain('paused');
    expect(factoryHealth.getProject(p.id).status).toBe('paused');
  });

  test('handleResumeProject resumes a paused project', async () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });

    const result = await handlers.handleResumeProject({ project: p.id });
    expect(result.content[0].text).toContain('running');
    expect(factoryHealth.getProject(p.id).status).toBe('running');
  });

  test('handlePauseAllProjects pauses everything', async () => {
    factoryHealth.registerProject({ name: 'A', path: '/a' });
    factoryHealth.registerProject({ name: 'B', path: '/b' });
    factoryHealth.updateProject(factoryHealth.getProjectByPath('/a').id, { status: 'running' });
    factoryHealth.updateProject(factoryHealth.getProjectByPath('/b').id, { status: 'running' });

    await handlers.handlePauseAllProjects({});
    const projects = factoryHealth.listProjects();
    expect(projects.every(p => p.status === 'paused')).toBe(true);
  });

  test('handleFactoryStatus returns overview', async () => {
    factoryHealth.registerProject({ name: 'A', path: '/a' });

    const result = await handlers.handleFactoryStatus({});
    const data = JSON.parse(result.content[0].text);
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].name).toBe('A');
  });

  test('handleSetFactoryTrustLevel changes trust', async () => {
    const p = factoryHealth.registerProject({ name: 'App', path: '/app' });

    const result = await handlers.handleSetFactoryTrustLevel({
      project: p.id,
      trust_level: 'guided',
    });
    expect(result.content[0].text).toContain('guided');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/factory-handlers.test.js`
Expected: FAIL — handlers module doesn't exist.

- [ ] **Step 3: Implement `server/handlers/factory-handlers.js`**

```js
'use strict';

const factoryHealth = require('../db/factory-health');
const logger = require('../logger').child({ component: 'factory-handlers' });

function resolveProject(projectRef) {
  let project = factoryHealth.getProject(projectRef);
  if (!project) {
    project = factoryHealth.getProjectByPath(projectRef);
  }
  if (!project) {
    throw new Error(`Project not found: ${projectRef}`);
  }
  return project;
}

function jsonResponse(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleRegisterFactoryProject(args) {
  const project = factoryHealth.registerProject({
    name: args.name,
    path: args.path,
    brief: args.brief,
    trust_level: args.trust_level,
  });
  logger.info(`Registered factory project: ${project.name} (${project.id})`);
  return jsonResponse({
    message: `Project "${project.name}" registered with trust level: ${project.trust_level}`,
    project,
  });
}

async function handleListFactoryProjects(args) {
  const projects = factoryHealth.listProjects(args.status ? { status: args.status } : undefined);
  const summaries = projects.map(p => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id);
    return { ...p, scores, balance };
  });
  return jsonResponse({ projects: summaries });
}

async function handleProjectHealth(args) {
  const project = resolveProject(args.project);
  const scores = factoryHealth.getLatestScores(project.id);
  const balance = factoryHealth.getBalanceScore(project.id);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  const result = {
    project: { id: project.id, name: project.name, path: project.path, trust_level: project.trust_level, status: project.status },
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
  };

  if (args.include_trends) {
    result.trends = {};
    for (const dim of Object.keys(scores)) {
      result.trends[dim] = factoryHealth.getScoreHistory(project.id, dim, 20);
    }
  }

  if (args.include_findings) {
    result.findings = {};
    for (const dim of Object.keys(scores)) {
      const history = factoryHealth.getScoreHistory(project.id, dim, 1);
      if (history.length > 0) {
        result.findings[dim] = factoryHealth.getFindings(history[history.length - 1].id);
      }
    }
  }

  return jsonResponse(result);
}

async function handleScanProjectHealth(args) {
  const project = resolveProject(args.project);
  const dimensions = args.dimensions || [...factoryHealth.VALID_DIMENSIONS];
  const scanType = args.scan_type || 'incremental';

  // Phase 1 records placeholder scores. Actual dimension scorers added in Phase 1b.
  const results = {};
  for (const dim of dimensions) {
    const snap = factoryHealth.recordSnapshot({
      project_id: project.id,
      dimension: dim,
      score: 0,
      scan_type: scanType,
      batch_id: args.batch_id,
      details: { status: 'scorer_not_yet_implemented' },
    });
    results[dim] = { snapshot_id: snap.id, score: snap.score };
  }

  return jsonResponse({
    message: `Scanned ${dimensions.length} dimensions for "${project.name}" (${scanType})`,
    project_id: project.id,
    results,
  });
}

async function handleSetFactoryTrustLevel(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { trust_level: args.trust_level });
  logger.info(`Trust level for "${updated.name}" changed to ${args.trust_level}`);
  return jsonResponse({
    message: `Trust level for "${updated.name}" set to: ${updated.trust_level}`,
    project: updated,
  });
}

async function handlePauseProject(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { status: 'paused' });
  logger.info(`Factory project paused: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" paused`,
    project: updated,
  });
}

async function handleResumeProject(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { status: 'running' });
  logger.info(`Factory project resumed: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" running`,
    project: updated,
  });
}

async function handlePauseAllProjects() {
  const projects = factoryHealth.listProjects();
  let paused = 0;
  for (const p of projects) {
    if (p.status !== 'paused') {
      factoryHealth.updateProject(p.id, { status: 'paused' });
      paused++;
    }
  }
  logger.info(`Emergency pause: ${paused} projects paused`);
  return jsonResponse({
    message: `${paused} project(s) paused`,
    total: projects.length,
    paused,
  });
}

async function handleFactoryStatus() {
  const projects = factoryHealth.listProjects();
  const summaries = projects.map(p => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id);
    const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      trust_level: p.trust_level,
      status: p.status,
      balance,
      weakest_dimension: weakest ? weakest[0] : null,
      dimension_count: Object.keys(scores).length,
    };
  });

  const running = summaries.filter(p => p.status === 'running').length;
  const paused = summaries.filter(p => p.status === 'paused').length;

  return jsonResponse({
    projects: summaries,
    summary: { total: projects.length, running, paused },
  });
}

module.exports = {
  handleRegisterFactoryProject,
  handleListFactoryProjects,
  handleProjectHealth,
  handleScanProjectHealth,
  handleSetFactoryTrustLevel,
  handlePauseProject,
  handleResumeProject,
  handlePauseAllProjects,
  handleFactoryStatus,
};
```

- [ ] **Step 4: Wire handlers into `server/tools.js` dispatch**

In `server/tools.js`, add the require near the top with other handler imports:

```js
const factoryHandlers = require('./handlers/factory-handlers');
```

Then in the dispatch map (find where other handlers are mapped to tool names), add:

```js
'register_factory_project': factoryHandlers.handleRegisterFactoryProject,
'list_factory_projects': factoryHandlers.handleListFactoryProjects,
'project_health': factoryHandlers.handleProjectHealth,
'scan_project_health': factoryHandlers.handleScanProjectHealth,
'set_factory_trust_level': factoryHandlers.handleSetFactoryTrustLevel,
'pause_project': factoryHandlers.handlePauseProject,
'resume_project': factoryHandlers.handleResumeProject,
'pause_all_projects': factoryHandlers.handlePauseAllProjects,
'factory_status': factoryHandlers.handleFactoryStatus,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/factory-handlers.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add server/handlers/factory-handlers.js server/tests/factory-handlers.test.js server/tools.js
git commit -m "feat(factory): implement MCP handlers for factory project management and health queries"
```

---

### Task 6: Add Factory Tools to Core Tier

**Files:**
- Modify: `server/core-tools.js`

- [ ] **Step 1: Read `server/core-tools.js` to understand the tier arrays**

Find `CORE_TOOL_NAMES` and `EXTENDED_TOOL_NAMES`.

- [ ] **Step 2: Add factory control tools to CORE_TOOL_NAMES**

Append these to the `CORE_TOOL_NAMES` array:

```js
'factory_status',
'pause_project',
'resume_project',
'pause_all_projects',
'project_health',
```

- [ ] **Step 3: Add remaining factory tools to EXTENDED_TOOL_NAMES**

Append these to the `EXTENDED_TOOL_NAMES` array:

```js
'register_factory_project',
'list_factory_projects',
'scan_project_health',
'set_factory_trust_level',
```

- [ ] **Step 4: Commit**

```
git add server/core-tools.js
git commit -m "feat(factory): add factory control tools to core tier for always-available access"
```

---

### Task 7: REST API Routes

**Files:**
- Modify: `server/api-server.core.js` or `server/api/v2-router.js` (depending on pattern)

- [ ] **Step 1: Read the v2 router to understand how routes are registered**

Read `server/api/v2-router.js` (or wherever the v2 routes are defined) to find the pattern for adding new route groups.

- [ ] **Step 2: Add factory REST routes**

Add routes that proxy to the MCP tool handlers via `handleToolCall`. The routes map as:

```
GET  /api/v2/factory/projects           -> list_factory_projects
POST /api/v2/factory/projects           -> register_factory_project
GET  /api/v2/factory/projects/:id       -> project_health { project: :id }
GET  /api/v2/factory/status             -> factory_status
POST /api/v2/factory/projects/:id/scan  -> scan_project_health { project: :id }
PUT  /api/v2/factory/projects/:id/trust -> set_factory_trust_level { project: :id }
POST /api/v2/factory/projects/:id/pause -> pause_project { project: :id }
POST /api/v2/factory/projects/:id/resume -> resume_project { project: :id }
POST /api/v2/factory/pause-all          -> pause_all_projects
```

Follow whichever pattern the existing v2 routes use (direct handler invocation, or proxying through `handleToolCall`).

- [ ] **Step 3: Verify routes respond**

After starting the server:
```
curl -s http://127.0.0.1:3457/api/v2/factory/status
```
Expected: JSON response with factory status.

- [ ] **Step 4: Commit**

```
git add server/api-server.core.js server/api/v2-router.js
git commit -m "feat(factory): add REST API v2 routes for factory management"
```

---

### Task 8: Dashboard — Radar Chart Component

**Files:**
- Create: `dashboard/src/components/RadarChart.jsx`
- Test: `dashboard/src/components/RadarChart.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/RadarChart.test.jsx`:

```jsx
import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import RadarChart from './RadarChart';

describe('RadarChart', () => {
  const scores = {
    test_coverage: 45,
    security: 72,
    structural: 68,
    user_facing: 30,
    documentation: 55,
  };

  test('renders an SVG element', () => {
    const { container } = render(<RadarChart scores={scores} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  test('renders a polygon for the data', () => {
    const { container } = render(<RadarChart scores={scores} />);
    const polygons = container.querySelectorAll('polygon');
    expect(polygons.length).toBeGreaterThanOrEqual(1);
  });

  test('renders dimension labels', () => {
    render(<RadarChart scores={scores} />);
    expect(screen.getByText(/test coverage/i)).toBeTruthy();
    expect(screen.getByText(/security/i)).toBeTruthy();
  });

  test('renders with empty scores', () => {
    const { container } = render(<RadarChart scores={{}} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  test('renders score values when showValues is true', () => {
    render(<RadarChart scores={scores} showValues />);
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('72')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run dashboard/src/components/RadarChart.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implement `dashboard/src/components/RadarChart.jsx`**

```jsx
const DIMENSION_LABELS = {
  structural: 'Structural',
  test_coverage: 'Test Coverage',
  security: 'Security',
  user_facing: 'User-Facing',
  api_completeness: 'API',
  documentation: 'Documentation',
  dependency_health: 'Dependencies',
  build_ci: 'Build/CI',
  performance: 'Performance',
  debt_ratio: 'Debt Ratio',
};

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export default function RadarChart({ scores = {}, size = 280, showValues = false }) {
  const dimensions = Object.keys(scores);
  if (dimensions.length === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Health radar chart (no data)">
        <text x={size / 2} y={size / 2} textAnchor="middle" fill="#64748b" fontSize={12}>No health data</text>
      </svg>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.38;
  const angleStep = 360 / dimensions.length;
  const rings = [25, 50, 75, 100];

  const dataPoints = dimensions.map((dim, i) => {
    const angle = i * angleStep;
    const r = (scores[dim] / 100) * maxR;
    return polarToCartesian(cx, cy, r, angle);
  });

  const axes = dimensions.map((dim, i) => {
    const angle = i * angleStep;
    const end = polarToCartesian(cx, cy, maxR, angle);
    const labelPos = polarToCartesian(cx, cy, maxR + 18, angle);
    return { dim, end, labelPos, angle };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Health radar chart">
      {rings.map(pct => {
        const r = (pct / 100) * maxR;
        const ringPoints = dimensions.map((_, i) => polarToCartesian(cx, cy, r, i * angleStep));
        const ringPath = ringPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + 'Z';
        return <path key={pct} d={ringPath} fill="none" stroke="#334155" strokeWidth={0.5} />;
      })}

      {axes.map(({ dim, end }) => (
        <line key={dim} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#334155" strokeWidth={0.5} />
      ))}

      <polygon points={dataPoints.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(59, 130, 246, 0.2)" stroke="#3b82f6" strokeWidth={2} />

      {dataPoints.map((p, i) => (
        <circle key={dimensions[i]} cx={p.x} cy={p.y} r={3} fill="#3b82f6" />
      ))}

      {axes.map(({ dim, labelPos, angle }) => {
        const label = DIMENSION_LABELS[dim] || dim.replace(/_/g, ' ');
        const textAnchor = angle > 90 && angle < 270 ? 'end' : angle === 0 || angle === 180 ? 'middle' : 'start';
        return (
          <text key={dim} x={labelPos.x} y={labelPos.y} textAnchor={textAnchor} dominantBaseline="middle" fill="#94a3b8" fontSize={10}>
            {label}
          </text>
        );
      })}

      {showValues && dataPoints.map((p, i) => (
        <text key={`val-${dimensions[i]}`} x={p.x} y={p.y - 8} textAnchor="middle" fill="#e2e8f0" fontSize={10} fontWeight="bold">
          {Math.round(scores[dimensions[i]])}
        </text>
      ))}
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run dashboard/src/components/RadarChart.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add dashboard/src/components/RadarChart.jsx dashboard/src/components/RadarChart.test.jsx
git commit -m "feat(factory): add SVG radar chart component for project health visualization"
```

---

### Task 9: Dashboard — Factory View + Routing

**Files:**
- Create: `dashboard/src/views/Factory.jsx`
- Modify: `dashboard/src/App.jsx` (add route)
- Modify: `dashboard/src/components/Layout.jsx` (add nav item)
- Modify: `dashboard/src/api.js` (add factory API client)

- [ ] **Step 1: Add factory API client methods to `dashboard/src/api.js`**

Add a `factory` export namespace following the pattern of existing namespaces (e.g., `budget`):

```js
export const factory = {
  status: (opts = {}) => requestV2('/factory/status', opts),
  projects: (opts = {}) => requestV2('/factory/projects', opts),
  health: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}`, opts),
  register: (data, opts = {}) => requestV2('/factory/projects', { method: 'POST', body: JSON.stringify(data), ...opts }),
  pause: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/pause`, { method: 'POST', ...opts }),
  resume: (projectId, opts = {}) => requestV2(`/factory/projects/${projectId}/resume`, { method: 'POST', ...opts }),
  pauseAll: (opts = {}) => requestV2('/factory/pause-all', { method: 'POST', ...opts }),
};
```

- [ ] **Step 2: Create `dashboard/src/views/Factory.jsx`**

Build the Factory view with: stat cards (total/running/paused), project card grid with radar charts and pause/resume buttons, and a detail panel that opens on click. See the full component code in the design spec walkthrough. The view should follow the same patterns as existing views (Budget.jsx, Hosts.jsx) — `useState` + `useEffect` + API fetch + conditional rendering.

Key elements:
- TrustBadge component (colored badge: supervised=yellow, guided=blue, autonomous=purple, dark=slate)
- StatusDot component (green=running, yellow=paused, grey=idle)
- ProjectCard component (name, path, radar chart, pause/resume button)
- Detail panel (full-size radar with showValues, dimension bar chart list, balance score)
- Pause All button in the header
- Empty state directing users to `register_factory_project`

- [ ] **Step 3: Add Factory route to `dashboard/src/App.jsx`**

Add lazy import near other lazy imports:
```js
const Factory = lazy(() => import('./views/Factory'));
```

Add route in the Routes block (before the redirect block):
```jsx
<Route path="factory" element={<Factory />} />
```

- [ ] **Step 4: Add Factory nav item to `dashboard/src/components/Layout.jsx`**

Add a FactoryIcon SVG component (beaker/flask icon — the one from heroicons):

```jsx
const FactoryIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
  </svg>
);
```

Add to `navItems` array (insert before the settings entry):
```js
{ to: '/factory', icon: FactoryIcon, label: 'Factory' },
```

Add to `ROUTE_NAMES`:
```js
'/factory': 'Factory',
```

- [ ] **Step 5: Verify the dashboard builds**

Run: `cd dashboard && npx vite build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```
git add dashboard/src/views/Factory.jsx dashboard/src/App.jsx dashboard/src/components/Layout.jsx dashboard/src/api.js
git commit -m "feat(factory): add Factory dashboard view with radar chart, project cards, and deep dive panel"
```

---

### Task 10: Integration Test — End-to-End Flow

**Files:**
- Create: `server/tests/factory-e2e.test.js`

- [ ] **Step 1: Write the integration test**

Create `server/tests/factory-e2e.test.js`:

```js
'use strict';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryHealth = require('../db/factory-health');
const handlers = require('../handlers/factory-handlers');

describe('factory end-to-end flow', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    runMigrations(db);
    factoryHealth.setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  test('full lifecycle: register, scan, query health, pause, resume', async () => {
    // 1. Register
    const regResult = await handlers.handleRegisterFactoryProject({
      name: 'WidgetApp', path: '/projects/widget-app', brief: 'Billing tool', trust_level: 'guided',
    });
    const regData = JSON.parse(regResult.content[0].text);
    expect(regData.project.trust_level).toBe('guided');
    const projectId = regData.project.id;

    // 2. Record health scores
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'test_coverage', score: 31 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'security', score: 72 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'structural', score: 68 });

    // 3. Query health
    const healthResult = await handlers.handleProjectHealth({ project: projectId });
    const healthData = JSON.parse(healthResult.content[0].text);
    expect(healthData.scores.test_coverage).toBe(31);
    expect(healthData.weakest_dimension.dimension).toBe('test_coverage');
    expect(healthData.balance).toBeGreaterThan(0);

    // 4. Query by path
    const pathResult = await handlers.handleProjectHealth({ project: '/projects/widget-app' });
    const pathData = JSON.parse(pathResult.content[0].text);
    expect(pathData.scores.security).toBe(72);

    // 5. Factory status
    const statusResult = await handlers.handleFactoryStatus({});
    const statusData = JSON.parse(statusResult.content[0].text);
    expect(statusData.projects).toHaveLength(1);

    // 6. Pause
    await handlers.handlePauseProject({ project: projectId });
    expect(factoryHealth.getProject(projectId).status).toBe('paused');

    // 7. Resume
    await handlers.handleResumeProject({ project: projectId });
    expect(factoryHealth.getProject(projectId).status).toBe('running');

    // 8. Change trust
    await handlers.handleSetFactoryTrustLevel({ project: projectId, trust_level: 'autonomous' });
    expect(factoryHealth.getProject(projectId).trust_level).toBe('autonomous');

    // 9. Pause all
    await handlers.handlePauseAllProjects({});
    expect(factoryHealth.getProject(projectId).status).toBe('paused');
  });

  test('score history tracks changes over time', async () => {
    const regResult = await handlers.handleRegisterFactoryProject({ name: 'App', path: '/app' });
    const projectId = JSON.parse(regResult.content[0].text).project.id;

    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'test_coverage', score: 20 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'test_coverage', score: 35 });
    factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'test_coverage', score: 48 });

    const history = factoryHealth.getScoreHistory(projectId, 'test_coverage');
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(20);
    expect(history[2].score).toBe(48);

    const scores = factoryHealth.getLatestScores(projectId);
    expect(scores.test_coverage).toBe(48);
  });

  test('findings are linked to snapshots', async () => {
    const regResult = await handlers.handleRegisterFactoryProject({ name: 'App', path: '/app2' });
    const projectId = JSON.parse(regResult.content[0].text).project.id;

    const snap = factoryHealth.recordSnapshot({ project_id: projectId, dimension: 'security', score: 55 });

    factoryHealth.recordFindings(snap.id, [
      { severity: 'high', message: 'SQL injection in user search', file_path: 'src/api/users.js' },
      { severity: 'low', message: 'Missing CSRF token on settings page', file_path: 'src/pages/settings.js' },
    ]);

    const findings = factoryHealth.getFindings(snap.id);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain('SQL injection');
  });
});
```

- [ ] **Step 2: Run all factory tests**

Run: `npx vitest run server/tests/factory-health-migration.test.js server/tests/factory-health-db.test.js server/tests/factory-handlers.test.js server/tests/factory-e2e.test.js`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```
git add server/tests/factory-e2e.test.js
git commit -m "test(factory): add end-to-end integration test for factory lifecycle"
```

---

## Post-Plan Notes

### What This Phase Delivers

- Project registry (register, list, query, pause/resume, trust levels)
- Health model with 10 dimension time-series storage
- Balance scoring (standard deviation across dimensions)
- Findings linked to snapshots
- 9 MCP tools (5 core tier, 4 extended)
- REST API v2 routes matching MCP tools
- Dashboard Factory view with radar charts, project cards, pause/resume controls, deep dive panel
- Full test coverage (migration, DB, handlers, e2e)

### What This Phase Does NOT Deliver

- **Actual dimension scorers** — `scan_project_health` records placeholder scores. Real scorers (leveraging scouts, scan_project, etc.) come in Phase 1b.
- **Factory loop** — no automatic cycling. Scans are manual via tool calls.
- **Architect, Intake, Guardrails, Feedback** — later phases per the spec.

### Next Phase

Phase 1b: Dimension Scorers — wire `scan_project`, security scout, test-coverage scout, and static analysis into the health model to produce real scores. Plan once Phase 1 is validated.
