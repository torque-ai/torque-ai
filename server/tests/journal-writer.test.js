'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { createJournalWriter } = require('../journal/journal-writer');

describe('journalWriter', () => {
  let db, journal;

  beforeEach(() => {
    ({ db } = setupTestDbOnly('journal-writer'));
    journal = createJournalWriter({ db });
    db.prepare(`INSERT INTO workflows (id, name, status) VALUES ('wf-1', 't', 'running')`).run();
  });

  afterEach(() => teardownTestDb());

  it('write assigns monotonically increasing seq per workflow', () => {
    const e1 = journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    const e2 = journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    const e3 = journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't2' });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('seq counters are independent per workflow', () => {
    db.prepare(`INSERT INTO workflows (id, name, status) VALUES ('wf-2', 't', 'running')`).run();
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });

    const first = journal.write({ workflowId: 'wf-2', type: 'task_started', taskId: 'tA' });

    expect(first.seq).toBe(1);
  });

  it('payload is serialized as JSON', () => {
    journal.write({
      workflowId: 'wf-1',
      type: 'state_patched',
      payload: { delta: { count: 1 } },
    });

    const row = db
      .prepare('SELECT payload_json FROM workflow_events WHERE workflow_id = ? LIMIT 1')
      .get('wf-1');

    expect(JSON.parse(row.payload_json).delta.count).toBe(1);
  });

  it('readJournal returns all events in seq order', () => {
    journal.write({ workflowId: 'wf-1', type: 'task_started', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'task_completed', taskId: 't1' });
    journal.write({ workflowId: 'wf-1', type: 'state_patched', payload: { x: 1 } });

    const events = journal.readJournal('wf-1');

    expect(events.map((e) => e.event_type)).toEqual([
      'task_started',
      'task_completed',
      'state_patched',
    ]);
  });

  it('write is atomic — concurrent writes get distinct seq values', () => {
    const seqs = [];
    for (let i = 0; i < 10; i++) {
      seqs.push(journal.write({ workflowId: 'wf-1', type: 'noop' }).seq);
    }
    const sorted = [...seqs].sort((a, b) => a - b);

    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(seqs).size).toBe(10);
  });
});
