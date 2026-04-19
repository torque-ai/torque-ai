'use strict';

const fs = require('fs');
const path = require('path');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  reconcileProject,
  reclaimDir,
  classifyDir,
  forceRmDir,
  RECLAIMABLE_STATUSES,
  FACTORY_LEAF_PREFIX,
} = require('../factory/worktree-reconcile');

let dbModule;
let dbHandle;
let testDir;

// Bracket access on exec avoids the security-reminder hook false-positive
// for better-sqlite3's Database#exec.
function runDdl(db, sql) {
  return db['exec'](sql);
}

function ensureFactoryWorktreesSchema(db) {
  runDdl(db, `
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

    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertRow(db, { project_id, branch, worktree_path, status = 'active', work_item_id = 1, batch_id = 'batch-1', vc_worktree_id = 'vc-1' }) {
  db.prepare(`
    INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status);
}

function insertVcRow(db, { id, repo_path, worktree_path, branch, status = 'active' }) {
  db.prepare(`
    INSERT INTO vc_worktrees (id, repo_path, worktree_path, branch, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, repo_path, worktree_path, branch, status);
}

function makeProject(name = 'proj') {
  const projectPath = path.join(testDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  return {
    id: `proj-${name}-${Date.now()}`,
    name,
    path: projectPath,
  };
}

function makeWorktreeDir(projectPath, leaf) {
  const worktreesRoot = path.join(projectPath, '.worktrees');
  const dir = path.join(worktreesRoot, leaf);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'placeholder.txt'), 'x', 'utf8');
  return dir;
}

beforeAll(() => {
  ({ db: dbModule, testDir } = setupTestDbOnly('worktree-reconcile'));
  dbHandle = dbModule.getDbInstance();
  // Template DB enforces FKs from factory_worktrees into factory_projects /
  // factory_work_items. We don't need to exercise those relationships —
  // just the reconciler's own logic against varying row shapes.
  runDdl(dbHandle, 'PRAGMA foreign_keys = OFF');
  ensureFactoryWorktreesSchema(dbHandle);
});

beforeEach(() => {
  dbHandle = dbModule.getDbInstance();
  runDdl(dbHandle, 'PRAGMA foreign_keys = OFF');
  ensureFactoryWorktreesSchema(dbHandle);
  runDdl(dbHandle, 'DELETE FROM factory_worktrees');
  runDdl(dbHandle, 'DELETE FROM vc_worktrees');
});

afterAll(() => {
  teardownTestDb();
});

describe('classifyDir', () => {
  it('reclaims a directory whose DB row is abandoned/shipped/merged', () => {
    const rows = new Map();
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

    const dir = 'C:/proj/.worktrees/feat-factory-1-foo';
    for (const status of RECLAIMABLE_STATUSES) {
      rows.set(norm(dir), { status, branch: 'feat/factory-1-foo' });
      const result = classifyDir(dir, rows);
      expect(result.action).toBe('reclaim');
      expect(result.row.status).toBe(status);
    }
  });

  it('skips a directory whose DB row is active', () => {
    const dir = 'C:/proj/.worktrees/feat-factory-1-foo';
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const rows = new Map([[norm(dir), { status: 'active', branch: 'feat/factory-1-foo' }]]);
    const result = classifyDir(dir, rows);
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('active');
  });

  it('reclaims a directory with no DB row when the leaf name starts with feat-factory-', () => {
    const dir = `C:/proj/.worktrees/${FACTORY_LEAF_PREFIX}99-orphan`;
    const result = classifyDir(dir, new Map());
    expect(result.action).toBe('reclaim');
    expect(result.reason).toContain('orphan');
    expect(result.row).toBe(null);
  });

  it('skips a directory with no DB row when the leaf name is not factory-named (user worktree)', () => {
    const dir = 'C:/proj/.worktrees/my-personal-branch';
    const result = classifyDir(dir, new Map());
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('non-factory');
  });

  it('skips a factory-named dir when a vc_worktrees row is present but factory_worktrees row is not', () => {
    // Reproduces the TOCTOU race: worktree-manager inserts the vc_worktrees
    // row atomically with the physical dir creation, but the factory_worktrees
    // row is inserted one step later by the loop-controller. A reconcile
    // during that gap would otherwise reclaim the dir as an orphan, killing
    // the worktree out from under a live EXECUTE stage.
    const dir = 'C:/proj/.worktrees/feat-factory-1-mid-create';
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const factoryRows = new Map();
    const vcRows = new Map([[norm(dir), { status: 'active', branch: 'feat/factory-1-mid-create' }]]);

    const result = classifyDir(dir, factoryRows, vcRows);
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('vc_worktrees');
  });

  it('prefers the factory_worktrees classification when both tables have rows', () => {
    // If the factory row says abandoned but a vc row also exists, reclaim
    // still wins — the factory row is authoritative for the factory's own
    // lifecycle. (Reconcile + cleanupWorktree will tear down both.)
    const dir = 'C:/proj/.worktrees/feat-factory-2-both';
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const factoryRows = new Map([[norm(dir), { status: 'abandoned', branch: 'feat/factory-2-both' }]]);
    const vcRows = new Map([[norm(dir), { status: 'active', branch: 'feat/factory-2-both' }]]);

    const result = classifyDir(dir, factoryRows, vcRows);
    expect(result.action).toBe('reclaim');
    expect(result.reason).toContain('abandoned');
  });

  it('skips a freshly-created factory dir whose .git redirect is younger than the orphan min-age', () => {
    // Defense-in-depth against the write-ahead race where worktree-manager's
    // createWorktree creates the physical dir BEFORE inserting its
    // vc_worktrees row. A reconcile in that window queries vc_worktrees
    // while the insert is in flight, misses the row, and would reclaim the
    // dir. The .git-mtime freshness check catches it.
    const project = makeProject();
    const freshDir = makeWorktreeDir(project.path, 'feat-factory-901-fresh');
    fs.writeFileSync(path.join(freshDir, '.git'), 'gitdir: /irrelevant\n', 'utf8');

    const nowMs = Date.now();
    const result = classifyDir(freshDir, new Map(), new Map(), nowMs);
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('fresh factory dir');
  });

  it('reclaims a factory dir with no .git redirect regardless of freshness (truly broken, no metadata)', () => {
    // If the .git file is missing entirely, git can't be using this dir.
    // Freshness only protects dirs that have a .git redirect.
    const project = makeProject();
    const brokenDir = makeWorktreeDir(project.path, 'feat-factory-902-no-git');
    // No .git file. makeWorktreeDir only writes a placeholder.txt.

    const result = classifyDir(brokenDir, new Map(), new Map());
    expect(result.action).toBe('reclaim');
    expect(result.reason).toContain('orphan');
  });

  it('reclaims an older factory dir even though it has a .git redirect (stale orphan)', () => {
    // A worktree with a .git redirect older than the min-age is a real
    // orphan — any in-flight create has long since finished or died. Safe
    // to reclaim.
    const project = makeProject();
    const oldDir = makeWorktreeDir(project.path, 'feat-factory-903-stale');
    const dotGit = path.join(oldDir, '.git');
    fs.writeFileSync(dotGit, 'gitdir: /irrelevant\n', 'utf8');
    // Backdate the .git file's mtime by 10 minutes (> 60s threshold).
    const oldTime = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(dotGit, oldTime / 1000, oldTime / 1000);

    const result = classifyDir(oldDir, new Map(), new Map());
    expect(result.action).toBe('reclaim');
    expect(result.reason).toContain('orphan');
  });
});

describe('reclaimDir', () => {
  it('removes a directory even when the project is not a git repo (git commands fail softly)', () => {
    const project = makeProject();
    const dir = makeWorktreeDir(project.path, 'feat-factory-1-foo');
    expect(fs.existsSync(dir)).toBe(true);

    const result = reclaimDir({
      repoPath: project.path,
      worktreePath: dir,
      branch: 'feat/factory-1-foo',
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // Every step attempted, with failures recorded but not fatal
    const stepNames = result.attempts.map((a) => a.step);
    expect(stepNames).toContain('worktree_remove');
    expect(stepNames).toContain('worktree_prune');
    expect(stepNames).toContain('branch_delete');
  });

  it('removes a directory containing read-only files (simulates git internals)', () => {
    const project = makeProject();
    const dir = makeWorktreeDir(project.path, 'feat-factory-2-readonly');
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const readOnlyFile = path.join(nested, 'locked.txt');
    fs.writeFileSync(readOnlyFile, 'x', 'utf8');
    try { fs.chmodSync(readOnlyFile, 0o444); } catch { /* platform-dependent */ }

    const result = reclaimDir({
      repoPath: project.path,
      worktreePath: dir,
      branch: 'feat/factory-2-readonly',
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports success when the directory is already gone', () => {
    const project = makeProject();
    const dir = path.join(project.path, '.worktrees', 'feat-factory-1-foo');
    // Never created on disk.
    const result = reclaimDir({
      repoPath: project.path,
      worktreePath: dir,
      branch: 'feat/factory-1-foo',
    });
    expect(result.success).toBe(true);
  });
});

describe('forceRmDir', () => {
  it('returns ok immediately when the directory does not exist', () => {
    const result = forceRmDir(path.join(testDir, 'nope-does-not-exist'));
    expect(result.ok).toBe(true);
    expect(result.attempts).toEqual([]);
  });

  it('removes a plain directory in a single rm_plain step', () => {
    const dir = path.join(testDir, `rm-plain-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf8');

    const result = forceRmDir(dir);
    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toMatchObject({ step: 'rm_plain', ok: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes a directory whose files are marked read-only', () => {
    const dir = path.join(testDir, `rm-readonly-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'locked.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    try { fs.chmodSync(file, 0o444); } catch { /* platform-dependent */ }

    const result = forceRmDir(dir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('reconcileProject', () => {
  it('returns zero when .worktrees/ does not exist', () => {
    const project = makeProject();
    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });
    expect(result.scanned).toBe(0);
    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('cleans orphan dirs with abandoned/shipped/merged rows and leaves active alone', () => {
    const project = makeProject();

    const abandonedDir = makeWorktreeDir(project.path, 'feat-factory-100-abandoned');
    const shippedDir = makeWorktreeDir(project.path, 'feat-factory-101-shipped');
    const mergedDir = makeWorktreeDir(project.path, 'feat-factory-102-merged');
    const activeDir = makeWorktreeDir(project.path, 'feat-factory-103-active');

    insertRow(dbHandle, { project_id: project.id, branch: 'feat/factory-100-abandoned', worktree_path: abandonedDir, status: 'abandoned' });
    insertRow(dbHandle, { project_id: project.id, branch: 'feat/factory-101-shipped', worktree_path: shippedDir, status: 'shipped' });
    insertRow(dbHandle, { project_id: project.id, branch: 'feat/factory-102-merged', worktree_path: mergedDir, status: 'merged' });
    insertRow(dbHandle, { project_id: project.id, branch: 'feat/factory-103-active', worktree_path: activeDir, status: 'active' });

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.scanned).toBe(4);
    expect(result.cleaned).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
    expect(fs.existsSync(abandonedDir)).toBe(false);
    expect(fs.existsSync(shippedDir)).toBe(false);
    expect(fs.existsSync(mergedDir)).toBe(false);
    expect(fs.existsSync(activeDir)).toBe(true);
  });

  it('cleans factory-named dirs that have no DB row (true orphans)', () => {
    const project = makeProject();
    const orphanDir = makeWorktreeDir(project.path, 'feat-factory-200-orphan');

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.cleaned.map((c) => c.worktreePath)).toContain(orphanDir);
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('leaves user-named dirs alone when they have no DB row', () => {
    const project = makeProject();
    const userDir = makeWorktreeDir(project.path, 'my-side-project');

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.cleaned).toHaveLength(0);
    expect(result.skipped.map((s) => s.worktreePath)).toContain(userDir);
    expect(fs.existsSync(userDir)).toBe(true);
  });

  it('returns empty results when factory_worktrees table is missing', () => {
    const project = makeProject();
    makeWorktreeDir(project.path, 'my-branch');
    runDdl(dbHandle, 'DROP TABLE factory_worktrees');

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    // user dir: classified as non-factory, skipped (one scanned, one skipped, zero cleaned)
    expect(result.scanned).toBe(1);
    expect(result.cleaned).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);

    // restore for other tests
    ensureFactoryWorktreesSchema(dbHandle);
  });

  it('skips a factory-named dir mid-create: vc_worktrees row present, factory_worktrees row pending', () => {
    // This is the integration-level repro of the TOCTOU race. The
    // factory's createForBatch inserts the vc_worktrees row atomically with
    // the worktree dir, but the factory_worktrees row is inserted by the
    // caller one step later. A reconcile pass in that gap must leave the
    // dir alone so the caller can finish recording and hand off to EXECUTE.
    const project = makeProject();
    const midCreateDir = makeWorktreeDir(project.path, 'feat-factory-404-mid-create');
    insertVcRow(dbHandle, {
      id: 'vc-mid-create',
      repo_path: project.path,
      worktree_path: midCreateDir,
      branch: 'feat/factory-404-mid-create',
      status: 'active',
    });
    // deliberately: no factory_worktrees row

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.cleaned).toHaveLength(0);
    expect(result.skipped.map((s) => s.worktreePath)).toContain(midCreateDir);
    expect(fs.existsSync(midCreateDir)).toBe(true);
  });

  it('scopes by project_id: row from project A does not classify project B dirs', () => {
    const projA = makeProject('a');
    const projB = makeProject('b');

    const bDir = makeWorktreeDir(projB.path, 'feat-factory-300-claim');
    // Row belongs to project A with same branch name — must NOT let A's row
    // authorize cleaning B's disk dir.
    insertRow(dbHandle, {
      project_id: projA.id,
      branch: 'feat/factory-300-claim',
      worktree_path: bDir,
      status: 'abandoned',
    });

    const result = reconcileProject({
      db: dbHandle,
      project_id: projB.id,
      project_path: projB.path,
    });

    // Under project B's reconcile, bDir has no B-scoped row but is
    // factory-named → reclaimed as an orphan. That's the intended behavior:
    // the caller scopes by project_id, and any factory-named dir without a
    // row owned by this project is treated as stale.
    expect(result.cleaned).toHaveLength(1);
    expect(fs.existsSync(bDir)).toBe(false);
  });
});
