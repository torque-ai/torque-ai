'use strict';
const { randomUUID } = require('crypto');

const VALID_EVENT_TYPES = new Set([
  'workflow_created',
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'task_created',
  'task_started',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_retried',
  'dependency_unblocked',
  'state_patched',
  'state_validation_failed',
  'checkpoint_taken',
  'fork_created',
  'noop', // for tests
]);

function createJournalWriter({ db, logger = console }) {
  const writeStmt = db.prepare(`
    INSERT INTO workflow_events (event_id, workflow_id, seq, event_type, task_id, step_id, payload_json)
    VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM workflow_events WHERE workflow_id = ?), 0) + 1, ?, ?, ?, ?)
  `);
  const readSeqStmt = db.prepare(`SELECT seq FROM workflow_events WHERE event_id = ?`);

  function write({ workflowId, type, taskId = null, stepId = null, payload = null }) {
    if (!VALID_EVENT_TYPES.has(type)) {
      logger.warn?.('unknown event type, recording anyway', { type });
    }

    const eventId = `ev_${randomUUID().slice(0, 12)}`;

    const tx = db.transaction(() => {
      writeStmt.run(
        eventId,
        workflowId,
        workflowId,
        type,
        taskId,
        stepId,
        payload ? JSON.stringify(payload) : null,
      );
      return readSeqStmt.get(eventId).seq;
    });

    const seq = tx();
    return { event_id: eventId, seq };
  }

  function readJournal(workflowId, { fromSeq = null, toSeq = null } = {}) {
    let sql = 'SELECT * FROM workflow_events WHERE workflow_id = ?';
    const params = [workflowId];

    if (fromSeq !== null) {
      sql += ' AND seq >= ?';
      params.push(fromSeq);
    }
    if (toSeq !== null) {
      sql += ' AND seq <= ?';
      params.push(toSeq);
    }
    sql += ' ORDER BY seq ASC';

    return db
      .prepare(sql)
      .all(...params)
      .map((row) => ({
        ...row,
        payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      }));
  }

  return { write, readJournal };
}

module.exports = { createJournalWriter, VALID_EVENT_TYPES };
