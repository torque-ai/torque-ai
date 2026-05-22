'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestRepo, commitAll, cleanupRepo } = require('./git-test-utils');
const { listProjectFiles, DEFAULT_IGNORE_DIRS } = require('../utils/project-files');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'projfiles-'));
}

test('listProjectFiles excludes gitignored directories in a git repo', () => {
  const dir = createTestRepo('projfiles-git');
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Library/\n');
    fs.writeFileSync(path.join(dir, 'main.cs'), 'class A {}');
    fs.mkdirSync(path.join(dir, 'Library'));
    fs.writeFileSync(path.join(dir, 'Library', 'generated.cs'), 'class Gen {}');
    commitAll(dir, 'init');

    const files = listProjectFiles(dir);
    const rels = files.map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('main.cs');
    expect(rels).toContain('.gitignore');
    expect(rels.some(r => r.startsWith('Library/'))).toBe(false);

    // The git code path must produce the same file-object shape as the
    // non-git fallback (covered separately below).
    const main = files.find(f => f.name === 'main.cs');
    expect(main).toMatchObject({ name: 'main.cs', ext: '.cs', lines: null });
    expect(typeof main.path).toBe('string');
    expect(typeof main.relativePath).toBe('string');
    expect(main.size).toBe('class A {}'.length);
  } finally {
    cleanupRepo(dir);
  }
});

test('listProjectFiles keeps files rescued by a gitignore negation', () => {
  const dir = createTestRepo('projfiles-git');
  try {
    // Use `build/*` (not `build/`) so that git's negation rule can apply —
    // git cannot un-ignore files inside a directory that is itself ignored.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/*\n!build/keep.txt\n');
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'build', 'drop.txt'), 'drop');
    fs.writeFileSync(path.join(dir, 'root.txt'), 'root');
    commitAll(dir, 'init');

    const rels = listProjectFiles(dir).map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('build/keep.txt');
    expect(rels).not.toContain('build/drop.txt');
  } finally {
    cleanupRepo(dir);
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

test('listProjectFiles excludes prefix-ignored directories in the non-git fallback', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'x');
    fs.mkdirSync(path.join(dir, '.tmp-foo'));
    fs.writeFileSync(path.join(dir, '.tmp-foo', 'scratch.js'), 'y');

    const rels = listProjectFiles(dir).map(f => f.relativePath.replace(/\\/g, '/'));
    expect(rels).toContain('app.js');
    expect(rels.some(r => r.startsWith('.tmp-foo/'))).toBe(false);
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
