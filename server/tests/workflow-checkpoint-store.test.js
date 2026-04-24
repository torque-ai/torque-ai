'use strict';

const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createCheckpointStore } = require('../workflow-state/checkpoint-store');

describe('checkpoint-store', () => {
  let db;
  let store;

  beforeEach(() => {
    setupTestDbOnly('workflow-checkpoint-store');
    db = rawDb();
    store = createCheckpointStore({ db });
    db.prepare(`
      INSERT INTO workflows (id, name, status, created_at)
      VALUES ('wf-1', 't', 'running', ?)
    `).run(new Date().toISOString());
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('writeCheckpoint persists a snapshot and returns its id', () => {
    const id = store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'plan', taskId: 't-1', state: { x: 1 }, version: 2 });
    expect(id).toMatch(/^cp_/);
    const row = db.prepare('SELECT * FROM workflow_checkpoints WHERE checkpoint_id = ?').get(id);
    expect(JSON.parse(row.state_json)).toEqual({ x: 1 });
    expect(row.state_version).toBe(2);
  });

  it('listCheckpoints returns checkpoints ordered by taken_at', () => {
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'a', state: { v: 1 }, version: 1 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'b', state: { v: 2 }, version: 2 });
    store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'c', state: { v: 3 }, version: 3 });
    const list = store.listCheckpoints('wf-1');
    expect(list).toHaveLength(3);
    expect(list.map(c => c.step_id)).toEqual(['a', 'b', 'c']);
  });

  it('getCheckpoint returns full record', () => {
    const id = store.writeCheckpoint({ workflowId: 'wf-1', stepId: 'plan', state: { foo: 'bar' }, version: 1 });
    const checkpoint = store.getCheckpoint(id);
    expect(checkpoint.workflow_id).toBe('wf-1');
    expect(checkpoint.state).toEqual({ foo: 'bar' });
  });
});
