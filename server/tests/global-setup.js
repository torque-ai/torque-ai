/**
 * Vitest globalSetup — runs once before any workers start.
 * Creates a serialized DB buffer that test files use via db.resetForTest()
 * instead of copying files and clearing module caches.
 *
 * Also snapshots pre-existing git.exe PIDs and kills orphans on teardown.
 * The primary defense against orphaned git processes is in git-test-utils.js
 * (windowsHide, timeout, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, etc.),
 * but this teardown acts as a safety net for any that slip through.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TEMPLATE_DIR = path.join(os.tmpdir(), 'torque-vitest-template');
const TEMPLATE_BUF = path.join(TEMPLATE_DIR, 'template.db.buf');
const TEMPLATE_STAMP = path.join(TEMPLATE_DIR, '.ready');

/** Snapshot git.exe PIDs before the suite runs (Windows only). */
let preExistingGitPids = new Set();

function snapshotGitPids() {
  if (process.platform !== 'win32') return new Set();
  try {
    // tasklist is ~10x faster than PowerShell Get-Process (~30ms vs ~260ms)
    const out = execFileSync('tasklist', [
      '/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'
    ], { timeout: 5000, encoding: 'utf8', windowsHide: true }).trim();
    if (!out || out.startsWith('INFO:')) return new Set();
    const pids = out.split('\r\n')
      .map(line => { const m = line.match(/"git\.exe","(\d+)"/); return m ? Number(m[1]) : null; })
      .filter(Boolean);
    return new Set(pids);
  } catch { return new Set(); }
}

/**
 * Also snapshot git-remote-https.exe and other git helper processes.
 * On Windows, git spawns helper subprocesses that can outlive the parent.
 */
function snapshotAllGitPids() {
  if (process.platform !== 'win32') return new Set();
  const pids = new Set();
  for (const processName of ['git.exe', 'git-remote-https.exe', 'git-credential-manager.exe']) {
    try {
      const out = execFileSync('tasklist', [
        '/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'
      ], { timeout: 5000, encoding: 'utf8', windowsHide: true }).trim();
      if (!out || out.startsWith('INFO:')) continue;
      for (const line of out.split('\r\n')) {
        const m = line.match(/"[^"]+","(\d+)"/);
        if (m) pids.add(Number(m[1]));
      }
    } catch { /* ok */ }
  }
  return pids;
}

/**
 * Kill git.exe (and helper) processes that were NOT running before the test suite.
 * These are orphaned processes left behind by vitest worker forks on Windows
 * (Windows doesn't propagate signals to child processes when a fork exits).
 */
function cleanupOrphanedGitProcesses() {
  if (process.platform !== 'win32') return 0;
  if (process.env.CI) return 0; // CI runners are ephemeral — no need to clean up
  try {
    const currentPids = snapshotAllGitPids();
    const orphans = [...currentPids].filter(pid => !preExistingGitPids.has(pid));
    if (orphans.length === 0) return 0;

    // Kill orphaned git processes using taskkill (faster than PowerShell)
    for (const pid of orphans) {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], {
          timeout: 5000, stdio: 'ignore', windowsHide: true
        });
      } catch { /* process may have already exited */ }
    }

    return orphans.length;
  } catch { return 0; }
}

module.exports = async function setup() {
  // Snapshot existing git processes (including helpers) before the suite
  preExistingGitPids = snapshotAllGitPids();

  // Create template DB with full schema applied
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });

  const origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = TEMPLATE_DIR;

  // Clear module cache to ensure fresh init
  delete require.cache[require.resolve('../database')];
  const db = require('../database');
  db.init();

  // Remove seeded hosts to prevent real Ollama probes in tests
  try {
    const hosts = db.listOllamaHosts ? db.listOllamaHosts() : [];
    for (const host of hosts) {
      if (db.removeOllamaHost) db.removeOllamaHost(host.id);
    }
  } catch { /* ok */ }

  // Checkpoint WAL and switch to DELETE journal mode before serializing.
  // In-memory DBs created from WAL-mode buffers fail with SQLITE_CANTOPEN.
  const inst = db.getDbInstance();
  inst.pragma('wal_checkpoint(TRUNCATE)');
  inst.pragma('journal_mode = DELETE');

  // Serialize the initialized DB to a buffer file
  const buffer = inst.serialize();
  fs.writeFileSync(TEMPLATE_BUF, buffer);

  db.close();

  // Restore env
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
  delete require.cache[require.resolve('../database')];

  // Stamp indicates the template is ready
  fs.writeFileSync(TEMPLATE_STAMP, String(Date.now()));

  // Return teardown function
  return async function teardown() {
    // Safety net: kill any orphaned git processes spawned during the test suite.
    // On Windows, vitest worker forks don't propagate signals to child processes,
    // so git.exe processes from execFileSync calls inside async close handlers
    // can survive after the worker exits.
    const killed = cleanupOrphanedGitProcesses();
    if (killed > 0) {
      console.log(`[global-teardown] Cleaned up ${killed} orphaned git process(es)`);
    }

    // NOTE: Do NOT delete TEMPLATE_DIR here. Late-starting workers in the
    // forks pool may still be reading template.db.buf when teardown runs.
    // The directory is overwritten on the next vitest run anyway.
  };
};
