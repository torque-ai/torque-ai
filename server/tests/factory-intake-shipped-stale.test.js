import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');

function createMinimalSchema(db) {
  db.prepare(`CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT)`).run();
  db.prepare(`INSERT INTO factory_projects (id, name) VALUES ('p1', 'test')`).run();
  db.prepare(`
    CREATE TABLE factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
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
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run();
}

describe('factory-intake shipped_stale status', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    factoryIntake.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('accepts shipped_stale as a valid status on updateWorkItem', () => {
    const created = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Scout finding X',
    });
    expect(() => factoryIntake.updateWorkItem(created.id, { status: 'shipped_stale' }))
      .not.toThrow();
    const row = db.prepare('SELECT status FROM factory_work_items WHERE id = ?').get(created.id);
    expect(row.status).toBe('shipped_stale');
  });

  it('exports VALID_STATUSES containing shipped_stale', () => {
    expect(factoryIntake.VALID_STATUSES.has('shipped_stale')).toBe(true);
  });

  it('still rejects truly bogus statuses', () => {
    const created = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Scout finding Y',
    });
    expect(() => factoryIntake.updateWorkItem(created.id, { status: 'nonsense_status' }))
      .toThrow(/Invalid status/);
  });
});
