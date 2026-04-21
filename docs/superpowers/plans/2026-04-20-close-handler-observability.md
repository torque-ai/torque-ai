# Close-Handler & Retry Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-attempt history for factory Codex runs, classify zero-diff completions, auto-route "already in place" results to ship-noop, silent-rerun ambiguous verify, and prepend prior-attempt context to retry fix prompts.

**Architecture:** One new SQLite table (`factory_attempt_history`) + one column (`factory_loop_instances.verify_silent_reruns`). Two new modules (`completion-rationale.js`, `verify-signature.js`) plus a new DB accessor (`factory-attempt-history.js`). Targeted edits to three existing factory files. All behavioral changes gated behind two feature flags that default off so the first ship is pure instrumentation.

**Tech Stack:** Node.js / better-sqlite3, vitest, existing TORQUE `smart_submit_task` router for LLM fallback, `safeLogDecision` for decision-log emission.

**Spec:** `docs/superpowers/specs/2026-04-20-close-handler-retry-observability-design.md`

**Branch:** `feat/close-handler-observability` (worktree: `.worktrees/feat-close-handler-observability/`)

**Verify command (remote):** `torque-remote npx vitest run server/tests/`

## Sandbox-tolerant verify fallback

Each task below has two "Run test" steps: one to confirm the failing test (red), one to confirm the fix (green). Execute them in this priority order:

1. **Preferred:** `torque-remote npx vitest run <path/to/test>` — runs on the remote workstation.
2. **Fallback 1:** `npx vitest run <path/to/test> --pool=threads --no-coverage` — avoids the vitest worker fork that sometimes hits `spawn EPERM` in restricted sandboxes.
3. **Fallback 2:** If both fail with spawn / access errors, note in your final task output the exact error text, skip the run step, and proceed to the commit step. The host's post-task verification will run the suite remotely and surface regressions.

Do **not** let a blocked vitest invocation prevent you from committing a correct code change. Your commit message and output should explicitly say "verify step skipped due to sandbox spawn restriction" when you take Fallback 2, so the reviewer knows.

---

## Task 1: Database migration — `factory_attempt_history` table + `verify_silent_reruns` column

**Acceptance:** Fresh DB runs migration 30 cleanly; existing DB running migration 30 adds the new table and column without dropping data; `SELECT` against the new table and column both succeed.

**Files:**
- Modify: `server/db/migrations.js` (append to MIGRATIONS array after version 29)
- Test: `server/tests/migration-030-attempt-history.test.js` (create)

- [ ] **Step 1.1: Write the failing test**

Create `server/tests/migration-030-attempt-history.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');

describe('migration 030 — factory_attempt_history + verify_silent_reruns', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS factory_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trust_level TEXT
      );
      CREATE TABLE IF NOT EXISTS factory_work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT
      );
      CREATE TABLE IF NOT EXISTS factory_loop_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        work_item_id INTEGER,
        batch_id TEXT,
        loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT,
        last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
    `);
  });

  afterEach(() => { db.close(); });

  it('creates factory_attempt_history with required columns and indices', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_attempt_history')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'batch_id', 'work_item_id', 'attempt', 'kind', 'task_id',
      'files_touched', 'file_count', 'stdout_tail', 'zero_diff_reason',
      'classifier_source', 'classifier_conf', 'verify_output_tail', 'created_at',
    ]));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='factory_attempt_history'").all().map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      'idx_factory_attempt_history_batch',
      'idx_factory_attempt_history_work_item',
    ]));
  });

  it('adds verify_silent_reruns column to factory_loop_instances with default 0', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_loop_instances')").all();
    const col = cols.find((c) => c.name === 'verify_silent_reruns');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('0');
    db.prepare('INSERT INTO factory_loop_instances (id, project_id) VALUES (?, ?)').run('inst-1', 'proj-1');
    const row = db.prepare('SELECT verify_silent_reruns FROM factory_loop_instances WHERE id=?').get('inst-1');
    expect(row.verify_silent_reruns).toBe(0);
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/migration-030-attempt-history.test.js`
Expected: 3 failing tests — "no such table: factory_attempt_history" or the column check fails.

- [ ] **Step 1.3: Append migration 30 to `server/db/migrations.js`**

Immediately after the closing `},` of the version-29 entry (at the end of the `MIGRATIONS` array), insert:

```javascript
  {
    version: 30,
    name: 'add_factory_attempt_history_and_silent_rerun_counter',
    up: [
      'CREATE TABLE IF NOT EXISTS factory_attempt_history (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '  batch_id TEXT NOT NULL,',
      '  work_item_id TEXT NOT NULL,',
      '  attempt INTEGER NOT NULL,',
      '  kind TEXT NOT NULL CHECK (kind IN (\'execute\', \'verify_retry\')),',
      '  task_id TEXT NOT NULL,',
      '  files_touched TEXT,',
      '  file_count INTEGER NOT NULL DEFAULT 0,',
      '  stdout_tail TEXT,',
      '  zero_diff_reason TEXT,',
      '  classifier_source TEXT NOT NULL DEFAULT \'none\' CHECK (classifier_source IN (\'heuristic\', \'llm\', \'none\')),',
      '  classifier_conf REAL,',
      '  verify_output_tail TEXT,',
      '  created_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_batch ON factory_attempt_history(batch_id, attempt);',
      'CREATE INDEX IF NOT EXISTS idx_factory_attempt_history_work_item ON factory_attempt_history(work_item_id, created_at DESC);',
      'ALTER TABLE factory_loop_instances ADD COLUMN verify_silent_reruns INTEGER NOT NULL DEFAULT 0;',
    ].join('\n'),
    down: [
      'DROP INDEX IF EXISTS idx_factory_attempt_history_work_item;',
      'DROP INDEX IF EXISTS idx_factory_attempt_history_batch;',
      'DROP TABLE IF EXISTS factory_attempt_history;',
    ].join('\n'),
  },
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/migration-030-attempt-history.test.js`
Expected: 3 passing tests.

- [ ] **Step 1.5: Commit**

```bash
git add server/db/migrations.js server/tests/migration-030-attempt-history.test.js
git commit -m "feat(factory): migration 30 — factory_attempt_history + verify_silent_reruns"
```

---

## Task 2: DB accessor — `server/db/factory-attempt-history.js`

**Acceptance:** Module exports `appendRow`, `listByBatch`, `listByWorkItem`, `updateVerifyOutputTail`, `getLatestForBatch`; all five round-trip through a real in-memory SQLite; `appendRow` auto-assigns the next `attempt` number per `work_item_id`.

**Files:**
- Create: `server/db/factory-attempt-history.js`
- Test: `server/tests/factory-attempt-history-db.test.js`

- [ ] **Step 2.1: Write the failing test**

Create `server/tests/factory-attempt-history-db.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const attemptHistory = require('../db/factory-attempt-history');

describe('factory-attempt-history DB accessor', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
    `);
    runMigrations(db);
    attemptHistory.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('appendRow assigns attempt=1 for the first row of a work_item', () => {
    const row = attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1',
      files_touched: ['a.js', 'b.js'], stdout_tail: 'ok',
    });
    expect(row.attempt).toBe(1);
    expect(row.file_count).toBe(2);
    expect(row.classifier_source).toBe('none');
  });

  it('appendRow increments attempt per work_item across kinds', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't2', files_touched: ['a.js'] });
    const r3 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't3', files_touched: ['b.js'] });
    expect(r3.attempt).toBe(3);
  });

  it('appendRow attempt counter is per-work_item, not global', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    const r = attemptHistory.appendRow({ batch_id: 'b2', work_item_id: 'w2', kind: 'execute', task_id: 't2', files_touched: [] });
    expect(r.attempt).toBe(1);
  });

  it('appendRow persists classifier fields when supplied', () => {
    const row = attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1',
      files_touched: [], stdout_tail: 'already in place',
      zero_diff_reason: 'already_in_place', classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    expect(row.zero_diff_reason).toBe('already_in_place');
    expect(row.classifier_source).toBe('heuristic');
    expect(row.classifier_conf).toBe(1.0);
  });

  it('appendRow rejects unknown kind', () => {
    expect(() => attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'bogus', task_id: 't1', files_touched: [],
    })).toThrow(/kind/);
  });

  it('listByBatch returns rows ordered by attempt asc', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't2', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't3', files_touched: [] });
    const rows = attemptHistory.listByBatch('b1');
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(Array.isArray(rows[0].files_touched)).toBe(true);
  });

  it('listByWorkItem returns newest-first, limited', () => {
    for (let i = 1; i <= 5; i += 1) {
      attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: `t${i}`, files_touched: [] });
    }
    const rows = attemptHistory.listByWorkItem('w1', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0].attempt).toBe(5);
  });

  it('getLatestForBatch returns highest-attempt row or null', () => {
    expect(attemptHistory.getLatestForBatch('b1')).toBeNull();
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't2', files_touched: ['x.js'] });
    const latest = attemptHistory.getLatestForBatch('b1');
    expect(latest.attempt).toBe(2);
    expect(latest.kind).toBe('verify_retry');
  });

  it('updateVerifyOutputTail writes to the named row only', () => {
    const r1 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    const r2 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't2', files_touched: [] });
    attemptHistory.updateVerifyOutputTail(r2.id, 'FAIL: foo\nFAIL: bar');
    const fetched = attemptHistory.listByBatch('b1');
    expect(fetched.find((r) => r.id === r1.id).verify_output_tail).toBeNull();
    expect(fetched.find((r) => r.id === r2.id).verify_output_tail).toBe('FAIL: foo\nFAIL: bar');
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-attempt-history-db.test.js`
Expected: Cannot find module '../db/factory-attempt-history'.

- [ ] **Step 2.3: Implement the accessor module**

Create `server/db/factory-attempt-history.js`:

```javascript
'use strict';

let db = null;

function setDb(dbInstance) { db = dbInstance; }

function resolveDbHandle(candidate) {
  if (!candidate) return null;
  if (typeof candidate.prepare === 'function') return candidate;
  if (typeof candidate.getDbInstance === 'function') return candidate.getDbInstance();
  if (typeof candidate.getDb === 'function') return candidate.getDb();
  return null;
}

function getDb() {
  let instance = resolveDbHandle(db);
  if (!instance) {
    try {
      const { defaultContainer } = require('../container');
      if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('db')) {
        instance = resolveDbHandle(defaultContainer.get('db'));
      }
    } catch { /* fall through */ }
  }
  if (!instance) {
    try {
      const database = require('../database');
      instance = resolveDbHandle(database);
    } catch { /* surface error below */ }
  }
  if (instance) db = instance;
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('factory-attempt-history requires an active database connection');
  }
  return instance;
}

const VALID_KINDS = new Set(['execute', 'verify_retry']);
const VALID_SOURCES = new Set(['heuristic', 'llm', 'none']);

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function appendRow({
  batch_id, work_item_id, kind, task_id,
  files_touched = [], stdout_tail = null,
  zero_diff_reason = null, classifier_source = 'none', classifier_conf = null,
  verify_output_tail = null,
}) {
  requireText(batch_id, 'batch_id');
  requireText(work_item_id, 'work_item_id');
  requireText(task_id, 'task_id');
  if (!VALID_KINDS.has(kind)) throw new Error(`kind must be one of ${[...VALID_KINDS]}`);
  if (!VALID_SOURCES.has(classifier_source)) throw new Error(`classifier_source must be one of ${[...VALID_SOURCES]}`);

  const database = getDb();
  const nextAttempt = database.prepare(
    'SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM factory_attempt_history WHERE work_item_id = ?'
  ).get(work_item_id).next;

  const filesJson = JSON.stringify(files_touched || []);
  const fileCount = Array.isArray(files_touched) ? files_touched.length : 0;
  const now = new Date().toISOString();

  const info = database.prepare(`
    INSERT INTO factory_attempt_history
      (batch_id, work_item_id, attempt, kind, task_id, files_touched, file_count,
       stdout_tail, zero_diff_reason, classifier_source, classifier_conf,
       verify_output_tail, created_at)
    VALUES (@batch_id, @work_item_id, @attempt, @kind, @task_id, @files_touched, @file_count,
            @stdout_tail, @zero_diff_reason, @classifier_source, @classifier_conf,
            @verify_output_tail, @created_at)
  `).run({
    batch_id, work_item_id, attempt: nextAttempt, kind, task_id,
    files_touched: filesJson, file_count: fileCount,
    stdout_tail, zero_diff_reason, classifier_source,
    classifier_conf, verify_output_tail, created_at: now,
  });

  return {
    id: info.lastInsertRowid, batch_id, work_item_id, attempt: nextAttempt, kind, task_id,
    files_touched: files_touched || [], file_count: fileCount,
    stdout_tail, zero_diff_reason, classifier_source, classifier_conf,
    verify_output_tail, created_at: now,
  };
}

function decodeRow(row) {
  if (!row) return null;
  let files = [];
  try { files = row.files_touched ? JSON.parse(row.files_touched) : []; } catch { files = []; }
  return { ...row, files_touched: files };
}

function listByBatch(batch_id) {
  return getDb().prepare(
    'SELECT * FROM factory_attempt_history WHERE batch_id = ? ORDER BY attempt ASC'
  ).all(batch_id).map(decodeRow);
}

function listByWorkItem(work_item_id, { limit = 10 } = {}) {
  return getDb().prepare(
    'SELECT * FROM factory_attempt_history WHERE work_item_id = ? ORDER BY attempt DESC LIMIT ?'
  ).all(work_item_id, limit).map(decodeRow);
}

function getLatestForBatch(batch_id) {
  const row = getDb().prepare(
    'SELECT * FROM factory_attempt_history WHERE batch_id = ? ORDER BY attempt DESC LIMIT 1'
  ).get(batch_id);
  return decodeRow(row);
}

function updateVerifyOutputTail(rowId, tail) {
  getDb().prepare('UPDATE factory_attempt_history SET verify_output_tail = ? WHERE id = ?').run(tail, rowId);
}

module.exports = { setDb, appendRow, listByBatch, listByWorkItem, getLatestForBatch, updateVerifyOutputTail };
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-attempt-history-db.test.js`
Expected: 8 passing tests.

- [ ] **Step 2.5: Commit**

```bash
git add server/db/factory-attempt-history.js server/tests/factory-attempt-history-db.test.js
git commit -m "feat(factory): factory-attempt-history DB accessor with per-work-item attempt counter"
```

---

## Task 3: Verify signature helper — `server/factory/verify-signature.js`

**Acceptance:** `verifySignature(output)` returns the same SHA-1 for two runs with the same failing tests (order-independent, timestamp-stripped); different for different failure sets; falls back to normalized stderr tail when no test markers are found.

**Files:**
- Create: `server/factory/verify-signature.js`
- Test: `server/tests/verify-signature.test.js`

- [ ] **Step 3.1: Write the failing test**

Create `server/tests/verify-signature.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { verifySignature } = require('../factory/verify-signature');

describe('verifySignature', () => {
  it('returns the same signature for identical vitest failures in different orders', () => {
    const a = `
 FAIL foo.test.ts > rejects null
 FAIL foo.test.ts > handles empty array
`;
    const b = `
 FAIL foo.test.ts > handles empty array
 FAIL foo.test.ts > rejects null
`;
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('ignores timestamps and absolute paths in test names', () => {
    const a = ' FAIL C:/path/to/foo.test.ts > rejects null  (15:00:01.123)';
    const b = ' FAIL /other/abs/path/foo.test.ts > rejects null  (16:22:44.901)';
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('returns different signatures for disjoint failure sets', () => {
    const a = ' FAIL foo.test.ts > A';
    const b = ' FAIL bar.test.ts > B';
    expect(verifySignature(a)).not.toBe(verifySignature(b));
  });

  it('returns a signature for jest-style FAIL lines', () => {
    const a = 'FAIL  tests/x.test.js\n  should do thing (15ms)';
    const sig = verifySignature(a);
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });

  it('falls back to normalized stderr tail when no test markers are present', () => {
    const a = 'arbitrary error at 2026-04-20T12:00Z in C:/tmp/proc/123/file.ts';
    const b = 'arbitrary error at 2026-04-21T13:00Z in C:/tmp/proc/456/file.ts';
    expect(verifySignature(a)).toBe(verifySignature(b));
  });

  it('returns empty string for empty input', () => {
    expect(verifySignature('')).toBe('');
    expect(verifySignature(null)).toBe('');
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/verify-signature.test.js`
Expected: Cannot find module '../factory/verify-signature'.

- [ ] **Step 3.3: Implement**

Create `server/factory/verify-signature.js`:

```javascript
'use strict';

const crypto = require('crypto');

const TEST_MARKERS = [
  /^\s*FAIL\s+(.+?)(\s*\(\d+\s*ms\))?\s*$/,
  /^\s*not ok\s+\d+\s+(.+?)$/,
];

function normalizeTestName(name) {
  return name
    .replace(/[A-Za-z]:[\\/][^\s>]*?([^\\/\s>]+)/g, '$1')
    .replace(/(?:^|\s)\/[^\s>]*?([^\\/\s>]+)/g, ' $1')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .replace(/\(\d+\s*ms\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFailingTestNames(output) {
  const names = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    for (const re of TEST_MARKERS) {
      const m = raw.match(re);
      if (m && m[1]) {
        names.add(normalizeTestName(m[1]));
        break;
      }
    }
  }
  return [...names].sort();
}

function normalizeStderrTail(output) {
  return String(output || '')
    .slice(-200)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .replace(/[A-Za-z]:[\\/][^\s>]*?([^\\/\s>]+)/g, '$1')
    .replace(/(?:^|\s)\/[^\s>]*?([^\\/\s>]+)/g, ' $1')
    .replace(/\b\d{2,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifySignature(output) {
  if (output == null || output === '') return '';
  const names = extractFailingTestNames(output);
  const payload = names.length > 0 ? names.join('\n') : normalizeStderrTail(output);
  if (!payload) return '';
  return crypto.createHash('sha1').update(payload).digest('hex');
}

module.exports = { verifySignature, extractFailingTestNames, normalizeTestName };
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/verify-signature.test.js`
Expected: 6 passing tests.

- [ ] **Step 3.5: Commit**

```bash
git add server/factory/verify-signature.js server/tests/verify-signature.test.js
git commit -m "feat(factory): verify-signature helper for same-vs-different failure detection"
```

---

## Task 4: Completion rationale classifier — heuristic only

**Acceptance:** `classifyZeroDiff({ stdout_tail, attempt, kind })` returns `{reason, source, confidence}`; heuristic matches fire for all three buckets with confidence 1.0 source 'heuristic'; unknown phrasing returns `unknown` confidence 0 source 'none'; `attempt > 1` pins `already_in_place` confidence to 0.

**Files:**
- Create: `server/factory/completion-rationale.js`
- Test: `server/tests/completion-rationale.test.js`

- [ ] **Step 4.1: Write the failing test**

Create `server/tests/completion-rationale.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { classifyZeroDiff, HEURISTIC_PATTERNS } = require('../factory/completion-rationale');

describe('classifyZeroDiff — heuristic layer', () => {
  const cases = [
    ['already_in_place', [
      'The change is already in place.',
      'This code already satisfies the requirement.',
      'No changes needed — module already implements the API.',
      'Already present in src/foo.ts.',
      'Nothing to change.',
      'No modifications required.',
    ]],
    ['blocked', [
      'I cannot proceed without write access.',
      'Blocked by a missing dependency.',
      'Permission denied on src/secrets/.env.',
      'Refusing to edit files outside the worktree.',
    ]],
    ['precondition_missing', [
      'File does not exist at src/foo/bar.ts.',
      'No such file or directory: build/output.json.',
      'Module not found: "@torque/xyz".',
      'Path not found in the configured tree.',
    ]],
  ];

  for (const [bucket, samples] of cases) {
    for (const text of samples) {
      it(`classifies "${text.slice(0, 40)}..." as ${bucket}`, async () => {
        const res = await classifyZeroDiff({ stdout_tail: text, attempt: 1, kind: 'execute' });
        expect(res.reason).toBe(bucket);
        expect(res.source).toBe('heuristic');
        expect(res.confidence).toBe(1.0);
      });
    }
  }

  it('returns unknown with source=none when no pattern matches and no LLM router supplied', async () => {
    const res = await classifyZeroDiff({ stdout_tail: 'Task complete. Summary: ok.', attempt: 1, kind: 'execute' });
    expect(res.reason).toBe('unknown');
    expect(res.source).toBe('none');
    expect(res.confidence).toBe(0);
  });

  it('pins already_in_place confidence to 0 when attempt > 1', async () => {
    const res = await classifyZeroDiff({
      stdout_tail: 'Already in place.',
      attempt: 2,
      kind: 'verify_retry',
    });
    expect(res.reason).toBe('already_in_place');
    expect(res.confidence).toBe(0);
    expect(res.source).toBe('heuristic');
  });

  it('is case-insensitive on heuristic matching', async () => {
    const res = await classifyZeroDiff({ stdout_tail: 'ALREADY IN PLACE', attempt: 1, kind: 'execute' });
    expect(res.reason).toBe('already_in_place');
  });

  it('never throws on malformed input', async () => {
    const results = await Promise.all([
      classifyZeroDiff({ stdout_tail: null, attempt: 1, kind: 'execute' }),
      classifyZeroDiff({ stdout_tail: undefined, attempt: 1, kind: 'execute' }),
      classifyZeroDiff({ stdout_tail: '', attempt: 1, kind: 'execute' }),
      classifyZeroDiff({}),
    ]);
    for (const r of results) {
      expect(r.reason).toBe('unknown');
    }
  });

  it('exports pattern list for external inspection', () => {
    expect(HEURISTIC_PATTERNS.already_in_place.length).toBeGreaterThan(0);
    expect(HEURISTIC_PATTERNS.blocked.length).toBeGreaterThan(0);
    expect(HEURISTIC_PATTERNS.precondition_missing.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/completion-rationale.test.js`
Expected: Cannot find module '../factory/completion-rationale'.

- [ ] **Step 4.3: Implement heuristic-only classifier**

Create `server/factory/completion-rationale.js`:

```javascript
'use strict';

const HEURISTIC_PATTERNS = {
  already_in_place: [
    'already in place',
    'already present',
    'no changes needed',
    'no modifications required',
    'nothing to change',
    'change is already',
    'already satisfies',
    'already applied',
    'code already implements',
    'no changes were made',
  ],
  blocked: [
    'cannot proceed',
    'blocked by',
    'refusing to',
    'unable to locate',
    'permission denied',
    'read-only',
    'outside the worktree',
    'sandbox denied',
  ],
  precondition_missing: [
    'file does not exist',
    'no such file',
    'path not found',
    'module not found',
    'not initialized',
    'prerequisite',
  ],
};

function matchHeuristic(text) {
  const lower = String(text || '').toLowerCase();
  for (const [reason, patterns] of Object.entries(HEURISTIC_PATTERNS)) {
    for (const p of patterns) {
      if (lower.includes(p)) {
        return { reason, source: 'heuristic', confidence: 1.0 };
      }
    }
  }
  return null;
}

async function invokeLlmFallback(/* args */) {
  return null;
}

async function classifyZeroDiff({
  stdout_tail = '',
  attempt = 1,
  kind = 'execute',
  llmRouter = null,
  timeoutMs = 30000,
} = {}) {
  const fallback = { reason: 'unknown', source: 'none', confidence: 0 };
  try {
    const heuristic = matchHeuristic(stdout_tail);
    let result = heuristic;

    if (!result && typeof llmRouter === 'function') {
      result = await invokeLlmFallback({ stdout_tail, llmRouter, timeoutMs });
    }

    if (!result) result = fallback;

    if (result.reason === 'already_in_place' && attempt > 1) {
      return { ...result, confidence: 0 };
    }
    return result;
  } catch {
    return fallback;
  }
}

module.exports = { classifyZeroDiff, matchHeuristic, HEURISTIC_PATTERNS };
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/completion-rationale.test.js`
Expected: All tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add server/factory/completion-rationale.js server/tests/completion-rationale.test.js
git commit -m "feat(factory): completion-rationale heuristic classifier for zero-diff Codex completions"
```

---

## Task 5: Completion rationale — LLM fallback

**Acceptance:** When heuristic misses, a supplied `llmRouter` is called with the tail; response is parsed into one of the valid buckets; successful parse → `source: 'llm'`, `confidence: 0.7`; unparseable response → `unknown`; router errors or timeouts → fallback to `unknown` without throwing.

**Files:**
- Modify: `server/factory/completion-rationale.js`
- Modify: `server/tests/completion-rationale.test.js` (append new describe block)

- [ ] **Step 5.1: Write the failing test**

Append to `server/tests/completion-rationale.test.js` at the bottom:

```javascript
describe('classifyZeroDiff — LLM fallback', () => {
  it('invokes llmRouter only when heuristic misses', async () => {
    let calls = 0;
    const llmRouter = async () => { calls += 1; return 'blocked'; };
    const hit = await classifyZeroDiff({
      stdout_tail: 'Already in place.', attempt: 1, kind: 'execute', llmRouter,
    });
    const miss = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(hit.source).toBe('heuristic');
    expect(miss.source).toBe('llm');
    expect(miss.reason).toBe('blocked');
    expect(miss.confidence).toBe(0.7);
    expect(calls).toBe(1);
  });

  it('returns unknown when llmRouter replies with unparseable text', async () => {
    const llmRouter = async () => 'the vibe is unclear';
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(res.reason).toBe('unknown');
  });

  it('returns unknown when llmRouter throws', async () => {
    const llmRouter = async () => { throw new Error('boom'); };
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
    });
    expect(res.reason).toBe('unknown');
  });

  it('respects timeoutMs on hanging llmRouter', async () => {
    const llmRouter = () => new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000));
    const start = Date.now();
    const res = await classifyZeroDiff({
      stdout_tail: 'Task did unusual thing.',
      attempt: 1, kind: 'execute', llmRouter, timeoutMs: 50,
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(res.reason).toBe('unknown');
  });

  it('trims and validates llmRouter response against the bucket set', async () => {
    const samples = [
      ['  already_in_place  ', 'already_in_place'],
      ['BLOCKED', 'blocked'],
      ['Precondition_Missing', 'precondition_missing'],
      ['unknown', 'unknown'],
    ];
    for (const [input, expected] of samples) {
      const llmRouter = async () => input;
      const res = await classifyZeroDiff({
        stdout_tail: 'Task did unusual thing.', attempt: 1, kind: 'execute', llmRouter,
      });
      expect(res.reason).toBe(expected);
    }
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/completion-rationale.test.js`
Expected: 5 new tests fail (stubbed fallback returns null).

- [ ] **Step 5.3: Replace the stub with a real LLM fallback**

In `server/factory/completion-rationale.js`, replace the stub `invokeLlmFallback` and add three helpers above it:

```javascript
const VALID_REASONS = new Set(['already_in_place', 'blocked', 'precondition_missing', 'unknown']);

function buildLlmPrompt(tail) {
  return [
    'Classify this Codex stdout tail from a task that produced no file changes.',
    'Answer with one word from this set: already_in_place, blocked, precondition_missing, unknown.',
    'No other text.',
    '',
    'Tail:',
    '```',
    String(tail || '').slice(-1200),
    '```',
  ].join('\n');
}

function parseLlmResponse(text) {
  const m = String(text || '').trim().toLowerCase().match(/^([a-z_]+)/);
  if (!m) return 'unknown';
  const candidate = m[1];
  return VALID_REASONS.has(candidate) ? candidate : 'unknown';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('llm_timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function invokeLlmFallback({ stdout_tail, llmRouter, timeoutMs }) {
  try {
    const prompt = buildLlmPrompt(stdout_tail);
    const raw = await withTimeout(Promise.resolve(llmRouter(prompt)), timeoutMs);
    const reason = parseLlmResponse(raw);
    return { reason, source: 'llm', confidence: 0.7 };
  } catch {
    return { reason: 'unknown', source: 'llm', confidence: 0 };
  }
}
```

Extend `module.exports`:

```javascript
module.exports = {
  classifyZeroDiff, matchHeuristic, HEURISTIC_PATTERNS,
  parseLlmResponse, buildLlmPrompt,
};
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/completion-rationale.test.js`
Expected: All tests (original 9 + new 5) pass.

- [ ] **Step 5.5: Commit**

```bash
git add server/factory/completion-rationale.js server/tests/completion-rationale.test.js
git commit -m "feat(factory): completion-rationale LLM fallback for unknown zero-diff phrasings"
```

---

## Task 6: Wire worktree-auto-commit into attempt-history + classifier

**Acceptance:** All three skip-clean paths and the success-commit path write rows to `factory_attempt_history`; skip-clean paths include classifier results in both the row and the decision-log outcome; existing decision-log action names continue to fire.

**Files:**
- Modify: `server/factory/worktree-auto-commit.js` (4 write points)
- Modify: `server/tests/factory-worktree-auto-commit.test.js` (extend)

- [ ] **Step 6.1: Write the failing test**

Append to `server/tests/factory-worktree-auto-commit.test.js` a new describe block near the end of the file, reusing the harness already defined in that file:

```javascript
describe('worktree-auto-commit — attempt history + rationale', () => {
  it('writes an attempt_history row with classifier fields when the worktree is clean and Codex said "already in place"', async () => {
    const { result } = await runAutoCommitListenerWithStdoutTail({
      stdoutTail: 'The change is already in place.',
      dirtyFiles: [],
      batchId: 'batch-h1',
      workItemId: 'wi-h1',
      taskId: 'task-h1',
      planTaskNumber: 1,
    });

    const rows = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').all('batch-h1');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('execute');
    expect(rows[0].file_count).toBe(0);
    expect(rows[0].zero_diff_reason).toBe('already_in_place');
    expect(rows[0].classifier_source).toBe('heuristic');
    expect(JSON.parse(rows[0].files_touched)).toEqual([]);

    const decision = db.prepare("SELECT * FROM factory_decisions WHERE action='auto_commit_skipped_clean' AND batch_id=?").get('batch-h1');
    const outcome = JSON.parse(decision.outcome_json || decision.outcome);
    expect(outcome.zero_diff_reason).toBe('already_in_place');
    expect(outcome.classifier_source).toBe('heuristic');
  });

  it('writes an attempt_history row with classifier_source=none on the successful commit path', async () => {
    await runAutoCommitListenerWithStdoutTail({
      stdoutTail: 'Created two files.',
      dirtyFiles: ['src/a.js', 'src/b.js'],
      batchId: 'batch-h2',
      workItemId: 'wi-h2',
      taskId: 'task-h2',
      planTaskNumber: 1,
    });
    const row = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').get('batch-h2');
    expect(row.file_count).toBe(2);
    expect(JSON.parse(row.files_touched).sort()).toEqual(['src/a.js', 'src/b.js'].sort());
    expect(row.classifier_source).toBe('none');
    expect(row.zero_diff_reason).toBeNull();
  });

  it('sets kind=verify_retry when the task tag factory:verify_retry=N is present', async () => {
    await runAutoCommitListenerWithStdoutTail({
      stdoutTail: 'already in place',
      dirtyFiles: [],
      batchId: 'batch-h3',
      workItemId: 'wi-h3',
      taskId: 'task-h3',
      planTaskNumber: 1002,
      extraTags: ['factory:verify_retry=2'],
    });
    const row = db.prepare('SELECT * FROM factory_attempt_history WHERE batch_id=?').get('batch-h3');
    expect(row.kind).toBe('verify_retry');
  });
});
```

`runAutoCommitListenerWithStdoutTail(opts)` is a local helper you must add alongside the existing setup helpers in this file. Its three responsibilities:

1. `fs.writeFileSync` each entry in `opts.dirtyFiles` under the worktree path with dummy content.
2. Insert a `tasks` row via `taskCore.createTask` carrying tags `factory:batch_id=<batchId>`, `factory:work_item_id=<workItemId>`, `factory:plan_task_number=<planTaskNumber>`, plus any entries from `opts.extraTags`, and with `output` (or the equivalent field the provider writes) set to `opts.stdoutTail`.
3. Emit `taskEvents.emit('completed', { task })` and `await` a small tick so the listener runs.

Use the existing "commit succeeds" helper as the scaffold — copy it and parameterize.

- [ ] **Step 6.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-worktree-auto-commit.test.js`
Expected: 3 new failing tests — rows not written yet.

- [ ] **Step 6.3: Thread classifier + history into the commit listener**

Edits to `server/factory/worktree-auto-commit.js`:

A. Near the top imports, after the existing `factoryDecisions` require, add:

```javascript
const attemptHistory = require('../db/factory-attempt-history');
const { classifyZeroDiff } = require('./completion-rationale');
```

B. Just above `parsePorcelainPaths` (search for `function parsePorcelainPaths`), add helpers:

```javascript
const STDOUT_TAIL_BUDGET = 1200;

function getStdoutTail(task) {
  const raw = task && (task.output || task.stdout_tail || task.result_output) || '';
  return String(raw).replace(/\u001b\[[0-9;]*m/g, '').slice(-STDOUT_TAIL_BUDGET);
}

function resolveKind(task) {
  const tag = Array.isArray(task && task.tags) ? task.tags.find((t) => typeof t === 'string' && t.startsWith('factory:verify_retry=')) : null;
  return tag ? 'verify_retry' : 'execute';
}

function resolveWorkItemId(task) {
  const tag = Array.isArray(task && task.tags) ? task.tags.find((t) => typeof t === 'string' && t.startsWith('factory:work_item_id=')) : null;
  if (!tag) return null;
  const raw = tag.split('=')[1];
  return raw && raw !== 'unknown' ? raw : null;
}
```

C. At each of the three `auto_commit_skipped_clean` return sites (grep `server/factory/worktree-auto-commit.js` for `auto_commit_skipped_clean`), immediately before the existing `safeLogDecision({ ..., action: 'auto_commit_skipped_clean', ... })` call, insert:

```javascript
    const stdoutTail = getStdoutTail(task);
    const kind = resolveKind(task);
    const workItemId = resolveWorkItemId(task);
    const classification = workItemId
      ? await classifyZeroDiff({ stdout_tail: stdoutTail, attempt: 1, kind })
      : { reason: 'unknown', source: 'none', confidence: 0 };
    if (workItemId) {
      try {
        attemptHistory.appendRow({
          batch_id: worktree.batchId || batchId,
          work_item_id: workItemId,
          kind,
          task_id: task.id,
          files_touched: [],
          stdout_tail: stdoutTail,
          zero_diff_reason: classification.reason,
          classifier_source: classification.source,
          classifier_conf: classification.confidence,
        });
      } catch (e) {
        logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
      }
    }
```

And change the existing `outcome:` of the `safeLogDecision({ ..., action: 'auto_commit_skipped_clean', ... })` call to include the classifier fields:

```javascript
      outcome: {
        task_id: task.id,
        plan_task_number: planTaskNumber,
        files_changed: [],
        zero_diff_reason: classification.reason,
        classifier_source: classification.source,
        classifier_conf: classification.confidence,
      },
```

(For the drift-only and pathspec return paths, keep the existing `skipped_drift_files: driftPaths` line they already have.)

D. At the successful-commit site (after the `const commitSha = runGit(...)` line but before the `safeLogDecision({ ..., action: 'auto_committed_task', ... })` call), append:

```javascript
    const workItemIdCommit = resolveWorkItemId(task);
    if (workItemIdCommit) {
      try {
        attemptHistory.appendRow({
          batch_id: worktree.batchId || batchId,
          work_item_id: workItemIdCommit,
          kind: resolveKind(task),
          task_id: task.id,
          files_touched: allStaged,
          stdout_tail: getStdoutTail(task),
        });
      } catch (e) {
        logger.warn('attempt_history_write_failed', { err: e.message, task_id: task.id });
      }
    }
```

E. Change the outer function signature: `commitCompletedPlanTask(task)` becomes `async function commitCompletedPlanTask(task)`. Update the completed-task listener that dispatches to it so unhandled rejections never escape. Search `completedTaskListener = (event) =>` in the same file and change its body:

```javascript
  completedTaskListener = (event) => {
    const taskId = getTaskId(event);
    if (!taskId) return;
    Promise.resolve()
      .then(() => commitCompletedPlanTask(event.task))
      .catch((err) => logger.warn('worktree_auto_commit_listener_failed', { err: err.message, task_id: taskId }));
  };
```

(The existing listener body shape will differ slightly — keep its existing structure, just ensure `commitCompletedPlanTask` is invoked via a promise chain with a `.catch`.)

- [ ] **Step 6.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-worktree-auto-commit.test.js`
Expected: All tests pass (new 3 + original suite).

- [ ] **Step 6.5: Commit**

```bash
git add server/factory/worktree-auto-commit.js server/tests/factory-worktree-auto-commit.test.js
git commit -m "feat(factory): auto-commit listener writes attempt_history + classifier rationale"
```

---

## Task 7: Retry-prompt enrichment — prior-attempts block

**Acceptance:** `buildVerifyFixPrompt` accepts `priorAttempts` and `verifyOutputPrev`; renders the prior-attempt block with file counts, touched files, Codex summary, and a progression line when both verify outputs parse; omits the block entirely when no priors exist; budget enforcement trims oldest first.

**Files:**
- Modify: `server/factory/loop-controller.js` (`buildVerifyFixPrompt` + `submitVerifyFixTask`)
- Test: `server/tests/attempt-history-prompt.test.js` (create)

- [ ] **Step 7.1: Write the failing test**

Create `server/tests/attempt-history-prompt.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { buildVerifyFixPrompt, __testing__ } = require('../factory/loop-controller');

const basePlan = {
  planPath: 'docs/superpowers/plans/x.md',
  planTitle: 'X Plan',
  branch: 'feat/x',
  verifyCommand: 'npm test',
  verifyOutput: ' FAIL foo.test.ts > handles empty array\n',
};

describe('buildVerifyFixPrompt — prior-attempts block', () => {
  it('omits the prior-attempts section when priorAttempts is empty', () => {
    const p = buildVerifyFixPrompt({ ...basePlan, priorAttempts: [], verifyOutputPrev: null });
    expect(p).not.toMatch(/Prior attempts/);
    expect(p).toMatch(/Verify output \(tail\)/);
  });

  it('omits the prior-attempts section when priorAttempts is undefined', () => {
    const p = buildVerifyFixPrompt(basePlan);
    expect(p).not.toMatch(/Prior attempts/);
  });

  it('renders one attempt row with kind label, file count, touched files, and Codex summary', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{
        attempt: 1, kind: 'execute', file_count: 2,
        files_touched: ['src/foo.ts', 'src/bar.ts'],
        stdout_tail: 'Added early-return guard.',
        zero_diff_reason: null,
      }],
    });
    expect(p).toMatch(/Prior attempts on this work item/);
    expect(p).toMatch(/Attempt 1 \(execute\): 2 files touched/);
    expect(p).toMatch(/src\/foo\.ts/);
    expect(p).toMatch(/Codex summary: "Added early-return guard\."/);
  });

  it('renders zero-diff attempt with classifier reason', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{
        attempt: 2, kind: 'verify_retry', file_count: 0, files_touched: [],
        stdout_tail: 'The guard is already present.',
        zero_diff_reason: 'already_in_place',
      }],
    });
    expect(p).toMatch(/0 files touched — classified as `already_in_place`/);
  });

  it('renders the progression line when both outputs have extractable test sets', () => {
    const p = buildVerifyFixPrompt({
      ...basePlan,
      verifyOutput: ' FAIL foo.test.ts > handles empty array\n',
      verifyOutputPrev: ' FAIL foo.test.ts > rejects null\n FAIL foo.test.ts > handles empty array\n',
      priorAttempts: [{ attempt: 1, kind: 'execute', file_count: 1, files_touched: ['src/foo.ts'], stdout_tail: '', zero_diff_reason: null }],
    });
    expect(p).toMatch(/Verify error progression/);
    expect(p).toMatch(/Previous run failed with/);
    expect(p).toMatch(/This run is failing with/);
  });

  it('caps prior-attempts block at VERIFY_FIX_PROMPT_PRIOR_BUDGET, trimming oldest first', () => {
    const longAttempts = Array.from({ length: 6 }, (_, i) => ({
      attempt: i + 1,
      kind: 'execute',
      file_count: 3,
      files_touched: ['a.ts', 'b.ts', 'c.ts'],
      stdout_tail: 'x'.repeat(500),
      zero_diff_reason: null,
    }));
    const p = buildVerifyFixPrompt({ ...basePlan, priorAttempts: longAttempts });
    const block = p.match(/Prior attempts on this work item:\n([\s\S]+?)\n\nConstraints:/);
    expect(block).toBeTruthy();
    expect(block[1].length).toBeLessThanOrEqual(__testing__.VERIFY_FIX_PROMPT_PRIOR_BUDGET + 200);
    expect(p).toMatch(/\(\d+ earlier attempts elided\)/);
  });

  it('truncates files_touched to first 5 with "(+N more)" suffix', () => {
    const manyFiles = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const p = buildVerifyFixPrompt({
      ...basePlan,
      priorAttempts: [{ attempt: 1, kind: 'execute', file_count: 8, files_touched: manyFiles, stdout_tail: '', zero_diff_reason: null }],
    });
    expect(p).toMatch(/f0\.ts.*f1\.ts.*f2\.ts.*f3\.ts.*f4\.ts.*\(\+3 more\)/);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/attempt-history-prompt.test.js`
Expected: All tests fail — new signature + block not yet implemented.

- [ ] **Step 7.3: Implement in loop-controller.js**

In `server/factory/loop-controller.js`, replace the existing `buildVerifyFixPrompt` with the expanded version:

```javascript
const VERIFY_FIX_PROMPT_PRIOR_BUDGET = 1800;

function renderFilesTouched(files, file_count) {
  const arr = Array.isArray(files) ? files : [];
  if (arr.length === 0) return 'none';
  const head = arr.slice(0, 5).join(', ');
  const extra = file_count > 5 ? ` (+${file_count - 5} more)` : '';
  return `${head}${extra}`;
}

function renderAttempt(a, labelNumber) {
  const verifyRetryIdx = labelNumber == null ? '' : ` (verify retry #${labelNumber})`;
  const kindLabel = a.kind === 'verify_retry' ? `verify_retry${verifyRetryIdx}` : 'execute';
  const head = `- Attempt ${a.attempt} (${kindLabel}): ${a.file_count} files touched`;
  const filesPart = a.file_count > 0 ? ` — ${renderFilesTouched(a.files_touched, a.file_count)}.` : '';
  const classified = a.file_count === 0 && a.zero_diff_reason
    ? ` — classified as \`${a.zero_diff_reason}\`.`
    : '.';
  const summary = String(a.stdout_tail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const summaryLine = summary ? `\n  Codex summary: "${summary}"` : '';
  return `${head}${filesPart}${classified}${summaryLine}`;
}

function renderProgression(prevOutput, currOutput) {
  try {
    const { extractFailingTestNames } = require('./verify-signature');
    const prev = extractFailingTestNames(prevOutput);
    const curr = extractFailingTestNames(currOutput);
    if (prev.length === 0 && curr.length === 0) return null;

    const prevSet = new Set(prev);
    const currSet = new Set(curr);
    const newlyPassing = prev.filter((n) => !currSet.has(n));
    const newlyFailing = curr.filter((n) => !prevSet.has(n));

    const lines = ['Verify error progression:'];
    lines.push(`- Previous run failed with: ${prev.length} failure${prev.length === 1 ? '' : 's'}${prev.length ? ` ("${prev.slice(0, 3).join('", "')}"${prev.length > 3 ? ', …' : ''})` : ''}`);
    lines.push(`- This run is failing with: ${curr.length} failure${curr.length === 1 ? '' : 's'}${curr.length ? ` ("${curr.slice(0, 3).join('", "')}"${curr.length > 3 ? ', …' : ''})` : ''}`);
    let verdict;
    if (newlyPassing.length > 0 && newlyFailing.length === 0) {
      verdict = `  → Partial progress. ${newlyPassing.length} test${newlyPassing.length === 1 ? '' : 's'} now passing. Keep current approach.`;
    } else if (newlyFailing.length > 0 && newlyPassing.length === 0) {
      verdict = `  → New failures introduced. Consider reverting part of last attempt.`;
    } else if (newlyPassing.length === 0 && newlyFailing.length === 0 && prev.length > 0) {
      verdict = `  → Same failures. Previous approach did not move the needle; try a different angle.`;
    } else if (newlyPassing.length > 0 && newlyFailing.length > 0) {
      verdict = `  → Mixed: ${newlyPassing.length} newly passing, ${newlyFailing.length} newly failing.`;
    } else {
      verdict = `  → No comparable change.`;
    }
    lines.push(verdict);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput) {
  const attempts = Array.isArray(priorAttempts) ? [...priorAttempts] : [];
  if (attempts.length === 0) return null;

  attempts.sort((a, b) => a.attempt - b.attempt);

  let verifyRetryIdx = 0;
  const rendered = attempts.map((a) => {
    if (a.kind === 'verify_retry') {
      verifyRetryIdx += 1;
      return renderAttempt(a, verifyRetryIdx);
    }
    return renderAttempt(a, null);
  });

  let elidedCount = 0;
  let block = `Prior attempts on this work item:\n${rendered.join('\n')}`;
  while (block.length > VERIFY_FIX_PROMPT_PRIOR_BUDGET && rendered.length > 1) {
    rendered.shift();
    elidedCount += 1;
    block = `Prior attempts on this work item:\n(${elidedCount} earlier attempt${elidedCount === 1 ? '' : 's'} elided)\n${rendered.join('\n')}`;
  }

  const progression = renderProgression(verifyOutputPrev, verifyOutput);
  if (progression) block += `\n\n${progression}`;

  return block;
}

function buildVerifyFixPrompt({
  planPath, planTitle, branch, verifyCommand, verifyOutput,
  priorAttempts, verifyOutputPrev,
}) {
  const tail = stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET);
  const priorBlock = buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput);
  const lines = [
    `Plan: ${planTitle || '(unknown)'}`,
    planPath ? `Plan path: ${planPath}` : null,
    `Factory branch: ${branch}`,
    `Verify command: ${verifyCommand}`,
    '',
    'The plan tasks for this batch were implemented, but the verify step failed. Read the error output below and make the minimum changes needed to turn the failures green. Common issues: a test that references a module the plan forgot to update, an alignment/invariant test that needs the new entry registered, a stale snapshot, a missing import, a type mismatch, or a lint rule violation.',
    '',
    priorBlock,
    priorBlock ? '' : null,
    'Constraints:',
    '- Edit only files in this worktree.',
    '- Do NOT revert the plan\'s intended changes — fix forward.',
    '- Prefer updating the failing test assertions ONLY if the plan is clearly the authoritative spec and the test is out of date. Otherwise update the production code so the test passes.',
    '- Do not run the full verify suite yourself. Targeted re-runs of the specific failing file are fine.',
    '',
    'Verify output (tail):',
    '```',
    tail,
    '```',
    '',
    'After making the edits, stop.',
  ].filter((x) => x !== null && x !== undefined);
  return lines.join('\n');
}
```

Extend the module's existing `module.exports` block. Keep every entry that is already there; add these three new keys inside the `__testing__` object alongside whatever is already exported:

```javascript
  // Existing exports stay — add these:
  buildVerifyFixPrompt,
  // Inside the existing __testing__: { ... } object, append:
  //   VERIFY_FIX_PROMPT_PRIOR_BUDGET,
  //   buildPriorAttemptsBlock,
  //   renderProgression,
```

If `__testing__` does not yet exist on the module, create it as `__testing__: { VERIFY_FIX_PROMPT_PRIOR_BUDGET, buildPriorAttemptsBlock, renderProgression }`.

Then thread history reads through `submitVerifyFixTask` (near line 4561). Before the `buildVerifyFixPrompt` call, insert:

```javascript
  const attemptHistory = require('../db/factory-attempt-history');
  const workItemIdStr = String((workItem && workItem.id) || '');
  const priorAttempts = workItemIdStr
    ? attemptHistory.listByWorkItem(workItemIdStr, { limit: 3 }).reverse()
    : [];
  const latest = priorAttempts[priorAttempts.length - 1];
  const verifyOutputPrev = latest && latest.verify_output_tail ? latest.verify_output_tail : null;

  if (latest && latest.id) {
    try {
      attemptHistory.updateVerifyOutputTail(
        latest.id,
        stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET)
      );
    } catch (e) {
      logger.warn('attempt_history_verify_tail_update_failed', { err: e.message });
    }
  }
```

And change the `buildVerifyFixPrompt` call in `submitVerifyFixTask` to:

```javascript
  const prompt = buildVerifyFixPrompt({
    planPath, planTitle,
    branch: worktreeRecord.branch,
    verifyCommand, verifyOutput,
    priorAttempts, verifyOutputPrev,
  });
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/attempt-history-prompt.test.js`
Expected: All tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add server/factory/loop-controller.js server/tests/attempt-history-prompt.test.js
git commit -m "feat(factory): prepend prior-attempt context to verify-retry fix prompts"
```

---

## Task 8: Ship-noop auto-route (flag-gated)

**Acceptance:** When `factory.auto_ship_noop_enabled=true` and the most recent attempt-history row has `zero_diff_reason='already_in_place'` + `classifier_conf >= 0.8`, the EXECUTE → VERIFY transition emits `shipped_as_noop` and advances to LEARN; `blocked` / `precondition_missing` with conf >= 0.8 uses `paused_at_gate` with a `paused_reason` outcome field.

**Files:**
- Modify: `server/factory/loop-controller.js` (EXECUTE → VERIFY transition + helper)
- Test: `server/tests/factory-ship-noop.test.js` (create)

- [ ] **Step 8.1: Locate the feature-flag read site**

Run: `grep -n "config_json\|feature_flag\|getProject" server/db/factory-health.js | head -20`

Expected: Find where `factory_projects.config_json` is parsed. If an existing helper returns parsed config, reuse it; otherwise the `isFactoryFeatureEnabled` helper below reads `factory_projects.config_json` via `factoryHealth.getProject(project_id)` and JSON-parses.

- [ ] **Step 8.2: Write the failing test**

Create `server/tests/factory-ship-noop.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const attemptHistory = require('../db/factory-attempt-history');
const factoryHealth = require('../db/factory-health');
const factoryDecisions = require('../db/factory-decisions');
const loopController = require('../factory/loop-controller');

describe('loop-controller — ship-noop auto-route', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT, config_json TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, status TEXT, metadata_json TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
      CREATE TABLE factory_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, batch_id TEXT,
        stage TEXT, action TEXT, reasoning TEXT, outcome_json TEXT, created_at TEXT NOT NULL
      );
    `);
    runMigrations(db);
    attemptHistory.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
  });

  afterEach(() => { db.close(); });

  function insertProject({ flagOn }) {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, config_json) VALUES (?, ?, ?, ?)').run(
      'proj-1', 'test', 'dark', JSON.stringify(flagOn ? { feature_flags: { auto_ship_noop_enabled: true } } : {})
    );
  }

  function insertWorkItem(id) {
    db.prepare('INSERT INTO factory_work_items (id, project_id, status) VALUES (?, ?, ?)').run(id, 'proj-1', 'prioritized');
  }

  it('advances to LEARN with shipped_as_noop when reason=already_in_place, conf=1.0, flag=on', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n1', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n1', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({ shipped_as_noop: true }));
    const decision = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-n1' AND action='shipped_as_noop'").get();
    expect(decision).toBeDefined();
  });

  it('does not ship-noop when flag is off', async () => {
    insertProject({ flagOn: false });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n2', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n2', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('does not ship-noop when confidence < 0.8', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n3', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'llm', classifier_conf: 0.7,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n3', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('emits paused_at_gate with paused_reason=blocked_by_codex when reason=blocked', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n4', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'blocked',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n4', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({ paused: true, paused_reason: 'blocked_by_codex' }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-n4' AND action='paused_at_gate'").get();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome.paused_reason).toBe('blocked_by_codex');
  });
});
```

- [ ] **Step 8.3: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-ship-noop.test.js`
Expected: Fails — `loopController.__testing__.maybeShipNoop` is undefined.

- [ ] **Step 8.4: Implement `maybeShipNoop`**

In `server/factory/loop-controller.js`, add above `buildVerifyFixPrompt`:

```javascript
function isFactoryFeatureEnabled(project_id, flagKey) {
  try {
    const project = factoryHealth.getProject(project_id);
    const raw = project && (project.config_json || project.config);
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return Boolean(cfg && cfg.feature_flags && cfg.feature_flags[flagKey]);
  } catch {
    return false;
  }
}

async function maybeShipNoop({ project_id, batch_id, work_item_id }) {
  const attemptHistory = require('../db/factory-attempt-history');
  const latest = attemptHistory.getLatestForBatch(batch_id);
  if (!latest) return { shipped_as_noop: false };

  const reason = latest.zero_diff_reason;
  const conf = latest.classifier_conf == null ? 0 : latest.classifier_conf;

  if (reason === 'already_in_place' && conf >= 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'shipped_as_noop',
      reasoning: 'Codex reported the change was already in place; skipping VERIFY per auto-route policy.',
      outcome: {
        work_item_id,
        classifier_source: latest.classifier_source,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: true };
  }

  if ((reason === 'blocked' || reason === 'precondition_missing') && conf >= 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    const paused_reason = reason === 'blocked' ? 'blocked_by_codex' : 'precondition_missing';
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'paused_at_gate',
      reasoning: `Codex reported ${reason}; pausing EXECUTE gate for operator review.`,
      outcome: {
        work_item_id,
        paused_stage: 'EXECUTE',
        paused_reason,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: false, paused: true, paused_reason };
  }

  return { shipped_as_noop: false };
}
```

Extend `__testing__` in `module.exports`:

```javascript
    maybeShipNoop,
    isFactoryFeatureEnabled,
```

Wire into the EXECUTE → VERIFY transition. Search `grep -n "entered_from_execute\|advance_from_execute" server/factory/loop-controller.js | head -5`. Find the point where the loop would advance from EXECUTE into VERIFY and, immediately before that advance, insert:

```javascript
        const shipResult = await maybeShipNoop({
          project_id,
          batch_id,
          work_item_id: instance && instance.work_item_id,
        });
        if (shipResult.shipped_as_noop) {
          workItemStore.markShipped(instance.work_item_id, { shipped_as_noop: true });
          await advanceToLearn({ project_id, batch_id, instance });
          return;
        }
        if (shipResult.paused) {
          await pauseInstanceAt({ instance_id: instance.id, stage: LOOP_STATES.EXECUTE });
          return;
        }
```

`workItemStore.markShipped(id, metadata)` and `pauseInstanceAt({ instance_id, stage })` already exist — grep for `markShipped` and `paused_at_stage` to find their real helper names. If the repo names them differently, substitute the actual names.

- [ ] **Step 8.5: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-ship-noop.test.js`
Expected: 4 passing tests.

- [ ] **Step 8.6: Commit**

```bash
git add server/factory/loop-controller.js server/tests/factory-ship-noop.test.js
git commit -m "feat(factory): ship-noop auto-route + pause-on-blocked with classifier confidence gate"
```

---

## Task 9: Verify silent-rerun (flag-gated)

**Acceptance:** When `factory.verify_silent_rerun_enabled=true` and the ambiguous classifier fires, verify command is re-run against the branch. Pass → `verify_passed_on_silent_rerun` and advance. Same-signature fail → fall through. Different-signature fail → fall through with combined output. Remote error → `verify_silent_rerun_failed` and fall through. Budget (`factory_loop_instances.verify_silent_reruns`) is bumped atomically; second ambiguous in same batch does not rerun.

**Files:**
- Modify: `server/factory/loop-controller.js` (ambiguous branch near L5282 + helper)
- Modify: `server/db/factory-loop-instances.js` (add `bumpVerifySilentReruns` + `getVerifySilentReruns`)
- Test: `server/tests/factory-silent-rerun.test.js` (create)

- [ ] **Step 9.1: Write the failing test**

Create `server/tests/factory-silent-rerun.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const loopController = require('../factory/loop-controller');
const instances = require('../db/factory-loop-instances');
const factoryHealth = require('../db/factory-health');
const factoryDecisions = require('../db/factory-decisions');

describe('loop-controller — verify silent-rerun', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT, config_json TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
      CREATE TABLE factory_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, batch_id TEXT,
        stage TEXT, action TEXT, reasoning TEXT, outcome_json TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO factory_projects (id, name, trust_level, config_json) VALUES ('proj-1', 't', 'dark', '{"feature_flags":{"verify_silent_rerun_enabled":true}}');
      INSERT INTO factory_loop_instances (id, project_id, batch_id, loop_state) VALUES ('inst-1', 'proj-1', 'batch-r1', 'VERIFY');
    `);
    runMigrations(db);
    instances.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('returns passed when silent rerun exits 0', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('passed');
    const deco = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-r1' AND action='verify_passed_on_silent_rerun'").get();
    expect(deco).toBeDefined();
    expect(runVerify).toHaveBeenCalledOnce();
  });

  it('returns same_failure when rerun fails with identical signature', async () => {
    const output = ' FAIL foo > A\n';
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 1, output });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: output, runVerify,
    });
    expect(result.kind).toBe('same_failure');
  });

  it('returns different_failure when rerun exits non-zero with different signature', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 1, output: ' FAIL foo > B\n' });
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('different_failure');
    expect(result.combinedOutput).toContain('foo > A');
    expect(result.combinedOutput).toContain('foo > B');
  });

  it('returns rerun_failed when runVerify throws', async () => {
    const runVerify = vi.fn().mockRejectedValue(new Error('remote unreachable'));
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('rerun_failed');
    const deco = db.prepare("SELECT action FROM factory_decisions WHERE batch_id='batch-r1' AND action='verify_silent_rerun_failed'").get();
    expect(deco).toBeDefined();
  });

  it('does not rerun when budget already consumed this batch', async () => {
    db.prepare("UPDATE factory_loop_instances SET verify_silent_reruns=1 WHERE id='inst-1'").run();
    const runVerify = vi.fn();
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('budget_exhausted');
    expect(runVerify).not.toHaveBeenCalled();
  });

  it('does not rerun when flag is off', async () => {
    db.prepare("UPDATE factory_projects SET config_json='{}' WHERE id='proj-1'").run();
    const runVerify = vi.fn();
    const result = await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    expect(result.kind).toBe('flag_off');
    expect(runVerify).not.toHaveBeenCalled();
  });

  it('bumps verify_silent_reruns atomically on each invocation that reaches the run', async () => {
    const runVerify = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });
    await loopController.__testing__.attemptSilentRerun({
      project_id: 'proj-1', batch_id: 'batch-r1', instance_id: 'inst-1',
      priorVerifyOutput: ' FAIL foo > A\n', runVerify,
    });
    const row = db.prepare("SELECT verify_silent_reruns FROM factory_loop_instances WHERE id='inst-1'").get();
    expect(row.verify_silent_reruns).toBe(1);
  });
});
```

- [ ] **Step 9.2: Run test to verify it fails**

Run: `torque-remote npx vitest run server/tests/factory-silent-rerun.test.js`
Expected: Fails — helpers do not yet exist.

- [ ] **Step 9.3: Add DB helpers**

In `server/db/factory-loop-instances.js`, before its `module.exports`, append:

```javascript
function bumpVerifySilentReruns(instance_id) {
  const database = getDb();
  const info = database.prepare(
    'UPDATE factory_loop_instances SET verify_silent_reruns = verify_silent_reruns + 1 WHERE id = ?'
  ).run(instance_id);
  return info.changes > 0;
}

function getVerifySilentReruns(instance_id) {
  const database = getDb();
  const row = database.prepare('SELECT verify_silent_reruns FROM factory_loop_instances WHERE id = ?').get(instance_id);
  return row ? row.verify_silent_reruns : 0;
}
```

Add `bumpVerifySilentReruns` and `getVerifySilentReruns` to the `module.exports` object.

- [ ] **Step 9.4: Implement `attemptSilentRerun`**

In `server/factory/loop-controller.js`, add below `maybeShipNoop`:

```javascript
async function attemptSilentRerun({
  project_id, batch_id, instance_id,
  priorVerifyOutput, runVerify,
}) {
  const { verifySignature } = require('./verify-signature');
  const instances = require('../db/factory-loop-instances');

  if (!isFactoryFeatureEnabled(project_id, 'verify_silent_rerun_enabled')) {
    return { kind: 'flag_off' };
  }
  if (instances.getVerifySilentReruns(instance_id) > 0) {
    return { kind: 'budget_exhausted' };
  }

  instances.bumpVerifySilentReruns(instance_id);

  safeLogDecision({
    project_id, batch_id, stage: LOOP_STATES.VERIFY,
    action: 'verify_silent_rerun_started',
    reasoning: 'Classifier was ambiguous; rerunning verify silently before spending a Codex retry slot.',
    outcome: { instance_id },
    confidence: 1,
  });

  let verifyResult;
  try {
    verifyResult = await runVerify();
  } catch (err) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_silent_rerun_failed',
      reasoning: `Silent rerun error: ${err.message}`,
      outcome: { instance_id, error: err.message },
      confidence: 1,
    });
    return { kind: 'rerun_failed', error: err.message };
  }

  if (verifyResult.exitCode === 0) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_passed_on_silent_rerun',
      reasoning: 'Silent rerun passed; advancing without spending a Codex retry.',
      outcome: { instance_id },
      confidence: 1,
    });
    return { kind: 'passed', output: verifyResult.output };
  }

  const prevSig = verifySignature(priorVerifyOutput);
  const currSig = verifySignature(verifyResult.output);

  if (prevSig && currSig && prevSig === currSig) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_rerun_same_failure',
      reasoning: 'Silent rerun produced the same failure signature; falling through to fix-task retry.',
      outcome: { instance_id, signature: currSig },
      confidence: 1,
    });
    return { kind: 'same_failure', output: verifyResult.output };
  }

  safeLogDecision({
    project_id, batch_id, stage: LOOP_STATES.VERIFY,
    action: 'verify_rerun_different_failure',
    reasoning: 'Silent rerun produced a different failure signature; passing both to the fix task.',
    outcome: { instance_id, prev_sig: prevSig, curr_sig: currSig },
    confidence: 1,
  });
  return {
    kind: 'different_failure',
    output: verifyResult.output,
    combinedOutput: `${priorVerifyOutput}\n---\n${verifyResult.output}`,
  };
}
```

Extend `__testing__`:

```javascript
    attemptSilentRerun,
```

Wire into the ambiguous branch. Find `verify_reviewed_ambiguous_retrying` (near L5282). In the block that currently logs the ambiguous decision and falls through, insert this call before today's fall-through. `runRemoteVerify` is the existing helper used for the initial verify invocation — grep around L5180 to find its real name; use the same helper here:

```javascript
            const silentResult = await attemptSilentRerun({
              project_id,
              batch_id,
              instance_id: instance && instance.id,
              priorVerifyOutput: verifyOutput,
              runVerify: async () => {
                const execResult = await runRemoteVerify({
                  worktreeRecord, verifyCommand, project,
                });
                return { exitCode: execResult.exitCode, output: execResult.output };
              },
            });

            if (silentResult.kind === 'passed') {
              return { status: 'passed' };
            }
            if (silentResult.kind === 'different_failure') {
              verifyOutput = silentResult.combinedOutput;
            }
            // same_failure, rerun_failed, flag_off, budget_exhausted → fall through to today's retry path
```

- [ ] **Step 9.5: Run test to verify it passes**

Run: `torque-remote npx vitest run server/tests/factory-silent-rerun.test.js`
Expected: 7 passing tests.

- [ ] **Step 9.6: Commit**

```bash
git add server/factory/loop-controller.js server/db/factory-loop-instances.js server/tests/factory-silent-rerun.test.js
git commit -m "feat(factory): silent verify-rerun on ambiguous classifier verdict"
```

---

## Task 10: Full-suite integration pass + docs

**Acceptance:** Full server test suite passes remotely; `docs/factory.md` references the new observability signals.

**Files:**
- Modify: `docs/factory.md` (new "Close-handler observability" section)

- [ ] **Step 10.1: Run full server test suite**

Run: `torque-remote npx vitest run server/tests/`
Expected: All tests pass (no regressions from the edits above).

- [ ] **Step 10.2: Update `docs/factory.md`**

Grep first to find the right insertion point: `grep -n "close-handler\|completion-pipeline\|zero-diff" docs/factory.md`. Insert the section below before the "Full safeguard documentation" footer, or adjacent to any existing close-handler content:

```markdown
## Close-Handler Observability (2026-04)

Every factory Codex task writes one row to `factory_attempt_history` on completion. The table captures: which plan task, files touched, last 1200 chars of Codex stdout, and (when no files changed) a classifier verdict — `already_in_place` / `blocked` / `precondition_missing` / `unknown`. Query the table to debug why a work item cycled through the loop without producing diffs.

Two feature flags on `factory_projects.config_json.feature_flags` gate behavioral changes:

- `auto_ship_noop_enabled` — classifier reason `already_in_place` with conf >= 0.8 → ship-noop, skip VERIFY.
- `verify_silent_rerun_enabled` — on ambiguous verify classifier verdict, rerun verify once silently before spending a Codex retry slot. Budget: one per batch, tracked on `factory_loop_instances.verify_silent_reruns`.

Decision-log actions to watch:
- `auto_commit_skipped_clean` — now carries `zero_diff_reason`, `classifier_source`, `classifier_conf`.
- `shipped_as_noop` — flag-gated auto-ship.
- `paused_at_gate` with `paused_reason: 'blocked_by_codex' | 'precondition_missing'` — classifier-triggered pause at EXECUTE.
- `verify_silent_rerun_started` / `verify_passed_on_silent_rerun` / `verify_rerun_same_failure` / `verify_rerun_different_failure` / `verify_silent_rerun_failed` — silent rerun lifecycle.

Retry fix prompts now include a "Prior attempts on this work item:" block (last 3 attempts, file counts, Codex summaries) and a "Verify error progression:" diff between the prior and current verify runs. See `server/factory/loop-controller.js` (`buildVerifyFixPrompt`) for the budget + rendering rules.

Design: `docs/superpowers/specs/2026-04-20-close-handler-retry-observability-design.md`
Plan:   `docs/superpowers/plans/2026-04-20-close-handler-observability.md`
```

- [ ] **Step 10.3: Commit**

```bash
git add docs/factory.md
git commit -m "docs(factory): document close-handler observability signals and flags"
```

---

## Post-plan operator rollout (outside the automated loop)

1. Cut over via `scripts/worktree-cutover.sh close-handler-observability`.
2. Wait 48 hours. Query `factory_attempt_history` to confirm rows are written on every completion and that heuristic bucket distribution matches spot-checks.
3. Enable LLM fallback by injecting a real `llmRouter` in the `worktree-auto-commit.js` call to `classifyZeroDiff` (bound to `smart_submit_task` with `provider: 'codex-spark'`). One-line change when ready.
4. Flip `factory.verify_silent_rerun_enabled=true` on torque-public's `config_json`. Monitor `verify_passed_on_silent_rerun` rate — should be >= 15% of ambiguous events.
5. After >= 20 `already_in_place` classifications have been spot-checked against shipped-noop candidates, flip `factory.auto_ship_noop_enabled=true`.
