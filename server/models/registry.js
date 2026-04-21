'use strict';

const { randomUUID } = require('crypto');
const eventBus = require('../event-bus');
const { classifyModel } = require('../discovery/family-classifier');

let db = null;

function setDb(dbInstance) {
  db = resolveDbHandle(dbInstance);
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
    throw new Error('Model registry database handle not set');
  }
  return instance;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRequiredString(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSizeBytes(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

function normalizeModelDescriptor(input, provider, hostId) {
  if (typeof input === 'string') {
    return {
      provider,
      hostId,
      modelName: normalizeRequiredString('modelName', input),
      sizeBytes: null,
    };
  }

  if (!input || typeof input !== 'object') {
    throw new Error('discovered model must be a string or object');
  }

  const modelName = input.modelName
    || input.model_name
    || input.name
    || input.id
    || input.model;
  const sizeBytes = input.sizeBytes
    ?? input.size_bytes
    ?? input.size
    ?? input.bytes;

  return {
    provider,
    hostId,
    modelName: normalizeRequiredString('modelName', modelName),
    sizeBytes: normalizeSizeBytes(sizeBytes),
  };
}

function appendExactHostClause(parts, values, hostId) {
  if (hostId === null) {
    parts.push('host_id IS NULL');
    return;
  }

  parts.push('host_id = ?');
  values.push(hostId);
}

function appendOptionalHostClause(parts, values, hostId) {
  if (hostId === undefined) return;
  appendExactHostClause(parts, values, hostId);
}

function getModelById(id) {
  return getDb().prepare('SELECT * FROM model_registry WHERE id = ?').get(id) || null;
}

function findModel(provider, modelName, hostId) {
  const values = [provider, modelName];
  const where = ['provider = ?', 'model_name = ?'];
  appendExactHostClause(where, values, hostId);

  return getDb().prepare(`
    SELECT *
    FROM model_registry
    WHERE ${where.join(' AND ')}
    LIMIT 1
  `).get(...values) || null;
}

function updateModelLastSeen(id, lastSeenAt, sizeBytes) {
  getDb().prepare(`
    UPDATE model_registry
    SET last_seen_at = ?,
        size_bytes = COALESCE(?, size_bytes)
    WHERE id = ?
  `).run(lastSeenAt, sizeBytes, id);

  const row = getModelById(id);

  // Backfill family + parameter_size_b for pre-migration rows where they are NULL
  if (row && row.family === null) {
    const { family, parameterSizeB } = classifyModel(row.model_name, { sizeBytes: row.size_bytes });
    getDb().prepare(`
      UPDATE model_registry
      SET family = ?,
          parameter_size_b = ?
      WHERE id = ?
    `).run(family, parameterSizeB, id);
    return getModelById(id);
  }

  return row;
}

function registerModelInternal({ provider, hostId, modelName, sizeBytes }) {
  const database = getDb();
  const now = nowIso();
  const existing = findModel(provider, modelName, hostId);

  if (existing) {
    return {
      inserted: false,
      model: updateModelLastSeen(existing.id, now, sizeBytes),
    };
  }

  const id = randomUUID();
  const insertResult = database.prepare(`
    INSERT OR IGNORE INTO model_registry (
      id,
      provider,
      host_id,
      model_name,
      size_bytes,
      status,
      first_seen_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, provider, hostId, modelName, sizeBytes, now, now);

  if (insertResult.changes > 0) {
    const { family, parameterSizeB } = classifyModel(modelName, { sizeBytes });
    database.prepare(`
      UPDATE model_registry
      SET family = ?,
          parameter_size_b = ?
      WHERE id = ?
    `).run(family, parameterSizeB, id);
    return {
      inserted: true,
      model: getModelById(id),
    };
  }

  const row = findModel(provider, modelName, hostId);
  return {
    inserted: false,
    model: row ? updateModelLastSeen(row.id, now, sizeBytes) : null,
  };
}

function emitIfNew(result) {
  if (result && result.inserted && result.model) {
    eventBus.emitModelDiscovered(result.model);
  }
  return result;
}

function registerModel({ provider, hostId, modelName, sizeBytes }) {
  const normalizedProvider = normalizeRequiredString('provider', provider);
  const normalizedHostId = normalizeOptionalString(hostId);
  const normalizedModelName = normalizeRequiredString('modelName', modelName);
  const normalizedSizeBytes = normalizeSizeBytes(sizeBytes);

  return emitIfNew(registerModelInternal({
    provider: normalizedProvider,
    hostId: normalizedHostId,
    modelName: normalizedModelName,
    sizeBytes: normalizedSizeBytes,
  }));
}

function updateStatus(provider, modelName, hostId, status, extraAssignments = '', extraValues = []) {
  const values = [status, ...extraValues, provider, modelName];
  const where = ['provider = ?', 'model_name = ?'];
  appendOptionalHostClause(where, values, hostId);

  const sql = `
    UPDATE model_registry
    SET status = ?
        ${extraAssignments}
    WHERE ${where.join(' AND ')}
  `;

  return getDb().prepare(sql).run(...values).changes;
}

function approveModel(provider, modelName, hostId) {
  return updateStatus(
    normalizeRequiredString('provider', provider),
    normalizeRequiredString('modelName', modelName),
    hostId === undefined ? undefined : normalizeOptionalString(hostId),
    'approved',
    `,
        approved_at = ?,
        approved_by = ?`,
    [nowIso(), 'user'],
  );
}

function denyModel(provider, modelName, hostId) {
  return updateStatus(
    normalizeRequiredString('provider', provider),
    normalizeRequiredString('modelName', modelName),
    hostId === undefined ? undefined : normalizeOptionalString(hostId),
    'denied',
    `,
        approved_at = NULL,
        approved_by = NULL`,
  );
}

function bulkApproveByProvider(provider) {
  return getDb().prepare(`
    UPDATE model_registry
    SET status = 'approved',
        approved_at = ?,
        approved_by = 'user'
    WHERE provider = ?
      AND status = 'pending'
  `).run(nowIso(), normalizeRequiredString('provider', provider)).changes;
}

function markModelRemoved(provider, modelName, hostId) {
  return updateStatus(
    normalizeRequiredString('provider', provider),
    normalizeRequiredString('modelName', modelName),
    hostId === undefined ? undefined : normalizeOptionalString(hostId),
    'removed',
  );
}

function listModels(filters = {}) {
  const database = getDb();
  const values = [];
  const where = [];
  const hostFilter = Object.prototype.hasOwnProperty.call(filters, 'host_id')
    ? filters.host_id
    : filters.hostId;

  if (filters.status) {
    where.push('status = ?');
    values.push(filters.status);
  }

  if (filters.provider) {
    where.push('provider = ?');
    values.push(filters.provider);
  }

  appendOptionalHostClause(where, values, hostFilter);

  const sql = [
    'SELECT * FROM model_registry',
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    'ORDER BY provider ASC, COALESCE(host_id, \'\') ASC, model_name ASC',
  ].filter(Boolean).join(' ');

  return database.prepare(sql).all(...values);
}

function listModelSummaries(filters = {}) {
  const provider = filters?.provider;
  const params = [];

  let sql = `
    SELECT r.model_name, r.provider, r.family, r.parameter_size_b, r.status,
           r.last_seen_at, r.probe_status,
           c.cap_hashline, c.cap_agentic, c.cap_file_creation, c.cap_multi_file,
           mr.role
    FROM model_registry r
    LEFT JOIN model_capabilities c ON r.model_name = c.model_name
    LEFT JOIN model_roles mr ON r.provider = mr.provider AND r.model_name = mr.model_name
  `;

  if (provider) {
    sql += ' WHERE r.provider = ?';
    params.push(provider);
  }

  sql += ' ORDER BY r.provider, r.parameter_size_b DESC';

  return getDb().prepare(sql).all(...params);
}

function assignModelRole(provider, role, modelName) {
  getDb().prepare(`
    INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(provider, role, modelName);
}

function listPendingModels() {
  return listModels({ status: 'pending' });
}

function getApprovedModels(provider, hostId) {
  const values = [
    normalizeRequiredString('provider', provider),
    'approved',
  ];
  const where = ['provider = ?', 'status = ?'];
  appendOptionalHostClause(where, values, hostId === undefined ? undefined : normalizeOptionalString(hostId));

  return getDb().prepare(`
    SELECT *
    FROM model_registry
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(last_seen_at, first_seen_at, '') DESC, model_name ASC
  `).all(...values);
}

function hasTable(tableName) {
  return Boolean(
    getDb().prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `).get(tableName),
  );
}

function averageCapabilityScore(row) {
  const scores = [
    row.score_code_gen,
    row.score_refactoring,
    row.score_testing,
    row.score_reasoning,
    row.score_docs,
  ].map((value) => Number.isFinite(Number(value)) ? Number(value) : 0.5);

  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function rankApprovedModel(row, complexity) {
  const quality = averageCapabilityScore(row);
  const sizeB = Number(row.param_size_b) || 0;
  const normalizedSize = Math.max(0, Math.min(sizeB, 70)) / 70;

  if (complexity === 'simple') {
    return (quality * 0.8) + ((1 - normalizedSize) * 0.2);
  }

  if (complexity === 'complex') {
    return (quality * 0.7) + (normalizedSize * 0.3);
  }

  return (quality * 0.85) + (normalizedSize * 0.15);
}

function selectBestApprovedModel(provider, complexity) {
  const normalizedProvider = normalizeRequiredString('provider', provider);
  const database = getDb();

  if (!hasTable('model_capabilities')) {
    return database.prepare(`
      SELECT model_name, host_id, provider
      FROM model_registry
      WHERE status = 'approved'
        AND provider = ?
      ORDER BY COALESCE(last_seen_at, first_seen_at, '') DESC, model_name ASC
      LIMIT 1
    `).get(normalizedProvider) || null;
  }

  const rows = database.prepare(`
    SELECT
      mr.model_name,
      mr.host_id,
      mr.provider,
      mr.first_seen_at,
      mr.last_seen_at,
      mc.score_code_gen,
      mc.score_refactoring,
      mc.score_testing,
      mc.score_reasoning,
      mc.score_docs,
      mc.param_size_b
    FROM model_registry mr
    LEFT JOIN model_capabilities mc
      ON mc.model_name = mr.model_name
    WHERE mr.status = 'approved'
      AND mr.provider = ?
    ORDER BY COALESCE(mr.last_seen_at, mr.first_seen_at, '') DESC, mr.model_name ASC
  `).all(normalizedProvider);

  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const scoreDiff = rankApprovedModel(b, complexity) - rankApprovedModel(a, complexity);
    if (scoreDiff !== 0) return scoreDiff;

    const lastSeenA = a.last_seen_at || a.first_seen_at || '';
    const lastSeenB = b.last_seen_at || b.first_seen_at || '';
    if (lastSeenA !== lastSeenB) return lastSeenB.localeCompare(lastSeenA);

    const nameCompare = a.model_name.localeCompare(b.model_name);
    if (nameCompare !== 0) return nameCompare;

    return (a.host_id || '').localeCompare(b.host_id || '');
  });

  return {
    model_name: rows[0].model_name,
    host_id: rows[0].host_id,
    provider: rows[0].provider,
  };
}

function rerouteQueuedTasksForRemovedModel(provider, removedModelName) {
  const database = getDb();
  const queuedTasks = database.prepare(`
    SELECT id, complexity
    FROM tasks
    WHERE status = 'queued'
      AND provider = ?
      AND model = ?
  `).all(provider, removedModelName);

  for (const task of queuedTasks) {
    const fallback = selectBestApprovedModel(provider, task.complexity || 'normal');
    if (!fallback || fallback.model_name === removedModelName) {
      continue;
    }

    database.prepare(`
      UPDATE tasks
      SET model = ?
      WHERE id = ?
        AND status = 'queued'
        AND provider = ?
        AND model = ?
    `).run(fallback.model_name, task.id, provider, removedModelName);
  }
}

function syncModelsFromHealthCheck(provider, hostId, discoveredModels) {
  const normalizedProvider = normalizeRequiredString('provider', provider);
  const normalizedHostId = normalizeOptionalString(hostId);
  const models = Array.isArray(discoveredModels) ? discoveredModels : [];
  const seenNames = new Set();

  const result = getDb().transaction(() => {
    const summary = {
      new: [],
      updated: [],
      removed: [],
    };

    for (const item of models) {
      const normalized = normalizeModelDescriptor(item, normalizedProvider, normalizedHostId);
      if (seenNames.has(normalized.modelName)) {
        continue;
      }

      seenNames.add(normalized.modelName);
      const registration = registerModelInternal(normalized);

      if (!registration.model) continue;
      if (registration.inserted) summary.new.push(registration.model);
      else summary.updated.push(registration.model);
    }

    for (const approved of getApprovedModels(normalizedProvider, normalizedHostId)) {
      if (seenNames.has(approved.model_name)) {
        continue;
      }

      const changes = markModelRemoved(normalizedProvider, approved.model_name, approved.host_id);
      if (changes > 0) {
        const removed = findModel(normalizedProvider, approved.model_name, approved.host_id);
        if (removed) summary.removed.push(removed);
        rerouteQueuedTasksForRemovedModel(normalizedProvider, approved.model_name);
      }
    }

    return summary;
  })();

  for (const model of result.new) {
    eventBus.emitModelDiscovered(model);
  }

  for (const model of result.removed) {
    eventBus.emitModelRemoved(model);
  }

  return result;
}

function getModelCount(provider) {
  const values = [];
  const where = [];

  if (provider) {
    where.push('provider = ?');
    values.push(normalizeRequiredString('provider', provider));
  }

  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied,
      SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed
    FROM model_registry
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
  `).get(...values);

  return {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    approved: Number(row?.approved || 0),
    denied: Number(row?.denied || 0),
    removed: Number(row?.removed || 0),
  };
}

module.exports = {
  setDb,
  registerModel,
  updateModelLastSeen,
  approveModel,
  denyModel,
  bulkApproveByProvider,
  markModelRemoved,
  listModels,
  listModelSummaries,
  listPendingModels,
  getApprovedModels,
  assignModelRole,
  selectBestApprovedModel,
  syncModelsFromHealthCheck,
  getModelCount,
};
