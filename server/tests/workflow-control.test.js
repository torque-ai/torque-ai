'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createWorkflowState } = require('../workflow-state/workflow-state');
const { createJournalWriter } = require('../journal/journal-writer');
const { createWorkflowControl } = require('../control/workflow-control');

function setupWorkflow(db) {
  db.prepare(`
    INSERT INTO workflows (id, name, status, control_handlers_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'wf-1',
    'test',
    'running',
    JSON.stringify({
      queries: { current_round: 'state.round', all_logs: 'state.logs' },
      signals: { add_log: 'state.logs.append', set_round: 'state.round.replace' },
      updates: { merge_config: 'state.config.merge_object' },
    }),
    new Date().toISOString(),
  );
}

describe('workflowControl', () => {
  let db;
  let workflowState;
  let journal;
  let control;

  beforeEach(() => {
    setupTestDbOnly('workflow-control');
    db = rawDb();
    workflowState = createWorkflowState({ db });
    journal = createJournalWriter({ db });
    db.prepare('DELETE FROM workflow_events').run();
    control = createWorkflowControl({ db, workflowState, journal });

    setupWorkflow(db);
    workflowState.setStateSchema('wf-1', null, {
      logs: 'append',
      round: 'replace',
      config: 'merge_object',
    });
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('query', () => {
    it('returns the value at the resolved state path', () => {
      workflowState.applyPatch('wf-1', { round: 7 });

      const result = control.query('wf-1', 'current_round');

      expect(result.ok).toBe(true);
      expect(result.value).toBe(7);
    });

    it('does NOT write to the journal', () => {
      workflowState.applyPatch('wf-1', { round: 7 });

      const before = journal.readJournal('wf-1').length;
      control.query('wf-1', 'current_round');
      const after = journal.readJournal('wf-1').length;

      expect(after).toBe(before);
    });

    it('errors when the named query is not declared', () => {
      const result = control.query('wf-1', 'unknown');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not registered/i);
    });
  });

  describe('signal', () => {
    it('applies the patch via reducer and journals a signal_received event', () => {
      const result = control.signal('wf-1', 'add_log', 'hello');

      expect(result.ok).toBe(true);
      expect(workflowState.getState('wf-1').logs).toEqual(['hello']);

      const events = journal.readJournal('wf-1');
      expect(events.some((event) => event.event_type === 'signal_received' && event.payload?.signal === 'add_log')).toBe(true);
    });

    it('multiple signals accumulate per reducer', () => {
      control.signal('wf-1', 'add_log', 'a');
      control.signal('wf-1', 'add_log', 'b');
      control.signal('wf-1', 'set_round', 5);

      expect(workflowState.getState('wf-1')).toEqual({ logs: ['a', 'b'], round: 5 });
    });

    it('errors when the named signal is not declared', () => {
      expect(control.signal('wf-1', 'unknown', 'x').ok).toBe(false);
    });
  });

  describe('update', () => {
    it('applies the patch and returns the new state synchronously', async () => {
      const result = await control.update('wf-1', 'merge_config', { mode: 'fast' });

      expect(result.ok).toBe(true);
      expect(result.state.config).toEqual({ mode: 'fast' });
    });

    it('returns validation error when state schema rejects the patch', async () => {
      workflowState.setStateSchema(
        'wf-1',
        { type: 'object', properties: { config: { type: 'string' } } },
        { config: 'replace' },
      );

      const result = await control.update('wf-1', 'merge_config', { wrong: 'shape' });

      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('journals an update_applied event', async () => {
      await control.update('wf-1', 'merge_config', { mode: 'safe' });

      const events = journal.readJournal('wf-1');
      expect(events.some((event) => event.event_type === 'update_applied' && event.payload?.update === 'merge_config')).toBe(true);
    });
  });
});
