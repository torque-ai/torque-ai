'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const logger = require('../logger').child({ component: 'worktree-reconcile' });

const DEFAULT_WORKTREE_DIR = '.worktrees';
const FACTORY_BRANCH_PREFIX = 'feat/factory-';
const FACTORY_LEAF_PREFIX = 'feat-factory-';
const RECLAIMABLE_STATUSES = new Set(['abandoned', 'shipped', 'merged']);

function runGit(repoPath, args) {
  return childProcess.execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
}

function tryGit(repoPath, args) {
  try {
    runGit(repoPath, args);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function normalizePathKey(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();
}

// Recursively clear read-only attributes so a subsequent rmSync can succeed.
// On Windows, git internals and some build tools mark files read-only; fs.rmSync
// with force:true tolerates missing files but not permission-denied.
function clearReadOnlyRecursive(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try { fs.chmodSync(full, 0o666); } catch { /* best effort */ }
    if (entry.isDirectory()) {
      clearReadOnlyRecursive(full);
    }
  }
}

// Layered force-delete that handles Windows quirks. Order:
//   1. fs.rmSync recursive+force (works for the common case)
//   2. chmod-recursive to clear read-only, then rmSync again (handles git
//      internals and files marked read-only by build tools)
//   3. shell fallback via platform-native recursive delete (handles the
//      "Directory not empty" error from files rmSync cannot unlink —
//      e.g. symlinks, files open in another process that released the
//      lock between attempts).
// Returns {ok, attempts: [{step, ok, err?}]}. `ok` reflects whether the
// directory is actually gone, not whether every step succeeded.
function forceRmDir(dir) {
  const attempts = [];
  if (!fs.existsSync(dir)) {
    return { ok: true, attempts };
  }

  // Attempt 1: plain recursive rm
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    attempts.push({ step: 'rm_plain', ok: true });
    if (!fs.existsSync(dir)) return { ok: true, attempts };
  } catch (err) {
    attempts.push({ step: 'rm_plain', ok: false, err: err.message });
  }

  // Attempt 2: clear read-only, retry rm
  try {
    clearReadOnlyRecursive(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    attempts.push({ step: 'rm_after_chmod', ok: true });
    if (!fs.existsSync(dir)) return { ok: true, attempts };
  } catch (err) {
    attempts.push({ step: 'rm_after_chmod', ok: false, err: err.message });
  }

  // Attempt 3: shell fallback. On Windows (no POSIX rm), use cmd.exe's
  // rmdir /s /q. Everywhere else, rm -rf. Both recursive + force.
  try {
    if (process.platform === 'win32') {
      childProcess.execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], {
        windowsHide: true,
        timeout: 30000,
      });
    } else {
      childProcess.execFileSync('rm', ['-rf', dir], {
        windowsHide: true,
        timeout: 30000,
      });
    }
    attempts.push({ step: 'rm_shell', ok: true });
  } catch (err) {
    attempts.push({ step: 'rm_shell', ok: false, err: err.message });
  }

  return { ok: !fs.existsSync(dir), attempts };
}

// Reclaim a stale worktree directory and its git metadata. Safe to call on
// entries that may be fully gone, partially gone, or still registered.
// Uses `git worktree remove --force` first (handles both metadata + dir),
// then falls back to fs.rmSync + prune + branch delete.
function reclaimDir({ repoPath, worktreePath, branch }) {
  const attempts = [];

  // Attempt 1: git-aware removal. Handles the case where .git/worktrees
  // still has a stale entry even if the physical dir is gone.
  const removeRes = tryGit(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  attempts.push({ step: 'worktree_remove', ok: removeRes.ok, err: removeRes.ok ? null : removeRes.err.message });

  // Attempt 2: prune. Clears metadata for any worktree whose dir is missing.
  // This is the one git-add will actually check. Always worth doing.
  const pruneRes = tryGit(repoPath, ['worktree', 'prune']);
  attempts.push({ step: 'worktree_prune', ok: pruneRes.ok, err: pruneRes.ok ? null : pruneRes.err.message });

  // Attempt 3: fs-level cleanup via forceRmDir. Layered: plain rmSync →
  // chmod-recursive + rmSync → shell fallback. Handles Windows "Directory
  // not empty" and read-only git internals that defeat a plain fs.rmSync.
  if (fs.existsSync(worktreePath)) {
    const rmResult = forceRmDir(worktreePath);
    attempts.push({
      step: 'fs_rm',
      ok: rmResult.ok,
      err: rmResult.ok
        ? null
        : rmResult.attempts
            .filter((a) => !a.ok)
            .map((a) => `${a.step}: ${a.err || 'failed'}`)
            .join(' | '),
      sub_attempts: rmResult.attempts,
    });
  }

  // Attempt 4: branch delete. Orphan branch may linger even when the worktree
  // is gone; git worktree add -b will fail with "branch already exists".
  if (branch) {
    const branchRes = tryGit(repoPath, ['branch', '-D', branch]);
    attempts.push({ step: 'branch_delete', ok: branchRes.ok, err: branchRes.ok ? null : branchRes.err.message });
  }

  const stillOnDisk = fs.existsSync(worktreePath);
  return {
    success: !stillOnDisk,
    worktreePath,
    branch: branch || null,
    attempts,
  };
}

// Look up factory_worktrees rows for a project. Called via injected db since
// factory-worktrees.js doesn't expose a listByProject helper.
function listProjectFactoryWorktrees(db, projectId) {
  try {
    return db.prepare(`
      SELECT id, project_id, work_item_id, batch_id, vc_worktree_id, branch,
             worktree_path, status, created_at, merged_at, abandoned_at
      FROM factory_worktrees
      WHERE project_id = ?
      ORDER BY id DESC
    `).all(projectId);
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('no such table')) {
      return [];
    }
    throw err;
  }
}

function listWorktreeDirs(projectPath, worktreeDir = DEFAULT_WORKTREE_DIR) {
  const root = path.isAbsolute(worktreeDir)
    ? worktreeDir
    : path.join(projectPath, worktreeDir);
  if (!fs.existsSync(root)) {
    return { root, dirs: [] };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, root }, 'readdir .worktrees failed');
    return { root, dirs: [] };
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
  return { root, dirs };
}

// Decide whether a directory is a reclaimable orphan.
//   - matching DB row with reclaimable status → yes
//   - no DB row, directory name starts with feat-factory- → yes (factory-created, abandoned without DB record)
//   - matching DB row with active/non-reclaimable status → no (still in use)
//   - no DB row, non-factory naming → no (user worktree, leave alone)
function classifyDir(dirPath, rowsByPath) {
  const key = normalizePathKey(dirPath);
  const row = rowsByPath.get(key);
  const leaf = path.basename(dirPath);

  if (row) {
    if (RECLAIMABLE_STATUSES.has(row.status)) {
      return { action: 'reclaim', reason: `db row status=${row.status}`, row };
    }
    return { action: 'skip', reason: `db row status=${row.status}`, row };
  }

  if (leaf.startsWith(FACTORY_LEAF_PREFIX)) {
    return { action: 'reclaim', reason: 'orphan factory dir with no db row', row: null };
  }

  return { action: 'skip', reason: 'non-factory dir with no db row', row: null };
}

// Reconcile a project's .worktrees/ against factory_worktrees rows.
// Removes stale directories whose DB state says they shouldn't be there,
// leaving active rows and user-owned worktrees alone.
function reconcileProject({ db, project_id, project_path, worktree_dir = DEFAULT_WORKTREE_DIR }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('db is required');
  }
  if (!project_id) throw new Error('project_id is required');
  if (!project_path) throw new Error('project_path is required');

  const cleaned = [];
  const skipped = [];
  const failed = [];

  const { root, dirs } = listWorktreeDirs(project_path, worktree_dir);
  if (dirs.length === 0) {
    return { root, scanned: 0, cleaned, skipped, failed };
  }

  const rows = listProjectFactoryWorktrees(db, project_id);
  const rowsByPath = new Map();
  for (const row of rows) {
    if (row.worktree_path) {
      rowsByPath.set(normalizePathKey(row.worktree_path), row);
    }
  }

  for (const dirPath of dirs) {
    const classification = classifyDir(dirPath, rowsByPath);
    if (classification.action === 'skip') {
      skipped.push({ worktreePath: dirPath, reason: classification.reason });
      continue;
    }

    const branch = classification.row && classification.row.branch ? classification.row.branch : null;
    const result = reclaimDir({ repoPath: project_path, worktreePath: dirPath, branch });
    if (result.success) {
      cleaned.push({ worktreePath: dirPath, branch, reason: classification.reason });
      logger.info('reconciled orphan worktree', {
        project_id,
        worktreePath: dirPath,
        branch,
        reason: classification.reason,
      });
    } else {
      failed.push({
        worktreePath: dirPath,
        branch,
        reason: classification.reason,
        attempts: result.attempts,
      });
      logger.warn('failed to reconcile worktree', {
        project_id,
        worktreePath: dirPath,
        branch,
        attempts: result.attempts,
      });
    }
  }

  return { root, scanned: dirs.length, cleaned, skipped, failed };
}

module.exports = {
  reconcileProject,
  reclaimDir,
  classifyDir,
  listProjectFactoryWorktrees,
  forceRmDir,
  clearReadOnlyRecursive,
  RECLAIMABLE_STATUSES,
  FACTORY_LEAF_PREFIX,
};
