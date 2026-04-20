'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  reclaimDir,
  forceRmDir,
} = require('../factory/worktree-reconcile');

let testDir;

// Build a deeply nested directory tree that exceeds Windows MAX_PATH (260 chars).
// Each level adds ~10 chars ("l00_abcde/"), so 30 levels ≈ 300 chars of nesting.
function createDeeplyNested(root, depth = 30) {
  let current = root;
  for (let i = 0; i < depth; i++) {
    const segment = `l${String(i).padStart(2, '0')}_abcde`;
    current = path.join(current, segment);
  }
  fs.mkdirSync(current, { recursive: true });
  // Drop a file at the deepest level so there's something to delete.
  fs.writeFileSync(path.join(current, 'leaf.txt'), 'deep', 'utf8');
  return current;
}

beforeAll(() => {
  testDir = path.join(os.tmpdir(), `torque-long-path-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  // Clean up test root — may itself be deep; use forceRmDir which handles it.
  try {
    forceRmDir(testDir);
  } catch {
    // Best effort.
  }
});

describe('forceRmDir — long-path trees', () => {
  it('removes a deeply nested directory tree (30+ levels) that exceeds Windows MAX_PATH', () => {
    const dir = path.join(testDir, `deep-tree-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    const deepest = createDeeplyNested(dir);
    expect(fs.existsSync(deepest)).toBe(true);

    // Verify the total path length actually exceeds 260 chars on Windows.
    // On non-Windows this is a no-op sanity check.
    if (process.platform === 'win32') {
      expect(deepest.length).toBeGreaterThan(260);
    }

    const result = forceRmDir(dir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes a deeply nested tree with read-only files at multiple depths', () => {
    const dir = path.join(testDir, `deep-readonly-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    // Create several nesting levels with read-only files scattered throughout.
    let current = dir;
    for (let i = 0; i < 30; i++) {
      const segment = `l${String(i).padStart(2, '0')}_rdonly`;
      current = path.join(current, segment);
      fs.mkdirSync(current, { recursive: true });
      if (i % 5 === 0) {
        const file = path.join(current, `locked_${i}.txt`);
        fs.writeFileSync(file, `readonly at depth ${i}`, 'utf8');
        try { fs.chmodSync(file, 0o444); } catch { /* platform-dependent */ }
      }
    }

    const result = forceRmDir(dir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('reclaimDir — long-path fallback', () => {
  it('reclaims a deeply nested worktree dir when git worktree remove would fail on long paths', () => {
    // Create a fake project dir (not a real git repo — git commands will fail
    // gracefully via tryGit, exercising the fs.rmSync fallback path).
    const project = path.join(testDir, `proj-longpath-${Date.now()}`);
    fs.mkdirSync(project, { recursive: true });

    const worktreeDir = path.join(project, '.worktrees', 'feat-factory-1-deep');
    fs.mkdirSync(worktreeDir, { recursive: true });

    // Populate with a deeply nested tree (simulates node_modules etc).
    createDeeplyNested(worktreeDir);

    expect(fs.existsSync(worktreeDir)).toBe(true);

    const result = reclaimDir({
      repoPath: project,
      worktreePath: worktreeDir,
      branch: 'feat/factory-1-deep',
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(worktreeDir)).toBe(false);

    // Verify the attempt log includes the fs_rm fallback and worktree_prune.
    // git worktree remove may or may not fail depending on whether a parent
    // git repo exists in the temp tree, but the fs_rm step should always
    // fire when the directory is still on disk after the git attempt.
    const stepNames = result.attempts.map((a) => a.step);
    expect(stepNames).toContain('worktree_remove');
    expect(stepNames).toContain('fs_rm');
    expect(stepNames).toContain('worktree_prune');

    // fs_rm ran BEFORE worktree_prune (the ordering fix).
    const fsIdx = stepNames.indexOf('fs_rm');
    const pruneIdx = stepNames.indexOf('worktree_prune');
    expect(fsIdx).toBeLessThan(pruneIdx);
  });

  it('succeeds even when the deep tree has nested .git directories (simulates submodules)', () => {
    const project = path.join(testDir, `proj-submod-${Date.now()}`);
    fs.mkdirSync(project, { recursive: true });

    const worktreeDir = path.join(project, '.worktrees', 'feat-factory-2-submod');
    fs.mkdirSync(worktreeDir, { recursive: true });

    // Create a simulated submodule with its own deep nesting.
    const submodDir = path.join(worktreeDir, 'vendor', 'some-lib');
    fs.mkdirSync(submodDir, { recursive: true });
    createDeeplyNested(submodDir, 25);

    // Create a .git file in the worktree (simulates git redirect).
    fs.writeFileSync(path.join(worktreeDir, '.git'), 'gitdir: /irrelevant\n', 'utf8');

    const result = reclaimDir({
      repoPath: project,
      worktreePath: worktreeDir,
      branch: 'feat/factory-2-submod',
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });

  it('fs_rm step is skipped when git worktree remove succeeds (no unnecessary fallback)', () => {
    // When git worktree remove works, the dir is already gone and fs_rm
    // should not appear in the attempt log. We simulate this by providing
    // a directory that doesn't exist — reclaimDir treats already-gone as success.
    const project = path.join(testDir, `proj-clean-${Date.now()}`);
    fs.mkdirSync(project, { recursive: true });

    const worktreeDir = path.join(project, '.worktrees', 'feat-factory-3-gone');
    // Directory does NOT exist on disk.

    const result = reclaimDir({
      repoPath: project,
      worktreePath: worktreeDir,
      branch: 'feat/factory-3-gone',
    });

    expect(result.success).toBe(true);
    // fs_rm should NOT be in the attempts since the dir didn't exist after
    // git worktree remove (even though git failed, the dir was never there).
    const stepNames = result.attempts.map((a) => a.step);
    expect(stepNames).not.toContain('fs_rm');
  });
});
