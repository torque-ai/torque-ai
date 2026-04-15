import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const childProcess = require('child_process');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryWorktrees = require('../db/factory-worktrees');
const taskCore = require('../db/task-core');
const { taskEvents } = require('../hooks/event-dispatch');

const MODULE_PATH = require.resolve('../factory/worktree-auto-commit');
const originalExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;

function runRealGit(cwd, args, options = {}) {
  return originalExecFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

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
    );

    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_factory_worktrees_project_active
      ON factory_worktrees(project_id, status);

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      task_description TEXT,
      working_directory TEXT,
      tags TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function loadAutoCommitModule() {
  delete require.cache[MODULE_PATH];
  return require('../factory/worktree-auto-commit');
}

function initGitWorktree(tempDirs) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-worktree-auto-commit-'));
  tempDirs.push(repoPath);
  runRealGit(repoPath, ['init', '--initial-branch=main']);
  runRealGit(repoPath, ['config', 'user.name', 'Factory Test']);
  runRealGit(repoPath, ['config', 'user.email', 'factory-test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'seed\n');
  runRealGit(repoPath, ['add', 'README.md']);
  runRealGit(repoPath, ['commit', '-m', 'initial commit']);

  const worktreePath = path.join(repoPath, '.worktrees', 'feat-auto-commit');
  runRealGit(repoPath, ['worktree', 'add', '-b', 'feat/auto-commit', worktreePath, 'main']);

  return { repoPath, worktreePath };
}

function seedFactoryProject(db, worktreePath) {
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, trust_level, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    'Factory Auto Commit',
    worktreePath,
    'supervised',
    'paused',
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

  const workItemInfo = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description, batch_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    'manual',
    'Auto commit pending approval task',
    'Close the worktree auto-commit gap.',
    'factory-project-1-7',
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

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
    'vc-worktree-1',
    worktreePath,
    worktreePath,
    'feat/auto-commit',
    'auto-commit',
    'main',
    'active',
    0,
    '2026-04-14T00:00:00.000Z',
    '2026-04-14T00:00:00.000Z',
  );

  db.prepare(`
    INSERT INTO factory_worktrees (
      project_id,
      work_item_id,
      batch_id,
      vc_worktree_id,
      branch,
      worktree_path,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'project-1',
    workItemInfo.lastInsertRowid,
    'factory-project-1-7',
    'vc-worktree-1',
    'feat/auto-commit',
    worktreePath,
    'active',
    '2026-04-14T00:00:00.000Z',
  );
}

function insertTask(db, {
  taskId,
  status = 'completed',
  tags = [],
  workingDirectory,
  taskDescription = 'Plan: Auto Commit\nTask 3: Add audit logging\n',
  metadata = null,
}) {
  db.prepare(`
    INSERT INTO tasks (id, status, task_description, working_directory, tags, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    status,
    taskDescription,
    workingDirectory,
    JSON.stringify(tags),
    metadata ? JSON.stringify(metadata) : null,
    '2026-04-14T00:00:00.000Z',
  );
}

function listDecisionRows(db) {
  return db.prepare(`
    SELECT id, action, outcome_json
    FROM factory_decisions
    ORDER BY id ASC
  `).all().map((row) => ({
    ...row,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

function countCommits(worktreePath) {
  return Number(runRealGit(worktreePath, ['rev-list', '--count', 'HEAD']).trim());
}

describe('factory worktree auto-commit', () => {
  let db;
  let autoCommit;
  let tempDirs;
  let originalGetDbInstance;

  beforeEach(() => {
    vi.restoreAllMocks();
    childProcess.execFileSync = originalExecFileSync;
    tempDirs = [];
    db = createDb();
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    factoryHealth.setDb(db);
    factoryWorktrees.setDb(db);
    factoryDecisions.setDb(db);
    taskCore.setDb(db);
    autoCommit = loadAutoCommitModule();
    autoCommit.resetFactoryWorktreeAutoCommitForTests();
  });

  afterEach(() => {
    autoCommit?.resetFactoryWorktreeAutoCommitForTests();
    delete require.cache[MODULE_PATH];
    database.getDbInstance = originalGetDbInstance;
    factoryHealth.setDb(null);
    factoryWorktrees.setDb(null);
    factoryDecisions.setDb(null);
    taskCore.setDb(null);
    if (db) {
      db.close();
    }
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    childProcess.execFileSync = originalExecFileSync;
  });

  it('commits dirty factory worktree changes after a completed plan task and logs auto_committed_task', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-commit',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
      metadata: {
        plan_task_title: 'Add audit logging',
      },
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    expect(autoCommit.initFactoryWorktreeAutoCommit()).toBe(true);
    taskEvents.emit('task:completed', { id: 'task-commit', status: 'completed' });

    const lastSubject = runRealGit(worktreePath, ['log', '-1', '--pretty=%s']).trim();
    const headSha = runRealGit(worktreePath, ['rev-parse', 'HEAD']).trim();
    const decisions = listDecisionRows(db);

    expect(lastSubject).toBe('feat(factory): plan task 3 — Add audit logging');
    expect(countCommits(worktreePath)).toBe(2);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_committed_task',
      outcome: {
        commit_sha: headSha,
        task_id: 'task-commit',
        plan_task_number: 3,
      },
    });
    expect(decisions[0].outcome.files_changed).toContain('feature.txt');
  });

  it('logs auto_commit_skipped_clean when the worktree is already clean', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-clean',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
    });

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-clean', status: 'completed' });

    const decisions = listDecisionRows(db);
    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_skipped_clean',
      outcome: {
        task_id: 'task-clean',
        plan_task_number: 3,
        files_changed: [],
      },
    });
  });

  it('ignores completed tasks that do not carry factory plan tags', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-non-factory',
      workingDirectory: worktreePath,
      tags: ['project:test'],
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-non-factory', status: 'completed' });

    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(listDecisionRows(db)).toHaveLength(0);
    expect(runRealGit(worktreePath, ['status', '--porcelain']).trim()).toContain('feature.txt');
  });

  it('does nothing when a factory task fails instead of completing', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-failed',
      status: 'failed',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    const gitSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => (
      originalExecFileSync(file, args, options)
    ));

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:failed', { id: 'task-failed', status: 'failed' });

    const commitCalls = gitSpy.mock.calls.filter(([file, args]) => file === 'git' && Array.isArray(args) && args[0] === 'commit');

    expect(countCommits(worktreePath)).toBe(1);
    expect(commitCalls).toHaveLength(0);
    expect(listDecisionRows(db)).toHaveLength(0);
  });

  it('logs auto_commit_failed when git commit throws and preserves the dirty worktree', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-commit-fail',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
      metadata: {
        plan_task_title: 'Add audit logging',
      },
    });
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'hello\n');

    vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'commit') {
        const error = new Error('simulated commit failure');
        error.stderr = 'simulated commit failure';
        throw error;
      }
      return originalExecFileSync(file, args, options);
    });

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-commit-fail', status: 'completed' });

    const decisions = listDecisionRows(db);
    const statusOutput = runRealGit(worktreePath, ['status', '--porcelain']).trim();

    expect(countCommits(worktreePath)).toBe(1);
    expect(statusOutput).toContain('feature.txt');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_failed',
      outcome: {
        task_id: 'task-commit-fail',
        plan_task_number: 3,
      },
    });
    expect(decisions[0].outcome.error).toContain('simulated commit failure');
  });

  it('skips CRLF-only drift files while still committing real Codex changes', () => {
    const { worktreePath, repoPath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-drift',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
      metadata: { plan_task_title: 'Add the real feature' },
    });

    // Seed a tracked file with LF line endings, commit it, then rewrite
    // the same file with CRLF — git diff will flag it as modified, but
    // it's pure drift. A remote Linux test runner against this Windows
    // worktree produces exactly this pattern.
    const driftFile = path.join(worktreePath, 'existing.txt');
    fs.writeFileSync(driftFile, 'line one\nline two\nline three\n');
    runRealGit(worktreePath, ['add', 'existing.txt']);
    runRealGit(worktreePath, ['commit', '-m', 'seed existing.txt']);
    fs.writeFileSync(driftFile, 'line one\r\nline two\r\nline three\r\n');

    // And the real Codex output: a brand-new file the auto-commit
    // must include.
    fs.writeFileSync(path.join(worktreePath, 'real-feature.js'), 'module.exports = {};\n');

    const commitsBefore = countCommits(worktreePath);

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-drift', status: 'completed' });

    const commitsAfter = countCommits(worktreePath);
    const decisions = listDecisionRows(db);

    expect(commitsAfter).toBe(commitsBefore + 1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('auto_committed_task');
    // The new Codex file must be staged; the CRLF-drift file must not.
    expect(decisions[0].outcome.files_changed).toContain('real-feature.js');
    expect(decisions[0].outcome.files_changed).not.toContain('existing.txt');
    expect(decisions[0].outcome.skipped_drift_files).toContain('existing.txt');

    // The drift file stays dirty in the worktree — a later pass or the
    // renormalize-on-merge path (worktree-manager.js) handles it.
    const statusAfter = runRealGit(worktreePath, ['status', '--porcelain']).trim();
    expect(statusAfter).toContain('existing.txt');
    expect(statusAfter).not.toContain('real-feature.js');
  });

  it('logs auto_commit_skipped_clean when the only dirty files are pure line-ending drift', () => {
    const { worktreePath } = initGitWorktree(tempDirs);
    seedFactoryProject(db, worktreePath);
    insertTask(db, {
      taskId: 'task-only-drift',
      workingDirectory: worktreePath,
      tags: [
        'factory:batch_id=factory-project-1-7',
        'factory:plan_task_number=3',
        'factory:pending_approval',
      ],
    });

    const driftFile = path.join(worktreePath, 'existing.txt');
    fs.writeFileSync(driftFile, 'a\nb\nc\n');
    runRealGit(worktreePath, ['add', 'existing.txt']);
    runRealGit(worktreePath, ['commit', '-m', 'seed']);
    fs.writeFileSync(driftFile, 'a\r\nb\r\nc\r\n');

    const commitsBefore = countCommits(worktreePath);

    autoCommit.initFactoryWorktreeAutoCommit();
    taskEvents.emit('task:completed', { id: 'task-only-drift', status: 'completed' });

    expect(countCommits(worktreePath)).toBe(commitsBefore);
    const decisions = listDecisionRows(db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'auto_commit_skipped_clean',
      outcome: {
        task_id: 'task-only-drift',
        plan_task_number: 3,
        files_changed: [],
      },
    });
    expect(decisions[0].outcome.skipped_drift_files).toContain('existing.txt');
  });
});
