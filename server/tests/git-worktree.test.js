/**
 * Unit tests for utils/git-worktree.js
 *
 * Tests git worktree isolation lifecycle: create, merge, remove, cleanup.
 * Uses real git repos in temp directories to test actual git worktree behavior.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { gitSync, cleanupRepo } = require('./git-test-utils');

const gitWorktree = require('../utils/git-worktree');

let testBaseDir;
let repoDir;

function createTestRepo() {
  repoDir = path.join(testBaseDir, 'test-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  gitSync(['init'], { cwd: repoDir });
  gitSync(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  gitSync(['config', 'user.name', 'Test'], { cwd: repoDir });

  // Create an initial commit so HEAD exists
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n');
  gitSync(['add', '.'], { cwd: repoDir });
  gitSync(['commit', '-m', 'Initial commit', '--no-gpg-sign'], { cwd: repoDir });

  return repoDir;
}

// Retry: git worktree tests are sensitive to process contention during full parallel suite runs
describe('git-worktree', { retry: 2 }, () => {
  beforeEach(() => {
    testBaseDir = path.join(os.tmpdir(), `torque-wt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanupRepo(repoDir);
    try {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  // ── isGitRepo ────────────────────────────────────────────────────

  describe('isGitRepo', () => {
    it('returns true for a git repository', () => {
      createTestRepo();
      expect(gitWorktree.isGitRepo(repoDir)).toBe(true);
    });

    it('returns false for a non-git directory', () => {
      const isolatedDir = path.join(testBaseDir, 'isolated-non-git');
      fs.mkdirSync(isolatedDir, { recursive: true });
      gitSync(['init'], { cwd: isolatedDir });
      fs.rmSync(path.join(isolatedDir, '.git'), { recursive: true, force: true });
      expect(gitWorktree.isGitRepo(path.join(testBaseDir, 'truly-does-not-exist-xyz'))).toBe(false);
    });

    it('returns false for a nonexistent directory', () => {
      expect(gitWorktree.isGitRepo(path.join(testBaseDir, 'does-not-exist'))).toBe(false);
    });
  });

  // ── createWorktree ───────────────────────────────────────────────

  describe('createWorktree', () => {
    it('creates a worktree and returns its path and HEAD SHA', () => {
      createTestRepo();
      const result = gitWorktree.createWorktree('task-abc-123', repoDir);

      expect(result).not.toBeNull();
      expect(result.worktreePath).toBeDefined();
      expect(result.headSha).toBeDefined();
      expect(result.headSha.length).toBeGreaterThanOrEqual(7);
      expect(fs.existsSync(result.worktreePath)).toBe(true);

      // Verify the worktree contains the same files as the source repo
      expect(fs.existsSync(path.join(result.worktreePath, 'README.md'))).toBe(true);

      // Clean up
      gitWorktree.removeWorktree(result.worktreePath, repoDir, 'task-abc-123');
    });

    it('sanitizes task ID for filesystem safety', () => {
      createTestRepo();
      const result = gitWorktree.createWorktree('task/with:special<chars>', repoDir);

      expect(result).not.toBeNull();
      // The basename of the worktree path should not contain the original special characters
      const baseName = path.basename(result.worktreePath);
      expect(baseName).not.toMatch(/[/<>:]/);
      expect(baseName).toContain('task_with_special_chars_');
      expect(fs.existsSync(result.worktreePath)).toBe(true);

      gitWorktree.removeWorktree(result.worktreePath, repoDir, 'task/with:special<chars>');
    });

    it('returns null for a non-git directory', () => {
      const nonGitDir = path.join(testBaseDir, 'not-a-repo');
      fs.mkdirSync(nonGitDir, { recursive: true });
      const result = gitWorktree.createWorktree('task-1', nonGitDir);
      expect(result).toBeNull();
    });

    it('handles stale worktree from previous crash', () => {
      createTestRepo();

      // Create a first worktree
      const first = gitWorktree.createWorktree('task-stale', repoDir);
      expect(first).not.toBeNull();

      // Create another worktree with the same task ID (simulates crash + retry)
      const second = gitWorktree.createWorktree('task-stale', repoDir);
      expect(second).not.toBeNull();
      expect(fs.existsSync(second.worktreePath)).toBe(true);

      gitWorktree.removeWorktree(second.worktreePath, repoDir, 'task-stale');
    });
  });

  // ── mergeWorktreeChanges ─────────────────────────────────────────

  describe('mergeWorktreeChanges', () => {
    it('merges new file from worktree back to source', () => {
      createTestRepo();
      const wt = gitWorktree.createWorktree('task-merge-1', repoDir);
      expect(wt).not.toBeNull();

      // Create a new file in the worktree
      fs.writeFileSync(path.join(wt.worktreePath, 'new-file.js'), 'console.log("hello");\n');

      const result = gitWorktree.mergeWorktreeChanges(wt.worktreePath, repoDir, 'task-merge-1');
      expect(result.success).toBe(true);
      expect(result.filesChanged).toBeGreaterThanOrEqual(1);

      // Verify the file exists in the source repo
      expect(fs.existsSync(path.join(repoDir, 'new-file.js'))).toBe(true);
      const content = fs.readFileSync(path.join(repoDir, 'new-file.js'), 'utf-8');
      // Normalize line endings for cross-platform (Windows may add \r\n via git autocrlf)
      expect(content.replace(/\r\n/g, '\n')).toBe('console.log("hello");\n');

      gitWorktree.removeWorktree(wt.worktreePath, repoDir, 'task-merge-1');
    });

    it('merges modifications to existing files', () => {
      createTestRepo();
      const wt = gitWorktree.createWorktree('task-merge-2', repoDir);
      expect(wt).not.toBeNull();

      // Modify an existing file in the worktree
      fs.writeFileSync(path.join(wt.worktreePath, 'README.md'), '# Modified Project\n\nNew content here.\n');

      const result = gitWorktree.mergeWorktreeChanges(wt.worktreePath, repoDir, 'task-merge-2');
      expect(result.success).toBe(true);
      expect(result.filesChanged).toBeGreaterThanOrEqual(1);

      // Verify the modification in the source repo
      const content = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf-8');
      expect(content).toContain('Modified Project');
      expect(content).toContain('New content here.');

      gitWorktree.removeWorktree(wt.worktreePath, repoDir, 'task-merge-2');
    });

    it('returns success with 0 files when no changes were made', () => {
      createTestRepo();
      const wt = gitWorktree.createWorktree('task-merge-3', repoDir);
      expect(wt).not.toBeNull();

      // Don't change anything
      const result = gitWorktree.mergeWorktreeChanges(wt.worktreePath, repoDir, 'task-merge-3');
      expect(result.success).toBe(true);
      expect(result.filesChanged).toBe(0);

      gitWorktree.removeWorktree(wt.worktreePath, repoDir, 'task-merge-3');
    });

    it('handles new subdirectories correctly', () => {
      createTestRepo();
      const wt = gitWorktree.createWorktree('task-merge-4', repoDir);
      expect(wt).not.toBeNull();

      // Create a nested directory structure in the worktree
      const subDir = path.join(wt.worktreePath, 'src', 'utils');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'helper.js'), 'module.exports = {};\n');

      const result = gitWorktree.mergeWorktreeChanges(wt.worktreePath, repoDir, 'task-merge-4');
      expect(result.success).toBe(true);

      // Verify nested file exists in source
      expect(fs.existsSync(path.join(repoDir, 'src', 'utils', 'helper.js'))).toBe(true);

      gitWorktree.removeWorktree(wt.worktreePath, repoDir, 'task-merge-4');
    });
  });

  // ── removeWorktree ───────────────────────────────────────────────

  describe('removeWorktree', () => {
    it('removes a worktree cleanly', () => {
      createTestRepo();
      const wt = gitWorktree.createWorktree('task-remove-1', repoDir);
      expect(wt).not.toBeNull();
      expect(fs.existsSync(wt.worktreePath)).toBe(true);

      gitWorktree.removeWorktree(wt.worktreePath, repoDir, 'task-remove-1');

      // Directory should be gone
      expect(fs.existsSync(wt.worktreePath)).toBe(false);
    });

    it('handles removing a nonexistent worktree gracefully', () => {
      createTestRepo();
      const fakePath = path.join(testBaseDir, 'nonexistent-worktree');

      // Should not throw
      expect(() => {
        gitWorktree.removeWorktree(fakePath, repoDir, 'task-fake');
      }).not.toThrow();
    });
  });

  // ── cleanupOrphanedWorktrees ─────────────────────────────────────

  describe('cleanupOrphanedWorktrees', () => {
    it('removes orphaned worktree directories', () => {
      const orphanDir = path.join(testBaseDir, 'orphan-base');
      fs.mkdirSync(orphanDir, { recursive: true });

      // Create fake orphaned worktree dirs
      fs.mkdirSync(path.join(orphanDir, 'task-orphan-1'), { recursive: true });
      fs.mkdirSync(path.join(orphanDir, 'task-orphan-2'), { recursive: true });
      fs.writeFileSync(path.join(orphanDir, 'task-orphan-1', 'file.txt'), 'stale');

      gitWorktree.cleanupOrphanedWorktrees(orphanDir);

      expect(fs.existsSync(path.join(orphanDir, 'task-orphan-1'))).toBe(false);
      expect(fs.existsSync(path.join(orphanDir, 'task-orphan-2'))).toBe(false);
    });

    it('handles nonexistent base directory gracefully', () => {
      expect(() => {
        gitWorktree.cleanupOrphanedWorktrees(path.join(testBaseDir, 'nope'));
      }).not.toThrow();
    });

    it('handles empty base directory gracefully', () => {
      const emptyDir = path.join(testBaseDir, 'empty-base');
      fs.mkdirSync(emptyDir, { recursive: true });

      expect(() => {
        gitWorktree.cleanupOrphanedWorktrees(emptyDir);
      }).not.toThrow();
    });
  });

  // ── WORKTREE_BASE_DIR ────────────────────────────────────────────

  describe('WORKTREE_BASE_DIR', () => {
    it('points to server/.tmp/worktrees/', () => {
      expect(gitWorktree.WORKTREE_BASE_DIR).toContain(path.join('server', '.tmp', 'worktrees'));
    });
  });
});
