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
