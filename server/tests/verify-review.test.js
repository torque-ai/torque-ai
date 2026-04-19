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
