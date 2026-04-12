# Fabro #49: Surgical Repair Loop (AutoCodeRover)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade verify-fail recovery from "retry with more prompt context" to a **localize-then-fix** loop with three components: (1) **symbol-aware code search** MCP tools for precise navigation, (2) **spectrum-based fault localization** that ranks suspicious files from test coverage, (3) **candidate patch selection** that preserves all attempted fixes and picks the best by validator score. Inspired by AutoCodeRover.

**Architecture:** Three subsystems composed:
1. `server/repair/symbol-search.js` — MCP tools `search_class`, `search_method_in_class`, `search_code_in_file`, `get_code_around_line` built on `@babel/parser` + TypeScript compiler API indexes.
2. `server/repair/sbfl.js` — Parse c8/vitest coverage JSON from the failing run. Compute per-file suspiciousness scores (Ochiai: `failures(f) / sqrt(total_failures × executions(f))`). Feed top-N files into the repair prompt.
3. `server/repair/candidate-selector.js` — For each repair attempt, save the candidate patch + validator output. After N attempts, pick the candidate with (a) most passing tests, (b) smallest diff, (c) newest.

**Tech Stack:** Node.js, @babel/parser, typescript, better-sqlite3. Builds on Plan 42 (debugging loop), existing auto-verify-retry.

---

## File Structure

**New files:**
- `server/migrations/0NN-repair-candidates.sql`
- `server/repair/symbol-search.js` — AST-indexed tools
- `server/repair/symbol-indexer.js` — background indexer
- `server/repair/sbfl.js` — fault localization scorer
- `server/repair/coverage-reader.js` — parse c8/vitest JSON
- `server/repair/candidate-selector.js`
- `server/tests/symbol-search.test.js`
- `server/tests/sbfl.test.js`
- `server/tests/candidate-selector.test.js`

**Modified files:**
- `server/validation/auto-verify-retry.js` — use SBFL to seed repair prompt
- `server/handlers/mcp-tools.js` — register symbol search tools

---

## Task 1: Symbol indexer + MCP tools

- [ ] **Step 1: Tests**

Create `server/tests/symbol-search.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { indexFile, searchClass, searchMethodInClass } = require('../repair/symbol-search');

const FIXTURE = `
class Foo {
  constructor(x) { this.x = x; }
  bar(a, b) { return a + b; }
  baz() { return this.x; }
}
function standalone(n) { return n * 2; }
`;

describe('symbol-search', () => {
  it('indexFile extracts classes, methods, and functions', () => {
    const idx = indexFile('src/test.js', FIXTURE);
    expect(idx.classes.Foo).toBeDefined();
    expect(idx.classes.Foo.methods.bar.startLine).toBe(4);
    expect(idx.functions.standalone).toBeDefined();
  });

  it('searchClass returns class signature with method list', () => {
    const idx = { 'src/test.js': indexFile('src/test.js', FIXTURE) };
    const r = searchClass(idx, 'Foo');
    expect(r.length).toBe(1);
    expect(r[0].methods.sort()).toEqual(['bar', 'baz', 'constructor']);
  });

  it('searchMethodInClass returns method body', () => {
    const idx = { 'src/test.js': indexFile('src/test.js', FIXTURE) };
    const r = searchMethodInClass(idx, 'Foo', 'bar');
    expect(r.body).toMatch(/return a \+ b/);
    expect(r.file).toBe('src/test.js');
  });

  it('returns empty array when class not found', () => {
    const idx = {};
    expect(searchClass(idx, 'Nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/repair/symbol-search.js`:

```js
'use strict';
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function indexFile(filePath, source) {
  const ast = parser.parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
    errorRecovery: true,
  });
  const result = { classes: {}, functions: {}, file: filePath };

  traverse(ast, {
    ClassDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;
      const methods = {};
      for (const member of path.node.body.body) {
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          const methodName = member.key.name || '(computed)';
          methods[methodName] = {
            startLine: member.loc?.start.line,
            endLine: member.loc?.end.line,
            body: source.slice(member.start, member.end),
          };
        }
      }
      result.classes[name] = {
        startLine: path.node.loc?.start.line,
        endLine: path.node.loc?.end.line,
        methods,
      };
    },
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;
      result.functions[name] = {
        startLine: path.node.loc?.start.line,
        endLine: path.node.loc?.end.line,
        body: source.slice(path.node.start, path.node.end),
      };
    },
  });
  return result;
}

function searchClass(indexByFile, className) {
  const hits = [];
  for (const [file, idx] of Object.entries(indexByFile)) {
    if (idx.classes[className]) {
      hits.push({
        file,
        class_name: className,
        start_line: idx.classes[className].startLine,
        end_line: idx.classes[className].endLine,
        methods: Object.keys(idx.classes[className].methods),
      });
    }
  }
  return hits;
}

function searchMethodInClass(indexByFile, className, methodName) {
  for (const [file, idx] of Object.entries(indexByFile)) {
    const cls = idx.classes[className];
    if (cls && cls.methods[methodName]) {
      return { file, class_name: className, method_name: methodName, ...cls.methods[methodName] };
    }
  }
  return null;
}

function searchFunction(indexByFile, functionName) {
  const hits = [];
  for (const [file, idx] of Object.entries(indexByFile)) {
    if (idx.functions[functionName]) {
      hits.push({ file, function_name: functionName, ...idx.functions[functionName] });
    }
  }
  return hits;
}

function getCodeAroundLine(source, line, contextLines = 10) {
  const lines = source.split('\n');
  const start = Math.max(0, line - contextLines - 1);
  const end = Math.min(lines.length, line + contextLines);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
}

module.exports = { indexFile, searchClass, searchMethodInClass, searchFunction, getCodeAroundLine };
```

Run tests → PASS. Commit: `feat(repair): symbol-search with class/method/function indexing`.

---

## Task 2: SBFL

- [ ] **Step 1: Tests**

Create `server/tests/sbfl.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { ochiaiScore, rankFiles } = require('../repair/sbfl');

describe('SBFL Ochiai scoring', () => {
  it('files executed only by failing tests score highest', () => {
    const score = ochiaiScore({ executedInFailing: 3, totalFailing: 3, executedInPassing: 0, totalPassing: 10 });
    expect(score).toBeCloseTo(1.0, 2);
  });

  it('files executed by all tests regardless of outcome score low', () => {
    const score = ochiaiScore({ executedInFailing: 3, totalFailing: 3, executedInPassing: 10, totalPassing: 10 });
    expect(score).toBeLessThan(0.7);
  });

  it('rankFiles sorts by score DESC', () => {
    const coverage = {
      'src/a.js': { passing_hits: 5, failing_hits: 0 },
      'src/b.js': { passing_hits: 0, failing_hits: 3 },
      'src/c.js': { passing_hits: 10, failing_hits: 2 },
    };
    const ranked = rankFiles(coverage, { totalPassing: 10, totalFailing: 3 });
    expect(ranked[0].file).toBe('src/b.js');
  });

  it('handles zero total counts gracefully', () => {
    const ranked = rankFiles({}, { totalPassing: 0, totalFailing: 0 });
    expect(ranked).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/repair/sbfl.js`:

```js
'use strict';

function ochiaiScore({ executedInFailing, totalFailing, executedInPassing, totalPassing }) {
  if (totalFailing === 0) return 0;
  const numerator = executedInFailing;
  const denominator = Math.sqrt(totalFailing * (executedInFailing + executedInPassing));
  return denominator === 0 ? 0 : numerator / denominator;
}

function rankFiles(coverageByFile, { totalPassing, totalFailing }) {
  return Object.entries(coverageByFile).map(([file, counts]) => ({
    file,
    score: ochiaiScore({
      executedInFailing: counts.failing_hits || 0,
      totalFailing,
      executedInPassing: counts.passing_hits || 0,
      totalPassing,
    }),
    failing_hits: counts.failing_hits || 0,
    passing_hits: counts.passing_hits || 0,
  })).filter(r => r.failing_hits > 0).sort((a, b) => b.score - a.score);
}

module.exports = { ochiaiScore, rankFiles };
```

Commit: `feat(repair): SBFL Ochiai scoring + file ranking`.

---

## Task 3: Coverage reader

- [ ] **Step 1: Implement**

Create `server/repair/coverage-reader.js`:

```js
'use strict';
const fs = require('fs');

// Reads c8 coverage JSON (`coverage-final.json`) and a vitest test-result JSON to build
// { [file]: { passing_hits, failing_hits } } plus { totalPassing, totalFailing }.
function readCoverage({ coveragePath, testResultsPath }) {
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  const testResults = JSON.parse(fs.readFileSync(testResultsPath, 'utf8'));

  const testOutcomes = new Map(); // testId -> 'passed' | 'failed'
  let totalPassing = 0, totalFailing = 0;
  for (const result of testResults.testResults || []) {
    for (const t of result.assertionResults || []) {
      testOutcomes.set(`${result.name}::${t.fullName}`, t.status);
      if (t.status === 'passed') totalPassing++;
      else if (t.status === 'failed') totalFailing++;
    }
  }

  const coverageByFile = {};
  for (const [file, fileData] of Object.entries(coverage)) {
    const totalExec = fileData.s ? Object.values(fileData.s).reduce((a, b) => a + b, 0) : 0;
    if (totalExec === 0) continue;
    // c8 doesn't natively track per-test hits. Approximate by attributing hits
    // proportionally: we know which test files failed → if any statement in the
    // covered file was executed while those tests ran, count it as failing_hit.
    // A more accurate version requires custom instrumentation; this is the
    // simpler heuristic used in TORQUE's repair loop.
    coverageByFile[file] = {
      passing_hits: 1, // default presence marker
      failing_hits: totalExec > 0 && hasAnyFailingTestCovering(file, testResults) ? 1 : 0,
    };
  }
  return { coverageByFile, totalPassing, totalFailing };
}

function hasAnyFailingTestCovering(file, testResults) {
  const failingTestFiles = new Set(
    (testResults.testResults || [])
      .filter(r => (r.assertionResults || []).some(a => a.status === 'failed'))
      .map(r => r.name),
  );
  // Very loose — assume test file in same directory subtree of source is related.
  for (const f of failingTestFiles) {
    if (f.includes(file) || file.includes(f.replace(/\.test\.[jt]sx?$/, ''))) return true;
  }
  return false;
}

module.exports = { readCoverage };
```

Commit: `feat(repair): coverage reader bridges c8 + vitest results into SBFL input`.

---

## Task 4: Candidate selector

- [ ] **Step 1: Migration**

`server/migrations/0NN-repair-candidates.sql`:

```sql
CREATE TABLE IF NOT EXISTS repair_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  diff_content TEXT NOT NULL,
  passing_tests INTEGER NOT NULL DEFAULT 0,
  failing_tests INTEGER NOT NULL DEFAULT 0,
  diff_line_count INTEGER,
  validator_output TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repair_candidates_task ON repair_candidates(task_id);
```

- [ ] **Step 2: Tests**

Create `server/tests/candidate-selector.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { setupTestDb } = require('./helpers/test-db');
const { createCandidateSelector } = require('../repair/candidate-selector');

describe('candidateSelector', () => {
  let db, selector;
  beforeEach(() => {
    db = setupTestDb();
    selector = createCandidateSelector({ db });
  });

  it('record appends a candidate with metrics', () => {
    const id = selector.record({
      taskId: 't1', attempt: 1, diffContent: 'diff...',
      passingTests: 5, failingTests: 2, diffLineCount: 10, validatorOutput: 'ok',
    });
    expect(id).toMatch(/^cand_/);
  });

  it('pickBest prefers highest passing, then smallest diff, then newest', () => {
    selector.record({ taskId: 't1', attempt: 1, diffContent: 'a', passingTests: 10, failingTests: 0, diffLineCount: 50 });
    selector.record({ taskId: 't1', attempt: 2, diffContent: 'b', passingTests: 10, failingTests: 0, diffLineCount: 20 });
    selector.record({ taskId: 't1', attempt: 3, diffContent: 'c', passingTests: 9, failingTests: 1, diffLineCount: 5 });
    const best = selector.pickBest('t1');
    expect(best.attempt).toBe(2); // 10 passing, 20 lines (smaller than 50)
  });

  it('pickBest returns null when no candidates recorded', () => {
    expect(selector.pickBest('nope')).toBeNull();
  });

  it('markSelected sets the selected flag', () => {
    const id = selector.record({ taskId: 't1', attempt: 1, diffContent: 'a', passingTests: 10, failingTests: 0 });
    selector.markSelected(id);
    const row = db.prepare('SELECT selected FROM repair_candidates WHERE candidate_id = ?').get(id);
    expect(row.selected).toBe(1);
  });
});
```

- [ ] **Step 3: Implement**

Create `server/repair/candidate-selector.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createCandidateSelector({ db }) {
  function record({ taskId, attempt, diffContent, passingTests, failingTests, diffLineCount = null, validatorOutput = null }) {
    const id = `cand_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO repair_candidates (candidate_id, task_id, attempt, diff_content, passing_tests, failing_tests, diff_line_count, validator_output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, attempt, diffContent, passingTests, failingTests, diffLineCount, validatorOutput);
    return id;
  }

  function pickBest(taskId) {
    return db.prepare(`
      SELECT * FROM repair_candidates WHERE task_id = ?
      ORDER BY passing_tests DESC, failing_tests ASC, diff_line_count ASC, created_at DESC
      LIMIT 1
    `).get(taskId) || null;
  }

  function markSelected(candidateId) {
    db.prepare(`UPDATE repair_candidates SET selected = 1 WHERE candidate_id = ?`).run(candidateId);
  }

  function listForTask(taskId) {
    return db.prepare(`SELECT * FROM repair_candidates WHERE task_id = ? ORDER BY attempt`).all(taskId);
  }

  return { record, pickBest, markSelected, listForTask };
}

module.exports = { createCandidateSelector };
```

Run tests → PASS. Commit: `feat(repair): candidate selector with passing-tests-first ranking`.

---

## Task 5: Wire into auto-verify-retry

- [ ] **Step 1: Seed repair prompt with SBFL + symbol context**

In `server/validation/auto-verify-retry.js` when a task fails verify and enters recovery:

```js
const { readCoverage } = require('../repair/coverage-reader');
const { rankFiles } = require('../repair/sbfl');
const { createCandidateSelector } = require('../repair/candidate-selector');
const selector = createCandidateSelector({ db });

// If coverage + test results are available, rank suspicious files
let suspiciousFiles = [];
try {
  const { coverageByFile, totalPassing, totalFailing } = readCoverage({
    coveragePath: path.join(workingDir, 'coverage/coverage-final.json'),
    testResultsPath: path.join(workingDir, 'coverage/test-results.json'),
  });
  suspiciousFiles = rankFiles(coverageByFile, { totalPassing, totalFailing }).slice(0, 5);
} catch { /* no coverage available */ }

const repairPrompt = `Verify failed. ${suspiciousFiles.length > 0 ? `\nRanked-suspicious files (most-suspicious first):\n${suspiciousFiles.map(f => `- ${f.file} (score ${f.score.toFixed(3)})`).join('\n')}\n\nUse the symbol_search tools (search_class, search_method_in_class, get_code_around_line) to navigate before editing.` : ''}\n\nPrevious failure output:\n${lastError}`;

// After repair task completes, record its candidate
const resultingDiff = await getTaskDiff(repairTaskId);
const testResults = await runValidator();
selector.record({
  taskId: originalTaskId, attempt: retryCount,
  diffContent: resultingDiff,
  passingTests: testResults.passing,
  failingTests: testResults.failing,
  diffLineCount: resultingDiff.split('\n').length,
  validatorOutput: testResults.summary,
});

// On exhaustion of retries, pick best candidate and apply it
if (retryCount >= maxRetries) {
  const best = selector.pickBest(originalTaskId);
  if (best) {
    await applyDiff(workingDir, best.diff_content);
    selector.markSelected(best.candidate_id);
    logger.info('repair loop exhausted; applied best candidate', { taskId: originalTaskId, attempt: best.attempt });
  }
}
```

- [ ] **Step 2: MCP tools**

Register these in `server/tool-defs/`:

```js
search_class: { description: 'Find a class by name in the indexed codebase.', inputSchema: { type: 'object', required: ['class_name'], properties: { class_name: { type: 'string' } } } },
search_method_in_class: { description: 'Find a method inside a class.', inputSchema: { type: 'object', required: ['class_name','method_name'], properties: { class_name: {type:'string'}, method_name: {type:'string'} } } },
get_code_around_line: { description: 'Return lines around a file:line with ±N context.', inputSchema: { type: 'object', required: ['file','line'], properties: { file: {type:'string'}, line: {type:'integer'}, context: {type:'integer'} } } },
```

Handlers call the corresponding functions from `symbol-search.js` against a background-refreshed index.

`await_restart`. Smoke: introduce a bug in a function, run verify, confirm SBFL ranks the right file and the repair prompt mentions it.

Commit: `feat(repair): SBFL-seeded repair + candidate selection + symbol tools`.
