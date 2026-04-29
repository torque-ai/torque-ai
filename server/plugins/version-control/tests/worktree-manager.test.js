'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../worktree-manager');
// worker-setup.js stubs git via childProcess; _realExecFileSync is the saved real one.
const originalExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      feature_name TEXT,
      base_branch TEXT DEFAULT 'main',
      status TEXT DEFAULT 'active',
      commit_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT
    )
  `);
  return db;
}

function loadManager(db) {
  delete require.cache[MODULE_PATH];
  return require('../worktree-manager').createWorktreeManager({ db });
}

function runRealGit(cwd, args, options = {}) {
  return originalExecFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

describe('version-control worktree manager', () => {
  let db;
  let manager;
  let execFileSyncMock;
  let tempDirs;

  function makeRepoRoot() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-worktree-manager-'));
    tempDirs.push(repoRoot);
    return repoRoot;
  }

  function insertWorktree(overrides = {}) {
    const repoPath = overrides.repo_path || makeRepoRoot();
    const record = {
      id: overrides.id || `wt-${Math.random().toString(16).slice(2)}`,
      repo_path: repoPath,
      worktree_path: overrides.worktree_path || path.join(repoPath, '.worktrees', 'feat-sample'),
      branch: overrides.branch || 'feat/sample',
      feature_name: overrides.feature_name || 'sample',
      base_branch: overrides.base_branch || 'main',
      status: overrides.status || 'active',
      commit_count: overrides.commit_count ?? 0,
      created_at: overrides.created_at || '2026-03-30T00:00:00.000Z',
      last_activity_at: Object.prototype.hasOwnProperty.call(overrides, 'last_activity_at')
        ? overrides.last_activity_at
        : '2026-03-30T00:00:00.000Z',
    };

    db.prepare(`
      INSERT INTO vc_worktrees (
        id,
        repo_path,
        worktree_path,
        branch,
        feature_name,
        base_branch,
        status,
        commit_count,
        created_at,
        last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.repo_path,
      record.worktree_path,
      record.branch,
      record.feature_name,
      record.base_branch,
      record.status,
      record.commit_count,
      record.created_at,
      record.last_activity_at,
    );

    // Materialize the worktree path on disk so the worktree-manager's
    // fs.existsSync guards (e.g. in assertWorktreeIsClean) don't short-
    // circuit tests that exercise the full cleanup / merge sequence.
    // Tests that want to simulate a vanished worktree should either use
    // createWorktree (with a real dir) and then rm it, or pass
    // overrides.skipMkdir = true.
    if (!overrides.skipMkdir) {
      try {
        fs.mkdirSync(record.worktree_path, { recursive: true });
      } catch { /* best effort */ }
    }

    return record;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    tempDirs = [];
    db = createDb();
    // Mock simulates enough of git's worktree machinery to satisfy the
    // post-create verify (worktree-manager.js ~580-634) which walks:
    //   - worktreePath exists and is non-empty
    //   - worktreePath/.git is a REDIRECT FILE of the form
    //     "gitdir: <resolved>" (not a directory)
    //   - the resolved gitdir contains a HEAD file
    //   - `git worktree list --porcelain` includes the worktreePath
    // A plain mockReturnValue('') lies about git success without producing
    // any of that, so the verify throws and the test fails. We track paths
    // added during this test and echo them back for `worktree list`.
    const addedWorktrees = [];
    execFileSyncMock = vi.fn((cmd, args) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'add') {
        let worktreePath = null;
        for (let i = 2; i < args.length; i++) {
          const arg = args[i];
          if (arg === '-b' || arg === '-B') { i += 1; continue; }
          if (typeof arg !== 'string' || arg.startsWith('-')) continue;
          if (arg.includes('/') || arg.includes('\\')) { worktreePath = arg; break; }
        }
        if (worktreePath) {
          const fakeGitDir = path.join(worktreePath, '..', `.gitdir-${path.basename(worktreePath)}`);
          try {
            fs.mkdirSync(worktreePath, { recursive: true });
            fs.mkdirSync(fakeGitDir, { recursive: true });
            fs.writeFileSync(path.join(fakeGitDir, 'HEAD'), 'ref: refs/heads/main\n');
            fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${fakeGitDir}\n`);
            addedWorktrees.push(worktreePath);
          } catch { /* best effort */ }
        }
        return '';
      }
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'list') {
        return addedWorktrees.map((wt) => `worktree ${wt}\n`).join('') || '';
      }
      return '';
    });
    childProcess.execFileSync = execFileSyncMock;
    manager = loadManager(db);
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
    vi.useRealTimers();

    if (db) {
      db.close();
    }

    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('creates a worktree, runs git worktree add, and inserts the record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T10:15:00.000Z'));

    const repoPath = makeRepoRoot();
    const created = manager.createWorktree(repoPath, 'new login flow', { baseBranch: 'develop' });
    const leaf = path.basename(created.worktree_path);

    expect(created.branch).toBe('feat/new-login-flow');
    expect(leaf).toBe('fea-7038346e');
    expect(created.worktree_path).toBe(path.join(repoPath, '.worktrees', leaf));
    expect(created.base_branch).toBe('develop');
    expect(created.feature_name).toBe('new login flow');
    expect(created.status).toBe('active');
    expect(created.commit_count).toBe(0);
    expect(created.isStale).toBe(false);

    const stored = db.prepare('SELECT * FROM vc_worktrees WHERE id = ?').get(created.id);
    expect(stored).toMatchObject({
      repo_path: repoPath,
      worktree_path: created.worktree_path,
      branch: 'feat/new-login-flow',
      feature_name: 'new login flow',
      base_branch: 'develop',
      status: 'active',
      commit_count: 0,
      created_at: '2026-03-30T10:15:00.000Z',
      last_activity_at: '2026-03-30T10:15:00.000Z',
    });

    if (process.platform === 'win32') {
      expect(execFileSyncMock).toHaveBeenCalledWith('git', [
        'config',
        '--local',
        'core.longpaths',
        'true',
      ], {
        cwd: repoPath,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        killSignal: 'SIGKILL',
      });
    }

    expect(execFileSyncMock).toHaveBeenCalledWith('git', [
      'worktree',
      'add',
      '-b',
      'feat/new-login-flow',
      created.worktree_path,
      'develop',
    ], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
  });

  it('uses a stable short worktree directory leaf for long branch names', () => {
    const repoPath = makeRepoRoot();
    const featureName = 'factory-742-validate-parser-to-repository-separation-with-focused-regression-coverage';

    const created = manager.createWorktree(repoPath, featureName);
    const leaf = path.basename(created.worktree_path);

    expect(created.branch).toBe(`feat/${featureName}`);
    expect(leaf.length).toBeLessThanOrEqual(12);
    expect(leaf).toMatch(/^fea-[a-f0-9]{8}$/);
    expect(created.worktree_path).toBe(path.join(repoPath, '.worktrees', leaf));
  });

  it('quarantines an undeletable stale worktree path before recreating it', () => {
    const repoPath = makeRepoRoot();
    const stalePath = path.join(repoPath, '.worktrees', 'fea-7038346e');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, 'locked.tmp'), 'stale');

    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(stalePath)) {
        throw new Error('simulated locked directory');
      }
      return originalRmSync.call(fs, target, options);
    });

    try {
      const created = manager.createWorktree(repoPath, 'new login flow');
      const worktreeRoot = path.dirname(stalePath);
      const staleEntries = fs.readdirSync(worktreeRoot)
        .filter((entry) => entry.startsWith('.stale-fea-7038346e-'));

      expect(created.worktree_path).toBe(stalePath);
      expect(staleEntries).toHaveLength(1);
      expect(fs.existsSync(path.join(worktreeRoot, staleEntries[0], 'locked.tmp'))).toBe(true);
      expect(fs.existsSync(path.join(created.worktree_path, '.git'))).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('uses an alternate short worktree path when stale cleanup and quarantine both fail', () => {
    const repoPath = makeRepoRoot();
    const stalePath = path.join(repoPath, '.worktrees', 'fea-7038346e');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, 'locked.tmp'), 'stale');

    const originalRmSync = fs.rmSync;
    const originalRenameSync = fs.renameSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(stalePath)) {
        throw new Error('simulated locked directory');
      }
      return originalRmSync.call(fs, target, options);
    });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(from)) === path.resolve(stalePath)) {
        throw new Error(`simulated busy rename to ${to}`);
      }
      return originalRenameSync.call(fs, from, to);
    });

    try {
      const created = manager.createWorktree(repoPath, 'new login flow');

      expect(created.worktree_path).toBe(`${stalePath}-1`);
      expect(fs.existsSync(path.join(stalePath, 'locked.tmp'))).toBe(true);
      expect(fs.existsSync(path.join(created.worktree_path, '.git'))).toBe(true);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('lists worktrees sorted by created_at descending and filters by repo', () => {
    const repoPathA = makeRepoRoot();
    const repoPathASlash = repoPathA.replace(/\\/g, '/');
    const repoPathB = makeRepoRoot();

    insertWorktree({
      id: 'wt-old',
      repo_path: repoPathA,
      worktree_path: path.join(repoPathA, '.worktrees', 'feat-old'),
      created_at: '2026-03-30T09:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-new',
      repo_path: repoPathASlash,
      worktree_path: path.join(repoPathA, '.worktrees', 'feat-new'),
      created_at: '2026-03-30T12:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-other',
      repo_path: repoPathB,
      worktree_path: path.join(repoPathB, '.worktrees', 'feat-other'),
      created_at: '2026-03-30T11:00:00.000Z',
    });

    expect(manager.listWorktrees().map((worktree) => worktree.id)).toEqual([
      'wt-new',
      'wt-other',
      'wt-old',
    ]);

    expect(manager.listWorktrees(repoPathA).map((worktree) => worktree.id)).toEqual([
      'wt-new',
      'wt-old',
    ]);
  });

  it('gets a single worktree by id and returns null for unknown ids', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));

    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-find-me',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-find-me'),
      branch: 'feat/find-me',
      feature_name: 'find-me',
    });

    expect(manager.getWorktree('wt-find-me')).toMatchObject({
      id: 'wt-find-me',
      repo_path: repoPath,
      branch: 'feat/find-me',
      feature_name: 'find-me',
      isStale: false,
    });
    expect(manager.getWorktree('missing-id')).toBeNull();
  });

  it('records activity by updating last_activity_at and incrementing commit_count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T08:45:00.000Z'));

    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-activity',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-activity'),
      commit_count: 2,
      last_activity_at: '2026-03-30T08:45:00.000Z',
    });

    const updated = manager.recordActivity('wt-activity');

    expect(updated).toMatchObject({
      id: 'wt-activity',
      commit_count: 3,
      last_activity_at: '2026-03-31T08:45:00.000Z',
      isStale: false,
    });
    expect(manager.recordActivity('does-not-exist')).toBeNull();
  });

  it('merges a worktree with rebase strategy and marks it merged when deleteAfter is false', () => {
    const repoPath = makeRepoRoot();
    const worktreePath = path.join(repoPath, '.worktrees', 'feat-api-sync');
    insertWorktree({
      id: 'wt-merge',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/api-sync',
      feature_name: 'api-sync',
      base_branch: 'main',
    });
    execFileSyncMock.mockImplementation((command, args) => {
      if (args[0] === 'status') {
        return '';
      }

      if (args[0] === 'rev-list') {
        return '1\n';
      }

      return '';
    });

    const result = manager.mergeWorktree('wt-merge', {
      strategy: 'rebase',
      targetBranch: 'release',
      deleteAfter: false,
    });

    expect(result).toMatchObject({
      merged: true,
      id: 'wt-merge',
      branch: 'feat/api-sync',
      target_branch: 'release',
      strategy: 'rebase',
      cleaned: false,
    });

    // Call sequence: (1) git-dir probe, (2) assertClean(worktree),
    // (3) rev-list ahead check, (4) git-dir probe for merge-target,
    // (5) assertClean(repo — merge-target), (6) rebase, (7) checkout, (8) merge
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['rev-list', '--count', 'release..feat/api-sync'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(4, 'git', ['rev-parse', '--git-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    // Call 5: assertWorktreeIsClean(repo_path, 'merge-target') — target-side cleanup
    expect(execFileSyncMock).toHaveBeenNthCalledWith(5, 'git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(6, 'git', ['rebase', 'release'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(7, 'git', ['checkout', 'release'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(8, 'git', ['merge', '--ff-only', 'feat/api-sync'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });

    expect(manager.getWorktree('wt-merge')).toMatchObject({
      id: 'wt-merge',
      status: 'merged',
    });
  });

  it('returns cleanup_failed when post-merge cleanup throws after the merge already succeeded', () => {
    const repoPath = makeRepoRoot();
    const worktreePath = path.join(repoPath, '.worktrees', 'feat-cleanup-fail');
    insertWorktree({
      id: 'wt-merge-cleanup-fail',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/cleanup-fail',
      feature_name: 'cleanup-fail',
      base_branch: 'main',
    });
    execFileSyncMock.mockImplementation((command, args) => {
      if (args[0] === 'status') {
        return '';
      }

      if (args[0] === 'rev-list') {
        return '1\n';
      }

      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('Permission denied');
      }

      return '';
    });

    const result = manager.mergeWorktree('wt-merge-cleanup-fail');

    expect(result).toMatchObject({
      merged: true,
      id: 'wt-merge-cleanup-fail',
      branch: 'feat/cleanup-fail',
      target_branch: 'main',
      strategy: 'merge',
      cleaned: false,
      cleanup_failed: true,
      cleanup_error: 'Permission denied',
      worktree: expect.objectContaining({
        id: 'wt-merge-cleanup-fail',
        status: 'merged',
      }),
    });
    // Call sequence includes git-dir probes before each cleanliness check.
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['rev-list', '--count', 'main..feat/cleanup-fail'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(4, 'git', ['rev-parse', '--git-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    // Call 5: target-side cleanup check
    expect(execFileSyncMock).toHaveBeenNthCalledWith(5, 'git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(6, 'git', ['checkout', 'main'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(7, 'git', ['merge', '--no-ff', 'feat/cleanup-fail'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(8, 'git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(9, 'git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(10, 'git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(manager.getWorktree('wt-merge-cleanup-fail')).toMatchObject({
      id: 'wt-merge-cleanup-fail',
      status: 'merged',
    });
  });

  it('cleans up a worktree by removing it from git and deleting the db record', () => {
    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-cleanup',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-cleanup'),
      branch: 'feat/cleanup',
    });

    const result = manager.cleanupWorktree('wt-cleanup');

    expect(result).toEqual({
      id: 'wt-cleanup',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-cleanup'),
      branch: 'feat/cleanup',
      removed: true,
      branchDeleted: true,
      warnings: [],
    });

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--git-dir'], {
      cwd: path.join(repoPath, '.worktrees', 'feat-cleanup'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['status', '--porcelain'], {
      cwd: path.join(repoPath, '.worktrees', 'feat-cleanup'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['worktree', 'remove', '--force', path.join(repoPath, '.worktrees', 'feat-cleanup')], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(4, 'git', ['worktree', 'prune'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(5, 'git', ['branch', '-D', 'feat/cleanup'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    expect(manager.getWorktree('wt-cleanup')).toBeNull();
  });

  it('removes the current worktree when only older same-path db siblings exist', () => {
    const repoPath = makeRepoRoot();
    const worktreePath = path.join(repoPath, '.worktrees', 'feat-cleanup-sibling');
    insertWorktree({
      id: 'wt-old-sibling',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/cleanup-sibling',
      created_at: '2026-03-30T00:00:00.000Z',
      last_activity_at: '2026-03-30T00:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-current-sibling',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/cleanup-sibling',
      created_at: '2026-03-31T00:00:00.000Z',
      last_activity_at: '2026-03-31T00:00:00.000Z',
    });

    const result = manager.cleanupWorktree('wt-current-sibling');

    expect(result).toMatchObject({
      id: 'wt-current-sibling',
      worktree_path: worktreePath,
      removed: true,
      branchDeleted: true,
    });
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['worktree', 'remove', '--force', worktreePath], expect.objectContaining({
      cwd: repoPath,
    }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM vc_worktrees WHERE worktree_path = ?').get(worktreePath).count).toBe(0);
  });

  it('drops only the stale worktree row when a newer same-path db sibling exists', () => {
    const repoPath = makeRepoRoot();
    const worktreePath = path.join(repoPath, '.worktrees', 'feat-superseded');
    insertWorktree({
      id: 'wt-stale-sibling',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/superseded',
      created_at: '2026-03-30T00:00:00.000Z',
      last_activity_at: '2026-03-30T00:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-newer-sibling',
      repo_path: repoPath,
      worktree_path: worktreePath,
      branch: 'feat/superseded',
      created_at: '2026-03-31T00:00:00.000Z',
      last_activity_at: '2026-03-31T00:00:00.000Z',
    });

    const result = manager.cleanupWorktree('wt-stale-sibling');

    expect(result).toMatchObject({
      id: 'wt-stale-sibling',
      worktree_path: worktreePath,
      removed: false,
      superseded: true,
      branchDeleted: false,
    });
    expect(execFileSyncMock).not.toHaveBeenCalledWith('git', ['worktree', 'remove', '--force', worktreePath], expect.any(Object));
    expect(manager.getWorktree('wt-stale-sibling')).toBeNull();
    expect(manager.getWorktree('wt-newer-sibling')).toMatchObject({
      id: 'wt-newer-sibling',
      worktree_path: worktreePath,
    });
  });

  it('detects stale worktrees and supports dry-run stale cleanup without deleting rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T00:00:00.000Z'));

    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-stale',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-stale'),
      created_at: '2026-03-20T00:00:00.000Z',
      last_activity_at: '2026-03-20T00:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-fresh',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-fresh'),
      created_at: '2026-04-09T00:00:00.000Z',
      last_activity_at: '2026-04-09T00:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-missing-merged',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-missing-merged'),
      status: 'merged',
      created_at: '2026-03-19T00:00:00.000Z',
      last_activity_at: '2026-04-09T00:00:00.000Z',
      skipMkdir: true,
    });

    expect(manager.getStaleWorktrees(7, repoPath).map((worktree) => worktree.id)).toEqual(['wt-stale', 'wt-missing-merged']);
    expect(manager.listWorktrees(repoPath).find((worktree) => worktree.id === 'wt-stale').isStale).toBe(true);
    expect(manager.listWorktrees(repoPath).find((worktree) => worktree.id === 'wt-missing-merged').isStale).toBe(true);

    execFileSyncMock.mockClear();
    const result = manager.cleanupStale({ repoPath, staleDays: 7, dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      repo_path: repoPath,
      stale_days: 7,
      count: 2,
    });
    expect(result.worktrees.map((worktree) => worktree.id)).toEqual(['wt-stale', 'wt-missing-merged']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vc_worktrees').get().count).toBe(3);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('does not insert a record when git worktree creation fails', () => {
    const repoPath = makeRepoRoot();
    // Target the mock at the actual `git worktree add` call rather than "first
    // call" — createWorktree now invokes resolveStartPoint first, which calls
    // `git rev-parse` with a try/catch that swallows errors. A first-call-only
    // throw lands inside resolveStartPoint, gets swallowed, and `worktree add`
    // proceeds unimpeded — test flakes ~50% of runs depending on whether
    // resolveStartPoint's rev-parse call happens before the mocked throw.
    execFileSyncMock.mockImplementation((command, args) => {
      if (
        command === 'git'
        && Array.isArray(args)
        && args[0] === 'worktree'
        && args[1] === 'add'
      ) {
        throw new Error('git worktree add failed');
      }
      return '';
    });

    expect(() => manager.createWorktree(repoPath, 'broken')).toThrow('git worktree add failed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM vc_worktrees').get().count).toBe(0);
  });

  it('syncs tracked rows with git worktree list output and marks missing entries', () => {
    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-missing',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-missing'),
      branch: 'feat/missing',
      feature_name: 'missing',
      status: 'active',
    });

    execFileSyncMock.mockReturnValueOnce([
      `worktree ${repoPath}`,
      'HEAD abcdef1',
      'branch refs/heads/main',
      '',
      `worktree ${path.join(repoPath, '.worktrees', 'feat-present')}`,
      'HEAD abcdef2',
      'branch refs/heads/feat/present',
      '',
    ].join('\n'));

    const result = manager.syncWithGit(repoPath);

    expect(result).toMatchObject({
      repo_path: repoPath,
      discovered: 1,
      inserted: 1,
      updated: 0,
      missing: 1,
    });

    expect(manager.getWorktree('wt-missing')).toMatchObject({
      id: 'wt-missing',
      status: 'missing',
    });

    const inserted = manager.listWorktrees(repoPath).find((worktree) => worktree.branch === 'feat/present');
    expect(inserted).toMatchObject({
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-present'),
      branch: 'feat/present',
      feature_name: 'present',
      status: 'active',
    });
  });

  it('validates required inputs and merge strategy values', () => {
    expect(() => loadManager(null)).toThrow(/prepare/);
    expect(() => manager.createWorktree('', 'feature')).toThrow('repoPath is required');
    expect(() => manager.createWorktree(makeRepoRoot(), '')).toThrow('featureName is required');

    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-invalid-strategy',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-invalid'),
      branch: 'feat/invalid',
    });

    expect(() => manager.mergeWorktree('wt-invalid-strategy', { strategy: 'octopus' }))
      .toThrow('strategy must be one of: merge, squash, rebase');
  });
});

describe('version-control worktree manager (real git integration)', () => {
  let db;
  let manager;
  let tempDirs;

  function makeRepoRoot() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-worktree-manager-'));
    tempDirs.push(repoRoot);
    return repoRoot;
  }

  function initGitRepo() {
    const repoPath = makeRepoRoot();
    runRealGit(repoPath, ['init', '--initial-branch=main']);
    runRealGit(repoPath, ['config', 'user.name', 'Worktree Test']);
    runRealGit(repoPath, ['config', 'user.email', 'worktree-test@example.com']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'seed\n');
    runRealGit(repoPath, ['add', 'README.md']);
    runRealGit(repoPath, ['commit', '-m', 'initial commit']);
    return repoPath;
  }

  function branchExists(repoPath, branch) {
    return runRealGit(repoPath, ['branch', '--list', branch]).trim().includes(branch);
  }

  beforeEach(() => {
    childProcess.execFileSync = originalExecFileSync;
    vi.restoreAllMocks();
    vi.useRealTimers();
    tempDirs = [];
    db = createDb();
    manager = require('../worktree-manager').createWorktreeManager({ db });
  });

  afterEach(() => {
    delete require.cache[require.resolve('../worktree-manager')];
    vi.useRealTimers();

    if (db) {
      db.close();
    }

    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('mergeWorktree throws when the branch has no commits ahead of target and preserves the worktree', () => {
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'empty branch');

    expect(() => manager.mergeWorktree(created.id)).toThrow('no commits ahead');
    expect(fs.existsSync(created.worktree_path)).toBe(true);
    expect(branchExists(repoPath, created.branch)).toBe(true);
    expect(manager.getWorktree(created.id)).not.toBeNull();
  });

  it('mergeWorktree auto-commits untracked files via pre-merge cleanup and merges successfully', () => {
    // Post --no-verify fix: assertWorktreeIsClean's attempt-3 (pre-merge
    // cleanup) commits untracked files + semantic diffs with --no-verify.
    // This means uncommitted changes no longer block the merge — they get
    // committed as "chore: pre-merge cleanup" before the merge proceeds.
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'dirty branch');

    // Seed a feature commit so the branch is ahead
    fs.writeFileSync(path.join(created.worktree_path, 'feature.txt'), 'feature\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    // Leave an untracked file — pre-merge cleanup will commit it
    fs.writeFileSync(path.join(created.worktree_path, 'draft.txt'), 'draft\n');

    const result = manager.mergeWorktree(created.id, { deleteAfter: false });
    expect(result).toMatchObject({ merged: true });

    const log = runRealGit(repoPath, ['log', '--pretty=%s', 'main']).trim();
    expect(log).toMatch(/pre-merge cleanup/);
  }, 60000); // 60s timeout — initGitRepo + createWorktree + 2 commits + mergeWorktree
              // (which does its own attempt-3 cleanup commit + merge) is 5+ git
              // invocations. On Windows under Defender each git.exe call is
              // slow; the default 15s testTimeout was firing before the merge
              // step completed. This passes in ~2-5s on a healthy box.

  it('mergeWorktree auto-commits line-ending drift before the clean check (Windows + remote Linux test runs)', () => {
    const repoPath = initGitRepo();
    // Enable autocrlf on this test repo so the renormalize pass has something
    // to do — this mirrors a Windows dev checkout that received LF files
    // from a Linux vitest runner via torque-remote.
    runRealGit(repoPath, ['config', 'core.autocrlf', 'true']);
    const created = manager.createWorktree(repoPath, 'crlf drift');
    runRealGit(created.worktree_path, ['config', 'core.autocrlf', 'true']);

    // Seed a feature commit using LF line endings in the worktree's index.
    const featurePath = path.join(created.worktree_path, 'feature.txt');
    fs.writeFileSync(featurePath, 'feature line 1\nfeature line 2\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    // Now rewrite the file with CRLF — simulates the drift a remote Linux
    // test runner can leave behind after syncing back to a Windows worktree.
    fs.writeFileSync(featurePath, 'feature line 1\r\nfeature line 2\r\n');
    const dirtyStatus = runRealGit(created.worktree_path, ['status', '--porcelain']).trim();
    expect(dirtyStatus).toMatch(/feature\.txt/);

    const result = manager.mergeWorktree(created.id, { deleteAfter: false });

    expect(result).toMatchObject({
      merged: true,
      branch: created.branch,
      target_branch: 'main',
      strategy: 'merge',
    });

    // Main received the feature + the line-ending normalization commit.
    const log = runRealGit(repoPath, ['log', '--pretty=%s', 'main']).trim();
    expect(log).toMatch(/add feature/);
    // The auto-commit message is recorded when any renormalization landed.
    expect(log).toMatch(/(add feature|normalize line endings)/);
  }, 60000); // 60s timeout — initGitRepo + createWorktree + 2 commits + CRLF
              // rewrite + mergeWorktree (which adds a renormalize-and-commit
              // pass before the clean check) is 7+ git.exe invocations. The
              // sibling test on line 954 was bumped for the same reason
              // (commit b2dddf9b 2026-04-27); this one was missed.

  it('mergeWorktree succeeds when the worktree branch is ahead and clean', () => {
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'clean merge');

    fs.writeFileSync(path.join(created.worktree_path, 'feature.txt'), 'feature\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    const result = manager.mergeWorktree(created.id, { deleteAfter: false });

    expect(result).toMatchObject({
      merged: true,
      id: created.id,
      branch: created.branch,
      target_branch: 'main',
      strategy: 'merge',
      cleaned: false,
    });
    expect(fs.readFileSync(path.join(repoPath, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('feature\n');
    expect(manager.getWorktree(created.id)).toMatchObject({
      id: created.id,
      status: 'merged',
    });
  });

  it('mergeWorktree refuses to auto-commit semantic drift on the main repo under "pre-merge cleanup"', () => {
    // Guards the 2026-04-24 regression where main's working tree had semantic
    // drift vs HEAD at merge time (cause uncertain — concurrent write, stale
    // checkout, whatever). The factory's attempt-3 "pre-merge cleanup" path
    // committed that drift under a misleading message and wiped 150 lines of
    // shipped perf work on main. Fix: refuse to auto-commit semantic drift
    // on the merge target; surface a MAIN_REPO_SEMANTIC_DRIFT error so the
    // operator can investigate.
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'merge target drift');

    fs.writeFileSync(path.join(created.worktree_path, 'feature.txt'), 'feature\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    // Corrupt the main repo's working tree: substantive, non-EOL change.
    const readmePath = path.join(repoPath, 'README.md');
    fs.writeFileSync(readmePath, '# Totally different content\nnot line-ending drift\n');

    expect(() => manager.mergeWorktree(created.id, { deleteAfter: false }))
      .toThrow(/semantic drift vs HEAD|MAIN_REPO_SEMANTIC_DRIFT/);

    // Main must still be at its original state; no silent clobber commit.
    const log = runRealGit(repoPath, ['log', '--pretty=%s', 'main']).trim();
    expect(log).not.toMatch(/pre-merge cleanup/);
    expect(log).not.toMatch(/normalize line endings/);
  });

  it('renormalizeLineEndings path refuses to commit when the staged diff is semantic, not EOL-only', () => {
    // Unit-level check on the first-attempt commit: when git add --renormalize
    // stages a blob that has semantic content differences (not just CRLF/LF),
    // the commit under "chore: normalize line endings" is misleading. Refuse,
    // reset the index, and let the caller decide.
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'renormalize semantic');

    fs.writeFileSync(path.join(created.worktree_path, 'feature.txt'), 'feature\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    // Corrupt README.md on the feature worktree with semantic content.
    fs.writeFileSync(path.join(created.worktree_path, 'README.md'), '# Not the original readme\n');

    // Merge action runs attempt-1 (renormalize) first — semantic content
    // means renormalize must refuse, then attempt-3 cleanup commits the real
    // diff under the honest "pre-merge cleanup" message. There must NEVER
    // be a "normalize line endings" commit on top of semantic content.
    manager.mergeWorktree(created.id, { deleteAfter: false });
    const log = runRealGit(repoPath, ['log', '--pretty=%s', 'main']).trim();
    expect(log).not.toMatch(/normalize line endings/);
  });

  it('cleanupWorktree blocks dirty branch-deleting cleanup but allows explicit recovery cleanup without deleting the branch', () => {
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'dirty cleanup');

    fs.writeFileSync(path.join(created.worktree_path, 'draft.txt'), 'draft\n');

    expect(() => manager.cleanupWorktree(created.id, { deleteBranch: true })).toThrow('uncommitted changes');
    expect(fs.existsSync(created.worktree_path)).toBe(true);
    expect(branchExists(repoPath, created.branch)).toBe(true);

    const result = manager.cleanupWorktree(created.id, { deleteBranch: false, force: true });

    expect(result).toMatchObject({
      id: created.id,
      removed: true,
      branchDeleted: false,
    });
    expect(fs.existsSync(created.worktree_path)).toBe(false);
    expect(branchExists(repoPath, created.branch)).toBe(true);
    expect(manager.getWorktree(created.id)).toBeNull();
  });

  it('mergeWorktree short-circuits with IN_PROGRESS_GIT_OPERATION when the target repo is mid-merge', () => {
    // Guards the bitsy 2026-04-20 incident: target repo left in UU / mid-
    // merge state → pre-merge cleanup retries `git commit` forever → 13
    // "uncommitted changes" errors in 75 minutes. The detector must
    // short-circuit with a distinct code so LEARN can pause the project
    // instead of retrying once per minute.
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'conflict branch');

    // Branch ahead of main so we pass the empty-branch guard and actually
    // reach the merge-target clean check.
    fs.writeFileSync(path.join(created.worktree_path, 'feature.txt'), 'feature\n');
    runRealGit(created.worktree_path, ['add', 'feature.txt']);
    runRealGit(created.worktree_path, ['commit', '-m', 'add feature']);

    // Simulate a mid-merge state on the target repo by writing the
    // MERGE_HEAD marker git uses when a merge is in progress. No need to
    // construct a real conflict — the factory's detector checks for the
    // marker files, which is how `git merge --abort` knows it has something
    // to abort.
    const mergeHead = path.join(repoPath, '.git', 'MERGE_HEAD');
    const headSha = runRealGit(repoPath, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(mergeHead, `${headSha}\n`);

    let caught;
    try {
      manager.mergeWorktree(created.id, { deleteAfter: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('IN_PROGRESS_GIT_OPERATION');
    expect(caught.op).toBe('merge');
    expect(caught.message).toMatch(/middle of a merge/);
    // Worktree + branch preserved — operator still has a path to recover.
    expect(fs.existsSync(created.worktree_path)).toBe(true);
    expect(branchExists(repoPath, created.branch)).toBe(true);
  });

  it('cleanupWorktree succeeds when the worktree directory is already gone (stale DB row)', () => {
    // Guards the factory's abandon→cleanupWorktree→assertWorktreeIsClean
    // path: when another process or a partial prior cleanup has already
    // removed the worktree dir, the row's branch-delete cleanup must
    // still succeed. Without the fs.existsSync guard in
    // assertWorktreeIsClean, `git status --porcelain` runs with a
    // missing cwd and on Windows falls back to the parent process's cwd,
    // producing a false-positive "has uncommitted changes" and wedging
    // the factory at EXECUTE forever.
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'vanished worktree');

    // Simulate the worktree directory being removed out from under the DB.
    // Leave the branch in place so the delete-branch path is exercised.
    fs.rmSync(created.worktree_path, { recursive: true, force: true });
    expect(fs.existsSync(created.worktree_path)).toBe(false);

    const result = manager.cleanupWorktree(created.id, { deleteBranch: true });

    expect(result).toMatchObject({
      id: created.id,
      removed: true,
    });
    expect(manager.getWorktree(created.id)).toBeNull();
  });

  it('cleanupWorktree succeeds when the missing worktree has already been pruned by git', () => {
    const repoPath = initGitRepo();
    const created = manager.createWorktree(repoPath, 'pruned vanished worktree');

    fs.rmSync(created.worktree_path, { recursive: true, force: true });
    runRealGit(repoPath, ['worktree', 'prune']);
    expect(runRealGit(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain(created.worktree_path);

    const result = manager.cleanupWorktree(created.id, { deleteBranch: true });

    expect(result).toMatchObject({
      id: created.id,
      removed: true,
      branchDeleted: true,
    });
    expect(result.warnings).toContain('worktree path missing; removed stale database row');
    expect(manager.getWorktree(created.id)).toBeNull();
    expect(branchExists(repoPath, created.branch)).toBe(false);
  });
});
