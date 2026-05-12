// server/tests/torque-remote-probe.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '_torque-remote-test-runner.sh');

// Invoke the probe classifier with a synthetic uname output, return REMOTE_OS.
function classify(probeOutput) {
  const out = execFileSync(
    'bash',
    [RUNNER, 'classify_and_print', 'unset', probeOutput],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return out.trim();
}

describe('remote OS probe classifier', () => {
  it('classifies Linux uname output as linux', () => {
    expect(classify('Linux torque-usb 6.8.0-generic')).toBe('linux');
  });

  it('classifies Darwin (macOS) as linux (POSIX-compatible)', () => {
    expect(classify('Darwin Kernel Version 23.x')).toBe('linux');
  });

  it('classifies MINGW64 Git Bash as windows', () => {
    expect(classify('MINGW64_NT-10.0-x')).toBe('windows');
  });

  it('classifies MSYS as windows', () => {
    expect(classify('MSYS_NT-10.0')).toBe('windows');
  });

  it('classifies CYGWIN as windows', () => {
    expect(classify('CYGWIN_NT-10.0')).toBe('windows');
  });

  it('classifies ver output (Microsoft Windows) as windows', () => {
    expect(classify('Microsoft Windows [Version 10.0.x]')).toBe('windows');
  });

  it('classifies empty output as unknown', () => {
    expect(classify('')).toBe('unknown');
  });

  it('classifies garbage output as unknown', () => {
    expect(classify('zorblax foo bar')).toBe('unknown');
  });

  it('remote_probe_os function is defined when sourced', () => {
    const out = execFileSync(
      'bash',
      [RUNNER, 'declare_and_print', 'unset', 'remote_probe_os'],
      { encoding: 'utf8' }
    );
    expect(out).toMatch(/remote_probe_os/);
  });
});
