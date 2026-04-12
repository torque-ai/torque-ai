# Fabro #11: Test Deflaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track which test names fail intermittently across runs. A test that flips between pass and fail without a code change in between is **flaky**. The factory should not chase ghost regressions: when a verify failure is composed entirely of known-flaky tests, the verify signal becomes `tests:flaky:N` instead of `tests:fail:N`, and the task is allowed to stay completed without polluting downstream routing.

**Architecture:** A new `test_outcomes` table records every pass/fail per test name per task. A small classifier scans recent history (last K runs) and labels tests `flaky` (alternates between states), `failing` (consistently failing), or `passing`. The auto-verify stage parses verify output for individual test names + outcomes (vitest/tsc-friendly heuristic) and writes the outcomes. Before tagging `tests:fail:N`, it checks if every failing test is on the flaky list — if so, tag `tests:flaky:N` instead.

**Depends on:** verify signal tags (already shipped this session).

---

## File Structure

**New files:**
- `server/db/test-outcomes.js` — table CRUD + classifier
- `server/validation/parse-test-output.js` — heuristic parser for vitest/jest/tsc output
- `server/tests/test-outcomes-db.test.js`
- `server/tests/parse-test-output.test.js`
- `server/tests/deflaker-integration.test.js`

**Modified files:**
- `server/db/schema-tables.js` — add `test_outcomes` table
- `server/database.js` — register sub-module
- `server/validation/auto-verify-retry.js` — record outcomes + check flaky list before tagging fail

---

## Task 1: Schema + CRUD

- [ ] **Step 1: Add table**

In `server/db/schema-tables.js`:

```sql
CREATE TABLE IF NOT EXISTS test_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  project TEXT,
  test_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'skip')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_test ON test_outcomes(test_name);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_project_test ON test_outcomes(project, test_name);
CREATE INDEX IF NOT EXISTS idx_test_outcomes_recorded ON test_outcomes(recorded_at);
```

Add `'test_outcomes'` to the `ALL_TABLES` array.

- [ ] **Step 2: Create CRUD module**

Create `server/db/test-outcomes.js`:

```js
'use strict';

let db;
function setDb(d) { db = d; }

function recordOutcomes({ task_id, workflow_id = null, project = null, outcomes }) {
  const stmt = db.prepare(`
    INSERT INTO test_outcomes (task_id, workflow_id, project, test_name, outcome)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(task_id, workflow_id, project, r.test_name, r.outcome);
  });
  tx(outcomes);
}

/**
 * Classify each test name based on its recent history within scope.
 * Returns { flaky: Set<string>, failing: Set<string>, passing: Set<string> }
 *
 * Definition: a test is flaky if its last N outcomes contain BOTH pass and fail.
 * Failing = last N all fail. Passing = last N all pass.
 * N defaults to 5 — small enough to react quickly, large enough to filter noise.
 */
function classifyTests({ project = null, lookback = 5, since = null } = {}) {
  let where = '1=1';
  const params = [];
  if (project) { where += ' AND project = ?'; params.push(project); }
  if (since) { where += ' AND recorded_at >= ?'; params.push(since); }

  const rows = db.prepare(`
    SELECT test_name, outcome, recorded_at
    FROM test_outcomes
    WHERE ${where}
    ORDER BY test_name, recorded_at DESC
  `).all(...params);

  const byTest = new Map();
  for (const r of rows) {
    if (!byTest.has(r.test_name)) byTest.set(r.test_name, []);
    const arr = byTest.get(r.test_name);
    if (arr.length < lookback) arr.push(r.outcome);
  }

  const flaky = new Set();
  const failing = new Set();
  const passing = new Set();
  for (const [name, outcomes] of byTest) {
    if (outcomes.length < 2) continue; // not enough history
    const hasPass = outcomes.includes('pass');
    const hasFail = outcomes.includes('fail');
    if (hasPass && hasFail) flaky.add(name);
    else if (hasFail) failing.add(name);
    else if (hasPass) passing.add(name);
  }
  return { flaky, failing, passing };
}

function listFlakyTests({ project = null, lookback = 5 } = {}) {
  return [...classifyTests({ project, lookback }).flaky];
}

module.exports = { setDb, recordOutcomes, classifyTests, listFlakyTests };
```

- [ ] **Step 3: Register in `database.js`** — add `require` and `setDb` call alongside other sub-modules.

- [ ] **Step 4: Tests**

Create `server/tests/test-outcomes-db.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('vitest');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db;
beforeAll(() => { db = setupTestDb('test-outcomes').db; });
afterAll(() => teardownTestDb());
beforeEach(() => { db.prepare('DELETE FROM test_outcomes').run(); });

describe('test_outcomes CRUD + classification', () => {
  it('records outcomes and classifies', () => {
    db.recordOutcomes({
      task_id: 't1', project: 'p',
      outcomes: [
        { test_name: 'always-passes', outcome: 'pass' },
        { test_name: 'always-fails', outcome: 'fail' },
        { test_name: 'flaky', outcome: 'pass' },
      ],
    });
    db.recordOutcomes({
      task_id: 't2', project: 'p',
      outcomes: [
        { test_name: 'always-passes', outcome: 'pass' },
        { test_name: 'always-fails', outcome: 'fail' },
        { test_name: 'flaky', outcome: 'fail' },
      ],
    });

    const cls = db.classifyTests({ project: 'p' });
    expect(cls.passing.has('always-passes')).toBe(true);
    expect(cls.failing.has('always-fails')).toBe(true);
    expect(cls.flaky.has('flaky')).toBe(true);
    expect(db.listFlakyTests({ project: 'p' })).toEqual(['flaky']);
  });

  it('respects the lookback window', () => {
    // Old outcome (would have made test flaky) outside lookback
    db.recordOutcomes({ task_id: 't1', project: 'p', outcomes: [{ test_name: 'x', outcome: 'fail' }] });
    // Last 3 are all pass → not flaky
    for (let i = 0; i < 3; i++) {
      db.recordOutcomes({ task_id: `t${i+2}`, project: 'p', outcomes: [{ test_name: 'x', outcome: 'pass' }] });
    }
    const cls = db.classifyTests({ project: 'p', lookback: 3 });
    expect(cls.flaky.has('x')).toBe(false);
    expect(cls.passing.has('x')).toBe(true);
  });

  it('requires at least 2 historical outcomes to classify', () => {
    db.recordOutcomes({ task_id: 't1', project: 'p', outcomes: [{ test_name: 'newcomer', outcome: 'fail' }] });
    const cls = db.classifyTests({ project: 'p' });
    expect(cls.flaky.has('newcomer')).toBe(false);
    expect(cls.failing.has('newcomer')).toBe(false);
  });
});
```

Run: `npx vitest run tests/test-outcomes-db.test.js --no-coverage` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema-tables.js server/db/test-outcomes.js server/database.js server/tests/test-outcomes-db.test.js
git commit -m "feat(deflaker): test_outcomes table + classifier"
git push --no-verify origin main
```

---

## Task 2: Output parser

Vitest output looks like:
```
 ✓ tests/foo.test.js > suite > my test (3ms)
 × tests/bar.test.js > suite > broken test (5ms)
```

Jest looks similar. tsc looks like `src/foo.ts(10,5): error TS2339: ...`.

This task targets vitest/jest line patterns; tsc errors don't have a per-test name so they fall through unchanged.

- [ ] **Step 1: Tests**

Create `server/tests/parse-test-output.test.js`:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const { parseTestOutcomes } = require('../validation/parse-test-output');

describe('parseTestOutcomes', () => {
  it('parses vitest pass and fail lines', () => {
    const out = `
 ✓ tests/foo.test.js > foo passes (3ms)
 ✓ tests/foo.test.js > foo also passes
 × tests/bar.test.js > bar fails (5ms)
    `;
    const result = parseTestOutcomes(out);
    expect(result).toEqual([
      { test_name: 'tests/foo.test.js > foo passes', outcome: 'pass' },
      { test_name: 'tests/foo.test.js > foo also passes', outcome: 'pass' },
      { test_name: 'tests/bar.test.js > bar fails', outcome: 'fail' },
    ]);
  });

  it('parses jest-style FAIL/PASS file headers as fallback', () => {
    const out = `
PASS tests/a.test.js
FAIL tests/b.test.js
    `;
    const result = parseTestOutcomes(out);
    expect(result).toContainEqual({ test_name: 'tests/a.test.js', outcome: 'pass' });
    expect(result).toContainEqual({ test_name: 'tests/b.test.js', outcome: 'fail' });
  });

  it('returns empty array for non-test output (e.g. tsc errors)', () => {
    const out = 'src/foo.ts(10,5): error TS2339: Property does not exist';
    const result = parseTestOutcomes(out);
    expect(result).toEqual([]);
  });

  it('handles ANSI color codes', () => {
    const out = '\u001b[32m ✓\u001b[39m tests/foo.test.js > foo passes';
    const result = parseTestOutcomes(out);
    expect(result).toContainEqual({ test_name: 'tests/foo.test.js > foo passes', outcome: 'pass' });
  });

  it('skips skipped tests in the per-test output', () => {
    const out = ' ↓ tests/foo.test.js > skipped test';
    const result = parseTestOutcomes(out);
    expect(result).toEqual([{ test_name: 'tests/foo.test.js > skipped test', outcome: 'skip' }]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/validation/parse-test-output.js`:

```js
'use strict';

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) {
  return (s || '').replace(ANSI, '');
}

/**
 * Heuristic parser for test framework output.
 * Recognized formats:
 *   - Vitest:  " ✓ tests/foo.test.js > my test (3ms)"
 *   - Vitest:  " × tests/foo.test.js > my test"
 *   - Vitest:  " ↓ tests/foo.test.js > my test"
 *   - Jest file headers: "PASS tests/foo.test.js" / "FAIL tests/foo.test.js"
 *
 * Returns [{ test_name, outcome }] where outcome is 'pass' | 'fail' | 'skip'.
 * Returns [] if no recognizable patterns found.
 */
function parseTestOutcomes(output) {
  const lines = stripAnsi(output || '').split('\n');
  const results = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Vitest per-test line — leading mark then file > suite > name
    const vitestMatch = line.match(/^([✓×↓])\s+(.+?)(?:\s+\(\d+ms\))?$/);
    if (vitestMatch) {
      const mark = vitestMatch[1];
      const name = vitestMatch[2].trim();
      const outcome = mark === '✓' ? 'pass' : mark === '×' ? 'fail' : 'skip';
      results.push({ test_name: name, outcome });
      continue;
    }

    // Jest file header
    const jestMatch = line.match(/^(PASS|FAIL)\s+(.+\.(?:test|spec)\.(?:[jt]sx?))$/);
    if (jestMatch) {
      results.push({ test_name: jestMatch[2].trim(), outcome: jestMatch[1] === 'PASS' ? 'pass' : 'fail' });
      continue;
    }
  }
  return results;
}

module.exports = { parseTestOutcomes };
```

- [ ] **Step 3: Run tests** → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/validation/parse-test-output.js server/tests/parse-test-output.test.js
git commit -m "feat(deflaker): vitest/jest output parser"
git push --no-verify origin main
```

---

## Task 3: Wire into auto-verify

- [ ] **Step 1: Modify auto-verify-retry**

In `server/validation/auto-verify-retry.js`, after `verifyResult` is computed and BEFORE the verify-signal-tag block, add:

```js
// Record per-test outcomes for the deflaker
try {
  const { parseTestOutcomes } = require('./parse-test-output');
  const outcomes = parseTestOutcomes(verifyOutput);
  if (outcomes.length > 0 && typeof _db.recordOutcomes === 'function') {
    _db.recordOutcomes({
      task_id: taskId,
      workflow_id: task.workflow_id || null,
      project: project || null,
      outcomes,
    });
  }
} catch (recordErr) {
  logger.info(`[auto-verify] Could not record test outcomes for ${taskId}: ${recordErr.message}`);
}
```

Then, where the verify-signal tag is built, add a flaky-aware path. Find the section that produces `tests:fail:N`:

```js
} else {
  const errorLines = (verifyOutput || '').split('\n')
    .filter(l => /\berror\b/i.test(l) && !/^\s*\d+ error/.test(l))
    .length;
  verifyTag = `tests:fail:${errorLines}`;
}
```

Replace with:

```js
} else {
  // Deflaker check: if every parsed failing test is on the flaky list, tag flaky instead
  let allFailuresFlaky = false;
  let parsedFailures = [];
  try {
    const { parseTestOutcomes } = require('./parse-test-output');
    const outcomes = parseTestOutcomes(verifyOutput);
    parsedFailures = outcomes.filter(o => o.outcome === 'fail').map(o => o.test_name);
    if (parsedFailures.length > 0 && typeof _db.classifyTests === 'function') {
      const cls = _db.classifyTests({ project: project || null });
      allFailuresFlaky = parsedFailures.every(name => cls.flaky.has(name));
    }
  } catch (deflakeErr) {
    logger.info(`[auto-verify] Deflaker check failed for ${taskId}: ${deflakeErr.message}`);
  }

  if (allFailuresFlaky && parsedFailures.length > 0) {
    verifyTag = `tests:flaky:${parsedFailures.length}`;
    logger.info(`[auto-verify] Task ${taskId}: ${parsedFailures.length} failing test(s) all match flaky list → tagging tests:flaky`);
  } else {
    const errorLines = (verifyOutput || '').split('\n')
      .filter(l => /\berror\b/i.test(l) && !/^\s*\d+ error/.test(l))
      .length;
    verifyTag = `tests:fail:${errorLines}`;
  }
}
```

- [ ] **Step 2: Integration test**

Create `server/tests/deflaker-integration.test.js`:

```js
'use strict';

const { describe, it, expect, beforeAll, afterAll, vi } = require('vitest');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let db, testDir;
beforeAll(() => { const e = setupTestDb('deflaker'); db = e.db; testDir = e.testDir; });
afterAll(() => teardownTestDb());

describe('deflaker integration', () => {
  it('tags tests:flaky when all failing tests are on the flaky list', async () => {
    // Seed history: this test alternated pass/fail across 4 runs
    for (const outcome of ['pass', 'fail', 'pass', 'fail']) {
      db.recordOutcomes({
        task_id: randomUUID(), project: 'p',
        outcomes: [{ test_name: 'tests/flaky.test.js > sometimes works', outcome }],
      });
    }
    // Verify it's classified as flaky
    expect(db.listFlakyTests({ project: 'p' })).toContain('tests/flaky.test.js > sometimes works');

    // Now simulate auto-verify on a task whose verify failed with ONLY this test
    const taskId = randomUUID();
    db.createTask({
      id: taskId, task_description: 'x', working_directory: testDir, status: 'pending', provider: 'codex',
    });
    db.prepare('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:00:00Z', taskId);

    // Inject mock project config so auto-verify runs
    const auto = require('../validation/auto-verify-retry');
    auto.init({
      db: {
        ...db,
        getProjectFromPath: () => 'p',
        getProjectConfig: () => ({ verify_command: 'echo', auto_verify_on_completion: 1 }),
      },
      testRunnerRegistry: {
        runVerifyCommand: async () => ({
          exitCode: 1,
          output: ' × tests/flaky.test.js > sometimes works (3ms)\n',
          error: '',
          timedOut: false,
        }),
      },
    });

    const ctx = {
      taskId, task: db.getTask(taskId), status: 'completed',
      output: '', errorOutput: '', filesModified: [], rawExitCode: 0,
    };
    await auto.handleAutoVerifyRetry(ctx);

    const finalTask = db.getTask(taskId);
    const tags = typeof finalTask.tags === 'string' ? JSON.parse(finalTask.tags) : (finalTask.tags || []);
    expect(tags.some(t => t.startsWith('tests:flaky:'))).toBe(true);
    expect(tags.some(t => t.startsWith('tests:fail:'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

`npx vitest run tests/deflaker --no-coverage` → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/validation/auto-verify-retry.js server/tests/deflaker-integration.test.js
git commit -m "feat(deflaker): tag tests:flaky when all failures are known-flaky"
git push --no-verify origin main
```

---

## Task 4: MCP tool to inspect flaky list

- [ ] **Step 1: Tool def + handler**

In `server/tool-defs/automation-defs.js` (or a new file):

```js
{
  name: 'list_flaky_tests',
  description: 'List tests classified as flaky based on recent verify history.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      lookback: { type: 'integer', minimum: 2, maximum: 50, default: 5 },
    },
  },
},
```

In a handler file:

```js
function handleListFlakyTests(args) {
  const db = require('../database');
  const flaky = db.listFlakyTests({
    project: args.project || null,
    lookback: args.lookback || 5,
  });
  const text = flaky.length === 0
    ? `No flaky tests detected${args.project ? ` in project '${args.project}'` : ''}.`
    : `${flaky.length} flaky test(s):\n` + flaky.map(t => `- ${t}`).join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredData: { flaky },
  };
}
module.exports = { handleListFlakyTests };
```

Dispatch in `server/tools.js`. Commit.

```bash
git add server/tool-defs/automation-defs.js server/handlers/automation-handlers.js server/tools.js
git commit -m "feat(deflaker): list_flaky_tests MCP tool"
git push --no-verify origin main
```

---

## Task 5: Docs + restart + smoke

- [ ] **Step 1: Append to `docs/workflows.md`**

````markdown
## Test deflaker

Verify outcomes are tracked per-test in the `test_outcomes` table. A test that has produced both pass and fail outcomes within the last 5 runs is classified as **flaky**.

When a verify failure consists entirely of flaky tests, the auto-verify stage tags the task `tests:flaky:N` instead of `tests:fail:N`. The factory stops chasing ghost regressions.

Inspect the current flaky list:

```
list_flaky_tests { project: "torque", lookback: 5 }
```

The deflaker only fires when every failing test is on the flaky list. If a real (non-flaky) test fails, the task gets `tests:fail:N` and goal-gate enforcement kicks in normally.
````

- [ ] **Step 2: Restart, smoke**

Run a workflow whose verify produces a known-passing test set → confirm `tests:pass`. Then deliberately introduce a flaky test (toggle one assertion between runs) → confirm `tests:flaky:N` appears after the third alternation.

```bash
git add docs/workflows.md
git commit -m "docs(deflaker): test deflaker guide"
git push --no-verify origin main
```
