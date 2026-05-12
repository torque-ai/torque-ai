// server/tests/torque-remote-adapters.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '_torque-remote-test-runner.sh');

function emit(adapterName, args, os) {
  return execFileSync(
    'bash',
    [RUNNER, adapterName, os, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

describe('remote_test_path_exists adapter', () => {
  it('emits POSIX test command on linux', () => {
    const out = emit('remote_test_path_exists', ['/tmp/foo'], 'linux');
    expect(out).toContain('[ -e "/tmp/foo" ]');
  });

  it('emits CMD if-exist on windows', () => {
    const out = emit('remote_test_path_exists', ['C:\\trt\\foo'], 'windows');
    expect(out).toContain('if exist "C:\\trt\\foo"');
  });
});

describe('remote_make_dir adapter', () => {
  it('emits mkdir -p on linux', () => {
    const out = emit('remote_make_dir', ['/tmp/foo'], 'linux');
    expect(out).toContain('mkdir -p "/tmp/foo"');
  });

  it('emits CMD mkdir with if-not-exist guard on windows', () => {
    const out = emit('remote_make_dir', ['C:\\trt\\foo'], 'windows');
    expect(out).toMatch(/if not exist "C:\\trt\\foo".*mkdir "C:\\trt\\foo"/s);
  });
});

describe('remote_remove_dir adapter', () => {
  it('emits rm -rf on linux', () => {
    const out = emit('remote_remove_dir', ['/tmp/foo'], 'linux');
    expect(out).toContain('rm -rf "/tmp/foo"');
  });

  it('emits rmdir /s /q on windows', () => {
    const out = emit('remote_remove_dir', ['C:\\trt\\foo'], 'windows');
    expect(out).toContain('rmdir /s /q "C:\\trt\\foo"');
  });
});

describe('remote_path_to_native adapter', () => {
  it('returns input unchanged on linux', () => {
    const out = emit('remote_path_to_native', ['~/trt/foo'], 'linux').trim();
    expect(out).toBe('~/trt/foo');
  });

  it('converts forward slashes to backslashes on windows', () => {
    const out = emit('remote_path_to_native', ['/c/trt/foo'], 'windows').trim();
    expect(out).toBe('\\c\\trt\\foo');
  });

  it('preserves C: prefix on windows', () => {
    const out = emit('remote_path_to_native', ['C:/trt/foo'], 'windows').trim();
    expect(out).toBe('C:\\trt\\foo');
  });
});
