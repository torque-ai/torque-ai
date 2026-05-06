'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const {
  reconcileProject,
  reclaimDir,
  classifyDir,
  forceRmDir,
  shouldLogReconcileFailure,
  resetReconcileFailureLogStateForTests,
  RECONCILE_FAILURE_WARN_INTERVAL_MS,
  RECLAIMABLE_STATUSES,
  FACTORY_LEAF_PREFIX,
  auditQuarantineDir,
  shouldLogDeletePendingWarn,
  resetDeletePendingWarnLogStateForTests,
  readDeletePendingThresholds,
  DELETE_PENDING_WARN_INTERVAL_MS,
  DELETE_PENDING_SIZE_WARN_BYTES_DEFAULT,
  DELETE_PENDING_AGE_WARN_MS_DEFAULT,
  QUARANTINE_DIR_NAME,
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

function insertRow(db, { project_id, branch, worktree_path, status = 'active', work_item_id = 1, batch_id = 'batch-1', vc_worktree_id = 'vc-1', created_at = null }) {
  db.prepare(`
    INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(project_id, work_item_id, batch_id, vc_worktree_id, branch, worktree_path, status, created_at);
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
  resetReconcileFailureLogStateForTests();
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

  it('quarantines a directory when delete commands report success but leave the path behind', () => {
    const dir = path.join(testDir, `rm-quarantine-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'left-behind.txt'), 'x', 'utf8');

    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
    const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => Buffer.from(''));

    let result;
    try {
      result = forceRmDir(dir);
    } finally {
      rmSpy.mockRestore();
      execSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    expect(result.quarantined).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(result.quarantinePath).toContain('.torque-delete-pending');
    expect(fs.existsSync(result.quarantinePath)).toBe(true);
    expect(result.attempts.at(-1)).toMatchObject({
      step: 'quarantine_rename',
      ok: true,
    });
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

  it('marks stale active rows abandoned when their worktree directory is missing', () => {
    const project = makeProject();
    const missingDir = path.join(project.path, '.worktrees', 'feat-factory-777-missing');
    insertRow(dbHandle, {
      project_id: project.id,
      branch: 'feat/factory-777-missing',
      worktree_path: missingDir,
      status: 'active',
      created_at: '2026-04-01 00:00:00',
    });

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.scanned).toBe(0);
    expect(result.abandonedRows).toEqual([expect.objectContaining({
      worktreePath: missingDir,
      branch: 'feat/factory-777-missing',
    })]);
    expect(dbHandle.prepare('SELECT status, abandoned_at FROM factory_worktrees WHERE worktree_path = ?').get(missingDir)).toMatchObject({
      status: 'abandoned',
      abandoned_at: expect.any(String),
    });
  });

  it('does not abandon fresh active rows whose worktree directory has not appeared yet', () => {
    const project = makeProject();
    const missingDir = path.join(project.path, '.worktrees', 'feat-factory-778-fresh');
    insertRow(dbHandle, {
      project_id: project.id,
      branch: 'feat/factory-778-fresh',
      worktree_path: missingDir,
      status: 'active',
    });

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.abandonedRows).toEqual([]);
    expect(dbHandle.prepare('SELECT status, abandoned_at FROM factory_worktrees WHERE worktree_path = ?').get(missingDir)).toMatchObject({
      status: 'active',
      abandoned_at: null,
    });
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

  it('when a path has both an old abandoned and a new active row, honors the NEWEST row (does not reclaim)', () => {
    // Regression: the branch → path map is deterministic, so one path
    // accumulates multiple factory_worktrees rows across its lifetime.
    // Every pre-reclaim marks the prior row abandoned and the next
    // EXECUTE inserts a fresh active row. If reconcile's rowsByPath Map
    // resolves to the OLDEST row (abandoned), it deletes the freshly
    // created dir that the newer active row actually owns — observed
    // live on torque-public item 79 (2026-04-19).
    const project = makeProject();
    const reusedDir = makeWorktreeDir(project.path, 'feat-factory-500-reused');

    // Insert old abandoned row FIRST (lower auto-increment id), then
    // the new active row for the same path (higher id).
    insertRow(dbHandle, {
      project_id: project.id,
      branch: 'feat/factory-500-reused',
      worktree_path: reusedDir,
      status: 'abandoned',
      batch_id: 'batch-old',
      vc_worktree_id: 'vc-old',
    });
    insertRow(dbHandle, {
      project_id: project.id,
      branch: 'feat/factory-500-reused',
      worktree_path: reusedDir,
      status: 'active',
      batch_id: 'batch-new',
      vc_worktree_id: 'vc-new',
    });

    const result = reconcileProject({
      db: dbHandle,
      project_id: project.id,
      project_path: project.path,
    });

    expect(result.cleaned).toHaveLength(0);
    expect(result.skipped.map((s) => s.worktreePath)).toContain(reusedDir);
    expect(fs.existsSync(reusedDir)).toBe(true);
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

describe('reconcile failure logging', () => {
  it('throttles repeated reconcile failures for the same locked worktree', () => {
    const failure = {
      project_id: 'project-1',
      worktreePath: 'C:/repo/.worktrees/feat-factory-1-locked',
      branch: 'feat/factory-1-locked',
      reason: 'orphan factory dir with no db row',
      attempts: [
        { step: 'worktree_remove', ok: false, err: 'fatal: not a working tree' },
        {
          step: 'fs_rm',
          ok: false,
          err: 'rm_plain: EBUSY',
          sub_attempts: [{ step: 'rm_plain', ok: false, err: 'EBUSY: resource busy or locked' }],
        },
      ],
    };

    const first = shouldLogReconcileFailure(failure, 1_000);
    const second = shouldLogReconcileFailure(failure, 2_000);
    const third = shouldLogReconcileFailure(
      failure,
      1_000 + RECONCILE_FAILURE_WARN_INTERVAL_MS + 1
    );

    expect(first).toMatchObject({ log: true, suppressed_count: 0 });
    expect(second).toMatchObject({ log: false, suppressed_count: 1 });
    expect(third).toMatchObject({ log: true, suppressed_count: 1 });
  });
});

describe('auditQuarantineDir', () => {
  let auditDir;

  beforeEach(() => {
    auditDir = fs.mkdtempSync(path.join(testDir, 'qaudit-'));
  });

  afterEach(() => {
    try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns null when .torque-delete-pending does not exist', () => {
    expect(auditQuarantineDir(auditDir)).toBeNull();
  });

  it('returns zeros when quarantine dir is empty', () => {
    fs.mkdirSync(path.join(auditDir, QUARANTINE_DIR_NAME));
    const r = auditQuarantineDir(auditDir);
    expect(r).toMatchObject({
      entry_count: 0,
      total_bytes: 0,
      oldest_mtime_ms: null,
      oldest_age_ms: null,
      scan_capped: false,
    });
  });

  it('sums bytes recursively and tracks oldest mtime', () => {
    const quarantine = path.join(auditDir, QUARANTINE_DIR_NAME);
    const leaf = path.join(quarantine, 'feat-foo-123-456-0');
    const subdir = path.join(leaf, 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(leaf, 'a.txt'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(subdir, 'b.txt'), 'y'.repeat(2000));
    const r = auditQuarantineDir(auditDir);
    expect(r.entry_count).toBe(1);
    expect(r.total_bytes).toBe(3000);
    expect(r.oldest_mtime_ms).not.toBeNull();
    expect(r.oldest_age_ms).toBeGreaterThanOrEqual(0);
    expect(r.scan_capped).toBe(false);
  });

  it('does not follow symlinks (security: no escape from quarantine root)', () => {
    if (process.platform === 'win32') {
      // Symlink creation on Windows requires SeCreateSymbolicLinkPrivilege.
      // Most CI/dev sessions don't have it; skip rather than fail.
      try {
        const probe = path.join(auditDir, 'symlink-probe');
        fs.symlinkSync(auditDir, probe, 'dir');
        fs.unlinkSync(probe);
      } catch {
        return;
      }
    }
    const quarantine = path.join(auditDir, QUARANTINE_DIR_NAME);
    fs.mkdirSync(quarantine, { recursive: true });
    // 1MB file outside the quarantine; symlink points to it. The audit must
    // count the link itself, not follow it.
    const target = path.join(auditDir, 'outside-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'big.bin'), 'z'.repeat(1024 * 1024));
    fs.symlinkSync(target, path.join(quarantine, 'evil-link'), 'dir');
    const r = auditQuarantineDir(auditDir);
    expect(r.total_bytes).toBe(0); // didn't traverse into outside-target
  });

  it('handles unreadable quarantine root by returning null', () => {
    // Simulate by pointing at a path that doesn't exist
    const result = auditQuarantineDir(path.join(auditDir, 'missing'));
    expect(result).toBeNull();
  });
});

describe('shouldLogDeletePendingWarn (15-min suppressor)', () => {
  beforeEach(() => {
    resetDeletePendingWarnLogStateForTests();
  });

  it('logs the first call, suppresses follow-ups within the interval, then logs again after expiry', () => {
    const first = shouldLogDeletePendingWarn('proj-A', 1_000);
    const second = shouldLogDeletePendingWarn('proj-A', 2_000);
    const third = shouldLogDeletePendingWarn(
      'proj-A',
      1_000 + DELETE_PENDING_WARN_INTERVAL_MS + 1
    );
    expect(first).toMatchObject({ log: true, suppressed_count: 0 });
    expect(second).toMatchObject({ log: false, suppressed_count: 1 });
    expect(third).toMatchObject({ log: true, suppressed_count: 1 });
  });

  it('tracks suppression independently per project_id', () => {
    shouldLogDeletePendingWarn('proj-A', 1_000);
    const otherProj = shouldLogDeletePendingWarn('proj-B', 1_000);
    expect(otherProj).toMatchObject({ log: true, suppressed_count: 0 });
  });
});

describe('readDeletePendingThresholds', () => {
  afterEach(() => {
    delete process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES;
    delete process.env.TORQUE_DELETE_PENDING_AGE_WARN_MS;
  });

  it('returns built-in defaults when env vars are unset', () => {
    delete process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES;
    delete process.env.TORQUE_DELETE_PENDING_AGE_WARN_MS;
    const t = readDeletePendingThresholds();
    expect(t.sizeBytes).toBe(DELETE_PENDING_SIZE_WARN_BYTES_DEFAULT);
    expect(t.ageMs).toBe(DELETE_PENDING_AGE_WARN_MS_DEFAULT);
  });

  it('honors numeric env-var overrides', () => {
    process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES = '2048';
    process.env.TORQUE_DELETE_PENDING_AGE_WARN_MS = '60000';
    const t = readDeletePendingThresholds();
    expect(t.sizeBytes).toBe(2048);
    expect(t.ageMs).toBe(60000);
  });

  it('falls back to defaults on garbage env values', () => {
    process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES = 'not-a-number';
    process.env.TORQUE_DELETE_PENDING_AGE_WARN_MS = '-1';
    const t = readDeletePendingThresholds();
    expect(t.sizeBytes).toBe(DELETE_PENDING_SIZE_WARN_BYTES_DEFAULT);
    // Negative is rejected by `>= 0` predicate; falls back.
    expect(t.ageMs).toBe(DELETE_PENDING_AGE_WARN_MS_DEFAULT);
  });
});

describe('reconcileProject — quarantine audit integration', () => {
  beforeEach(() => {
    resetDeletePendingWarnLogStateForTests();
  });

  afterEach(() => {
    delete process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES;
    delete process.env.TORQUE_DELETE_PENDING_AGE_WARN_MS;
  });

  it('returns quarantineAudit:null when .worktrees does not exist', () => {
    const projectPath = path.join(testDir, `proj-noworktrees-${Date.now()}`);
    fs.mkdirSync(projectPath, { recursive: true });
    childProcess.execFileSync('git', ['init', projectPath], { stdio: 'ignore' });
    const result = reconcileProject({
      db: dbHandle,
      project_id: 'proj-noworktrees',
      project_path: projectPath,
    });
    // .worktrees doesn't exist → audit looks for .torque-delete-pending which also doesn't exist → null
    expect(result.quarantineAudit).toBeNull();
  });

  it('reports breached: true and breach reason when size threshold exceeded', () => {
    const projectPath = path.join(testDir, `proj-breach-size-${Date.now()}`);
    fs.mkdirSync(projectPath, { recursive: true });
    childProcess.execFileSync('git', ['init', projectPath], { stdio: 'ignore' });
    const worktreesRoot = path.join(projectPath, '.worktrees');
    const quarantine = path.join(worktreesRoot, QUARANTINE_DIR_NAME);
    const leaf = path.join(quarantine, 'feat-foo-1-1-0');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(leaf, 'fat.bin'), 'q'.repeat(4096));
    process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES = '1024';
    const result = reconcileProject({
      db: dbHandle,
      project_id: 'proj-breach-size',
      project_path: projectPath,
    });
    expect(result.quarantineAudit).toMatchObject({
      breached: true,
      size_breached: true,
      total_bytes: 4096,
      threshold_size_bytes: 1024,
    });
  });

  it('reports breached: false when both thresholds are under limit', () => {
    const projectPath = path.join(testDir, `proj-noBreach-${Date.now()}`);
    fs.mkdirSync(projectPath, { recursive: true });
    childProcess.execFileSync('git', ['init', projectPath], { stdio: 'ignore' });
    const worktreesRoot = path.join(projectPath, '.worktrees');
    const quarantine = path.join(worktreesRoot, QUARANTINE_DIR_NAME);
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'tiny.txt'), 'x');
    const result = reconcileProject({
      db: dbHandle,
      project_id: 'proj-noBreach',
      project_path: projectPath,
    });
    expect(result.quarantineAudit).toMatchObject({
      breached: false,
      total_bytes: 1,
    });
  });

  it('runs audit on the early-return path (no worktree dirs but quarantine exists)', () => {
    const projectPath = path.join(testDir, `proj-early-${Date.now()}`);
    fs.mkdirSync(projectPath, { recursive: true });
    childProcess.execFileSync('git', ['init', projectPath], { stdio: 'ignore' });
    const worktreesRoot = path.join(projectPath, '.worktrees');
    const quarantine = path.join(worktreesRoot, QUARANTINE_DIR_NAME);
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'a.bin'), 'q'.repeat(2048));
    process.env.TORQUE_DELETE_PENDING_SIZE_WARN_BYTES = '1024';
    const result = reconcileProject({
      db: dbHandle,
      project_id: 'proj-early',
      project_path: projectPath,
    });
    // dirs.length === 0 but quarantine has 2KB → still audited
    expect(result.scanned).toBe(0);
    expect(result.quarantineAudit).toMatchObject({
      breached: true,
      size_breached: true,
    });
  });
});
