'use strict';

/**
 * Per-worker vitest setup — orphaned git.exe process cleanup.
 *
 * On Windows, vitest worker forks don't propagate SIGTERM to child
 * processes spawned by execFileSync('git', ...). When a worker is
 * killed (timeout, SIGTERM, etc.), git.exe children survive as orphans.
 *
 * This setup file runs inside each worker fork and:
 * 1. Snapshots git.exe PIDs at worker start
 * 2. Registers process.on('exit') to kill any NEW git.exe processes
 *
 * Combined with Part 1 (safeGitExec mandatory timeouts), this provides
 * defense-in-depth against orphaned git processes.
 */

const { execFileSync } = require('child_process');

if (process.platform === 'win32') {
  let workerGitPids;
  try {
    workerGitPids = snapshotGitPids();
  } catch {
    workerGitPids = new Set();
  }

  // Kill orphaned git.exe on worker exit (fires on normal exit and SIGTERM)
  process.on('exit', () => {
    try {
      const currentPids = snapshotGitPids();
      for (const pid of currentPids) {
        if (!workerGitPids.has(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch { /* already exited */ }
        }
      }
    } catch { /* best-effort cleanup */ }
  });
}

function snapshotGitPids() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'], {
    timeout: 3000, encoding: 'utf8', windowsHide: true,
  }).trim();
  if (!out || out.startsWith('INFO:')) return new Set();
  return new Set(
    out.split('\r\n')
      .map(line => { const m = line.match(/"git\.exe","(\d+)"/); return m ? Number(m[1]) : null; })
      .filter(Boolean)
  );
}
