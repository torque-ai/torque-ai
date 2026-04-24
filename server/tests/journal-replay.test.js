'use strict';

const { beforeEach, afterEach, describe, it, expect } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createJournalWriter } = require('../journal/journal-writer');
const { replayWorkflow } = require('../journal/journal-replay');

let db;
let journal;

beforeEach(() => {
  ({ db } = setupTestDbOnly('journal-replay'));
  journal = createJournalWriter({ db });
  db.prepare(`INSERT INTO workflows (id, name, status) VALUES ('wf-1', 't', 'running')`).run();
});

afterEach(() => teardownTestDb());

describe('replayWorkflow', () => {
  it('reconstructs task statuses from start/complete/fail events', () => {
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't2' });
    journal.write({ workflowId: 'wf-1', type: 'task_failed', taskId: 't2', payload: { reason: 'oom' } });

    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.tasks.t1.status).toBe('completed');
    expect(replay.tasks.t2.status).toBe('failed');
    expect(replay.tasks.t2.failure_payload.reason).toBe('oom');
  });

  it('reconstructs state by folding state_patched events through reducers', () => {
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { count: 1 }, reducers: { count: 'numeric_sum' } },
    });
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { count: 2 }, reducers: { count: 'numeric_sum' } },
    });
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { tag: 'x' }, reducers: { tag: 'replace' } },
    });

    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.state).toEqual({ count: 3, tag: 'x' });
  });

  it('records last event seq seen', () => {
    for (let i = 0; i < 4; i++) {
      journal.write({ workflowId: 'wf-1', type: 'noop' });
    }
    const replay = replayWorkflow({ db, workflowId: 'wf-1' });
    expect(replay.last_seq).toBe(4);
  });

  it('can replay up to a specific seq (point-in-time view)', () => {
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } },
    });
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } },
    });
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { patch: { x: 1 }, reducers: { x: 'numeric_sum' } },
    });

    const replay = replayWorkflow({ db, workflowId: 'wf-1', toSeq: 2 });
    expect(replay.state.x).toBe(2);
    expect(replay.last_seq).toBe(2);
  });
});
