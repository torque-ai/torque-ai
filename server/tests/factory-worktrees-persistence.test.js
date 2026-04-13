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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch
      ON factory_worktrees(branch);
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
  const modulePath = require.resolve('../db/factory-worktrees');
  delete require.cache[modulePath];
  return require('../db/factory-worktrees');
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
});
