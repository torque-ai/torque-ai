'use strict';

const { randomUUID } = require('crypto');

const VALID_SEVERITIES = new Set(['error', 'warn', 'info']);
let lastTimestampMs = 0;

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }

  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  throw new Error('asset checks requires a database handle');
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

function normalizePassed(passed) {
  if (typeof passed === 'boolean') return passed ? 1 : 0;
  if (passed === 0 || passed === 1) return passed;
  throw new Error('passed must be a boolean or 0/1');
}

function normalizeSeverity(severity) {
  const normalized = optionalText(severity, 'severity') || 'error';
  if (!VALID_SEVERITIES.has(normalized)) {
    throw new Error(`severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
  }
  return normalized;
}

function serializeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be a plain object');
  }
  return JSON.stringify(metadata);
}

function parseMetadata(metadataJson) {
  if (!metadataJson) return null;
  return JSON.parse(metadataJson);
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function timestampIso() {
  const nextTimestampMs = Math.max(Date.now() + 1, lastTimestampMs + 1);
  lastTimestampMs = nextTimestampMs;
  return new Date(nextTimestampMs).toISOString();
}

function createAssetChecks({ db } = {}) {
  const dbHandle = resolveDbHandle(db);

  function record({
    assetKey,
    checkName,
    passed,
    severity = 'error',
    taskId = null,
    metadata = null,
  }) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    const normalizedCheckName = requireText(checkName, 'checkName');
    const normalizedSeverity = normalizeSeverity(severity);
    const normalizedTaskId = optionalText(taskId, 'taskId');
    const metadataJson = serializeMetadata(metadata);
    const checkId = id('chk');

    dbHandle.prepare(`
      INSERT INTO assets (asset_key)
      VALUES (?)
      ON CONFLICT(asset_key) DO NOTHING
    `).run(normalizedAssetKey);

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
      normalizePassed(passed),
      normalizedSeverity,
      normalizedTaskId,
      metadataJson,
      timestampIso(),
    );

    return checkId;
  }

  function latestForAsset(assetKey) {
    const normalizedAssetKey = requireText(assetKey, 'assetKey');
    const rows = dbHandle.prepare(`
      SELECT a.*
      FROM asset_checks a
      WHERE a.asset_key = ?
        AND NOT EXISTS (
          SELECT 1
          FROM asset_checks newer
          WHERE newer.asset_key = a.asset_key
            AND newer.check_name = a.check_name
            AND (
              julianday(newer.checked_at) > julianday(a.checked_at)
              OR (
                julianday(newer.checked_at) = julianday(a.checked_at)
                AND newer.rowid > a.rowid
              )
            )
        )
      ORDER BY a.check_name ASC
    `).all(normalizedAssetKey);

    const latest = {};
    for (const row of rows) {
      latest[row.check_name] = {
        passed: row.passed === 1,
        severity: row.severity || 'error',
        checked_at: row.checked_at,
        task_id: row.task_id,
        metadata: parseMetadata(row.metadata_json),
      };
    }
    return latest;
  }

  function isHealthy(assetKey) {
    const latest = latestForAsset(assetKey);
    return Object.values(latest).every(check => check.passed || check.severity !== 'error');
  }

  return { record, latestForAsset, isHealthy };
}

module.exports = { createAssetChecks };
