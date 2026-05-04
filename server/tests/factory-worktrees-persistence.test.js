import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function createTables(db) {
  db.pragma('foreign_keys = ON');
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch_active
      ON factory_worktrees(branch)
      WHERE status = 'active';
  `);
}

function seedParents(db) {
  db.prepare(`
    INSERT INTO factory_projects (id, name, path)
    VALUES (?, ?, ?)
  `).run('project-1', 'Factory Worktree Project', 'C:/repo');

  const workItemInfo = db.prepare(`
    INSERT INTO factory_work_items (project_id, source, title, description)
    VALUES (?, ?, ?, ?)
  `).run('project-1', 'manual', 'Persist worktree', 'Verify restart-safe worktree lookup');

  db.prepare(`
    INSERT INTO vc_worktrees (id, repo_path, worktree_path, branch, feature_name, base_branch, status, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    'vc-worktree-1',
    'C:/repo',
    'C:/repo/.worktrees/feat/factory-persist',
    'feat/factory-persist',
    'factory-persist',
    'main',
    'active',
  );

  return workItemInfo.lastInsertRowid;
}

function loadFreshFactoryWorktrees() {
  const modulePath = require.resolve('../db/factory/worktrees');
  delete require.cache[modulePath];
  return require('../db/factory/worktrees');
}

describe('factory worktrees persistence', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-worktrees-persistence-'));
    dbPath = path.join(tempDir, 'factory-worktrees.sqlite');
  });

  afterEach(() => {
    vi.resetModules();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
    dbPath = null;
  });

  it('records an active worktree and resolves it from a fresh module instance after a restart', () => {
    const db1 = new Database(dbPath);
    createTables(db1);
    const workItemId = seedParents(db1);

    const factoryWorktrees1 = loadFreshFactoryWorktrees();
    factoryWorktrees1.setDb(db1);
    const recorded = factoryWorktrees1.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-1',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-persist',
      worktree_path: 'C:/repo/.worktrees/feat/factory-persist',
    });

    expect(factoryWorktrees1.getActiveWorktree('project-1')).toMatchObject({
      id: recorded.id,
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-1',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-persist',
      worktree_path: 'C:/repo/.worktrees/feat/factory-persist',
      status: 'active',
    });

    db1.close();
    factoryWorktrees1.setDb(null);

    const db2 = new Database(dbPath);
    createTables(db2);
    const factoryWorktrees2 = loadFreshFactoryWorktrees();
    factoryWorktrees2.setDb(db2);

    expect(factoryWorktrees2.getActiveWorktree('project-1')).toMatchObject({
      id: recorded.id,
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-1',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-persist',
      worktree_path: 'C:/repo/.worktrees/feat/factory-persist',
      status: 'active',
    });

    const merged = factoryWorktrees2.markMerged(recorded.id);
    expect(merged).toMatchObject({
      id: recorded.id,
      status: 'merged',
      merged_at: expect.any(String),
    });
    expect(factoryWorktrees2.getActiveWorktree('project-1')).toBeNull();

    db2.close();
    factoryWorktrees2.setDb(null);
  });

  it('enforces unique branches across persisted factory worktrees', () => {
    const db = new Database(dbPath);
    createTables(db);
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);
    factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-1',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-persist',
      worktree_path: 'C:/repo/.worktrees/feat/factory-persist',
    });

    expect(() => factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-2',
      vc_worktree_id: 'vc-worktree-2',
      branch: 'feat/factory-persist',
      worktree_path: 'C:/repo/.worktrees/feat/factory-persist-2',
    })).toThrow(/UNIQUE/i);

    db.close();
    factoryWorktrees.setDb(null);
  });

  it('persists base_branch when the schema has the column', () => {
    const db = new Database(dbPath);
    createTables(db);
    db.prepare('ALTER TABLE factory_worktrees ADD COLUMN base_branch TEXT').run();
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);
    const recorded = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-base',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-base',
      base_branch: 'develop',
      worktree_path: 'C:/repo/.worktrees/feat/factory-base',
    });

    expect(recorded.baseBranch).toBe('develop');
    const row = db.prepare('SELECT base_branch FROM factory_worktrees WHERE id = ?').get(recorded.id);
    expect(row.base_branch).toBe('develop');

    db.close();
    factoryWorktrees.setDb(null);
  });

  it('prunes only abandoned worktrees older than the retention window', () => {
    const db = new Database(dbPath);
    createTables(db);
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);
    const oldAbandoned = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-old',
      vc_worktree_id: 'vc-worktree-old',
      branch: 'feat/factory-old',
      worktree_path: 'C:/repo/.worktrees/feat/factory-old',
    });
    factoryWorktrees.markAbandoned(oldAbandoned.id);
    db.prepare("UPDATE factory_worktrees SET abandoned_at = datetime('now', '-2 days') WHERE id = ?").run(oldAbandoned.id);

    const freshAbandoned = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-fresh',
      vc_worktree_id: 'vc-worktree-fresh',
      branch: 'feat/factory-fresh',
      worktree_path: 'C:/repo/.worktrees/feat/factory-fresh',
    });
    factoryWorktrees.markAbandoned(freshAbandoned.id);

    const active = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-active',
      vc_worktree_id: 'vc-worktree-active',
      branch: 'feat/factory-active',
      worktree_path: 'C:/repo/.worktrees/feat/factory-active',
    });

    const pruned = factoryWorktrees.pruneAbandonedWorktrees({ olderThanHours: 24 });
    expect(pruned).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_worktrees WHERE id = ?').get(oldAbandoned.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_worktrees WHERE id = ?').get(freshAbandoned.id).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM factory_worktrees WHERE id = ?').get(active.id).count).toBe(1);

    db.close();
    factoryWorktrees.setDb(null);
  });

  it('allows re-recording a branch after the previous worktree is merged', () => {
    // Partial unique index (status = 'active') — merged rows are historical
    // and shouldn't block a fresh worktree on the same branch if the work
    // item re-enters EXECUTE.
    const db = new Database(dbPath);
    createTables(db);
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);
    const first = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-1',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-reuse',
      worktree_path: 'C:/repo/.worktrees/feat/factory-reuse',
    });
    factoryWorktrees.markMerged(first.id);

    // Same branch on a fresh batch should succeed now that the prior row is merged.
    const second = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-2',
      vc_worktree_id: 'vc-worktree-2',
      branch: 'feat/factory-reuse',
      worktree_path: 'C:/repo/.worktrees/feat/factory-reuse-retry',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('active');

    // But a second active row on the same branch still collides.
    expect(() => factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-3',
      vc_worktree_id: 'vc-worktree-3',
      branch: 'feat/factory-reuse',
      worktree_path: 'C:/repo/.worktrees/feat/factory-reuse-conflict',
    })).toThrow(/UNIQUE/i);

    db.close();
    factoryWorktrees.setDb(null);
  });

  it('refreshes created_at when setOwningTask attaches a non-null owner', async () => {
    // Regression: the loop-controller pre-reclaim grace check uses the
    // worktree row's created_at to decide whether the slot is "fresh."
    // Before this fix, attaching a fresh task to an old worktree row left
    // created_at frozen at row-insert time, so a fresh in-flight task would
    // be killed by the reclaim sweep with reason "pre_reclaim_before_create".
    // setOwningTask now bumps created_at on attach so the grace check sees
    // the slot as freshly-owned.
    const db = new Database(dbPath);
    createTables(db);
    db.prepare('ALTER TABLE factory_worktrees ADD COLUMN owning_task_id TEXT').run();
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);
    const recorded = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-attach',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-attach',
      worktree_path: 'C:/repo/.worktrees/feat/factory-attach',
    });

    // Backdate the row to simulate a long-lived worktree slot.
    db.prepare("UPDATE factory_worktrees SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(recorded.id);
    const stale = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recorded.id);
    const staleMs = Date.parse(`${stale.created_at.replace(' ', 'T')}Z`);
    expect(Date.now() - staleMs).toBeGreaterThan(60 * 60 * 1000);

    // Sleep briefly so the bump is observable at second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = factoryWorktrees.setOwningTask(recorded.id, 'task-fresh');
    expect(refreshed).toBeTruthy();
    expect(refreshed.owningTaskId).toBe('task-fresh');

    const after = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recorded.id);
    const afterMs = Date.parse(`${after.created_at.replace(' ', 'T')}Z`);
    // Created_at should now be within the last few seconds, not 2 hours old.
    expect(Date.now() - afterMs).toBeLessThan(10 * 1000);

    // Clearing the owner (null) must NOT bump created_at — clearing isn't a
    // slot reuse, just an end-of-life transition.
    const beforeClear = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recorded.id).created_at;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    factoryWorktrees.clearOwningTask(recorded.id);
    const afterClear = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recorded.id).created_at;
    expect(afterClear).toBe(beforeClear);

    db.close();
    factoryWorktrees.setDb(null);
  });

  it('refreshGraceForOwningTask bumps created_at for the active row owned by a task_id', async () => {
    // Regression: stall recovery requeues the SAME task_id (status='queued',
    // started_at=null) for a fresh attempt. Without this refresh the
    // factory_worktrees row keeps its old created_at — and on the next
    // factory tick, the loop-controller pre-reclaim sweep reads the row as
    // overstayed and cancels the in-flight retry with reason
    // pre_reclaim_before_create. This test pins the contract that
    // refreshGraceForOwningTask resets the grace window for that path.
    const db = new Database(dbPath);
    createTables(db);
    db.prepare('ALTER TABLE factory_worktrees ADD COLUMN owning_task_id TEXT').run();
    const workItemId = seedParents(db);

    const factoryWorktrees = loadFreshFactoryWorktrees();
    factoryWorktrees.setDb(db);

    // Two active rows on different work-items, the second owned by task-stall.
    const recordedA = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: workItemId,
      batch_id: 'batch-A',
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-A',
      worktree_path: 'C:/repo/.worktrees/feat/factory-A',
    });
    factoryWorktrees.setOwningTask(recordedA.id, 'task-other');

    db.prepare(`
      INSERT INTO factory_work_items (project_id, source, title, description)
      VALUES (?, ?, ?, ?)
    `).run('project-1', 'manual', 'Second item', 'second');
    const secondWorkItemId = db.prepare('SELECT MAX(id) AS id FROM factory_work_items').get().id;

    db.prepare(`
      INSERT INTO vc_worktrees (id, repo_path, worktree_path, branch, feature_name, base_branch, status, created_at, last_activity_at)
      VALUES ('vc-worktree-2', 'C:/repo', 'C:/repo/.worktrees/feat/factory-stall', 'feat/factory-stall', 'factory-stall', 'main', 'active', datetime('now'), datetime('now'))
    `).run();
    const recordedB = factoryWorktrees.recordWorktree({
      project_id: 'project-1',
      work_item_id: secondWorkItemId,
      batch_id: 'batch-B',
      vc_worktree_id: 'vc-worktree-2',
      branch: 'feat/factory-stall',
      worktree_path: 'C:/repo/.worktrees/feat/factory-stall',
    });
    factoryWorktrees.setOwningTask(recordedB.id, 'task-stall');

    // Backdate row B's created_at to simulate a long-running attempt.
    db.prepare("UPDATE factory_worktrees SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(recordedB.id);
    const beforeB = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedB.id);
    expect(Date.now() - Date.parse(`${beforeB.created_at.replace(' ', 'T')}Z`)).toBeGreaterThan(60 * 60 * 1000);

    // Also backdate row A — refreshing task-stall must NOT touch task-other.
    db.prepare("UPDATE factory_worktrees SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(recordedA.id);
    const beforeA = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedA.id);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = factoryWorktrees.refreshGraceForOwningTask('task-stall');
    expect(refreshed).toBeTruthy();
    expect(refreshed.id).toBe(recordedB.id);
    expect(refreshed.owningTaskId).toBe('task-stall');

    // Row B's grace window is reset to ~now.
    const afterB = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedB.id);
    expect(Date.now() - Date.parse(`${afterB.created_at.replace(' ', 'T')}Z`)).toBeLessThan(10 * 1000);

    // Row A is unchanged — refresh is scoped to the matched owner only.
    const afterA = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedA.id);
    expect(afterA.created_at).toBe(beforeA.created_at);

    // Unknown task_id is a no-op (returns null).
    expect(factoryWorktrees.refreshGraceForOwningTask('task-nonexistent')).toBeNull();

    // Abandoned rows are not touched even if owning_task_id matches.
    factoryWorktrees.markAbandoned(recordedB.id, 'test');
    const beforeAbandoned = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedB.id).created_at;
    expect(factoryWorktrees.refreshGraceForOwningTask('task-stall')).toBeNull();
    const afterAbandoned = db.prepare('SELECT created_at FROM factory_worktrees WHERE id = ?').get(recordedB.id).created_at;
    expect(afterAbandoned).toBe(beforeAbandoned);

    db.close();
    factoryWorktrees.setDb(null);
  });
});
