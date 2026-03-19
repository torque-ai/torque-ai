'use strict';

/**
 * agentic-git-safety.test.js — Tests for the git safety net module.
 *
 * Uses real temporary git repositories to verify snapshot/revert/authorize
 * behavior under a variety of scenarios.
 */

// Restore real git — this test creates real repos and the production code
// (agentic-git-safety.js) calls execFileSync('git') directly.
const cp = require('child_process');
if (cp._realExecFileSync) cp.execFileSync = cp._realExecFileSync;
if (cp._realSpawnSync) cp.spawnSync = cp._realSpawnSync;

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { captureSnapshot, checkAndRevert } = require('../providers/agentic-git-safety');

// ---------------------------------------------------------------------------
// Per-test repo setup
// ---------------------------------------------------------------------------

let repoDir;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-git-'));
  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'main.cs'), 'original');
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'build/\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function readFile(rel) {
  return fs.readFileSync(path.join(repoDir, rel), 'utf-8');
}

function writeFile(rel, content) {
  const full = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function fileExists(rel) {
  return fs.existsSync(path.join(repoDir, rel));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureSnapshot', () => {
  it('returns empty sets in a clean repo', () => {
    const snap = captureSnapshot(repoDir);
    expect(snap.isGitRepo).toBe(true);
    expect(snap.dirtyFiles.size).toBe(0);
    expect(snap.untrackedFiles.size).toBe(0);
  });

  it('captures pre-existing dirty tracked file', () => {
    writeFile('main.cs', 'modified');
    const snap = captureSnapshot(repoDir);
    expect(snap.dirtyFiles.has('main.cs')).toBe(true);
  });

  it('captures pre-existing untracked file', () => {
    writeFile('new-file.cs', 'hello');
    const snap = captureSnapshot(repoDir);
    expect(snap.untrackedFiles.has('new-file.cs')).toBe(true);
  });

  it('returns isGitRepo: false for non-git directory', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-nongit-'));
    try {
      const snap = captureSnapshot(nonGit);
      expect(snap.isGitRepo).toBe(false);
      expect(snap.dirtyFiles.size).toBe(0);
      expect(snap.untrackedFiles.size).toBe(0);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('checkAndRevert — no changes', () => {
  it('returns empty reverted and kept arrays when nothing changed after snapshot', () => {
    const snap = captureSnapshot(repoDir);
    const result = checkAndRevert(repoDir, snap, 'update AccountService', 'enforce');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.report).toBe('');
  });
});

describe('checkAndRevert — authorized change', () => {
  it('keeps a dirty tracked file whose name appears in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'changed by task');
    // "main.cs" appears in the description → authorized
    const result = checkAndRevert(repoDir, snap, 'refactor main.cs to use async', 'enforce');
    expect(result.kept).toContain('main.cs');
    expect(result.reverted).not.toContain('main.cs');
    // File should still have the new content
    expect(readFile('main.cs')).toBe('changed by task');
  });

  it('keeps a new file whose parent directory name appears in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('Accounting/Account.cs', 'new accounting file');
    const result = checkAndRevert(repoDir, snap, 'add Accounting module', 'enforce');
    // 'Accounting' is a path component → authorized
    expect(result.kept.some(f => f.includes('Account.cs'))).toBe(true);
    expect(fileExists('Accounting/Account.cs')).toBe(true);
  });
});

describe('checkAndRevert — unauthorized tracked file change', () => {
  it('reverts a dirty tracked file not mentioned in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized modification');
    const result = checkAndRevert(repoDir, snap, 'update README', 'enforce');
    expect(result.reverted).toContain('main.cs');
    expect(result.kept).not.toContain('main.cs');
    // File should be restored to original content
    expect(readFile('main.cs')).toBe('original');
  });

  it('includes reverted files in the report string', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized');
    const result = checkAndRevert(repoDir, snap, 'fix typo in docs', 'enforce');
    expect(result.report).toMatch(/Reverted 1 unauthorized change/);
    expect(result.report).toContain('main.cs');
  });
});

describe('checkAndRevert — unauthorized new file', () => {
  it('deletes an untracked file not mentioned in the task description', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('stray.tmp', 'surprise file');
    const result = checkAndRevert(repoDir, snap, 'update Invoice model', 'enforce');
    expect(result.reverted.some(f => f.includes('stray.tmp'))).toBe(true);
    expect(fileExists('stray.tmp')).toBe(false);
  });
});

describe('checkAndRevert — gitignored new file', () => {
  it('keeps a new file that matches a .gitignore pattern (not deleted)', () => {
    const snap = captureSnapshot(repoDir);
    // 'build/' is in .gitignore
    writeFile('build/output.dll', 'compiled');
    const result = checkAndRevert(repoDir, snap, 'compile project', 'enforce');
    // git check-ignore should recognize build/ files as ignored
    const buildFiles = result.kept.filter(f => f.includes('build'));
    // If git check-ignore is available and works, file stays
    // (some CI envs may not have the .gitignore respected at nested level — verify existence)
    expect(fileExists('build/output.dll')).toBe(true);
    expect(result.reverted.filter(f => f.includes('build'))).toHaveLength(0);
  });
});

describe('checkAndRevert — pre-existing dirty state preserved', () => {
  it('does not revert files that were already dirty before snapshot', () => {
    // Dirty main.cs BEFORE taking snapshot
    writeFile('main.cs', 'pre-existing modification');
    const snap = captureSnapshot(repoDir);
    // No new changes after snapshot
    const result = checkAndRevert(repoDir, snap, 'update README', 'enforce');
    expect(result.reverted).not.toContain('main.cs');
    // Content remains the pre-existing modification
    expect(readFile('main.cs')).toBe('pre-existing modification');
  });

  it('does not revert pre-existing untracked files', () => {
    writeFile('pre-existing.cs', 'was here before');
    const snap = captureSnapshot(repoDir);
    // No additional changes
    const result = checkAndRevert(repoDir, snap, 'unrelated task', 'enforce');
    expect(result.reverted.some(f => f.includes('pre-existing.cs'))).toBe(false);
    expect(fileExists('pre-existing.cs')).toBe(true);
  });
});

describe('checkAndRevert — mode=warn', () => {
  it('does not revert unauthorized changes but includes them in the report', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'unauthorized in warn mode');
    const result = checkAndRevert(repoDir, snap, 'update README', 'warn');
    // File should NOT be reverted
    expect(readFile('main.cs')).toBe('unauthorized in warn mode');
    // Should be in kept (not reverted)
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toContain('main.cs');
  });

  it('does not delete unauthorized new files in warn mode', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('sneaky.cs', 'surprise');
    const result = checkAndRevert(repoDir, snap, 'update Invoice', 'warn');
    expect(fileExists('sneaky.cs')).toBe(true);
    expect(result.reverted).toHaveLength(0);
  });
});

describe('checkAndRevert — mode=off', () => {
  it('skips all checks and returns empty results', () => {
    const snap = captureSnapshot(repoDir);
    writeFile('main.cs', 'modified');
    writeFile('extra.cs', 'new file');
    const result = checkAndRevert(repoDir, snap, 'unrelated task', 'off');
    expect(result.reverted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.report).toBe('');
    // Files should be untouched
    expect(readFile('main.cs')).toBe('modified');
    expect(fileExists('extra.cs')).toBe(true);
  });
});

describe('checkAndRevert — non-git directory', () => {
  it('returns empty results gracefully when snapshot has isGitRepo: false', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-nongit-'));
    try {
      const snap = captureSnapshot(nonGit);
      expect(snap.isGitRepo).toBe(false);
      const result = checkAndRevert(nonGit, snap, 'any task', 'enforce');
      expect(result.reverted).toHaveLength(0);
      expect(result.kept).toHaveLength(0);
      expect(result.report).toBe('');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
