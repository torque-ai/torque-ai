'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { cgDiff } = require('../queries/diff');

const GIT_OPTS = {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
};

function git(repo, ...args) {
  return execFileSync('git', args, { ...GIT_OPTS, cwd: repo, encoding: 'utf8' }).trim();
}
function gitVoid(repo, ...args) {
  execFileSync('git', args, { ...GIT_OPTS, cwd: repo });
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
    const sha1 = commitFile(repo, 'a.js', 'function alpha() {}\n', 'init');
    commitFile(repo, 'b.js', 'function gamma() {}\n', 'add b.js');
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
