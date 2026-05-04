'use strict';

const { spawn } = require('child_process');
const { isPidAlive } = require('../utils/pid-liveness');

describe('isPidAlive', () => {
  it('returns true for the current node process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns true for a freshly-spawned child and false after it exits', async () => {
    // node -e 'setTimeout(() => process.exit(0), 30000)' — sleeps 30s
    // so the test gets a stable live PID for the assertion. detached
    // so an unexpected test failure doesn't leak the child into the
    // test runner's process group; ignore stdio so its output doesn't
    // pollute our test logs.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 30000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      // Give the OS a moment to register the PID before we probe it.
      await new Promise((r) => setTimeout(r, 50));
      expect(isPidAlive(child.pid)).toBe(true);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Wait for the kernel to reap the PID before asserting it's gone.
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(isPidAlive(child.pid)).toBe(false);
  });

  it('returns false for invalid input (non-numeric, negative, zero, NaN, fractional)', () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive('123')).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
    expect(isPidAlive(Infinity)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('returns false for an obviously-out-of-range PID', () => {
    // 32-bit max is well above any platform's PID space; on POSIX
    // the kernel returns ESRCH, on Windows OpenProcess returns
    // ERROR_INVALID_PARAMETER which node maps to ESRCH.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});
