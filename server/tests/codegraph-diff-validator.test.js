'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
// server/tests/worker-setup.js stubs child_process.{execFileSync,spawnSync}
// to prevent orphaned git.exe processes on Windows. Restore the originals so
// the test fixture can run real git AND so the validator under test can read
// real HEAD shas through its own childProcess.execFileSync references.
if (childProcess._realExecFileSync) childProcess.execFileSync = childProcess._realExecFileSync;
const { execFileSync } = childProcess;

const {
  inspectPostTaskDiff,
  filterUndeclaredSignatureChanges,
} = require('../validation/codegraph-diff-validator');

const wrap = (payload) => ({ structuredData: payload });

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validator-'));
  gitVoid(repo, 'init', '-q', '-b', 'main');
  gitVoid(repo, 'config', 'user.email', 't@t');
  gitVoid(repo, 'config', 'user.name',  't');
  return repo;
}
function commit(repo, file, content, msg) {
  fs.writeFileSync(path.join(repo, file), content);
  gitVoid(repo, 'add', file);
  gitVoid(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('filterUndeclaredSignatureChanges', () => {
  it('drops symbols the task description names with word boundaries', () => {
    const sigs = [{ name: 'foo' }, { name: 'bar' }, { name: 'doFoo' }];
    const out = filterUndeclaredSignatureChanges(sigs, 'Refactor `foo` for the new flow.');
    // foo is named; doFoo and bar are not.
    expect(out.map((s) => s.name).sort()).toEqual(['bar', 'doFoo']);
  });

  it('keeps everything when description is empty', () => {
    const sigs = [{ name: 'foo' }];
    expect(filterUndeclaredSignatureChanges(sigs, '')).toHaveLength(1);
    expect(filterUndeclaredSignatureChanges(sigs, null)).toHaveLength(1);
  });

  it('treats qualified mention as a hit (Foo.bar matches bar)', () => {
    const sigs = [{ name: 'bar' }];
    const out = filterUndeclaredSignatureChanges(sigs, 'Foo.bar() needs an await');
    expect(out).toEqual([]);
  });

  it('does NOT treat substring as a hit (foo does not match doFoo)', () => {
    const sigs = [{ name: 'foo' }];
    const out = filterUndeclaredSignatureChanges(sigs, 'rename doFoo to doBar');
    expect(out).toHaveLength(1); // foo not actually mentioned
  });
});

describe('inspectPostTaskDiff — graceful skips', () => {
  it('returns ran=false when handlers are null and plugin not loaded', async () => {
    const r = await inspectPostTaskDiff({
      repoPath: '/x', workingDirectory: '/x', fromSha: 'abc', taskDescription: '',
      handlers: null,   // forces the default loader path
    });
    // Default loader returns null outside a running TORQUE.
    expect(r.ran).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('returns ran=false when fromSha is missing', async () => {
    const r = await inspectPostTaskDiff({
      repoPath: '/x', workingDirectory: '/x', fromSha: '',
      taskDescription: '', handlers: { cg_diff: async () => wrap({}) },
    });
    expect(r.ran).toBe(false);
  });

  it('returns ran=false when cg_diff times out', async () => {
    const handlers = {
      cg_diff: () => new Promise(() => {/* never resolves */}),
    };
    const r = await inspectPostTaskDiff({
      repoPath: '/x', workingDirectory: '/x', fromSha: 'abc',
      taskDescription: '', handlers,
    });
    expect(r.ran).toBe(false);
    // Sanity: the promise didn't bring the test runner down.
  }, 10_000);
});

describe('inspectPostTaskDiff — real git fixture, real handlers', () => {
  let repo;
  let sha1;
  let sha2;

  beforeEach(() => {
    repo = makeRepo();
    sha1 = commit(repo, 'a.js', 'function foo() { return 1; }\n', 'init');
    sha2 = commit(repo, 'a.js', 'async function foo() { return 1; }\n', 'flip async');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function realCgDiffHandlers() {
    // Drive the real cg_diff query module directly; we don't need the SQL
    // index for cg_diff because it reads from the git object store and
    // re-extracts symbols on demand.
    const { cgDiff } = require('../plugins/codegraph/queries/diff');
    return {
      cg_diff: async ({ repo_path, from_sha, to_sha, max_files }) => {
        const r = await cgDiff({ repoPath: repo_path, fromSha: from_sha, toSha: to_sha, maxFiles: max_files });
        return wrap(r);
      },
    };
  }

  it('flags sig change when task description does not mention the symbol', async () => {
    const r = await inspectPostTaskDiff({
      repoPath: repo,
      workingDirectory: repo,
      fromSha: sha1,
      taskDescription: 'Some unrelated cleanup that does not name the function.',
      handlers: realCgDiffHandlers(),
    });
    expect(r.ran).toBe(true);
    expect(r.from_sha).toBe(sha1);
    expect(r.to_sha).toBe(sha2);
    expect(r.signature_undeclared.length).toBe(1);
    expect(r.signature_undeclared[0].name).toBe('foo');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe('cg_diff_signature_change_undeclared');
    expect(r.warnings[0].message).toMatch(/foo/);
    expect(r.warnings[0].message).toMatch(/isAsync: false→true/);
  });

  it('does NOT flag when task description names the changed symbol', async () => {
    const r = await inspectPostTaskDiff({
      repoPath: repo,
      workingDirectory: repo,
      fromSha: sha1,
      taskDescription: 'Make `foo` async to match the new contract.',
      handlers: realCgDiffHandlers(),
    });
    expect(r.ran).toBe(true);
    expect(r.signature_undeclared).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('returns ran=false (skip) when fromSha == HEAD (no Codex commits)', async () => {
    const r = await inspectPostTaskDiff({
      repoPath: repo,
      workingDirectory: repo,
      fromSha: sha2,    // already at HEAD
      taskDescription: '',
      handlers: realCgDiffHandlers(),
    });
    expect(r.ran).toBe(false);
    expect(r.from_sha).toBe(sha2);
    expect(r.to_sha).toBe(sha2);
  });
});
