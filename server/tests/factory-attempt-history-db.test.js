import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const attemptHistory = require('../db/factory-attempt-history');

describe('factory-attempt-history DB accessor', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE factory_projects (id TEXT PRIMARY KEY, name TEXT, trust_level TEXT);
      CREATE TABLE factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT);
      CREATE TABLE factory_loop_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id INTEGER,
        batch_id TEXT, loop_state TEXT NOT NULL DEFAULT 'IDLE',
        paused_at_stage TEXT, last_action_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        terminated_at TEXT
      );
    `);
    runMigrations(db);
    attemptHistory.setDb(db);
  });

  afterEach(() => { db.close(); });

  it('appendRow assigns attempt=1 for the first row of a work_item', () => {
    const row = attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1',
      files_touched: ['a.js', 'b.js'], stdout_tail: 'ok',
    });
    expect(row.attempt).toBe(1);
    expect(row.file_count).toBe(2);
    expect(row.classifier_source).toBe('none');
  });

  it('appendRow increments attempt per work_item across kinds', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't2', files_touched: ['a.js'] });
    const r3 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't3', files_touched: ['b.js'] });
    expect(r3.attempt).toBe(3);
  });

  it('appendRow attempt counter is per-work_item, not global', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    const r = attemptHistory.appendRow({ batch_id: 'b2', work_item_id: 'w2', kind: 'execute', task_id: 't2', files_touched: [] });
    expect(r.attempt).toBe(1);
  });

  it('appendRow persists classifier fields when supplied', () => {
    const row = attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1',
      files_touched: [], stdout_tail: 'already in place',
      zero_diff_reason: 'already_in_place', classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    expect(row.zero_diff_reason).toBe('already_in_place');
    expect(row.classifier_source).toBe('heuristic');
    expect(row.classifier_conf).toBe(1.0);
  });

  it('appendRow rejects unknown kind', () => {
    expect(() => attemptHistory.appendRow({
      batch_id: 'b1', work_item_id: 'w1', kind: 'bogus', task_id: 't1', files_touched: [],
    })).toThrow(/kind/);
  });

  it('listByBatch returns rows ordered by attempt asc', () => {
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't2', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't3', files_touched: [] });
    const rows = attemptHistory.listByBatch('b1');
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(Array.isArray(rows[0].files_touched)).toBe(true);
  });

  it('listByWorkItem returns newest-first, limited', () => {
    for (let i = 1; i <= 5; i += 1) {
      attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: `t${i}`, files_touched: [] });
    }
    const rows = attemptHistory.listByWorkItem('w1', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0].attempt).toBe(5);
  });

  it('getLatestForBatch returns highest-attempt row or null', () => {
    expect(attemptHistory.getLatestForBatch('b1')).toBeNull();
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't2', files_touched: ['x.js'] });
    const latest = attemptHistory.getLatestForBatch('b1');
    expect(latest.attempt).toBe(2);
    expect(latest.kind).toBe('verify_retry');
  });

  it('updateVerifyOutputTail writes to the named row only', () => {
    const r1 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'execute', task_id: 't1', files_touched: [] });
    const r2 = attemptHistory.appendRow({ batch_id: 'b1', work_item_id: 'w1', kind: 'verify_retry', task_id: 't2', files_touched: [] });
    attemptHistory.updateVerifyOutputTail(r2.id, 'FAIL: foo\nFAIL: bar');
    const fetched = attemptHistory.listByBatch('b1');
    expect(fetched.find((r) => r.id === r1.id).verify_output_tail).toBeNull();
    expect(fetched.find((r) => r.id === r2.id).verify_output_tail).toBe('FAIL: foo\nFAIL: bar');
  });
});
