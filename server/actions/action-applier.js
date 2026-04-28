'use strict';

const { randomUUID } = require('crypto');

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function') return db;
  if (db && typeof db.getDbInstance === 'function') return db.getDbInstance();
  throw new TypeError('createActionApplier requires a better-sqlite3 database handle');
}

function createActionApplier({ db, sinks, logger = console }) {
  const conn = resolveDbHandle(db);

  async function apply({ taskId, workflowId = null, action }) {
    const sink = sinks?.[action?.type];
    if (!sink) throw new Error(`Unknown action type: ${action?.type}`);

    const attrs = { ...action };
    const content = action.content;
    delete attrs.content;
    delete attrs.type;

    let result;
    try {
      result = await sink({ attrs, content });
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`Action sink failed for ${action.type}: ${err.message}`);
      }
      throw err;
    }

    const insertAppliedAction = conn.transaction(() => {
      const seq = conn.prepare(`
        SELECT COALESCE(MAX(seq), 0) + 1 AS n
        FROM applied_actions
        WHERE task_id = ?
      `).get(taskId).n;
      const id = `a_${randomUUID().slice(0, 12)}`;
      const payloadJson = JSON.stringify({ attrs, content });
      const resultJson = result === undefined ? null : JSON.stringify(result);

      conn.prepare(`
        INSERT INTO applied_actions (
          action_id,
          task_id,
          workflow_id,
          seq,
          action_type,
          payload_json,
          result_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, taskId, workflowId, seq, action.type, payloadJson, resultJson);

      return { id, seq };
    });

    const { id, seq } = insertAppliedAction();
    return { ok: true, action_id: id, seq, ...result };
  }

  return { apply };
}

module.exports = { createActionApplier };
