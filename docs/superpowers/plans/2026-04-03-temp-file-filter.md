# Temp File Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent temp/debug files from being auto-committed by TORQUE's completion pipeline, with configurable patterns and governance detection.

**Architecture:** A shared `temp-file-filter.js` utility provides `filterTempFiles(paths, projectConfig)` that removes paths matching temp patterns. Three auto-commit call sites filter before `git add`. A governance rule scans completed task diffs for temp artifacts in shadow mode.

**Tech Stack:** Node.js, CommonJS, minimatch-style glob patterns (hand-rolled — no new dependencies)

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `server/utils/temp-file-filter.js` | Shared filter logic + default patterns | Create: ~60 lines |
| `server/tests/temp-file-filter.test.js` | Tests for the filter | Create: ~80 lines |
| `server/handlers/auto-commit-batch.js` | `auto_commit_batch` MCP tool | Modify: add filter at line ~155 |
| `server/handlers/workflow/await.js` | `await_task` + `await_workflow` auto-commit | Modify: add filter at lines ~1501 and ~1047 |
| `server/db/governance-rules.js` | Builtin governance rules | Modify: add `reject-temp-files` rule |
| `server/tests/governance-rules.test.js` | Governance rule tests | Modify: update count 13→14 |

---

## Task 1: Create the Shared Filter Utility

**Files:**
- Create: `server/utils/temp-file-filter.js`
- Create: `server/tests/temp-file-filter.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/temp-file-filter.test.js`:

```js
'use strict';

const { filterTempFiles, isTempFile, DEFAULT_TEMP_PATTERNS } = require('../utils/temp-file-filter');

describe('temp-file-filter', () => {
  it('exports DEFAULT_TEMP_PATTERNS as a frozen array', () => {
    expect(Array.isArray(DEFAULT_TEMP_PATTERNS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEMP_PATTERNS)).toBe(true);
    expect(DEFAULT_TEMP_PATTERNS.length).toBeGreaterThan(0);
  });

  describe('isTempFile', () => {
    it('matches tmp/ directory paths', () => {
      expect(isTempFile('tmp/debug-entry.jsx')).toBe(true);
      expect(isTempFile('dashboard/tmp/strategy-debug-entry.jsx')).toBe(true);
    });

    it('matches temp/ and .tmp/ directory paths', () => {
      expect(isTempFile('temp/output.js')).toBe(true);
      expect(isTempFile('.tmp/cache.json')).toBe(true);
    });

    it('matches __pycache__ and .cache directories', () => {
      expect(isTempFile('__pycache__/module.pyc')).toBe(true);
      expect(isTempFile('.cache/data.json')).toBe(true);
    });

    it('matches temp file extensions', () => {
      expect(isTempFile('src/app.tmp')).toBe(true);
      expect(isTempFile('src/app.bak')).toBe(true);
      expect(isTempFile('src/app.orig')).toBe(true);
      expect(isTempFile('server/output.log')).toBe(true);
    });

    it('matches debug- prefix files', () => {
      expect(isTempFile('debug-trace.js')).toBe(true);
      expect(isTempFile('src/debug-output.txt')).toBe(true);
    });

    it('matches *.debug.* files', () => {
      expect(isTempFile('src/app.debug.js')).toBe(true);
    });

    it('does not match normal source files', () => {
      expect(isTempFile('src/index.js')).toBe(false);
      expect(isTempFile('dashboard/src/views/Strategy.jsx')).toBe(false);
      expect(isTempFile('server/utils/temp-file-filter.js')).toBe(false);
      expect(isTempFile('package.json')).toBe(false);
    });

    it('does not match files with temp in the name but not as a pattern', () => {
      expect(isTempFile('src/temperature.js')).toBe(false);
      expect(isTempFile('src/template.jsx')).toBe(false);
    });

    it('accepts custom patterns that extend defaults', () => {
      expect(isTempFile('scratch/notes.md', ['scratch/'])).toBe(true);
      expect(isTempFile('src/index.js', ['scratch/'])).toBe(false);
    });
  });

  describe('filterTempFiles', () => {
    it('removes temp files and returns both lists', () => {
      const input = [
        'src/index.js',
        'tmp/debug-entry.jsx',
        'src/app.bak',
        'dashboard/src/views/Strategy.jsx',
        'debug-trace.log',
      ];
      const { kept, excluded } = filterTempFiles(input);
      expect(kept).toEqual(['src/index.js', 'dashboard/src/views/Strategy.jsx']);
      expect(excluded).toEqual(['tmp/debug-entry.jsx', 'src/app.bak', 'debug-trace.log']);
    });

    it('returns all files when none match', () => {
      const input = ['src/index.js', 'server/tools.js'];
      const { kept, excluded } = filterTempFiles(input);
      expect(kept).toEqual(input);
      expect(excluded).toEqual([]);
    });

    it('handles empty input', () => {
      const { kept, excluded } = filterTempFiles([]);
      expect(kept).toEqual([]);
      expect(excluded).toEqual([]);
    });

    it('accepts custom patterns', () => {
      const input = ['src/index.js', 'scratch/notes.md'];
      const { kept, excluded } = filterTempFiles(input, ['scratch/']);
      expect(kept).toEqual(['src/index.js']);
      expect(excluded).toEqual(['scratch/notes.md']);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd server && npx vitest run tests/temp-file-filter.test.js --reporter=verbose
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the filter**

Create `server/utils/temp-file-filter.js`:

```js
'use strict';

/**
 * Default patterns for temp/debug files that should never be auto-committed.
 * Each pattern is tested against the full relative path (forward-slash normalized).
 * - Patterns ending with `/` match directory prefixes
 * - Patterns starting with `*.` match file extensions
 * - Patterns starting with a word match filename prefixes
 * - Patterns containing `*` in the middle match glob-style (e.g., `*.debug.*`)
 */
const DEFAULT_TEMP_PATTERNS = Object.freeze([
  // Directories
  'tmp/', 'temp/', '.tmp/', '.cache/', '__pycache__/',
  // Extensions
  '*.tmp', '*.bak', '*.orig', '*.log',
  // Prefix
  'debug-',
  // Glob
  '*.debug.*',
]);

function normalizePath(p) {
  return (p || '').replace(/\\/g, '/');
}

/**
 * Check if a file path matches any temp file pattern.
 * @param {string} filePath - relative file path
 * @param {string[]} [extraPatterns] - additional patterns to check (merged with defaults)
 * @returns {boolean}
 */
function isTempFile(filePath, extraPatterns) {
  const norm = normalizePath(filePath);
  const patterns = extraPatterns
    ? [...DEFAULT_TEMP_PATTERNS, ...extraPatterns]
    : DEFAULT_TEMP_PATTERNS;

  for (const pattern of patterns) {
    // Directory prefix: "tmp/" matches any path containing "/tmp/" or starting with "tmp/"
    if (pattern.endsWith('/')) {
      const dir = pattern;
      if (norm.startsWith(dir) || norm.includes('/' + dir)) return true;
      continue;
    }

    // Extension: "*.tmp" matches files ending with ".tmp"
    if (pattern.startsWith('*.') && !pattern.includes('*', 1)) {
      const ext = pattern.slice(1); // ".tmp"
      if (norm.endsWith(ext)) return true;
      continue;
    }

    // Middle glob: "*.debug.*" matches any segment containing ".debug."
    if (pattern.includes('*')) {
      const inner = pattern.replace(/\*/g, '');
      const basename = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
      if (basename.includes(inner)) return true;
      continue;
    }

    // Prefix: "debug-" matches basename starting with "debug-"
    const basename = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
    if (basename.startsWith(pattern)) return true;
  }

  return false;
}

/**
 * Filter an array of file paths, separating temp files from real files.
 * @param {string[]} paths - file paths to filter
 * @param {string[]} [extraPatterns] - additional patterns beyond defaults
 * @returns {{ kept: string[], excluded: string[] }}
 */
function filterTempFiles(paths, extraPatterns) {
  const kept = [];
  const excluded = [];
  for (const p of paths) {
    if (isTempFile(p, extraPatterns)) {
      excluded.push(p);
    } else {
      kept.push(p);
    }
  }
  return { kept, excluded };
}

module.exports = { DEFAULT_TEMP_PATTERNS, isTempFile, filterTempFiles };
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd server && npx vitest run tests/temp-file-filter.test.js --reporter=verbose
```

Expected: all 13 tests PASS.

- [ ] **Step 5: Commit**

```
git add server/utils/temp-file-filter.js server/tests/temp-file-filter.test.js
git commit -m "feat: add temp file filter utility with default patterns"
```

---

## Task 2: Wire Filter into auto-commit-batch

**Files:**
- Modify: `server/handlers/auto-commit-batch.js:155-168`

- [ ] **Step 1: Add the filter import and apply it**

At the top of `auto-commit-batch.js`, add the import (after the existing requires):

```js
const { filterTempFiles } = require('../utils/temp-file-filter');
```

Then around line 155, after `filesToCommit` is resolved but before the `git add` call at line 168, add the filter:

```js
  const trackedCommitFiles = _resolveTrackedCommitFiles(args, workingDir);
  const rawFiles = trackedCommitFiles.length > 0
    ? trackedCommitFiles
    : _getFallbackCommitFiles(workingDir);

  // Filter out temp/debug files before staging
  const { kept: filesToCommit, excluded } = filterTempFiles(rawFiles);
  if (excluded.length > 0) {
    output += `Excluded ${excluded.length} temp file(s): ${excluded.join(', ')}\n`;
  }
```

Remove the old `const filesToCommit = ...` assignment at lines 156-158 since we now assign it via destructuring above.

- [ ] **Step 2: Commit**

```
git add server/handlers/auto-commit-batch.js
git commit -m "feat: filter temp files from auto-commit-batch staging"
```

---

## Task 3: Wire Filter into await_task Auto-Commit

**Files:**
- Modify: `server/handlers/workflow/await.js:1500-1503`

- [ ] **Step 1: Add the import**

At the top of `await.js`, add among the existing requires:

```js
const { filterTempFiles } = require('../../utils/temp-file-filter');
```

- [ ] **Step 2: Add filter before await_task's git add (around line 1500-1503)**

Change:
```js
const taskPaths = [...collectTaskCommitPaths(task.id, cwd)];
const commitPaths = taskPaths.length > 0 ? taskPaths : getFallbackCommitPaths(cwd);
if (commitPaths.length > 0) {
  executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
```

To:
```js
const taskPaths = [...collectTaskCommitPaths(task.id, cwd)];
const rawPaths = taskPaths.length > 0 ? taskPaths : getFallbackCommitPaths(cwd);
const { kept: commitPaths, excluded: tempExcluded } = filterTempFiles(rawPaths);
if (tempExcluded.length > 0) {
  logger.info(`[await_task] Excluded ${tempExcluded.length} temp file(s) from commit: ${tempExcluded.join(', ')}`);
}
if (commitPaths.length > 0) {
  executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
```

- [ ] **Step 3: Add filter before await_workflow's git add (around line 1045-1047)**

Find the workflow auto-commit block (around line 1045). Apply the same pattern:

Change:
```js
// Wrap git add separately so failures are clearly attributed.
try {
  executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
```

To (add filter before the try block):
```js
const { kept: filteredPaths, excluded: tempExcluded } = filterTempFiles(commitPaths);
if (tempExcluded.length > 0) {
  output += `Excluded ${tempExcluded.length} temp file(s): ${tempExcluded.join(', ')}\n`;
  commitPaths = filteredPaths;
}
if (commitPaths.length === 0) {
  output += 'No files to commit after temp filter.\n';
  return output;
}
// Wrap git add separately so failures are clearly attributed.
try {
  executeValidatedCommandSync('git', ['add', '--', ...commitPaths], {
```

Note: `commitPaths` needs to be `let` not `const` in the parent scope for reassignment. Check and change if needed.

- [ ] **Step 4: Commit**

```
git add server/handlers/workflow/await.js
git commit -m "feat: filter temp files from await_task and await_workflow auto-commit"
```

---

## Task 4: Add Governance Rule

**Files:**
- Modify: `server/db/governance-rules.js:122` (add to BUILTIN_RULES)
- Modify: `server/tests/governance-rules.test.js` (update count 13→14)

- [ ] **Step 1: Add the builtin rule**

In `server/db/governance-rules.js`, before the closing `]);` of `BUILTIN_RULES` (after the `no-force-restart` entry at line 122), add:

```js
  Object.freeze({
    id: 'reject-temp-files',
    name: 'reject-temp-files',
    description: 'Detect temp/debug files in task output. Shadow mode logs warnings; enforce mode flags for review.',
    stage: 'task_post_complete',
    default_mode: 'warn',
    checker_id: 'checkRejectTempFiles',
    config: null,
  }),
```

- [ ] **Step 2: Update test expectations**

In `server/tests/governance-rules.test.js`, update all rule count assertions from 13 to 14.

Search for `13` in the file and update:
- `BUILTIN_RULES.length` → 14
- `seedBuiltinRules()` return value → 14
- `getAllRules().toHaveLength(14)` → 14

- [ ] **Step 3: Verify tests pass**

```
cd server && npx vitest run tests/governance-rules.test.js --reporter=verbose
```

- [ ] **Step 4: Commit**

```
git add server/db/governance-rules.js server/tests/governance-rules.test.js
git commit -m "feat: add reject-temp-files governance rule (shadow mode default)"
```

---

## Task 5: Final Verification

- [ ] **Step 1: Run temp file filter tests**

```
cd server && npx vitest run tests/temp-file-filter.test.js tests/governance-rules.test.js --reporter=verbose
```

Expected: All tests pass.

- [ ] **Step 2: Run full server test suite**

```
torque-remote npm run test --prefix server
```

Expected: All tests pass, no regressions.

- [ ] **Step 3: Commit plan file**

```
git add docs/superpowers/plans/2026-04-03-temp-file-filter.md
git commit -m "docs: temp file filter implementation plan"
```
