'use strict';

const Ajv = require('ajv');
const { reduceState } = require('./reducers');
const { safeJsonParse } = require('../utils/json');

const ajv = new Ajv({ strict: false, allErrors: true });

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('workflow state requires a database handle');
}

function normalizeWorkflowId(workflowId) {
  if (typeof workflowId !== 'string' || workflowId.trim().length === 0) {
    throw new Error('workflowId is required');
  }
  return workflowId.trim();
}

function ensureSchema(dbHandle) {
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS workflow_state (
      workflow_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL DEFAULT '{}',
      schema_json TEXT,
      reducers_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )
  `);
  dbHandle.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_state_updated
    ON workflow_state(updated_at)
  `);
}

function serializeJson(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    return serialized;
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

function isPatchObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createWorkflowState({ db } = {}) {
  const dbHandle = resolveDbHandle(db);
  ensureSchema(dbHandle);

  function ensureRow(workflowId) {
    const normalizedWorkflowId = normalizeWorkflowId(workflowId);
    dbHandle.prepare(`
      INSERT OR IGNORE INTO workflow_state (workflow_id, state_json, version, updated_at)
      VALUES (?, '{}', 1, ?)
    `).run(normalizedWorkflowId, new Date().toISOString());
    return normalizedWorkflowId;
  }

  function getState(workflowId) {
    const row = dbHandle.prepare(`
      SELECT state_json
      FROM workflow_state
      WHERE workflow_id = ?
    `).get(normalizeWorkflowId(workflowId));

    return row ? safeJsonParse(row.state_json, {}) : {};
  }

  function getMeta(workflowId) {
    const row = dbHandle.prepare(`
      SELECT schema_json, reducers_json, version, updated_at
      FROM workflow_state
      WHERE workflow_id = ?
    `).get(normalizeWorkflowId(workflowId));

    if (!row) {
      return {
        schema: null,
        reducers: {},
        version: 1,
        updated_at: null,
      };
    }

    return {
      schema: row.schema_json ? safeJsonParse(row.schema_json, null) : null,
      reducers: row.reducers_json ? safeJsonParse(row.reducers_json, {}) : {},
      version: Number.isInteger(Number(row.version)) ? Number(row.version) : 1,
      updated_at: row.updated_at || null,
    };
  }

  function setStateSchema(workflowId, schema = null, reducers = {}) {
    const normalizedWorkflowId = ensureRow(workflowId);

    dbHandle.prepare(`
      UPDATE workflow_state
      SET schema_json = ?, reducers_json = ?, updated_at = ?
      WHERE workflow_id = ?
    `).run(
      serializeJson(schema, 'schema'),
      serializeJson(reducers || {}, 'reducers'),
      new Date().toISOString(),
      normalizedWorkflowId,
    );
  }

  function applyPatch(workflowId, patch) {
    if (!isPatchObject(patch)) {
      throw new Error('patch must be an object');
    }

    const normalizedWorkflowId = ensureRow(workflowId);
    const meta = getMeta(normalizedWorkflowId);
    const currentState = getState(normalizedWorkflowId);
    const nextState = reduceState(currentState, patch, meta.reducers);

    if (meta.schema) {
      const validate = ajv.compile(meta.schema);
      const valid = validate(nextState);
      if (!valid) {
        return {
          ok: false,
          errors: (validate.errors || []).map((error) => {
            const location = error.instancePath || error.dataPath || error.schemaPath || '';
            return `${location}: ${error.message}`;
          }),
        };
      }
    }

    dbHandle.prepare(`
      UPDATE workflow_state
      SET state_json = ?, version = version + 1, updated_at = ?
      WHERE workflow_id = ?
    `).run(
      serializeJson(nextState, 'state'),
      new Date().toISOString(),
      normalizedWorkflowId,
    );

    return {
      ok: true,
      state: nextState,
      version: (meta.version || 1) + 1,
    };
  }

  return {
    getState,
    getMeta,
    setStateSchema,
    applyPatch,
  };
}

module.exports = { createWorkflowState };
