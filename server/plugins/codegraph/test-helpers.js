'use strict';

const { execFileSync } = require('child_process');
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
