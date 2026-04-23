'use strict';
/* global describe, it, expect, beforeEach, afterEach */

const Database = require('better-sqlite3');
const { applySchema } = require('../db/schema');
const { createCheckpointStore } = require('../workflow-state/checkpoint-store');

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applySchema(db, {
    safeAddColumn: (table, colDef) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch (error) {
        if (!String(error && error.message).includes('duplicate column')) {
          throw error;
        }
      }
    },
    getConfig: (key) => {
      try {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        return row ? row.value : null;
      } catch {
        return null;
      }
    },
    setConfig: (key, value) => {
      try {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch {
        // config may not exist in reduced fixtures before applySchema completes
      }
    },
    setConfigDefault: (key, value) => {
      try {
        db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
      } catch {
        // config may not exist in reduced fixtures before applySchema completes
      }
    },
    DATA_DIR: __dirname,
  });

  return db;
}

describe('workflow checkpoint store', () => {
  let db;
  let store;

  beforeEach(() => {
    db = setupDb();
    store = createCheckpointStore({ db });
    db.prepare(`
      INSERT INTO workflows (id, name, status, created_at)
      VALUES ('wf-1', 'workflow-under-test', 'running', ?)
    `).run(new Date().toISOString());
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  it('writeCheckpoint persists a snapshot and returns its id', () => {
    const id = store.writeCheckpoint({
      workflowId: 'wf-1',
      stepId: 'plan',
      taskId: 't-1',
      state: { x: 1 },
      version: 2,
    });

    expect(id).toMatch(/^cp_/);

    const row = db.prepare('SELECT * FROM workflow_checkpoints WHERE checkpoint_id = ?').get(id);
    expect(JSON.parse(row.state_json)).toEqual({ x: 1 });
    expect(row.state_version).toBe(2);
    expect(row.workflow_id).toBe('wf-1');
    expect(row.step_id).toBe('plan');
    expect(row.task_id).toBe('t-1');
  });

  it('listCheckpoints returns checkpoints ordered by taken_at', () => {
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'a', state: { v: 1 }, version: 1 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'b', state: { v: 2 }, version: 2 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'c', state: { v: 3 }, version: 3 });

    const list = store.listCheckpoints('wf-1');

    expect(list).toHaveLength(3);
    expect(list.map((checkpoint) => checkpoint.step_id)).toEqual(['a', 'b', 'c']);
  });

  it('getCheckpoint returns the full record with parsed state', () => {
    const id = store.writeCheckpoint({
      workflowId: 'wf-1',
      stepId: 'plan',
      state: { foo: 'bar' },
      version: 1,
    });

    const checkpoint = store.getCheckpoint(id);

    expect(checkpoint.workflow_id).toBe('wf-1');
    expect(checkpoint.step_id).toBe('plan');
    expect(checkpoint.state).toEqual({ foo: 'bar' });
    expect(checkpoint.state_json).toBe(JSON.stringify({ foo: 'bar' }));
  });
});
