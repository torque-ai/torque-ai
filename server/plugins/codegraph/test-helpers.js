'use strict';

const childProcess = require('child_process');
// server/tests/worker-setup.js stubs child_process.{execFileSync,execFile,spawnSync}
// to prevent orphaned git.exe processes on Windows. Restore the originals here
// so setupTinyRepo can run real git for fixture creation. Mirrors the pattern
// in server/tests/git-test-utils.js. No-op outside vitest (the _real* slots are
// only set by worker-setup.js).
if (childProcess._realExecFileSync) childProcess.execFileSync = childProcess._realExecFileSync;
if (childProcess._realExecFile) childProcess.execFile = childProcess._realExecFile;
if (childProcess._realSpawnSync) childProcess.spawnSync = childProcess._realSpawnSync;

const { execFileSync } = childProcess;
const fs = require('fs');
const path = require('path');
const os = require('os');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function setupTinyRepo(prefix = 'cg-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function alpha() { return beta(); }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'function beta() { return 1; }\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return dir;
}

function destroyTinyRepo(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { setupTinyRepo, destroyTinyRepo, git };
