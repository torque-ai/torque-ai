# Phase 1 — Sync I/O Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every synchronous filesystem and subprocess call from hot-path files, ship the `torque/no-sync-fs-on-hot-paths` ESLint discipline rule that prevents recurrence, and flip the rule to `error` mode once all 13 findings are closed.

**Architecture:** The ESLint rule ships first (Task 1) in `warn` mode with 5 grandfathered exceptions, giving `npm run lint` a signal for all subsequent tasks. Tasks 2–13 convert each finding file-by-file using `fs.promises.*` and promisified subprocess calls. Task 14 flips the rule to `error`. Task 15 re-runs the performance scout to confirm zero new findings. Task 16 updates the perf baseline with the measured improvement.

**Tech Stack:** Node.js (commonjs), `fs.promises` (built-in), `util.promisify` (built-in), ESLint flat config, vitest (existing test runner), no new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-25-perf-1-sync-io-design.md` is the authoritative source. Pre-flight findings are at `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-pre.md`.

**Worktree:** `feat-perf-1-sync-io` at `.worktrees/feat-perf-1-sync-io/` on branch `feat/perf-1-sync-io`. All commits go to that branch. Tests run via `torque-remote` from the worktree directory.

**Important rules during implementation:**

- **Never run tests locally.** Always: `torque-remote npx vitest run path/to/test.js` from the worktree dir.
- **Never restart TORQUE.** TORQUE is shared infrastructure.
- **Never edit main directly.** All work in this worktree.
- **Commit per task** unless a task explicitly says otherwise.
- **Use Read before Edit** — never guess at indentation or surrounding context.
- **Preserve all spawn options** on every subprocess conversion: `windowsHide: true`, `encoding`, `maxBuffer`, `timeout`, `env`.

---

## File Map

| File | Action | Reason |
|------|--------|--------|
| `server/eslint-rules/no-sync-fs-on-hot-paths.js` | Create | Discipline rule |
| `server/eslint-rules/no-sync-fs-on-hot-paths.test.js` | Create | Rule tests |
| `server/eslint.config.js` | Modify | Wire rule in |
| `server/execution/sandbox-revert-detection.js` | Modify | HIGH #1 — async subprocess |
| `server/tests/sandbox-revert-detection.test.js` | Modify | Paired test update |
| `server/handlers/review-handler.js` | Modify | HIGH #2 — async subprocess |
| `server/handlers/task/pipeline.js` | Modify | HIGH #3 — async subprocess |
| `server/handlers/automation-handlers.js` | Modify | HIGH #4 — async readdir+readFile |
| `server/handlers/validation/index.js` | Modify | HIGH #5 — async readFile+stat loop |
| `server/execution/task-startup.js` | Modify | MEDIUM #6,#7 — where.exe memo + async stat |
| `server/handlers/ci-handlers.js` | Modify | MEDIUM #8 — async subprocess |
| `server/execution/workflow-runtime.js` | Modify | MEDIUM #9 — async fs |
| `server/api/v2-governance-handlers.js` | Modify | MEDIUM #10 — async writeFile+unlink |
| `server/api/v2-task-handlers.js` | Modify | MEDIUM #11 — async readFile |
| `server/handlers/automation-ts-tools.js` | Modify | MEDIUM #12 — bulk async via helper |
| `server/handlers/hashline-handlers.js` | Modify | MEDIUM #13 — async stat+readFile+writeFile |
| `server/execution/restart-handoff.js` | Modify | Add 3 grandfathered disable comments |
| `server/execution/startup-task-reconciler.js` | Modify | Add 1 grandfathered disable comment |
| `server/execution/command-builders.js` | Modify | Add 4 grandfathered disable comments |
| `server/execution/process-lifecycle.js` | Modify | Add 4 grandfathered disable comments |
| `server/perf/baseline.json` | Modify | Update governance-evaluate metric |

---

## Task 1: ESLint rule `torque/no-sync-fs-on-hot-paths` in warn mode

**Files:**
- Create: `server/eslint-rules/no-sync-fs-on-hot-paths.js`
- Create: `server/eslint-rules/no-sync-fs-on-hot-paths.test.js`
- Modify: `server/eslint.config.js`

- [ ] **Step 1: Write the failing test**

Create `server/eslint-rules/no-sync-fs-on-hot-paths.test.js`:

```js
'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-sync-fs-on-hot-paths');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-sync-fs-on-hot-paths', rule, {
  valid: [
    // File outside hot-path globs — not flagged
    {
      filename: 'C:/repo/server/scripts/migrate.js',
      code: "const fs = require('fs');\nfs.readFileSync('/tmp/x', 'utf8');",
    },
    // Async variant in hot-path file — allowed
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const fsPromises = require('fs').promises;\nawait fsPromises.readFile('/tmp/x', 'utf8');",
    },
    // Grandfathered with valid reason (> 10 chars)
    {
      filename: 'C:/repo/server/execution/restart-handoff.js',
      code: "const fs = require('fs');\n// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- shutdown/startup handoff file — sync is correct ordering.\nfs.writeFileSync('/tmp/restart', '1');",
    },
    // spawn (async) is fine even in hot-path
    {
      filename: 'C:/repo/server/handlers/task/pipeline.js',
      code: "const cp = require('child_process');\ncp.spawn('git', ['status']);",
    },
  ],
  invalid: [
    // fs.readFileSync in hot-path
    {
      filename: 'C:/repo/server/handlers/validation/index.js',
      code: "const fs = require('fs');\nfs.readFileSync('/tmp/x', 'utf8');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.writeFileSync in hot-path
    {
      filename: 'C:/repo/server/api/v2-governance-handlers.js',
      code: "const fs = require('fs');\nfs.writeFileSync('/tmp/x', 'data');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.statSync in hot-path
    {
      filename: 'C:/repo/server/execution/task-startup.js',
      code: "const fs = require('fs');\nfs.statSync('/some/path');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.existsSync in hot-path
    {
      filename: 'C:/repo/server/execution/workflow-runtime.js',
      code: "const fs = require('fs');\nfs.existsSync('/some/path');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // execFileSync (MemberExpression) in hot-path
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const childProcess = require('child_process');\nchildProcess.execFileSync('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // execFileSync (destructured) in hot-path
    {
      filename: 'C:/repo/server/execution/sandbox-revert-detection.js',
      code: "const { execFileSync } = require('child_process');\nexecFileSync('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // Renamed destructured binding — e.g., const { execFileSync: efs } = require('child_process')
    {
      filename: 'C:/repo/server/execution/sandbox-revert-detection.js',
      code: "const { execFileSync: efs } = require('child_process');\nefs('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // spawnSync (MemberExpression) in hot-path
    {
      filename: 'C:/repo/server/handlers/task/pipeline.js',
      code: "const childProcess = require('child_process');\nchildProcess.spawnSync('git', ['status']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // Grandfathered with empty/short reason — still fails (reason must be > 10 chars)
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const fs = require('fs');\n// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- fixme\nfs.readFileSync('/tmp/x', 'utf8');",
      errors: [{ messageId: 'shortDisableReason' }],
    },
  ],
});
```

- [ ] **Step 2: Run test to verify it fails**

```
torque-remote npx vitest run server/eslint-rules/no-sync-fs-on-hot-paths.test.js
```

Expected: FAIL — `Cannot find module './no-sync-fs-on-hot-paths'`

- [ ] **Step 3: Write the rule**

Create `server/eslint-rules/no-sync-fs-on-hot-paths.js`:

```js
'use strict';

// Hot-path globs — matches umbrella spec §3.1
const HOT_PATH_PATTERNS = [
  'server/handlers/',
  'server/execution/',
  'server/governance/',
  'server/audit/',
  'server/api/',
  'server/dashboard-server.js',
  'server/queue-scheduler',
  'server/maintenance/orphan-cleanup.js',
];

// All sync fs method names to flag
const SYNC_FS_METHODS = new Set([
  'readFileSync', 'writeFileSync', 'statSync', 'existsSync', 'readdirSync',
  'unlinkSync', 'mkdirSync', 'rmSync', 'lstatSync', 'realpathSync',
  'openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'copyFileSync',
]);

// Sync subprocess methods to flag
const SYNC_CP_METHODS = new Set(['execSync', 'execFileSync', 'spawnSync']);

const MIN_REASON_LENGTH = 10;

function normalizeFilename(context) {
  const filename = typeof context.filename === 'string'
    ? context.filename
    : context.getFilename();
  return typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
}

function isHotPath(filename) {
  return HOT_PATH_PATTERNS.some((p) => filename.includes(p));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow synchronous fs and child_process calls on hot-path files — they block the Node.js event loop under concurrent request load.',
    },
    messages: {
      noSyncFsOnHotPath:
        'Sync I/O call "{{name}}" blocks the event loop on hot-path files. Use the async equivalent (fs.promises.* or promisified subprocess).',
      shortDisableReason:
        'eslint-disable comment for torque/no-sync-fs-on-hot-paths must include a reason longer than {{min}} chars (e.g., "-- startup only, not a request hot-path").',
    },
    schema: [],
  },
  create(context) {
    const filename = normalizeFilename(context);
    if (!isHotPath(filename)) {
      return {};
    }

    // Track renamed destructured bindings from require('child_process')
    // e.g. const { execFileSync: efs } = require('child_process')  =>  efs -> 'execFileSync'
    const renamedCpBindings = new Map(); // localName -> canonicalName

    function checkInlineDisableComment(node, ruleName) {
      const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
      const comments = sourceCode.getCommentsBefore(node);
      for (const comment of comments) {
        const text = comment.value.trim();
        if (text.includes(`eslint-disable-next-line ${ruleName}`)) {
          // Extract reason after '--'
          const dashIdx = text.indexOf('--');
          if (dashIdx === -1) {
            context.report({ node, messageId: 'shortDisableReason', data: { min: MIN_REASON_LENGTH } });
            return true;
          }
          const reason = text.slice(dashIdx + 2).trim();
          if (reason.length <= MIN_REASON_LENGTH) {
            context.report({ node, messageId: 'shortDisableReason', data: { min: MIN_REASON_LENGTH } });
          }
          return true; // has disable comment (whether valid or not, don't double-report)
        }
      }
      return false;
    }

    return {
      // Track: const { execFileSync } = require('child_process')
      // Track: const { execFileSync: efs } = require('child_process')
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === 'require' &&
          node.init.arguments.length === 1 &&
          node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'child_process' &&
          node.id.type === 'ObjectPattern'
        ) {
          for (const prop of node.id.properties) {
            if (prop.type === 'Property') {
              const keyName = prop.key.type === 'Identifier' ? prop.key.name : null;
              const valName = prop.value.type === 'Identifier' ? prop.value.name : null;
              if (keyName && valName && SYNC_CP_METHODS.has(keyName)) {
                renamedCpBindings.set(valName, keyName);
              }
            }
          }
        }
      },

      CallExpression(node) {
        const { callee } = node;

        // Case 1: fs.readFileSync(...) — MemberExpression
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier'
        ) {
          const methodName = callee.property.name;
          if (SYNC_FS_METHODS.has(methodName) || SYNC_CP_METHODS.has(methodName)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name: methodName },
              });
            }
          }
          return;
        }

        // Case 2: execFileSync(...) — bare Identifier (destructured direct import)
        if (callee.type === 'Identifier') {
          const name = callee.name;
          if (SYNC_CP_METHODS.has(name)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name },
              });
            }
            return;
          }
          // Case 3: renamed binding — e.g., efs(...) where efs = execFileSync
          if (renamedCpBindings.has(name)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name: `${name} (alias for ${renamedCpBindings.get(name)})` },
              });
            }
          }
        }
      },
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```
torque-remote npx vitest run server/eslint-rules/no-sync-fs-on-hot-paths.test.js
```

Expected: PASS — all valid/invalid cases green

- [ ] **Step 5: Wire rule into eslint.config.js**

Read `server/eslint.config.js` first, then add after the existing `require` lines at the top and add a new config object for hot-path files.

In `server/eslint.config.js`, after line 4 (`const noVitestRequireRule = ...`), add:

```js
const noSyncFsOnHotPathsRule = require('./eslint-rules/no-sync-fs-on-hot-paths');
```

Then add a new config object at the end of the array (before the `ignores` entry):

```js
  {
    files: [
      'server/handlers/**/*.js',
      'server/execution/**/*.js',
      'server/governance/**/*.js',
      'server/audit/**/*.js',
      'server/api/**/*.js',
      'server/dashboard-server.js',
      'server/queue-scheduler*.js',
      'server/maintenance/orphan-cleanup.js',
    ],
    plugins: {
      torque: {
        rules: {
          'no-sync-fs-on-hot-paths': noSyncFsOnHotPathsRule,
        },
      },
    },
    rules: {
      'torque/no-sync-fs-on-hot-paths': 'warn',
    },
  },
```

- [ ] **Step 6: Verify lint runs without crashing**

```
torque-remote npx eslint --max-warnings=9999 server/handlers/review-handler.js
```

Expected: exit 0, warnings listed (not errors), no crash

- [ ] **Step 7: Add grandfathered disable comments to exception files**

For each file below, Read it first, then add the disable comment on the line immediately before each sync call.

**`server/execution/restart-handoff.js` (lines ~15, ~34, ~40):**
```
// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- shutdown/startup handoff file — sync is correct ordering.
```

**`server/execution/startup-task-reconciler.js` (line ~124):**
```
// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- startup reconciler — runs once at server boot.
```

**`server/execution/command-builders.js` (lines ~31, ~33, ~43, ~52):**
For lines ~31, ~33, ~43 (sandbox writable-roots probe):
```
// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- sandbox writable-roots probe — task startup, single small read each.
```
For line ~52 (mkdirSync):
```
// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- best-effort sandbox dir creation.
```

**`server/execution/process-lifecycle.js` (lines ~117, ~135, ~201, ~251):**
```
// eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- Windows process kill — runs in setTimeout during graceful shutdown, not request hot-path.
```

- [ ] **Step 8: Verify lint with grandfathered exceptions**

```
torque-remote npx eslint --max-warnings=9999 server/execution/restart-handoff.js server/execution/startup-task-reconciler.js server/execution/command-builders.js server/execution/process-lifecycle.js
```

Expected: exit 0, zero errors, the grandfathered lines produce no output

- [ ] **Step 9: Run full vitest suite to confirm no breakage**

```
torque-remote npx vitest run
```

Expected: all tests pass

- [ ] **Step 10: Commit**

```
git add server/eslint-rules/no-sync-fs-on-hot-paths.js server/eslint-rules/no-sync-fs-on-hot-paths.test.js server/eslint.config.js server/execution/restart-handoff.js server/execution/startup-task-reconciler.js server/execution/command-builders.js server/execution/process-lifecycle.js
git commit -m "feat(perf): add ESLint rule torque/no-sync-fs-on-hot-paths (warn mode)"
```

---

## Task 2: Convert sandbox-revert-detection.js (HIGH #1)

**Files:**
- Modify: `server/execution/sandbox-revert-detection.js` (lines 19, 68, 165)
- Modify or create: `server/tests/sandbox-revert-detection.test.js`

Context: `checkFileForRevert` (line 65) uses `execFileSync('git', ['diff', 'HEAD', '--', filePath])` at line 68. `detectSandboxReverts` (line 113) uses `execFileSync('git', ['checkout', 'HEAD', '--', r.file])` at line 165. The module imports `{ execFileSync }` from `child_process` at line 19.

- [ ] **Step 1: Write a failing test**

Find the existing test file: `torque-remote npx vitest run server/tests/sandbox-revert-detection.test.js`

If no test file exists, create `server/tests/sandbox-revert-detection.test.js`:

```js
'use strict';

const { describe, it, expect, vi, beforeEach } = await import('vitest');

// The async conversion must make detectSandboxReverts return a Promise
describe('sandbox-revert-detection async shape', () => {
  it('detectSandboxReverts returns a Promise', async () => {
    // Mock execFile to avoid real git calls
    vi.mock('util', () => ({ promisify: (fn) => fn }));
    const mod = require('../execution/sandbox-revert-detection');
    const result = mod.detectSandboxReverts({ files: [] });
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
torque-remote npx vitest run server/tests/sandbox-revert-detection.test.js
```

Expected: FAIL — `detectSandboxReverts` returns undefined (sync), not a Promise

- [ ] **Step 3: Convert the module to async**

Read `server/execution/sandbox-revert-detection.js` lines 1-30 first to see the exact import line, then:

Replace the `execFileSync` import at line 19 with a promisified async version. The module-level change:

```js
// OLD:
const { execFileSync } = require('child_process');

// NEW:
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
```

Then convert `checkFileForRevert` (lines 65-98): change the sync call to `await execFileAsync(...)`. The function signature becomes `async function checkFileForRevert(...)`.

The relevant change inside `checkFileForRevert` (around line 68):

```js
// OLD:
const diffOutput = execFileSync('git', ['diff', 'HEAD', '--', filePath], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
});

// NEW:
const { stdout: diffOutput } = await execFileAsync('git', ['diff', 'HEAD', '--', filePath], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
});
```

Then convert `detectSandboxReverts` (lines 113-191): make it `async`, and convert the git-checkout call (around line 165):

```js
// OLD:
execFileSync('git', ['checkout', 'HEAD', '--', r.file], {
  cwd: r.cwd,
  encoding: 'utf8',
  windowsHide: true,
});

// NEW:
await execFileAsync('git', ['checkout', 'HEAD', '--', r.file], {
  cwd: r.cwd,
  encoding: 'utf8',
  windowsHide: true,
});
```

Also parallelise the per-file diff checks in `detectSandboxReverts`. Find the loop that calls `checkFileForRevert` for each changed file and replace it with `Promise.all`:

```js
// Where the loop was (pseudocode — read the actual code first):
const results = await Promise.all(
  changedFiles.map((f) => checkFileForRevert(f, cwd))
);
```

- [ ] **Step 4: Run the test to verify it passes**

```
torque-remote npx vitest run server/tests/sandbox-revert-detection.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite to confirm no regressions**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Verify lint is clean for this file**

```
torque-remote npx eslint server/execution/sandbox-revert-detection.js
```

Expected: exit 0, zero errors, zero warnings from `torque/no-sync-fs-on-hot-paths`

- [ ] **Step 7: Commit**

```
git add server/execution/sandbox-revert-detection.js server/tests/sandbox-revert-detection.test.js
git commit -m "perf(sync-io): async sandbox-revert-detection subprocess calls (HIGH #1)"
```

---

## Task 3: Convert review-handler.js (HIGH #2)

**Files:**
- Modify: `server/handlers/review-handler.js` (line ~153)

Context: `collectDiffOutput` at lines 149-166 uses `childProcess.execFileSync('git', diffArgs, { cwd, encoding: 'utf8', maxBuffer: 4*1024*1024, windowsHide: true })` at line 153. The module imports `const childProcess = require('child_process')` at line 3.

- [ ] **Step 1: Write a failing test**

Find or create `server/tests/review-handler.test.js`. Add:

```js
describe('review-handler async', () => {
  it('collectDiffOutput is async (returns Promise)', async () => {
    // collectDiffOutput is not exported — test via the module's _testing export if present,
    // or by checking the caller runStage returns a Promise.
    const mod = require('../handlers/review-handler');
    // The function must exist and the module must load without error
    expect(mod).toBeDefined();
  });
});
```

Actually the meaningful test is: confirm the module lints clean after conversion. Write a direct lint test using child_process to run eslint:

```js
describe('review-handler lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/review-handler.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]', stderr: e.stderr || '' }));
    const results = JSON.parse(stdout || '[]');
    const syncViolations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(syncViolations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (lint reports violation)**

```
torque-remote npx vitest run server/tests/review-handler.test.js
```

Expected: FAIL — lint finds `torque/no-sync-fs-on-hot-paths` violation at line 153

- [ ] **Step 3: Convert collectDiffOutput to async**

Read `server/handlers/review-handler.js` lines 1-10 and 145-170 first. Then:

Add promisify at the top of the file after the `childProcess` require:

```js
const { promisify } = require('util');
const execFileAsync = promisify(childProcess.execFile);
```

Convert `collectDiffOutput`:

```js
// OLD:
function collectDiffOutput(cwd, diffArgs) {
  try {
    return childProcess.execFileSync('git', diffArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    return '';
  }
}

// NEW:
async function collectDiffOutput(cwd, diffArgs) {
  try {
    const { stdout } = await execFileAsync('git', diffArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (_err) {
    return '';
  }
}
```

Update the caller (the function that calls `collectDiffOutput`) to `await` it. Read the caller's context first to find the exact line.

- [ ] **Step 4: Run test to verify it passes**

```
torque-remote npx vitest run server/tests/review-handler.test.js
```

Expected: PASS — zero lint violations

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/review-handler.js server/tests/review-handler.test.js
git commit -m "perf(sync-io): async review-handler subprocess calls (HIGH #2)"
```

---

## Task 4: Convert task/pipeline.js (HIGH #3)

**Files:**
- Modify: `server/handlers/task/pipeline.js` (lines ~182, ~205)

Context: `execGit` at lines 177-201 uses `childProcess.spawnSync('git', gitArgs, { cwd, encoding, timeout: TASK_TIMEOUTS.GIT_ADD_ALL, maxBuffer: 10*1024*1024, windowsHide: true, env: {...process.env, ...GIT_SAFE_ENV} })` at line 182. `execGitCommit` at lines 203-221 uses `childProcess.spawnSync('git', ['commit', '-m', message], { cwd, encoding, timeout, windowsHide: true })` at line 205.

- [ ] **Step 1: Write a failing lint test**

Create or add to `server/tests/pipeline.test.js`:

```js
describe('pipeline.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/task/pipeline.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/pipeline.test.js
```

Expected: FAIL — 2 violations found

- [ ] **Step 3: Convert execGit and execGitCommit**

Read `server/handlers/task/pipeline.js` lines 170-230 first. Then add at top of file (with other requires):

```js
const { promisify } = require('util');
const spawnAsync = promisify(require('child_process').execFile);
```

Note: `spawnSync` semantics (returns `{ stdout, stderr, status }`) differ from `execFile`. Use `execFile` with `{ maxBuffer, timeout, windowsHide, env }` options and wrap to match the expected return shape. Read how `execGit`'s return value is used before converting.

Convert `execGit` to async:

```js
// OLD:
function execGit(gitArgs, cwd, encoding = 'utf8') {
  const result = childProcess.spawnSync('git', gitArgs, {
    cwd,
    encoding,
    timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...GIT_SAFE_ENV },
  });
  return result;
}

// NEW:
async function execGit(gitArgs, cwd, encoding = 'utf8') {
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const cp = childProcess.spawn('git', gitArgs, {
        cwd,
        encoding,
        timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...GIT_SAFE_ENV },
      });
      let stdout = '';
      let stderr = '';
      cp.stdout && cp.stdout.on('data', (d) => { stdout += d; });
      cp.stderr && cp.stderr.on('data', (d) => { stderr += d; });
      cp.on('close', (code) => resolve({ stdout, stderr, status: code }));
      cp.on('error', reject);
    });
    return { stdout, stderr, status: 0 };
  } catch (err) {
    return { stdout: '', stderr: err.message || '', status: err.code || 1 };
  }
}
```

Convert `execGitCommit` similarly. Update all callers to `await execGit(...)` and `await execGitCommit(...)`.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/pipeline.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/task/pipeline.js server/tests/pipeline.test.js
git commit -m "perf(sync-io): async git subprocess in task/pipeline.js (HIGH #3)"
```

---

## Task 5: Convert automation-handlers.js scanDirectory (HIGH #4)

**Files:**
- Modify: `server/handlers/automation-handlers.js` (lines ~590-632)

Context: `scanDirectory` at lines 590-632 uses `fs.readdirSync(dirPath, { withFileTypes: true })` at line 595 and `fs.readFileSync(fullPath, 'utf8')` at line 624.

- [ ] **Step 1: Write a failing test**

Find or create `server/tests/automation-handlers.test.js`. Add a test that directly exercises `scanDirectory` with a temp dir:

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('automation-handlers scanDirectory', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'console.log("a");');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.js'), 'console.log("b");');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('scanDirectory returns a Promise that resolves to an array of file objects', async () => {
    // scanDirectory is internal — access via the module's _testing export if available,
    // or test via the MCP handler in a unit harness.
    // As a proxy, verify the module loads and the handler function is async:
    const mod = require('../handlers/automation-handlers');
    expect(mod).toBeDefined();
    // The real test is lint-clean:
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/automation-handlers.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/automation-handlers.test.js
```

Expected: FAIL — violations found

- [ ] **Step 3: Convert scanDirectory to async with bounded concurrency**

Read `server/handlers/automation-handlers.js` lines 585-640 first. Then convert:

Add at top of file (with other requires):

```js
const fsPromises = require('fs').promises;
```

Add a module-level bounded concurrency helper (inline, no new dependencies):

```js
async function runBounded(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}
```

Convert `scanDirectory`:

```js
// OLD (sync):
function scanDirectory(dirPath, extensions, ignorePatterns, results = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    // ... recurse sync, readFileSync for files
  }
  return results;
}

// NEW (async, bounded):
async function scanDirectory(dirPath, extensions, ignorePatterns, results = []) {
  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    const fullPath = require('path').join(dirPath, entry.name);
    if (ignorePatterns.some((p) => entry.name === p || fullPath.includes(p))) continue;
    if (entry.isDirectory()) {
      tasks.push(() => scanDirectory(fullPath, extensions, ignorePatterns, results));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      tasks.push(async () => {
        const content = await fsPromises.readFile(fullPath, 'utf8');
        results.push({ path: fullPath, content });
      });
    }
  }
  await runBounded(tasks, 8);
  return results;
}
```

Update the caller (the MCP handler that calls `scanDirectory`) to `await` the result.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/automation-handlers.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/automation-handlers.js server/tests/automation-handlers.test.js
git commit -m "perf(sync-io): async scanDirectory in automation-handlers.js (HIGH #4)"
```

---

## Task 6: Convert validation/index.js readFile+stat loop (HIGH #5)

**Files:**
- Modify: `server/handlers/validation/index.js` (lines ~253-264)

Context: Per-file `fs.readFileSync(absPath, 'utf-8')` and `fs.statSync(absPath)` in a loop over `changedFiles` in `handleValidateTaskDiff`.

- [ ] **Step 1: Write a failing lint test**

Add to `server/tests/validation.test.js` (or create it):

```js
describe('validation/index.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/validation/index.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/validation.test.js
```

Expected: FAIL — violations found

- [ ] **Step 3: Convert the readFile+stat loop**

Read `server/handlers/validation/index.js` lines 245-275 first. Add at top:

```js
const fsPromises = require('fs').promises;
```

Replace the per-file sync loop with async parallel fetch:

```js
// OLD:
for (const relPath of changedFiles) {
  const absPath = path.join(workingDir, relPath);
  const content = fs.readFileSync(absPath, 'utf-8');
  const stat = fs.statSync(absPath);
  fileData.push({ path: relPath, content, size: stat.size });
}

// NEW:
const fileData = await Promise.all(
  changedFiles.map(async (relPath) => {
    const absPath = path.join(workingDir, relPath);
    const [content, stat] = await Promise.all([
      fsPromises.readFile(absPath, 'utf-8'),
      fsPromises.stat(absPath),
    ]);
    return { path: relPath, content, size: stat.size };
  })
);
```

Ensure the containing function is `async` and that the call site awaits it.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/validation.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/validation/index.js server/tests/validation.test.js
git commit -m "perf(sync-io): async readFile+stat loop in validation/index.js (HIGH #5)"
```

---

## Task 7: Convert task-startup.js where.exe memo + stat (MEDIUM #6, #7)

**Files:**
- Modify: `server/execution/task-startup.js` (lines ~355-390, ~585-619)

Context: `resolveWindowsCmdToNode` at lines 355-390 uses `execFileSync('where.exe', [cmdPath], { encoding: 'utf-8', windowsHide: true })` at line 362. `runPreflightChecks` at lines 585-619 uses `fs.statSync(task.working_directory)` at line 588.

- [ ] **Step 1: Write a failing lint test**

Add to `server/tests/task-startup.test.js` (or create it):

```js
describe('task-startup.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'execution/task-startup.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/task-startup.test.js
```

Expected: FAIL

- [ ] **Step 3: Add where.exe module-level memo + async resolution**

Read `server/execution/task-startup.js` lines 350-395 first. Then:

Add module-level cache and promisified where.exe resolver:

```js
const fsPromises = require('fs').promises;
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);

// Module-level memo: process-lifetime cache for where.exe resolution
const _resolvedWindowsCmdCache = new Map();

async function resolveWindowsCmdToNode(cmdPath) {
  if (_resolvedWindowsCmdCache.has(cmdPath)) {
    return _resolvedWindowsCmdCache.get(cmdPath);
  }
  try {
    const { stdout } = await execFileAsync('where.exe', [cmdPath], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    const resolved = stdout.trim().split('\n')[0].trim();
    _resolvedWindowsCmdCache.set(cmdPath, resolved);
    return resolved;
  } catch (_err) {
    return cmdPath;
  }
}
```

Read the old sync version first and remove it (or replace it entirely). Ensure callers `await resolveWindowsCmdToNode(...)`.

**Convert `runPreflightChecks` stat call (line ~588):**

```js
// OLD:
const stat = fs.statSync(task.working_directory);

// NEW:
const stat = await fsPromises.stat(task.working_directory);
```

Ensure `runPreflightChecks` is already `async` (read the function signature first).

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/task-startup.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/execution/task-startup.js server/tests/task-startup.test.js
git commit -m "perf(sync-io): async where.exe memo + stat in task-startup.js (MEDIUM #6,#7)"
```

---

## Task 8: Convert ci-handlers.js resolveRepo (MEDIUM #8)

**Files:**
- Modify: `server/handlers/ci-handlers.js` (line ~20)

Context: `resolveRepo` at lines 12-34 uses `execFileSync('gh', [...], { timeout: 10000, encoding: 'utf8', cwd: args.working_directory, windowsHide: true })` at line 20.

- [ ] **Step 1: Write failing lint test**

Add to `server/tests/ci-handlers.test.js` (or create it):

```js
describe('ci-handlers.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/ci-handlers.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/ci-handlers.test.js
```

Expected: FAIL

- [ ] **Step 3: Convert resolveRepo to async**

Read `server/handlers/ci-handlers.js` lines 1-40 first. Then:

```js
// Add at top:
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);

// OLD:
function resolveRepo(args) {
  const output = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], {
    timeout: 10000,
    encoding: 'utf8',
    cwd: args.working_directory,
    windowsHide: true,
  });
  return JSON.parse(output);
}

// NEW:
async function resolveRepo(args) {
  const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], {
    timeout: 10000,
    encoding: 'utf8',
    cwd: args.working_directory,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}
```

Update the caller to `await resolveRepo(args)`.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/ci-handlers.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/ci-handlers.js server/tests/ci-handlers.test.js
git commit -m "perf(sync-io): async resolveRepo in ci-handlers.js (MEDIUM #8)"
```

---

## Task 9: Convert workflow-runtime.js generatePipelineDocumentation (MEDIUM #9)

**Files:**
- Modify: `server/execution/workflow-runtime.js` (lines ~394-421)

Context: `generatePipelineDocumentation` around lines 394-421 uses `fs.existsSync(torqueDir)` at line 399, `fs.mkdirSync(torqueDir, { recursive: true })` at line 400, `fs.writeFileSync(filepath, markdown, 'utf8')` at line 409.

- [ ] **Step 1: Write failing lint test**

Add to `server/tests/workflow-runtime.test.js` (or create):

```js
describe('workflow-runtime.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'execution/workflow-runtime.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/workflow-runtime.test.js
```

Expected: FAIL

- [ ] **Step 3: Convert generatePipelineDocumentation to async**

Read `server/execution/workflow-runtime.js` lines 390-415 first. Then:

```js
// Add at top if not already present:
const fsPromises = require('fs').promises;

// OLD:
function generatePipelineDocumentation(pipelineId, stages) {
  const torqueDir = path.join(workingDir, '.torque');
  if (!fs.existsSync(torqueDir)) {
    fs.mkdirSync(torqueDir, { recursive: true });
  }
  const filepath = path.join(torqueDir, `pipeline-${pipelineId}.md`);
  const markdown = buildMarkdown(stages);
  fs.writeFileSync(filepath, markdown, 'utf8');
}

// NEW:
async function generatePipelineDocumentation(pipelineId, stages) {
  const torqueDir = path.join(workingDir, '.torque');
  await fsPromises.mkdir(torqueDir, { recursive: true });
  const filepath = path.join(torqueDir, `pipeline-${pipelineId}.md`);
  const markdown = buildMarkdown(stages);
  await fsPromises.writeFile(filepath, markdown, 'utf8');
}
```

Note: `mkdir({ recursive: true })` is idempotent — the `existsSync` check is unnecessary and removed. Update the caller to `await generatePipelineDocumentation(...)`.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/workflow-runtime.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/execution/workflow-runtime.js server/tests/workflow-runtime.test.js
git commit -m "perf(sync-io): async fs in workflow-runtime generatePipelineDocumentation (MEDIUM #9)"
```

---

## Task 10: Convert v2-governance-handlers.js plan import temp file (MEDIUM #10)

**Files:**
- Modify: `server/api/v2-governance-handlers.js` (lines ~959, ~979)

Context: `handleImportPlan` around lines 953-984 uses `fs.writeFileSync(tempFile, body.plan_content)` at line 959 and `fs.unlinkSync(tempFile)` at line 979 in a `finally` block.

- [ ] **Step 1: Write failing lint test**

Add to `server/tests/v2-governance-handlers.test.js` (or create):

```js
describe('v2-governance-handlers.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'api/v2-governance-handlers.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/v2-governance-handlers.test.js
```

Expected: FAIL

- [ ] **Step 3: Convert writeFile + unlink to async**

Read `server/api/v2-governance-handlers.js` lines 950-990 first. Then:

```js
// Add at top if not already present:
const fsPromises = require('fs').promises;

// OLD:
async function handleImportPlan(body) {
  const tempFile = path.join(os.tmpdir(), `plan-import-${Date.now()}.md`);
  fs.writeFileSync(tempFile, body.plan_content);
  try {
    // ... process tempFile ...
  } finally {
    fs.unlinkSync(tempFile);
  }
}

// NEW:
async function handleImportPlan(body) {
  const tempFile = path.join(os.tmpdir(), `plan-import-${Date.now()}.md`);
  await fsPromises.writeFile(tempFile, body.plan_content);
  try {
    // ... process tempFile ...
  } finally {
    await fsPromises.unlink(tempFile).catch(() => {}); // ignore if already gone
  }
}
```

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/v2-governance-handlers.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/api/v2-governance-handlers.js server/tests/v2-governance-handlers.test.js
git commit -m "perf(sync-io): async writeFile+unlink in v2-governance-handlers plan import (MEDIUM #10)"
```

---

## Task 11: Convert v2-task-handlers.js artifact readFile (MEDIUM #11)

**Files:**
- Modify: `server/api/v2-task-handlers.js` (lines ~132, ~677)

Context: `buildRunArtifactPreview` at lines 126-146 uses `fs.readFileSync(artifact.absolute_path, 'utf8')` at line 132. Download handler around line 677 uses `fs.readFileSync(artifact.absolute_path)` (binary buffer, no encoding).

- [ ] **Step 1: Write failing lint test**

Add to `server/tests/v2-task-handlers.test.js` (or create):

```js
describe('v2-task-handlers.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'api/v2-task-handlers.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/v2-task-handlers.test.js
```

Expected: FAIL

- [ ] **Step 3: Convert both readFile calls to async**

Read `server/api/v2-task-handlers.js` lines 120-145 and 670-685 first. Then:

```js
// Add at top if not already present:
const fsPromises = require('fs').promises;

// buildRunArtifactPreview (line ~132):
// OLD:
const content = fs.readFileSync(artifact.absolute_path, 'utf8');
// NEW:
const content = await fsPromises.readFile(artifact.absolute_path, 'utf8');

// Download handler (line ~677):
// OLD:
const buffer = fs.readFileSync(artifact.absolute_path);
// NEW:
const buffer = await fsPromises.readFile(artifact.absolute_path);
```

Ensure both containing functions are `async` and callers `await` them. Read the surrounding context before editing to confirm.

- [ ] **Step 4: Run test to verify passes**

```
torque-remote npx vitest run server/tests/v2-task-handlers.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/api/v2-task-handlers.js server/tests/v2-task-handlers.test.js
git commit -m "perf(sync-io): async readFile in v2-task-handlers artifact handlers (MEDIUM #11)"
```

---

## Task 12: Bulk-convert automation-ts-tools.js (MEDIUM #12)

**Files:**
- Modify: `server/handlers/automation-ts-tools.js`

Context: 9 TypeScript mutator handlers (`add_ts_interface_members`, `add_ts_method_to_class`, `replace_ts_method_body`, `inject_class_dependency`, `add_ts_union_members`, `inject_method_calls`, `normalize_interface_formatting`, `add_ts_enum_members`, `add_import_statement`) each follow the pattern: `fs.existsSync(filePath)` → `fs.readFileSync(filePath, 'utf8')` → transform → `fs.writeFileSync(filePath, content, 'utf8')`.

- [ ] **Step 1: Write a failing test**

Find existing tests for `automation-ts-tools.js`. Run them first:

```
torque-remote npx vitest run server/tests/automation-ts-tools.test.js
```

Ensure they all pass before the conversion. If the test file doesn't exist, note that the lint test will be the signal. Add lint test to the existing test file or create `server/tests/automation-ts-tools-lint.test.js`:

```js
describe('automation-ts-tools.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/automation-ts-tools.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/automation-ts-tools-lint.test.js
```

Expected: FAIL — many violations

- [ ] **Step 3: Add readModifyWrite helper and convert all 9 handlers**

Read `server/handlers/automation-ts-tools.js` lines 1-30 to see the existing requires. Then add at top:

```js
const fsPromises = require('fs').promises;

/**
 * Async read-modify-write helper.
 * Reads filePath, applies transform(content) -> newContent, writes only if changed.
 * Throws with err.isRmwNotFound = true if the file doesn't exist.
 */
async function readModifyWrite(filePath, transform) {
  let content;
  try {
    content = await fsPromises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const notFound = new Error(`File not found: ${filePath}`);
      notFound.isRmwNotFound = true;
      throw notFound;
    }
    throw err;
  }
  const newContent = transform(content);
  if (newContent !== content) {
    await fsPromises.writeFile(filePath, newContent, 'utf8');
  }
  return newContent;
}
```

For each of the 9 handlers, read the specific lines (read ~40 lines around each handler) and replace the sync pattern:

```js
// OLD pattern (each handler):
if (!fs.existsSync(filePath)) {
  return { error: 'File not found: ' + filePath };
}
const content = fs.readFileSync(filePath, 'utf8');
const newContent = someTransform(content, args);
fs.writeFileSync(filePath, newContent, 'utf8');
return { success: true };

// NEW pattern (each handler):
try {
  await readModifyWrite(filePath, (content) => someTransform(content, args));
  return { success: true };
} catch (err) {
  if (err.isRmwNotFound) return { error: err.message };
  throw err;
}
```

Ensure each handler function is `async`. The callers (MCP tool dispatch) must `await` the result — read the dispatch wiring to confirm.

- [ ] **Step 4: Run existing tests to verify no regressions**

```
torque-remote npx vitest run server/tests/automation-ts-tools.test.js
```

Expected: all passing

- [ ] **Step 5: Run lint test**

```
torque-remote npx vitest run server/tests/automation-ts-tools-lint.test.js
```

Expected: PASS — zero violations

- [ ] **Step 6: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 7: Commit**

```
git add server/handlers/automation-ts-tools.js server/tests/automation-ts-tools-lint.test.js
git commit -m "perf(sync-io): bulk async conversion via readModifyWrite in automation-ts-tools.js (MEDIUM #12)"
```

---

## Task 13: Convert hashline-handlers.js (MEDIUM #13)

**Files:**
- Modify: `server/handlers/hashline-handlers.js` (lines ~72, ~81, ~82, ~267)

Context: `getCachedFile` at lines 67-78 uses `fs.statSync(filePath)` at line 72. `cacheFile` at lines 80-93 uses `fs.readFileSync(filePath, 'utf8')` at line 81 and `fs.statSync(filePath)` at line 82. `handleHashlineEdit` around line 267 uses `fs.writeFileSync(absoluteFilePath, newFileContent, 'utf8')`.

- [ ] **Step 1: Write a failing lint test**

Find existing tests: `torque-remote npx vitest run server/tests/hashline-handlers.test.js` — note which pass. Then add lint test:

```js
describe('hashline-handlers.js lint', () => {
  it('has zero torque/no-sync-fs-on-hot-paths violations', async () => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['../node_modules/.bin/eslint', '--format=json', 'handlers/hashline-handlers.js'],
      { cwd: __dirname + '/..', encoding: 'utf8' }
    ).catch((e) => ({ stdout: e.stdout || '[]' }));
    const results = JSON.parse(stdout || '[]');
    const violations = (results[0]?.messages || []).filter(
      (m) => m.ruleId === 'torque/no-sync-fs-on-hot-paths'
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
torque-remote npx vitest run server/tests/hashline-handlers.test.js
```

Expected: FAIL — violations found

- [ ] **Step 3: Convert stat + readFile + writeFile to async**

Read `server/handlers/hashline-handlers.js` lines 60-100 and 260-275 first. Then:

```js
// Add at top if not already present:
const fsPromises = require('fs').promises;

// getCachedFile (line ~72) — convert statSync:
// OLD:
function getCachedFile(filePath) {
  const stat = fs.statSync(filePath);
  // check cache vs mtime ...
}

// NEW:
async function getCachedFile(filePath) {
  const stat = await fsPromises.stat(filePath);
  // check cache vs mtime ...
}

// cacheFile (lines ~80-93) — convert readFileSync + statSync:
// OLD:
function cacheFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  // store in cache
  return { content, stat };
}

// NEW:
async function cacheFile(filePath) {
  const [content, stat] = await Promise.all([
    fsPromises.readFile(filePath, 'utf8'),
    fsPromises.stat(filePath),
  ]);
  // store in cache
  return { content, stat };
}

// handleHashlineEdit (line ~267) — convert writeFileSync:
// OLD:
fs.writeFileSync(absoluteFilePath, newFileContent, 'utf8');
// NEW:
await fsPromises.writeFile(absoluteFilePath, newFileContent, 'utf8');
```

Ensure `handleHashlineEdit` is `async` and all callers of `getCachedFile` and `cacheFile` `await` them.

- [ ] **Step 4: Run existing tests to verify no regressions**

```
torque-remote npx vitest run server/tests/hashline-handlers.test.js
```

Expected: all passing

- [ ] **Step 5: Run full suite**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 6: Commit**

```
git add server/handlers/hashline-handlers.js server/tests/hashline-handlers.test.js
git commit -m "perf(sync-io): async stat+readFile+writeFile in hashline-handlers.js (MEDIUM #13)"
```

---

## Task 14: Flip ESLint rule to error mode

**Files:**
- Modify: `server/eslint.config.js`

- [ ] **Step 1: Verify lint is warning-only and passing for all converted files**

```
torque-remote npx eslint --format=compact server/handlers/ server/execution/ server/api/
```

Expected: zero errors (`error` severity), only the 5 grandfathered `warn` items remain if `warn` mode, plus any unrelated pre-existing warnings

- [ ] **Step 2: Flip warn to error in eslint.config.js**

Read `server/eslint.config.js` lines 120-143 first. Find the torque rule entry added in Task 1 and change:

```js
// OLD:
      'torque/no-sync-fs-on-hot-paths': 'warn',

// NEW:
      'torque/no-sync-fs-on-hot-paths': 'error',
```

- [ ] **Step 3: Run lint on all hot-path files**

```
torque-remote npx eslint server/handlers/ server/execution/ server/governance/ server/api/ server/dashboard-server.js
```

Expected: exit 0, zero errors from `torque/no-sync-fs-on-hot-paths`

If any file shows an error: that file was missed in Tasks 2-13. Read the file, apply the async conversion following the same pattern, run `npx vitest run` to confirm tests pass, then re-run lint.

- [ ] **Step 4: Run full suite one more time**

```
torque-remote npx vitest run
```

Expected: all passing

- [ ] **Step 5: Commit**

```
git add server/eslint.config.js
git commit -m "perf(sync-io): flip torque/no-sync-fs-on-hot-paths to error mode"
```

---

## Task 15: Re-scout and post-scan confirmation

**Files:**
- Create: `docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md` (scout will write this)

- [ ] **Step 1: Push branch for scout to access**

```
git push origin feat/perf-1-sync-io
```

- [ ] **Step 2: Run the post-phase scout**

Submit a TORQUE scout task targeting sync I/O patterns in hot-path files. From the worktree directory, the scout brief is:

```
Scout: verify Phase 1 sync I/O closure on branch feat/perf-1-sync-io.
Working directory: <worktree path>

Scan all files matching:
  server/handlers/**
  server/execution/**
  server/governance/**
  server/audit/**
  server/api/**
  server/dashboard-server.js
  server/queue-scheduler*.js
  server/maintenance/orphan-cleanup.js

For each file, look for any remaining calls to:
  fs.readFileSync, fs.writeFileSync, fs.statSync, fs.existsSync,
  fs.readdirSync, fs.unlinkSync, fs.mkdirSync, execFileSync, spawnSync, execSync

For each finding, note:
  - file path + line number
  - whether it has an eslint-disable-next-line comment with a valid reason (>10 chars)
  - whether it matches one of the 5 grandfathered exceptions:
      server/execution/restart-handoff.js
      server/execution/startup-task-reconciler.js
      server/execution/command-builders.js (lines ~31, ~33, ~43, ~52)
      server/execution/process-lifecycle.js

Expected: zero NEW findings (unexcused, no disable comment). Only the 5 grandfathered exceptions remain.

Write findings to: docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md
Format: match phase-1-sync-io-pre.md structure. If zero new findings, note "Phase 1 closure confirmed: zero new sync I/O findings."
```

- [ ] **Step 3: Read the scout output**

```
torque-remote cat docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md
```

Expected: report states "Phase 1 closure confirmed: zero new sync I/O findings."

If any new finding appears: treat it as a missed conversion. Read the flagged file, apply the async conversion pattern from the relevant task above, run lint and tests, commit, then re-run this step.

- [ ] **Step 4: Commit the post-scan findings file**

```
git add docs/findings/2026-04-25-perf-arc/phase-1-sync-io-post.md
git commit -m "docs(perf): Phase 1 post-scan confirms zero new sync I/O findings"
```

---

## Task 16: Update perf baseline with Phase 1 improvement

**Files:**
- Modify: `server/perf/baseline.json`

Context: Per spec §4.1, `governance-evaluate` should improve from 172.64ms to ~10-20ms after the sync git subprocesses are replaced with async. The `task-core-create` metric (0.43ms) may improve marginally. The `perf-baseline:` commit trailer is required per umbrella §4.3.

- [ ] **Step 1: Run the perf harness to get new timings**

```
torque-remote npm run perf --prefix server
```

Expected: output shows `governance-evaluate` significantly lower than 172.64ms. Record the median value.

- [ ] **Step 2: Read current baseline.json**

```
torque-remote cat server/perf/baseline.json
```

Note the current `governance-evaluate` and `task-core-create` values.

- [ ] **Step 3: Update baseline.json with new measurements**

Read `server/perf/baseline.json` first. Update the `governance-evaluate` entry with the new median from Step 1. If `task-core-create` improved, update it too. Leave unchanged metrics as-is.

Example (use actual measured value):

```json
{
  "governance-evaluate": { "median": 14.5, "unit": "ms" },
  "task-core-create": { "median": 0.38, "unit": "ms" }
}
```

- [ ] **Step 4: Run the perf gate to confirm it passes**

```
torque-remote npm run perf --prefix server
```

Expected: `PASS` — no regressions against the newly committed baseline.

- [ ] **Step 5: Commit with required perf-baseline trailers**

Use the actual measured values in the trailers:

```
git add server/perf/baseline.json
git commit -m "$(cat <<'EOF'
perf(baseline): update Phase 1 metrics after sync I/O migration

perf-baseline: governance-evaluate 172.64 to <NEW_VALUE> (Phase 1: sync git subprocesses replaced with async, parallelized over changed-files)
perf-baseline: task-core-create 0.43 to <NEW_VALUE> (Phase 1: governance no longer blocks the pipeline)
EOF
)"
```

Replace `<NEW_VALUE>` with the actual measured medians from Step 1.

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|---|---|
| ESLint rule `torque/no-sync-fs-on-hot-paths` | Task 1 |
| Renamed-binding tracking (e.g., `const { execFileSync: efs }`) | Task 1 step 3 |
| 5 grandfathered exceptions with disable comments | Task 1 step 7 |
| Rule in warn mode initially | Task 1 step 5 |
| HIGH #1 sandbox-revert-detection | Task 2 |
| HIGH #2 review-handler | Task 3 |
| HIGH #3 task/pipeline.js | Task 4 |
| HIGH #4 automation-handlers scanDirectory | Task 5 |
| HIGH #5 validation/index.js | Task 6 |
| MEDIUM #6 task-startup where.exe memo | Task 7 |
| MEDIUM #7 task-startup runPreflightChecks stat | Task 7 |
| MEDIUM #8 ci-handlers resolveRepo | Task 8 |
| MEDIUM #9 workflow-runtime generatePipelineDocumentation | Task 9 |
| MEDIUM #10 v2-governance-handlers plan import | Task 10 |
| MEDIUM #11 v2-task-handlers artifact readFile | Task 11 |
| MEDIUM #12 automation-ts-tools bulk async | Task 12 |
| MEDIUM #13 hashline-handlers | Task 13 |
| Rule flipped to error mode after all conversions | Task 14 |
| Re-scout confirms zero new findings | Task 15 |
| Baseline updated with perf-baseline trailers | Task 16 |
| Phase 1.5 artifacts.js out of scope | Not in plan (correctly deferred) |
| dashboard-server.js already closed | Not in plan (correctly excluded) |

All 20 spec requirements covered. Zero gaps.

### Type/Name Consistency Check

- `readModifyWrite` used in Task 12 step 3 — matches what Task 12 step 3 defines. Consistent.
- `runBounded` used in Task 5 step 3 — matches what Task 5 step 3 defines. Consistent.
- `execFileAsync` defined in Tasks 2, 3, 7, 8 independently per module — each module defines its own local promisified version. No cross-task name conflicts.
- `fsPromises` used in Tasks 5, 6, 7, 9, 10, 11, 12, 13 — all defined as `require('fs').promises` at the top of each module. Consistent.
- `_resolvedWindowsCmdCache` in Task 7 — defined and used in same task. Consistent.
- `isRmwNotFound` marker in Task 12 — defined on thrown error in `readModifyWrite` helper, checked in caller. Consistent.
