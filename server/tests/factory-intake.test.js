'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const handlers = require('../handlers/factory-handlers');

function createFactoryTables(db) {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fhs_project_dim
      ON factory_health_snapshots(project_id, dimension, scanned_at);
    CREATE INDEX IF NOT EXISTS idx_fhs_project_time
      ON factory_health_snapshots(project_id, scanned_at);

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fhf_snapshot
      ON factory_health_findings(snapshot_id);

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'default',
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'intake',
      reject_reason TEXT,
      linked_item_id TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
      ON factory_work_items(source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
      ON factory_work_items(linked_item_id);
  `);
}

function parseJsonResponse(result) {
  return JSON.parse(result.content[0].text);
}

describe('factory intake', () => {
  let db;
  let project;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Test App',
      path: '/projects/factory-test-app',
      brief: 'Test project for intake flows',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('createWorkItem creates and returns item with correct defaults', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Add project intake coverage',
    });

    expect(item.id).toBeTruthy();
    expect(item.project_id).toBe(project.id);
    expect(item.title).toBe('Add project intake coverage');
    expect(item.status).toBe('intake');
    expect(item.source).toBe('conversational');
    expect(item.priority).toBe('default');
  });

  test('listWorkItems returns items sorted by priority', () => {
    factoryIntake.createWorkItem({ project_id: project.id, title: 'Low', priority: 'low' });
    factoryIntake.createWorkItem({ project_id: project.id, title: 'Default', priority: 'default' });
    factoryIntake.createWorkItem({ project_id: project.id, title: 'User Override', priority: 'user_override' });
    factoryIntake.createWorkItem({ project_id: project.id, title: 'Medium', priority: 'medium' });
    factoryIntake.createWorkItem({ project_id: project.id, title: 'High', priority: 'high' });

    const items = factoryIntake.listWorkItems({ project_id: project.id });

    expect(items.map(item => item.title)).toEqual([
      'User Override',
      'High',
      'Medium',
      'Default',
      'Low',
    ]);
  });

  test('updateWorkItem changes status and priority', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Promote this request',
    });

    const updated = factoryIntake.updateWorkItem(item.id, {
      status: 'planned',
      priority: 'high',
    });

    expect(updated.status).toBe('planned');
    expect(updated.priority).toBe('high');
  });

  test('rejectWorkItem sets status to rejected and stores reason', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Duplicate request',
    });

    const rejected = factoryIntake.rejectWorkItem(item.id, 'Already tracked elsewhere');

    expect(rejected.status).toBe('rejected');
    expect(rejected.reject_reason).toBe('Already tracked elsewhere');
  });

  test('findDuplicates detects exact and partial title matches', () => {
    const exact = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Improve queue metrics',
    });
    const partial = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Queue metrics',
    });
    const shipped = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Improve queue metrics',
    });
    factoryIntake.updateWorkItem(shipped.id, { status: 'shipped' });

    const matches = factoryIntake.findDuplicates(project.id, 'Improve queue metrics');

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        match_type: 'exact_title',
        item: expect.objectContaining({ id: exact.id }),
      }),
      expect.objectContaining({
        match_type: 'partial_title',
        item: expect.objectContaining({ id: partial.id }),
      }),
    ]));
    expect(matches).toHaveLength(2);
  });

  test('createFromFindings bulk-creates from finding objects and maps severity to priority', () => {
    const created = factoryIntake.createFromFindings(project.id, [
      {
        title: 'Critical outage in planner',
        severity: 'critical',
        file: 'src/planner.js',
      },
      {
        message: 'High error rate on queue workers',
        severity: 'high',
        file: 'src/queue.js',
      },
      {
        message: 'Minor documentation drift',
        severity: 'low',
        file: 'docs/factory.md',
      },
    ]);

    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({
      source: 'scheduled_scan',
      priority: 'high',
      requestor: 'scout',
      origin: { type: 'finding', severity: 'critical', file: 'src/planner.js' },
    });
    expect(created[1]).toMatchObject({
      priority: 'medium',
      origin: { type: 'finding', severity: 'high', file: 'src/queue.js' },
    });
    expect(created[2]).toMatchObject({
      priority: 'default',
      origin: { type: 'finding', severity: 'low', file: 'docs/factory.md' },
    });
  });

  test('getIntakeStats returns counts grouped by status', () => {
    const intake = factoryIntake.createWorkItem({ project_id: project.id, title: 'Keep in intake' });
    const planned = factoryIntake.createWorkItem({ project_id: project.id, title: 'Plan me' });
    const rejected = factoryIntake.createWorkItem({ project_id: project.id, title: 'Reject me' });
    const shipped = factoryIntake.createWorkItem({ project_id: project.id, title: 'Ship me' });

    factoryIntake.updateWorkItem(planned.id, { status: 'planned' });
    factoryIntake.rejectWorkItem(rejected.id, 'Out of scope');
    factoryIntake.updateWorkItem(shipped.id, { status: 'shipped' });

    const stats = factoryIntake.getIntakeStats(project.id);

    expect(stats).toMatchObject({
      intake: 1,
      planned: 1,
      rejected: 1,
      shipped: 1,
    });
    expect(stats.intake).toBe(1);
    expect(intake.status).toBe('intake');
  });

  test('handler: handleCreateWorkItem via MCP creates item', async () => {
    const result = await handlers.handleCreateWorkItem({
      project: project.id,
      title: 'Investigate flaky intake test',
      description: 'Need a reliable regression test',
      priority: 'high',
      requestor: 'qa',
    });
    const data = parseJsonResponse(result);

    expect(data.message).toContain('created');
    expect(data.item).toMatchObject({
      project_id: project.id,
      title: 'Investigate flaky intake test',
      description: 'Need a reliable regression test',
      priority: 'high',
      requestor: 'qa',
      status: 'intake',
      source: 'conversational',
    });
  });

  test('handler: handleListWorkItems returns items with stats', async () => {
    const defaultItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Default priority request',
    });
    const highItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Urgent request',
      priority: 'high',
    });
    factoryIntake.updateWorkItem(defaultItem.id, { status: 'shipped' });

    const result = await handlers.handleListWorkItems({ project: project.id });
    const data = parseJsonResponse(result);

    expect(data.items).toHaveLength(2);
    expect(data.items.map(item => item.id)).toEqual([highItem.id, defaultItem.id]);
    expect(data.stats).toMatchObject({
      intake: 1,
      shipped: 1,
    });
  });

  test('handler: handleRejectWorkItem rejects with reason', async () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Reject through handler',
    });

    const result = await handlers.handleRejectWorkItem({
      id: item.id,
      reason: 'Superseded by another work item',
    });
    const data = parseJsonResponse(result);

    expect(data.message).toContain('rejected');
    expect(data.item).toMatchObject({
      id: item.id,
      status: 'rejected',
      reject_reason: 'Superseded by another work item',
    });
  });
});
