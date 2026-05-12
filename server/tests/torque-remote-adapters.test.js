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

describe('remote_lock_acquire adapter', () => {
  const ownerEnv = 'host=foo\npid=123\nstarted_at_epoch=1700000000\nlane_index=1';
  // Base64-encode to survive Windows CreateProcess argument passing (newlines
  // in CLI args get mangled). Runner decodes B64:-prefixed args.
  const ownerEnvB64 = 'B64:' + Buffer.from(ownerEnv).toString('base64');

  it('emits mkdir + heredoc on linux', () => {
    const out = emit('remote_lock_acquire', ['/tmp/lock', ownerEnvB64], 'linux');
    expect(out).toContain('mkdir "/tmp/lock"');
    expect(out).toContain('cat > "/tmp/lock/owner.env"');
    expect(out).toContain('host=foo');
  });

  it('emits CMD mkdir + echo chain on windows', () => {
    const out = emit('remote_lock_acquire', ['C:\\trt\\lock', ownerEnvB64], 'windows');
    expect(out).toContain('mkdir "C:\\trt\\lock"');
    // First line written with > (overwrite), subsequent with >>
    expect(out).toMatch(/echo host=foo *>"C:\\trt\\lock\\owner\.env"/);
    expect(out).toMatch(/echo pid=123 *>>"C:\\trt\\lock\\owner\.env"/);
  });
});

describe('remote_lock_release adapter', () => {
  it('emits rm -rf on linux', () => {
    const out = emit('remote_lock_release', ['/tmp/lock'], 'linux');
    expect(out).toContain('rm -rf "/tmp/lock"');
  });

  it('emits rmdir /s /q on windows', () => {
    const out = emit('remote_lock_release', ['C:\\trt\\lock'], 'windows');
    expect(out).toContain('rmdir /s /q "C:\\trt\\lock"');
  });
});

describe('remote_read_owner_env adapter', () => {
  it('emits cat on linux', () => {
    const out = emit('remote_read_owner_env', ['/tmp/lock'], 'linux');
    expect(out).toContain('cat "/tmp/lock/owner.env"');
  });

  it('emits type on windows', () => {
    const out = emit('remote_read_owner_env', ['C:\\trt\\lock'], 'windows');
    expect(out).toContain('type "C:\\trt\\lock\\owner.env"');
  });
});

describe('remote_heartbeat_write adapter', () => {
  it('emits POSIX echo redirect on linux', () => {
    const out = emit('remote_heartbeat_write', ['/tmp/lock', '1700000000'], 'linux');
    expect(out).toContain('echo 1700000000 > "/tmp/lock/heartbeat.epoch"');
  });

  it('emits CMD echo redirect on windows (no space before >, preserves trailing-space artifact)', () => {
    const out = emit('remote_heartbeat_write', ['C:\\trt\\lock', '1700000000'], 'windows');
    expect(out).toContain('echo 1700000000>"C:\\trt\\lock\\heartbeat.epoch"');
  });
});

describe('remote_node_modules_link adapter', () => {
  it('emits POSIX ln -s with base-dir pre-check on linux', () => {
    const out = emit('remote_node_modules_link', ['/lane/node_modules', '/base/node_modules'], 'linux');
    expect(out).toContain('[ -d "/base/node_modules" ]');
    expect(out).toContain('ln -s "/base/node_modules" "/lane/node_modules"');
  });

  it('emits mklink /D cascade on windows', () => {
    const out = emit('remote_node_modules_link', ['C:\\lane\\node_modules', 'C:\\base\\node_modules'], 'windows');
    expect(out).toContain('mklink /D');
    expect(out).toContain('C:\\lane\\node_modules');
    expect(out).toContain('C:\\base\\node_modules');
  });
});

describe('remote_node_modules_unlink adapter', () => {
  it('emits link-guarded rm on linux', () => {
    const out = emit('remote_node_modules_unlink', ['/lane/node_modules'], 'linux');
    expect(out).toContain('[ -L "/lane/node_modules" ]');
    expect(out).toContain('rm "/lane/node_modules"');
  });

  it('emits rmdir without /S on windows (safety: refuses real dirs)', () => {
    const out = emit('remote_node_modules_unlink', ['C:\\lane\\node_modules'], 'windows');
    expect(out).toContain('rmdir "C:\\lane\\node_modules"');
    expect(out).not.toContain('/S');
    expect(out).not.toContain('/s');
  });
});

describe('remote_bundle_extract adapter', () => {
  it('emits mkdir + tar -xf on linux', () => {
    const out = emit('remote_bundle_extract', ['/tmp/bundle.tar', '/tmp/extract'], 'linux');
    expect(out).toContain('mkdir -p "/tmp/extract"');
    expect(out).toContain('tar -xf "/tmp/bundle.tar"');
    expect(out).toContain('-C "/tmp/extract"');
  });

  it('emits PowerShell New-Item + tar on windows', () => {
    const out = emit('remote_bundle_extract', ['C:\\tmp\\bundle.tar', 'C:\\tmp\\extract'], 'windows');
    expect(out).toContain('powershell');
    expect(out).toContain('-EncodedCommand');
  });
});

describe('remote_bundle_cleanup adapter', () => {
  it('emits rm -f on linux', () => {
    const out = emit('remote_bundle_cleanup', ['/tmp/bundle.tar'], 'linux');
    expect(out).toContain('rm -f "/tmp/bundle.tar"');
  });

  it('emits PowerShell Remove-Item with retry on windows', () => {
    const out = emit('remote_bundle_cleanup', ['C:\\tmp\\bundle.tar'], 'windows');
    expect(out).toContain('powershell');
    expect(out).toContain('-EncodedCommand');
  });
});
