'use strict';

const { randomUUID } = require('crypto');
const { safeJsonStringify } = require('../utils/json');

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
  'signal_received',
  'update_applied',
  'noop',
]);

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('journal writer requires a database handle');
}

function ensureSchema(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      event_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      task_id TEXT,
      step_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (workflow_id, seq),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )
  `);
  dbHandle.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_wf_seq
    ON workflow_events(workflow_id, seq)
  `);
  dbHandle.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_type
    ON workflow_events(event_type)
  `);
  dbHandle.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_task
    ON workflow_events(task_id)
  `);
}

function parsePayload(payloadJson) {
  if (payloadJson === null || payloadJson === undefined) {
    return null;
  }

  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function createJournalWriter({ db, logger = console } = {}) {
  const dbHandle = resolveDbHandle(db);
  ensureSchema(dbHandle);

  const insertEvent = dbHandle.prepare(`
    INSERT INTO workflow_events (
      event_id,
      workflow_id,
      seq,
      event_type,
      task_id,
      step_id,
      payload_json,
      created_at
    )
    VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM workflow_events WHERE workflow_id = ?), 0) + 1, ?, ?, ?, ?, ?)
  `);
  const readSeq = dbHandle.prepare(`
    SELECT seq
    FROM workflow_events
    WHERE event_id = ?
  `);

  const writeTx = dbHandle.transaction(({ workflowId, type, taskId = null, stepId = null, payload = null }) => {
    const eventId = `ev_${randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    insertEvent.run(
      eventId,
      workflowId,
      workflowId,
      type,
      taskId,
      stepId,
      payload === undefined ? null : safeJsonStringify(payload, 'null'),
      createdAt,
    );

    return {
      event_id: eventId,
      seq: readSeq.get(eventId).seq,
      created_at: createdAt,
    };
  });

  function write({ workflowId, type, taskId = null, stepId = null, payload = null }) {
    if (typeof workflowId !== 'string' || workflowId.trim().length === 0) {
      throw new Error('workflowId is required');
    }
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error('type is required');
    }

    if (!VALID_EVENT_TYPES.has(type)) {
      logger.warn?.('unknown workflow journal event type, recording anyway', { type });
    }

    return writeTx({
      workflowId: workflowId.trim(),
      type: type.trim(),
      taskId,
      stepId,
      payload,
    });
  }

  function readJournal(workflowId, { fromSeq = null, toSeq = null } = {}) {
    let sql = `
      SELECT *
      FROM workflow_events
      WHERE workflow_id = ?
    `;
    const params = [workflowId];

    if (fromSeq !== null && fromSeq !== undefined) {
      sql += ' AND seq >= ?';
      params.push(fromSeq);
    }
    if (toSeq !== null && toSeq !== undefined) {
      sql += ' AND seq <= ?';
      params.push(toSeq);
    }

    sql += ' ORDER BY seq ASC';

    return dbHandle.prepare(sql).all(...params).map((row) => ({
      ...row,
      payload: parsePayload(row.payload_json),
    }));
  }

  return { write, readJournal };
}

module.exports = { createJournalWriter, VALID_EVENT_TYPES };
