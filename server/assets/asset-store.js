'use strict';

const { randomUUID } = require('crypto');

const VALID_KINDS = new Set(['code', 'test', 'docs', 'bundle', 'report']);
const VALID_CHECK_SEVERITIES = new Set(['error', 'warn', 'info']);
let lastTimestampMs = 0;

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('asset store requires a database handle');
}

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalText(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function optionalKind(value) {
  const kind = optionalText(value, 'kind');
  if (kind !== null && !VALID_KINDS.has(kind)) {
    throw new Error(`kind must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
  return kind;
}

function serializeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be a plain object');
  }
  return JSON.stringify(metadata);
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function timestampIso() {
  const nextTimestampMs = Math.max(Date.now() + 1, lastTimestampMs + 1);
  lastTimestampMs = nextTimestampMs;
  return new Date(nextTimestampMs).toISOString();
}

function createAssetStore({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function declareAsset({
    assetKey,
    kind = null,
    description = null,
    partitionKey = null,
    metadata = null,
  }) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    const normalizedKind = optionalKind(kind);
    const normalizedDescription = optionalText(description, 'description');
    const normalizedPartitionKey = optionalText(partitionKey, 'partitionKey');
    const metadataJson = serializeMetadata(metadata);

    dbHandle.prepare(`
      INSERT INTO assets (asset_key, kind, description, partition_key, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_key) DO UPDATE SET
        kind = COALESCE(excluded.kind, kind),
        description = COALESCE(excluded.description, description),
        partition_key = COALESCE(excluded.partition_key, partition_key),
        metadata_json = COALESCE(excluded.metadata_json, metadata_json)
    `).run(
      normalizedAssetKey,
      normalizedKind,
      normalizedDescription,
      normalizedPartitionKey,
      metadataJson,
    );
  }

  function recordMaterialization({
    assetKey,
    taskId = null,
    workflowId = null,
    contentHash = null,
    metadata = null,
  }) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    declareAsset({ assetKey: normalizedAssetKey });

    const materializationId = id('mat');
    dbHandle.prepare(`
      INSERT INTO asset_materializations (
        materialization_id,
        asset_key,
        task_id,
        workflow_id,
        content_hash,
        metadata_json,
        produced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      materializationId,
      normalizedAssetKey,
      optionalText(taskId, 'taskId'),
      optionalText(workflowId, 'workflowId'),
      optionalText(contentHash, 'contentHash'),
      serializeMetadata(metadata),
      timestampIso(),
    );

    return materializationId;
  }

  function getLatestMaterialization(assetKey) {
    return dbHandle.prepare(`
      SELECT *
      FROM asset_materializations
      WHERE asset_key = ?
      ORDER BY julianday(produced_at) DESC, rowid DESC
      LIMIT 1
    `).get(requireText(assetKey, 'assetKey'));
  }

  function isFresh(assetKey, sinceIso) {
    requireText(sinceIso, 'sinceIso');
    const row = dbHandle.prepare(`
      SELECT 1
      FROM asset_materializations
      WHERE asset_key = ?
        AND julianday(produced_at) > julianday(?)
      LIMIT 1
    `).get(requireText(assetKey, 'assetKey'), sinceIso);
    return Boolean(row);
  }

  function recordCheck({
    assetKey,
    checkName,
    passed,
    severity = null,
    taskId = null,
    metadata = null,
  }) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    const normalizedCheckName = requireText(checkName, 'checkName');
    const normalizedSeverity = optionalText(severity, 'severity');
    if (normalizedSeverity !== null && !VALID_CHECK_SEVERITIES.has(normalizedSeverity)) {
      throw new Error(`severity must be one of: ${[...VALID_CHECK_SEVERITIES].join(', ')}`);
    }
    if (typeof passed !== 'boolean' && passed !== 0 && passed !== 1) {
      throw new Error('passed must be a boolean or 0/1');
    }

    declareAsset({ assetKey: normalizedAssetKey });
    const checkId = id('chk');
    dbHandle.prepare(`
      INSERT INTO asset_checks (
        check_id,
        asset_key,
        check_name,
        passed,
        severity,
        task_id,
        metadata_json,
        checked_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkId,
      normalizedAssetKey,
      normalizedCheckName,
      passed === true || passed === 1 ? 1 : 0,
      normalizedSeverity,
      optionalText(taskId, 'taskId'),
      serializeMetadata(metadata),
      timestampIso(),
    );

    return checkId;
  }

  function listChecks(assetKey) {
    return dbHandle.prepare(`
      SELECT *
      FROM asset_checks
      WHERE asset_key = ?
      ORDER BY julianday(checked_at) DESC, rowid DESC
    `).all(requireText(assetKey, 'assetKey'));
  }

  function declareDependency(assetKey, dependsOnAssetKey) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    const normalizedDependsOnAssetKey = requireText(dependsOnAssetKey, 'dependsOnAssetKey');

    declareAsset({ assetKey: normalizedAssetKey });
    declareAsset({ assetKey: normalizedDependsOnAssetKey });
    dbHandle.prepare(`
      INSERT OR IGNORE INTO asset_dependencies (asset_key, depends_on_asset_key)
      VALUES (?, ?)
    `).run(normalizedAssetKey, normalizedDependsOnAssetKey);
  }

  function getUpstream(assetKey) {
    return dbHandle.prepare(`
      SELECT depends_on_asset_key
      FROM asset_dependencies
      WHERE asset_key = ?
      ORDER BY depends_on_asset_key ASC
    `).all(requireText(assetKey, 'assetKey')).map(row => row.depends_on_asset_key);
  }

  function getDownstream(assetKey) {
    return dbHandle.prepare(`
      SELECT asset_key
      FROM asset_dependencies
      WHERE depends_on_asset_key = ?
      ORDER BY asset_key ASC
    `).all(requireText(assetKey, 'assetKey')).map(row => row.asset_key);
  }

  return {
    declareAsset,
    recordMaterialization,
    getLatestMaterialization,
    isFresh,
    recordCheck,
    listChecks,
    declareDependency,
    getUpstream,
    getDownstream,
  };
}

module.exports = { createAssetStore };
