# CI Failure Detection Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the CI monitoring pipeline so TORQUE automatically detects GitHub Actions failures, diagnoses them into structured categories, and pushes lean notifications to all connected Claude sessions.

**Architecture:** Three changes layered bottom-up: (1) fix the GitHub Actions provider to preserve the `conclusion` field, then implement `watchRun()` polling on the provider base class; (2) enhance the diagnostics module with sub-category extraction (schema, logic, platform); (3) wire the enhanced diagnosis into the notification payload and the `diagnose_ci_failure` pull response.

**Tech Stack:** Node.js, better-sqlite3, vitest, `gh` CLI for GitHub Actions API

**Spec:** `docs/superpowers/specs/2026-03-24-ci-failure-detection-design.md`

---

### Task 1: Fix `_normalizeRun` to preserve `conclusion` (CRITICAL-1)

**Files:**
- Modify: `server/ci/github-actions.js:172-183`
- Test: `server/tests/ci-github-actions-repo.test.js`

- [ ] **Step 1: Write the failing test**

```js
// In ci-github-actions-repo.test.js — add to existing describe block
it('_normalizeRun preserves conclusion alongside normalized status', () => {
  const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/repo' });
  const raw = {
    databaseId: '123',
    status: 'completed',
    conclusion: 'timed_out',
    headBranch: 'main',
    headSha: 'abc',
    url: 'https://github.com',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const normalized = provider._normalizeRun(raw);
  expect(normalized.status).toBe('failure'); // normalizeRunStatus maps timed_out → failure
  expect(normalized.conclusion).toBe('timed_out'); // raw conclusion preserved
});

it('_normalizeRun sets conclusion to success for successful runs', () => {
  const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/repo' });
  const raw = {
    databaseId: '456',
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    headSha: 'def',
    url: 'https://github.com',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const normalized = provider._normalizeRun(raw);
  expect(normalized.status).toBe('success');
  expect(normalized.conclusion).toBe('success');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ci-github-actions-repo.test.js -t "preserves conclusion"`
Expected: FAIL — `normalized.conclusion` is `undefined`

- [ ] **Step 3: Implement the fix**

In `server/ci/github-actions.js`, modify `_normalizeRun()` at line 172:

```js
_normalizeRun(rawRun) {
  return {
    id: String(rawRun.databaseId || rawRun.id),
    status: this._normalizeRunStatus(rawRun.status, rawRun.conclusion),
    conclusion: typeof rawRun.conclusion === 'string' ? rawRun.conclusion.toLowerCase() : null,
    repository: rawRun.repository || this.repo,
    branch: rawRun.headBranch,
    sha: rawRun.headSha,
    url: rawRun.url,
    createdAt: rawRun.createdAt,
    updatedAt: rawRun.updatedAt,
    raw: typeof rawRun.raw === 'string' ? rawRun.raw : JSON.stringify(rawRun.raw || rawRun),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ci-github-actions-repo.test.js -t "preserves conclusion"`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add server/ci/github-actions.js server/tests/ci-github-actions-repo.test.js
git commit -m "fix(ci): preserve conclusion field in _normalizeRun"
```

---

### Task 2: Implement `watchRun()` on `CIProvider` base class

**Files:**
- Modify: `server/ci/provider.js:60-62`
- Test: `server/tests/ci-provider.test.js`

- [ ] **Step 1: Write the failing test**

```js
// In ci-provider.test.js — add to existing describe block
describe('watchRun', () => {
  it('polls getRun until status is completed and returns the run', async () => {
    vi.useFakeTimers();
    const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
    let callCount = 0;
    provider.getRun = vi.fn(async () => {
      callCount++;
      if (callCount < 3) return { id: 'run-1', status: 'running', conclusion: null };
      return { id: 'run-1', status: 'success', conclusion: 'success' };
    });

    const promise = provider.watchRun('run-1', { pollIntervalMs: 1000 });

    // Advance through 2 polling cycles
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(provider.getRun).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('returns immediately when run is already completed', async () => {
    const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
    provider.getRun = vi.fn(async () => ({ id: 'run-1', status: 'failure', conclusion: 'failure' }));

    const result = await provider.watchRun('run-1');
    expect(result.status).toBe('failure');
    expect(provider.getRun).toHaveBeenCalledTimes(1);
  });

  it('rejects after timeout', async () => {
    vi.useFakeTimers();
    const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
    provider.getRun = vi.fn(async () => ({ id: 'run-1', status: 'running', conclusion: null }));

    const promise = provider.watchRun('run-1', { pollIntervalMs: 1000, timeoutMs: 2500 });

    await vi.advanceTimersByTimeAsync(3000);

    await expect(promise).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ci-provider.test.js -t "watchRun"`
Expected: FAIL — `watchRun() not implemented`

- [ ] **Step 3: Implement `watchRun` on the base class**

Replace the stub in `server/ci/provider.js` at line 60:

```js
async watchRun(runId, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || 15000;
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
  const startTime = Date.now();
  const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled', 'timed_out']);

  while (true) {
    const run = await this.getRun(runId);
    if (run && TERMINAL_STATUSES.has(run.status)) {
      return run;
    }
    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`watchRun timed out after ${Math.round(timeoutMs / 1000)}s waiting for run ${runId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ci-provider.test.js -t "watchRun"`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add server/ci/provider.js server/tests/ci-provider.test.js
git commit -m "feat(ci): implement watchRun polling on CIProvider base class"
```

---

### Task 3: Implement `awaitRun` on watcher + fix handler timeout conversion

**Files:**
- Modify: `server/ci/watcher.js` (add `awaitRun` export)
- Modify: `server/handlers/ci-handlers.js:134-191` (fix `handleAwaitCiRun`)
- Test: `server/tests/ci-watcher.test.js`
- Test: `server/tests/ci-handlers.test.js`

- [ ] **Step 1: Write the failing test for `awaitRun`**

```js
// In ci-watcher.test.js — add to existing describe block
describe('awaitRun', () => {
  it('delegates to provider.watchRun and returns the result', async () => {
    const mockProvider = {
      name: 'mock',
      watchRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'failure', conclusion: 'failure' }),
      listRuns: vi.fn(),
      getFailureLogs: vi.fn(),
    };

    const { awaitRun } = require('../ci/watcher');
    const result = await awaitRun({
      repo: 'org/repo',
      provider: mockProvider,
      runId: 'run-1',
      pollIntervalMs: 1000,
      timeoutMs: 5000,
    });

    expect(result.status).toBe('failure');
    expect(mockProvider.watchRun).toHaveBeenCalledWith('run-1', { pollIntervalMs: 1000, timeoutMs: 5000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ci-watcher.test.js -t "awaitRun"`
Expected: FAIL — `awaitRun is not a function` or `awaitRun is not exported`

- [ ] **Step 3: Implement `awaitRun` in watcher.js**

Add to `server/ci/watcher.js` before the `module.exports`:

```js
async function awaitRun({ repo, provider, runId, pollIntervalMs, timeoutMs }) {
  if (!runId) throw new Error('awaitRun requires a runId');
  if (!provider) throw new Error('awaitRun requires a provider');

  const { providerInstance } = _resolveProvider(provider, repo);
  return providerInstance.watchRun(runId, {
    pollIntervalMs: pollIntervalMs || 15000,
    timeoutMs: timeoutMs || 30 * 60 * 1000,
  });
}
```

Export `awaitRun` in `module.exports`.

- [ ] **Step 4: Fix `handleAwaitCiRun` timeout conversion**

In `server/handlers/ci-handlers.js` at `handleAwaitCiRun` (~line 134), fix the timeout conversion and wire unused params:

```js
async function handleAwaitCiRun(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) return repoResult.error;
    const runIdResult = parseRunId(args);
    if (runIdResult.error) return runIdResult.error;

    if (typeof watcher.awaitRun !== 'function') {
      return makeError(ErrorCodes.OPERATION_FAILED, 'CI await is not available in this build');
    }

    const timeoutMinutes = args.timeout_minutes ?? 30;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const shouldDiagnose = args.diagnose !== false; // default true

    const provider = createProvider(args, repoResult.repo);
    const run = await watcher.awaitRun({
      repo: repoResult.repo,
      provider: parseProvider(args),
      runId: runIdResult.runId,
      pollIntervalMs: parsePollInterval(args),
      timeoutMs,
    });

    if (!run || typeof run !== 'object') {
      return makeError(ErrorCodes.PROVIDER_ERROR, 'Awaited run was missing');
    }

    if (run.conclusion === 'timed_out') {
      return makeError(ErrorCodes.TIMEOUT, `CI run ${runIdResult.runId} timed out`);
    }

    if (run.status === 'failure' || run.conclusion === 'failure') {
      if (!shouldDiagnose) {
        return { content: [{ type: 'text', text: `## CI Run Failed\n\n${formatRunMarkdown(run)}` }] };
      }
      const logs = await provider.getFailureLogs(String(run.id || runIdResult.runId));
      const diagnosis = diagnostics.diagnoseFailures(logs, {
        conclusion: run.conclusion || run.status || 'failure',
        runId: String(run.id || runIdResult.runId),
      });
      return {
        content: [{ type: 'text', text: diagnosis.triage || `No actionable CI failures found for run ${runIdResult.runId}.` }],
      };
    }

    return {
      content: [{ type: 'text', text: `## CI Run Completed\n\n${formatRunMarkdown(run)}` }],
    };
  } catch (err) {
    const message = err.message || String(err);
    if (message.toLowerCase().includes('timed out') || message.toLowerCase().includes('timeout')) {
      return makeError(ErrorCodes.TIMEOUT, message);
    }
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to await CI run: ${message}`);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/ci-watcher.test.js tests/ci-handlers.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add server/ci/watcher.js server/handlers/ci-handlers.js server/tests/ci-watcher.test.js server/tests/ci-handlers.test.js
git commit -m "feat(ci): implement awaitRun + fix handler timeout conversion"
```

---

### Task 4: Add sub-category extraction to diagnostics

**Files:**
- Modify: `server/ci/diagnostics.js`
- Test: `server/tests/ci-diagnostics.test.js`

- [ ] **Step 1: Write failing tests for new categories**

```js
// In ci-diagnostics.test.js — add these tests

it('categorizes SqliteError as test_schema', () => {
  const log = 'FAIL tests/host-credentials.test.js > saves credential\nSqliteError: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint';
  const result = diagnoseFailures(log, {});
  expect(result.failures.length).toBeGreaterThanOrEqual(1);
  const schemaFailure = result.failures.find(f => f.category === 'test_schema');
  expect(schemaFailure).toBeTruthy();
  expect(schemaFailure.message).toContain('ON CONFLICT');
});

it('categorizes "no column named" as test_schema', () => {
  const log = 'FAIL tests/close-handler.test.js > rollback\nSqliteError: table task_file_changes has no column named stash_ref';
  const result = diagnoseFailures(log, {});
  const schemaFailure = result.failures.find(f => f.category === 'test_schema');
  expect(schemaFailure).toBeTruthy();
});

it('categorizes spawn EPERM as test_platform', () => {
  const log = 'FAIL tests/bootstrap.test.js > startup\nError: spawn EPERM';
  const result = diagnoseFailures(log, {});
  const platformFailure = result.failures.find(f => f.category === 'test_platform');
  expect(platformFailure).toBeTruthy();
});

it('categorizes AssertionError as test_logic', () => {
  const log = "FAIL tests/handler.test.js > returns expected\nAssertionError: expected 'completed' to be 'failed'";
  const result = diagnoseFailures(log, {});
  const logicFailure = result.failures.find(f => f.category === 'test_logic');
  expect(logicFailure).toBeTruthy();
});

it('maps old infrastructure category to infra', () => {
  const log = '##[error] Runner received shutdown signal';
  const result = diagnoseFailures(log, {});
  expect(result.failures[0].category).toBe('infra');
});

it('maps old timeout category to infra', () => {
  const result = diagnoseFailures('some log', { conclusion: 'timed_out' });
  expect(result.failures[0].category).toBe('infra');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ci-diagnostics.test.js -t "categorizes|maps old"`
Expected: FAIL — categories don't match

- [ ] **Step 3: Implement sub-category detection**

In `server/ci/diagnostics.js`:

**3a.** Add schema and platform extraction functions after `extractInfrastructureFailure`:

```js
const SCHEMA_PATTERNS = [
  /SqliteError/i,
  /no column named/i,
  /FOREIGN KEY constraint/i,
  /NOT NULL constraint failed/i,
  /ON CONFLICT clause/i,
  /no such table/i,
];

function isSchemaError(line) {
  return SCHEMA_PATTERNS.some(p => p.test(line));
}

const PLATFORM_PATTERNS = [
  /spawn EPERM/i,
  /spawn ENOENT/i,
  /ESOCKETTIMEDOUT/i,
  /timeout of \d+ms exceeded/i,
  /process activity/i,
];

function isPlatformError(line) {
  return PLATFORM_PATTERNS.some(p => p.test(line));
}
```

**3b.** Update `extractTestFailure` to sub-categorize. After extracting the test failure, check the detail line:

```js
// Inside extractTestFailure, after building the failure object:
let subCategory = 'test_logic'; // default
if (isSchemaError(detailLine)) subCategory = 'test_schema';
else if (isPlatformError(detailLine)) subCategory = 'test_platform';

failures.push(buildFailure({
  category: subCategory,
  // ... rest unchanged
}));
```

**3c.** Rename old categories for backward compat:

```js
// In categorizeError, change returns:
// 'infrastructure' → 'infra'
// 'timeout' → 'infra'
```

And in `extractInfrastructureFailure`, change `category: 'infrastructure'` to `category: 'infra'`.

**3d.** Update `generateFixSuggestion` to handle new categories:

```js
if (category === 'test_schema') {
  return `Fix schema mismatch${file}: add missing column/table to test DB bootstrap.`;
}
if (category === 'test_logic') {
  return `Re-run the failing test${file}${testName} and review the assertion${line}.`;
}
if (category === 'test_platform') {
  return `Environment-specific failure${file} — check platform compatibility or add CI-resilient assertions.`;
}
if (category === 'infra') {
  return 'CI infrastructure issue — inspect runner health or rerun the workflow.';
}
```

- [ ] **Step 4: Run all diagnostics tests**

Run: `npx vitest run tests/ci-diagnostics.test.js`
Expected: PASS (update any existing tests that asserted old category names)

- [ ] **Step 5: Commit**

```
git add server/ci/diagnostics.js server/tests/ci-diagnostics.test.js
git commit -m "feat(ci): add test_schema/test_logic/test_platform sub-categories to diagnostics"
```

---

### Task 5: Enhance `diagnoseFailures` return shape with categories + suggested actions

**Files:**
- Modify: `server/ci/diagnostics.js`
- Test: `server/tests/ci-diagnostics.test.js`

- [ ] **Step 1: Write failing test for new return shape**

```js
it('returns structured categories with counts and suggested_actions', () => {
  const log = [
    'FAIL tests/host.test.js > saves credential',
    'SqliteError: ON CONFLICT clause does not match',
    'FAIL tests/handler.test.js > returns expected',
    "AssertionError: expected 'completed' to be 'failed'",
    '  5:7  error  Unexpected var  no-var',
  ].join('\n');

  const result = diagnoseFailures(log, {});

  expect(result.categories).toBeDefined();
  expect(result.categories.test_schema.count).toBe(1);
  expect(result.categories.test_logic.count).toBe(1);
  expect(result.categories.lint.count).toBe(1);
  expect(result.total_failures).toBe(3);
  expect(result.triage_summary).toContain('schema');
  expect(result.suggested_actions).toBeInstanceOf(Array);
  expect(result.suggested_actions.length).toBeGreaterThan(0);
  // backward compat: triage markdown still present
  expect(result.triage).toContain('CI Failure Triage');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ci-diagnostics.test.js -t "structured categories"`
Expected: FAIL — `result.categories` is undefined

- [ ] **Step 3: Implement enhanced return shape**

At the end of `diagnoseFailures()`, after building `categorizedFailures` and `triage`, add:

```js
// Build category groupings
const CATEGORY_NAMES = ['lint', 'test_schema', 'test_logic', 'test_platform', 'build', 'infra', 'unknown'];
const categories = {};
for (const cat of CATEGORY_NAMES) {
  const matching = categorizedFailures.filter(f => f.category === cat);
  categories[cat] = { count: matching.length, failures: matching };
}

// Build triage summary (one-liner)
const nonZero = CATEGORY_NAMES.filter(c => categories[c].count > 0);
const triageSummary = nonZero.length
  ? `${categorizedFailures.length} failures: ${nonZero.map(c => `${categories[c].count} ${c.replace('test_', '')}`).join(', ')}`
  : 'No failures detected';

// Build suggested actions (one per category that has failures)
const ACTION_MAP = {
  lint: { action: 'auto-fixable', description: 'Run eslint --fix or submit to codex' },
  test_schema: { action: 'schema-sync', description: 'Update test DB bootstrap with missing columns' },
  test_logic: { action: 'manual-review', description: 'Test expectations don\'t match current behavior' },
  test_platform: { action: 'platform-fix', description: 'Add CI-resilient assertions or skip on affected platform' },
  build: { action: 'build-fix', description: 'Fix compilation errors and rebuild' },
  infra: { action: 'rerun', description: 'CI infrastructure issue — rerun or check runner health' },
};
const suggestedActions = nonZero
  .filter(c => ACTION_MAP[c])
  .map(c => ({ category: c, ...ACTION_MAP[c] }));

return {
  failures: categorizedFailures,
  categories,
  total_failures: categorizedFailures.length,
  triage_summary: triageSummary,
  triage,
  suggested_actions: suggestedActions,
};
```

- [ ] **Step 4: Run all diagnostics tests**

Run: `npx vitest run tests/ci-diagnostics.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add server/ci/diagnostics.js server/tests/ci-diagnostics.test.js
git commit -m "feat(ci): enhance diagnoseFailures with categories, summary, and suggested actions"
```

---

### Task 6: Enhance notification payload and `handleDiagnoseCiFailure` response

**Files:**
- Modify: `server/ci/watcher.js` (`_notifyFailure`)
- Modify: `server/handlers/ci-handlers.js` (`handleDiagnoseCiFailure`)
- Test: `server/tests/ci-watcher.test.js`
- Test: `server/tests/ci-handlers.test.js`

- [ ] **Step 1: Write failing test for enhanced notification payload**

```js
// In ci-watcher.test.js — modify existing "detects new completed runs" test
// or add a new test that checks the notification payload shape
it('notification payload includes category_counts and triage_summary', async () => {
  const provider = {
    name: 'mock',
    listRuns: vi.fn().mockResolvedValue([{
      id: 'run-2',
      status: 'failure',
      conclusion: 'failure',
      branch: 'main',
      repository: 'org/repo',
      sha: 'abc123',
      url: 'https://github.com/org/repo/actions/runs/2',
      created_at: new Date().toISOString(),
    }]),
    getFailureLogs: vi.fn().mockResolvedValue(
      "FAIL tests/foo.test.js > bar\nSqliteError: no column named xyz\n  5:7  error  unused var  no-unused-vars"
    ),
  };

  watchRepo({ repo: 'org/repo', provider, poll_interval_ms: 1000 });
  await vi.advanceTimersByTimeAsync(1000);

  expect(mcpSse.pushNotification).toHaveBeenCalled();
  const call = mcpSse.pushNotification.mock.calls[0][0];
  expect(call.type).toBe('ci:run:failed');
  expect(call.data.commit_sha).toBe('abc123');
  expect(call.data.conclusion).toBe('failure');
  expect(call.data.category_counts).toBeDefined();
  expect(call.data.triage_summary).toBeDefined();
  expect(call.data.total_failures).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ci-watcher.test.js -t "category_counts"`
Expected: FAIL — payload doesn't include `category_counts`

- [ ] **Step 3: Update `_notifyFailure` in watcher.js**

Modify `_notifyFailure` to accept and include the diagnosis:

```js
async function _notifyFailure({ run, watch, _provider, failures, triage, diagnosis }) {
  const categoryCounts = {};
  if (diagnosis && diagnosis.categories) {
    for (const [cat, data] of Object.entries(diagnosis.categories)) {
      if (data.count > 0) categoryCounts[cat] = data.count;
    }
  }

  const payload = {
    type: 'ci:run:failed',
    data: {
      run_id: String(run.id),
      repo: run.repository || watch.repo,
      branch: run.branch || watch.branch || null,
      commit_sha: run.sha || null,
      conclusion: run.conclusion || _getConclusion(run),
      url: run.url || null,
      category_counts: categoryCounts,
      total_failures: diagnosis ? diagnosis.total_failures : (Array.isArray(failures) ? failures.length : 0),
      triage_summary: diagnosis ? diagnosis.triage_summary : '',
    },
  };

  const mcpSse = getMcpSse();
  if (typeof mcpSse.pushNotification === 'function') {
    const result = mcpSse.pushNotification(payload);
    if (result && typeof result.then === 'function') await result;
  }
}
```

Update the call site in `_pollWatch` to pass the diagnosis object.

- [ ] **Step 4: Update `handleDiagnoseCiFailure` to return structured data**

In `server/handlers/ci-handlers.js`, modify `handleDiagnoseCiFailure` (~line 286):

```js
async function handleDiagnoseCiFailure(args) {
  try {
    const repoResult = requireRepo(args);
    if (repoResult.error) return repoResult.error;
    const runIdResult = parseRunId(args);
    if (runIdResult.error) return runIdResult.error;

    const provider = createProvider(args, repoResult.repo);
    const log = await provider.getFailureLogs(runIdResult.runId);
    const report = diagnostics.diagnoseFailures(log, { runId: runIdResult.runId });

    const content = [
      { type: 'text', text: report.triage || `No actionable CI failures found for run ${runIdResult.runId}.` },
    ];

    if (report.categories) {
      content.push({
        type: 'text',
        text: JSON.stringify({
          categories: report.categories,
          total_failures: report.total_failures,
          suggested_actions: report.suggested_actions,
        }),
      });
    }

    return { content };
  } catch (err) {
    return makeError(ErrorCodes.PROVIDER_ERROR, `Failed to diagnose CI failure: ${err.message || err}`);
  }
}
```

- [ ] **Step 5: Run all CI tests**

Run: `npx vitest run tests/ci-watcher.test.js tests/ci-handlers.test.js tests/ci-diagnostics.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add server/ci/watcher.js server/handlers/ci-handlers.js server/tests/ci-watcher.test.js server/tests/ci-handlers.test.js
git commit -m "feat(ci): enhance notification payload with categories + structured diagnose response"
```

---

### Task 7: DI consolidation — move watcher DB ops to ci-cache.js

**Files:**
- Modify: `server/db/ci-cache.js`
- Modify: `server/ci/watcher.js`
- Test: `server/tests/ci-watcher.test.js` (existing tests should still pass)

- [ ] **Step 1: Check which DB functions in watcher.js aren't already in ci-cache.js**

Functions to migrate from watcher.js → ci-cache.js:
- `_getWatch` → already exists as `getCiWatch` in ci-cache.js
- `_upsertWatchRecord` → already exists as `upsertCiWatch` in ci-cache.js
- `_deactivateWatchRow` → add `deactivateCiWatch` to ci-cache.js
- `_hasRunBeenDiagnosed` → add `hasRunBeenDiagnosed` to ci-cache.js
- `_cacheRunDiagnostic` → already exists as `upsertCiRunCache` in ci-cache.js
- `_updateLastCheckedAt` → add `updateWatchLastCheckedAt` to ci-cache.js

- [ ] **Step 2: Add missing functions to ci-cache.js**

```js
function deactivateCiWatch(repo, provider) {
  const now = new Date().toISOString();
  const result = _db.prepare(`
    UPDATE ci_watches SET active = 0, updated_at = ? WHERE repo = ? AND provider = ?
  `).run(now, repo, normalizeProviderValue(provider));
  return result.changes > 0;
}

function hasRunBeenDiagnosed(runId, repo, provider) {
  const row = _db.prepare(`
    SELECT diagnosed_at FROM ci_run_cache WHERE run_id = ? AND repo = ? AND provider = ?
  `).get(String(runId), repo, normalizeProviderValue(provider));
  return Boolean(row && row.diagnosed_at);
}

function updateWatchLastCheckedAt(repo, provider) {
  const now = new Date().toISOString();
  _db.prepare(`
    UPDATE ci_watches SET last_checked_at = ?, updated_at = ? WHERE repo = ? AND provider = ?
  `).run(now, now, repo, normalizeProviderValue(provider));
}
```

Export all three.

- [ ] **Step 3: Update watcher.js to use ci-cache.js instead of direct DB access**

Replace `_getDb()` calls with imports from ci-cache:

```js
const ciCache = require('../db/ci-cache');
```

Then replace:
- `_getWatch(repo, provider)` → `ciCache.getCiWatch(repo, provider)`
- `_upsertWatchRecord(...)` → `ciCache.upsertCiWatch(...)`
- `_deactivateWatchRow(repo, provider)` → `ciCache.deactivateCiWatch(repo, provider)`
- `_hasRunBeenDiagnosed(...)` → `ciCache.hasRunBeenDiagnosed(...)`
- `_cacheRunDiagnostic(...)` → `ciCache.upsertCiRunCache(...)`
- `_updateLastCheckedAt(...)` → `ciCache.updateWatchLastCheckedAt(...)`

Remove `_getDb()` and the direct `database` import from watcher.js.

- [ ] **Step 4: Run all CI tests**

Run: `npx vitest run tests/ci-watcher.test.js tests/ci-handlers.test.js`
Expected: PASS — no behavior change, just cleaner DI

- [ ] **Step 5: Commit**

```
git add server/db/ci-cache.js server/ci/watcher.js
git commit -m "refactor(ci): consolidate watcher DB ops into ci-cache.js"
```

---

### Task 8: Update _testing exports + run full test suite

**Files:**
- Modify: `server/ci/diagnostics.js` (update `_testing` exports)
- All test files from tasks 1-7

- [ ] **Step 1: Update `_testing` exports**

In `server/ci/diagnostics.js`, update the `_testing` export block to include new functions:

```js
_testing: {
  categorizeError,
  extractTestFailure,
  extractLintFailure,
  extractBuildFailure,
  extractInfrastructureFailure,
  isSchemaError,
  isPlatformError,
},
```

- [ ] **Step 2: Run the full CI test suite**

Run: `npx vitest run tests/ci-*.test.js`
Expected: ALL PASS

- [ ] **Step 3: Run ESLint**

Run: `npx eslint ci/ handlers/ci-handlers.js db/ci-cache.js`
Expected: 0 errors

- [ ] **Step 4: Final commit**

```
git add -A
git commit -m "feat(ci): Phase 1 complete — CI failure detection pipeline"
```

---

## Verification Checklist

After all tasks are complete, verify the end-to-end flow:

1. Start TORQUE
2. Call `watch_ci_repo({ repo: 'torque-ai/torque-ai' })`
3. Push a commit that breaks lint or tests
4. Wait 30-60s for the poll cycle
5. Call `check_notifications` — should see `ci:run:failed` with `category_counts`
6. Call `diagnose_ci_failure({ run_id: '<from notification>' })` — should get structured categories + markdown triage
7. Alternatively: call `await_ci_run({ run_id: '<run-id>' })` and verify it blocks until completion, then returns diagnosis
