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
