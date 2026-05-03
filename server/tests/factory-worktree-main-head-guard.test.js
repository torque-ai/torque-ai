'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { reconcileProject } = require('../factory/worktree-reconcile');

const GIT_TEST_ENV = { ...process.env };
delete GIT_TEST_ENV.GIT_DIR;
delete GIT_TEST_ENV.GIT_WORK_TREE;
delete GIT_TEST_ENV.GIT_INDEX_FILE;
delete GIT_TEST_ENV.GIT_OBJECT_DIRECTORY;
delete GIT_TEST_ENV.GIT_ALTERNATE_OBJECT_DIRECTORIES;
Object.assign(GIT_TEST_ENV, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Factory Test',
  GIT_AUTHOR_EMAIL: 'factory-test@example.com',
  GIT_COMMITTER_NAME: 'Factory Test',
  GIT_COMMITTER_EMAIL: 'factory-test@example.com',
});

let dbModule;
let db;
let testDir;

function runDdl(dbHandle, sql) {
  return dbHandle.exec(sql);
}

function runGit(repoDir, args) {
  const execFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true,
    env: GIT_TEST_ENV,
  });
}

function createRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-main-head-'));
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.email', 'factory-test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Factory Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test', 'utf8');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['commit', '-m', 'init', '--no-gpg-sign']);
  runGit(repoDir, ['checkout', '-B', 'main']);
  return repoDir;
}

function cleanupRepo(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return;
  fs.rmSync(repoDir, { recursive: true, force: true });
}

function ensureSchema(handle) {
  runDdl(handle, `
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  runDdl(handle, `
    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  runDdl(handle, `
    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      work_item_id INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );
  `);

  runDdl(handle, `
    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
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
  `);
}

function makeProjectRow(repoDir) {
  const projectId = `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, status)
    VALUES (?, 'factory-main-head-guard', ?, 'running')
  `).run(projectId, repoDir);
  return {
    id: projectId,
    path: repoDir,
  };
}

function insertWorkItem(projectId) {
  const info = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description, priority, status, created_at, updated_at)
    VALUES (?, 'test', 'worktree guard fixture', 'fixture', 50, 'executing', datetime('now'), datetime('now'))
  `).run(projectId);
  return Number(info.lastInsertRowid);
}

function insertWorktreeRow({ projectId, branch, status = 'active', worktreePath = null }) {
  const workItemId = insertWorkItem(projectId);
  db.prepare(`
    INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status)
    VALUES (?, ?, 'batch-1', ?, ?, ?, ?)
  `).run(
    projectId,
    workItemId,
    `vc-${workItemId}`,
    branch,
    worktreePath || path.join(testDir, 'unused', branch.replace(/[^\w-]/g, '-')),
    status,
  );
}

function getDecision(projectId, action) {
  return db.prepare(`
    SELECT id, inputs_json, outcome_json, action, stage
    FROM factory_decisions
    WHERE project_id = ? AND action = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(projectId, action);
}

beforeAll(() => {
  ({ db: dbModule, testDir } = setupTestDbOnly('factory-worktree-main-head-guard'));
  db = dbModule.getDbInstance();
  ensureSchema(db);
});

beforeEach(() => {
  db = dbModule.getDbInstance();
  runDdl(db, 'DELETE FROM factory_worktrees');
  runDdl(db, 'DELETE FROM factory_decisions');
  runDdl(db, 'DELETE FROM factory_work_items');
  runDdl(db, 'DELETE FROM factory_projects');
});

afterAll(() => {
  teardownTestDb();
});

describe('guardMainRepoHead', () => {
  it('resets clean stale factory branch to main and writes reconcile decision', () => {
    const repoDir = createRepo();
    const project = makeProjectRow(repoDir);
    try {
      runGit(repoDir, ['checkout', '-b', 'feat/factory-guard-clean']);

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
      expect(runGit(repoDir, ['status', '--porcelain']).trim()).toBe('');
      expect(db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(project.id).status).toBe('running');
      expect(runGit(repoDir, ['branch', '--show-current']).trim()).toBe('main');

      const row = getDecision(project.id, 'main_repo_on_stale_factory_branch');
      expect(row).toBeTruthy();
      expect(row.stage).toBe('reconcile');
      expect(JSON.parse(row.inputs_json)).toEqual({ branch: 'feat/factory-guard-clean' });
      expect(JSON.parse(row.outcome_json)).toEqual({ resolved: 'reset_to_main' });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('pauses dirty stale factory branch and preserves uncommitted files', () => {
    const repoDir = createRepo();
    const project = makeProjectRow(repoDir);
    try {
      runGit(repoDir, ['checkout', '-b', 'feat-factory-guard-dirty']);
      fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'dirty', 'utf8');

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat-factory-guard-dirty');
      expect(fs.existsSync(path.join(repoDir, 'dirty.txt'))).toBe(true);
      expect(db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(project.id).status).toBe('paused');

      const row = getDecision(project.id, 'main_repo_on_stale_factory_branch');
      expect(row).toBeTruthy();
      expect(JSON.parse(row.inputs_json)).toEqual({ branch: 'feat-factory-guard-dirty' });
      expect(JSON.parse(row.outcome_json)).toEqual({
        resolved: 'paused_project',
        reason: 'dirty_working_tree',
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('skips stale factory branch when an open row exists with exact and normalized names', () => {
    const repoDir = createRepo();
    const project = makeProjectRow(repoDir);
    try {
      runGit(repoDir, ['checkout', '-b', 'feat-factory-guard-open']);
      insertWorktreeRow({
        projectId: project.id,
        branch: 'feat/factory-guard-open',
        status: 'active',
        worktreePath: path.join(repoDir, '.worktrees', 'guard-open'),
      });

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat-factory-guard-open');
      expect(db.prepare('SELECT COUNT(*) AS count FROM factory_decisions WHERE project_id = ? AND action = ?')
        .get(project.id, 'main_repo_on_stale_factory_branch').count).toBe(0);
      expect(db.prepare('SELECT status FROM factory_projects WHERE id = ?').get(project.id).status).toBe('running');
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('skips guard when already on main or non-factory branch names', () => {
    const repoDir = createRepo();
    const project = makeProjectRow(repoDir);
    try {
      runGit(repoDir, ['checkout', 'main']);

      const onMain = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });
      expect(onMain.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');

      runGit(repoDir, ['checkout', '-b', 'wip/factory-guard']);
      const onNonFactory = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });
      expect(onNonFactory.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wip/factory-guard');

      runGit(repoDir, ['checkout', '-b', 'feature/factory-guard']);
      const onFeature = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });
      expect(onFeature.cleaned).toEqual([]);
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/factory-guard');

      expect(db.prepare('SELECT COUNT(*) AS count FROM factory_decisions WHERE project_id = ? AND action = ?')
        .get(project.id, 'main_repo_on_stale_factory_branch').count).toBe(0);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});
