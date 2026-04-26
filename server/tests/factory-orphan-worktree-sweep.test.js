'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Database = require('better-sqlite3');

const logger = require('../logger');
const decisionLog = require('../factory/decision-log');
const worktreeReconcile = require('../factory/worktree-reconcile');

const {
  forceRmDir,
  sweepOrphanWorktreeDirs,
} = worktreeReconcile;

const PROJECT_ID = 'project-orphan-worktree-sweep';
const defaultExecFileSync = childProcess.execFileSync;
const realExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;

function runDdl(db, sql) {
  return db['exec'](sql);
}

function createDb() {
  const db = new Database(':memory:');
  runDdl(db, `
    CREATE TABLE factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      work_item_id INTEGER,
      batch_id TEXT,
      vc_worktree_id TEXT,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );
  `);
  return db;
}

function git(repoPath, args) {
  return realExecFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
}

function withRealGit(fn) {
  const previous = childProcess.execFileSync;
  childProcess.execFileSync = realExecFileSync;
  try {
    return fn();
  } finally {
    childProcess.execFileSync = previous;
  }
}

function initRepo(tempDirs) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-orphan-worktree-'));
  tempDirs.push(repoPath);

  try {
    git(repoPath, ['init', '--initial-branch=main']);
  } catch {
    git(repoPath, ['init']);
    git(repoPath, ['checkout', '-B', 'main']);
  }
  git(repoPath, ['config', 'user.name', 'Factory Test']);
  git(repoPath, ['config', 'user.email', 'factory-test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'seed\n', 'utf8');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial commit']);

  return repoPath;
}

function makeWorktreeDir(repoPath, leaf) {
  const dir = path.join(repoPath, '.worktrees', leaf);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dummy.txt'), 'x\n', 'utf8');
  return dir;
}

function insertOpenWorktreeRow(db, { worktreePath, status = 'active', branch = 'feat/factory-active' }) {
  db.prepare(`
    INSERT INTO factory_worktrees (
      project_id,
      work_item_id,
      batch_id,
      vc_worktree_id,
      branch,
      worktree_path,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(PROJECT_ID, 1, 'batch-1', 'vc-1', branch, worktreePath, status);
}

function hasWarnContaining(warnSpy, text) {
  return warnSpy.mock.calls.some((call) =>
    call.some((arg) => typeof arg === 'string' && arg.includes(text))
  );
}

describe('sweepOrphanWorktreeDirs', () => {
  let db;
  let tempDirs;
  let warnSpy;
  let logDecisionSpy;

  beforeEach(() => {
    db = createDb();
    tempDirs = [];
    warnSpy = vi.spyOn(logger.Logger.prototype, 'warn').mockImplementation(() => {});
    logDecisionSpy = vi.spyOn(decisionLog, 'logDecision').mockReturnValue({
      id: 1,
      created_at: '2026-04-21T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    childProcess.execFileSync = defaultExecFileSync;
    if (db) db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('on-disk dir not in git worktree list and not in DB and not busy -> removed, swept incremented', () => {
    const repoPath = initRepo(tempDirs);
    const ghostDir = makeWorktreeDir(repoPath, 'feat-ghost-1');

    const counts = withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(counts).toEqual({ swept: 1, deferred_busy: 0, errored: 0 });
    expect(fs.existsSync(ghostDir)).toBe(false);
  });

  it('busy dir -> left in place, deferred_busy incremented, no warn log for rm failure', () => {
    const repoPath = initRepo(tempDirs);
    const busyDir = makeWorktreeDir(repoPath, 'feat-busy-1');
    vi.spyOn(worktreeReconcile, 'forceRmDir').mockReturnValue({
      ok: false,
      reason: 'busy',
      attempts: [{ step: 'rm_plain', ok: false, err: 'EBUSY: resource busy' }],
    });

    const counts = withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(counts).toEqual({ swept: 0, deferred_busy: 1, errored: 0 });
    expect(fs.existsSync(busyDir)).toBe(true);
    expect(hasWarnContaining(warnSpy, 'rm failed')).toBe(false);
  });

  it('real failure (non-busy error) -> errored incremented, warn logged', () => {
    const repoPath = initRepo(tempDirs);
    makeWorktreeDir(repoPath, 'feat-error-1');
    vi.spyOn(worktreeReconcile, 'forceRmDir').mockReturnValue({
      ok: false,
      attempts: [{ step: 'rm_plain', ok: false, err: 'EACCES: permission denied' }],
    });

    const counts = withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(counts).toEqual({ swept: 0, deferred_busy: 0, errored: 1 });
    expect(hasWarnContaining(warnSpy, 'rm failed')).toBe(true);
  });

  it('active worktree dirs (present in git worktree list) are untouched', () => {
    const repoPath = initRepo(tempDirs);
    const activeDir = path.join(repoPath, '.worktrees', 'feat-active-1');
    fs.mkdirSync(path.dirname(activeDir), { recursive: true });
    git(repoPath, ['worktree', 'add', '-b', 'feat-active-1', activeDir, 'HEAD']);

    const counts = withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(counts).toEqual({ swept: 0, deferred_busy: 0, errored: 0 });
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it('dir referenced by an open factory_worktrees row is untouched', () => {
    const repoPath = initRepo(tempDirs);
    const activeDir = makeWorktreeDir(repoPath, 'feat-active-2');
    insertOpenWorktreeRow(db, {
      worktreePath: activeDir,
      status: 'active',
      branch: 'feat/factory-active-2',
    });

    const counts = withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(counts).toEqual({ swept: 0, deferred_busy: 0, errored: 0 });
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it('one decisions row written per cycle regardless of counts', () => {
    const repoPath = initRepo(tempDirs);
    makeWorktreeDir(repoPath, 'feat-ghost-1');

    withRealGit(() => sweepOrphanWorktreeDirs({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    }));

    expect(logDecisionSpy).toHaveBeenCalledTimes(1);
    expect(logDecisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'swept_orphan_worktree_dirs',
      outcome: { swept: 1, deferred_busy: 0, errored: 0 },
    }));
  });
});

describe('forceRmDir busy classification', () => {
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    childProcess.execFileSync = defaultExecFileSync;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('forceRmDir returns reason: busy when all attempts fail with EBUSY', () => {
    const busyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-rm-busy-'));
    tempDirs.push(busyDir);
    fs.writeFileSync(path.join(busyDir, 'locked.txt'), 'x\n', 'utf8');

    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy');
    });
    const shellSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('EBUSY: device or resource busy');
    });

    const busyResult = forceRmDir(busyDir);

    expect(busyResult.ok).toBe(false);
    expect(busyResult.reason).toBe('busy');

    const nonBusyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-rm-nonbusy-'));
    tempDirs.push(nonBusyDir);
    fs.writeFileSync(path.join(nonBusyDir, 'locked.txt'), 'x\n', 'utf8');
    rmSpy.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    shellSpy.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const nonBusyResult = forceRmDir(nonBusyDir);

    expect(nonBusyResult.ok).toBe(false);
    expect(nonBusyResult).not.toHaveProperty('reason');
  });
});
