'use strict';

const { randomUUID } = require('crypto');
const { safeJsonParse } = require('../utils/json');

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('workflow checkpoint store requires a database handle');
}

function normalizeRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}

function normalizeOptionalString(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeVersion(version) {
  if (version === undefined || version === null || version === '') {
    return 1;
  }

  const normalized = Number(version);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error('version must be a positive integer');
  }

  return normalized;
}

function serializeState(state) {
  const normalizedState = state === undefined || state === null ? {} : state;

  try {
    const serialized = JSON.stringify(normalizedState);
    if (serialized === undefined) {
      throw new Error('state must be JSON-serializable');
    }
    return serialized;
  } catch {
    throw new Error('state must be JSON-serializable');
  }
}

function createCheckpointStore({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function writeCheckpoint({ workflowId, stepId = null, taskId = null, state, version } = {}) {
    const id = `cp_${randomUUID().slice(0, 12)}`;
    const takenAt = new Date().toISOString();

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
      normalizeRequiredString(workflowId, 'workflowId'),
      normalizeOptionalString(stepId, 'stepId'),
      normalizeOptionalString(taskId, 'taskId'),
      serializeState(state),
      normalizeVersion(version),
      takenAt,
    );

    return id;
  }

  function listCheckpoints(workflowId) {
    return dbHandle.prepare(`
      SELECT checkpoint_id, workflow_id, step_id, task_id, state_version, taken_at
      FROM workflow_checkpoints
      WHERE workflow_id = ?
      ORDER BY taken_at ASC, rowid ASC
    `).all(normalizeRequiredString(workflowId, 'workflowId'));
  }

  function getCheckpoint(checkpointId) {
    const row = dbHandle.prepare(`
      SELECT *
      FROM workflow_checkpoints
      WHERE checkpoint_id = ?
    `).get(normalizeRequiredString(checkpointId, 'checkpointId'));

    if (!row) {
      return null;
    }

    return {
      ...row,
      state: safeJsonParse(row.state_json, {}),
    };
  }

  return {
    writeCheckpoint,
    listCheckpoints,
    getCheckpoint,
  };
}

module.exports = { createCheckpointStore };
