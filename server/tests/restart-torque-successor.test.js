'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  tryLoadBetterSqlite3,
  waitForFileUnlock,
  ensureBetterSqliteUsable,
  getBetterSqliteBinaryPath,
} = require('../../scripts/restart-torque-successor');

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `torque-restart-test-${prefix}-`));
}

function makeFakeBetterSqliteModule(serverDir) {
  const pkgDir = path.join(serverDir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-test', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    'module.exports = { __fake: true };\n',
  );
  // Materialize the .node binary path so getBetterSqliteBinaryPath + waitForFileUnlock
  // see a real file when the orchestration probes for one.
  const binDir = path.join(pkgDir, 'build', 'Release');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'better_sqlite3.node'), Buffer.from([0]));
  return pkgDir;
}

describe('getBetterSqliteBinaryPath', () => {
  it('returns the conventional .node path under serverDir', () => {
    const result = getBetterSqliteBinaryPath('/srv');
    expect(result).toMatch(/better-sqlite3/);
    expect(result).toMatch(/better_sqlite3\.node$/);
  });
});

describe('waitForFileUnlock', () => {
  it('returns true immediately when the file does not exist', async () => {
    const tmp = mktmp('unlock-missing');
    try {
      const ok = await waitForFileUnlock(path.join(tmp, 'nope.node'), 1000, 100);
      expect(ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when the file exists and is openable', async () => {
    const tmp = mktmp('unlock-open');
    try {
      const f = path.join(tmp, 'addon.node');
      fs.writeFileSync(f, Buffer.from([0]));
      const ok = await waitForFileUnlock(f, 1000, 100);
      expect(ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects the budget and returns false when the file never unlocks', async () => {
    // Simulate a perpetually-locked file by creating a regular file and
    // chmod'ing it read-only. fs.openSync(path, 'r+') needs write access,
    // so it fails with EACCES/EPERM on both POSIX and Windows. The earlier
    // version pointed at a directory, but Windows happily opens directories
    // r+ which made waitForFileUnlock return true after one attempt — flaky
    // on Windows, working on POSIX.
    const tmp = mktmp('unlock-locked');
    const f = path.join(tmp, 'readonly.node');
    try {
      fs.writeFileSync(f, Buffer.from([0]));
      fs.chmodSync(f, 0o444);  // read-only — r+ open fails with EPERM/EACCES
      const start = Date.now();
      // budget=300ms, interval=100ms — should bail in ~300-400ms
      const ok = await waitForFileUnlock(f, 300, 100);
      const elapsed = Date.now() - start;
      expect(ok).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      // Restore writable bit so rmSync can delete the file on Windows.
      try { fs.chmodSync(f, 0o644); } catch { /* may not exist if writeFile failed */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('tryLoadBetterSqlite3', () => {
  it('returns loaded:true when the module exists and requires cleanly', () => {
    const tmp = mktmp('try-load-ok');
    try {
      const serverDir = path.join(tmp, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      makeFakeBetterSqliteModule(serverDir);
      const result = tryLoadBetterSqlite3(process.execPath, serverDir, process.env);
      expect(result.loaded).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns loaded:false with an error when the module is missing', () => {
    const tmp = mktmp('try-load-missing');
    try {
      const serverDir = path.join(tmp, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      const result = tryLoadBetterSqlite3(process.execPath, serverDir, process.env);
      expect(result.loaded).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ensureBetterSqliteUsable', () => {
  it('takes the fast path: probe passes → no rebuild attempted', async () => {
    const tmp = mktmp('ensure-fast');
    try {
      const serverDir = path.join(tmp, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      makeFakeBetterSqliteModule(serverDir);

      // npm spawner that throws if invoked — proves we never call rebuild on the fast path.
      const npm = {
        command: 'should-never-run',
        argsPrefix: [],
      };

      const result = await ensureBetterSqliteUsable(npm, serverDir, process.env);
      expect(result.usable).toBe(true);
      expect(result.rebuilt).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns usable:false when probe fails AND rebuild attempts fail', async () => {
    const tmp = mktmp('ensure-broken');
    try {
      const serverDir = path.join(tmp, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      // Don't materialize better-sqlite3 — probe will fail with module-not-found.
      // npm command is set to a binary that exits non-zero, so all rebuild attempts fail.
      const fakeNpmBin = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
        : '/usr/bin/false';
      const npm = {
        command: fakeNpmBin,
        argsPrefix: process.platform === 'win32' ? ['/c', 'exit', '1'] : [],
      };
      const result = await ensureBetterSqliteUsable(npm, serverDir, process.env, { cwd: tmp });
      expect(result.usable).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});
