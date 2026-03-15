/**
 * Git worktree isolation utilities for TORQUE
 *
 * Provides functions to create, merge, and clean up git worktrees for
 * isolated Codex task execution. Prevents concurrent tasks from conflicting
 * when modifying the same project working directory.
 *
 * All git commands use execFileSync (no shell injection risk).
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../logger').child({ component: 'git-worktree' });
const { TASK_TIMEOUTS } = require('../constants');

/** Base directory for worktrees (inside server/.tmp/worktrees/) */
const WORKTREE_BASE_DIR = path.join(__dirname, '..', '.tmp', 'worktrees');

/**
 * Check whether a directory is inside a git repository.
 * @param {string} dir - Directory to check
 * @returns {boolean}
 */
function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a detached git worktree for a task.
 *
 * The worktree is created from HEAD of the source repo so that the Codex
 * process starts with a clean snapshot of the current state.
 *
 * @param {string} taskId - Unique task identifier (used in worktree path)
 * @param {string} sourceDir - The original project working directory
 * @returns {{ worktreePath: string, headSha: string } | null} - null if creation failed
 */
function createWorktree(taskId, sourceDir) {
  try {
    // Ensure the base directory exists
    fs.mkdirSync(WORKTREE_BASE_DIR, { recursive: true });

    // Sanitize task ID for use in filesystem path (replace non-alphanumeric chars)
    const safeName = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const worktreePath = path.join(WORKTREE_BASE_DIR, `task-${safeName}`);

    // If a stale worktree path exists from a previous crashed run, remove it first
    if (fs.existsSync(worktreePath)) {
      logger.info(`[Worktree] Removing stale worktree at ${worktreePath}`);
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: sourceDir,
          encoding: 'utf-8',
          timeout: TASK_TIMEOUTS.GIT_STATUS,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        logger.info(`[Worktree] git worktree remove failed for stale path, trying manual cleanup: ${e.message}`);
        // Manual cleanup fallback — remove directory and prune worktree list
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          execFileSync('git', ['worktree', 'prune'], {
            cwd: sourceDir,
            encoding: 'utf-8',
            timeout: TASK_TIMEOUTS.GIT_STATUS,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (cleanupErr) {
          logger.info(`[Worktree] Manual cleanup also failed: ${cleanupErr.message}`);
        }
      }
    }

    // Capture HEAD SHA before creating worktree
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceDir,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    // Create a detached worktree at HEAD
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: sourceDir,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_ADD_ALL, // 30s — worktree add can take a moment for large repos
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    logger.info(`[Worktree] Created worktree for task ${taskId} at ${worktreePath} (HEAD: ${headSha.slice(0, 8)})`);
    return { worktreePath, headSha };
  } catch (err) {
    logger.info(`[Worktree] Failed to create worktree for task ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Merge changes from a worktree back into the original working directory.
 *
 * Strategy: generate a diff of all changes in the worktree relative to its
 * detached HEAD, then apply that diff to the source directory.
 *
 * @param {string} worktreePath - Path to the worktree
 * @param {string} sourceDir - The original project working directory
 * @param {string} taskId - Task ID for logging
 * @returns {{ success: boolean, filesChanged: number, error?: string }}
 */
function mergeWorktreeChanges(worktreePath, sourceDir, taskId) {
  try {
    // First check if there are any changes at all in the worktree
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    if (!statusOutput) {
      logger.info(`[Worktree] Task ${taskId} worktree has no changes to merge`);
      return { success: true, filesChanged: 0 };
    }

    const changedFiles = statusOutput.split('\n').length;

    // Stage all changes in the worktree so diff captures everything
    // (including new untracked files)
    execFileSync('git', ['add', '-A'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Generate a patch of staged changes against HEAD
    let patch;
    try {
      patch = execFileSync('git', ['diff', '--cached', '--binary'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: TASK_TIMEOUTS.GIT_DIFF,
        maxBuffer: 50 * 1024 * 1024, // 50MB max patch size
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (diffErr) {
      // git diff --cached exits 1 when there are differences on some systems
      if (diffErr.stdout) {
        patch = diffErr.stdout;
      } else {
        throw diffErr;
      }
    }

    if (!patch || !patch.trim()) {
      logger.info(`[Worktree] Task ${taskId} generated empty patch despite status showing changes — falling back to file copy`);
      return copyChangedFiles(worktreePath, sourceDir, taskId, statusOutput);
    }

    // Apply the patch to the original working directory
    try {
      execFileSync('git', ['apply', '--3way', '--whitespace=nowarn'], {
        cwd: sourceDir,
        encoding: 'utf-8',
        timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
        input: patch,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (applyErr) {
      // --3way failed, try without it
      logger.info(`[Worktree] Task ${taskId} 3-way apply failed, trying direct apply: ${applyErr.message}`);
      try {
        execFileSync('git', ['apply', '--whitespace=nowarn'], {
          cwd: sourceDir,
          encoding: 'utf-8',
          timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
          input: patch,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (directApplyErr) {
        logger.info(`[Worktree] Task ${taskId} direct apply also failed, falling back to file copy: ${directApplyErr.message}`);
        return copyChangedFiles(worktreePath, sourceDir, taskId, statusOutput);
      }
    }

    logger.info(`[Worktree] Task ${taskId} merged ${changedFiles} file(s) from worktree to ${sourceDir}`);
    return { success: true, filesChanged: changedFiles };
  } catch (err) {
    logger.info(`[Worktree] Task ${taskId} merge failed: ${err.message}`);
    return { success: false, filesChanged: 0, error: err.message };
  }
}

/**
 * Fallback: copy changed files directly from worktree to source directory.
 * Used when git apply fails (e.g., binary files, encoding issues).
 *
 * @param {string} worktreePath
 * @param {string} sourceDir
 * @param {string} taskId
 * @param {string} statusOutput - git status --porcelain output from worktree
 * @returns {{ success: boolean, filesChanged: number, error?: string }}
 */
function copyChangedFiles(worktreePath, sourceDir, taskId, statusOutput) {
  try {
    const lines = statusOutput.split('\n').filter(Boolean);
    let copied = 0;

    for (const line of lines) {
      // Parse porcelain format: XY filename
      const statusCode = line.slice(0, 2);
      let filePath = line.slice(3).trim();

      // Handle quoted paths
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }

      if (!filePath) continue;

      const srcFile = path.join(worktreePath, filePath);
      const destFile = path.join(sourceDir, filePath);

      // Security: prevent path traversal via crafted filePath
      const rel = path.relative(sourceDir, destFile);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn(`[Worktree] Skipping path traversal attempt: ${filePath}`);
        continue;
      }

      // Deleted files
      if (statusCode.includes('D')) {
        try {
          if (fs.existsSync(destFile)) {
            fs.unlinkSync(destFile);
            copied++;
          }
        } catch (e) {
          logger.info(`[Worktree] Task ${taskId} failed to delete ${filePath}: ${e.message}`);
        }
        continue;
      }

      // New or modified files — copy from worktree to source
      try {
        if (fs.existsSync(srcFile)) {
          const destDir = path.dirname(destFile);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcFile, destFile);
          copied++;
        }
      } catch (e) {
        logger.info(`[Worktree] Task ${taskId} failed to copy ${filePath}: ${e.message}`);
      }
    }

    logger.info(`[Worktree] Task ${taskId} file-copy fallback: copied ${copied}/${lines.length} files`);
    return { success: true, filesChanged: copied };
  } catch (err) {
    logger.info(`[Worktree] Task ${taskId} file-copy fallback failed: ${err.message}`);
    return { success: false, filesChanged: 0, error: err.message };
  }
}

/**
 * Remove a git worktree and clean up its directory.
 *
 * @param {string} worktreePath - Path to the worktree to remove
 * @param {string} sourceDir - The original project working directory
 * @param {string} taskId - Task ID for logging
 */
function removeWorktree(worktreePath, sourceDir, taskId) {
  try {
    // Try graceful removal first
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: sourceDir,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    logger.info(`[Worktree] Removed worktree for task ${taskId}`);
  } catch (err) {
    logger.info(`[Worktree] git worktree remove failed for task ${taskId}: ${err.message}`);
    // Manual cleanup fallback
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      execFileSync('git', ['worktree', 'prune'], {
        cwd: sourceDir,
        encoding: 'utf-8',
        timeout: TASK_TIMEOUTS.GIT_STATUS,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      logger.info(`[Worktree] Manually cleaned worktree for task ${taskId}`);
    } catch (cleanupErr) {
      logger.info(`[Worktree] Manual cleanup failed for task ${taskId}: ${cleanupErr.message}`);
    }
  }
}

/**
 * Clean up any orphaned worktrees in the base directory.
 * Call this during server startup to handle worktrees from crashed processes.
 *
 * @param {string} [baseDir] - Override worktree base directory (for testing)
 */
function cleanupOrphanedWorktrees(baseDir) {
  const dir = baseDir || WORKTREE_BASE_DIR;
  try {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          logger.info(`[Worktree] Cleaning up orphaned worktree: ${fullPath}`);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch (e) {
        logger.info(`[Worktree] Failed to clean orphaned worktree ${entry}: ${e.message}`);
      }
    }

    // Prune the worktree list in any git repos that might reference these
    // This is best-effort — we don't know which repos they belonged to
    logger.info(`[Worktree] Orphaned worktree cleanup complete (${entries.length} entries)`);
  } catch (err) {
    logger.info(`[Worktree] Orphan cleanup failed: ${err.message}`);
  }
}

module.exports = {
  WORKTREE_BASE_DIR,
  isGitRepo,
  createWorktree,
  mergeWorktreeChanges,
  removeWorktree,
  cleanupOrphanedWorktrees,
};
