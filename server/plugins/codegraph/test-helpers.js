'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { gitSync, cleanupRepo } = require('../../tests/git-test-utils');

function git(cwd, args) {
  gitSync(args, { cwd });
}

function setupTinyRepo(prefix = 'cg-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function alpha() { return beta(); }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'function beta() { return 1; }\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init', '--no-gpg-sign']);
  return dir;
}

function destroyTinyRepo(dir) {
  cleanupRepo(dir);
}

module.exports = { setupTinyRepo, destroyTinyRepo, git };
