'use strict';
/* global describe, it, expect, beforeEach */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../db/schema/tables');
const {
  parkWorkItemForCodex,
  resumeAllCodexParked,
  isParkedStatus,
  PARK_STATUSES,
} = require('../db/factory/intake');

const INSERT_PROJECT = `INSERT INTO factory_projects (id, name, path, brief, trust_level, status)
                       VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO factory_work_items (project_id, source, title) VALUES (?, ?, ?)`;
const LOGGER_STUB = { debug() {}, info() {}, warn() {}, error() {} };

describe('park work-item helpers', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureSchema(db, LOGGER_STUB);
    db.prepare(INSERT_PROJECT).run('p1', 'TestProj', '/tmp', 'brief', 'cautious', 'running');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item A');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item B');
    db.prepare(INSERT_ITEM).run('p1', 'scout', 'Item C');
  });

  it('PARK_STATUSES exposes the new vocabulary', () => {
    expect(PARK_STATUSES).toContain('parked_codex_unavailable');
    expect(PARK_STATUSES).toContain('parked_chain_exhausted');
  });

  it('isParkedStatus identifies park values', () => {
    expect(isParkedStatus('parked_codex_unavailable')).toBe(true);
    expect(isParkedStatus('parked_chain_exhausted')).toBe(true);
    expect(isParkedStatus('pending')).toBe(false);
    expect(isParkedStatus('completed')).toBe(false);
  });

  it('parkWorkItemForCodex sets status', () => {
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'wait_for_codex_policy' });
    const row = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row.status).toBe('parked_codex_unavailable');
  });

  it('resumeAllCodexParked promotes parked items to pending', () => {
    parkWorkItemForCodex({ db, workItemId: 1, reason: 'a' });
    parkWorkItemForCodex({ db, workItemId: 2, reason: 'b' });
    const resumed = resumeAllCodexParked({ db });
    expect(resumed).toBe(2);
    const rows = db.prepare(`SELECT id, status FROM factory_work_items ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, status: 'pending' },
      { id: 2, status: 'pending' },
      { id: 3, status: 'pending' },
    ]);
  });

  it('resumeAllCodexParked does NOT resume parked_chain_exhausted items', () => {
    db.prepare(`UPDATE factory_work_items SET status = 'parked_chain_exhausted' WHERE id = 1`).run();
    parkWorkItemForCodex({ db, workItemId: 2, reason: 'a' });
    const resumed = resumeAllCodexParked({ db });
    expect(resumed).toBe(1);
    const row1 = db.prepare(`SELECT status FROM factory_work_items WHERE id = 1`).get();
    expect(row1.status).toBe('parked_chain_exhausted');
  });
});
