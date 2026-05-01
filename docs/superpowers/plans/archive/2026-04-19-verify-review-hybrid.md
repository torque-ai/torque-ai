# Verify-Review Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the factory's blind 3-retry-then-reject verify loop with a hybrid classifier that distinguishes task-caused failures from baseline breakage, and pauses projects whose baseline is broken so no more compute burns on unreachable goals.

**Architecture:** New module `server/factory/verify-review.js` runs a two-pass scorer (deterministic environment check + file-path intersection, then LLM semantic tiebreak on ambiguous cases). Integrates into the existing `executeVerifyStage` in `loop-controller.js` at the first verify failure. Paused projects auto-heal via a new probe phase in `factory-tick.js` that runs the project's `verify_command` against a clean checkout of main; operators can also trigger the probe explicitly via a new MCP tool / REST endpoint. Fail-open on classifier exceptions (project pauses only on positive LLM agreement).

**Tech Stack:** Node.js, vitest with threads pool (per `server/vitest.config.js` default), existing factory helpers (`submitFactoryInternalTask`, `handleAwaitTask`, `factoryHealth.updateProject`, `factoryIntake.updateWorkItem`, `safeLogDecision`), existing event-bus pattern in `server/event-bus.js`.

**Spec:** [docs/superpowers/specs/2026-04-19-verify-review-hybrid-design.md](../specs/2026-04-19-verify-review-hybrid-design.md)

---

## File Structure

### New

- `server/factory/verify-review.js` — the classifier. Exports `reviewVerifyFailure`, `detectEnvironmentFailure`, `parseFailingTests`, `getModifiedFiles`, `runLlmTiebreak`, plus constants `LLM_TIMEOUT_MS`, `ENVIRONMENT_EXIT_CODES`, `ENVIRONMENT_STDERR_PATTERNS`.
- `server/factory/baseline-probe.js` — single-purpose paused-project probe. Exports `probeProjectBaseline`.
- `server/tests/verify-review.test.js` — unit tests for every classifier branch + LLM gating + each test-runner parser.
- `server/tests/baseline-probe.test.js` — unit tests for the probe's success, failure, timeout, and unconfigured cases.
- `server/tests/factory-verify-review-integration.test.js` — e2e tests driving `executeVerifyStage` through the classifier scenarios.
- `server/tests/factory-baseline-probe-integration.test.js` — e2e tests for factory-tick probe phase + MCP tool + REST endpoint.

### Modified

- `server/factory/loop-controller.js`
  - Around line 4222 (inside the `while (true)` verify loop, between `if (res.passed) break;` and `if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES)`): call `reviewVerifyFailure` on the first failure; branch on classification.
- `server/factory/factory-tick.js`
  - Between the existing `reconcileOrphanWorktrees` step and the instance-advance loop: insert a paused-baseline probe phase that runs on projects flagged `baseline_broken_since` in their `config_json`.
- `server/event-bus.js`
  - Add three emit/on helper pairs to `createEventBus()` for `factory:project_baseline_broken`, `factory:project_baseline_cleared`, `factory:project_environment_failure`.
- `server/handlers/factory-handlers.js`
  - Add `handleResumeProjectBaselineFixed(project_id)` handler.
- `server/api/routes/factory-routes.js`
  - Register `POST /api/v2/factory/projects/:project/baseline-resume` → `resume_project_baseline_fixed` tool.
- `server/tool-defs/factory-defs.js` (or wherever factory MCP tool defs live — grep for `set_factory_trust_level` to confirm file)
  - Register the `resume_project_baseline_fixed` MCP tool definition.

No DB migrations. No new API domains beyond the one new route.

---

## Task 1: verify-review module skeleton

**Files:**
- Create: `server/factory/verify-review.js`
- Create: `server/tests/verify-review.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/verify-review.test.js`:

```js
'use strict';

describe('verify-review module exports', () => {
  it('exports reviewVerifyFailure, detectEnvironmentFailure, parseFailingTests, getModifiedFiles, runLlmTiebreak, and constants', () => {
    const mod = require('../factory/verify-review');
    expect(typeof mod.reviewVerifyFailure).toBe('function');
    expect(typeof mod.detectEnvironmentFailure).toBe('function');
    expect(typeof mod.parseFailingTests).toBe('function');
    expect(typeof mod.getModifiedFiles).toBe('function');
    expect(typeof mod.runLlmTiebreak).toBe('function');
    expect(mod.LLM_TIMEOUT_MS).toBe(60_000);
    expect(mod.ENVIRONMENT_EXIT_CODES).toBeInstanceOf(Set);
    expect(Array.isArray(mod.ENVIRONMENT_STDERR_PATTERNS)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL with "Cannot find module '../factory/verify-review'".

- [ ] **Step 3: Write minimal implementation**

Create `server/factory/verify-review.js`:

```js
'use strict';

const LLM_TIMEOUT_MS = 60_000;
const ENVIRONMENT_EXIT_CODES = new Set([127, 126, 124]);
const ENVIRONMENT_STDERR_PATTERNS = [
  /\bEPERM\b/,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\btimeout after \d+/i,
  /\bkilled by signal\b/i,
];

function detectEnvironmentFailure(_verifyOutput) {
  return { detected: false, signals: [], reason: null };
}

function parseFailingTests(_verifyOutput) {
  return [];
}

async function getModifiedFiles(_workingDirectory, _worktreeBranch, _mergeBase) {
  return [];
}

async function runLlmTiebreak(_opts) {
  return { verdict: null, critique: null };
}

async function reviewVerifyFailure(_opts) {
  return {
    classification: 'ambiguous',
    confidence: 'low',
    modifiedFiles: [],
    failingTests: [],
    intersection: [],
    environmentSignals: [],
    llmVerdict: null,
    llmCritique: null,
    suggestedRejectReason: null,
  };
}

module.exports = {
  LLM_TIMEOUT_MS,
  ENVIRONMENT_EXIT_CODES,
  ENVIRONMENT_STDERR_PATTERNS,
  detectEnvironmentFailure,
  parseFailingTests,
  getModifiedFiles,
  runLlmTiebreak,
  reviewVerifyFailure,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review module skeleton"
```

---

## Task 2: Environment failure detection

**Files:**
- Modify: `server/factory/verify-review.js` (`detectEnvironmentFailure`)
- Modify: `server/tests/verify-review.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
const { detectEnvironmentFailure } = require('../factory/verify-review');

describe('detectEnvironmentFailure', () => {
  it('returns detected=true with signal command_not_found on exit code 127', () => {
    const r = detectEnvironmentFailure({ exitCode: 127, stdout: '', stderr: 'pytest: command not found', timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('exit_127');
    expect(r.reason).toBe('command_not_found');
  });

  it('returns detected=true with signal timeout on timedOut=true', () => {
    const r = detectEnvironmentFailure({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('timed_out');
    expect(r.reason).toBe('timeout');
  });

  it('returns detected=true with signal timeout on exit code 124 (GNU timeout wrapper)', () => {
    const r = detectEnvironmentFailure({ exitCode: 124, stdout: '', stderr: '', timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('exit_124');
    expect(r.reason).toBe('timeout');
  });

  it('returns detected=true when stderr matches EPERM pattern', () => {
    const r = detectEnvironmentFailure({ exitCode: 1, stdout: '', stderr: 'fs: EPERM: operation not permitted', timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('stderr_EPERM');
    expect(r.reason).toBe('permission_denied');
  });

  it('returns detected=true when stderr matches ENOENT pattern', () => {
    const r = detectEnvironmentFailure({ exitCode: 1, stdout: '', stderr: 'Error: ENOENT: no such file or directory', timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('stderr_ENOENT');
    expect(r.reason).toBe('missing_file_or_dir');
  });

  it('returns detected=false for normal test-runner exit 1 with failing-test output', () => {
    const r = detectEnvironmentFailure({ exitCode: 1, stdout: 'FAILED tests/foo.py::test_bar', stderr: '', timedOut: false });
    expect(r.detected).toBe(false);
    expect(r.signals).toEqual([]);
    expect(r.reason).toBeNull();
  });

  it('returns detected=false for exit 0 (passing verify)', () => {
    const r = detectEnvironmentFailure({ exitCode: 0, stdout: 'PASSED', stderr: '', timedOut: false });
    expect(r.detected).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on all 7 new tests (stub returns `{detected: false, ...}` always).

- [ ] **Step 3: Implement detectEnvironmentFailure**

Replace the stub in `server/factory/verify-review.js`:

```js
function detectEnvironmentFailure(verifyOutput) {
  const signals = [];
  let reason = null;

  if (verifyOutput && verifyOutput.timedOut === true) {
    signals.push('timed_out');
    reason = 'timeout';
  }

  const exitCode = verifyOutput ? verifyOutput.exitCode : null;
  if (typeof exitCode === 'number' && ENVIRONMENT_EXIT_CODES.has(exitCode)) {
    signals.push(`exit_${exitCode}`);
    if (exitCode === 127) reason = reason || 'command_not_found';
    else if (exitCode === 126) reason = reason || 'permission_denied';
    else if (exitCode === 124) reason = reason || 'timeout';
  }

  const stderr = verifyOutput ? String(verifyOutput.stderr || '') : '';
  const stderrChecks = [
    { re: /\bEPERM\b/, signal: 'stderr_EPERM', reason: 'permission_denied' },
    { re: /\bEACCES\b/, signal: 'stderr_EACCES', reason: 'permission_denied' },
    { re: /\bENOENT\b/, signal: 'stderr_ENOENT', reason: 'missing_file_or_dir' },
    { re: /\btimeout after \d+/i, signal: 'stderr_timeout', reason: 'timeout' },
    { re: /\bkilled by signal\b/i, signal: 'stderr_killed', reason: 'timeout' },
  ];
  for (const check of stderrChecks) {
    if (check.re.test(stderr)) {
      signals.push(check.signal);
      reason = reason || check.reason;
    }
  }

  return { detected: signals.length > 0, signals, reason };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS (8/8 total).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review environment failure detection"
```

---

## Task 3: Failing test parser (pytest, vitest, dotnet test)

**Files:**
- Modify: `server/factory/verify-review.js` (`parseFailingTests`)
- Modify: `server/tests/verify-review.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
const { parseFailingTests } = require('../factory/verify-review');

describe('parseFailingTests', () => {
  it('parses pytest FAILED lines into test file paths', () => {
    const out = {
      stdout: `
...
FAILED tests/foo.py::test_bar - AssertionError: expected 1 got 2
FAILED tests/baz.py::test_qux - ValueError: bad input
===================== 2 failed, 3 passed in 1.23s ====================
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r).toContain('tests/foo.py');
    expect(r).toContain('tests/baz.py');
    expect(r).toHaveLength(2);
  });

  it('parses vitest ❯ lines into test file paths', () => {
    const out = {
      stdout: `
 FAIL  src/components/Foo.test.tsx > Foo > renders
   Error: expect(received).toBe(expected)
 ❯ src/components/Foo.test.tsx:12:5
 FAIL  src/utils/bar.test.ts > bar > adds
 ❯ src/utils/bar.test.ts:8:3
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r).toContain('src/components/Foo.test.tsx');
    expect(r).toContain('src/utils/bar.test.ts');
    expect(r).toHaveLength(2);
  });

  it('parses dotnet test failure summary into test DLL paths', () => {
    const out = {
      stdout: `
Failed!  - Failed:     3, Passed:     5, Skipped:     0, Total:     8
Test Files: /r/tests/Foo.Tests/bin/Debug/net8.0/Foo.Tests.dll
Test Files: /r/tests/Bar.Tests/bin/Debug/net8.0/Bar.Tests.dll
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r.some(p => p.endsWith('Foo.Tests.dll'))).toBe(true);
    expect(r.some(p => p.endsWith('Bar.Tests.dll'))).toBe(true);
  });

  it('returns empty array on unknown output format', () => {
    const out = { stdout: 'Some unexpected output with no test results', stderr: '' };
    expect(parseFailingTests(out)).toEqual([]);
  });

  it('returns empty array on empty output', () => {
    expect(parseFailingTests({ stdout: '', stderr: '' })).toEqual([]);
    expect(parseFailingTests({})).toEqual([]);
    expect(parseFailingTests(null)).toEqual([]);
  });

  it('de-duplicates when the same file fails multiple tests', () => {
    const out = {
      stdout: `FAILED tests/foo.py::test_a\nFAILED tests/foo.py::test_b\n`,
      stderr: '',
    };
    expect(parseFailingTests(out)).toEqual(['tests/foo.py']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on 6 new tests (stub returns `[]` always).

- [ ] **Step 3: Implement parseFailingTests**

Replace the stub in `server/factory/verify-review.js`. Use `String.prototype.matchAll` for each parser so we iterate regex matches cleanly:

```js
function parseFailingTests(verifyOutput) {
  if (!verifyOutput) return [];
  const combined = String(verifyOutput.stdout || '') + '\n' + String(verifyOutput.stderr || '');
  if (!combined.trim()) return [];

  const paths = new Set();

  // Pytest: "FAILED tests/foo.py::test_bar - ..." or "FAILED tests/foo.py - collection error"
  const pytestRe = /^FAILED\s+([A-Za-z0-9_./\\-]+?\.py)(?:::|\s|$)/gm;
  for (const m of combined.matchAll(pytestRe)) {
    paths.add(m[1]);
  }

  // Vitest arrow pointer: "❯ src/foo.test.ts:line:col"
  const vitestPointerRe = /❯\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+/g;
  for (const m of combined.matchAll(vitestPointerRe)) {
    paths.add(m[1]);
  }
  // Vitest FAIL header: "FAIL  src/foo.test.ts > describe > it"
  const vitestFailRe = /^\s*FAIL\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))\s*>/gm;
  for (const m of combined.matchAll(vitestFailRe)) {
    paths.add(m[1]);
  }

  // Dotnet test: "Test Files: <path>/<name>.dll" or "Failed ... Files: <path>/<name>.dll"
  const dotnetRe = /(?:Test Files?:|Files:)\s*([A-Za-z]:[\\/]?[^\s]+\.dll|[\\/][^\s]+\.dll|[A-Za-z0-9_./\\-]+?\.dll)/g;
  for (const m of combined.matchAll(dotnetRe)) {
    paths.add(m[1]);
  }

  return Array.from(paths);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS on all tests so far (14/14).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review failing-test parser"
```

---

## Task 4: Modified files helper (git diff)

**Files:**
- Modify: `server/factory/verify-review.js` (`getModifiedFiles`)
- Modify: `server/tests/verify-review.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
const { vi } = require('vitest');
const childProcess = require('node:child_process');
const { getModifiedFiles } = require('../factory/verify-review');

describe('getModifiedFiles', () => {
  let spawnSpy;

  afterEach(() => {
    if (spawnSpy) spawnSpy.mockRestore();
  });

  function mockGitDiff(stdout, exitCode = 0) {
    spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const { EventEmitter } = require('node:events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
      });
      return child;
    });
  }

  it('returns parsed file paths from git diff --name-only', async () => {
    mockGitDiff('src/foo.ts\ntests/foo.test.ts\n');
    const r = await getModifiedFiles('/tmp/p', 'feat/factory-1-example', 'main');
    expect(r).toEqual(['src/foo.ts', 'tests/foo.test.ts']);
  });

  it('returns empty array when git exits non-zero', async () => {
    mockGitDiff('', 128);
    const r = await getModifiedFiles('/tmp/p', 'feat/factory-1-example', 'main');
    expect(r).toEqual([]);
  });

  it('returns empty array when git spawn throws', async () => {
    spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('spawn EPERM');
    });
    const r = await getModifiedFiles('/tmp/p', 'feat/factory-1-example', 'main');
    expect(r).toEqual([]);
  });

  it('returns empty array when stdout is empty', async () => {
    mockGitDiff('');
    const r = await getModifiedFiles('/tmp/p', 'feat/factory-1-example', 'main');
    expect(r).toEqual([]);
  });

  it('strips blank lines and trims whitespace', async () => {
    mockGitDiff('src/a.ts\n\n  src/b.ts  \n\n');
    const r = await getModifiedFiles('/tmp/p', 'feat/factory-1-example', 'main');
    expect(r).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on 5 new tests (stub returns `[]` always; mocks never asserted).

- [ ] **Step 3: Implement getModifiedFiles**

Replace the stub in `server/factory/verify-review.js`. Use async `spawn` (not `spawnSync` — the factory lint rule bans that):

```js
const { spawn } = require('node:child_process');

async function getModifiedFiles(workingDirectory, worktreeBranch, mergeBase) {
  // Use `git diff --name-only <mergeBase>...<worktreeBranch>` to list files
  // the worktree's branch changed relative to the merge-base with main. The
  // three-dot range is used so changes made on main since the branch started
  // don't pollute the list.
  //
  // Any git error (exit != 0, spawn throw, missing cwd) → return []. The
  // caller falls back to the LLM tiebreak when the list is empty.
  if (!workingDirectory || !worktreeBranch || !mergeBase) return [];
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn('git', ['diff', '--name-only', `${mergeBase}...${worktreeBranch}`], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (_e) {
      resolve([]);
      return;
    }
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) return resolve([]);
      const paths = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      resolve(paths);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS on all tests so far (19/19).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review git-diff modified files helper"
```

---

## Task 5: LLM tiebreak

**Files:**
- Modify: `server/factory/verify-review.js` (`runLlmTiebreak`)
- Modify: `server/tests/verify-review.test.js`

**Context:** Follows the same pattern as yesterday's `plan-quality-gate`'s `runLlmSemanticCheck`: submits an internal factory task via `submitFactoryInternalTask({ kind: 'plan_generation', ... })`, awaits via `handleAwaitTask`, reads result via `taskCore.getTask`. Returns `{ verdict: 'go' | 'no-go' | null, critique: string | null }`. 'go' means "failure IS attributable to this diff — retry it". 'no-go' means "failure is NOT attributable — baseline is broken".

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
// require.cache mock helper (same pattern as plan-quality-gate tests, since
// vi.doMock doesn't intercept lazy require() calls inside the SUT).
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../factory/verify-review.js');

describe('runLlmTiebreak', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[modulePath];
  }

  afterEach(() => {
    for (const [path, cached] of savedCache) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
    savedCache.clear();
    delete require.cache[modulePath];
  });

  it('returns {verdict: null, critique: null} when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('provider down')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r).toEqual({ verdict: null, critique: null });
  });

  it('returns {verdict: null, critique: null} when task does not complete', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 't1' }),
      await: vi.fn().mockResolvedValue({ status: 'timeout' }),
      task: vi.fn().mockReturnValue({ status: 'running', output: null }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r).toEqual({ verdict: null, critique: null });
  });

  it('returns {verdict: "no-go", critique} when task output is JSON no-go', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 't2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"no-go","critique":"Failures reference legacy reconciler not touched by this diff."}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/legacy_reconciler_test.py'],
      modifiedFiles: ['src/feature_x.py'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.verdict).toBe('no-go');
    expect(r.critique).toContain('legacy reconciler');
  });

  it('returns {verdict: "go", critique} when task output is JSON go', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 't3' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"Test file imports the modified util and asserts on its return value."}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/helper.test.ts'],
      modifiedFiles: ['src/helper.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.verdict).toBe('go');
    expect(r.critique).toContain('modified util');
  });

  it('returns {verdict: null, critique: null} when output is unparseable', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 't4' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'not json' }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r).toEqual({ verdict: null, critique: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on 5 new tests (stub returns `{verdict: null, critique: null}` always — will pass the null cases but fail the parseable-JSON cases).

- [ ] **Step 3: Implement runLlmTiebreak**

Replace the stub in `server/factory/verify-review.js`:

```js
async function runLlmTiebreak({ failingTests, modifiedFiles, workItem, project, timeoutMs = LLM_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const prompt = buildTiebreakPrompt({ failingTests, modifiedFiles, workItem });
  let taskId;
  try {
    const submitResult = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'plan_generation',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submitResult?.task_id || null;
  } catch (_e) {
    return { verdict: null, critique: null };
  }
  if (!taskId) return { verdict: null, critique: null };

  try {
    await handleAwaitTask({
      task_id: taskId,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
      heartbeat_minutes: 0,
    });
  } catch (_e) {
    return { verdict: null, critique: null };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') return { verdict: null, critique: null };

  const raw = String(task.output || '').trim();
  if (!raw) return { verdict: null, critique: null };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const verdict = parsed && parsed.verdict === 'no-go' ? 'no-go'
                  : parsed && parsed.verdict === 'go' ? 'go'
                  : null;
    if (verdict === null) return { verdict: null, critique: null };
    const critique = typeof parsed.critique === 'string' ? parsed.critique.trim() : null;
    return { verdict, critique };
  } catch (_e) {
    void _e;
    return { verdict: null, critique: null };
  }
}

function buildTiebreakPrompt({ failingTests, modifiedFiles, workItem }) {
  return `You are a quality reviewer for a software factory's verify step.

The factory ran a work item's task on a feature branch. The verify command (test runner) exited non-zero. Before burning another retry cycle, I need to know whether the failing tests were caused by this task's diff or by a pre-existing broken baseline.

Work item title: ${workItem?.title || '(none)'}
Work item description: ${workItem?.description || '(none)'}

Failing test file paths:
${failingTests.map((p) => `  - ${p}`).join('\n') || '  (none parsed)'}

Files modified by the diff:
${modifiedFiles.map((p) => `  - ${p}`).join('\n') || '  (none)'}

Return ONLY valid JSON in this exact shape:
{"verdict":"go"|"no-go","critique":"one sentence explaining the verdict"}

- "go" means: the failures ARE attributable to this diff. Retry makes sense.
- "no-go" means: the failures are NOT attributable. The project's baseline is broken; retrying will not help.
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS on all tests so far (24/24).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review LLM tiebreak"
```

---

## Task 6: reviewVerifyFailure orchestrator

**Files:**
- Modify: `server/factory/verify-review.js` (`reviewVerifyFailure`)
- Modify: `server/tests/verify-review.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
const verifyReview = require('../factory/verify-review');

describe('reviewVerifyFailure orchestrator', () => {
  it('environment_failure: returns environment_failure without calling LLM', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: 'go', critique: 'should not be called' });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 127, stdout: '', stderr: 'pytest: command not found', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('environment_failure');
    expect(r.confidence).toBe('high');
    expect(llmSpy).not.toHaveBeenCalled();
    expect(r.environmentSignals.length).toBeGreaterThan(0);
    expect(r.suggestedRejectReason).toBe('verify_failed_environment');
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('task_caused: intersection non-empty returns task_caused without calling LLM', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: 'go', critique: 'should not be called' });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['tests/foo.test.ts', 'src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAIL  tests/foo.test.ts > Foo > renders\n❯ tests/foo.test.ts:12:5', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('task_caused');
    expect(r.confidence).toBe('high');
    expect(r.intersection).toContain('tests/foo.test.ts');
    expect(llmSpy).not.toHaveBeenCalled();
    expect(r.suggestedRejectReason).toBeNull();
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM no-go: returns baseline_broken with critique', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: 'no-go', critique: 'Failures are in the legacy reconciler module this diff never touched.' });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/feature_x.py']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/legacy_reconciler_test.py::test_something - ...', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('baseline_broken');
    expect(r.confidence).toBe('high');
    expect(llmSpy).toHaveBeenCalledTimes(1);
    expect(r.llmVerdict).toBe('no-go');
    expect(r.llmCritique).toContain('legacy reconciler');
    expect(r.suggestedRejectReason).toBe('verify_failed_baseline_unrelated');
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM go: returns task_caused (LLM overruled deterministic)', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: 'go', critique: 'Test imports the modified util via deep path alias.' });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/util.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAIL  tests/consumer.test.ts > ...\n❯ tests/consumer.test.ts:8:3', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('task_caused');
    expect(r.confidence).toBe('medium');
    expect(r.llmVerdict).toBe('go');
    expect(r.suggestedRejectReason).toBeNull();
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM null: returns ambiguous (conservative)', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: null, critique: null });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/bar.py::test_baz', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('ambiguous');
    expect(r.confidence).toBe('low');
    expect(r.suggestedRejectReason).toBeNull();
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('ambiguous (no failing tests parsed) + LLM no-go: returns baseline_broken confidence medium', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({ verdict: 'no-go', critique: 'Output indicates a runner-level failure unrelated to the diff.' });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'Some unknown output format', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('baseline_broken');
    expect(r.confidence).toBe('medium');
    expect(r.suggestedRejectReason).toBe('verify_failed_baseline_unrelated');
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on 6 new tests — stub returns `ambiguous` always without consulting the helpers.

- [ ] **Step 3: Implement reviewVerifyFailure**

Replace the stub in `server/factory/verify-review.js`. Note the `module.exports.getModifiedFiles` and `module.exports.runLlmTiebreak` indirection — it lets tests intercept via `vi.spyOn`:

```js
async function reviewVerifyFailure({
  verifyOutput,
  workingDirectory,
  worktreeBranch,
  mergeBase,
  workItem,
  project,
  options = {},
}) {
  const env = detectEnvironmentFailure(verifyOutput);
  if (env.detected) {
    return {
      classification: 'environment_failure',
      confidence: 'high',
      modifiedFiles: [],
      failingTests: [],
      intersection: [],
      environmentSignals: env.signals,
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: 'verify_failed_environment',
    };
  }

  const failingTests = parseFailingTests(verifyOutput);
  const modifiedFiles = await module.exports.getModifiedFiles(workingDirectory, worktreeBranch, mergeBase);
  const intersection = failingTests.filter((t) => modifiedFiles.includes(t));

  if (intersection.length > 0) {
    return {
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    };
  }

  const deterministicBase = failingTests.length > 0 ? 'baseline_candidate' : 'ambiguous';

  // Both baseline_candidate and ambiguous fire the LLM.
  const llm = await module.exports.runLlmTiebreak({
    failingTests,
    modifiedFiles,
    workItem,
    project,
    timeoutMs: options.llmTimeoutMs,
  });

  // No LLM result → conservative: ambiguous (never pause without positive agreement).
  if (!llm || llm.verdict === null) {
    return {
      classification: 'ambiguous',
      confidence: 'low',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    };
  }

  if (llm.verdict === 'no-go') {
    return {
      classification: 'baseline_broken',
      confidence: deterministicBase === 'baseline_candidate' ? 'high' : 'medium',
      modifiedFiles,
      failingTests,
      intersection,
      environmentSignals: [],
      llmVerdict: 'no-go',
      llmCritique: llm.critique,
      suggestedRejectReason: 'verify_failed_baseline_unrelated',
    };
  }

  // llm.verdict === 'go' — LLM overruled deterministic, retry.
  return {
    classification: 'task_caused',
    confidence: deterministicBase === 'baseline_candidate' ? 'medium' : 'low',
    modifiedFiles,
    failingTests,
    intersection,
    environmentSignals: [],
    llmVerdict: 'go',
    llmCritique: llm.critique,
    suggestedRejectReason: null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS on all tests (30/30).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review orchestrator"
```

---

## Task 7: baseline-probe module

**Files:**
- Create: `server/factory/baseline-probe.js`
- Create: `server/tests/baseline-probe.test.js`

**Context:** The probe runs `verify_command` against a clean checkout of main (no worktree). It delegates to a caller-provided `runner` function with the shape `({ command, cwd, timeoutMs }) => Promise<{ exitCode, stdout, stderr, durationMs, timedOut }>`. The factory wires `runner` to the same remote-workstation-aware runner used by `executeVerifyStage`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/baseline-probe.test.js`:

```js
'use strict';

describe('baseline-probe module exports', () => {
  it('exports probeProjectBaseline', () => {
    const mod = require('../factory/baseline-probe');
    expect(typeof mod.probeProjectBaseline).toBe('function');
  });
});

describe('probeProjectBaseline', () => {
  it('returns { passed: false, error: "no_verify_command" } when verify_command is missing', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const runner = vi.fn();
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: '',
      runner,
    });
    expect(r.passed).toBe(false);
    expect(r.error).toBe('no_verify_command');
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns { passed: true } when runner exits 0', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: 'all tests passed', stderr: '', durationMs: 1234, timedOut: false,
    });
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: 'npm test',
      runner,
    });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBe(1234);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns { passed: false, output preserved } when runner exits non-zero', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const runner = vi.fn().mockResolvedValue({
      exitCode: 1, stdout: 'FAIL', stderr: 'test error', durationMs: 500, timedOut: false,
    });
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: 'npm test',
      runner,
    });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('FAIL');
    expect(r.output).toContain('test error');
  });

  it('returns { passed: false, error: "runner_threw" } when runner throws', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const runner = vi.fn().mockRejectedValue(new Error('remote unreachable'));
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: 'npm test',
      runner,
    });
    expect(r.passed).toBe(false);
    expect(r.error).toBe('runner_threw');
  });

  it('returns { passed: false, error: "timeout" } when runner reports timedOut', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const runner = vi.fn().mockResolvedValue({
      exitCode: null, stdout: '', stderr: '', durationMs: 300000, timedOut: true,
    });
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: 'npm test',
      runner,
    });
    expect(r.passed).toBe(false);
    expect(r.error).toBe('timeout');
  });

  it('truncates combined output to 4KB', async () => {
    const { probeProjectBaseline } = require('../factory/baseline-probe');
    const bigStdout = 'X'.repeat(8 * 1024);
    const runner = vi.fn().mockResolvedValue({
      exitCode: 1, stdout: bigStdout, stderr: '', durationMs: 100, timedOut: false,
    });
    const r = await probeProjectBaseline({
      project: { id: 'p', path: '/tmp/p' },
      verifyCommand: 'npm test',
      runner,
    });
    expect(r.output.length).toBeLessThanOrEqual(4 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/baseline-probe.test.js`
Expected: FAIL — "Cannot find module '../factory/baseline-probe'".

- [ ] **Step 3: Write the implementation**

Create `server/factory/baseline-probe.js`:

```js
'use strict';

const OUTPUT_TRUNCATE_BYTES = 4 * 1024;

async function probeProjectBaseline({ project, verifyCommand, runner, timeoutMs = 5 * 60 * 1000 }) {
  if (!verifyCommand || !String(verifyCommand).trim()) {
    return { passed: false, exitCode: null, output: '', durationMs: 0, error: 'no_verify_command' };
  }
  let result;
  try {
    result = await runner({
      command: verifyCommand,
      cwd: project.path,
      timeoutMs,
    });
  } catch (_e) {
    return { passed: false, exitCode: null, output: '', durationMs: 0, error: 'runner_threw' };
  }

  const combined = String(result.stdout || '') + (result.stderr ? '\n' + String(result.stderr) : '');
  const output = combined.length > OUTPUT_TRUNCATE_BYTES ? combined.slice(-OUTPUT_TRUNCATE_BYTES) : combined;

  if (result.timedOut) {
    return { passed: false, exitCode: result.exitCode, output, durationMs: result.durationMs, error: 'timeout' };
  }
  if (result.exitCode === 0) {
    return { passed: true, exitCode: 0, output, durationMs: result.durationMs, error: null };
  }
  return { passed: false, exitCode: result.exitCode, output, durationMs: result.durationMs, error: null };
}

module.exports = { probeProjectBaseline };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/baseline-probe.test.js`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add server/factory/baseline-probe.js server/tests/baseline-probe.test.js
git commit -m "feat(factory): baseline-probe module"
```

---

## Task 8: Event-bus emitters

**Files:**
- Modify: `server/event-bus.js`
- Modify: `server/tests/plan-quality-gate-integration-shims.test.js` (reuse for the new emitter tests)

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/plan-quality-gate-integration-shims.test.js`:

```js
describe('event-bus verify-review emitters', () => {
  it('emitFactoryProjectBaselineBroken fires factory:project_baseline_broken', () => {
    const { createEventBus } = require('../event-bus');
    const bus = createEventBus();
    const spy = vi.fn();
    bus.onFactoryProjectBaselineBroken(spy);
    bus.emitFactoryProjectBaselineBroken({ project_id: 'p', reason: 'r', failing_tests: ['t'], evidence: {} });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ project_id: 'p', reason: 'r', failing_tests: ['t'], evidence: {} });
  });

  it('emitFactoryProjectBaselineCleared fires factory:project_baseline_cleared', () => {
    const { createEventBus } = require('../event-bus');
    const bus = createEventBus();
    const spy = vi.fn();
    bus.onFactoryProjectBaselineCleared(spy);
    bus.emitFactoryProjectBaselineCleared({ project_id: 'p', cleared_after_ms: 12345 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emitFactoryProjectEnvironmentFailure fires factory:project_environment_failure', () => {
    const { createEventBus } = require('../event-bus');
    const bus = createEventBus();
    const spy = vi.fn();
    bus.onFactoryProjectEnvironmentFailure(spy);
    bus.emitFactoryProjectEnvironmentFailure({ project_id: 'p', signals: ['exit_127'], exit_code: 127 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/plan-quality-gate-integration-shims.test.js`
Expected: FAIL on the 3 new tests — emitters don't exist.

- [ ] **Step 3: Add the emitters**

In `server/event-bus.js`, inside the `createEventBus()` return object, after the existing `emitFactoryPlanGateSkipped` line (around line 53), insert:

```js
    emitFactoryProjectBaselineBroken: (data) => emitter.emit('factory:project_baseline_broken', data),
    onFactoryProjectBaselineBroken: (fn) => emitter.on('factory:project_baseline_broken', fn),
    emitFactoryProjectBaselineCleared: (data) => emitter.emit('factory:project_baseline_cleared', data),
    onFactoryProjectBaselineCleared: (fn) => emitter.on('factory:project_baseline_cleared', fn),
    emitFactoryProjectEnvironmentFailure: (data) => emitter.emit('factory:project_environment_failure', data),
    onFactoryProjectEnvironmentFailure: (fn) => emitter.on('factory:project_environment_failure', fn),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/plan-quality-gate-integration-shims.test.js`
Expected: PASS on all tests (8/8 total).

- [ ] **Step 5: Commit**

```bash
git add server/event-bus.js server/tests/plan-quality-gate-integration-shims.test.js
git commit -m "feat(factory): event-bus verify-review emitters"
```

---

## Task 9: Integrate classifier into executeVerifyStage

**Files:**
- Modify: `server/factory/loop-controller.js` (`executeVerifyStage`, around line 4222 inside the verify while-loop)
- Create: `server/tests/factory-verify-review-integration.test.js`

**Context:** Current flow at line 4222 is:

```js
while (true) {
  res = await worktreeRunner.verify({...});
  if (res.passed) { log, break; }
  if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES) { reject-exhaust path; break; }
  // ... submit retry task, increment retryAttempt, continue
}
```

We insert the classifier right after `if (res.passed) break;` and before the retry-exhaust check, but **only on the first failure** (`retryAttempt === 0`). On retries, the classifier already fired at attempt 0 — no need to re-classify. Consequential classifications (`baseline_broken`, `environment_failure`) break out of the loop and drive a dedicated reject + project-pause path; non-consequential classifications (`task_caused`, `ambiguous`, or fail-open null) fall through to the existing retry path.

- [ ] **Step 1: Write the failing tests (3 scenarios)**

Create `server/tests/factory-verify-review-integration.test.js`:

```js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const fs = require('node:fs');
const path = require('node:path');

function seedProjectItemAndWorktree(db, { trust = 'autonomous', originOverrides = {} } = {}) {
  const tempPath = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vr-e2e-'));
  const projectId = 'proj-vr-e2e';
  db.prepare(`INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'running', '{}', datetime('now'), datetime('now'))`)
    .run(projectId, 'Test', tempPath, trust);
  const { lastInsertRowid: workItemId } = db.prepare(
    `INSERT INTO factory_work_items (project_id, source, title, description, priority, status, origin_json, created_at, updated_at)
     VALUES (?, 'architect', 'test item', 'desc', 50, 'executing', ?, datetime('now'), datetime('now'))`
  ).run(projectId, JSON.stringify({ plan_path: path.join(tempPath, 'plan.md'), ...originOverrides }));
  const batchId = `factory-${projectId}-${workItemId}`;
  db.prepare(
    `INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, branch, base_branch, worktree_path, vc_worktree_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', ?, 'vcid1', 'active', datetime('now'), datetime('now'))`
  ).run(projectId, workItemId, batchId, `feat/factory-${workItemId}-test`, path.join(tempPath, '.worktrees', 'feat-test'));
  return { projectId, workItemId, batchId, tempPath };
}

describe('executeVerifyStage + verify-review integration', () => {
  let db;
  beforeEach(() => { ({ db } = setupTestDb('verify-review-e2e')); });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  it('Scenario 1 (task_caused): retry fires, existing flow unchanged', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);

    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, stdout: 'FAIL  tests/foo.test.ts', stderr: '', output: 'FAIL  tests/foo.test.ts', durationMs: 100, timedOut: false })
      .mockResolvedValueOnce({ passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false });
    vi.spyOn(loopController, 'getWorktreeRunner').mockReturnValue({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'task_caused', confidence: 'high',
      modifiedFiles: ['tests/foo.test.ts'], failingTests: ['tests/foo.test.ts'], intersection: ['tests/foo.test.ts'],
      environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null,
    });

    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-retry' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '' });

    const instance = { id: 'inst-1', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('passed');
    expect(verify).toHaveBeenCalledTimes(2);
    const item = db.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).not.toBe('rejected');
    const project = db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('running');
  });

  it('Scenario 2 (baseline_broken): rejects item, pauses project, emits event', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const eventBus = require('../event-bus');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);

    const verify = vi.fn().mockResolvedValue({
      passed: false, exitCode: 1,
      stdout: 'FAILED tests/legacy_reconciler_test.py::test_old_thing',
      stderr: '', output: 'FAILED tests/legacy_reconciler_test.py::test_old_thing', durationMs: 100, timedOut: false,
    });
    vi.spyOn(loopController, 'getWorktreeRunner').mockReturnValue({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'baseline_broken', confidence: 'high',
      modifiedFiles: ['src/feature_x.py'], failingTests: ['tests/legacy_reconciler_test.py'], intersection: [],
      environmentSignals: [],
      llmVerdict: 'no-go', llmCritique: 'Failures in legacy reconciler, untouched by diff.',
      suggestedRejectReason: 'verify_failed_baseline_unrelated',
    });

    const eventSpy = vi.fn();
    eventBus.onFactoryProjectBaselineBroken(eventSpy);

    const instance = { id: 'inst-2', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('baseline_broken');
    const item = db.prepare('SELECT status, reject_reason FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).toBe('rejected');
    expect(item.reject_reason).toBe('verify_failed_baseline_unrelated');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
    expect(cfg.baseline_broken_reason).toBe('verify_failed_baseline_unrelated');
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].project_id).toBe(projectId);
  });

  it('Scenario 6 (classifier throws): fail-open, retry path fires', async () => {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');

    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);

    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, stdout: 'FAIL', stderr: '', output: 'FAIL', durationMs: 100, timedOut: false })
      .mockResolvedValueOnce({ passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false });
    vi.spyOn(loopController, 'getWorktreeRunner').mockReturnValue({ verify });

    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockRejectedValue(new Error('classifier exploded'));
    vi.spyOn(require('../factory/internal-task-submit'), 'submitFactoryInternalTask').mockResolvedValue({ task_id: 't-retry' });
    vi.spyOn(require('../handlers/workflow/await'), 'handleAwaitTask').mockResolvedValue({ status: 'completed' });
    vi.spyOn(require('../db/task-core'), 'getTask').mockReturnValue({ status: 'completed', output: '' });

    const instance = { id: 'inst-6', project_id: projectId, batch_id: batchId, work_item_id: workItemId };
    const r = await loopController.executeVerifyStage(projectId, batchId, instance);

    expect(r.status).toBe('passed');
    const item = db.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(workItemId);
    expect(item.status).not.toBe('rejected');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/factory-verify-review-integration.test.js`
Expected: FAIL — classifier isn't wired into `executeVerifyStage` yet.

- [ ] **Step 3: Wire the classifier**

In `server/factory/loop-controller.js`, inside `executeVerifyStage`'s while-loop (around line 4222):

Before the `while (true)` at line 4221, declare:

```js
    const verifyReview = require('./verify-review');
    const eventBus = require('../event-bus');
    let review = null;
```

Inside the loop, immediately after `if (res.passed) { log; break; }` and before the existing `if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES)` check, insert:

```js
        if (retryAttempt === 0 && !review) {
          try {
            const wi = instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null;
            review = await verifyReview.reviewVerifyFailure({
              verifyOutput: res,
              workingDirectory: project?.path || process.cwd(),
              worktreeBranch: worktreeRecord.branch,
              mergeBase: worktreeRecord.base_branch || 'main',
              workItem: wi,
              project: project || { id: project_id, path: null },
            });
          } catch (err) {
            logger.warn('verify-review classifier failed; falling through to existing retry path', {
              project_id, err: err.message,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_reviewer_fail_open',
              reasoning: `Classifier threw: ${err.message}. Retrying as before.`,
              outcome: { work_item_id: instance?.work_item_id || null },
              confidence: 1,
              batch_id,
            });
            review = null;
          }

          if (review && (review.classification === 'baseline_broken' ||
                         review.classification === 'environment_failure')) {
            if (instance?.work_item_id) {
              try {
                factoryIntake.updateWorkItem(instance.work_item_id, {
                  status: 'rejected',
                  reject_reason: review.suggestedRejectReason,
                });
              } catch (_e) { void _e; }
            }

            try {
              const currentProject = factoryHealth.getProject(project_id);
              const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
              cfg.baseline_broken_since = new Date().toISOString();
              cfg.baseline_broken_reason = review.suggestedRejectReason;
              cfg.baseline_broken_evidence = {
                failing_tests: review.failingTests,
                exit_code: res.exitCode,
                environment_signals: review.environmentSignals,
                llm_critique: review.llmCritique,
              };
              cfg.baseline_broken_probe_attempts = 0;
              cfg.baseline_broken_tick_count = 0;
              factoryHealth.updateProject(project_id, {
                status: 'paused',
                config_json: JSON.stringify(cfg),
              });
            } catch (_e) { void _e; }

            try {
              if (review.classification === 'baseline_broken') {
                eventBus.emitFactoryProjectBaselineBroken({
                  project_id,
                  reason: review.suggestedRejectReason,
                  failing_tests: review.failingTests,
                  evidence: { exit_code: res.exitCode, llm_critique: review.llmCritique },
                });
              } else {
                eventBus.emitFactoryProjectEnvironmentFailure({
                  project_id,
                  signals: review.environmentSignals,
                  exit_code: res.exitCode,
                });
              }
            } catch (_e) { void _e; }

            const action = review.classification === 'baseline_broken'
              ? 'verify_reviewed_baseline_broken'
              : 'verify_reviewed_environment_failure';
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action,
              reasoning: review.classification === 'baseline_broken'
                ? `Baseline broken — ${review.failingTests.length} failing test(s) unrelated to this diff. ${review.llmCritique || ''}`
                : `Environment failure — signals: ${review.environmentSignals.join(', ')}.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                environmentSignals: review.environmentSignals,
                llmVerdict: review.llmVerdict,
              },
              confidence: 1,
              batch_id,
            });

            return { status: 'rejected', reason: review.classification };
          }

          const reviewedAction = review && review.classification === 'task_caused'
            ? 'verify_reviewed_task_caused'
            : 'verify_reviewed_ambiguous_retrying';
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: reviewedAction,
            reasoning: review
              ? `Classifier says ${review.classification} (confidence=${review.confidence}); existing retry path will fire.`
              : 'Classifier unavailable; retrying as before.',
            outcome: review ? {
              work_item_id: instance?.work_item_id || null,
              classification: review.classification,
              confidence: review.confidence,
              modifiedFiles: review.modifiedFiles,
              failingTests: review.failingTests,
              intersection: review.intersection,
            } : { work_item_id: instance?.work_item_id || null, classifier: 'unavailable' },
            confidence: 1,
            batch_id,
          });
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/factory-verify-review-integration.test.js`
Expected: PASS on scenarios 1, 2, 6.

- [ ] **Step 5: Run the full verify-review test suite to confirm no regressions**

Run: `cd server && npx vitest run tests/verify-review.test.js tests/baseline-probe.test.js tests/plan-quality-gate-integration-shims.test.js tests/factory-verify-review-integration.test.js`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add server/factory/loop-controller.js server/tests/factory-verify-review-integration.test.js
git commit -m "feat(factory): wire verify-review classifier into executeVerifyStage"
```

---

## Task 10: Factory-tick baseline probe phase

**Files:**
- Modify: `server/factory/factory-tick.js` (insert probe phase after `reconcileOrphanWorktrees`)
- Create: `server/tests/factory-baseline-probe-integration.test.js`

**Context:** The probe phase runs at the start of each `tickProject` call for projects whose `config_json.baseline_broken_since` is set. Exponential backoff: gap between probe N and probe N+1 is `min(2^(N-1), 12)` ticks. Tracked in `config_json.baseline_broken_probe_attempts` (seeded to 0 at pause time by the Task 9 code). The runner is the same test-runner-registry used elsewhere (remote-first, local fallback).

- [ ] **Step 1: Write the failing test**

Create `server/tests/factory-baseline-probe-integration.test.js`:

```js
'use strict';

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

function seedPausedBaselineProject(db, { probeAttempts = 0, tickCountSincePause = 1 } = {}) {
  const cfg = {
    loop: { auto_continue: true },
    baseline_broken_since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    baseline_broken_reason: 'verify_failed_baseline_unrelated',
    baseline_broken_evidence: { failing_tests: ['tests/foo.py'], exit_code: 1 },
    baseline_broken_probe_attempts: probeAttempts,
    baseline_broken_tick_count: tickCountSincePause,
  };
  const projectId = 'proj-probe-e2e';
  db.prepare(
    `INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
     VALUES (?, 'ProbeTest', '/tmp/probe', 'dark', 'paused', ?, datetime('now'), datetime('now'))`
  ).run(projectId, JSON.stringify(cfg));
  return projectId;
}

describe('factory-tick baseline probe phase', () => {
  let db;
  beforeEach(() => { ({ db } = setupTestDb('baseline-probe-tick')); });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  it('probes paused project on first tick; clears flag + resumes on green probe', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');
    const eventBus = require('../event-bus');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });

    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: true, exitCode: 0, output: 'all green', durationMs: 5000, error: null,
    });
    const eventSpy = vi.fn();
    eventBus.onFactoryProjectBaselineCleared(eventSpy);

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('running');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeNull();
    expect(cfg.baseline_broken_reason).toBeNull();
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  it('probes paused project; stays paused on red probe and increments attempts', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });

    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAILED tests/foo.py', durationMs: 5000, error: null,
    });

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
    expect(cfg.baseline_broken_probe_attempts).toBe(1);
  });

  it('skips probing when tick count has not reached the next backoff slot', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 1, tickCountSincePause: 2 });

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline');

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await factoryTick.tickProject(project);

    expect(probeSpy).not.toHaveBeenCalled();

    const updated = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_tick_count).toBe(3);
  });

  it('probes at backoff slots with gaps 1, 2, 4, 8, 12, 12, 12', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const probeSpy = vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAIL', durationMs: 1, error: null,
    });

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 0 });
    const expectedGaps = [1, 2, 4, 8, 12, 12, 12];

    for (let i = 0; i < expectedGaps.length; i += 1) {
      const row = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
      const cfg = JSON.parse(row.config_json);
      cfg.baseline_broken_tick_count = (cfg.baseline_broken_tick_count || 0) + expectedGaps[i];
      db.prepare('UPDATE factory_projects SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), projectId);

      const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
      await factoryTick.tickProject(project);
    }

    expect(probeSpy).toHaveBeenCalledTimes(expectedGaps.length);
  });

  it('probe errors (thrown) do not clear the flag and do not crash the tick', async () => {
    const factoryTick = require('../factory/factory-tick');
    const baselineProbe = require('../factory/baseline-probe');

    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0, tickCountSincePause: 1 });
    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockRejectedValue(new Error('remote down'));

    const project = db.prepare('SELECT * FROM factory_projects WHERE id = ?').get(projectId);
    await expect(factoryTick.tickProject(project)).resolves.toBeUndefined();

    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/factory-baseline-probe-integration.test.js`
Expected: FAIL on all 5 tests — probe phase doesn't exist yet.

- [ ] **Step 3: Add the probe phase**

In `server/factory/factory-tick.js`, inside `tickProject(project)`, right after `const freshProject = factoryHealth.getProject(project.id);` and before the existing paused-status auto_continue branch, insert:

```js
    if (freshProject && freshProject.status === 'paused') {
      const cfg = getProjectConfig(freshProject);
      if (cfg.baseline_broken_since) {
        const prevTickCount = Number.isFinite(cfg.baseline_broken_tick_count) ? cfg.baseline_broken_tick_count : 0;
        const nextTickCount = prevTickCount + 1;
        const attempts = Number.isFinite(cfg.baseline_broken_probe_attempts) ? cfg.baseline_broken_probe_attempts : 0;
        let targetTick = 0;
        for (let i = 0; i <= attempts; i += 1) {
          targetTick += i === 0 ? 1 : Math.min(Math.pow(2, i - 1), 12);
        }
        const shouldProbe = nextTickCount >= targetTick;

        if (shouldProbe) {
          const baselineProbe = require('./baseline-probe');
          const factoryDefaults = require('../db/factory-defaults');
          const verifyCommand = factoryDefaults.getProjectDefault(project.id, 'verify_command')
            || cfg.verify_command
            || null;
          const runnerRegistry = require('../test-runner-registry').createTestRunnerRegistry();
          const runner = ({ command, cwd, timeoutMs }) =>
            runnerRegistry.runVerifyCommand(command, cwd, { timeout: timeoutMs });

          let probe;
          try {
            probe = await baselineProbe.probeProjectBaseline({
              project: freshProject,
              verifyCommand,
              runner,
              timeoutMs: 5 * 60 * 1000,
            });
          } catch (err) {
            probe = { passed: false, error: 'runner_threw', exitCode: null, output: err.message, durationMs: 0 };
          }

          if (probe.passed) {
            const pausedSince = Date.parse(cfg.baseline_broken_since) || Date.now();
            cfg.baseline_broken_since = null;
            cfg.baseline_broken_reason = null;
            cfg.baseline_broken_evidence = null;
            cfg.baseline_broken_probe_attempts = 0;
            cfg.baseline_broken_tick_count = 0;
            factoryHealth.updateProject(project.id, {
              status: 'running',
              config_json: JSON.stringify(cfg),
            });
            try {
              eventBus.emitFactoryProjectBaselineCleared({
                project_id: project.id,
                cleared_after_ms: Date.now() - pausedSince,
              });
            } catch (_e) { void _e; }
          } else {
            cfg.baseline_broken_probe_attempts = attempts + 1;
            cfg.baseline_broken_tick_count = nextTickCount;
            factoryHealth.updateProject(project.id, { config_json: JSON.stringify(cfg) });
          }
        } else {
          cfg.baseline_broken_tick_count = nextTickCount;
          factoryHealth.updateProject(project.id, { config_json: JSON.stringify(cfg) });
        }
        return;
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/factory-baseline-probe-integration.test.js`
Expected: PASS on all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/factory/factory-tick.js server/tests/factory-baseline-probe-integration.test.js
git commit -m "feat(factory): factory-tick baseline probe phase with exponential backoff"
```

---

## Task 11: resume_project_baseline_fixed MCP tool + REST endpoint

**Files:**
- Modify: `server/handlers/factory-handlers.js` (add `handleResumeProjectBaselineFixed`)
- Modify: `server/api/routes/factory-routes.js` (register POST route)
- Modify: `server/tool-defs/factory-defs.js` (or the file that houses `set_factory_trust_level` — grep to confirm path)
- Modify: `server/tests/factory-baseline-probe-integration.test.js` (add REST/tool tests)

- [ ] **Step 1: Locate the correct tool-defs file**

Run: `cd server && grep -rn "set_factory_trust_level" tool-defs/ | head -3`
Expected: Output shows the file path where factory MCP tools are defined. Use that file for the tool definition in Step 6.

- [ ] **Step 2: Append the failing tests**

Append to `server/tests/factory-baseline-probe-integration.test.js`:

```js
describe('handleResumeProjectBaselineFixed', () => {
  let db;
  beforeEach(() => { ({ db } = setupTestDb('baseline-resume')); });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  it('returns error when project is not baseline-flagged', async () => {
    const projectId = 'proj-not-flagged';
    db.prepare(
      `INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
       VALUES (?, 'T', '/tmp/t', 'dark', 'running', '{}', datetime('now'), datetime('now'))`
    ).run(projectId);
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not flagged');
  });

  it('returns error when verify_command is missing', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const factoryDefaults = require('../db/factory-defaults');
    vi.spyOn(factoryDefaults, 'getProjectDefault').mockReturnValue(null);
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('verify_command');
  });

  it('clears flag and resumes when probe passes', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const factoryDefaults = require('../db/factory-defaults');
    vi.spyOn(factoryDefaults, 'getProjectDefault').mockReturnValue('npm test');
    const baselineProbe = require('../factory/baseline-probe');
    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: true, exitCode: 0, output: 'all green', durationMs: 4321, error: null,
    });
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('resumed');
    const updated = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('running');
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.baseline_broken_since).toBeNull();
  });

  it('returns error + preserves flag when probe still fails', async () => {
    const projectId = seedPausedBaselineProject(db, { probeAttempts: 0 });
    const factoryDefaults = require('../db/factory-defaults');
    vi.spyOn(factoryDefaults, 'getProjectDefault').mockReturnValue('npm test');
    const baselineProbe = require('../factory/baseline-probe');
    vi.spyOn(baselineProbe, 'probeProjectBaseline').mockResolvedValue({
      passed: false, exitCode: 1, output: 'FAILED tests/foo.py', durationMs: 100, error: null,
    });
    const { handleResumeProjectBaselineFixed } = require('../handlers/factory-handlers');
    const r = await handleResumeProjectBaselineFixed({ project: projectId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('baseline still');
    expect(r.content[0].text).toContain('FAILED tests/foo.py');
    const updated = db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(projectId);
    expect(updated.status).toBe('paused');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/factory-baseline-probe-integration.test.js`
Expected: FAIL on the 4 new tests — handler doesn't exist.

- [ ] **Step 4: Add the handler**

In `server/handlers/factory-handlers.js`, append:

```js
async function handleResumeProjectBaselineFixed({ project }) {
  const { ErrorCodes, makeError } = require('./error-codes');
  try {
    const factoryHealth = require('../db/factory-health');
    const factoryDefaults = require('../db/factory-defaults');
    const baselineProbe = require('../factory/baseline-probe');
    const eventBus = require('../event-bus');

    const projectRow = factoryHealth.getProject(project) || factoryHealth.getProjectByPath(project);
    if (!projectRow) return makeError(ErrorCodes.NOT_FOUND, `Project not found: ${project}`);

    const cfg = projectRow.config_json ? JSON.parse(projectRow.config_json) : {};
    if (!cfg.baseline_broken_since) {
      return makeError(ErrorCodes.INVALID_ARGS, `Project "${projectRow.name}" is not flagged baseline_broken; nothing to resume.`);
    }

    const verifyCommand = factoryDefaults.getProjectDefault(projectRow.id, 'verify_command') || cfg.verify_command;
    if (!verifyCommand) {
      return makeError(ErrorCodes.INVALID_ARGS, `Project "${projectRow.name}" has no verify_command configured; cannot probe. Set one via set_project_defaults and try again.`);
    }

    const runnerRegistry = require('../test-runner-registry').createTestRunnerRegistry();
    const runner = ({ command, cwd, timeoutMs }) => runnerRegistry.runVerifyCommand(command, cwd, { timeout: timeoutMs });

    const probe = await baselineProbe.probeProjectBaseline({
      project: projectRow,
      verifyCommand,
      runner,
      timeoutMs: 5 * 60 * 1000,
    });

    if (!probe.passed) {
      const preview = (probe.output || '').slice(-1500);
      return makeError(
        ErrorCodes.CONFLICT,
        `Baseline still failing (exit ${probe.exitCode}). Fix the failing tests, then try again.\n\nProbe output (last 1500 chars):\n${preview}`,
      );
    }

    cfg.baseline_broken_since = null;
    cfg.baseline_broken_reason = null;
    cfg.baseline_broken_evidence = null;
    cfg.baseline_broken_probe_attempts = 0;
    cfg.baseline_broken_tick_count = 0;
    factoryHealth.updateProject(projectRow.id, {
      status: 'running',
      config_json: JSON.stringify(cfg),
    });
    try {
      eventBus.emitFactoryProjectBaselineCleared({ project_id: projectRow.id, cleared_after_ms: probe.durationMs });
    } catch (_e) { void _e; }

    return {
      content: [{ type: 'text', text: `Project "${projectRow.name}" resumed — baseline probe passed in ${probe.durationMs}ms.` }],
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL, `Failed to resume project baseline: ${err.message}`);
  }
}
```

Also add `handleResumeProjectBaselineFixed` to the module.exports at the bottom of `factory-handlers.js`.

- [ ] **Step 5: Register the REST route**

In `server/api/routes/factory-routes.js`, add a POST route entry near the existing `/loop/reset` / `/trust` routes:

```js
  { method: 'POST', path: /^\/api\/v2\/factory\/projects\/([^/]+)\/baseline-resume$/, tool: 'resume_project_baseline_fixed', mapParams: ['project'] },
```

- [ ] **Step 6: Register the MCP tool**

In the tool-defs file identified in Step 1, add the tool definition:

```js
{
  name: 'resume_project_baseline_fixed',
  description: 'Resume a factory project that was paused by verify-review due to a broken baseline. Runs the project\'s verify_command on a clean checkout of main as a probe; only resumes if the probe passes. Use after fixing pre-existing broken tests that caused the baseline pause.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project ID or path' },
    },
    required: ['project'],
  },
},
```

Also wire it into the tool dispatch table that maps tool names to handler functions (grep for `'set_factory_trust_level'` to find the dispatch file and add an entry for `'resume_project_baseline_fixed': handleResumeProjectBaselineFixed`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/factory-baseline-probe-integration.test.js`
Expected: PASS on all 9 tests (5 probe-phase + 4 resume-tool).

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `cd server && npx vitest run`
Expected: 0 failures. If any existing test asserts exhaustive tool lists or exhaustive route domains, update the expected list to include `resume_project_baseline_fixed` and `/baseline-resume`. Grep for `EXPECTED_DOMAINS` and `CORE_TOOL_NAMES` + `EXTENDED_TOOL_NAMES` in `server/tests/` — these are the alignment guards that often flake when a new tool lands.

- [ ] **Step 9: Commit**

```bash
git add server/handlers/factory-handlers.js server/api/routes/factory-routes.js server/tool-defs/ server/tests/factory-baseline-probe-integration.test.js
git commit -m "feat(factory): resume_project_baseline_fixed MCP tool + REST endpoint"
```

---

## Self-Review Checklist (for the implementer)

After completing all tasks:

1. **Spec coverage check**
   - [ ] Classifier has 4 branches: environment_failure, task_caused, baseline_broken, ambiguous (Tasks 2, 3, 4, 6)
   - [ ] LLM tiebreak runs only on baseline_candidate + ambiguous (Task 6)
   - [ ] Fail-open on classifier exception (Task 9, Scenario 6)
   - [ ] Baseline_broken pauses the whole project and rejects the item (Task 9, Scenario 2)
   - [ ] Environment_failure takes the same pause path with a different reject_reason (Task 9 handler covers both branches)
   - [ ] Event-bus emitters + on* helpers for all 3 new events (Task 8)
   - [ ] Factory-tick probe phase with exponential backoff (Task 10)
   - [ ] MCP tool + REST endpoint for operator-triggered resume (Task 11)
   - [ ] `baseline_broken_since` + evidence persist in `config_json`, no DB migration (Task 9, Task 10)
   - [ ] Worktree is NOT abandoned on baseline_broken rejection (Task 9 handler — verify by reading)
   - [ ] Test runner parsers cover pytest, vitest, dotnet test (Task 3)

2. **Placeholder scan**
   - [ ] No "TBD" / "TODO" in production code
   - [ ] All test code blocks are complete and runnable
   - [ ] No "add appropriate error handling" without concrete code
   - [ ] Task 11 Step 1 identified the correct tool-defs file; the path in Step 9's commit command is updated to match

3. **Type/signature consistency**
   - [ ] `reviewVerifyFailure` return shape matches across Task 1 stub, Task 6 implementation, and Task 9 call site
   - [ ] `runLlmTiebreak` signature (`{ failingTests, modifiedFiles, workItem, project, timeoutMs }`) matches Task 5 → Task 6
   - [ ] `probeProjectBaseline` signature (`{ project, verifyCommand, runner, timeoutMs }`) matches Task 7 → Task 10 → Task 11
   - [ ] `reject_reason` string `verify_failed_baseline_unrelated` matches across Task 6 (suggestedRejectReason) and Task 9 (handler writes)
   - [ ] `reject_reason` string `verify_failed_environment` matches between Task 6 and Task 9
   - [ ] Event payload field names (`project_id`, `failing_tests`, `evidence`, `cleared_after_ms`) match between Task 8 tests and Task 9/Task 10 emitters

4. **Lint coverage (from yesterday's rules):**
   - [ ] No hardcoded provider names in `verify-review.js` — LLM tiebreak uses `submitFactoryInternalTask` with `kind: 'plan_generation'`
   - [ ] No `spawnSync` anywhere — `getModifiedFiles` uses `spawn` with event-driven completion
   - [ ] Baseline probe runs async via the test-runner-registry, no spawnSync
