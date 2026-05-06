'use strict';

const fs = require('fs');
const path = require('path');

// Linux exposes per-process state via /proc/<pid>/status. The "State:" field
// reports a single-character code:
//   R running   S sleeping (interruptible)   D disk-sleep (uninterruptible)
//   Z zombie    T stopped/traced             X dead (transitional)
//   I idle (kernel thread)                   K wakekill                P parked
//
// process.kill(pid, 0) returns success on zombies because the kernel still
// has a process table entry — but the process is dead and waiting to be
// reaped by its parent. /proc/<pid>/status is the authoritative source on
// Linux, mirroring what Windows tasklist provides for orphan-cleanup Check 4.
//
// Returns:
//   'alive'   — process exists with non-zombie/non-X state
//   'zombie'  — Z (or X transitional) — kernel will reap when parent calls waitpid
//   'dead'    — /proc/<pid>/status missing (ENOENT) — pid no longer in process table
//   'unknown' — unsupported platform (non-Linux), unreadable /proc, or unparseable state
//
// `unknown` is the conservative fallback: callers should NOT force-cleanup on
// 'unknown' since it could mean the check is unavailable on this platform.
//
// `procRoot` defaults to '/proc'; tests override it to a tmpdir fake.
function checkProcStatusLinux(pid, options = {}) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) {
    return 'unknown';
  }
  const procRoot = options.procRoot || '/proc';
  // Only meaningful on Linux. macOS, Windows, BSD do not expose /proc/<pid>/status
  // in the linux-compatible format. The default procRoot=/proc still exists on
  // some platforms (Solaris, FreeBSD with procfs mounted) but the format differs.
  // Tests can override platformOverride to exercise the parser on non-Linux hosts.
  const platform = options.platformOverride || process.platform;
  if (platform !== 'linux') return 'unknown';
  try {
    const statusPath = path.join(procRoot, String(pid), 'status');
    const status = fs.readFileSync(statusPath, 'utf8');
    const stateMatch = status.match(/^State:\s+([A-Z])\b/m);
    if (!stateMatch) return 'unknown';
    const code = stateMatch[1];
    if (code === 'Z' || code === 'X') return 'zombie';
    return 'alive';
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'dead';
    return 'unknown';
  }
}

module.exports = { checkProcStatusLinux };
