'use strict';

const VALID_EVENT_TYPES = new Set([
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'workflow_paused',
  'workflow_cancelled',
  'activity_started',
  'activity_completed',
  'activity_failed',
  'activity_heartbeat',
]);

function safeParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeStringify(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      _serialization_error: err.message,
      _truncated: true,
    });
  }
}

function createJournalWriter({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createJournalWriter requires a database handle');
  }

  function write({ workflowId, taskId, type, actor = null, payload = {} }) {
    if (!type || typeof type !== 'string') {
      throw new Error('journal.write requires a type');
    }
    if (!VALID_EVENT_TYPES.has(type)) {
      throw new Error(`Unknown journal event type: ${type}`);
    }

    const ts = new Date().toISOString();
    const payloadJson = safeStringify(payload);
    const persistedTaskId = taskId || workflowId || '__journal__';

    const result = db.prepare(`
      INSERT INTO task_events (
        task_id, workflow_id, ts, type, actor, payload_json,
        event_type, event_data, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      persistedTaskId,
      workflowId || null,
      ts,
      type,
      actor,
      payloadJson,
      type,
      payloadJson,
      ts
    );

    return {
      id: result.lastInsertRowid,
      task_id: persistedTaskId,
      workflow_id: workflowId || null,
      ts,
      type,
      event_type: type,
      payload,
    };
  }

  function readJournal(workflowId) {
    if (!workflowId || typeof workflowId !== 'string') {
      throw new Error('readJournal requires a workflow id');
    }

    return db.prepare(`
      SELECT id, task_id, workflow_id, ts, type, actor, payload_json, event_type, event_data, created_at
      FROM task_events
      WHERE workflow_id = ?
      ORDER BY ts ASC, id ASC
    `).all(workflowId).map((row) => ({
      ...row,
      payload: safeParse(row.payload_json) || safeParse(row.event_data),
    }));
  }

  return { write, readJournal };
}

module.exports = { VALID_EVENT_TYPES, createJournalWriter };
