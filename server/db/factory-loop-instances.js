'use strict';

const { randomUUID } = require('crypto');
const { isValidState } = require('../factory/loop-states');

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function resolveDbHandle(candidate) {
  if (!candidate) {
    return null;
  }
  if (typeof candidate.prepare === 'function') {
    return candidate;
  }
  if (typeof candidate.getDbInstance === 'function') {
    return candidate.getDbInstance();
  }
  if (typeof candidate.getDb === 'function') {
    return candidate.getDb();
  }
  return null;
}

function getDb() {
  let instance = resolveDbHandle(db);
  if (!instance) {
    try {
      const { defaultContainer } = require('../container');
      if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('db')) {
        instance = resolveDbHandle(defaultContainer.get('db'));
      }
    } catch {
      // Fall through to the database.js fallback below.
    }
  }
  if (!instance) {
    try {
      const database = require('../database');
      instance = resolveDbHandle(database);
    } catch {
      // Let the explicit error below surface if no active DB is available.
    }
  }

  if (instance) {
    db = instance;
  }
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('Factory loop instances requires an active database connection');
  }
  return instance;
}

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function normalizeLoopState(loopState) {
  const normalized = requireText(loopState, 'loop_state').toUpperCase();
  if (!isValidState(normalized)) {
    throw new Error(`Invalid loop_state: ${loopState}`);
  }
  return normalized;
}

function normalizeOptionalText(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return requireText(value, 'value');
}

function normalizeOptionalInteger(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return numeric;
}

function parseInstance(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    batchId: row.batch_id,
    loopState: row.loop_state,
    pausedAtStage: row.paused_at_stage,
    lastActionAt: row.last_action_at,
    createdAt: row.created_at,
    terminatedAt: row.terminated_at,
  };
}

function isStageOccupancyConflict(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return Boolean(
    error
    && (
      message.includes('idx_factory_loop_instances_stage_occupancy')
      || message.includes('UNIQUE constraint failed: factory_loop_instances.project_id, factory_loop_instances.loop_state')
    )
  );
}

function createFactoryLoopInstances({ db: dbInstance }) {
  setDb(dbInstance);
  return {
    createInstance,
    getInstance,
    listInstances,
    listByStage,
    updateInstance,
    terminateInstance,
    getStageOccupant,
    claimStageForInstance,
  };
}

function createInstance({ project_id, work_item_id, batch_id }) {
  const now = new Date().toISOString();
  const id = randomUUID();

  try {
    getDb().prepare(`
      INSERT INTO factory_loop_instances (
        id,
        project_id,
        work_item_id,
        batch_id,
        loop_state,
        last_action_at,
        created_at
      )
      VALUES (?, ?, ?, ?, 'SENSE', ?, ?)
    `).run(
      id,
      requireText(project_id, 'project_id'),
      normalizeOptionalInteger(work_item_id, 'work_item_id'),
      normalizeOptionalText(batch_id),
      now,
      now,
    );
  } catch (error) {
    if (isStageOccupancyConflict(error)) {
      const occupiedError = new Error(`Stage SENSE is already occupied for project ${project_id}`);
      occupiedError.code = 'FACTORY_STAGE_OCCUPIED';
      occupiedError.project_id = project_id;
      occupiedError.stage = 'SENSE';
      throw occupiedError;
    }
    throw error;
  }

  return getInstance(id);
}

function getInstance(id) {
  const row = getDb().prepare('SELECT * FROM factory_loop_instances WHERE id = ?').get(requireText(id, 'id'));
  return parseInstance(row);
}

function listInstances({ project_id, active_only = false } = {}) {
  const params = [];
  const where = [];

  if (project_id !== undefined) {
    where.push('project_id = ?');
    params.push(requireText(project_id, 'project_id'));
  }
  if (active_only) {
    where.push('terminated_at IS NULL');
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb().prepare(`
    SELECT *
    FROM factory_loop_instances
    ${whereSql}
    ORDER BY created_at ASC, id ASC
  `).all(...params);
  return rows.map(parseInstance);
}

function listByStage({ project_id, loop_state }) {
  const rows = getDb().prepare(`
    SELECT *
    FROM factory_loop_instances
    WHERE project_id = ?
      AND loop_state = ?
      AND terminated_at IS NULL
    ORDER BY created_at ASC, id ASC
  `).all(
    requireText(project_id, 'project_id'),
    normalizeLoopState(loop_state),
  );
  return rows.map(parseInstance);
}

function updateInstance(id, updates) {
  const allowed = ['loop_state', 'paused_at_stage', 'last_action_at', 'batch_id', 'work_item_id'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates || {})) {
    if (!allowed.includes(key)) {
      continue;
    }
    sets.push(`${key} = ?`);
    if (key === 'loop_state') {
      params.push(normalizeLoopState(value));
      continue;
    }
    if (key === 'work_item_id') {
      params.push(normalizeOptionalInteger(value, 'work_item_id'));
      continue;
    }
    params.push(key === 'last_action_at' ? normalizeOptionalText(value) : normalizeOptionalText(value));
  }

  if (sets.length === 0) {
    return getInstance(id);
  }

  params.push(requireText(id, 'id'));
  getDb().prepare(`
    UPDATE factory_loop_instances
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getInstance(id);
}

function terminateInstance(id) {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE factory_loop_instances
    SET loop_state = 'IDLE',
        paused_at_stage = NULL,
        last_action_at = ?,
        terminated_at = ?
    WHERE id = ?
  `).run(now, now, requireText(id, 'id'));
  return getInstance(id);
}

function getStageOccupant(project_id, stage) {
  const row = getDb().prepare(`
    SELECT *
    FROM factory_loop_instances
    WHERE project_id = ?
      AND loop_state = ?
      AND terminated_at IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(requireText(project_id, 'project_id'), normalizeLoopState(stage));
  return parseInstance(row);
}

function claimStageForInstance(id, stage) {
  const sqliteDb = getDb();
  const targetStage = normalizeLoopState(stage);
  const now = new Date().toISOString();

  const tx = sqliteDb.transaction(() => {
    const current = sqliteDb.prepare(`
      SELECT *
      FROM factory_loop_instances
      WHERE id = ?
    `).get(requireText(id, 'id'));

    if (!current) {
      throw new Error(`Factory loop instance not found: ${id}`);
    }
    if (current.terminated_at) {
      throw new Error(`Factory loop instance is terminated: ${id}`);
    }
    if (current.loop_state === targetStage) {
      sqliteDb.prepare(`
        UPDATE factory_loop_instances
        SET paused_at_stage = NULL,
            last_action_at = ?
        WHERE id = ?
      `).run(now, id);
      return;
    }

    sqliteDb.prepare(`
      UPDATE factory_loop_instances
      SET loop_state = ?,
          paused_at_stage = NULL,
          last_action_at = ?
      WHERE id = ?
        AND terminated_at IS NULL
    `).run(targetStage, now, id);
  });

  try {
    tx();
  } catch (error) {
    if (isStageOccupancyConflict(error)) {
      const instance = getInstance(id);
      const occupiedError = new Error(`Stage ${targetStage} is already occupied for project ${instance?.project_id || 'unknown'}`);
      occupiedError.code = 'FACTORY_STAGE_OCCUPIED';
      occupiedError.instance_id = id;
      occupiedError.project_id = instance?.project_id || null;
      occupiedError.stage = targetStage;
      throw occupiedError;
    }
    throw error;
  }

  return getInstance(id);
}

module.exports = {
  createFactoryLoopInstances,
  setDb,
  resolveDbHandle,
  getDb,
  parseInstance,
  isStageOccupancyConflict,
  createInstance,
  getInstance,
  listInstances,
  listByStage,
  updateInstance,
  terminateInstance,
  getStageOccupant,
  claimStageForInstance,
};
