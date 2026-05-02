'use strict';

describe('baseline-probe module exports', () => {
  it('exports probeProjectBaseline', () => {
    const mod = require('../factory/baseline-probe');
    expect(typeof mod.probeProjectBaseline).toBe('function');
    expect(typeof mod.resolveBaselineProbeTimeoutMs).toBe('function');
    expect(typeof mod.resolveBaselineVerifyCommand).toBe('function');
  });
});

describe('resolveBaselineVerifyCommand', () => {
  const { resolveBaselineVerifyCommand } = require('../factory/baseline-probe');

  it('returns null when nothing is configured', () => {
    expect(resolveBaselineVerifyCommand()).toBeNull();
    expect(resolveBaselineVerifyCommand({})).toBeNull();
    expect(resolveBaselineVerifyCommand({ cfg: {}, defaults: {} })).toBeNull();
  });

  it('prefers recorded failed verify command above smoke baseline commands', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: {
        baseline_broken_evidence: { verify_command: 'npx vitest run server/tests/full.test.js' },
        baseline_verify_command: 'npx vitest run server/tests/smoke.test.js',
        verify_command: 'npx vitest run',
      },
      defaults: {
        baseline_verify_command: 'def-baseline',
        verify_command: 'def-verify',
      },
    })).toBe('npx vitest run server/tests/full.test.js');
  });

  it('prefers cfg.baseline_verify_command when there is no recorded failure command', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: {
        baseline_verify_command: 'cfg-baseline',
        verify_command: 'cfg-verify',
      },
      defaults: {
        baseline_verify_command: 'def-baseline',
        verify_command: 'def-verify',
      },
    })).toBe('cfg-baseline');
  });

  it('falls back to defaults.baseline_verify_command when cfg lacks one', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: { verify_command: 'cfg-verify' },
      defaults: {
        baseline_verify_command: 'def-baseline',
        verify_command: 'def-verify',
      },
    })).toBe('def-baseline');
  });

  it('falls back to cfg.verify_command before defaults.verify_command', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: { verify_command: 'cfg-verify' },
      defaults: { verify_command: 'def-verify' },
    })).toBe('cfg-verify');
  });

  it('falls back to defaults.verify_command when cfg has nothing', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: {},
      defaults: { verify_command: 'def-verify' },
    })).toBe('def-verify');
  });

  it('treats empty strings as missing for cfg.baseline_verify_command', () => {
    expect(resolveBaselineVerifyCommand({
      cfg: { baseline_verify_command: '', verify_command: 'cfg-verify' },
      defaults: {},
    })).toBe('cfg-verify');
  });
});

describe('resolveBaselineProbeTimeoutMs', () => {
  it('defaults to 60 minutes and honors explicit timeout over project config', () => {
    const { resolveBaselineProbeTimeoutMs } = require('../factory/baseline-probe');
    expect(resolveBaselineProbeTimeoutMs()).toBe(60 * 60 * 1000);
    expect(resolveBaselineProbeTimeoutMs({
      timeout_minutes: 90,
      config: { baseline_probe_timeout_minutes: 30 },
    })).toBe(90 * 60 * 1000);
  });

  it('uses project config timeout and clamps unreasonable values', () => {
    const { resolveBaselineProbeTimeoutMs } = require('../factory/baseline-probe');
    expect(resolveBaselineProbeTimeoutMs({
      config: { baseline_probe_timeout_minutes: 45 },
    })).toBe(45 * 60 * 1000);
    expect(resolveBaselineProbeTimeoutMs({ timeout_minutes: 999 })).toBe(240 * 60 * 1000);
    expect(resolveBaselineProbeTimeoutMs({ timeout_minutes: 0 })).toBe(1 * 60 * 1000);
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
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60 * 60 * 1000 }));
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
