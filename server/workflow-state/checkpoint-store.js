'use strict';

const { randomUUID } = require('crypto');

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('workflow checkpoint store requires a database handle');
}

function createCheckpointStore({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function writeCheckpoint({ workflowId, stepId = null, taskId = null, state, version }) {
    const id = `cp_${randomUUID().slice(0, 12)}`;

    dbHandle.prepare(`
      INSERT INTO workflow_checkpoints (
        checkpoint_id,
        workflow_id,
        step_id,
        task_id,
        state_json,
        state_version,
        taken_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workflowId,
      stepId,
      taskId,
      JSON.stringify(state || {}),
      version || 1,
      new Date().toISOString(),
    );

    return id;
  }

  function listCheckpoints(workflowId) {
    return dbHandle.prepare(`
      SELECT checkpoint_id, workflow_id, step_id, task_id, state_version, taken_at
      FROM workflow_checkpoints
      WHERE workflow_id = ?
      ORDER BY taken_at ASC, rowid ASC
    `).all(workflowId);
  }

  function getCheckpoint(checkpointId) {
    const row = dbHandle.prepare(`
      SELECT *
      FROM workflow_checkpoints
      WHERE checkpoint_id = ?
    `).get(checkpointId);

    if (!row) {
      return null;
    }

    return {
      ...row,
      state: JSON.parse(row.state_json),
    };
  }

  return {
    writeCheckpoint,
    listCheckpoints,
    getCheckpoint,
  };
}

module.exports = { createCheckpointStore };
