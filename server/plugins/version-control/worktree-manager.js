'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const childProcess = require('child_process');

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_WORKTREE_DIR = '.worktrees';
const DEFAULT_STALE_DAYS = 7;
const VALID_MERGE_STRATEGIES = new Set(['merge', 'squash', 'rebase']);

function resolveDbHandle(dbService) {
  const handle = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  if (!handle || typeof handle.prepare !== 'function') {
    throw new Error('createWorktreeManager requires a db object with prepare()');
  }

  return handle;
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }

  return numeric;
}

function runGit(cwd, args, options = {}) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'worktree';
}

function buildBranchName(featureName) {
  const normalized = requireString(featureName, 'featureName');
  if (normalized.includes('/')) {
    return normalized;
  }

  return `feat/${slugify(normalized)}`;
}

function buildWorktreeLeaf(branch) {
  return String(branch || '')
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'worktree';
}

function buildWorktreePath(repoPath, worktreeDir, branch) {
  const root = path.isAbsolute(worktreeDir)
    ? worktreeDir
    : path.join(repoPath, worktreeDir);
  return path.join(root, buildWorktreeLeaf(branch));
}

function normalizePathKey(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/').toLowerCase();
}

function stripBranchRef(branchRef) {
  const branch = normalizeOptionalString(branchRef);
  if (!branch) {
    return null;
  }

  return branch.replace(/^refs\/heads\//, '');
}

function deriveFeatureName(branch) {
  const normalized = stripBranchRef(branch);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('feat/')) {
    return normalized.slice('feat/'.length);
  }

  return normalized.split('/').pop() || normalized;
}

function extractGitError(error) {
  if (typeof error?.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }

  if (typeof error?.stdout === 'string' && error.stdout.trim()) {
    return error.stdout.trim();
  }

  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }

  return 'unknown git error';
}

function parseWorktreeList(output) {
  const entries = [];
  const lines = String(output || '').split(/\r?\n/);
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current && current.worktree_path) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    const separatorIndex = line.indexOf(' ');
    const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);

    if (key === 'worktree') {
      if (current && current.worktree_path) {
        entries.push(current);
      }
      current = { worktree_path: value };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === 'branch') {
      current.branch = stripBranchRef(value) || 'detached';
      continue;
    }

    if (key === 'detached') {
      current.branch = 'detached';
    }
  }

  if (current && current.worktree_path) {
    entries.push(current);
  }

  return entries;
}

function isStaleWorktree(worktree, staleDays = DEFAULT_STALE_DAYS) {
  if (!worktree || typeof worktree !== 'object') {
    return false;
  }

  const status = normalizeOptionalString(worktree.status);
  if (status && status.toLowerCase() === 'merged') {
    return false;
  }

  if (status && status.toLowerCase() === 'stale') {
    return true;
  }

  const timestamp = worktree.last_activity_at || worktree.created_at;
  if (!timestamp) {
    return false;
  }

  const staleDaysValue = normalizeOptionalNumber(staleDays, 'staleDays') ?? DEFAULT_STALE_DAYS;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Date.now() - parsed >= staleDaysValue * 24 * 60 * 60 * 1000;
}

function createWorktreeManager({ db } = {}) {
  const dbHandle = resolveDbHandle(db);
  let cachedColumns = null;

  function getColumns() {
    if (cachedColumns) {
      return cachedColumns;
    }

    try {
      cachedColumns = dbHandle.prepare("PRAGMA table_info('vc_worktrees')").all().map((column) => column.name);
    } catch {
      cachedColumns = [];
    }

    return cachedColumns;
  }

  function hasColumn(columnName) {
    const columns = getColumns();
    return columns.length === 0 || columns.includes(columnName);
  }

  function insertWorktree(record) {
    const orderedColumns = [
      'id',
      'repo_path',
      'worktree_path',
      'branch',
      'feature_name',
      'base_branch',
      'status',
      'commit_count',
      'created_at',
      'last_activity_at',
    ].filter((column) => hasColumn(column));

    const placeholders = orderedColumns.map(() => '?').join(', ');
    const values = orderedColumns.map((column) => (
      Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null
    ));

    dbHandle
      .prepare(`INSERT INTO vc_worktrees (${orderedColumns.join(', ')}) VALUES (${placeholders})`)
      .run(...values);
  }

  function updateWorktree(id, updates) {
    const entries = Object.entries(updates)
      .filter(([column, value]) => value !== undefined && hasColumn(column));

    if (entries.length === 0) {
      return;
    }

    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    dbHandle.prepare(`UPDATE vc_worktrees SET ${assignments} WHERE id = ?`).run(...values, id);
  }

  function getRowById(id) {
    const worktreeId = requireString(id, 'id');
    return dbHandle.prepare('SELECT * FROM vc_worktrees WHERE id = ?').get(worktreeId) || null;
  }

  function withDerivedFields(row, staleDays = DEFAULT_STALE_DAYS) {
    if (!row) {
      return null;
    }

    return {
      ...row,
      isStale: isStaleWorktree(row, staleDays),
    };
  }

  function getWorktreeStatusPorcelain(worktreePath) {
    return String(runGit(worktreePath, ['status', '--porcelain'])).trim();
  }

  function renormalizeLineEndings(worktreePath) {
    // On Windows + remote Linux test runs (torque-remote), vitest's rsync or
    // git's autocrlf can leave every file in the worktree flagged as
    // modified purely because of CRLF/LF drift. Stage a renormalize pass
    // and commit it if anything lands — that converts meaningless
    // whitespace churn into a single bookkeeping commit so the downstream
    // clean check can tell real edits from line-ending noise.
    try {
      runGit(worktreePath, ['add', '--renormalize', '.']);
    } catch (_err) {
      void _err;
      return { committed: false, reason: 'renormalize_failed' };
    }
    const staged = String(runGit(worktreePath, ['diff', '--cached', '--name-only'])).trim();
    if (!staged) {
      return { committed: false, reason: 'nothing_to_renormalize' };
    }
    try {
      runGit(worktreePath, [
        'commit',
        '-m',
        'chore: normalize line endings (factory auto-commit)',
      ]);
      return { committed: true, files: staged.split('\n').filter(Boolean) };
    } catch (_err) {
      void _err;
      return { committed: false, reason: 'commit_failed' };
    }
  }

  function assertWorktreeIsClean(worktreePath, action) {
    let status = getWorktreeStatusPorcelain(worktreePath);
    if (!status) {
      return;
    }

    // First attempt: renormalize line endings and re-check. If the only
    // "uncommitted changes" were CRLF/LF drift, the worktree becomes
    // clean after the auto-normalize commit.
    renormalizeLineEndings(worktreePath);
    status = getWorktreeStatusPorcelain(worktreePath);
    if (!status) {
      return;
    }

    throw new Error(`worktree ${worktreePath} has uncommitted changes — refusing to ${action}`);
  }

  function getAheadCommitCount(repoPath, targetBranch, branch) {
    const output = String(runGit(repoPath, ['rev-list', '--count', `${targetBranch}..${branch}`])).trim();
    const count = Number.parseInt(output, 10);
    if (!Number.isFinite(count)) {
      throw new Error(`unable to determine ahead commit count for ${branch} against ${targetBranch}`);
    }

    return count;
  }

  function createWorktree(repoPath, featureName, options = {}) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const requestedFeatureName = requireString(featureName, 'featureName');
    const baseBranch = normalizeOptionalString(options.baseBranch || options.base_branch) || DEFAULT_BASE_BRANCH;
    const worktreeDir = normalizeOptionalString(options.worktreeDir || options.worktree_dir) || DEFAULT_WORKTREE_DIR;
    const branch = buildBranchName(requestedFeatureName);
    const worktreePath = buildWorktreePath(repositoryPath, worktreeDir, branch);
    const createdAt = new Date().toISOString();

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    runGit(repositoryPath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);

    const record = {
      id: randomUUID(),
      repo_path: repositoryPath,
      worktree_path: worktreePath,
      branch,
      feature_name: requestedFeatureName,
      base_branch: baseBranch,
      status: 'active',
      commit_count: 0,
      created_at: createdAt,
      last_activity_at: createdAt,
    };

    insertWorktree(record);
    return withDerivedFields(record);
  }

  function listWorktrees(repoPath = null) {
    const repositoryPath = normalizeOptionalString(repoPath);
    const rows = repositoryPath
      ? dbHandle.prepare('SELECT * FROM vc_worktrees WHERE repo_path = ? ORDER BY created_at DESC').all(repositoryPath)
      : dbHandle.prepare('SELECT * FROM vc_worktrees ORDER BY created_at DESC').all();

    return rows.map((row) => withDerivedFields(row));
  }

  function getWorktree(id) {
    return withDerivedFields(getRowById(id));
  }

  function recordActivity(id) {
    const existing = getRowById(id);
    if (!existing) {
      return null;
    }

    const timestamp = new Date().toISOString();
    dbHandle.prepare(
      'UPDATE vc_worktrees SET last_activity_at = ?, commit_count = COALESCE(commit_count, 0) + 1 WHERE id = ?'
    ).run(timestamp, existing.id);

    return getWorktree(existing.id);
  }

  function cleanupWorktree(id, options = {}) {
    const existing = getRowById(id);
    if (!existing) {
      return null;
    }

    const warnings = [];
    const deleteBranch = options.deleteAfter !== false
      && options.delete_after !== false
      && options.deleteBranch !== false
      && options.delete_branch !== false;
    const removeArgs = ['worktree', 'remove'];

    if (deleteBranch) {
      assertWorktreeIsClean(existing.worktree_path, 'cleanup');
    }

    if (options.force !== false) {
      removeArgs.push('--force');
    }

    removeArgs.push(existing.worktree_path);
    runGit(existing.repo_path, removeArgs);

    try {
      runGit(existing.repo_path, ['worktree', 'prune']);
    } catch (error) {
      warnings.push(`git worktree prune failed: ${extractGitError(error)}`);
    }

    let branchDeleted = false;
    if (deleteBranch && normalizeOptionalString(existing.branch) && existing.branch !== 'detached') {
      try {
        runGit(existing.repo_path, ['branch', '-D', existing.branch]);
        branchDeleted = true;
      } catch (error) {
        warnings.push(`git branch -D failed: ${extractGitError(error)}`);
      }
    }

    dbHandle.prepare('DELETE FROM vc_worktrees WHERE id = ?').run(existing.id);

    return {
      id: existing.id,
      repo_path: existing.repo_path,
      worktree_path: existing.worktree_path,
      branch: existing.branch,
      removed: true,
      branchDeleted,
      warnings,
    };
  }

  function mergeWorktree(id, options = {}) {
    const existing = getRowById(id);
    if (!existing) {
      return null;
    }

    const strategy = normalizeOptionalString(options.strategy) || 'merge';
    if (!VALID_MERGE_STRATEGIES.has(strategy)) {
      throw new Error('strategy must be one of: merge, squash, rebase');
    }

    const targetBranch = normalizeOptionalString(options.targetBranch || options.target_branch)
      || normalizeOptionalString(existing.base_branch)
      || DEFAULT_BASE_BRANCH;
    const deleteAfter = options.deleteAfter !== false && options.delete_after !== false;

    assertWorktreeIsClean(existing.worktree_path, 'merge');

    if (getAheadCommitCount(existing.repo_path, targetBranch, existing.branch) === 0) {
      throw new Error(`worktree has no commits ahead of ${targetBranch} — refusing to merge empty branch`);
    }

    if (strategy === 'rebase') {
      runGit(existing.worktree_path, ['rebase', targetBranch]);
      runGit(existing.repo_path, ['checkout', targetBranch]);
      runGit(existing.repo_path, ['merge', '--ff-only', existing.branch]);
    } else {
      runGit(existing.repo_path, ['checkout', targetBranch]);
      runGit(
        existing.repo_path,
        strategy === 'squash'
          ? ['merge', '--squash', existing.branch]
          : ['merge', '--no-ff', existing.branch],
      );
    }

    const mergedAt = new Date().toISOString();

    if (deleteAfter) {
      let cleanup = null;
      let cleanupError = null;
      try {
        cleanup = cleanupWorktree(existing.id, { deleteBranch: true });
      } catch (error) {
        cleanupError = extractGitError(error);
      }

      if (cleanup) {
        return {
          merged: true,
          id: existing.id,
          branch: existing.branch,
          target_branch: targetBranch,
          strategy,
          cleaned: true,
          cleanup,
        };
      }

      updateWorktree(existing.id, {
        status: 'merged',
        last_activity_at: mergedAt,
        merged_at: mergedAt,
      });

      return {
        merged: true,
        id: existing.id,
        branch: existing.branch,
        target_branch: targetBranch,
        strategy,
        cleaned: false,
        cleanup_failed: true,
        cleanup_error: cleanupError,
        worktree: getWorktree(existing.id),
      };
    }

    updateWorktree(existing.id, {
      status: 'merged',
      last_activity_at: mergedAt,
      merged_at: mergedAt,
    });

    return {
      merged: true,
      id: existing.id,
      branch: existing.branch,
      target_branch: targetBranch,
      strategy,
      cleaned: false,
      worktree: getWorktree(existing.id),
    };
  }

  function syncWithGit(repoPath) {
    const repositoryPath = requireString(repoPath, 'repoPath');
    const entries = parseWorktreeList(runGit(repositoryPath, ['worktree', 'list', '--porcelain']))
      .filter((entry) => normalizePathKey(entry.worktree_path) !== normalizePathKey(repositoryPath));
    const existingRows = dbHandle.prepare('SELECT * FROM vc_worktrees WHERE repo_path = ?').all(repositoryPath);
    const existingByPath = new Map(existingRows.map((row) => [normalizePathKey(row.worktree_path), row]));
    const gitPaths = new Set(entries.map((entry) => normalizePathKey(entry.worktree_path)));
    const syncedAt = new Date().toISOString();

    let inserted = 0;
    let updated = 0;
    let missing = 0;

    for (const entry of entries) {
      const key = normalizePathKey(entry.worktree_path);
      const existing = existingByPath.get(key);

      if (!existing) {
        insertWorktree({
          id: randomUUID(),
          repo_path: repositoryPath,
          worktree_path: entry.worktree_path,
          branch: entry.branch || 'detached',
          feature_name: deriveFeatureName(entry.branch),
          base_branch: DEFAULT_BASE_BRANCH,
          status: 'active',
          commit_count: 0,
          created_at: syncedAt,
          last_activity_at: syncedAt,
        });
        inserted += 1;
        continue;
      }

      const nextBranch = entry.branch || existing.branch || 'detached';
      const nextStatus = existing.status === 'merged' ? 'merged' : 'active';
      if (existing.branch !== nextBranch || existing.status !== nextStatus) {
        updateWorktree(existing.id, {
          branch: nextBranch,
          status: nextStatus,
          feature_name: existing.feature_name || deriveFeatureName(nextBranch),
        });
        updated += 1;
      }
    }

    for (const row of existingRows) {
      const key = normalizePathKey(row.worktree_path);
      if (gitPaths.has(key)) {
        continue;
      }

      if (row.status !== 'missing') {
        updateWorktree(row.id, { status: 'missing' });
        missing += 1;
      }
    }

    return {
      repo_path: repositoryPath,
      discovered: entries.length,
      inserted,
      updated,
      missing,
      worktrees: listWorktrees(repositoryPath),
    };
  }

  function getStaleWorktrees(staleDays = DEFAULT_STALE_DAYS, repoPath = null) {
    const threshold = normalizeOptionalNumber(staleDays, 'staleDays') ?? DEFAULT_STALE_DAYS;
    return listWorktrees(repoPath).filter((worktree) => isStaleWorktree(worktree, threshold));
  }

  function cleanupStale(options = {}) {
    const config = options && typeof options === 'object' ? options : {};
    const threshold = normalizeOptionalNumber(
      typeof options === 'number' ? options : (
        config.staleDays
        ?? config.stale_days
        ?? config.thresholdDays
        ?? config.threshold_days
      ),
      'staleDays',
    ) ?? DEFAULT_STALE_DAYS;
    const repositoryPath = typeof options === 'object'
      ? normalizeOptionalString(config.repoPath || config.repo_path)
      : null;
    const dryRun = typeof options === 'object' && (config.dryRun === true || config.dry_run === true);
    const staleWorktrees = getStaleWorktrees(threshold, repositoryPath);

    if (dryRun) {
      return {
        dryRun: true,
        repo_path: repositoryPath,
        stale_days: threshold,
        count: staleWorktrees.length,
        worktrees: staleWorktrees,
      };
    }

    const cleaned = staleWorktrees.map((worktree) => cleanupWorktree(worktree.id));
    return {
      dryRun: false,
      repo_path: repositoryPath,
      stale_days: threshold,
      count: cleaned.length,
      worktrees: cleaned,
    };
  }

  return {
    createWorktree,
    listWorktrees,
    getWorktree,
    recordActivity,
    mergeWorktree,
    cleanupWorktree,
    syncWithGit,
    getStaleWorktrees,
    cleanupStale,
  };
}

module.exports = { createWorktreeManager };
