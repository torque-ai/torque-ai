'use strict';

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTimestampValue(value, fieldName, { required = false } = {}) {
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) {
      throw new Error(`${fieldName} is not a valid timestamp`);
    }
    return Math.trunc(millis);
  }

  if (typeof value === 'number') {
    const rounded = Math.trunc(value);
    if (!Number.isFinite(rounded)) {
      throw new Error(`${fieldName} is not a valid timestamp`);
    }
    return rounded;
  }

  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      if (required) {
        throw new Error(`${fieldName} is required`);
      }
      return null;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName} is not a valid timestamp`);
    }
    return parsed;
  }

  if (!required && (value === null || value === undefined)) return null;
  if (required) {
    throw new Error(`${fieldName} is required`);
  }
  return null;
}

function normalizePayload(value, fieldName, { defaultValue = null } = {}) {
  if (value === undefined) return defaultValue;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (defaultValue !== null) return defaultValue;
  throw new Error(`${fieldName} must be JSON-serializable`);
}

function parseJsonField(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function ensureTemporalGraphMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_graph_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(entity_type, entity_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_graph_fact_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_entity_type TEXT NOT NULL,
      subject_entity_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      object_entity_type TEXT,
      object_entity_id TEXT,
      value_json TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      invalidated_by_edge_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(invalidated_by_edge_id) REFERENCES temporal_graph_fact_edges(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_entities_type_id
    ON temporal_graph_entities(entity_type, entity_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_edges_subject
    ON temporal_graph_fact_edges(subject_entity_type, subject_entity_id, edge_type, valid_from, valid_to)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_edges_object
    ON temporal_graph_fact_edges(object_entity_type, object_entity_id, edge_type, valid_from, valid_to)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_edges_value
    ON temporal_graph_fact_edges(value_json, valid_from, valid_to)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_edges_valid_range
    ON temporal_graph_fact_edges(valid_from, valid_to)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tg_edges_invalidation
    ON temporal_graph_fact_edges(subject_entity_type, subject_entity_id, edge_type, object_entity_type, object_entity_id, value_json, valid_to)
  `);
}

function mapEntityRow(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJsonField(row.payload_json),
  };
}

function mapFactEdgeRow(row) {
  if (!row) return null;
  return {
    ...row,
    value: parseJsonField(row.value_json),
    payload: parseJsonField(row.payload_json),
  };
}

function buildEntityInput(record = {}) {
  return {
    entity_type: requireNonEmptyString(record.entity_type ?? record.entityType, 'entity_type'),
    entity_id: requireNonEmptyString(record.entity_id ?? record.entityId, 'entity_id'),
    payload_json: normalizePayload(record.payload ?? record.payload_json ?? record.payloadJson, 'payload', { defaultValue: '{}' }) || '{}',
  };
}

function buildFactEdgeInput(record = {}, nowValue, { requireNow = true } = {}) {
  const subjectEntityType = requireNonEmptyString(record.subject_entity_type ?? record.subjectEntityType, 'subject_entity_type');
  const subjectEntityId = requireNonEmptyString(record.subject_entity_id ?? record.subjectEntityId, 'subject_entity_id');
  const edgeType = requireNonEmptyString(record.edge_type ?? record.edgeType, 'edge_type');
  const objectEntityType = normalizeOptionalString(record.object_entity_type ?? record.objectEntityType);
  const objectEntityId = normalizeOptionalString(record.object_entity_id ?? record.objectEntityId);
  if ((objectEntityType === null) !== (objectEntityId === null)) {
    throw new Error('object_entity_type and object_entity_id must both be set together');
  }

  const validFrom = normalizeTimestampValue(record.valid_from ?? record.validFrom, 'valid_from', { required: true });
  const validTo = normalizeTimestampValue(record.valid_to ?? record.validTo, 'valid_to');
  if (validTo !== null && validTo < validFrom) {
    throw new Error('valid_to must be greater than or equal to valid_from');
  }

  const payloadJson = normalizePayload(record.payload ?? record.payload_json ?? record.payloadJson, 'payload', { defaultValue: '{}' }) || '{}';
  const valueJson = normalizePayload(
    record.value ?? record.value_json ?? record.valueJson,
    'value',
  );

  const createdAt = normalizeTimestampValue(
    record.created_at ?? record.createdAt ?? nowValue,
    'created_at',
    { required: !Number.isFinite(nowValue) || requireNow ? true : false },
  );

  return {
    subject_entity_type: subjectEntityType,
    subject_entity_id: subjectEntityId,
    edge_type: edgeType,
    object_entity_type: objectEntityType,
    object_entity_id: objectEntityId,
    value_json: valueJson,
    payload_json: payloadJson,
    valid_from: validFrom,
    valid_to: validTo,
    invalidated_by_edge_id: record.invalidated_by_edge_id ?? record.invalidatedByEdgeId ?? null,
    created_at: createdAt,
  };
}

function createTemporalGraphMemoryStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('db with prepare() is required');
  }
  if (typeof now !== 'function') {
    throw new Error('now must be a function');
  }

  ensureTemporalGraphMemorySchema(db);

  const entityPayload = db.prepare(`
    INSERT INTO temporal_graph_entities (entity_type, entity_id, payload_json, created_at, updated_at)
    VALUES (@entity_type, @entity_id, @payload_json, @timestamp, @timestamp)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const getEntity = db.prepare(`
    SELECT *
    FROM temporal_graph_entities
    WHERE entity_type = ? AND entity_id = ?
    LIMIT 1
  `);

  const insertFactEdge = db.prepare(`
    INSERT INTO temporal_graph_fact_edges (
      subject_entity_type, subject_entity_id, edge_type, object_entity_type, object_entity_id,
      value_json, payload_json, valid_from, valid_to, invalidated_by_edge_id, created_at
    )
    VALUES (
      @subject_entity_type, @subject_entity_id, @edge_type, @object_entity_type, @object_entity_id,
      @value_json, @payload_json, @valid_from, @valid_to, @invalidated_by_edge_id, @created_at
    )
  `);

  const invalidateConflictingFactEdges = db.prepare(`
    UPDATE temporal_graph_fact_edges
    SET valid_to = @valid_to,
        invalidated_by_edge_id = @new_edge_id
    WHERE id != @new_edge_id
      AND subject_entity_type = @subject_entity_type
      AND subject_entity_id = @subject_entity_id
      AND edge_type = @edge_type
      AND COALESCE(object_entity_type, '') = COALESCE(@object_entity_type, '')
      AND COALESCE(object_entity_id, '') = COALESCE(@object_entity_id, '')
      AND COALESCE(value_json, '') = COALESCE(@value_json, '')
      AND valid_from <= @valid_from
      AND (valid_to IS NULL OR valid_to > @valid_from)
  `);

  const getFactEdgeById = db.prepare(`
    SELECT *
    FROM temporal_graph_fact_edges
    WHERE id = ?
    LIMIT 1
  `);

  const readActiveFactEdgesAt = db.prepare(`
    SELECT *
    FROM temporal_graph_fact_edges
    WHERE valid_from <= ?
      AND (valid_to IS NULL OR valid_to > ?)
      AND (? IS NULL OR subject_entity_type = ?)
      AND (? IS NULL OR subject_entity_id = ?)
      AND (? IS NULL OR edge_type = ?)
      AND (? IS NULL OR object_entity_type = ?)
      AND (? IS NULL OR object_entity_id = ?)
      AND (? IS NULL OR value_json = ?)
    ORDER BY created_at ASC, id ASC
  `);

  function normalizeNowTimestamp() {
    return normalizeTimestampValue(now(), 'now', { required: true });
  }

  function requireEntityExists(entityType, entityId) {
    const entity = getEntity.get(entityType, entityId);
    if (!entity) {
      throw new Error(`missing entity ${entityType}:${entityId}`);
    }
    return entity;
  }

  const upsertEntityTxn = db.transaction((record) => {
    const payload = buildEntityInput(record);
    const timestamp = normalizeNowTimestamp();
    entityPayload.run({
      ...payload,
      timestamp,
    });
    return mapEntityRow(getEntity.get(payload.entity_type, payload.entity_id));
  });

  const insertFactEdgeTxn = db.transaction((record) => {
    const nowTimestamp = normalizeNowTimestamp();
    const edge = buildFactEdgeInput(record, nowTimestamp);

    requireEntityExists(edge.subject_entity_type, edge.subject_entity_id);
    if (edge.object_entity_type !== null && edge.object_entity_id !== null) {
      requireEntityExists(edge.object_entity_type, edge.object_entity_id);
    }

    const inserted = insertFactEdge.run(edge);
    const newEdgeId = Number(inserted.lastInsertRowid);
    invalidateConflictingFactEdges.run({
      ...edge,
      new_edge_id: newEdgeId,
      valid_to: edge.valid_from,
    });
    return mapFactEdgeRow(getFactEdgeById.get(newEdgeId));
  });

  return {
    upsertEntity(entity) {
      return upsertEntityTxn(entity);
    },
    getEntity({ entity_type, entityType, entity_id, entityId }) {
      return mapEntityRow(getEntity.get(
        requireNonEmptyString(entity_type ?? entityType, 'entity_type'),
        requireNonEmptyString(entity_id ?? entityId, 'entity_id'),
      )) || null;
    },
    insertFactEdge(edge) {
      return insertFactEdgeTxn(edge);
    },
    invalidateConflictingFactEdges(edge) {
      const nowTimestamp = normalizeNowTimestamp();
      const normalized = buildFactEdgeInput(edge, nowTimestamp);
      requireEntityExists(normalized.subject_entity_type, normalized.subject_entity_id);
      if (normalized.object_entity_type !== null && normalized.object_entity_id !== null) {
        requireEntityExists(normalized.object_entity_type, normalized.object_entity_id);
      }
      return invalidateConflictingFactEdges.run(normalized).changes;
    },
    readFactEdgesAt({
      timestamp,
      subject_entity_type: subjectEntityType,
      subject_entity_id: subjectEntityId,
      edge_type: edgeType,
      object_entity_type: objectEntityType,
      object_entity_id: objectEntityId,
      value,
    }) {
      const pointInTime = normalizeTimestampValue(timestamp, 'timestamp', { required: true });
      const normalizedValue = value === undefined ? null : normalizePayload(value, 'value');
      const rows = readActiveFactEdgesAt.all(
        pointInTime,
        pointInTime,
        subjectEntityType ?? null,
        subjectEntityType ?? null,
        subjectEntityId ?? null,
        subjectEntityId ?? null,
        edgeType ?? null,
        edgeType ?? null,
        objectEntityType ?? null,
        objectEntityType ?? null,
        objectEntityId ?? null,
        objectEntityId ?? null,
        normalizedValue,
        normalizedValue,
      );
      return rows.map(mapFactEdgeRow);
    },
  };
}

module.exports = { createTemporalGraphMemoryStore, ensureTemporalGraphMemorySchema };
