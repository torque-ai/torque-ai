'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
// server/tests/worker-setup.js stubs child_process.{execFileSync,spawnSync}
// to return fake values like 'abcdef1234567890' for `git rev-parse HEAD`,
// preventing orphaned git.exe processes on Windows. Test-helpers.js restores
// the originals — but only by virtue of being imported. cgDiff under test
// also calls execFileSync internally, so we need the real implementation in
// scope when the test creates a fixture repo AND when cgDiff diffs it.
if (childProcess._realExecFileSync) childProcess.execFileSync = childProcess._realExecFileSync;
const { execFileSync } = childProcess;
const { cgDiff } = require('../queries/diff');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' };

function git(repo, ...args) {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function gitVoid(repo, ...args) {
  execFileSync('git', args, {
    cwd: repo, windowsHide: true, env: GIT_ENV,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-diff-'));
  gitVoid(repo, 'init', '-q', '-b', 'main');
  gitVoid(repo, 'config', 'user.email', 't@t');
  gitVoid(repo, 'config', 'user.name',  't');
  return repo;
}

function commitFile(repo, file, content, msg) {
  fs.writeFileSync(path.join(repo, file), content);
  gitVoid(repo, 'add', file);
  gitVoid(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

function rmFile(repo, file, msg) {
  fs.unlinkSync(path.join(repo, file));
  gitVoid(repo, 'add', '-A');
  gitVoid(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('cg_diff', () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('diffs an added symbol in a modified file', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    const sha2 = commitFile(repo, 'a.js', 'function alpha() {}\nfunction beta() {}\n', 'add beta');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.added_symbols.find((s) => s.name === 'beta')).toBeTruthy();
    expect(r.removed_symbols).toHaveLength(0);
    expect(r.changed_files.modified).toContain('a.js');
    expect(r.truncated).toBe(false);
  });

  it('diffs a removed symbol in a modified file', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\nfunction beta() {}\n', 'init');
    const sha2 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'remove beta');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.removed_symbols.find((s) => s.name === 'beta')).toBeTruthy();
    expect(r.added_symbols).toHaveLength(0);
  });

  it('diffs a fully added file (every symbol counted as added)', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    const sha2 = commitFile(repo, 'b.js', 'function gamma() {}\n', 'add b.js');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.added_symbols.find((s) => s.name === 'gamma' && s.file === 'b.js')).toBeTruthy();
    expect(r.changed_files.added).toContain('b.js');
    // a.js wasn't modified — alpha not in either list.
    expect(r.added_symbols.find((s) => s.name === 'alpha')).toBeUndefined();
    expect(r.removed_symbols.find((s) => s.name === 'alpha')).toBeUndefined();
  });

  it('diffs a fully removed file (every symbol counted as removed)', async () => {
    commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    // sha1 has b.js; sha2 has b.js removed. Diff sha1→sha2 surfaces gamma
    // as removed. (Diffing init→sha2 would show no net change for b.js
    // since it was added and then removed in between.)
    const sha1 = commitFile(repo, 'b.js', 'function gamma() {}\n', 'add b.js');
    const sha2 = rmFile(repo, 'b.js', 'rm b.js');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.removed_symbols.find((s) => s.name === 'gamma' && s.file === 'b.js')).toBeTruthy();
    expect(r.changed_files.deleted).toContain('b.js');
  });

  it('does NOT report a function as add+remove just because it moved within a file', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() { return 1; }\nfunction beta() {}\n', 'init');
    // Same symbols, different order (alpha moved to bottom).
    const sha2 = commitFile(repo, 'a.js', 'function beta() {}\nfunction alpha() { return 1; }\n', 'reorder');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    // changed_files records the modify but symbol set is unchanged.
    expect(r.changed_files.modified).toContain('a.js');
    expect(r.added_symbols.find((s) => s.name === 'alpha')).toBeUndefined();
    expect(r.removed_symbols.find((s) => s.name === 'alpha')).toBeUndefined();
    expect(r.added_symbols.find((s) => s.name === 'beta')).toBeUndefined();
    expect(r.removed_symbols.find((s) => s.name === 'beta')).toBeUndefined();
  });

  it('records non-indexable file changes in skipped_files (e.g. .md)', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    const sha2 = commitFile(repo, 'README.md', '# notes\n', 'add readme');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.skipped_files).toContain('README.md');
    expect(r.added_symbols).toHaveLength(0);
  });

  it('truncates with no symbol diff when the changed-file set exceeds max_files', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    // Touch 6 files; with max_files=3 we should hit the truncation branch.
    fs.writeFileSync(path.join(repo, 'b.js'), 'function b1() {}\n');
    fs.writeFileSync(path.join(repo, 'c.js'), 'function c1() {}\n');
    fs.writeFileSync(path.join(repo, 'd.js'), 'function d1() {}\n');
    fs.writeFileSync(path.join(repo, 'e.js'), 'function e1() {}\n');
    fs.writeFileSync(path.join(repo, 'f.js'), 'function f1() {}\n');
    fs.writeFileSync(path.join(repo, 'g.js'), 'function g1() {}\n');
    gitVoid(repo, 'add', '-A');
    gitVoid(repo, 'commit', '-q', '-m', 'add 6 files');
    const sha2 = git(repo, 'rev-parse', 'HEAD');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2, maxFiles: 3 });
    expect(r.truncated).toBe(true);
    expect(r.max_files).toBe(3);
    expect(r.total_files_changed).toBe(6);
    expect(r.added_symbols).toHaveLength(0);   // skipped — truncated
    expect(r.removed_symbols).toHaveLength(0);
    expect(r.truncation_hint).toMatch(/exceeds the 3-file cap/);
  });

  it('throws when from_sha or to_sha is unreachable in the repo', async () => {
    const sha1 = commitFile(repo, 'a.js', 'x\n', 'init');
    await expect(cgDiff({ repoPath: repo, fromSha: 'deadbeef00000000', toSha: sha1 }))
      .rejects.toThrow(/from_sha not reachable/);
    await expect(cgDiff({ repoPath: repo, fromSha: sha1, toSha: 'beefdead00000000' }))
      .rejects.toThrow(/to_sha not reachable/);
  });

  it('flags signature changes (sync → async) without reporting add+remove', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function foo() { return 1; }\n', 'init');
    const sha2 = commitFile(repo, 'a.js', 'async function foo() { return 1; }\n', 'flip async');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.added_symbols).toHaveLength(0);
    expect(r.removed_symbols).toHaveLength(0);
    expect(r.signature_changed_symbols).toHaveLength(1);
    const sig = r.signature_changed_symbols[0];
    expect(sig.name).toBe('foo');
    expect(sig.file).toBe('a.js');
    expect(sig.changed.isAsync).toEqual({ from: false, to: true });
    expect(sig.from_flags.isAsync).toBe(false);
    expect(sig.to_flags.isAsync).toBe(true);
  });

  it('treats a content-stable file rename as 0 added / 0 removed and lists it under changed_files.renamed', async () => {
    const sha1 = commitFile(repo, 'a.js', 'function foo() { return 1; }\n', 'init');
    fs.renameSync(path.join(repo, 'a.js'), path.join(repo, 'b.js'));
    gitVoid(repo, 'add', '-A');
    gitVoid(repo, 'commit', '-q', '-m', 'rename a→b');
    const sha2 = git(repo, 'rev-parse', 'HEAD');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.added_symbols).toHaveLength(0);
    expect(r.removed_symbols).toHaveLength(0);
    expect(r.signature_changed_symbols).toHaveLength(0);
    expect(r.changed_files.renamed).toHaveLength(1);
    expect(r.changed_files.renamed[0]).toEqual({ from: 'a.js', to: 'b.js' });
    // Old shape kept these out of added/deleted; new shape continues to.
    expect(r.changed_files.added).not.toContain('b.js');
    expect(r.changed_files.deleted).not.toContain('a.js');
    expect(r.total_files_changed).toBe(1);
  });

  it('within a rename, surfaces real symbol additions and signature flips', async () => {
    // Body is large enough that the small async/bar additions keep the
    // rename above git's -M50% similarity threshold (otherwise the rename
    // decomposes into add+delete and changed_files.renamed is empty).
    const body = 'function foo() {\n  // shared body keeps similarity > 50%\n  return 1;\n  return 2;\n  return 3;\n  return 4;\n}\n';
    const sha1 = commitFile(repo, 'a.js', body, 'init');
    fs.renameSync(path.join(repo, 'a.js'), path.join(repo, 'b.js'));
    fs.writeFileSync(path.join(repo, 'b.js'),
      body.replace('function foo()', 'async function foo()') + 'function bar() {}\n');
    gitVoid(repo, 'add', '-A');
    gitVoid(repo, 'commit', '-q', '-m', 'rename + edit');
    const sha2 = git(repo, 'rev-parse', 'HEAD');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    expect(r.changed_files.renamed[0]).toEqual({ from: 'a.js', to: 'b.js' });
    expect(r.added_symbols.find((s) => s.name === 'bar' && s.file === 'b.js')).toBeTruthy();
    expect(r.removed_symbols).toHaveLength(0);
    const sig = r.signature_changed_symbols.find((s) => s.name === 'foo');
    expect(sig).toBeTruthy();
    expect(sig.changed.isAsync).toEqual({ from: false, to: true });
  });

  it('captures the container of an added method', async () => {
    const sha1 = commitFile(repo, 'a.js',
      'class Animal { speak() {} }\n', 'init');
    const sha2 = commitFile(repo, 'a.js',
      'class Animal { speak() {} bark() {} }\n', 'add bark');

    const r = await cgDiff({ repoPath: repo, fromSha: sha1, toSha: sha2 });
    const bark = r.added_symbols.find((s) => s.name === 'bark');
    expect(bark).toBeTruthy();
    expect(bark.container).toBe('Animal');
  });
});
