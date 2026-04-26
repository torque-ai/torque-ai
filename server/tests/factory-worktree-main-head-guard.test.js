import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Database = require('better-sqlite3');
const decisionLog = require('../factory/decision-log');
const { guardMainRepoHead } = require('../factory/worktree-reconcile');

const originalExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
const PROJECT_ID = 'project-main-head-guard';

function runGit(repoPath, args) {
  return originalExecFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
}

function runDdl(db, sql) {
  return db['exec'](sql);
}

function createDb() {
  const db = new Database(':memory:');
  runDdl(db, `
    CREATE TABLE factory_projects (
      id TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT
    );

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
  db.prepare('INSERT INTO factory_projects (id, paused) VALUES (?, 0)').run(PROJECT_ID);
  return db;
}

function initRepo(tempDirs) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-main-head-guard-'));
  tempDirs.push(repoPath);

  runGit(repoPath, ['init', '--initial-branch=main']);
  runGit(repoPath, ['config', 'user.name', 'Factory Test']);
  runGit(repoPath, ['config', 'user.email', 'factory-test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'seed\n', 'utf8');
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['commit', '-m', 'initial commit']);

  return repoPath;
}

function currentBranch(repoPath) {
  return runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function checkoutNewBranch(repoPath, branch) {
  runGit(repoPath, ['checkout', '-b', branch]);
}

function insertWorktreeRow(db, { branch, status = 'active', worktreePath = '/tmp/factory-worktree' }) {
  db.prepare(`
    INSERT INTO factory_worktrees (
      project_id,
      branch,
      worktree_path,
      status
    ) VALUES (?, ?, ?, ?)
  `).run(PROJECT_ID, branch, worktreePath, status);
}

describe('guardMainRepoHead', () => {
  let db;
  let tempDirs;
  let logDecisionSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    tempDirs = [];
    db = createDb();
    logDecisionSpy = vi.spyOn(decisionLog, 'logDecision').mockReturnValue({ id: 1 });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (db) db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    vi.restoreAllMocks();
  });

  it('on feat-factory branch with no open row and clean tree -> resets to main and logs a decision', () => {
    const repoPath = initRepo(tempDirs);
    checkoutNewBranch(repoPath, 'feat-factory-123-foo');

    const result = guardMainRepoHead({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    });

    expect(result).toEqual({
      action: 'resolved',
      branch: 'feat-factory-123-foo',
      outcome: { resolved: 'reset_to_main' },
    });
    expect(currentBranch(repoPath)).toBe('main');
    expect(logDecisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      project_id: PROJECT_ID,
      stage: 'reconcile',
      actor: 'worktree-reconcile',
      action: 'main_repo_on_stale_factory_branch',
      inputs: { branch: 'feat-factory-123-foo' },
      outcome: { resolved: 'reset_to_main' },
    }));
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('"main_repo_on_stale_factory_branch"'));
  });

  it('on feat-factory branch with no open row and DIRTY tree -> pauses project, does not checkout', () => {
    const repoPath = initRepo(tempDirs);
    checkoutNewBranch(repoPath, 'feat-factory-123-foo');
    const dirtyFile = path.join(repoPath, 'uncommitted.txt');
    fs.writeFileSync(dirtyFile, 'do not clobber\n', 'utf8');

    const result = guardMainRepoHead({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    });

    expect(result.outcome).toEqual({
      resolved: 'paused_project',
      reason: 'dirty_working_tree',
    });
    expect(db.prepare('SELECT paused, pause_reason FROM factory_projects WHERE id = ?').get(PROJECT_ID)).toEqual({
      paused: 1,
      pause_reason: 'main_repo_on_stale_factory_branch_dirty_tree',
    });
    expect(currentBranch(repoPath)).toBe('feat-factory-123-foo');
    expect(fs.existsSync(dirtyFile)).toBe(true);
  });

  it('on feat-factory branch with a matching open factory_worktrees row -> no action', () => {
    const repoPath = initRepo(tempDirs);
    checkoutNewBranch(repoPath, 'feat-factory-123-foo');
    insertWorktreeRow(db, { branch: 'feat-factory-123-foo', status: 'active' });

    const result = guardMainRepoHead({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    });

    expect(result).toEqual({
      action: 'skip',
      reason: 'matching open factory_worktrees row',
      branch: 'feat-factory-123-foo',
    });
    expect(currentBranch(repoPath)).toBe('feat-factory-123-foo');
    expect(db.prepare('SELECT paused FROM factory_projects WHERE id = ?').get(PROJECT_ID).paused).toBe(0);
    expect(logDecisionSpy).not.toHaveBeenCalled();
  });

  it('on main -> no action', () => {
    const repoPath = initRepo(tempDirs);

    const result = guardMainRepoHead({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    });

    expect(result).toEqual({
      action: 'skip',
      reason: 'non-factory branch',
      branch: 'main',
    });
    expect(currentBranch(repoPath)).toBe('main');
    expect(logDecisionSpy).not.toHaveBeenCalled();
  });

  it('on feature/foo (non-factory) -> no action', () => {
    const repoPath = initRepo(tempDirs);
    checkoutNewBranch(repoPath, 'feature/foo');

    const result = guardMainRepoHead({
      db,
      project_id: PROJECT_ID,
      project_path: repoPath,
    });

    expect(result).toEqual({
      action: 'skip',
      reason: 'non-factory branch',
      branch: 'feature/foo',
    });
    expect(currentBranch(repoPath)).toBe('feature/foo');
    expect(logDecisionSpy).not.toHaveBeenCalled();
  });
});
