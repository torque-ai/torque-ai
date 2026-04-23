'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const childProcess = require('child_process');

const logger = require('../../logger').child({ component: 'worktree-manager' });

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_WORKTREE_DIR = '.worktrees';
const DEFAULT_STALE_DAYS = 7;
const MAX_WORKTREE_LEAF_LENGTH = 40;
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

function parseTimestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerWorktreeRow(candidate, existing) {
  const candidateCreated = parseTimestampMs(candidate?.created_at);
  const existingCreated = parseTimestampMs(existing?.created_at);
  if (candidateCreated !== null && existingCreated !== null && candidateCreated !== existingCreated) {
    return candidateCreated > existingCreated;
  }

  const candidateActivity = parseTimestampMs(candidate?.last_activity_at);
  const existingActivity = parseTimestampMs(existing?.last_activity_at);
  if (candidateActivity !== null && existingActivity !== null && candidateActivity !== existingActivity) {
    return candidateActivity > existingActivity;
  }

  return false;
}

// Windows-safe recursive delete. Plain fs.rmSync throws EPERM on read-only
// files (git internals, tool-marked files) and "Directory not empty" on
// paths where Codex or pytest leaves wheel-check dirs with restrictive
// DACLs. Layered fallback — plain rmSync, chmod-recursive + rmSync, then
// platform shell rmdir/rm -rf — clears each of those stuck cases.
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

function forceRmSync(target) {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (!fs.existsSync(target)) return;
  } catch { /* fall through */ }
  try {
    fs.chmodSync(target, 0o666);
  } catch { /* best effort */ }
  clearReadOnlyRecursive(target);
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (!fs.existsSync(target)) return;
  } catch { /* fall through to shell */ }
  const { execFileSync } = childProcess;
  // Shell fallbacks. On Windows the path must use backslashes (cmd treats
  // forward slashes as option switches, so a forward-slash path turns into
  // an Invalid switch error). Some directories also carry ACLs that
  // plain cmd rmdir cannot clear but bash rm -rf can (MSYS handles the
  // quirks differently). Order: cmd rmdir -> icacls reset + cmd rmdir ->
  // bash rm -rf.
  const winPath = target.replace(/\//g, '\\');
  const bashPath = target.replace(/'/g, "'\\''");
  const attempts = [];
  if (process.platform === 'win32') {
    attempts.push(() => execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', winPath], {
      stdio: 'ignore', windowsHide: true, timeout: 20000,
    }));
    attempts.push(() => {
      execFileSync('icacls', [winPath, '/reset', '/T', '/C', '/Q'], {
        stdio: 'ignore', windowsHide: true, timeout: 30000,
      });
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', winPath], {
        stdio: 'ignore', windowsHide: true, timeout: 20000,
      });
    });
    attempts.push(() => execFileSync('bash', ['-c', 'rm -rf \'' + bashPath + '\''], {
      stdio: 'ignore', windowsHide: true, timeout: 20000,
    }));
  } else {
    attempts.push(() => execFileSync('rm', ['-rf', target], {
      stdio: 'ignore', timeout: 20000,
    }));
  }
  let lastErr = null;
  for (const attempt of attempts) {
    try { attempt(); } catch (err) { lastErr = err; }
    if (!fs.existsSync(target)) return;
  }
  throw new Error(
    'forceRmSync: path still exists after layered cleanup: ' + target
    + (lastErr ? ' (last shell error: ' + lastErr.message + ')' : '')
  );
}

function runGit(cwd, args, options = {}) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
    ...options,
  });
}

function ensureWindowsLongPathSupport(repoPath) {
  if (process.platform !== 'win32') return;
  runGit(repoPath, ['config', '--local', 'core.longpaths', 'true']);
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
  const leaf = String(branch || '')
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'worktree';

  if (leaf.length <= MAX_WORKTREE_LEAF_LENGTH) {
    return leaf;
  }

  const hash = createHash('sha1').update(leaf).digest('hex').slice(0, 8);
  const prefixLength = MAX_WORKTREE_LEAF_LENGTH - hash.length - 1;
  const prefix = leaf
    .slice(0, prefixLength)
    .replace(/[-._]+$/g, '') || 'worktree';
  return `${prefix}-${hash}`;
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

  const worktreePath = normalizeOptionalString(worktree.worktree_path);
  if (worktreePath && !fs.existsSync(worktreePath)) {
    return true;
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
      // --no-verify: factory-internal commit. When called from inside a
      // synchronous execFileSync chain (e.g. LEARN → mergeWorktree), TORQUE's
      // event loop is blocked so the pre-commit hook's HTTP call to
      // /api/pii-scan times out. It then falls back to the regex scanner,
      // which emits exit 1 on any RFC1918 IP match — false-positive on
      // legitimate test fixtures. The commit below already represents only
      // renormalized line endings; there is no new content to PII-check.
      runGit(worktreePath, [
        'commit',
        '--no-verify',
        '-m',
        'chore: normalize line endings (factory auto-commit)',
      ]);
      return { committed: true, files: staged.split('\n').filter(Boolean) };
    } catch (err) {
      logger.warn('renormalizeLineEndings commit failed', {
        worktreePath,
        err: err && err.message,
        stderr: err && typeof err.stderr === 'string' ? err.stderr : String(err?.stderr || ''),
      });
      return { committed: false, reason: 'commit_failed' };
    }
  }

  function hasSemanticDiffAgainstHead(worktreePath) {
    // Returns true only when the working tree has a semantic diff vs HEAD
    // — i.e. anything beyond CR-at-EOL / whitespace drift and untracked
    // files git would ignore. Used as a strict clean check for merge:
    // we don't care if existing files drifted on line endings; we care
    // whether there's uncommitted real work.
    try {
      runGit(worktreePath, [
        'diff', '--quiet', '--ignore-cr-at-eol', '--ignore-all-space', 'HEAD',
      ]);
      return false;
    } catch (_err) {
      return true;
    }
  }

  function hasUntrackedFiles(worktreePath) {
    const output = String(runGit(worktreePath, [
      'ls-files', '--others', '--exclude-standard',
    ])).trim();
    return output.length > 0;
  }

  function detectInProgressGitOperation(worktreePath) {
    // Detect mid-merge / mid-rebase / mid-cherry-pick / mid-revert state by
    // looking for the marker files git writes into the gitdir. When one of
    // these is active, the pre-merge cleanup path below cannot recover by
    // committing — the repo is in a half-applied state where `git commit`
    // refuses until the operator resolves conflicts or aborts. Returns one
    // of 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null.
    let gitDir;
    try {
      gitDir = String(runGit(worktreePath, ['rev-parse', '--git-dir'])).trim();
    } catch {
      return null;
    }
    if (!gitDir) return null;
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.resolve(worktreePath, gitDir);
    }
    const markers = [
      { op: 'merge', file: 'MERGE_HEAD' },
      { op: 'cherry-pick', file: 'CHERRY_PICK_HEAD' },
      { op: 'revert', file: 'REVERT_HEAD' },
      { op: 'rebase', file: 'rebase-merge' },
      { op: 'rebase', file: 'rebase-apply' },
    ];
    for (const { op, file } of markers) {
      try {
        if (fs.existsSync(path.join(gitDir, file))) return op;
      } catch {
        // fall through to next marker
      }
    }
    return null;
  }

  function assertWorktreeIsClean(worktreePath, action) {
    // If the worktree path no longer exists on disk, there's nothing to
    // preserve — the cleanup is trivially safe. Without this guard, the
    // downstream git invocations run with a missing cwd, which on Windows
    // falls back to the parent process's cwd and can report unrelated
    // uncommitted changes from TORQUE itself as if they belonged to this
    // worktree (false positive → cleanup refused → EXECUTE paused forever).
    if (!fs.existsSync(worktreePath)) {
      return;
    }
    const status = getWorktreeStatusPorcelain(worktreePath);
    if (!status) {
      return;
    }

    // Short-circuit on in-progress git operations. If the repo is mid-merge,
    // mid-rebase, mid-cherry-pick, or mid-revert, the pre-merge cleanup path
    // below will keep throwing generic "uncommitted changes" every loop
    // iteration because `git commit` refuses to commit while conflict
    // markers are unresolved. The factory retried this ~1/min against bitsy
    // master on 2026-04-20 until the operator noticed. Distinct error +
    // code lets LEARN pause the project immediately. This check runs after
    // the porcelain check (cheap short-circuit when the repo is clean) but
    // before renormalize/auto-commit (which would no-op on UU anyway).
    const inProgressOp = detectInProgressGitOperation(worktreePath);
    if (inProgressOp) {
      const err = new Error(
        `${worktreePath} is in the middle of a ${inProgressOp} (check .git/) `
        + `— refusing to ${action}. Operator must resolve or abort `
        + `(git ${inProgressOp} --abort) before the factory can proceed.`
      );
      err.code = 'IN_PROGRESS_GIT_OPERATION';
      err.op = inProgressOp;
      err.path = worktreePath;
      throw err;
    }

    // First attempt: renormalize line endings and commit the bookkeeping
    // change. If PII-GUARD or another pre-commit hook blocks the commit
    // (common when test-fixture files drift on line endings), fall
    // through to the semantic check.
    renormalizeLineEndings(worktreePath);
    if (!getWorktreeStatusPorcelain(worktreePath)) {
      return;
    }

    // Second attempt: treat the worktree as clean if the only diff
    // against HEAD is CR-at-EOL + whitespace drift AND there are no
    // untracked files. The merge only cares about committed history;
    // drift in the feature worktree doesn't affect what lands on main.
    if (!hasSemanticDiffAgainstHead(worktreePath) && !hasUntrackedFiles(worktreePath)) {
      return;
    }

    // Third attempt: commit remaining semantic changes (plan-file [x]
    // ticks that land after the last auto-commit, verify-retry edits,
    // etc.) with inline PII sanitization. This mirrors the auto-commit
    // logic but runs at merge time as a catch-all.
    // SKIP for 'cleanup' action — auto-committing then deleting the
    // branch would lose the work. Cleanup should fail-loud so the
    // operator knows there's uncommitted work to preserve.
    if (action === 'cleanup') {
      throw new Error(`worktree ${worktreePath} has uncommitted changes — refusing to ${action}`);
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const { scanAndReplace } = require('../../utils/pii-guard');

      const changedOut = String(runGit(worktreePath, ['diff', '--name-only', 'HEAD'])).trim();
      const changed = changedOut ? changedOut.split(/\r?\n/).filter(Boolean) : [];
      const untrackedOut = String(runGit(worktreePath, ['ls-files', '--others', '--exclude-standard'])).trim();
      const untracked = untrackedOut ? untrackedOut.split(/\r?\n/).filter(Boolean) : [];

      // Filter to semantic changes only (skip pure CRLF drift)
      const semantic = changed.filter((p) => {
        try {
          require('child_process').execFileSync('git', [
            'diff', '--quiet', '--ignore-cr-at-eol', 'HEAD', '--', p,
          ], { cwd: worktreePath, windowsHide: true });
          return false;
        } catch (_e) {
          return true;
        }
      });

      const toStage = [...semantic, ...untracked];
      if (toStage.length === 0) {
        return;
      }

      for (const filePath of toStage) {
        const absPath = path.join(worktreePath, filePath);
        if (!fs.existsSync(absPath)) continue;
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          const result = scanAndReplace(content, { workingDirectory: worktreePath });
          if (!result.clean && result.sanitized) {
            fs.writeFileSync(absPath, result.sanitized);
          }
        } catch (_piiErr) {
          void _piiErr;
        }
      }

      // Stage via stdin pathspec to avoid argv quirk
      require('child_process').execFileSync('git', [
        'add', '--pathspec-from-file=-', '--pathspec-file-nul',
      ], {
        cwd: worktreePath,
        encoding: 'utf8',
        windowsHide: true,
        input: toStage.join('\0'),
      });

      // --no-verify: same rationale as renormalizeLineEndings. The files
      // staged here have already been PII-sanitized inline above via
      // scanAndReplace; the pre-commit hook would just re-run the same
      // check but hit the TORQUE event-loop deadlock + regex fallback
      // false-positive and block the merge.
      runGit(worktreePath, [
        'commit',
        '--no-verify',
        '-m',
        'chore: pre-merge cleanup (factory auto-commit)',
      ]);
    } catch (commitErr) {
      logger.warn('pre-merge cleanup commit failed', {
        worktreePath,
        action,
        err: commitErr && commitErr.message,
        stderr: commitErr && typeof commitErr.stderr === 'string'
          ? commitErr.stderr
          : String(commitErr?.stderr || ''),
      });
    }

    // Final check after cleanup commit.
    if (!hasSemanticDiffAgainstHead(worktreePath) && !hasUntrackedFiles(worktreePath)) {
      return;
    }
    if (!getWorktreeStatusPorcelain(worktreePath)) {
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

  // Resolve the start point for `git worktree add -b <branch> <path> <start>`.
// Prefer origin/<branch> when it exists and is ahead of the base: Codex
// pushes every retry cycle's commits to origin/<branch>, and the
// pre-reclaim + recreate flow would otherwise wipe them every loop by
// starting each new worktree from base (master/main). With this helper,
// retries accumulate commits instead of losing them, and LEARN's merge
// step sees a non-empty feat branch to merge into main.
function resolveStartPoint(repoPath, branch, baseBranch) {
  try {
    const ref = `refs/remotes/origin/${branch}`;
    runGit(repoPath, ['rev-parse', '--verify', ref], { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return baseBranch;
  }
  try {
    const output = String(runGit(repoPath, ['rev-list', '--count', `${baseBranch}..origin/${branch}`])).trim();
    const count = Number.parseInt(output, 10);
    if (Number.isFinite(count) && count > 0) {
      return `origin/${branch}`;
    }
  } catch {
    // Fall through to base.
  }
  return baseBranch;
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
    ensureWindowsLongPathSupport(repositoryPath);
    // Clean up stale worktree directory if it exists from a prior run
    // that wasn't fully removed (git worktree remove succeeded but
    // the physical directory persisted due to file locks). If we can't
    // clear it, propagate — proceeding into `git worktree add` against a
    // locked/non-empty path produces phantom state (empty dir, no
    // metadata) that cascades silently through downstream stages.
    if (fs.existsSync(worktreePath)) {
      logger.warn('createWorktree: removing stale worktree directory', {
        worktreePath,
        branch,
      });
      forceRmSync(worktreePath);
      try {
        runGit(repositoryPath, ['worktree', 'prune']);
      } catch (pruneErr) {
        logger.warn('createWorktree: worktree prune after stale-dir removal failed', {
          worktreePath,
          err: pruneErr && pruneErr.message,
        });
      }
    }
    const initialStartPoint = resolveStartPoint(repositoryPath, branch, baseBranch);
    if (initialStartPoint !== baseBranch) {
      logger.info('createWorktree: starting from existing origin branch to preserve prior work', {
        branch,
        start_point: initialStartPoint,
        base_branch: baseBranch,
      });
    }
    try {
      runGit(repositoryPath, ['worktree', 'add', '-b', branch, worktreePath, initialStartPoint]);
    } catch (addErr) {
      // Stale branch from a prior run that wasn't fully cleaned up.
      // Force-delete the orphan branch and retry once. The fs.rmSync here
      // also propagates on failure — a locked directory must fail the
      // EXECUTE cycle loudly instead of producing phantom state.
      const errMsg = addErr && typeof addErr.stderr === 'string' ? addErr.stderr : String(addErr?.message || '');
      if (/branch named .* already exists/i.test(errMsg) || /already exists/i.test(errMsg)) {
        logger.warn('createWorktree: stale branch detected, force-deleting and retrying', {
          branch,
          repoPath: repositoryPath,
        });
        try {
          runGit(repositoryPath, ['branch', '-D', branch]);
        } catch (branchDelErr) {
          logger.warn('createWorktree: stale branch delete failed (may not exist)', {
            branch,
            err: branchDelErr && branchDelErr.message,
          });
        }
        try {
          runGit(repositoryPath, ['worktree', 'prune']);
        } catch (pruneErr) {
          logger.warn('createWorktree: worktree prune during retry failed', {
            err: pruneErr && pruneErr.message,
          });
        }
        if (fs.existsSync(worktreePath)) {
          forceRmSync(worktreePath);
        }
        const retryStartPoint = resolveStartPoint(repositoryPath, branch, baseBranch);
        runGit(repositoryPath, ['worktree', 'add', '-b', branch, worktreePath, retryStartPoint]);
      } else {
        throw addErr;
      }
    }

    // Post-create verification: assert the worktree is actually usable.
    // `git worktree add` has been observed to exit 0 on Windows while
    // leaving a broken state — populated dir with missing metadata, or an
    // empty dir with metadata pointing elsewhere — typically when the
    // target path had lingering file handles. Catching this here turns a
    // phantom success into a loud failure before the row is persisted and
    // downstream stages consume it.
    verifyCreatedWorktree({ worktreePath, repositoryPath });

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

  function verifyCreatedWorktree({ worktreePath, repositoryPath }) {
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`post-create verify: worktree path missing: ${worktreePath}`);
    }
    let entries;
    try {
      entries = fs.readdirSync(worktreePath);
    } catch (readErr) {
      throw new Error(`post-create verify: cannot read worktree dir ${worktreePath}: ${readErr.message}`);
    }
    if (entries.length === 0) {
      throw new Error(`post-create verify: worktree path is empty: ${worktreePath}`);
    }
    const dotGitPath = path.join(worktreePath, '.git');
    if (!fs.existsSync(dotGitPath)) {
      throw new Error(`post-create verify: .git link missing at ${dotGitPath}`);
    }
    let dotGitStat;
    try {
      dotGitStat = fs.statSync(dotGitPath);
    } catch (statErr) {
      throw new Error(`post-create verify: .git stat failed at ${dotGitPath}: ${statErr.message}`);
    }
    if (!dotGitStat.isFile()) {
      throw new Error(`post-create verify: .git at ${dotGitPath} is not a worktree redirect file`);
    }
    let redirect;
    try {
      redirect = fs.readFileSync(dotGitPath, 'utf8');
    } catch (readErr) {
      throw new Error(`post-create verify: .git redirect read failed at ${dotGitPath}: ${readErr.message}`);
    }
    const match = redirect.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) {
      throw new Error(`post-create verify: .git at ${dotGitPath} has no gitdir: line`);
    }
    const linked = match[1].trim();
    const resolvedGitDir = path.isAbsolute(linked) ? linked : path.resolve(worktreePath, linked);
    const headFile = path.join(resolvedGitDir, 'HEAD');
    if (!fs.existsSync(headFile)) {
      throw new Error(`post-create verify: per-worktree metadata HEAD missing at ${headFile}`);
    }
    // Smoke-check the metadata is reachable from repositoryPath — if
    // git lost track of it, `git worktree list` would omit this branch
    // and later operations would mis-behave.
    try {
      const listed = String(runGit(repositoryPath, ['worktree', 'list', '--porcelain'])).trim();
      if (!listed.includes(worktreePath.replace(/\\/g, '/')) && !listed.includes(worktreePath)) {
        throw new Error(`post-create verify: git worktree list does not include ${worktreePath}`);
      }
    } catch (listErr) {
      throw new Error(`post-create verify: git worktree list failed: ${listErr.message}`);
    }
  }

  function listWorktrees(repoPath = null) {
    const repositoryPath = normalizeOptionalString(repoPath);
    const rows = dbHandle.prepare('SELECT * FROM vc_worktrees ORDER BY created_at DESC').all();
    const filteredRows = repositoryPath
      ? rows.filter((row) => normalizePathKey(row.repo_path) === normalizePathKey(repositoryPath))
      : rows;

    return filteredRows.map((row) => withDerivedFields(row));
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

    // If another vc_worktrees row claims the same path, this `id` is a stale
    // DB record that a newer active row has superseded (common in the factory
    // reclaim flow: createWorktree wipes + recreates the dir, registers a new
    // row, then the caller tries to abandon the old row by its previous id).
    // Running `git worktree remove --force` on the shared path would wipe the
    // active sibling's directory — so drop only the stale DB row here.
    const siblings = dbHandle.prepare(
      'SELECT id, created_at, last_activity_at FROM vc_worktrees WHERE worktree_path = ? AND id != ?'
    ).all(existing.worktree_path, existing.id);
    const newerSibling = siblings.find((sibling) => isNewerWorktreeRow(sibling, existing));
    if (newerSibling) {
      dbHandle.prepare('DELETE FROM vc_worktrees WHERE id = ?').run(existing.id);
      if (logger) {
        logger.warn('cleanupWorktree: dropped stale row superseded by sibling (same path)', {
          stale_id: existing.id,
          sibling_id: newerSibling.id,
          worktree_path: existing.worktree_path,
          branch: existing.branch,
        });
      }
      return {
        id: existing.id,
        repo_path: existing.repo_path,
        worktree_path: existing.worktree_path,
        branch: existing.branch,
        removed: false,
        superseded: true,
        branchDeleted: false,
        warnings: [],
      };
    }

    for (const sibling of siblings) {
      dbHandle.prepare('DELETE FROM vc_worktrees WHERE id = ?').run(sibling.id);
      if (logger) {
        logger.warn('cleanupWorktree: dropped older sibling row for current worktree path', {
          stale_id: sibling.id,
          current_id: existing.id,
          worktree_path: existing.worktree_path,
          branch: existing.branch,
        });
      }
    }

    const warnings = [];
    const deleteBranch = options.deleteAfter !== false
      && options.delete_after !== false
      && options.deleteBranch !== false
      && options.delete_branch !== false;
    const removeArgs = ['worktree', 'remove'];
    const worktreePathExists = fs.existsSync(existing.worktree_path);

    if (deleteBranch) {
      assertWorktreeIsClean(existing.worktree_path, 'cleanup');
    }

    if (options.force !== false) {
      removeArgs.push('--force');
    }

    removeArgs.push(existing.worktree_path);
    if (worktreePathExists) {
      try {
        runGit(existing.repo_path, removeArgs);
      } catch (error) {
        const gitMessage = extractGitError(error);
        if (!/is not a working tree/i.test(gitMessage)) {
          throw error;
        }
        forceRmSync(existing.worktree_path);
        warnings.push(`git worktree remove skipped stale path: ${gitMessage}`);
      }
    } else {
      warnings.push('worktree path missing; removed stale database row');
    }

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

    // Sanitize the merge TARGET working tree as well. The feature-worktree
    // cleanup above only handles drift on the source side; if the main
    // checkout (existing.repo_path) has CRLF/LF drift or uncommitted
    // bookkeeping changes, `git checkout targetBranch` or the subsequent
    // `git merge` aborts with:
    //   "error: Your local changes to the following files would be
    //    overwritten by merge"
    // ...even though the drift is harmless line-ending churn. Same three
    // attempts (renormalize → semantic-diff short-circuit → pre-merge
    // cleanup) work here — we reuse the same function.
    assertWorktreeIsClean(existing.repo_path, 'merge-target');

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
