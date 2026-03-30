'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../worktree-manager');
const originalExecFileSync = childProcess.execFileSync;

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

    return record;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    tempDirs = [];
    db = createDb();
    execFileSyncMock = vi.fn().mockReturnValue('');
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

    expect(created.branch).toBe('feat/new-login-flow');
    expect(created.worktree_path).toBe(path.join(repoPath, '.worktrees', 'feat-new-login-flow'));
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
    });
  });

  it('lists worktrees sorted by created_at descending and filters by repo', () => {
    const repoPathA = makeRepoRoot();
    const repoPathB = makeRepoRoot();

    insertWorktree({
      id: 'wt-old',
      repo_path: repoPathA,
      worktree_path: path.join(repoPathA, '.worktrees', 'feat-old'),
      created_at: '2026-03-30T09:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-new',
      repo_path: repoPathA,
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

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['rebase', 'release'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['checkout', 'release'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['merge', '--ff-only', 'feat/api-sync'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(manager.getWorktree('wt-merge')).toMatchObject({
      id: 'wt-merge',
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

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['worktree', 'remove', '--force', path.join(repoPath, '.worktrees', 'feat-cleanup')], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['worktree', 'prune'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['branch', '-D', 'feat/cleanup'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(manager.getWorktree('wt-cleanup')).toBeNull();
  });

  it('detects stale worktrees and supports dry-run stale cleanup without deleting rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T00:00:00.000Z'));

    const repoPath = makeRepoRoot();
    insertWorktree({
      id: 'wt-stale',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-stale'),
      last_activity_at: '2026-03-20T00:00:00.000Z',
    });
    insertWorktree({
      id: 'wt-fresh',
      repo_path: repoPath,
      worktree_path: path.join(repoPath, '.worktrees', 'feat-fresh'),
      last_activity_at: '2026-04-09T00:00:00.000Z',
    });

    expect(manager.getStaleWorktrees(7, repoPath).map((worktree) => worktree.id)).toEqual(['wt-stale']);
    expect(manager.listWorktrees(repoPath).find((worktree) => worktree.id === 'wt-stale').isStale).toBe(true);

    execFileSyncMock.mockClear();
    const result = manager.cleanupStale({ repoPath, staleDays: 7, dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      repo_path: repoPath,
      stale_days: 7,
      count: 1,
    });
    expect(result.worktrees.map((worktree) => worktree.id)).toEqual(['wt-stale']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vc_worktrees').get().count).toBe(2);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('does not insert a record when git worktree creation fails', () => {
    const repoPath = makeRepoRoot();
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('git worktree add failed');
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
