'use strict';

// Regression for the DLPhone empty-branch loop observed 2026-05-02.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const factoryHealth = require('../db/factory-health');
const { routeWorkItemToNeedsReplan } = require('../factory/loop-controller');

function createMinimalSchema(database) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS factory_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'paused', config_json TEXT, provider_chain_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));",
    "CREATE TABLE IF NOT EXISTS factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES factory_projects(id), source TEXT NOT NULL, origin_json TEXT, title TEXT NOT NULL, description TEXT, priority INTEGER NOT NULL DEFAULT 50, requestor TEXT, constraints_json TEXT, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, linked_item_id INTEGER, depth INTEGER DEFAULT 0, batch_id TEXT, claimed_by_instance_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));",
  ];
  for (const stmt of stmts) database.exec(stmt);
}

describe('routeWorkItemToNeedsReplan also deletes stale plan file from disk', () => {
  let db;
  let tmpDir;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    factoryIntake.setDb(db);
    factoryHealth.setDb(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-stale-plan-'));
    const insertSql = "INSERT INTO factory_projects (id, name, path, status, created_at, updated_at) VALUES ('p1', 'Proj', '/tmp/stale-plan-test', 'running', datetime('now'), datetime('now'))";
    db.prepare(insertSql).run();
  });

  afterEach(() => {
    factoryIntake.setDb(null);
    factoryHealth.setDb(null);
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  it('deletes the on-disk plan file when origin.plan_path points to it', () => {
    const planPath = path.join(tmpDir, '2048-test-plan.md');
    fs.writeFileSync(planPath, '# Test plan\n\n- [x] Step 1: done\n- [x] Step 2: also done\n');
    expect(fs.existsSync(planPath)).toBe(true);

    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Stale plan test',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: { plan_path: planPath },
    });

    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'empty_branch_after_execute' },
    );

    expect(after.status).toBe('needs_replan');
    expect(after.origin?.plan_path).toBeUndefined();
    // Critical: the file must also be gone so the next pickup forces fresh plan generation.
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it('preserves source plan_file documents and keeps their origin plan_path', () => {
    const planPath = path.join(tmpDir, '2026-04-11-fabro-63-persistent-threads.md');
    fs.writeFileSync(planPath, '# Persistent threads Plan\n\n## Task 1: Implement threads\n');

    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'plan_file', title: 'Source plan should persist',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: { plan_path: planPath, plan_generation_task_id: 'old-task-id' },
    });

    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'pre_written_plan_rejected_by_quality_gate' },
    );

    expect(after.status).toBe('needs_replan');
    expect(after.origin?.plan_path).toBe(planPath);
    expect(after.origin?.plan_generation_task_id).toBeUndefined();
    expect(fs.existsSync(planPath)).toBe(true);
  });

  it('does not throw when plan_path is missing or file does not exist', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'No plan path',
    });
    expect(() => routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'cannot_generate_plan' },
    )).not.toThrow();
  });

  it('does not throw when plan_path exists in origin but file is already gone', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Phantom plan',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: { plan_path: path.join(tmpDir, 'nonexistent.md') },
    });
    expect(() => routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'empty_branch_after_execute' },
    )).not.toThrow();
  });

  it('clears plan_path from origin AND deletes file in the same call', () => {
    const planPath = path.join(tmpDir, '2048-dlphone-first-run-host-join-smoke-checklist.md');
    fs.writeFileSync(planPath, [
      '# Dlphone first run host join smoke checklist Plan',
      '',
      '## Task 1: Reconcile duplicate first-run smoke plan records',
      '- [x] **Step 1: Done**',
      '- [x] **Step 2: Commit**',
    ].join('\n'));

    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Dlphone first run host join smoke checklist',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: { plan_path: planPath, plan_generation_task_id: 'old-task-id' },
    });

    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'empty_branch_after_execute' },
    );

    expect(after.status).toBe('needs_replan');
    expect(after.origin?.plan_path).toBeUndefined();
    expect(after.origin?.plan_generation_task_id).toBeUndefined();
    expect(fs.existsSync(planPath)).toBe(false);
  });
});
