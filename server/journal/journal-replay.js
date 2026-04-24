'use strict';

const { reduceState } = require('../workflow-state/reducers');
const { createJournalWriter } = require('./journal-writer');

function replayWorkflow({ db, workflowId, toSeq = null }) {
  const journal = createJournalWriter({ db });
  const events = journal.readJournal(workflowId, { toSeq });

  const tasks = {};
  let state = {};
  const unblocked = new Set();

  for (const ev of events) {
    switch (ev.event_type) {
      case 'task_created':
        tasks[ev.task_id] = { status: 'pending', payload: ev.payload || {} };
        break;
      case 'task_started':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'running', started_at: ev.created_at };
        break;
      case 'task_completed':
        tasks[ev.task_id] = {
          ...(tasks[ev.task_id] || {}),
          status: 'completed',
          completed_at: ev.created_at,
          output: ev.payload?.output,
        };
        break;
      case 'task_failed':
        tasks[ev.task_id] = {
          ...(tasks[ev.task_id] || {}),
          status: 'failed',
          failed_at: ev.created_at,
          failure_payload: ev.payload,
        };
        break;
      case 'task_cancelled':
        tasks[ev.task_id] = { ...(tasks[ev.task_id] || {}), status: 'cancelled' };
        break;
      case 'state_patched': {
        const patch = ev.payload?.patch || {};
        const reducers = ev.payload?.reducers || {};
        state = reduceState(state, patch, reducers);
        break;
      }
      case 'dependency_unblocked':
        unblocked.add(ev.task_id);
        break;
      default:
        break;
      // workflow_*, noop, etc. are observability-only here
    }
  }

  return {
    workflow_id: workflowId,
    tasks,
    state,
    unblocked: Array.from(unblocked),
    last_seq: events.length ? events[events.length - 1].seq : 0,
    event_count: events.length,
  };
}

module.exports = { replayWorkflow };
