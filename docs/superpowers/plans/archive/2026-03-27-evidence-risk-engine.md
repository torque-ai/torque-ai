# Evidence & Risk Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three Anvil-inspired features to TORQUE: file-level risk tagging, a structured verification ledger, and adversarial multi-provider code review.

**Architecture:** Three independent modules, each with its own DB table, handler, and integration point. File risk is a policy adapter + inline scorer. Verification ledger is a read-only finalizer stage. Adversarial review is a finalizer stage that spawns review tasks. All follow existing TORQUE patterns (DI container, `runStage`, policy adapters, MCP tool auto-dispatch).

**Tech Stack:** Node.js, better-sqlite3, Vitest, MCP (SSE transport), minimatch (glob pattern matching — already a dependency)

**Spec:** `docs/superpowers/specs/2026-03-27-evidence-risk-engine-design.md`

---

## Phase 1: File Risk Tagging

### Task 1: Schema and DB Module

**Files:**
- Modify: `server/db/schema-tables.js` (add table + VALID_TABLE_NAMES entry)
- Modify: `server/db/schema-migrations.js` (add migration for new table)
- Create: `server/db/file-risk.js`
- Create: `server/tests/file-risk.test.js`

- [ ] **Step 1: Write failing test for `insertFileRisk` and `getFileRisk`**

```js
// server/tests/file-risk.test.js
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('file-risk', () => {
  let db;
  let fileRisk;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL,
        scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec('CREATE INDEX idx_risk_scores_level ON file_risk_scores(risk_level)');
    db.exec('CREATE INDEX idx_risk_scores_path ON file_risk_scores(file_path)');

    const { createFileRisk } = require('../db/file-risk');
    fileRisk = createFileRisk({ db });
  });

  it('upserts and retrieves a file risk score', () => {
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'high',
      risk_reasons: JSON.stringify(['auth_module']),
      scored_by: 'pattern',
    });

    const result = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(result).toBeTruthy();
    expect(result.risk_level).toBe('high');
    expect(JSON.parse(result.risk_reasons)).toEqual(['auth_module']);
  });

  it('upsert replaces existing score for same file+dir', () => {
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'medium',
      risk_reasons: JSON.stringify(['cross_cutting']),
      scored_by: 'pattern',
    });
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'high',
      risk_reasons: JSON.stringify(['auth_module']),
      scored_by: 'pattern',
    });

    const results = db.prepare('SELECT * FROM file_risk_scores WHERE file_path = ?').all('server/auth/session.js');
    expect(results).toHaveLength(1);
    expect(results[0].risk_level).toBe('high');
  });

  it('returns null for unknown file', () => {
    const result = fileRisk.getFileRisk('unknown.js', '/project');
    expect(result).toBeNull();
  });

  it('getFilesAtRisk filters by minimum level', () => {
    fileRisk.upsertScore({ file_path: 'auth.js', working_directory: '/p', risk_level: 'high', risk_reasons: '["auth_module"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'config.js', working_directory: '/p', risk_level: 'medium', risk_reasons: '["configuration"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'readme.md', working_directory: '/p', risk_level: 'low', risk_reasons: '["documentation"]', scored_by: 'pattern' });

    const highOnly = fileRisk.getFilesAtRisk('/p', 'high');
    expect(highOnly).toHaveLength(1);
    expect(highOnly[0].file_path).toBe('auth.js');

    const mediumUp = fileRisk.getFilesAtRisk('/p', 'medium');
    expect(mediumUp).toHaveLength(2);
  });

  it('setManualOverride sets auto_scored to 0', () => {
    fileRisk.upsertScore({ file_path: 'utils.js', working_directory: '/p', risk_level: 'low', risk_reasons: '["styling"]', scored_by: 'pattern' });
    fileRisk.setManualOverride('utils.js', '/p', 'high', 'contains-secrets');

    const result = fileRisk.getFileRisk('utils.js', '/p');
    expect(result.risk_level).toBe('high');
    expect(result.auto_scored).toBe(0);
    expect(JSON.parse(result.risk_reasons)).toContain('contains-secrets');
  });

  it('getTaskRiskSummary aggregates risk levels', () => {
    // Simulate task_file_changes table
    db.exec(`
      CREATE TABLE task_file_changes (
        id INTEGER PRIMARY KEY, task_id TEXT, file_path TEXT,
        change_type TEXT, file_size_bytes INTEGER, working_directory TEXT,
        relative_path TEXT, is_outside_workdir INTEGER, created_at TEXT
      )
    `);
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'auth.js', '/p', 'modified', new Date().toISOString());
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'readme.md', '/p', 'modified', new Date().toISOString());

    fileRisk.upsertScore({ file_path: 'auth.js', working_directory: '/p', risk_level: 'high', risk_reasons: '["auth_module"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'readme.md', working_directory: '/p', risk_level: 'low', risk_reasons: '["documentation"]', scored_by: 'pattern' });

    const summary = fileRisk.getTaskRiskSummary('task-1');
    expect(summary.high).toHaveLength(1);
    expect(summary.low).toHaveLength(1);
    expect(summary.overall_risk).toBe('high');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/file-risk.test.js`
Expected: FAIL — `Cannot find module '../db/file-risk'`

- [ ] **Step 3: Implement `server/db/file-risk.js`**

```js
// server/db/file-risk.js
'use strict';

const RISK_LEVELS = ['high', 'medium', 'low'];
const RISK_LEVEL_ORDER = { high: 0, medium: 1, low: 2 };

function createFileRisk({ db }) {
  function upsertScore({ file_path, working_directory, risk_level, risk_reasons, scored_by }) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO file_risk_scores (file_path, working_directory, risk_level, risk_reasons, auto_scored, scored_at, scored_by)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        risk_level = CASE WHEN auto_scored = 0 THEN risk_level ELSE excluded.risk_level END,
        risk_reasons = CASE WHEN auto_scored = 0 THEN risk_reasons ELSE excluded.risk_reasons END,
        scored_at = excluded.scored_at,
        scored_by = excluded.scored_by
    `).run(file_path, working_directory, risk_level, risk_reasons, now, scored_by || 'pattern');
  }

  function getFileRisk(filePath, workingDirectory) {
    return db.prepare('SELECT * FROM file_risk_scores WHERE file_path = ? AND working_directory = ?')
      .get(filePath, workingDirectory) || null;
  }

  function getFilesAtRisk(workingDirectory, minLevel = 'low') {
    const minOrder = RISK_LEVEL_ORDER[minLevel] ?? 2;
    const levels = RISK_LEVELS.filter(l => RISK_LEVEL_ORDER[l] <= minOrder);
    if (levels.length === 0) return [];
    const placeholders = levels.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM file_risk_scores WHERE working_directory = ? AND risk_level IN (${placeholders}) ORDER BY risk_level`
    ).all(workingDirectory, ...levels);
  }

  function setManualOverride(filePath, workingDirectory, riskLevel, reason) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO file_risk_scores (file_path, working_directory, risk_level, risk_reasons, auto_scored, scored_at, scored_by)
      VALUES (?, ?, ?, ?, 0, ?, 'manual')
      ON CONFLICT(file_path, working_directory) DO UPDATE SET
        risk_level = excluded.risk_level,
        risk_reasons = excluded.risk_reasons,
        auto_scored = 0,
        scored_at = excluded.scored_at,
        scored_by = 'manual'
    `).run(filePath, workingDirectory, riskLevel, JSON.stringify([reason]), now);
  }

  function getTaskRiskSummary(taskId) {
    const files = db.prepare(`
      SELECT tfc.file_path, tfc.working_directory, frs.risk_level, frs.risk_reasons
      FROM task_file_changes tfc
      LEFT JOIN file_risk_scores frs ON tfc.file_path = frs.file_path AND tfc.working_directory = frs.working_directory
      WHERE tfc.task_id = ?
    `).all(taskId);

    const summary = { high: [], medium: [], low: [], unscored: [], overall_risk: 'low' };
    for (const f of files) {
      const level = f.risk_level || 'unscored';
      const bucket = summary[level] || summary.unscored;
      bucket.push({ file_path: f.file_path, risk_reasons: f.risk_reasons ? JSON.parse(f.risk_reasons) : [] });
    }
    if (summary.high.length > 0) summary.overall_risk = 'high';
    else if (summary.medium.length > 0) summary.overall_risk = 'medium';
    return summary;
  }

  return { upsertScore, getFileRisk, getFilesAtRisk, setManualOverride, getTaskRiskSummary };
}

module.exports = { createFileRisk, RISK_LEVELS, RISK_LEVEL_ORDER };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/file-risk.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Add table to schema-tables.js**

Add `'file_risk_scores'` to the `VALID_TABLE_NAMES` Set near the top of `server/db/schema-tables.js`.

Then add the CREATE TABLE statement inside `createTables()`, after the `users` table (after line ~3178):

```js
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL,
        scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_level ON file_risk_scores(risk_level)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_risk_scores_path ON file_risk_scores(file_path)');
  } catch (e) {
    logger.debug(`Schema migration (file_risk_scores): ${e.message}`);
  }
```

- [ ] **Step 6: Add migration to schema-migrations.js**

Add the same CREATE TABLE + indexes in `runMigrations()` just before the `migrateModelAgnostic(db)` call (before line ~645). Use the try/catch pattern matching existing late-lifecycle table additions.

- [ ] **Step 7: Commit**

```bash
git add server/db/file-risk.js server/tests/file-risk.test.js server/db/schema-tables.js server/db/schema-migrations.js
git commit -m "feat(evidence-risk): add file_risk_scores table and DB module

Introduces the file-risk scoring database layer: upsert, query,
manual override, and task-level risk summary aggregation."
```

---

### Task 2: Risk Scoring Engine

**Files:**
- Create: `server/db/file-risk-patterns.js`
- Create: `server/tests/file-risk-patterns.test.js`

- [ ] **Step 1: Write failing test for static pattern matching**

```js
// server/tests/file-risk-patterns.test.js
const { describe, it, expect } = require('vitest');

describe('file-risk-patterns', () => {
  let scoreFilePath;

  beforeEach(() => {
    const { scoreFileByPath } = require('../db/file-risk-patterns');
    scoreFilePath = scoreFileByPath;
  });

  describe('high risk patterns', () => {
    it.each([
      ['server/auth/session.js', 'auth_module'],
      ['src/authentication/login.ts', 'auth_module'],
      ['lib/authorization/rbac.js', 'auth_module'],
      ['server/crypto-utils.js', 'crypto_module'],
      ['src/encrypt-data.ts', 'crypto_module'],
      ['db/schema/users.sql', 'schema_change'],
      ['prisma/migrations/001.prisma', 'schema_change'],
      ['server/.env.production', 'secrets_adjacent'],
      ['src/credential-store.js', 'secrets_adjacent'],
      ['server/api/routes/users.js', 'public_api'],
      ['src/controllers/auth.ts', 'public_api'],
      ['server/payment/stripe.js', 'financial_module'],
      ['src/billing/invoice.ts', 'financial_module'],
      ['server/permission-check.js', 'access_control'],
      ['src/rbac/roles.ts', 'access_control'],
    ])('%s should be high risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('medium risk patterns', () => {
    it.each([
      ['server/middleware/cors.js', 'cross_cutting'],
      ['src/hooks/useAuth.ts', 'cross_cutting'],
      ['server/config/database.js', 'configuration'],
      ['src/cache-manager.js', 'stateful_module'],
      ['server/queue/worker.js', 'async_infra'],
    ])('%s should be medium risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('medium');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('low risk patterns', () => {
    it.each([
      ['tests/unit/auth.test.js', 'test_file'],
      ['src/__tests__/utils.spec.ts', 'test_file'],
      ['docs/README.md', 'documentation'],
      ['src/styles/main.css', 'styling'],
    ])('%s should be low risk with reason %s', (filePath, expectedReason) => {
      const result = scoreFilePath(filePath);
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toContain(expectedReason);
    });
  });

  describe('precedence', () => {
    it('high beats medium when both match', () => {
      const result = scoreFilePath('server/auth/config.js');
      expect(result.risk_level).toBe('high');
    });

    it('test files are low even if path contains crypto keyword', () => {
      const result = scoreFilePath('tests/crypto-utils.test.js');
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toContain('test_file');
    });

    it('unmatched files default to low with no reasons', () => {
      const result = scoreFilePath('src/utils/format-date.js');
      expect(result.risk_level).toBe('low');
      expect(result.risk_reasons).toHaveLength(0);
    });
  });

  describe('scoreFiles batch', () => {
    it('scores multiple files and returns per-file results', () => {
      const { scoreFilesByPath } = require('../db/file-risk-patterns');
      const results = scoreFilesByPath([
        'server/auth/session.js',
        'src/utils/format.js',
        'docs/README.md',
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].risk_level).toBe('high');
      expect(results[1].risk_level).toBe('low');
      expect(results[2].risk_level).toBe('low');
    });
  });

  describe('custom patterns', () => {
    it('merges custom high-risk patterns with built-in', () => {
      const { scoreFileByPath: customScore } = require('../db/file-risk-patterns');
      const result = customScore('src/special/handler.js', {
        high: [{ patterns: ['**/special/**'], reason: 'special_zone' }],
      });
      expect(result.risk_level).toBe('high');
      expect(result.risk_reasons).toContain('special_zone');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/file-risk-patterns.test.js`
Expected: FAIL — `Cannot find module '../db/file-risk-patterns'`

- [ ] **Step 3: Implement `server/db/file-risk-patterns.js`**

```js
// server/db/file-risk-patterns.js
'use strict';

const { minimatch } = require('minimatch');

const BUILTIN_RULES = {
  high: [
    { patterns: ['**/auth/**', '**/authentication/**', '**/authorization/**'], reason: 'auth_module' },
    { patterns: ['**/*crypto*', '**/*encrypt*', '**/*decrypt*', '**/*hash*'], reason: 'crypto_module', excludeTests: true },
    { patterns: ['**/*schema*', '**/migration*', '**/*.sql', '**/*.prisma'], reason: 'schema_change' },
    { patterns: ['**/*secret*', '**/.env*', '**/*credential*', '**/*token*'], reason: 'secrets_adjacent' },
    { patterns: ['**/api/routes*', '**/controllers/**', '**/endpoints/**'], reason: 'public_api' },
    { patterns: ['**/*payment*', '**/*billing*', '**/*subscription*'], reason: 'financial_module' },
    { patterns: ['**/*permission*', '**/*rbac*', '**/*acl*', '**/*role*'], reason: 'access_control' },
  ],
  medium: [
    { patterns: ['**/middleware/**', '**/hooks/**', '**/interceptors/**'], reason: 'cross_cutting' },
    { patterns: ['**/*config*', '**/settings*'], reason: 'configuration', excludePatterns: ['**/*lock*', '**/node_modules/**'] },
    { patterns: ['**/*cache*', '**/*session*', '**/*state*'], reason: 'stateful_module' },
    { patterns: ['**/*queue*', '**/*worker*', '**/*job*'], reason: 'async_infra' },
  ],
  low: [
    { patterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], reason: 'test_file' },
    { patterns: ['**/*.md', '**/docs/**', '**/README*'], reason: 'documentation' },
    { patterns: ['**/*.css', '**/*.scss', '**/*.less'], reason: 'styling' },
  ],
};

const TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];

function isTestFile(filePath) {
  return TEST_PATTERNS.some(p => minimatch(filePath, p, { dot: true }));
}

function matchesAny(filePath, patterns) {
  return patterns.some(p => minimatch(filePath, p, { dot: true }));
}

function scoreFileByPath(filePath, customPatterns = {}) {
  const reasons = { high: [], medium: [], low: [] };
  const testFile = isTestFile(filePath);

  for (const level of ['high', 'medium', 'low']) {
    const rules = [...BUILTIN_RULES[level], ...(customPatterns[level] || [])];
    for (const rule of rules) {
      if (rule.excludeTests && testFile) continue;
      if (rule.excludePatterns && matchesAny(filePath, rule.excludePatterns)) continue;
      const patterns = rule.patterns || (rule.pattern ? [rule.pattern] : []);
      if (matchesAny(filePath, patterns)) {
        reasons[level].push(rule.reason);
      }
    }
  }

  if (reasons.high.length > 0) return { risk_level: 'high', risk_reasons: [...new Set(reasons.high)] };
  if (reasons.medium.length > 0) return { risk_level: 'medium', risk_reasons: [...new Set(reasons.medium)] };
  if (reasons.low.length > 0) return { risk_level: 'low', risk_reasons: [...new Set(reasons.low)] };
  return { risk_level: 'low', risk_reasons: [] };
}

function scoreFilesByPath(filePaths, customPatterns = {}) {
  return filePaths.map(fp => ({ file_path: fp, ...scoreFileByPath(fp, customPatterns) }));
}

module.exports = { scoreFileByPath, scoreFilesByPath, BUILTIN_RULES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/file-risk-patterns.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/db/file-risk-patterns.js server/tests/file-risk-patterns.test.js
git commit -m "feat(evidence-risk): add file risk pattern matching engine

Static glob-based scoring: high/medium/low risk with reason tags.
Supports custom patterns, test-file exclusion, and batch scoring."
```

---

### Task 3: Policy Adapter

**Files:**
- Create: `server/policy-engine/adapters/file-risk.js`
- Create: `server/tests/file-risk-adapter.test.js`

- [ ] **Step 1: Write failing test for the adapter**

```js
// server/tests/file-risk-adapter.test.js
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('file-risk policy adapter', () => {
  let db;
  let adapter;
  let fileRisk;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL, working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL, risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1, scored_at TEXT NOT NULL, scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec(`
      CREATE TABLE task_file_changes (
        id INTEGER PRIMARY KEY, task_id TEXT, file_path TEXT,
        change_type TEXT, file_size_bytes INTEGER, working_directory TEXT,
        relative_path TEXT, is_outside_workdir INTEGER, created_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE file_baselines (
        id INTEGER PRIMARY KEY, file_path TEXT, working_directory TEXT,
        size_bytes INTEGER, line_count INTEGER, checksum TEXT,
        captured_at TEXT, task_id TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);

    const { createFileRisk } = require('../db/file-risk');
    fileRisk = createFileRisk({ db });

    const { createFileRiskAdapter } = require('../policy-engine/adapters/file-risk');
    adapter = createFileRiskAdapter({ db, fileRisk });
  });

  it('collectEvidence scores changed files and returns evidence', () => {
    const context = {
      stage: 'task_complete',
      changed_files: ['server/auth/session.js', 'src/utils/format.js'],
      project_path: '/project',
    };

    const evidence = adapter.collectEvidence(context);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].type).toBe('file_risk_assessed');
    expect(evidence[0].satisfied).toBe(true);
    expect(evidence[0].high_risk_files).toHaveLength(1);
    expect(evidence[0].high_risk_files[0]).toBe('server/auth/session.js');
  });

  it('scoreAndPersist writes scores to DB', () => {
    adapter.scoreAndPersist(['server/auth/session.js', 'docs/README.md'], '/project');

    const high = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(high.risk_level).toBe('high');

    const low = fileRisk.getFileRisk('docs/README.md', '/project');
    expect(low.risk_level).toBe('low');
  });

  it('respects manual overrides — does not overwrite auto_scored=0', () => {
    fileRisk.setManualOverride('src/utils/format.js', '/project', 'high', 'custom-reason');
    adapter.scoreAndPersist(['src/utils/format.js'], '/project');

    const result = fileRisk.getFileRisk('src/utils/format.js', '/project');
    expect(result.risk_level).toBe('high');
    expect(result.auto_scored).toBe(0);
  });

  it('returns empty evidence when no files provided', () => {
    const evidence = adapter.collectEvidence({ stage: 'task_complete', changed_files: [], project_path: '/p' });
    expect(evidence[0].high_risk_files).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/file-risk-adapter.test.js`
Expected: FAIL — `Cannot find module '../policy-engine/adapters/file-risk'`

- [ ] **Step 3: Implement `server/policy-engine/adapters/file-risk.js`**

```js
// server/policy-engine/adapters/file-risk.js
'use strict';

const { scoreFilesByPath } = require('../../db/file-risk-patterns');

function createFileRiskAdapter({ db, fileRisk, customPatterns = {} }) {

  function scoreAndPersist(filePaths, workingDirectory, taskId) {
    const scored = scoreFilesByPath(filePaths, customPatterns);
    for (const s of scored) {
      fileRisk.upsertScore({
        file_path: s.file_path,
        working_directory: workingDirectory,
        risk_level: s.risk_level,
        risk_reasons: JSON.stringify(s.risk_reasons),
        scored_by: taskId || 'pattern',
      });
    }
    return scored;
  }

  function collectEvidence(context) {
    const files = context.changed_files || [];
    const workDir = context.project_path || '';
    const scored = files.length > 0 ? scoreAndPersist(files, workDir) : [];

    const high = scored.filter(s => s.risk_level === 'high').map(s => s.file_path);
    const medium = scored.filter(s => s.risk_level === 'medium').map(s => s.file_path);
    const low = scored.filter(s => s.risk_level === 'low').map(s => s.file_path);

    return [{
      type: 'file_risk_assessed',
      available: true,
      satisfied: true,
      high_risk_files: high,
      medium_risk_files: medium,
      low_risk_files: low,
      total_files: files.length,
    }];
  }

  return { collectEvidence, scoreAndPersist };
}

module.exports = { createFileRiskAdapter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/file-risk-adapter.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/policy-engine/adapters/file-risk.js server/tests/file-risk-adapter.test.js
git commit -m "feat(evidence-risk): add file-risk policy adapter

Scores changed files via pattern matching, persists to DB, returns
structured evidence for policy engine evaluation."
```

---

### Task 4: MCP Tools and Container Wiring

**Files:**
- Create: `server/tool-defs/evidence-risk-defs.js`
- Create: `server/handlers/evidence-risk-handlers.js`
- Modify: `server/tools.js` (add to TOOLS + HANDLER_MODULES arrays)
- Modify: `server/container.js` (register new services)

- [ ] **Step 1: Create tool definitions for file risk**

```js
// server/tool-defs/evidence-risk-defs.js
'use strict';

module.exports = [
  {
    name: 'get_file_risk',
    description: 'Get the risk score for a single file. Returns risk_level (high/medium/low), reasons, and whether it was auto-scored or manually overridden.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file (relative to working directory)' },
        working_directory: { type: 'string', description: 'Project working directory' },
      },
      required: ['file_path', 'working_directory'],
    },
  },
  {
    name: 'get_task_risk_summary',
    description: 'Get risk breakdown for all files touched by a task. Returns files grouped by risk level and an overall_risk rating.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to summarize' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'set_file_risk_override',
    description: 'Manually override the risk level for a file. Overrides persist across re-scoring until cleared.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        working_directory: { type: 'string' },
        risk_level: { type: 'string', enum: ['high', 'medium', 'low'] },
        reason: { type: 'string', description: 'Why this override was set' },
      },
      required: ['file_path', 'working_directory', 'risk_level', 'reason'],
    },
  },
  {
    name: 'get_high_risk_files',
    description: 'List all files at or above a given risk level in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string' },
        min_level: { type: 'string', enum: ['high', 'medium', 'low'], default: 'high' },
      },
      required: ['working_directory'],
    },
  },
];
```

- [ ] **Step 2: Create handlers for file risk tools**

```js
// server/handlers/evidence-risk-handlers.js
'use strict';

const { defaultContainer } = require('../container');

function getFileRiskService() {
  return defaultContainer.get('fileRisk');
}

async function handleGetFileRisk(args) {
  const fileRisk = getFileRiskService();
  const result = fileRisk.getFileRisk(args.file_path, args.working_directory);
  if (!result) {
    return { content: [{ type: 'text', text: JSON.stringify({ risk_level: 'unscored', message: 'File has not been scored yet. Risk is scored when a task touches the file.' }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, risk_reasons: JSON.parse(result.risk_reasons) }) }] };
}

async function handleGetTaskRiskSummary(args) {
  const fileRisk = getFileRiskService();
  const summary = fileRisk.getTaskRiskSummary(args.task_id);
  return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
}

async function handleSetFileRiskOverride(args) {
  const fileRisk = getFileRiskService();
  fileRisk.setManualOverride(args.file_path, args.working_directory, args.risk_level, args.reason);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, file_path: args.file_path, risk_level: args.risk_level, reason: args.reason }) }] };
}

async function handleGetHighRiskFiles(args) {
  const fileRisk = getFileRiskService();
  const files = fileRisk.getFilesAtRisk(args.working_directory, args.min_level || 'high');
  const parsed = files.map(f => ({ ...f, risk_reasons: JSON.parse(f.risk_reasons) }));
  return { content: [{ type: 'text', text: JSON.stringify({ count: parsed.length, files: parsed }) }] };
}

module.exports = { handleGetFileRisk, handleGetTaskRiskSummary, handleSetFileRiskOverride, handleGetHighRiskFiles };
```

- [ ] **Step 3: Wire into tools.js**

In `server/tools.js`:
- Add `...require('./tool-defs/evidence-risk-defs'),` to the TOOLS array (before the closing `];` at line ~50)
- Add `require('./handlers/evidence-risk-handlers'),` to HANDLER_MODULES (before the closing `];` at line ~120)

- [ ] **Step 4: Register in container.js**

In `server/container.js`, inside `initModules()`, add after the policy adapter registrations (after line ~452):

```js
// File Risk — Evidence & Risk Engine
if (!_defaultContainer.has('fileRisk')) {
  const { createFileRisk } = require('./db/file-risk');
  _defaultContainer.registerValue('fileRisk', createFileRisk({ db }));
}
if (!_defaultContainer.has('fileRiskAdapter')) {
  const { createFileRiskAdapter } = require('./policy-engine/adapters/file-risk');
  const fileRisk = _defaultContainer.get('fileRisk');
  _defaultContainer.registerValue('fileRiskAdapter', createFileRiskAdapter({ db, fileRisk }));
}
```

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/evidence-risk-defs.js server/handlers/evidence-risk-handlers.js server/tools.js server/container.js
git commit -m "feat(evidence-risk): wire file-risk MCP tools and DI registration

4 MCP tools: get_file_risk, get_task_risk_summary, set_file_risk_override,
get_high_risk_files. Registered fileRisk + fileRiskAdapter in container."
```

---

## Phase 2: Verification Ledger

### Task 5: Schema and DB Module

**Files:**
- Modify: `server/db/schema-tables.js` (add table + VALID_TABLE_NAMES)
- Modify: `server/db/schema-migrations.js` (add migration)
- Create: `server/db/verification-ledger.js`
- Create: `server/tests/verification-ledger.test.js`

- [ ] **Step 1: Write failing test for verification ledger DB module**

```js
// server/tests/verification-ledger.test.js
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('verification-ledger', () => {
  let db;
  let ledger;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        workflow_id TEXT,
        phase TEXT NOT NULL,
        check_name TEXT NOT NULL,
        tool TEXT,
        command TEXT,
        exit_code INTEGER,
        output_snippet TEXT,
        passed INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX idx_verif_checks_task ON verification_checks(task_id)');
    db.exec('CREATE INDEX idx_verif_checks_phase ON verification_checks(phase)');

    const { createVerificationLedger } = require('../db/verification-ledger');
    ledger = createVerificationLedger({ db });
  });

  it('insertCheck writes a single row', () => {
    ledger.insertCheck({
      task_id: 'task-1',
      phase: 'after',
      check_name: 'build',
      tool: 'tsc',
      command: 'npx tsc --noEmit',
      exit_code: 0,
      output_snippet: 'Build succeeded',
      passed: 1,
      duration_ms: 1200,
    });

    const rows = db.prepare('SELECT * FROM verification_checks WHERE task_id = ?').all('task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].check_name).toBe('build');
    expect(rows[0].passed).toBe(1);
  });

  it('insertChecks batch-inserts in a transaction', () => {
    const checks = [
      { task_id: 'task-1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1 },
      { task_id: 'task-1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 0, exit_code: 1, output_snippet: '2 tests failed' },
      { task_id: 'task-1', phase: 'after', check_name: 'safeguard', tool: 'safeguard-gates', passed: 1 },
    ];
    ledger.insertChecks(checks);

    const rows = db.prepare('SELECT * FROM verification_checks WHERE task_id = ?').all('task-1');
    expect(rows).toHaveLength(3);
  });

  it('getChecksForTask returns all checks, filterable by phase and check_name', () => {
    ledger.insertCheck({ task_id: 't1', phase: 'baseline', check_name: 'build', tool: 'tsc', passed: 1 });
    ledger.insertCheck({ task_id: 't1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1 });
    ledger.insertCheck({ task_id: 't1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 0 });
    ledger.insertCheck({ task_id: 't1', phase: 'review', check_name: 'adversarial_review', tool: 'deepinfra', passed: 1 });

    expect(ledger.getChecksForTask('t1')).toHaveLength(4);
    expect(ledger.getChecksForTask('t1', { phase: 'after' })).toHaveLength(2);
    expect(ledger.getChecksForTask('t1', { checkName: 'build' })).toHaveLength(2);
    expect(ledger.getChecksForTask('t1', { phase: 'after', checkName: 'test' })).toHaveLength(1);
  });

  it('getCheckSummary aggregates across a workflow', () => {
    ledger.insertCheck({ task_id: 't1', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 1 });
    ledger.insertCheck({ task_id: 't2', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 1 });
    ledger.insertCheck({ task_id: 't3', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 0 });
    ledger.insertCheck({ task_id: 't1', workflow_id: 'wf1', phase: 'after', check_name: 'test', passed: 1 });

    const summary = ledger.getCheckSummary('wf1');
    expect(summary.build).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(summary.test).toEqual({ total: 1, passed: 1, failed: 0 });
  });

  it('pruneOldChecks deletes rows older than retention', () => {
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    db.prepare('INSERT INTO verification_checks (task_id, phase, check_name, passed, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('old-task', 'after', 'build', 1, old);
    ledger.insertCheck({ task_id: 'new-task', phase: 'after', check_name: 'build', passed: 1 });

    const deleted = ledger.pruneOldChecks(90);
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM verification_checks').get().c).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/verification-ledger.test.js`
Expected: FAIL — `Cannot find module '../db/verification-ledger'`

- [ ] **Step 3: Implement `server/db/verification-ledger.js`**

```js
// server/db/verification-ledger.js
'use strict';

function createVerificationLedger({ db }) {
  function insertCheck(check) {
    const now = check.created_at || new Date().toISOString();
    db.prepare(`
      INSERT INTO verification_checks (task_id, workflow_id, phase, check_name, tool, command, exit_code, output_snippet, passed, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      check.task_id, check.workflow_id || null, check.phase, check.check_name,
      check.tool || null, check.command || null, check.exit_code ?? null,
      check.output_snippet || null, check.passed, check.duration_ms || null, now
    );
  }

  function insertChecks(checks) {
    const tx = db.transaction(() => {
      for (const c of checks) insertCheck(c);
    });
    tx();
  }

  function getChecksForTask(taskId, filters = {}) {
    let sql = 'SELECT * FROM verification_checks WHERE task_id = ?';
    const params = [taskId];
    if (filters.phase) { sql += ' AND phase = ?'; params.push(filters.phase); }
    if (filters.checkName) { sql += ' AND check_name = ?'; params.push(filters.checkName); }
    sql += ' ORDER BY created_at ASC';
    return db.prepare(sql).all(...params);
  }

  function getCheckSummary(workflowId) {
    const rows = db.prepare(`
      SELECT check_name, passed, COUNT(*) as cnt
      FROM verification_checks
      WHERE workflow_id = ?
      GROUP BY check_name, passed
    `).all(workflowId);

    const summary = {};
    for (const row of rows) {
      if (!summary[row.check_name]) summary[row.check_name] = { total: 0, passed: 0, failed: 0 };
      summary[row.check_name].total += row.cnt;
      if (row.passed) summary[row.check_name].passed += row.cnt;
      else summary[row.check_name].failed += row.cnt;
    }
    return summary;
  }

  function pruneOldChecks(retentionDays = 90) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = db.prepare('DELETE FROM verification_checks WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  return { insertCheck, insertChecks, getChecksForTask, getCheckSummary, pruneOldChecks };
}

module.exports = { createVerificationLedger };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/verification-ledger.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Add table to schema-tables.js and schema-migrations.js**

Add `'verification_checks'` to `VALID_TABLE_NAMES` in `schema-tables.js`.

Add the CREATE TABLE + indexes in both `createTables()` (after the `file_risk_scores` block) and `runMigrations()` (before `migrateModelAgnostic`):

```js
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        workflow_id TEXT,
        phase TEXT NOT NULL,
        check_name TEXT NOT NULL,
        tool TEXT,
        command TEXT,
        exit_code INTEGER,
        output_snippet TEXT,
        passed INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_task ON verification_checks(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verif_checks_phase ON verification_checks(phase)');
  } catch (e) {
    logger.debug(`Schema migration (verification_checks): ${e.message}`);
  }
```

- [ ] **Step 6: Commit**

```bash
git add server/db/verification-ledger.js server/tests/verification-ledger.test.js server/db/schema-tables.js server/db/schema-migrations.js
git commit -m "feat(evidence-risk): add verification_checks table and ledger DB module

INSERT-based verification ledger: per-check recording, task/workflow
queries, workflow summaries, and retention-based pruning."
```

---

### Task 6: Verification Ledger Finalizer Stage

**Files:**
- Create: `server/execution/verification-ledger-stage.js`
- Create: `server/tests/verification-ledger-stage.test.js`

- [ ] **Step 1: Write failing test for the stage**

```js
// server/tests/verification-ledger-stage.test.js
const { describe, it, expect, beforeEach, vi } = require('vitest');

describe('verification-ledger-stage', () => {
  let stage;
  let mockLedger;
  let mockProjectConfig;

  beforeEach(() => {
    vi.resetModules();

    mockLedger = {
      insertChecks: vi.fn(),
    };

    mockProjectConfig = {
      getProjectConfig: vi.fn().mockReturnValue({ verification_ledger: true }),
    };

    const { createVerificationLedgerStage } = require('../execution/verification-ledger-stage');
    stage = createVerificationLedgerStage({ verificationLedger: mockLedger, projectConfigCore: mockProjectConfig });
  });

  it('converts validationStages into ledger checks', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { workflow_id: 'wf-1', working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      validationStages: {
        safeguard_checks: { outcome: 'no_change', duration_ms: 50 },
        auto_verify_retry: { outcome: 'no_change', duration_ms: 1200 },
      },
      filesModified: ['src/app.js'],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).toHaveBeenCalledTimes(1);
    const checks = mockLedger.insertChecks.mock.calls[0][0];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every(c => c.task_id === 'task-1')).toBe(true);
    expect(checks.every(c => c.phase === 'after')).toBe(true);
  });

  it('maps error outcomes to passed=0', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'failed',
      code: 1,
      validationStages: {
        safeguard_checks: { outcome: 'error', error: 'File truncation detected', duration_ms: 30 },
      },
      filesModified: [],
    };

    await stage(ctx);

    const checks = mockLedger.insertChecks.mock.calls[0][0];
    const safeguard = checks.find(c => c.check_name === 'safeguard_checks');
    expect(safeguard.passed).toBe(0);
    expect(safeguard.output_snippet).toContain('File truncation');
  });

  it('no-ops when verification_ledger is disabled in project config', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ verification_ledger: false });

    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      validationStages: { safeguard_checks: { outcome: 'no_change' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).not.toHaveBeenCalled();
  });

  it('no-ops when per-task metadata disables ledger', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: JSON.stringify({ verification_ledger: false }) },
      status: 'completed',
      code: 0,
      validationStages: { safeguard_checks: { outcome: 'no_change' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(mockLedger.insertChecks).not.toHaveBeenCalled();
  });

  it('records verify_command result from metadata when available', async () => {
    const ctx = {
      taskId: 'task-1',
      task: {
        working_directory: '/project',
        metadata: JSON.stringify({
          finalization: {
            verify_command_result: {
              command: 'npx tsc --noEmit',
              exitCode: 0,
              output: 'Build succeeded',
              durationMs: 2500,
            },
          },
        }),
      },
      status: 'completed',
      code: 0,
      validationStages: {},
      filesModified: [],
    };

    await stage(ctx);

    const checks = mockLedger.insertChecks.mock.calls[0][0];
    const verify = checks.find(c => c.check_name === 'verify_command');
    expect(verify).toBeTruthy();
    expect(verify.command).toBe('npx tsc --noEmit');
    expect(verify.exit_code).toBe(0);
    expect(verify.passed).toBe(1);
  });

  it('never mutates ctx.status or ctx.earlyExit', async () => {
    const ctx = {
      taskId: 'task-1',
      task: { working_directory: '/project', metadata: '{}' },
      status: 'completed',
      code: 0,
      earlyExit: false,
      validationStages: { safeguard_checks: { outcome: 'error' } },
      filesModified: [],
    };

    await stage(ctx);

    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/verification-ledger-stage.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement `server/execution/verification-ledger-stage.js`**

```js
// server/execution/verification-ledger-stage.js
'use strict';

const PASSING_OUTCOMES = new Set(['no_change', 'early_exit']);
const FAILING_OUTCOMES = new Set(['error', 'status:failed']);

function createVerificationLedgerStage({ verificationLedger, projectConfigCore }) {

  return async function verificationLedgerStage(ctx) {
    // Check project-level config
    const projectConfig = projectConfigCore.getProjectConfig(ctx.task?.working_directory);
    if (projectConfig && projectConfig.verification_ledger === false) return;
    if (projectConfig && !projectConfig.verification_ledger) return; // off by default

    // Check per-task override
    let metadata = {};
    try { metadata = JSON.parse(ctx.task?.metadata || '{}'); } catch (_) { /* ignore */ }
    if (metadata.verification_ledger === false) return;

    const checks = [];
    const workflowId = ctx.task?.workflow_id || null;

    // Convert each validation stage outcome to a ledger check
    for (const [stageName, outcome] of Object.entries(ctx.validationStages || {})) {
      if (!outcome || outcome.outcome === 'skipped') continue;

      const passed = PASSING_OUTCOMES.has(outcome.outcome) ? 1 : 0;
      checks.push({
        task_id: ctx.taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: stageName,
        tool: stageName,
        exit_code: passed ? 0 : 1,
        output_snippet: outcome.error ? String(outcome.error).slice(0, 2000) : null,
        passed,
        duration_ms: outcome.duration_ms || null,
      });
    }

    // Record verify_command result if available
    const finalization = metadata.finalization || {};
    const verifyResult = finalization.verify_command_result;
    if (verifyResult) {
      checks.push({
        task_id: ctx.taskId,
        workflow_id: workflowId,
        phase: 'after',
        check_name: 'verify_command',
        tool: 'verify_command',
        command: verifyResult.command || null,
        exit_code: verifyResult.exitCode ?? null,
        output_snippet: verifyResult.output ? String(verifyResult.output).slice(0, 2000) : null,
        passed: verifyResult.exitCode === 0 ? 1 : 0,
        duration_ms: verifyResult.durationMs || null,
      });
    }

    if (checks.length > 0) {
      verificationLedger.insertChecks(checks);
    }
  };
}

module.exports = { createVerificationLedgerStage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/verification-ledger-stage.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/verification-ledger-stage.js server/tests/verification-ledger-stage.test.js
git commit -m "feat(evidence-risk): add verification ledger finalizer stage

Read-only pipeline stage that converts validationStages + verify_command
results into structured verification_checks rows. Never mutates ctx."
```

---

### Task 7: Verification Ledger MCP Tools and Wiring

**Files:**
- Modify: `server/tool-defs/evidence-risk-defs.js` (add ledger tool defs)
- Modify: `server/handlers/evidence-risk-handlers.js` (add ledger handlers)
- Modify: `server/container.js` (register ledger)
- Modify: `server/db/schema-migrations.js` (add project_config column)

- [ ] **Step 1: Add ledger tool definitions to evidence-risk-defs.js**

Append to the existing array in `server/tool-defs/evidence-risk-defs.js`:

```js
  {
    name: 'get_verification_ledger',
    description: 'Query verification checks for a task. Returns all recorded build, test, lint, review, and safeguard check results.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        phase: { type: 'string', enum: ['baseline', 'after', 'review'], description: 'Filter by phase' },
        check_name: { type: 'string', description: 'Filter by check name (e.g. build, test, safeguard)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_verification_summary',
    description: 'Aggregate pass/fail counts for all check types across a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflow_id'],
    },
  },
```

- [ ] **Step 2: Add ledger handlers to evidence-risk-handlers.js**

Append to `server/handlers/evidence-risk-handlers.js`:

```js
function getLedgerService() {
  return defaultContainer.get('verificationLedger');
}

async function handleGetVerificationLedger(args) {
  const ledger = getLedgerService();
  const checks = ledger.getChecksForTask(args.task_id, { phase: args.phase, checkName: args.check_name });
  return { content: [{ type: 'text', text: JSON.stringify({ task_id: args.task_id, checks, count: checks.length }) }] };
}

async function handleGetVerificationSummary(args) {
  const ledger = getLedgerService();
  const summary = ledger.getCheckSummary(args.workflow_id);
  return { content: [{ type: 'text', text: JSON.stringify({ workflow_id: args.workflow_id, summary }) }] };
}
```

Add to `module.exports`: `handleGetVerificationLedger, handleGetVerificationSummary`

- [ ] **Step 3: Register ledger in container.js**

Add after the fileRiskAdapter registration:

```js
// Verification Ledger — Evidence & Risk Engine
if (!_defaultContainer.has('verificationLedger')) {
  const { createVerificationLedger } = require('./db/verification-ledger');
  _defaultContainer.registerValue('verificationLedger', createVerificationLedger({ db }));
}
```

- [ ] **Step 4: Add `verification_ledger` column to project_config**

In `server/db/schema-migrations.js`, add before `migrateModelAgnostic`:

```js
safeAddColumn('project_config', 'verification_ledger INTEGER');
safeAddColumn('project_config', 'verification_ledger_retention_days INTEGER');
```

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/evidence-risk-defs.js server/handlers/evidence-risk-handlers.js server/container.js server/db/schema-migrations.js
git commit -m "feat(evidence-risk): wire verification ledger MCP tools and container

2 MCP tools: get_verification_ledger, get_verification_summary.
Registered verificationLedger in container. Added project_config columns."
```

---

## Phase 3: Adversarial Review

### Task 8: Schema and DB Module

**Files:**
- Modify: `server/db/schema-tables.js` (add table + VALID_TABLE_NAMES)
- Modify: `server/db/schema-migrations.js` (add migration)
- Create: `server/db/adversarial-reviews.js`
- Create: `server/tests/adversarial-reviews.test.js`

- [ ] **Step 1: Write failing test for adversarial reviews DB module**

```js
// server/tests/adversarial-reviews.test.js
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('adversarial-reviews', () => {
  let db;
  let reviews;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        review_task_id TEXT,
        reviewer_provider TEXT NOT NULL,
        reviewer_model TEXT,
        verdict TEXT,
        confidence TEXT,
        issues TEXT,
        diff_snippet TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX idx_adv_reviews_task ON adversarial_reviews(task_id)');

    const { createAdversarialReviews } = require('../db/adversarial-reviews');
    reviews = createAdversarialReviews({ db });
  });

  it('inserts and retrieves a review', () => {
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-task-1',
      reviewer_provider: 'deepinfra',
      reviewer_model: 'Qwen/Qwen2.5-72B-Instruct',
      verdict: 'concerns',
      confidence: 'medium',
      issues: JSON.stringify([{ file: 'auth.js', line: 42, severity: 'warning', category: 'security', description: 'test', suggestion: 'fix' }]),
      diff_snippet: '--- a/auth.js\n+++ b/auth.js',
      duration_ms: 15000,
    });

    const results = reviews.getReviewsForTask('task-1');
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('concerns');
    expect(results[0].reviewer_provider).toBe('deepinfra');
  });

  it('getReviewByReviewTaskId finds by spawned task ID', () => {
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-task-1',
      reviewer_provider: 'codex',
      verdict: 'approve',
      confidence: 'high',
      issues: '[]',
    });

    const result = reviews.getReviewByReviewTaskId('review-task-1');
    expect(result).toBeTruthy();
    expect(result.task_id).toBe('task-1');
  });

  it('getReviewStats aggregates verdicts', () => {
    reviews.insertReview({ task_id: 't1', reviewer_provider: 'deepinfra', verdict: 'approve', confidence: 'high', issues: '[]' });
    reviews.insertReview({ task_id: 't2', reviewer_provider: 'codex', verdict: 'reject', confidence: 'high', issues: '[]' });
    reviews.insertReview({ task_id: 't3', reviewer_provider: 'deepinfra', verdict: 'concerns', confidence: 'medium', issues: '[]' });

    const stats = reviews.getReviewStats();
    expect(stats.total).toBe(3);
    expect(stats.by_verdict.approve).toBe(1);
    expect(stats.by_verdict.reject).toBe(1);
    expect(stats.by_verdict.concerns).toBe(1);
  });

  it('returns empty array for unknown task', () => {
    expect(reviews.getReviewsForTask('no-such-task')).toEqual([]);
  });

  it('returns null for unknown review task', () => {
    expect(reviews.getReviewByReviewTaskId('no-such')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/adversarial-reviews.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement `server/db/adversarial-reviews.js`**

```js
// server/db/adversarial-reviews.js
'use strict';

function createAdversarialReviews({ db }) {
  function insertReview(review) {
    const now = review.created_at || new Date().toISOString();
    db.prepare(`
      INSERT INTO adversarial_reviews (task_id, review_task_id, reviewer_provider, reviewer_model, verdict, confidence, issues, diff_snippet, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.task_id, review.review_task_id || null, review.reviewer_provider,
      review.reviewer_model || null, review.verdict || null, review.confidence || null,
      review.issues || '[]', review.diff_snippet || null, review.duration_ms || null, now
    );
  }

  function getReviewsForTask(taskId) {
    return db.prepare('SELECT * FROM adversarial_reviews WHERE task_id = ? ORDER BY created_at DESC').all(taskId);
  }

  function getReviewByReviewTaskId(reviewTaskId) {
    return db.prepare('SELECT * FROM adversarial_reviews WHERE review_task_id = ?').get(reviewTaskId) || null;
  }

  function getReviewStats(since) {
    let sql = 'SELECT verdict, confidence, COUNT(*) as cnt FROM adversarial_reviews';
    const params = [];
    if (since) { sql += ' WHERE created_at >= ?'; params.push(since); }
    sql += ' GROUP BY verdict, confidence';
    const rows = db.prepare(sql).all(...params);

    const stats = { total: 0, by_verdict: {}, by_confidence: {} };
    for (const row of rows) {
      stats.total += row.cnt;
      stats.by_verdict[row.verdict] = (stats.by_verdict[row.verdict] || 0) + row.cnt;
      stats.by_confidence[row.confidence] = (stats.by_confidence[row.confidence] || 0) + row.cnt;
    }
    return stats;
  }

  return { insertReview, getReviewsForTask, getReviewByReviewTaskId, getReviewStats };
}

module.exports = { createAdversarialReviews };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/adversarial-reviews.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Add table to schema-tables.js and schema-migrations.js**

Add `'adversarial_reviews'` to `VALID_TABLE_NAMES`. Add CREATE TABLE + indexes in both `createTables()` and `runMigrations()`:

```js
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        review_task_id TEXT,
        reviewer_provider TEXT NOT NULL,
        reviewer_model TEXT,
        verdict TEXT,
        confidence TEXT,
        issues TEXT,
        diff_snippet TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_task ON adversarial_reviews(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_adv_reviews_verdict ON adversarial_reviews(verdict)');
  } catch (e) {
    logger.debug(`Schema migration (adversarial_reviews): ${e.message}`);
  }
```

- [ ] **Step 6: Add `adversarial_reviews` to cascade delete in task-core.js**

Add `'adversarial_reviews'` to the `childTables` array in `_cleanOrphanedTaskChildren()` at `server/db/task-core.js` (around line 832-844).

- [ ] **Step 7: Commit**

```bash
git add server/db/adversarial-reviews.js server/tests/adversarial-reviews.test.js server/db/schema-tables.js server/db/schema-migrations.js server/db/task-core.js
git commit -m "feat(evidence-risk): add adversarial_reviews table and DB module

CRUD for adversarial review results: insert, query by task/review-task,
aggregate stats by verdict/confidence. Cascade delete on task removal."
```

---

### Task 9: Adversarial Review Stage

**Files:**
- Create: `server/execution/adversarial-review-stage.js`
- Create: `server/tests/adversarial-review-stage.test.js`

- [ ] **Step 1: Write failing test for the stage**

```js
// server/tests/adversarial-review-stage.test.js
const { describe, it, expect, beforeEach, vi } = require('vitest');

describe('adversarial-review-stage', () => {
  let createStage;
  let mockAdversarialReviews;
  let mockFileRiskAdapter;
  let mockTaskCore;
  let mockTaskManager;
  let mockVerificationLedger;
  let mockProjectConfig;

  beforeEach(() => {
    vi.resetModules();

    mockAdversarialReviews = { insertReview: vi.fn() };
    mockFileRiskAdapter = { scoreAndPersist: vi.fn().mockReturnValue([]) };
    mockTaskCore = { createTask: vi.fn(), getTask: vi.fn(), updateTask: vi.fn() };
    mockTaskManager = { startTask: vi.fn().mockReturnValue({ started: true }) };
    mockVerificationLedger = { insertCheck: vi.fn() };
    mockProjectConfig = { getProjectConfig: vi.fn().mockReturnValue({ adversarial_review: 'always' }) };

    const mod = require('../execution/adversarial-review-stage');
    createStage = mod.createAdversarialReviewStage;
  });

  function makeCtx(overrides = {}) {
    return {
      taskId: 'task-1',
      task: {
        working_directory: '/project',
        provider: 'codex',
        task_description: 'Add login feature',
        metadata: '{}',
        workflow_id: null,
      },
      status: 'completed',
      code: 0,
      filesModified: ['src/auth.js'],
      earlyExit: false,
      validationStages: {},
      proc: { baselineCommit: null },
      ...overrides,
    };
  }

  function makeStage() {
    return createStage({
      adversarialReviews: mockAdversarialReviews,
      fileRiskAdapter: mockFileRiskAdapter,
      taskCore: mockTaskCore,
      taskManager: mockTaskManager,
      verificationLedger: mockVerificationLedger,
      projectConfigCore: mockProjectConfig,
    });
  }

  it('spawns an async review task when adversarial_review is always', async () => {
    const stage = makeStage();
    await stage(makeCtx());

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    const taskArg = mockTaskCore.createTask.mock.calls[0][0];
    expect(taskArg.task_description).toContain('hostile code reviewer');
    expect(taskArg.task_description).toContain('Add login feature');

    const meta = JSON.parse(taskArg.metadata);
    expect(meta.adversarial_review_task).toBe(true);
    expect(meta.adversarial_review_of_task_id).toBe('task-1');
    expect(meta.intended_provider).not.toBe('codex');
  });

  it('skips when task status is not completed', async () => {
    const stage = makeStage();
    await stage(makeCtx({ status: 'failed' }));
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('skips when task is itself a review task', async () => {
    const stage = makeStage();
    const ctx = makeCtx({
      task: { ...makeCtx().task, metadata: JSON.stringify({ adversarial_review_task: true }) },
    });
    await stage(ctx);
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('skips when adversarial_review is off', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'off' });
    const stage = makeStage();
    await stage(makeCtx());
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('in auto mode, triggers only when high-risk files exist', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'auto' });
    mockFileRiskAdapter.scoreAndPersist.mockReturnValue([
      { file_path: 'src/auth.js', risk_level: 'high', risk_reasons: ['auth_module'] },
    ]);

    const stage = makeStage();
    await stage(makeCtx());

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    const desc = mockTaskCore.createTask.mock.calls[0][0].task_description;
    expect(desc).toContain('auth_module');
  });

  it('in auto mode, skips when no high-risk files', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'auto' });
    mockFileRiskAdapter.scoreAndPersist.mockReturnValue([
      { file_path: 'src/utils.js', risk_level: 'low', risk_reasons: [] },
    ]);

    const stage = makeStage();
    await stage(makeCtx());
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('selects a different provider from the original task', async () => {
    const stage = makeStage();
    await stage(makeCtx({ task: { ...makeCtx().task, provider: 'deepinfra' } }));

    const meta = JSON.parse(mockTaskCore.createTask.mock.calls[0][0].metadata);
    expect(meta.intended_provider).not.toBe('deepinfra');
  });

  it('never sets earlyExit in async mode', async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    await stage(ctx);
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/adversarial-review-stage.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement `server/execution/adversarial-review-stage.js`**

```js
// server/execution/adversarial-review-stage.js
'use strict';

const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_REVIEW_CHAIN = ['codex', 'deepinfra', 'claude-cli', 'ollama'];
const DEFAULT_TIMEOUT_MINUTES = 30;

function createAdversarialReviewStage({
  adversarialReviews, fileRiskAdapter, taskCore, taskManager,
  verificationLedger, projectConfigCore,
}) {

  function selectReviewerProvider(originalProvider, chain) {
    for (const candidate of chain) {
      if (candidate !== originalProvider) return candidate;
    }
    return null;
  }

  function buildReviewPrompt(taskDescription, diff, highRiskFiles) {
    let prompt = `You are a hostile code reviewer. Your job is to FIND PROBLEMS, not approve.

Task description: ${taskDescription}
`;

    if (highRiskFiles && highRiskFiles.length > 0) {
      prompt += '\nHIGH-RISK FILES (pay special attention):\n';
      for (const f of highRiskFiles) {
        const reasons = Array.isArray(f.risk_reasons) ? f.risk_reasons.join(', ') : f.risk_reasons;
        prompt += `- ${f.file_path}: ${reasons}\n`;
      }
    }

    prompt += `
Diff:
${diff}

Respond with ONLY a JSON object:
{
  "verdict": "approve" | "reject" | "concerns",
  "confidence": "high" | "medium" | "low",
  "issues": [
    { "file": "...", "line": 42, "severity": "critical|warning|info",
      "category": "bug|security|logic|performance|style",
      "description": "...", "suggestion": "..." }
  ]
}

Rules:
- "approve" = no issues found worth flagging
- "concerns" = issues found but not blocking
- "reject" = critical issues that should block commit
- Only use "reject" for genuine bugs or security holes, not style preferences`;

    return prompt;
  }

  function collectDiff(workingDirectory, beforeSha) {
    try {
      const args = beforeSha ? ['diff', `${beforeSha}..HEAD`] : ['diff', 'HEAD~1'];
      const output = execFileSync('git', args, {
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      });
      const diffStr = output.toString('utf8');
      return diffStr.length > 50000 ? diffStr.slice(0, 50000) + '\n... (truncated)' : diffStr;
    } catch (e) {
      return null;
    }
  }

  return async function adversarialReviewStage(ctx) {
    if (ctx.status !== 'completed') return;

    let metadata = {};
    try { metadata = JSON.parse(ctx.task?.metadata || '{}'); } catch (_) { /* ignore */ }

    // Prevent infinite recursion
    if (metadata.review_task || metadata.adversarial_review_task) return;

    // Determine trigger
    const projectConfig = projectConfigCore.getProjectConfig(ctx.task?.working_directory) || {};
    const taskLevel = metadata.adversarial_review;
    const projectLevel = projectConfig.adversarial_review || 'off';

    let shouldRun = false;
    let highRiskFiles = [];

    if (taskLevel === true || taskLevel === 'true') {
      shouldRun = true;
    } else if (projectLevel === 'always') {
      shouldRun = true;
    } else if (projectLevel === 'auto') {
      const scored = fileRiskAdapter.scoreAndPersist(
        ctx.filesModified || [],
        ctx.task?.working_directory || '',
        ctx.taskId
      );
      highRiskFiles = scored.filter(s => s.risk_level === 'high');
      shouldRun = highRiskFiles.length > 0;
    }

    if (!shouldRun) return;

    // Score files for prompt context if not done yet
    if (highRiskFiles.length === 0 && (ctx.filesModified || []).length > 0) {
      const scored = fileRiskAdapter.scoreAndPersist(
        ctx.filesModified,
        ctx.task?.working_directory || '',
        ctx.taskId
      );
      highRiskFiles = scored.filter(s => s.risk_level === 'high');
    }

    // Select reviewer
    const chain = projectConfig.adversarial_review_chain
      ? (typeof projectConfig.adversarial_review_chain === 'string'
          ? JSON.parse(projectConfig.adversarial_review_chain)
          : projectConfig.adversarial_review_chain)
      : DEFAULT_REVIEW_CHAIN;
    const reviewerProvider = metadata.adversarial_reviewer
      || selectReviewerProvider(ctx.task?.provider, chain);

    if (!reviewerProvider) return;

    // Collect diff
    const diff = collectDiff(ctx.task?.working_directory, ctx.proc?.baselineCommit);
    if (!diff) return;

    // Build and spawn review task
    const reviewPrompt = buildReviewPrompt(
      ctx.task?.task_description || '',
      diff,
      highRiskFiles
    );

    const reviewTaskId = randomUUID();
    const reviewTask = {
      id: reviewTaskId,
      status: 'pending',
      task_description: reviewPrompt,
      working_directory: ctx.task?.working_directory,
      timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
      auto_approve: false,
      priority: 0,
      provider: null,
      metadata: JSON.stringify({
        intended_provider: reviewerProvider,
        user_provider_override: true,
        requested_provider: reviewerProvider,
        adversarial_review_task: true,
        adversarial_review_of_task_id: ctx.taskId,
        review_task: true,
      }),
    };

    taskCore.createTask(reviewTask);
    taskManager.startTask(reviewTaskId);

    // Mark original task (best effort)
    try {
      const updatedMeta = { ...metadata, adversarial_review_pending: true, adversarial_review_task_id: reviewTaskId };
      if (taskCore.updateTask) {
        taskCore.updateTask(ctx.taskId, { metadata: JSON.stringify(updatedMeta) });
      }
    } catch (_) { /* best effort */ }
  };
}

module.exports = { createAdversarialReviewStage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/adversarial-review-stage.test.js`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/execution/adversarial-review-stage.js server/tests/adversarial-review-stage.test.js
git commit -m "feat(evidence-risk): add adversarial review finalizer stage

Spawns review tasks on a different provider. Supports always/auto/off
modes. Auto mode uses file-risk scores to trigger on high-risk files.
Includes risk context in the review prompt for targeted review."
```

---

### Task 10: Adversarial Review MCP Tools and Wiring

**Files:**
- Modify: `server/tool-defs/evidence-risk-defs.js` (add review tool defs)
- Modify: `server/handlers/evidence-risk-handlers.js` (add review handlers)
- Modify: `server/container.js` (register adversarial reviews)
- Modify: `server/db/schema-migrations.js` (add project_config columns)

- [ ] **Step 1: Add adversarial review tool definitions to evidence-risk-defs.js**

Append to the array:

```js
  {
    name: 'get_adversarial_reviews',
    description: 'Get all adversarial reviews for a task. Returns reviewer provider, verdict, confidence, and detailed issues.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'request_adversarial_review',
    description: 'Manually trigger an adversarial review for any completed task. Spawns a review task on a different provider.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to review' },
        provider: { type: 'string', description: 'Specific provider to use for review (must differ from original)' },
        working_directory: { type: 'string', description: 'Project working directory' },
      },
      required: ['task_id', 'working_directory'],
    },
  },
```

- [ ] **Step 2: Add adversarial review handlers to evidence-risk-handlers.js**

Append to `server/handlers/evidence-risk-handlers.js`:

```js
function getAdversarialReviewsService() {
  return defaultContainer.get('adversarialReviews');
}

async function handleGetAdversarialReviews(args) {
  const svc = getAdversarialReviewsService();
  const reviews = svc.getReviewsForTask(args.task_id);
  const parsed = reviews.map(r => ({ ...r, issues: JSON.parse(r.issues || '[]') }));
  return { content: [{ type: 'text', text: JSON.stringify({ task_id: args.task_id, reviews: parsed, count: parsed.length }) }] };
}

async function handleRequestAdversarialReview(args) {
  const taskCore = defaultContainer.get('taskCore');
  const task = taskCore.getTask(args.task_id);
  if (!task) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }] };
  if (task.status !== 'completed') return { content: [{ type: 'text', text: JSON.stringify({ error: 'Task must be completed to review' }) }] };

  const { createAdversarialReviewStage } = require('../execution/adversarial-review-stage');
  const adversarialReviews = defaultContainer.get('adversarialReviews');
  const fileRiskAdapter = defaultContainer.get('fileRiskAdapter');
  const taskManager = defaultContainer.get('taskManager');
  const projectConfigCore = defaultContainer.get('projectConfigCore');
  const verificationLedger = defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null;

  let metadata = {};
  try { metadata = JSON.parse(task.metadata || '{}'); } catch (_) { /* ignore */ }

  const stage = createAdversarialReviewStage({
    adversarialReviews, fileRiskAdapter, taskCore, taskManager,
    verificationLedger, projectConfigCore,
  });

  const ctx = {
    taskId: args.task_id,
    task: { ...task, metadata: JSON.stringify({ ...metadata, adversarial_review: true, adversarial_reviewer: args.provider || undefined }) },
    status: 'completed',
    code: 0,
    filesModified: task.files_modified ? JSON.parse(task.files_modified) : [],
    earlyExit: false,
    validationStages: {},
    proc: { baselineCommit: task.git_before_sha },
  };

  await stage(ctx);

  return { content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: args.task_id, message: 'Adversarial review task spawned' }) }] };
}
```

Add to `module.exports`: `handleGetAdversarialReviews, handleRequestAdversarialReview`

- [ ] **Step 3: Register in container.js**

Add after the verificationLedger registration:

```js
// Adversarial Reviews — Evidence & Risk Engine
if (!_defaultContainer.has('adversarialReviews')) {
  const { createAdversarialReviews } = require('./db/adversarial-reviews');
  _defaultContainer.registerValue('adversarialReviews', createAdversarialReviews({ db }));
}
```

- [ ] **Step 4: Add project_config columns for adversarial review**

In `server/db/schema-migrations.js`, add before `migrateModelAgnostic`:

```js
safeAddColumn('project_config', 'adversarial_review TEXT');
safeAddColumn('project_config', 'adversarial_review_mode TEXT');
safeAddColumn('project_config', 'adversarial_review_chain TEXT');
safeAddColumn('project_config', 'adversarial_review_timeout_seconds INTEGER');
```

- [ ] **Step 5: Commit**

```bash
git add server/tool-defs/evidence-risk-defs.js server/handlers/evidence-risk-handlers.js server/container.js server/db/schema-migrations.js
git commit -m "feat(evidence-risk): wire adversarial review MCP tools and container

2 MCP tools: get_adversarial_reviews, request_adversarial_review.
Registered adversarialReviews in container. Added project_config columns
for review mode, chain, and timeout."
```

---

## Phase 4: Integration

### Task 11: Wire All Stages Into Task Finalizer

**Files:**
- Modify: `server/execution/task-finalizer.js` (add 2 new runStage calls + deps wiring)

- [ ] **Step 1: Read current task-finalizer.js around the insertion point**

Read `server/execution/task-finalizer.js` lines 455-500 to confirm exact line numbers for:
- `auto_verify_retry` runStage call (line ~461)
- `earlyExit` check block (lines ~462-471)
- `smart_diagnosis` runStage call (line ~475)

- [ ] **Step 2: Add verification_ledger stage call**

After the `auto_verify_retry` runStage call (line ~461) and BEFORE the `earlyExit` check (line ~462), insert:

```js
    await runStage(ctx, 'verification_ledger', deps.handleVerificationLedger, typeof deps.handleVerificationLedger === 'function');
```

- [ ] **Step 3: Add adversarial_review stage call**

After the `earlyExit` check block (line ~471) and BEFORE `smart_diagnosis` (line ~475), insert:

```js
    await runStage(ctx, 'adversarial_review', deps.handleAdversarialReview, typeof deps.handleAdversarialReview === 'function' && ctx.status === 'completed');
```

- [ ] **Step 4: Wire deps in the module that constructs the finalizer**

Search for where `task-finalizer.js` `init()` is called and `deps.handleAutoVerifyRetry` is assigned. Add the new stage handlers to the deps object:

```js
const { createVerificationLedgerStage } = require('./execution/verification-ledger-stage');
const { createAdversarialReviewStage } = require('./execution/adversarial-review-stage');

// Add to deps before init() call:
deps.handleVerificationLedger = createVerificationLedgerStage({
  verificationLedger: defaultContainer.get('verificationLedger'),
  projectConfigCore: defaultContainer.get('projectConfigCore'),
});
deps.handleAdversarialReview = createAdversarialReviewStage({
  adversarialReviews: defaultContainer.get('adversarialReviews'),
  fileRiskAdapter: defaultContainer.get('fileRiskAdapter'),
  taskCore: defaultContainer.get('taskCore'),
  taskManager: defaultContainer.get('taskManager'),
  verificationLedger: defaultContainer.has('verificationLedger') ? defaultContainer.get('verificationLedger') : null,
  projectConfigCore: defaultContainer.get('projectConfigCore'),
});
```

- [ ] **Step 5: Commit**

```bash
git add server/execution/task-finalizer.js
git commit -m "feat(evidence-risk): wire ledger + adversarial stages into finalizer pipeline

verification_ledger runs after auto_verify_retry (read-only, records checks).
adversarial_review runs after earlyExit check (spawns review on different provider).
Both no-op when unconfigured."
```

---

### Task 12: Extend Project Defaults

**Files:**
- Modify: `server/handlers/automation-handlers.js` (handleSetProjectDefaults + handleGetProjectDefaults)
- Modify: tool-defs file for `set_project_defaults` (add new inputSchema properties)

- [ ] **Step 1: Read current handleSetProjectDefaults to find insertion point**

Read `server/handlers/automation-handlers.js` lines 590-665 to find the last config key handler block.

- [ ] **Step 2: Add evidence-risk config keys to handleSetProjectDefaults**

After the last existing config key block and before the `projectConfigCore().setProjectConfig` call, add:

```js
  // Evidence & Risk Engine
  if (typeof args.verification_ledger === 'boolean') {
    configUpdate.verification_ledger = args.verification_ledger ? 1 : 0;
    changes.push(`Verification ledger: ${args.verification_ledger ? 'enabled' : 'disabled'}`);
  }
  if (args.verification_ledger_retention_days !== undefined) {
    configUpdate.verification_ledger_retention_days = args.verification_ledger_retention_days;
    changes.push(`Verification ledger retention: ${args.verification_ledger_retention_days} days`);
  }
  if (args.adversarial_review !== undefined) {
    const validModes = ['off', 'auto', 'always'];
    if (!validModes.includes(args.adversarial_review)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `adversarial_review must be one of: ${validModes.join(', ')}` }) }] };
    }
    configUpdate.adversarial_review = args.adversarial_review;
    changes.push(`Adversarial review: ${args.adversarial_review}`);
  }
  if (args.adversarial_review_mode !== undefined) {
    const validExecModes = ['async', 'blocking'];
    if (!validExecModes.includes(args.adversarial_review_mode)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `adversarial_review_mode must be one of: ${validExecModes.join(', ')}` }) }] };
    }
    configUpdate.adversarial_review_mode = args.adversarial_review_mode;
    changes.push(`Adversarial review mode: ${args.adversarial_review_mode}`);
  }
  if (args.adversarial_review_chain !== undefined) {
    configUpdate.adversarial_review_chain = JSON.stringify(args.adversarial_review_chain);
    changes.push(`Adversarial review chain: ${args.adversarial_review_chain.join(' -> ')}`);
  }
  if (args.adversarial_review_timeout_seconds !== undefined) {
    configUpdate.adversarial_review_timeout_seconds = args.adversarial_review_timeout_seconds;
    changes.push(`Adversarial review timeout: ${args.adversarial_review_timeout_seconds}s`);
  }
```

- [ ] **Step 3: Add to set_project_defaults inputSchema**

Find the tool definition for `set_project_defaults` (in `server/tool-defs/automation-defs.js` or wherever it lives). Add these properties:

```js
verification_ledger: { type: 'boolean', description: 'Enable structured verification ledger (default: false)' },
verification_ledger_retention_days: { type: 'number', description: 'Retention period for verification ledger data in days (default: 90)' },
adversarial_review: { type: 'string', enum: ['off', 'auto', 'always'], description: 'Adversarial review trigger mode (default: off). auto triggers on high-risk files.' },
adversarial_review_mode: { type: 'string', enum: ['async', 'blocking'], description: 'Whether review runs async or blocks task completion (default: async)' },
adversarial_review_chain: { type: 'array', items: { type: 'string' }, description: 'Provider fallback chain for adversarial reviews (default: codex, deepinfra, claude-cli, ollama)' },
adversarial_review_timeout_seconds: { type: 'number', description: 'Timeout for blocking mode reviews in seconds (default: 300)' },
```

- [ ] **Step 4: Ensure get_project_defaults includes new fields**

Read the `handleGetProjectDefaults` function and verify the new columns appear in the response. If it does `SELECT *` they'll appear automatically. If it cherry-picks fields, add the new ones.

- [ ] **Step 5: Commit**

```bash
git add server/handlers/automation-handlers.js server/tool-defs/automation-defs.js
git commit -m "feat(evidence-risk): extend set_project_defaults for evidence-risk config

New config keys: verification_ledger, verification_ledger_retention_days,
adversarial_review, adversarial_review_mode, adversarial_review_chain,
adversarial_review_timeout_seconds."
```

---

### Task 13: End-to-End Integration Test

**Files:**
- Create: `server/tests/evidence-risk-integration.test.js`

- [ ] **Step 1: Write integration test**

```js
// server/tests/evidence-risk-integration.test.js
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('evidence-risk integration', () => {
  let db;
  let fileRisk;
  let ledger;
  let reviews;
  let fileRiskAdapter;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL, risk_reasons TEXT NOT NULL, auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL, scored_by TEXT, UNIQUE(file_path, working_directory)
      );
      CREATE TABLE verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, workflow_id TEXT,
        phase TEXT NOT NULL, check_name TEXT NOT NULL, tool TEXT, command TEXT,
        exit_code INTEGER, output_snippet TEXT, passed INTEGER NOT NULL,
        duration_ms INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, review_task_id TEXT,
        reviewer_provider TEXT NOT NULL, reviewer_model TEXT, verdict TEXT, confidence TEXT,
        issues TEXT, diff_snippet TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE task_file_changes (
        id INTEGER PRIMARY KEY, task_id TEXT, file_path TEXT, change_type TEXT,
        file_size_bytes INTEGER, working_directory TEXT, relative_path TEXT,
        is_outside_workdir INTEGER, created_at TEXT
      );
    `);

    const { createFileRisk } = require('../db/file-risk');
    fileRisk = createFileRisk({ db });

    const { createVerificationLedger } = require('../db/verification-ledger');
    ledger = createVerificationLedger({ db });

    const { createAdversarialReviews } = require('../db/adversarial-reviews');
    reviews = createAdversarialReviews({ db });

    const { createFileRiskAdapter } = require('../policy-engine/adapters/file-risk');
    fileRiskAdapter = createFileRiskAdapter({ db, fileRisk });
  });

  it('file risk -> ledger -> adversarial review data flow', () => {
    // 1. Score files via adapter
    const scored = fileRiskAdapter.scoreAndPersist(
      ['server/auth/session.js', 'src/utils/format.js'],
      '/project',
      'task-1'
    );
    expect(scored[0].risk_level).toBe('high');
    expect(scored[1].risk_level).toBe('low');

    // 2. Scores persisted and queryable
    const risk = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(risk.risk_level).toBe('high');

    // 3. Ledger records checks
    ledger.insertChecks([
      { task_id: 'task-1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1, duration_ms: 1000 },
      { task_id: 'task-1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 1, duration_ms: 5000 },
    ]);
    expect(ledger.getChecksForTask('task-1')).toHaveLength(2);

    // 4. Adversarial review records result
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-1',
      reviewer_provider: 'deepinfra',
      verdict: 'concerns',
      confidence: 'medium',
      issues: JSON.stringify([{ file: 'server/auth/session.js', line: 42, severity: 'warning', category: 'security', description: 'Missing rate limit', suggestion: 'Add rate limiting' }]),
    });

    // 5. Review also goes into ledger
    ledger.insertCheck({
      task_id: 'task-1',
      phase: 'review',
      check_name: 'adversarial_review',
      tool: 'deepinfra',
      passed: 1,
    });

    // 6. Full ledger shows pipeline + review
    const allChecks = ledger.getChecksForTask('task-1');
    expect(allChecks).toHaveLength(3);
    expect(allChecks.filter(c => c.phase === 'after')).toHaveLength(2);
    expect(allChecks.filter(c => c.phase === 'review')).toHaveLength(1);

    // 7. Task risk summary via file_changes join
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'server/auth/session.js', '/project', 'modified', new Date().toISOString());
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'src/utils/format.js', '/project', 'modified', new Date().toISOString());

    const summary = fileRisk.getTaskRiskSummary('task-1');
    expect(summary.overall_risk).toBe('high');
    expect(summary.high).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd server && npx vitest run tests/evidence-risk-integration.test.js`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `cd server && npx vitest run`
Expected: All existing + new tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add server/tests/evidence-risk-integration.test.js
git commit -m "test(evidence-risk): add end-to-end integration test

Validates full data flow: file risk scoring -> verification ledger
recording -> adversarial review -> ledger integration."
```

---

## Summary — Phases 1-4 (Completed)

| Phase | Tasks | New Files | Modified Files |
|-------|-------|-----------|----------------|
| **1: File Risk** | 1-4 | 4 (db, patterns, adapter, tests) | schema-tables, schema-migrations, tools, container |
| **2: Verification Ledger** | 5-7 | 3 (db, stage, tests) | schema-tables, schema-migrations, evidence-risk-defs/handlers, container |
| **3: Adversarial Review** | 8-10 | 3 (db, stage, tests) | schema-tables, schema-migrations, evidence-risk-defs/handlers, container, task-core |
| **4: Integration** | 11-13 | 1 (integration test) | task-finalizer, automation-handlers, automation-defs |

**Phases 1-4 total:** 13 tasks, 11 new files, ~7 modified files, ~15 commits

---

## Phase 5: Workflow DAG Integration (Planned — Not Yet Implemented)

The adversarial review stage spawns review tasks async, but nothing prevents Claude from committing before the review finishes. Phase 5 wires adversarial review into the workflow DAG so the review task is a dependency that blocks the commit step. Claude stays in the driver seat — reads the verdict, decides commit/fix/rollback.

### Task 14: Auto-inject Review Node into Workflows

**Files:**
- Modify: `server/db/workflow-engine.js` (or wherever `advanceWorkflow` / `unblockNextNodes` lives)
- Modify: `server/handlers/workflow-handlers.js` (create_feature_workflow)
- Create: `server/tests/adversarial-review-workflow.test.js`

When a code task completes and `adversarial_review` is enabled (`'auto'` or `'always'`), the adversarial review task spawned by the finalizer stage should be **registered as a workflow node** that blocks downstream nodes (commit, next phase). This means:

- [ ] **Step 1: Read the workflow engine to understand how nodes are added dynamically**

Find where workflow nodes are unblocked after a task completes. Understand the `depends_on` and `advanceWorkflow` flow.

- [ ] **Step 2: Write failing test**

Test that when a task in a workflow completes with `adversarial_review_pending: true` in metadata, a new workflow node is injected with `depends_on` pointing to the review task, and downstream nodes are re-blocked until the review completes.

```js
// server/tests/adversarial-review-workflow.test.js
describe('adversarial-review-workflow', () => {
  it('injects review node into workflow DAG when review is spawned', () => {
    // Create a workflow: [code-task] → [commit-task]
    // Complete code-task with adversarial_review_pending: true
    // Verify: commit-task is now blocked by the review task
    // Complete review task
    // Verify: commit-task is unblocked
  });

  it('skips injection when no adversarial review was spawned', () => {
    // Complete code-task without adversarial_review_pending
    // Verify: commit-task unblocks normally
  });

  it('passes review verdict to Claude via workflow context', () => {
    // Complete review task with verdict + issues
    // Verify: downstream node receives review context via context_from
  });
});
```

- [ ] **Step 3: Implement DAG injection**

In the post-completion workflow advancement code (where `advanceWorkflow` runs after a task finishes), add a hook:

```js
// After task completes, before advancing workflow:
const metadata = JSON.parse(task.metadata || '{}');
if (metadata.adversarial_review_pending && metadata.adversarial_review_task_id) {
  // Find downstream nodes that depend on this task
  // Insert the review task as an intermediate dependency
  // Downstream nodes now depend on review task instead of (or in addition to) this task
  workflowEngine.injectReviewDependency(
    task.workflow_id,
    task.workflow_node_id,
    metadata.adversarial_review_task_id
  );
}
```

- [ ] **Step 4: Implement `injectReviewDependency`**

```js
function injectReviewDependency(workflowId, completedNodeId, reviewTaskId) {
  // 1. Register review task as a workflow node
  //    node_id: `review-${completedNodeId}`, task_id: reviewTaskId
  //    depends_on: [completedNodeId], context_from: [completedNodeId]
  // 2. Find all nodes that depended on completedNodeId
  // 3. Re-point their dependency to the review node instead
  // 4. The review node's output (verdict + issues) flows to downstream nodes via context_from
}
```

- [ ] **Step 5: Run test, verify it passes**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(evidence-risk): auto-inject adversarial review into workflow DAG

When a code task in a workflow spawns an adversarial review, the review
task is injected as an intermediate DAG node. Downstream nodes (commit,
next phase) block until the review completes. Claude reads the verdict
and decides: commit, fix, or rollback."
```

### Task 15: Feature Workflow Template Support

**Files:**
- Modify: `server/handlers/workflow-handlers.js` (or `create_feature_workflow` handler)

When `create_feature_workflow` is called and the project has `adversarial_review: 'auto' | 'always'`, automatically add review nodes after each code-producing step in the template:

- [ ] **Step 1: Read `create_feature_workflow` to understand the template DAG structure**

- [ ] **Step 2: Add optional review nodes to the feature workflow template**

For each code-producing step (types, data, events, system, wire), if adversarial review is enabled, insert a review checkpoint node:

```
[types] → [review-types?] → [data] → [review-data?] → ... → [tests] → [commit]
```

Review nodes are conditional — only inserted when `adversarial_review !== 'off'` in project defaults. Each review node uses `context_from` to pass the code task's output (diff) to Claude for the verdict.

- [ ] **Step 3: Test that feature workflows include review nodes when enabled**

- [ ] **Step 4: Test that feature workflows skip review nodes when disabled**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(evidence-risk): add review nodes to feature workflow template

When adversarial_review is enabled in project defaults, create_feature_workflow
inserts review checkpoint nodes after each code-producing step."
```

### Task 16: Slash Command Integration

**Files:**
- Modify: `.claude/commands/torque-review.md` (or equivalent)

Update `/torque-review` to check for pending adversarial reviews and present structured results:

- [ ] **Step 1: Read the current `/torque-review` command**

- [ ] **Step 2: Add adversarial review awareness**

When reviewing a task that has `adversarial_review_pending: true` or completed adversarial reviews:
1. Call `get_adversarial_reviews({ task_id })`
2. Present the verdict, confidence, and issues table
3. Ask Claude to decide: approve, request fixes, or rollback

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(evidence-risk): make /torque-review adversarial-review-aware

Shows adversarial review verdict and issues when reviewing a task that
has pending or completed adversarial reviews."
```
