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
