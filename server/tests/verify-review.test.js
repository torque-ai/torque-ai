'use strict';

describe('verify-review module exports', () => {
  it('exports reviewVerifyFailure, detectEnvironmentFailure, parseFailingTests, getModifiedFiles, runLlmTiebreak, and constants', () => {
    const mod = require('../factory/verify-review');
    expect(typeof mod.reviewVerifyFailure).toBe('function');
    expect(typeof mod.detectEnvironmentFailure).toBe('function');
    expect(typeof mod.normalizeVerifyOutput).toBe('function');
    expect(typeof mod.parseFailingTests).toBe('function');
    expect(typeof mod.getModifiedFiles).toBe('function');
    expect(typeof mod.runLlmTiebreak).toBe('function');
    expect(typeof mod.buildTiebreakPrompt).toBe('function');
    expect(typeof mod.extractVerifyExcerpt).toBe('function');
    expect(mod.LLM_TIMEOUT_MS).toBe(600_000);
    expect(mod.ENVIRONMENT_EXIT_CODES).toBeInstanceOf(Set);
    expect(Array.isArray(mod.ENVIRONMENT_STDERR_PATTERNS)).toBe(true);
  });

  it('honors TORQUE_VERIFY_REVIEWER_TIMEOUT_MS env override at module load', () => {
    const original = process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS;
    process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS = '900000';
    delete require.cache[require.resolve('../factory/verify-review')];
    try {
      const mod = require('../factory/verify-review');
      expect(mod.LLM_TIMEOUT_MS).toBe(900_000);
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS;
      else process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS = original;
      delete require.cache[require.resolve('../factory/verify-review')];
    }
  });

  it('ignores invalid TORQUE_VERIFY_REVIEWER_TIMEOUT_MS values and falls back to default', () => {
    const original = process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS;
    process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS = 'not-a-number';
    delete require.cache[require.resolve('../factory/verify-review')];
    try {
      const mod = require('../factory/verify-review');
      expect(mod.LLM_TIMEOUT_MS).toBe(600_000);
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS;
      else process.env.TORQUE_VERIFY_REVIEWER_TIMEOUT_MS = original;
      delete require.cache[require.resolve('../factory/verify-review')];
    }
  });
});

const depRegistryPath = require.resolve('../factory/dep-resolver/registry');
const pythonAdapterPath = require.resolve('../factory/dep-resolver/adapters/python');

describe('reviewVerifyFailure — missing_dep classification', () => {
  const savedCache = new Map();

  function installAdapterMocks({ detectResult, mapResult }) {
    const stubRegistry = {
      detect: vi.fn().mockReturnValue(detectResult),
      clearAdaptersForTests: vi.fn(),
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listManagers: vi.fn().mockReturnValue([]),
    };
    const stubAdapter = {
      manager: detectResult?.manager || 'python',
      mapModuleToPackage: vi.fn().mockResolvedValue(mapResult),
    };
    if (detectResult?.detected) {
      stubRegistry.detect.mockReturnValue({ adapter: stubAdapter, ...detectResult });
    }
    [
      { path: depRegistryPath, exports: stubRegistry },
      { path: pythonAdapterPath, exports: { createPythonAdapter: () => stubAdapter } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[require.resolve('../factory/verify-review')];
    return { stubRegistry, stubAdapter };
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[require.resolve('../factory/verify-review')];
  });

  it('returns missing_dep when adapter detects + LLM maps with high confidence', async () => {
    installAdapterMocks({
      detectResult: { detected: true, manager: 'python', module_name: 'cv2', signals: ['ModuleNotFoundError'] },
      mapResult: { package_name: 'opencv-python', confidence: 'high' },
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('missing_dep');
    expect(r.manager).toBe('python');
    expect(r.package_name).toBe('opencv-python');
    expect(r.module_name).toBe('cv2');
  });

  it('falls through to existing classification when detection fires but LLM confidence is low', async () => {
    installAdapterMocks({
      detectResult: { detected: true, manager: 'python', module_name: 'weird', signals: ['ModuleNotFoundError'] },
      mapResult: { package_name: null, confidence: 'low' },
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: "ModuleNotFoundError: No module named 'weird'", stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).not.toBe('missing_dep');
  });

  it('falls through to existing classification when no adapter detects', async () => {
    installAdapterMocks({
      detectResult: null,
      mapResult: null,
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/foo.py::test_bar', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).not.toBe('missing_dep');
  });
});

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

  it('returns detected=true for Windows pytest temp PermissionError output', () => {
    const stderr = [
      "PermissionError: [WinError 5] Access is denied: 'C:\\repo\\.pytest-tmp\\pytest-cache-files-a1'",
      'pytest failed while cleaning temporary directories',
    ].join('\n');
    const r = detectEnvironmentFailure({ exitCode: 1, stdout: '', stderr, timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('stderr_PermissionError');
    expect(r.signals).toContain('stderr_pytest_temp_permission');
    expect(r.reason).toBe('permission_denied');
  });

  it('returns detected=true when stderr matches ENOENT pattern', () => {
    const r = detectEnvironmentFailure({ exitCode: 1, stdout: '', stderr: 'Error: ENOENT: no such file or directory', timedOut: false });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('stderr_ENOENT');
    expect(r.reason).toBe('missing_file_or_dir');
  });

  it('uses combined output fallback when stdout and stderr are absent', () => {
    const r = detectEnvironmentFailure({ output: '[error] Error: ENOENT: no such file or directory', exitCode: 1 });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('stderr_ENOENT');
  });

  it('parses exit_code from output fallback', () => {
    const r = detectEnvironmentFailure({ output: 'factory worktree verify finished exit_code: 127' });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('exit_127');
    expect(r.reason).toBe('command_not_found');
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

  it('parses vitest failure pointer lines into test file paths', () => {
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

  it('parses vitest failure paths from output fallback', () => {
    const r = parseFailingTests({
      output: `
 FAIL  server/tests/factory-verify-review.test.js [ server/tests/factory-verify-review.test.js ]
 ❯ server/tests/factory-verify-review.test.js:42:7
`,
    });
    expect(r).toEqual(['server/tests/factory-verify-review.test.js']);
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

  it('parses Pester 5 stack-trace lines into test script paths', () => {
    const out = {
      stdout: `
Describing FactoryGate
  [-] should reject when ratio < threshold 30ms
     Expected 0.99 but was 0.85
     at <ScriptBlock>, C:\\Users\\Werem\\Projects\\StateTrace\\Modules\\Tests\\SharedCacheHitRatioGate.Tests.ps1:42
  [-] should mark warm runs ready 18ms
     at <ScriptBlock>, Modules/Tests/SharedCacheHitRatioGate.Tests.ps1:67

Tests Passed: 12, Failed: 2, Skipped: 0
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r.some(p => p.endsWith('SharedCacheHitRatioGate.Tests.ps1'))).toBe(true);
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it('parses Pester 4 stack-trace lines into test script paths', () => {
    const out = {
      stdout: `
[-] InvokeAllChecks.Validate fails on missing manifest
   Expected: True
   But was:  False
   at line: 14 in C:\\Users\\Werem\\Projects\\StateTrace\\Tools\\Tests\\InvokeAllChecks.Tests.ps1
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r.some(p => p.endsWith('InvokeAllChecks.Tests.ps1'))).toBe(true);
  });

  it('returns empty for Pester output with no failures (only [+] markers)', () => {
    const out = {
      stdout: `
Describing TestSuite
  [+] passes one 5ms
  [+] passes two 4ms

Tests Passed: 2, Failed: 0
`,
      stderr: '',
    };
    expect(parseFailingTests(out)).toEqual([]);
  });

  it('strips ANSI escape codes before matching vitest output (vitest 4 emits SGR colors even when stdout is redirected to a file)', () => {
    // Live regression 2026-04-25: torque-public went baseline_broken because
    // vitest 4 wraps its arrow-pointer and FAIL-header lines in SGR escapes
    // ([31m...[39m) even when stdout is redirected to a non-TTY.
    // The existing regexes use `❯\s+(<path>):\d+` and `^\s*FAIL\s+(<path>)`
    // which only match against clean text — the embedded escape codes between
    // ❯ and the path (or between FAIL and the path) make `\s+` fail and the
    // parser returns []. Empty failing_tests then collapses the classifier
    // to the LLM tiebreak, which hallucinated "patch overlay conflicts" and
    // marked the project verify_failed_baseline_unrelated for a full day.
    const ESC = '';
    const out = {
      stdout: `
 ${ESC}[31m❯${ESC}[39m server/tests/p3-silent-catches.test.js ${ESC}[2m(${ESC}[22m${ESC}[2m1 test${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[31m1 failed${ESC}[39m${ESC}[2m)${ESC}[22m${ESC}[33m 338${ESC}[2mms${ESC}[22m${ESC}[39m
${ESC}[31m     ${ESC}[31m×${ESC}[31m no handler catch blocks should be empty${ESC}[39m
${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m server/tests/v2-task-handlers.test.js${ESC}[2m > ${ESC}[22mhandleReassignTaskProvider > preserves metadata
${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: ...
${ESC}[36m ${ESC}[2m❯${ESC}[22m server/tests/v2-task-handlers.test.js:${ESC}[2m1399:31${ESC}[22m${ESC}[39m
`,
      stderr: '',
    };
    const r = parseFailingTests(out);
    expect(r).toContain('server/tests/p3-silent-catches.test.js');
    expect(r).toContain('server/tests/v2-task-handlers.test.js');
  });
});

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

  it('returns submit_failed when submit throws', async () => {
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
    expect(r).toEqual({ verdict: null, critique: null, status: 'submit_failed', taskId: null });
  });

  it('returns timeout when the review task is cancelled for timeout', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 't1' }),
      await: vi.fn().mockResolvedValue({ status: 'timeout' }),
      task: vi.fn().mockReturnValue({ status: 'cancelled', output: null, error_output: '[cancelled] Timeout exceeded' }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r).toEqual({ verdict: null, critique: null, status: 'timeout', taskId: 't1' });
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
    expect(r.status).toBe('completed');
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
    expect(r.status).toBe('completed');
  });

  it('submits the LLM tiebreak task in the provided worktree directory with the full timeout budget', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-worktree' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"The failing test belongs to this diff."}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    await runLlmTiebreak({
      failingTests: ['tests/helper.test.ts'],
      modifiedFiles: ['src/helper.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/repo/root' },
      workingDirectory: '/repo/.worktrees/feat-factory-1',
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      working_directory: '/repo/.worktrees/feat-factory-1',
      timeout_minutes: 10,
    }));
  });

  it('returns invalid_output when output is unparseable', async () => {
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
    expect(r).toEqual({ verdict: null, critique: null, status: 'invalid_output', taskId: 't4' });
  });

  it('forwards verifyOutput tail into the submitted prompt', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-verify' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    await runLlmTiebreak({
      failingTests: [],
      modifiedFiles: ['simtests/Foo.cs'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
      verifyOutput: { exitCode: 1, stdout: '[xUnit.net 00:00:01.99]   SimCore.Tests.FooBar.Method [FAIL]\n  Expected: 42\n  Actual:   17', stderr: '' },
    });
    const submittedPrompt = submit.mock.calls[0][0].task;
    expect(submittedPrompt).toContain('Verify command output');
    expect(submittedPrompt).toContain('FooBar.Method [FAIL]');
    expect(submittedPrompt).toContain('Expected: 42');
  });

  it('truncates oversize work item descriptions in the prompt', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-trunc' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const longDescription = 'X'.repeat(5000);
    await runLlmTiebreak({
      failingTests: [],
      modifiedFiles: ['src/foo.ts'],
      workItem: { id: 1, title: 'w', description: longDescription },
      project: { id: 'p', path: '/tmp/p' },
      verifyOutput: { exitCode: 1, stdout: 'fail', stderr: '' },
    });
    const submittedPrompt = submit.mock.calls[0][0].task;
    expect(submittedPrompt).toContain('[...truncated...]');
    expect(submittedPrompt.length).toBeLessThan(longDescription.length);
  });

  it('routes verify_review with cerebras + prefer_free + context_stuff:false by default', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-fast' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'verify_review',
        provider: 'cerebras',
        prefer_free: true,
        context_stuff: false,
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
      else process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = original;
    }
  });

  it('defers verify_review provider selection to the target project provider lane when configured', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-lane' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: {
          id: 'p',
          path: '/tmp/p',
          config_json: JSON.stringify({
            provider_lane_policy: {
              expected_provider: 'ollama-cloud',
              allowed_fallback_providers: [],
              enforce_handoffs: true,
            },
          }),
        },
      });
      const call = submit.mock.calls[0][0];
      expect(call.provider).toBeUndefined();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'verify_review',
        prefer_free: true,
        context_stuff: false,
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
      else process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = original;
    }
  });

  it('honors TORQUE_VERIFY_REVIEWER_PROVIDER env override', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-env' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = 'groq';
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'groq',
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
      else process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = original;
    }
  });

  it('opts back into smart routing when TORQUE_VERIFY_REVIEWER_PROVIDER is empty', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-empty' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
    process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = '';
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      const call = submit.mock.calls[0][0];
      expect(call.provider).toBeUndefined();
      expect(call.prefer_free).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_PROVIDER;
      else process.env.TORQUE_VERIFY_REVIEWER_PROVIDER = original;
    }
  });

  it('retries once with strict-JSON suffix when first attempt is invalid_output', async () => {
    const submit = vi.fn()
      .mockResolvedValueOnce({ task_id: 't-attempt-1' })
      .mockResolvedValueOnce({ task_id: 't-attempt-2' });
    const taskFn = vi.fn()
      .mockReturnValueOnce({ status: 'completed', output: 'here is your answer: { verdict: maybe }' })
      .mockReturnValueOnce({ status: 'completed', output: '{"verdict":"go","critique":"failures match the diff"}' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: taskFn,
    });
    const { runLlmTiebreak, STRICT_JSON_SUFFIX } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0].task).not.toContain(STRICT_JSON_SUFFIX.trim());
    expect(submit.mock.calls[1][0].task).toContain('JSON only');
    expect(r.verdict).toBe('go');
    expect(r.status).toBe('completed');
    expect(r.taskId).toBe('t-attempt-2');
  });

  it('does not retry when first attempt succeeds', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-once' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"no-go","critique":"unrelated baseline"}',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('retries once with strict-JSON suffix when first attempt is empty_output', async () => {
    const submit = vi.fn()
      .mockResolvedValueOnce({ task_id: 't-empty-1' })
      .mockResolvedValueOnce({ task_id: 't-empty-2' });
    // First task returns null/empty output (qwen-3-235b empty-output bug);
    // second task returns a real verdict.
    const taskFn = vi.fn()
      .mockReturnValueOnce({ status: 'completed', output: null })
      .mockReturnValueOnce({ status: 'completed', output: '{"verdict":"go","critique":"diff explains the fail"}' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: taskFn,
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0].task).toContain('JSON only');
    expect(r.verdict).toBe('go');
    expect(r.status).toBe('completed');
    expect(r.taskId).toBe('t-empty-2');
  });

  it('passes a reviewerModel override (default llama3.1-8b) into the submit', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-model' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_MODEL;
    delete process.env.TORQUE_VERIFY_REVIEWER_MODEL;
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        model: 'llama3.1-8b',
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_MODEL;
      else process.env.TORQUE_VERIFY_REVIEWER_MODEL = original;
    }
  });

  it('substitutes tier-restricted env override with the safe fallback model', async () => {
    // zai-glm-4.7 / gpt-oss-120b appear in /v1/models but 404 on
    // chat/completions for tier-1 cerebras keys. If an operator (or a
    // routing template handed down via env) names one, swap to
    // llama3.1-8b instead of burning 30s on a doomed request.
    const submit = vi.fn().mockResolvedValue({ task_id: 't-model-restricted' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_MODEL;
    process.env.TORQUE_VERIFY_REVIEWER_MODEL = 'zai-glm-4.7';
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        model: 'llama3.1-8b',
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_MODEL;
      else process.env.TORQUE_VERIFY_REVIEWER_MODEL = original;
    }
  });

  it('opts back into routing-template choice when env override is empty', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-model-empty' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_MODEL;
    process.env.TORQUE_VERIFY_REVIEWER_MODEL = '';
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      // model: null → submitFactoryInternalTask omits the model arg
      // entirely, leaving routing template to pick. Spec preserves
      // bbd5fd71's existing escape hatch.
      const submitArgs = submit.mock.calls[0][0];
      expect('model' in submitArgs ? submitArgs.model : null).toBeNull();
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_MODEL;
      else process.env.TORQUE_VERIFY_REVIEWER_MODEL = original;
    }
  });

  it('honors TORQUE_VERIFY_REVIEWER_MODEL env override', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-model-env' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"verdict":"go","critique":"ok"}',
      }),
    });
    const original = process.env.TORQUE_VERIFY_REVIEWER_MODEL;
    process.env.TORQUE_VERIFY_REVIEWER_MODEL = 'llama3.1-8b';
    try {
      const { runLlmTiebreak } = require('../factory/verify-review');
      await runLlmTiebreak({
        failingTests: ['tests/foo.py'],
        modifiedFiles: ['src/bar.ts'],
        workItem: { id: 1, title: 'w', description: 'd' },
        project: { id: 'p', path: '/tmp/p' },
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        model: 'llama3.1-8b',
      }));
    } finally {
      if (original === undefined) delete process.env.TORQUE_VERIFY_REVIEWER_MODEL;
      else process.env.TORQUE_VERIFY_REVIEWER_MODEL = original;
    }
  });

  it('does not retry on terminal non-parse failures (timeout, submit_failed)', async () => {
    const submit = vi.fn().mockResolvedValue({ task_id: 't-timeout' });
    installMocks({
      submit,
      await: vi.fn().mockResolvedValue({ status: 'timeout' }),
      task: vi.fn().mockReturnValue({
        status: 'cancelled',
        output: null,
        error_output: '[cancelled] Timeout exceeded',
      }),
    });
    const { runLlmTiebreak } = require('../factory/verify-review');
    const r = await runLlmTiebreak({
      failingTests: ['tests/foo.py'],
      modifiedFiles: ['src/bar.ts'],
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('timeout');
  });
});

describe('extractVerifyExcerpt', () => {
  const { extractVerifyExcerpt } = require('../factory/verify-review');

  it('returns empty string for missing or empty input', () => {
    expect(extractVerifyExcerpt(null)).toBe('');
    expect(extractVerifyExcerpt(undefined)).toBe('');
    expect(extractVerifyExcerpt({ stdout: '', stderr: '' })).toBe('');
  });

  it('returns combined output untouched when under the limit', () => {
    const out = extractVerifyExcerpt({ stdout: 'short stdout', stderr: 'short stderr' });
    expect(out).toContain('short stdout');
    expect(out).toContain('short stderr');
    expect(out).not.toContain('[...truncated...]');
  });

  it('keeps only the tail when combined output exceeds the limit', () => {
    const big = 'A'.repeat(4000) + '\nFINAL_FAILURE_LINE';
    const out = extractVerifyExcerpt({ stdout: big, stderr: '' });
    expect(out.startsWith('[...truncated...]')).toBe(true);
    expect(out).toContain('FINAL_FAILURE_LINE');
    expect(out.length).toBeLessThan(big.length);
  });
});

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

  it('baseline_candidate + LLM timeout: returns reviewer_timeout', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: null,
      critique: null,
      status: 'timeout',
      taskId: 'llm-timeout-1',
    });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/bar.py::test_baz', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('reviewer_timeout');
    expect(r.confidence).toBe('high');
    expect(r.llmStatus).toBe('timeout');
    expect(r.llmTaskId).toBe('llm-timeout-1');
    expect(r.suggestedRejectReason).toBeNull();
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM null without timeout + non-infra diff: upgrades to baseline_likely', async () => {
    // When the LLM verdict is unavailable (submit_failed / invalid_output /
    // empty_output / await_failed) we used to return ambiguous and pause for
    // operator triage. That left the loop stuck whenever the reviewer
    // provider was flaky. The deterministic shape here — failing tests do
    // not touch any modified file, modifiedFiles all live outside shared
    // infrastructure — is strong enough to upgrade to baseline_likely with
    // medium confidence. Loop-controller routes baseline_likely through the
    // same handler as baseline_broken (reject the work item, pause for the
    // baseline-probe to confirm against main).
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: null,
      critique: null,
      status: 'invalid_output',
      taskId: 'llm-invalid-1',
    });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue(['src/foo.ts']);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/bar.py::test_baz', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('baseline_likely');
    expect(r.confidence).toBe('medium');
    expect(r.llmStatus).toBe('invalid_output');
    expect(r.llmTaskId).toBe('llm-invalid-1');
    expect(r.intersection).toEqual([]);
    expect(r.sharedInfraTouched).toBe(false);
    expect(r.suggestedRejectReason).toBe('verify_failed_baseline_likely_unrelated');
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM null + shared-infra diff: stays ambiguous (conservative)', async () => {
    // Hardening against false negatives in the path-intersection heuristic.
    // When a modified file is shared infrastructure (lockfile, build config,
    // top-level script, etc.) it can break tests that don't import it
    // directly — codegraph tests can fail because of a package.json bump,
    // for instance. In that case `intersection: []` is misleading, so we
    // refuse to upgrade to baseline_likely and stay ambiguous. The engine's
    // strategy escalation (retry → reject_and_advance → escalate) is the
    // safety net that breaks the loop instead.
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: null,
      critique: null,
      status: 'submit_failed',
      taskId: null,
    });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue([
      'package.json',
      'scripts/install-userbin.sh',
      'server/tests/install-userbin.test.js',
    ]);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: {
        exitCode: 1,
        stdout: 'FAIL  server/plugins/codegraph/tests/parser.test.js > parser > works',
        stderr: '',
        timedOut: false,
      },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('ambiguous');
    expect(r.confidence).toBe('low');
    expect(r.sharedInfraTouched).toBe(true);
    expect(Array.isArray(r.sharedInfraFiles)).toBe(true);
    expect(r.sharedInfraFiles).toEqual(expect.arrayContaining(['package.json', 'scripts/install-userbin.sh']));
    expect(r.suggestedRejectReason).toBeNull();
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM null + tsconfig.json in diff: stays ambiguous', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: null,
      critique: null,
      status: 'submit_failed',
      taskId: null,
    });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue([
      'tsconfig.json',
      'src/foo.ts',
    ]);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAIL  src/unrelated.test.ts > x > y\n❯ src/unrelated.test.ts:5:1', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('ambiguous');
    expect(r.sharedInfraTouched).toBe(true);
    expect(r.sharedInfraFiles).toContain('tsconfig.json');
    llmSpy.mockRestore();
    diffSpy.mockRestore();
  });

  it('baseline_candidate + LLM submit_failed + multi-file non-infra diff: upgrades to baseline_likely', async () => {
    const llmSpy = vi.spyOn(verifyReview, 'runLlmTiebreak').mockResolvedValue({
      verdict: null,
      critique: null,
      status: 'submit_failed',
      taskId: null,
    });
    const diffSpy = vi.spyOn(verifyReview, 'getModifiedFiles').mockResolvedValue([
      'src/feature/alpha.ts',
      'src/feature/beta.ts',
      'src/feature/__tests__/alpha.test.ts',
    ]);
    const r = await verifyReview.reviewVerifyFailure({
      verifyOutput: {
        exitCode: 1,
        stdout: 'FAIL  tests/legacy/parser.test.ts > x > y\n❯ tests/legacy/parser.test.ts:8:3',
        stderr: '',
        timedOut: false,
      },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/factory-1',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('baseline_likely');
    expect(r.confidence).toBe('medium');
    expect(r.suggestedRejectReason).toBe('verify_failed_baseline_likely_unrelated');
    expect(r.sharedInfraTouched).toBe(false);
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

describe('isSharedInfrastructureFile', () => {
  const { isSharedInfrastructureFile } = require('../factory/verify-review');

  it('detects Node lockfiles + manifests', () => {
    expect(isSharedInfrastructureFile('package.json')).toBe(true);
    expect(isSharedInfrastructureFile('package-lock.json')).toBe(true);
    expect(isSharedInfrastructureFile('yarn.lock')).toBe(true);
    expect(isSharedInfrastructureFile('pnpm-lock.yaml')).toBe(true);
    expect(isSharedInfrastructureFile('server/package.json')).toBe(true);
    expect(isSharedInfrastructureFile('packages/foo/package.json')).toBe(true);
  });

  it('detects test/build config files', () => {
    expect(isSharedInfrastructureFile('tsconfig.json')).toBe(true);
    expect(isSharedInfrastructureFile('tsconfig.base.json')).toBe(true);
    expect(isSharedInfrastructureFile('vitest.config.ts')).toBe(true);
    expect(isSharedInfrastructureFile('jest.config.js')).toBe(true);
    expect(isSharedInfrastructureFile('vite.config.mjs')).toBe(true);
    expect(isSharedInfrastructureFile('eslint.config.js')).toBe(true);
    expect(isSharedInfrastructureFile('.eslintrc.json')).toBe(true);
  });

  it('detects Python project metadata', () => {
    expect(isSharedInfrastructureFile('pyproject.toml')).toBe(true);
    expect(isSharedInfrastructureFile('requirements.txt')).toBe(true);
    expect(isSharedInfrastructureFile('requirements-dev.txt')).toBe(true);
    expect(isSharedInfrastructureFile('Pipfile')).toBe(true);
    expect(isSharedInfrastructureFile('setup.py')).toBe(true);
  });

  it('detects Rust/Go/.NET build files', () => {
    expect(isSharedInfrastructureFile('Cargo.toml')).toBe(true);
    expect(isSharedInfrastructureFile('Cargo.lock')).toBe(true);
    expect(isSharedInfrastructureFile('go.mod')).toBe(true);
    expect(isSharedInfrastructureFile('go.sum')).toBe(true);
    expect(isSharedInfrastructureFile('SpudgetBooks.sln')).toBe(true);
    expect(isSharedInfrastructureFile('src/Domain/Domain.csproj')).toBe(true);
    expect(isSharedInfrastructureFile('Makefile')).toBe(true);
  });

  it('detects repo-wide infrastructure directories', () => {
    expect(isSharedInfrastructureFile('.github/workflows/ci.yml')).toBe(true);
    expect(isSharedInfrastructureFile('scripts/install-userbin.sh')).toBe(true);
    expect(isSharedInfrastructureFile('tools/bench.js')).toBe(true);
    expect(isSharedInfrastructureFile('bin/torque-remote')).toBe(true);
    expect(isSharedInfrastructureFile('.husky/pre-commit')).toBe(true);
  });

  it('detects top-level shell/script files', () => {
    expect(isSharedInfrastructureFile('install.sh')).toBe(true);
    expect(isSharedInfrastructureFile('build.ps1')).toBe(true);
    expect(isSharedInfrastructureFile('Setup.bat')).toBe(true);
  });

  it('handles Windows backslash separators', () => {
    expect(isSharedInfrastructureFile('server\\package.json')).toBe(true);
    expect(isSharedInfrastructureFile('scripts\\install.sh')).toBe(true);
  });

  it('does NOT flag ordinary source/test files', () => {
    expect(isSharedInfrastructureFile('src/foo.ts')).toBe(false);
    expect(isSharedInfrastructureFile('server/factory/loop-controller.js')).toBe(false);
    expect(isSharedInfrastructureFile('tests/foo.test.ts')).toBe(false);
    expect(isSharedInfrastructureFile('docs/readme.md')).toBe(false);
    // Nested .sh under src/ is still not infra at the top level
    expect(isSharedInfrastructureFile('src/runner/launch.sh')).toBe(false);
  });

  it('handles empty/null input gracefully', () => {
    expect(isSharedInfrastructureFile('')).toBe(false);
    expect(isSharedInfrastructureFile(null)).toBe(false);
    expect(isSharedInfrastructureFile(undefined)).toBe(false);
  });
});

describe('detectBuildFailure', () => {
  const { detectBuildFailure } = require('../factory/verify-review');

  it('returns detected:false for exit-code 0 even with error-looking text', () => {
    const r = detectBuildFailure({
      exitCode: 0,
      stdout: 'this output mentions error CS1234: but the build still succeeded',
      stderr: '',
      output: '',
    });
    expect(r.detected).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it('detects the f9cf2275 SpudgetBooks pattern (CS errors + Build FAILED + Error count)', () => {
    // Synthetic version of the actual `dotnet test` output that should have
    // tripped the gate on 2026-04-23 but didn't. failingTests=[] (because
    // the build failed before tests could run), exit 1, plus all three
    // dotnet build-failure signals.
    const r = detectBuildFailure({
      exitCode: 1,
      stdout: [
        '  Restored Domain.csproj',
        '  Restored Application.csproj',
        '  Restored Infrastructure.csproj',
        "ApiEndpointRouteBuilderExtensions.Banking.cs(61,24): error CS0103: The name 'PaginationHelper' does not exist in the current context",
        "ApiEndpointRouteBuilderExtensions.Banking.cs(147,13): error CS0128: A local variable named 'result' is already defined in this scope",
        '',
        'Build FAILED.',
        '',
        '    8 Error(s)',
      ].join('\n'),
      stderr: '',
      output: '',
    });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('csharp_compile_error');
    expect(r.signals).toContain('dotnet_build_failed_marker');
    expect(r.signals).toContain('dotnet_error_count_8');
  });

  it('detects TypeScript tsc compile errors', () => {
    const r = detectBuildFailure({
      exitCode: 2,
      stdout: 'src/foo.ts(10,5): error TS2304: Cannot find name "Bar".',
      stderr: '',
      output: '',
    });
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('ts_compile_error');
  });

  it('detects tsc watch-mode "Found N errors"', () => {
    const r = detectBuildFailure({
      exitCode: 1,
      stdout: 'Found 3 errors. Watching for file changes.',
      stderr: '',
      output: '',
    });
    expect(r.signals).toContain('tsc_found_errors');
  });

  it('detects gcc/clang errors (anchored to C-family extensions, not python)', () => {
    const cErr = detectBuildFailure({
      exitCode: 1,
      stdout: 'src/main.c:42:13: error: \'foo\' undeclared',
      stderr: '',
      output: '',
    });
    expect(cErr.signals).toContain('cc_error');

    // Regression: an earlier rev's `^.+:\d+:\d+:\s+error:` matched python
    // tracebacks like "Module.py:10:5: error: ...". The new anchored
    // pattern requires a C-family extension, so this should NOT trip cc_error.
    const pythonish = detectBuildFailure({
      exitCode: 1,
      stdout: 'tests/Module.py:10:5: error: invalid syntax',
      stderr: '',
      output: '',
    });
    expect(pythonish.signals).not.toContain('cc_error');
  });

  it('detects rust cargo compile errors', () => {
    const r = detectBuildFailure({
      exitCode: 101,
      stdout: 'error[E0425]: cannot find value `x` in this scope\nerror: could not compile `mycrate`',
      stderr: '',
      output: '',
    });
    expect(r.signals).toContain('rust_compile_error');
    expect(r.signals).toContain('cargo_could_not_compile');
  });

  it('detects go compile errors via the compile-idiom anchor (not by absence of PASS/FAIL)', () => {
    // The earlier rev gated go detection on the absence of PASS/FAIL anywhere.
    // That suppressed detection in the common case where one package has a
    // compile error but a sibling package PASSes earlier in the same output.
    const r = detectBuildFailure({
      exitCode: 1,
      stdout: [
        'ok      example.com/sibling     0.123s',
        'PASS',
        '',
        '# example.com/broken',
        './pkg/foo.go:42:13: undefined: Bar',
        'FAIL    example.com/broken      [build failed]',
      ].join('\n'),
      stderr: '',
      output: '',
    });
    expect(r.signals).toContain('go_compile_error');
  });

  it('detects javac and make errors', () => {
    const javaR = detectBuildFailure({
      exitCode: 1,
      stdout: 'src/com/example/Foo.java:42: error: cannot find symbol',
      stderr: '',
      output: '',
    });
    expect(javaR.signals).toContain('javac_error');

    const makeR = detectBuildFailure({
      exitCode: 2,
      stdout: 'make[1]: *** [Makefile:42: target] Error 1',
      stderr: '',
      output: '',
    });
    expect(makeR.signals).toContain('make_error');
  });

  it('returns detected:false on bare non-zero exit with no compile signatures', () => {
    // A test failure (non-zero exit, but tests ran) should NOT be classified
    // as build_failure — that path is handled elsewhere by the test-failure
    // classifier. detectBuildFailure stays out of the way.
    const r = detectBuildFailure({
      exitCode: 1,
      stdout: 'FAIL  src/foo.test.ts > does the thing\n  AssertionError: expected 1 to be 2',
      stderr: '',
      output: '',
    });
    expect(r.detected).toBe(false);
  });
});
