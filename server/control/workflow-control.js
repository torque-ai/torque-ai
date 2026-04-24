'use strict';

const Ajv = require('ajv');
const { resolveHandler } = require('./handler-resolver');
const { reduceField } = require('../workflow-state/reducers');
const { safeJsonParse } = require('../utils/json');

const ajv = new Ajv({ strict: false, allErrors: true });

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('workflow control requires a database handle');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneContainer(value) {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (isPlainObject(value)) {
    return { ...value };
  }
  return {};
}

function formatValidationErrors(errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || error.dataPath || error.schemaPath || '';
    return `${location}: ${error.message}`;
  });
}

function getPath(obj, path) {
  if (!path) return obj;

  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setPath(obj, path, value) {
  if (!path) return value;

  const parts = path.split('.');
  const root = cloneContainer(obj);
  let current = root;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    current[part] = cloneContainer(current[part]);
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
  return root;
}

function createWorkflowControl({ db, workflowState, journal } = {}) {
  const dbHandle = resolveDbHandle(db);

  if (!workflowState || typeof workflowState.getState !== 'function' || typeof workflowState.getMeta !== 'function') {
    throw new Error('workflow control requires workflowState getState/getMeta support');
  }
  if (!journal || typeof journal.write !== 'function') {
    throw new Error('workflow control requires journal.write support');
  }

  function loadHandlers(workflowId) {
    try {
      const row = dbHandle.prepare(`
        SELECT control_handlers_json
        FROM workflows
        WHERE id = ?
      `).get(workflowId);

      const parsed = safeJsonParse(row?.control_handlers_json, null) || {};
      return {
        queries: isPlainObject(parsed.queries) ? parsed.queries : {},
        signals: isPlainObject(parsed.signals) ? parsed.signals : {},
        updates: isPlainObject(parsed.updates) ? parsed.updates : {},
      };
    } catch {
      return {
        queries: {},
        signals: {},
        updates: {},
      };
    }
  }

  function persistState(workflowId, nextState) {
    const createdAt = new Date().toISOString();
    dbHandle.prepare(`
      INSERT OR IGNORE INTO workflow_state (workflow_id, state_json, version, updated_at)
      VALUES (?, '{}', 1, ?)
    `).run(workflowId, createdAt);

    let serializedState;
    try {
      serializedState = JSON.stringify(nextState);
    } catch {
      return {
        ok: false,
        errors: ['state: must be JSON-serializable'],
      };
    }

    dbHandle.prepare(`
      UPDATE workflow_state
      SET state_json = ?, version = version + 1, updated_at = ?
      WHERE workflow_id = ?
    `).run(serializedState, createdAt, workflowId);

    const versionRow = dbHandle.prepare(`
      SELECT version
      FROM workflow_state
      WHERE workflow_id = ?
    `).get(workflowId);

    return {
      ok: true,
      state: nextState,
      version: Number(versionRow?.version || 1),
    };
  }

  function applyWrite(workflowId, resolved, value) {
    const currentState = workflowState.getState(workflowId);
    const meta = workflowState.getMeta(workflowId);
    const currentValue = getPath(currentState, resolved.statePath);
    const nextValue = reduceField(resolved.reducer, currentValue, value);
    const nextState = setPath(currentState, resolved.statePath, nextValue);

    if (meta.schema) {
      const validate = ajv.compile(meta.schema);
      if (!validate(nextState)) {
        return {
          ok: false,
          errors: formatValidationErrors(validate.errors || []),
        };
      }
    }

    return persistState(workflowId, nextState);
  }

  function query(workflowId, name) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.queries[name];
    if (!spec) {
      return { ok: false, error: `Query '${name}' not registered for workflow ${workflowId}` };
    }

    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'query') {
      return { ok: false, error: `Query '${name}' has invalid handler spec '${spec}'` };
    }

    return {
      ok: true,
      value: getPath(workflowState.getState(workflowId), resolved.statePath),
    };
  }

  function signal(workflowId, name, value) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.signals[name];
    if (!spec) {
      return { ok: false, error: `Signal '${name}' not registered` };
    }

    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'write') {
      return { ok: false, error: `Signal '${name}' has invalid handler '${spec}'` };
    }

    const result = applyWrite(workflowId, resolved, value);
    journal.write({
      workflowId,
      type: 'signal_received',
      payload: {
        signal: name,
        spec,
        value,
        applied: result.ok,
        errors: result.errors,
      },
    });

    if (!result.ok) {
      return { ok: false, errors: result.errors };
    }

    return { ok: true };
  }

  async function update(workflowId, name, value) {
    const handlers = loadHandlers(workflowId);
    const spec = handlers.updates[name];
    if (!spec) {
      return { ok: false, error: `Update '${name}' not registered` };
    }

    const resolved = resolveHandler(spec);
    if (!resolved || resolved.kind !== 'write') {
      return { ok: false, error: `Update '${name}' has invalid handler '${spec}'` };
    }

    const result = applyWrite(workflowId, resolved, value);
    journal.write({
      workflowId,
      type: 'update_applied',
      payload: {
        update: name,
        spec,
        value,
        applied: result.ok,
        errors: result.errors,
      },
    });

    if (!result.ok) {
      return { ok: false, errors: result.errors };
    }

    return { ok: true, state: result.state };
  }

  return { query, signal, update };
}

module.exports = { createWorkflowControl };
