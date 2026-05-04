'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory/intake');

function createMinimalSchema(db) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS factory_projects (",
    "  id TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  path TEXT NOT NULL UNIQUE,",
    "  status TEXT NOT NULL DEFAULT 'paused',",
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
    "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ");",
    "CREATE TABLE IF NOT EXISTS factory_work_items (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  project_id TEXT NOT NULL REFERENCES factory_projects(id),",
    "  source TEXT NOT NULL,",
    "  origin_json TEXT,",
    "  title TEXT NOT NULL,",
    "  description TEXT,",
    "  priority INTEGER NOT NULL DEFAULT 50,",
    "  requestor TEXT,",
    "  constraints_json TEXT,",
    "  status TEXT NOT NULL DEFAULT 'pending',",
    "  reject_reason TEXT,",
    "  linked_item_id INTEGER,",
    "  depth INTEGER DEFAULT 0,",
    "  batch_id TEXT,",
    "  claimed_by_instance_id TEXT,",
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),",
    "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ");",
  ].join('\n');
  db.exec(sql);
}

describe('Phase X1: needs_replan status (foundation)', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    factoryIntake.setDb(db);
    const insertSql = "INSERT INTO factory_projects (id, name, path, status, created_at, updated_at) "
      + "VALUES ('p1', 'TestProject', '/tmp/x1', 'running', "
      + "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
      + "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
    db.prepare(insertSql).run();
  });

  afterEach(() => {
    factoryIntake.setDb(null);
    db.close();
  });

  describe('status enum', () => {
    it('VALID_STATUSES includes needs_replan', () => {
      expect(factoryIntake.VALID_STATUSES.has('needs_replan')).toBe(true);
    });

    it('CLOSED_STATUSES does NOT include needs_replan (so PRIORITIZE picks it up)', () => {
      const item = factoryIntake.createWorkItem({
        project_id: 'p1', source: 'scout', title: 'Needs replan item',
      });
      factoryIntake.updateWorkItem(item.id, { status: 'needs_replan' });
      const open = factoryIntake.listOpenWorkItems({ project_id: 'p1' });
      expect(open.map((w) => w.id)).toContain(item.id);
    });
  });

  describe('updateWorkItem accepts needs_replan', () => {
    it('does not throw when transitioning to needs_replan', () => {
      const item = factoryIntake.createWorkItem({
        project_id: 'p1', source: 'scout', title: 'X',
      });
      expect(() => factoryIntake.updateWorkItem(item.id, { status: 'needs_replan' })).not.toThrow();
      const reloaded = factoryIntake.getWorkItem(item.id);
      expect(reloaded.status).toBe('needs_replan');
    });

    it('rejects unknown status values (regression: VALID_STATUSES still enforced)', () => {
      const item = factoryIntake.createWorkItem({
        project_id: 'p1', source: 'scout', title: 'X',
      });
      expect(() => factoryIntake.updateWorkItem(item.id, { status: 'totally_made_up' })).toThrow(/Invalid status/);
    });
  });

  describe('PRIORITIZE selection ordering', () => {
    it('listOpenWorkItems returns needs_replan items alongside pending items', () => {
      const a = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'fresh' });
      const b = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'replan-me' });
      factoryIntake.updateWorkItem(b.id, { status: 'needs_replan' });
      const open = factoryIntake.listOpenWorkItems({ project_id: 'p1' });
      const ids = new Set(open.map((w) => w.id));
      expect(ids.has(a.id)).toBe(true);
      expect(ids.has(b.id)).toBe(true);
    });

    it('rejected, shipped, and unactionable items remain hidden from listOpenWorkItems', () => {
      const r = factoryIntake.createWorkItem({ project_id: 'p1', source: 'scout', title: 'rejected' });
      factoryIntake.updateWorkItem(r.id, { status: 'rejected' });
      const open = factoryIntake.listOpenWorkItems({ project_id: 'p1' });
      expect(open.map((w) => w.id)).not.toContain(r.id);
    });
  });
});

describe('Phase X1: WORK_ITEM_STATUS_ORDER includes needs_replan at end', () => {
  it('loop-controller exposes needs_replan in WORK_ITEM_STATUS_ORDER', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'factory', 'loop-controller.js'),
      'utf8',
    );
    const orderMatch = src.match(/WORK_ITEM_STATUS_ORDER\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(orderMatch).not.toBeNull();
    expect(orderMatch[1]).toContain("'needs_replan'");
    const tuple = orderMatch[1];
    const pendingIdx = tuple.indexOf("'pending'");
    const replanIdx = tuple.indexOf("'needs_replan'");
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(replanIdx).toBeGreaterThan(pendingIdx);
  });

  it('NEEDS_REPLAN_COOLDOWN_MS is defined and at least 5 minutes', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'factory', 'loop-controller.js'),
      'utf8',
    );
    const match = src.match(/NEEDS_REPLAN_COOLDOWN_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(5);
  });

  it('claimNextWorkItemForInstance applies NEEDS_REPLAN_COOLDOWN_MS check', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'factory', 'loop-controller.js'),
      'utf8',
    );
    const cooldownBlock = src.match(/needs_replan'[\s\S]{0,400}NEEDS_REPLAN_COOLDOWN_MS/);
    expect(cooldownBlock).not.toBeNull();
  });
});
