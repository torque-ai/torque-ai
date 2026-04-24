'use strict';

const { randomUUID } = require('crypto');

function safeParse(serialized) {
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function createActivityStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createActivityStore requires a database handle');
  }

  function create({ workflowId, taskId, kind, name, input, options }) {
    const id = `act_${randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO activities (activity_id, workflow_id, task_id, kind, name, input_json,
        max_attempts, start_to_close_timeout_ms, heartbeat_timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workflowId || null,
      taskId || null,
      kind,
      name,
      input === undefined ? null : JSON.stringify(input),
      options?.max_attempts || 1,
      options?.start_to_close_timeout_ms || null,
      options?.heartbeat_timeout_ms || null,
    );
    return id;
  }

  function markRunning(id) {
    db.prepare(`
      UPDATE activities SET status = 'running', attempt = attempt + 1, started_at = datetime('now')
      WHERE activity_id = ?
    `).run(id);
  }

  function heartbeat(id) {
    db.prepare(`
      UPDATE activities SET last_heartbeat_at = datetime('now') WHERE activity_id = ?
    `).run(id);
  }

  function complete(id, result) {
    db.prepare(`
      UPDATE activities SET status = 'completed', result_json = ?, completed_at = datetime('now')
      WHERE activity_id = ?
    `).run(result === undefined ? null : JSON.stringify(result), id);
  }

  function fail(id, errorText, finalStatus = 'failed') {
    db.prepare(`
      UPDATE activities SET status = ?, error_text = ?, completed_at = datetime('now')
      WHERE activity_id = ?
    `).run(finalStatus, errorText, id);
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM activities WHERE activity_id = ?').get(id);
    if (!row) {
      return null;
    }

    return {
      ...row,
      input: row.input_json ? safeParse(row.input_json) : null,
      result: row.result_json ? safeParse(row.result_json) : null,
    };
  }

  function listStale({ heartbeatGraceMs = 0 } = {}) {
    return db.prepare(`
      SELECT activity_id FROM activities
      WHERE status = 'running'
        AND heartbeat_timeout_ms IS NOT NULL
        AND (julianday('now') - julianday(COALESCE(last_heartbeat_at, started_at))) * 86400000 > heartbeat_timeout_ms + ?
    `).all(heartbeatGraceMs).map((row) => row.activity_id);
  }

  return { create, markRunning, heartbeat, complete, fail, get, listStale };
}

module.exports = { createActivityStore };
