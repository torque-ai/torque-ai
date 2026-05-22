'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
// Use the real (unpatched) execFileSync — worker-setup.js stubs git calls on
// the patched version, but initGitRepo needs to actually create git repos on disk.
const execFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
const { listProjectFiles, DEFAULT_IGNORE_DIRS } = require('../utils/project-files');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'projfiles-'));
}

function initGitRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init'], opts);
  execFileSync('git', ['config', 'user.email', 'torque-test'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], opts);
}

test('listProjectFiles excludes gitignored directories in a git repo', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Library/\n');
    fs.writeFileSync(path.join(dir, 'main.cs'), 'class A {}');
    fs.mkdirSync(path.join(dir, 'Library'));
    fs.writeFileSync(path.join(dir, 'Library', 'generated.cs'), 'class Gen {}');
    initGitRepo(dir);

    const files = listProjectFiles(dir);
    const rels = files.map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('main.cs');
    expect(rels).toContain('.gitignore');
    expect(rels.some(r => r.startsWith('Library/'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listProjectFiles keeps files rescued by a gitignore negation', () => {
  const dir = mkTmp();
  try {
    // Use `build/*` (not `build/`) so that git's negation rule can apply —
    // git cannot un-ignore files inside a directory that is itself ignored.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/*\n!build/keep.txt\n');
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'build', 'drop.txt'), 'drop');
    fs.writeFileSync(path.join(dir, 'root.txt'), 'root');
    initGitRepo(dir);

    const rels = listProjectFiles(dir).map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('build/keep.txt');
    expect(rels).not.toContain('build/drop.txt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listProjectFiles falls back to a filtered walk for a non-git directory', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'y');
    fs.mkdirSync(path.join(dir, 'Library'));
    fs.writeFileSync(path.join(dir, 'Library', 'gen.js'), 'z');

    const rels = listProjectFiles(dir).map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('app.js');
    expect(rels.some(r => r.startsWith('node_modules/'))).toBe(false);
    expect(rels.some(r => r.startsWith('Library/'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listProjectFiles returns walkDir-shaped file objects', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    const files = listProjectFiles(dir);
    const a = files.find(f => f.name === 'a.txt');
    expect(a).toBeTruthy();
    expect(a).toMatchObject({ name: 'a.txt', ext: '.txt', lines: null });
    expect(typeof a.path).toBe('string');
    expect(typeof a.relativePath).toBe('string');
    expect(a.size).toBe(5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_IGNORE_DIRS includes Unity and common build directories', () => {
  for (const d of ['Library', 'PackageCache', 'node_modules', 'bin', 'obj', 'target']) {
    expect(DEFAULT_IGNORE_DIRS).toContain(d);
  }
});
