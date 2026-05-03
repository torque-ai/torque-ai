'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const logger = require('../logger');
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
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-orphan-sweep-'));
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

function insertProject(repoDir) {
  const projectId = `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.prepare(`
    INSERT INTO factory_projects (id, name, path, status)
    VALUES (?, 'factory-orphan-sweep', ?, 'running')
  `).run(projectId, repoDir);
  return {
    id: projectId,
    path: repoDir,
  };
}

function insertWorkItem(projectId) {
  const info = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description, priority, status, created_at, updated_at)
    VALUES (?, 'test', 'orphan sweep fixture', 'fixture', 50, 'executing', datetime('now'), datetime('now'))
  `).run(projectId);
  return Number(info.lastInsertRowid);
}

function insertWorktreeRow({ projectId, branch, status, worktreePath }) {
  const workItemId = insertWorkItem(projectId);
  db.prepare(`
    INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status)
    VALUES (?, ?, 'batch-1', ?, ?, ?, ?)
  `).run(projectId, workItemId, `vc-${workItemId}`, branch, worktreePath, status);
}

function getSweepDecision(projectId) {
  return db.prepare(`
    SELECT inputs_json, outcome_json
    FROM factory_decisions
    WHERE project_id = ? AND action = 'swept_orphan_worktree_dirs'
    ORDER BY id DESC
    LIMIT 1
  `).get(projectId);
}

function createNonfactoryOrphan(projectDir, name) {
  const orphanPath = path.join(projectDir, '.worktrees', name);
  fs.mkdirSync(orphanPath, { recursive: true });
  fs.writeFileSync(path.join(orphanPath, 'left-behind.txt'), 'x', 'utf8');
  return orphanPath;
}

beforeAll(() => {
  ({ db: dbModule } = setupTestDbOnly('factory-orphan-worktree-sweep'));
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

describe('sweepOrphanWorktreeDirs', () => {
  it('removes orphan directories not tracked by factory table or git worktree list', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    try {
      const orphanDir = createNonfactoryOrphan(repoDir, 'orphan-old');

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(fs.existsSync(orphanDir)).toBe(false);
      expect(result.orphanSweep).toEqual({
        swept: 1,
        deferred_busy: 0,
        errored: 0,
      });

      const decision = getSweepDecision(project.id);
      expect(decision).toBeTruthy();
      expect(JSON.parse(decision.outcome_json)).toEqual({
        swept: 1,
        deferred_busy: 0,
        errored: 0,
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('defers busy orphan directories without warnings', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    const warnSpy = vi.spyOn(logger.constructor.prototype, 'warn').mockImplementation(() => {});
    const origExecFileSync = childProcess.execFileSync;

    try {
      const orphanDir = createNonfactoryOrphan(repoDir, 'busy-orphan');
      const busyError = new Error('EBUSY: resource busy');
      busyError.code = 'EBUSY';

      vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
        throw busyError;
      });
      vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => {
        if (file === 'cmd') {
          throw busyError;
        }
        return origExecFileSync(file, args, options);
      });
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw busyError;
      });

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.orphanSweep).toEqual({
        swept: 0,
        deferred_busy: 1,
        errored: 0,
      });
      expect(fs.existsSync(orphanDir)).toBe(true);
      const decision = getSweepDecision(project.id);
      expect(JSON.parse(decision.outcome_json)).toEqual({
        swept: 0,
        deferred_busy: 1,
        errored: 0,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      fs.rmSync.mockRestore();
      childProcess.execFileSync.mockRestore();
      fs.renameSync.mockRestore();
      cleanupRepo(repoDir);
    }
  });

  it('counts non-busy sweep failures and logs a warning', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    const warnSpy = vi.spyOn(logger.constructor.prototype, 'warn').mockImplementation(() => {});
    const origExecFileSync = childProcess.execFileSync;
    const eaccesError = new Error('EACCES: permission denied');
    eaccesError.code = 'EACCES';

    try {
      const orphanDir = createNonfactoryOrphan(repoDir, 'eacces-orphan');

      vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
        throw eaccesError;
      });
      vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => {
        if (file === 'cmd') {
          throw eaccesError;
        }
        return origExecFileSync(file, args, options);
      });
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw eaccesError;
      });

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.orphanSweep).toEqual({
        swept: 0,
        deferred_busy: 0,
        errored: 1,
      });
      expect(fs.existsSync(orphanDir)).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      const decision = getSweepDecision(project.id);
      expect(JSON.parse(decision.outcome_json)).toEqual({
        swept: 0,
        deferred_busy: 0,
        errored: 1,
      });
    } finally {
      warnSpy.mockRestore();
      fs.rmSync.mockRestore();
      childProcess.execFileSync.mockRestore();
      fs.renameSync.mockRestore();
      cleanupRepo(repoDir);
    }
  });

  it('preserves active git worktrees (and leaves non-orphan paths untouched)', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    try {
      const activeGitWorktree = path.join(repoDir, '.worktrees', 'linked-main');
      runGit(repoDir, ['worktree', 'add', '-b', 'linked-main-branch', activeGitWorktree, 'main']);
      const orphanDir = createNonfactoryOrphan(repoDir, 'non-orphan-after');

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(fs.existsSync(activeGitWorktree)).toBe(true);
      expect(result.orphanSweep).toEqual({
        swept: 1,
        deferred_busy: 0,
        errored: 0,
      });
      expect(fs.existsSync(orphanDir)).toBe(false);
    } finally {
      try {
        runGit(repoDir, ['worktree', 'remove', '--force', path.join(repoDir, '.worktrees', 'linked-main')]);
      } catch {
        // Best-effort cleanup; assertion failures may already have removed it.
      }
      cleanupRepo(repoDir);
    }
  });

  it('preserves directories that have open factory_worktrees rows', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    try {
      const ownedDir = createNonfactoryOrphan(repoDir, 'feat-factory-owned');
      insertWorktreeRow({
        projectId: project.id,
        branch: 'feat/factory-owned',
        worktreePath: ownedDir,
        status: 'active',
      });

      const result = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });

      expect(result.orphanSweep).toEqual({
        swept: 0,
        deferred_busy: 0,
        errored: 0,
      });
      expect(fs.existsSync(ownedDir)).toBe(true);
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('writes one swept-orphan decision row per reconcile call', () => {
    const repoDir = createRepo();
    const project = insertProject(repoDir);
    try {
      createNonfactoryOrphan(repoDir, 'decide-once');
      const first = reconcileProject({
        db,
        project_id: project.id,
        project_path: project.path,
      });
      const decisionCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM factory_decisions
        WHERE project_id = ? AND action = 'swept_orphan_worktree_dirs'
      `).get(project.id).count;
      expect(first.orphanSweep.swept).toBe(1);
      expect(decisionCount).toBe(1);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});
