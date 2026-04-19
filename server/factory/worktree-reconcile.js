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

  // Attempt 3: fs-level cleanup. In case the git command didn't delete the
  // dir (e.g. it was an orphan git didn't know about, or remove refused
  // because of locked files that rmSync can force).
  if (fs.existsSync(worktreePath)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      attempts.push({ step: 'fs_rm', ok: true });
    } catch (err) {
      attempts.push({ step: 'fs_rm', ok: false, err: err.message });
    }
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
  RECLAIMABLE_STATUSES,
  FACTORY_LEAF_PREFIX,
};
