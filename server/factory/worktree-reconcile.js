'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const logger = require('../logger').child({ component: 'worktree-reconcile' });

const DEFAULT_WORKTREE_DIR = '.worktrees';
const FACTORY_LEAF_PREFIX = 'feat-factory-';
const RECLAIMABLE_STATUSES = new Set(['abandoned', 'shipped', 'merged']);
const RECONCILE_FAILURE_WARN_INTERVAL_MS = 15 * 60 * 1000;
const FACTORY_HEAD_PREFIX = /^feat[-/]factory-/;
const reconcileFailureLogState = new Map();

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

function isNotGitRepositoryError(err) {
  if (!err) return false;
  const code = err.code || err.status;
  if (code === 128) return true;
  const message = String(err.message || err.stderr || '').toLowerCase();
  return message.includes('not a git repository');
}

function isBusyDeleteError(err) {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  const message = String(err.message || err).toLowerCase();
  return code === 'ebusy' || code === 'eperm' || message.includes('device or resource busy');
}

function normalizeFactoryBranchName(branch) {
  if (!branch || typeof branch !== 'string') return null;
  const trimmed = branch.trim();
  if (!trimmed) return null;
  return trimmed.replace('feat/factory-', 'feat-factory-');
}

function areFactoryBranchNamesEquivalent(a, b) {
  if (a === b) return true;
  const normA = normalizeFactoryBranchName(a);
  const normB = normalizeFactoryBranchName(b);
  return Boolean(normA && normB && normA === normB);
}

function hasOpenFactoryWorktreeRowsForBranch(rows, branch) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  return rows.some((row) => {
    if (!row || typeof row.branch !== 'string') return false;
    if (!FACTORY_HEAD_PREFIX.test(row.branch)) return false;
    if (!areFactoryBranchNamesEquivalent(row.branch, branch)) return false;
    return !RECLAIMABLE_STATUSES.has(row.status || '');
  });
}

function insertReconcileDecisionRow(db, { project_id, action, inputs, outcome }) {
  if (!db || typeof db.prepare !== 'function') return;
  try {
    db.prepare(`
      INSERT INTO factory_decisions (
        project_id,
        stage,
        actor,
        action,
        inputs_json,
        outcome_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      project_id,
      'reconcile',
      'auto-recovery',
      action,
      JSON.stringify(inputs || {}),
      JSON.stringify(outcome || {}),
      new Date().toISOString(),
    );
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('no such table: factory_decisions')) {
      return;
    }
    throw err;
  }
}

function guardMainRepoHead({ db, project_id, project_path }) {
  let branch = null;
  try {
    branch = runGit(project_path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (err) {
    if (isNotGitRepositoryError(err)) {
      return;
    }
    throw err;
  }

  if (!branch || branch === 'main' || branch === 'master') {
    return;
  }
  if (!FACTORY_HEAD_PREFIX.test(branch)) {
    return;
  }

  const rows = listProjectFactoryWorktrees(db, project_id);
  if (hasOpenFactoryWorktreeRowsForBranch(rows, branch)) {
    return;
  }

  let hasDirtyTree = false;
  try {
    const status = runGit(project_path, ['status', '--porcelain']);
    hasDirtyTree = status.trim().length > 0;
  } catch (err) {
    logger.warn({ action: 'main_repo_head_status_failed', project_id, branch, err: err.message }, 'main repo head guard status check failed');
    return;
  }

  if (hasDirtyTree) {
    db.prepare('UPDATE factory_projects SET status = ? WHERE id = ?').run('paused', project_id);
    insertReconcileDecisionRow(db, {
      project_id,
      action: 'main_repo_on_stale_factory_branch',
      inputs: { branch },
      outcome: { resolved: 'paused_project', reason: 'dirty_working_tree' },
    });
    return;
  }

  runGit(project_path, ['checkout', 'main']);
  console.warn({
    action: 'main_repo_on_stale_factory_branch',
    project_id,
    branch,
    expected_main: 'main',
  });
  insertReconcileDecisionRow(db, {
    project_id,
    action: 'main_repo_on_stale_factory_branch',
    inputs: { branch },
    outcome: { resolved: 'reset_to_main' },
  });
}

function normalizePathKey(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();
}

function flattenAttemptErrors(attempts = []) {
  const out = [];
  for (const attempt of attempts || []) {
    if (!attempt || attempt.ok) continue;
    if (attempt.err) {
      out.push(`${attempt.step || 'unknown'}:${attempt.err}`);
    }
    if (Array.isArray(attempt.sub_attempts)) {
      out.push(...flattenAttemptErrors(attempt.sub_attempts));
    }
  }
  return out;
}

function reconcileFailureKey({ project_id, worktreePath, branch, reason, attempts }) {
  const errors = flattenAttemptErrors(attempts).join('|').slice(0, 1000);
  return [
    project_id || '',
    normalizePathKey(worktreePath),
    branch || '',
    reason || '',
    errors,
  ].join('::');
}

function shouldLogReconcileFailure(failure, nowMs = Date.now()) {
  const key = reconcileFailureKey(failure);
  const existing = reconcileFailureLogState.get(key);
  if (!existing || nowMs >= existing.nextLogAt) {
    const suppressedCount = existing?.suppressedCount || 0;
    reconcileFailureLogState.set(key, {
      nextLogAt: nowMs + RECONCILE_FAILURE_WARN_INTERVAL_MS,
      suppressedCount: 0,
    });
    return {
      log: true,
      suppressed_count: suppressedCount,
      next_log_at: new Date(nowMs + RECONCILE_FAILURE_WARN_INTERVAL_MS).toISOString(),
    };
  }

  existing.suppressedCount += 1;
  return {
    log: false,
    suppressed_count: existing.suppressedCount,
    next_log_at: new Date(existing.nextLogAt).toISOString(),
  };
}

function resetReconcileFailureLogStateForTests() {
  reconcileFailureLogState.clear();
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

function quarantineDir(dir) {
  if (!fs.existsSync(dir)) {
    return { ok: true, path: null };
  }

  const parent = path.dirname(dir);
  const leaf = path.basename(dir);
  const traceLeaf = leaf.length > 80 ? leaf.slice(0, 80) : leaf;
  const quarantineRoot = path.join(parent, '.torque-delete-pending');

  try {
    fs.mkdirSync(quarantineRoot, { recursive: true });
  } catch (err) {
    return { ok: false, path: null, err: `mkdir quarantine root failed: ${err.message}` };
  }

  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    const suffix = `${Date.now()}-${process.pid}-${i}`;
    const target = path.join(quarantineRoot, `${traceLeaf}-${suffix}`);
    try {
      fs.renameSync(dir, target);
      return { ok: !fs.existsSync(dir), path: target };
    } catch (err) {
      lastErr = err;
    }
  }

  return {
    ok: false,
    path: null,
    err: lastErr ? lastErr.message : 'rename failed',
  };
}

// Layered force-delete that handles Windows quirks. Order:
//   1. fs.rmSync recursive+force (works for the common case)
//   2. chmod-recursive to clear read-only, then rmSync again (handles git
//      internals and files marked read-only by build tools)
//   3. shell fallback via platform-native recursive delete (handles the
//      "Directory not empty" error from files rmSync cannot unlink —
//      e.g. symlinks, files open in another process that released the
//      lock between attempts).
//   4. quarantine rename when delete commands leave the original path behind
//      despite reporting success (observed on Windows with Bitsy pytest temp
//      roots that deny traversal). This releases the factory worktree path so
//      future work can reuse it while preserving the stubborn payload for
//      separate manual cleanup.
// Returns {ok, attempts: [{step, ok, err?}]}. `ok` reflects whether the
// original directory path is gone, not whether every step succeeded.
function forceRmDir(dir, options = {}) {
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

  const failedAttempts = attempts.filter((attempt) => !attempt.ok && attempt.err);
  const allBusy = failedAttempts.length > 0 && failedAttempts.every((attempt) => (
    isBusyDeleteError(attempt.err)
  ));
  if (allBusy && fs.existsSync(dir)) {
    return {
      ok: false,
      removed: false,
      reason: 'busy',
      attempts,
    };
  }

  if (!fs.existsSync(dir)) {
    return { ok: true, attempts };
  }

  if (options.quarantine !== false) {
    const quarantine = quarantineDir(dir);
    attempts.push({
      step: 'quarantine_rename',
      ok: quarantine.ok,
      err: quarantine.ok ? null : quarantine.err,
      quarantine_path: quarantine.path,
    });
    if (quarantine.ok) {
      return {
        ok: true,
        attempts,
        quarantined: true,
        quarantinePath: quarantine.path,
      };
    }
  }

  return { ok: !fs.existsSync(dir), attempts };
}

// Reclaim a stale worktree directory and its git metadata. Safe to call on
// entries that may be fully gone, partially gone, or still registered.
// Uses `git worktree remove --force` first (handles both metadata + dir),
// then falls back to node fs.rmSync (which handles Windows long paths via
// \\?\ prefixing) + prune + branch delete.
function reclaimDir({ repoPath, worktreePath, branch }) {
  const attempts = [];

  // Attempt 1: git-aware removal. Handles the case where .git/worktrees
  // still has a stale entry even if the physical dir is gone.
  const removeRes = tryGit(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  attempts.push({ step: 'worktree_remove', ok: removeRes.ok, err: removeRes.ok ? null : removeRes.err.message });

  // Attempt 2: if the directory is still on disk after git worktree remove
  // (git failed, partially deleted, or reported success without removing
  // the dir — e.g. Windows long paths exceeding MAX_PATH 260 chars), fall
  // back to node fs.rmSync which handles \\?\ prefixing automatically,
  // then layered forceRmDir for stubborn cases.
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
      quarantined: Boolean(rmResult.quarantined),
      quarantine_path: rmResult.quarantinePath || null,
    });
  }

  // Attempt 3: prune. Clears metadata for any worktree whose dir is missing.
  // Run AFTER the fs-level cleanup so prune sees the directory is gone and
  // properly removes the .git/worktrees/<name> registration entry.
  const pruneRes = tryGit(repoPath, ['worktree', 'prune']);
  attempts.push({ step: 'worktree_prune', ok: pruneRes.ok, err: pruneRes.ok ? null : pruneRes.err.message });

  // Attempt 4: branch delete. Orphan branch may linger even when the worktree
  // is gone; git worktree add -b will fail with "branch already exists".
  if (branch) {
    const branchRes = tryGit(repoPath, ['branch', '-D', branch]);
    attempts.push({ step: 'branch_delete', ok: branchRes.ok, err: branchRes.ok ? null : branchRes.err.message });
  }

  const stillOnDisk = fs.existsSync(worktreePath);
  const quarantineAttempt = attempts.find((attempt) => (
    attempt.step === 'fs_rm' && attempt.quarantined && attempt.quarantine_path
  ));
  return {
    success: !stillOnDisk,
    worktreePath,
    branch: branch || null,
    quarantined: Boolean(quarantineAttempt),
    quarantinePath: quarantineAttempt ? quarantineAttempt.quarantine_path : null,
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

// Look up vc_worktrees rows for a repo. The factory row is inserted AFTER
// the physical worktree is created (see loop-controller.js: createForBatch
// returns, THEN factoryWorktrees.recordWorktree runs). During that window
// a reconcile pass that only looks at factory_worktrees will see the dir
// as an orphan and reclaim it, wiping the just-created worktree out from
// under the EXECUTE stage. Consulting vc_worktrees closes the race: the
// vc row is inserted atomically with the physical dir by worktree-manager.
function listRepoVcWorktrees(db, repoPath) {
  try {
    return db.prepare(`
      SELECT id, repo_path, worktree_path, branch, status, created_at
      FROM vc_worktrees
      WHERE repo_path = ?
    `).all(repoPath);
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

function parseGitWorktreeList(projectPath) {
  try {
    const raw = runGit(projectPath, ['worktree', 'list', '--porcelain']);
    if (!raw) {
      return new Set();
    }

    const parsed = new Set();
    for (const line of String(raw).split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) {
        continue;
      }
      const worktreePath = line.slice('worktree '.length).trim();
      if (worktreePath) {
        parsed.add(normalizePathKey(worktreePath));
      }
    }
    return parsed;
  } catch (err) {
    if (isNotGitRepositoryError(err)) {
      return null;
    }
    throw err;
  }
}

// Minimum age (ms) before a factory-named dir with no DB row is considered
// a reclaimable orphan. Defense against a write-ahead race that even the
// vc_worktrees check doesn't fully close: worktree-manager's createWorktree
// creates the physical dir via `git worktree add` (line 519) BEFORE inserting
// the vc_worktrees row (line 578). Between those two synchronous steps, a
// parallel tick's reconcile that happens to query vc_worktrees first can
// miss the row-in-flight and reclaim the dir. Ages are cheap to compute
// from the .git redirect file's mtime; a truly abandoned dir will survive
// this window and get reclaimed on the next tick.
const ORPHAN_DIR_MIN_AGE_MS = 60 * 1000;

// An `active` factory_worktrees row is assumed to be owned by a live loop.
// Trust that ownership for up to STALE_ACTIVE_ROW_MAX_AGE_MS; past that,
// the loop instance has almost certainly died (server crash, terminated
// instance, orphaned batch) without flipping the row to abandoned/merged.
// The pre-fix reconciler refused to reclaim these forever, so dirs sat
// indefinitely — observed 2026-04-20 with `feat-factory-85` + `-99` at
// 24+ hours old. 12h is generous vs. the factory's single-digit-minute
// stage cadence, so anything older is near-certainly stranded.
const STALE_ACTIVE_ROW_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Parse a sqlite `created_at` TEXT column (datetime('now') format, i.e.
// `YYYY-MM-DD HH:MM:SS` in UTC) into epoch ms. Returns null on parse
// failure so callers can fall back to "treat as fresh" rather than
// crashing the reconcile loop on unexpected data.
function parseSqliteUtcTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  // Accept both `YYYY-MM-DD HH:MM:SS` and `YYYY-MM-DDTHH:MM:SSZ`.
  const normalized = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

// Read the .git redirect file inside a worktree dir and return its mtime.
// Null on any read failure — the caller treats null as "don't use freshness
// to skip", preserving pre-fix reclaim behavior for truly broken dirs.
function readDotGitMtime(dirPath) {
  try {
    const dotGit = path.join(dirPath, '.git');
    const stat = fs.statSync(dotGit);
    if (!stat.isFile()) return null;
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

// Decide whether a directory is a reclaimable orphan.
//   - matching factory_worktrees row with reclaimable status → yes
//   - matching factory_worktrees row with active/non-reclaimable status → no (still in use)
//   - no factory_worktrees row, but a vc_worktrees row for this path → no (mid-create;
//     factory row hasn't been inserted yet — deleting the dir would wipe the
//     worktree out from under a live EXECUTE stage)
//   - no DB row, directory name starts with feat-factory-, .git redirect
//     file mtime younger than ORPHAN_DIR_MIN_AGE_MS → no (freshly created
//     by an in-flight createWorktree call whose vc_worktrees insert hasn't
//     committed yet)
//   - no DB row, directory name starts with feat-factory- → yes (factory-created, abandoned without DB record)
//   - no DB row, non-factory naming → no (user worktree, leave alone)
function classifyDir(dirPath, rowsByPath, vcRowsByPath = new Map(), nowMs = Date.now()) {
  const key = normalizePathKey(dirPath);
  const row = rowsByPath.get(key);
  const leaf = path.basename(dirPath);

  if (row) {
    if (RECLAIMABLE_STATUSES.has(row.status)) {
      return { action: 'reclaim', reason: `db row status=${row.status}`, row };
    }
    // Stale-active override: if the row claims `active` but has been sitting
    // for longer than STALE_ACTIVE_ROW_MAX_AGE_MS, the owning loop is gone
    // and the row is stranded. Reclaim the dir and let a subsequent factory
    // run delete or re-activate the row.
    if (row.status === 'active' && row.created_at) {
      const createdMs = parseSqliteUtcTimestamp(row.created_at);
      if (createdMs !== null && (nowMs - createdMs) > STALE_ACTIVE_ROW_MAX_AGE_MS) {
        const ageH = Math.round((nowMs - createdMs) / 3600000);
        return {
          action: 'reclaim',
          reason: `stale active row (age ${ageH}h > ${STALE_ACTIVE_ROW_MAX_AGE_MS / 3600000}h)`,
          row,
        };
      }
    }
    return { action: 'skip', reason: `db row status=${row.status}`, row };
  }

  const vcRow = vcRowsByPath.get(key);
  if (vcRow) {
    return { action: 'skip', reason: `vc_worktrees row present (status=${vcRow.status || 'unknown'})`, row: null };
  }

  if (leaf.startsWith(FACTORY_LEAF_PREFIX)) {
    const mtime = readDotGitMtime(dirPath);
    if (mtime !== null && (nowMs - mtime) < ORPHAN_DIR_MIN_AGE_MS) {
      const ageSec = Math.round((nowMs - mtime) / 1000);
      return {
        action: 'skip',
        reason: `fresh factory dir (.git age ${ageSec}s < ${ORPHAN_DIR_MIN_AGE_MS / 1000}s); likely mid-create`,
        row: null,
      };
    }
    return { action: 'reclaim', reason: 'orphan factory dir with no db row', row: null };
  }

  return { action: 'skip', reason: 'non-factory dir with no db row', row: null };
}

function markStaleMissingActiveRows({ db, rows, dirs, nowMs = Date.now() }) {
  const abandonedRows = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return abandonedRows;
  }
  const dirKeys = new Set((dirs || []).map((dirPath) => normalizePathKey(dirPath)));
  const stmt = db.prepare(`
    UPDATE factory_worktrees
    SET status = 'abandoned',
        abandoned_at = datetime('now')
    WHERE id = ?
      AND status = 'active'
  `);

  for (const row of rows) {
    if (!row || row.status !== 'active' || !row.worktree_path) {
      continue;
    }
    const key = normalizePathKey(row.worktree_path);
    if (dirKeys.has(key)) {
      continue;
    }
    const createdMs = parseSqliteUtcTimestamp(row.created_at);
    if (createdMs === null || (nowMs - createdMs) <= STALE_ACTIVE_ROW_MAX_AGE_MS) {
      continue;
    }
    const result = stmt.run(row.id);
    if (result.changes > 0) {
      const ageH = Math.round((nowMs - createdMs) / 3600000);
      abandonedRows.push({
        id: row.id,
        worktreePath: row.worktree_path,
        branch: row.branch || null,
        reason: `stale active row missing dir (age ${ageH}h > ${STALE_ACTIVE_ROW_MAX_AGE_MS / 3600000}h)`,
      });
    }
  }

  return abandonedRows;
}

function sweepOrphanWorktreeDirs({ db, project_id, project_path, worktree_dir = DEFAULT_WORKTREE_DIR }) {
  const tally = { swept: 0, deferred_busy: 0, errored: 0 };
  const { dirs } = listWorktreeDirs(project_path, worktree_dir);
  const listedGitWorktrees = parseGitWorktreeList(project_path);

  if (!Array.isArray(dirs) || dirs.length === 0) {
    insertReconcileDecisionRow(db, {
      project_id,
      action: 'swept_orphan_worktree_dirs',
      inputs: {
        worktree_dir,
      },
      outcome: tally,
    });
    return tally;
  }

  const rows = listProjectFactoryWorktrees(db, project_id);
  const openPaths = new Set();
  for (const row of rows) {
    if (!row || !row.worktree_path) {
      continue;
    }
    if (RECLAIMABLE_STATUSES.has(row.status || '')) {
      continue;
    }
    openPaths.add(normalizePathKey(row.worktree_path));
  }

  if (listedGitWorktrees === null) {
    insertReconcileDecisionRow(db, {
      project_id,
      action: 'swept_orphan_worktree_dirs',
      inputs: {
        worktree_dir,
      },
      outcome: tally,
    });
    return tally;
  }

  for (const dirPath of dirs) {
    const key = normalizePathKey(dirPath);
    if (listedGitWorktrees.has(key)) {
      continue;
    }
    if (openPaths.has(key)) {
      continue;
    }

    const removal = forceRmDir(dirPath);
    if (removal.ok) {
      tally.swept += 1;
      continue;
    }
    if (removal.reason === 'busy') {
      tally.deferred_busy += 1;
      continue;
    }
    tally.errored += 1;
    logger.warn('failed to sweep orphan worktree directory', {
      project_id,
      worktreePath: dirPath,
      attempts: removal.attempts,
    });
  }

  insertReconcileDecisionRow(db, {
    project_id,
    action: 'swept_orphan_worktree_dirs',
    inputs: {
      worktree_dir,
    },
    outcome: tally,
  });

  return tally;
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

  guardMainRepoHead({ db, project_id, project_path });

  const cleaned = [];
  const skipped = [];
  const failed = [];
  const orphanSweep = { swept: 0, deferred_busy: 0, errored: 0 };

  const { root, dirs } = listWorktreeDirs(project_path, worktree_dir);
  const rows = listProjectFactoryWorktrees(db, project_id);
  const abandonedRows = markStaleMissingActiveRows({ db, rows, dirs });
  if (dirs.length === 0) {
    const sweepResult = sweepOrphanWorktreeDirs({
      db,
      project_id,
      project_path,
      worktree_dir,
    });
    orphanSweep.swept = sweepResult.swept;
    orphanSweep.deferred_busy = sweepResult.deferred_busy;
    orphanSweep.errored = sweepResult.errored;
    return {
      root,
      scanned: 0,
      cleaned,
      skipped,
      failed,
      abandonedRows,
      orphanSweep,
    };
  }

  // The branch → path map is deterministic, so a single path will
  // accumulate multiple factory_worktrees rows across its lifetime: every
  // pre-reclaim marks the prior row abandoned and the next EXECUTE inserts
  // a fresh active row for the same path. listProjectFactoryWorktrees
  // returns them newest-first (ORDER BY id DESC). A plain Map.set loop
  // overwrites each entry, so the final Map holds the OLDEST row per path
  // — typically abandoned — and classifyDir then reclaims the fresh dir
  // that the just-inserted active row actually owns. Keep only the
  // first-seen (newest) row per path.
  const rowsByPath = new Map();
  for (const row of rows) {
    if (!row.worktree_path) continue;
    const key = normalizePathKey(row.worktree_path);
    if (!rowsByPath.has(key)) {
      rowsByPath.set(key, row);
    }
  }

  const vcRows = listRepoVcWorktrees(db, project_path);
  const vcRowsByPath = new Map();
  for (const row of vcRows) {
    if (row.worktree_path) {
      vcRowsByPath.set(normalizePathKey(row.worktree_path), row);
    }
  }

  for (const dirPath of dirs) {
    const classification = classifyDir(dirPath, rowsByPath, vcRowsByPath);
    if (classification.action === 'skip') {
      skipped.push({ worktreePath: dirPath, reason: classification.reason });
      continue;
    }

    const branch = classification.row && classification.row.branch ? classification.row.branch : null;
    const result = reclaimDir({ repoPath: project_path, worktreePath: dirPath, branch });
    if (result.success) {
      const cleanedEntry = { worktreePath: dirPath, branch, reason: classification.reason };
      if (result.quarantined) {
        cleanedEntry.quarantined = true;
        cleanedEntry.quarantinePath = result.quarantinePath;
      }
      cleaned.push(cleanedEntry);
      logger.info('reconciled orphan worktree', {
        project_id,
        worktreePath: dirPath,
        branch,
        reason: classification.reason,
        quarantined: Boolean(result.quarantined),
        quarantinePath: result.quarantinePath || null,
      });
    } else {
      const failedEntry = {
        project_id,
        worktreePath: dirPath,
        branch,
        reason: classification.reason,
        attempts: result.attempts,
      };
      const logDecision = shouldLogReconcileFailure(failedEntry);
      failedEntry.log_suppressed = !logDecision.log;
      failedEntry.suppressed_count = logDecision.suppressed_count;
      failedEntry.next_log_at = logDecision.next_log_at;
      failed.push(failedEntry);
      if (logDecision.log) {
        logger.warn('failed to reconcile worktree', {
          project_id,
          worktreePath: dirPath,
          branch,
          attempts: result.attempts,
          suppressed_count: logDecision.suppressed_count,
          next_log_at: logDecision.next_log_at,
        });
      }
    }
  }

  const sweepResult = sweepOrphanWorktreeDirs({
    db,
    project_id,
    project_path,
    worktree_dir,
  });
  orphanSweep.swept = sweepResult.swept;
  orphanSweep.deferred_busy = sweepResult.deferred_busy;
  orphanSweep.errored = sweepResult.errored;

  return {
    root,
    scanned: dirs.length,
    cleaned,
    skipped,
    failed,
    abandonedRows,
    orphanSweep,
  };
}

module.exports = {
  reconcileProject,
  reclaimDir,
  classifyDir,
  markStaleMissingActiveRows,
  listProjectFactoryWorktrees,
  listRepoVcWorktrees,
  forceRmDir,
  clearReadOnlyRecursive,
  quarantineDir,
  shouldLogReconcileFailure,
  resetReconcileFailureLogStateForTests,
  RECONCILE_FAILURE_WARN_INTERVAL_MS,
  RECLAIMABLE_STATUSES,
  FACTORY_LEAF_PREFIX,
  parseGitWorktreeList,
  sweepOrphanWorktreeDirs,
  guardMainRepoHead,
};
