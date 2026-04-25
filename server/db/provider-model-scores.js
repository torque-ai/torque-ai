'use strict';

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS provider_model_scores (
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    score REAL DEFAULT 0,
    score_reason TEXT,
    smoke_status TEXT DEFAULT 'metadata',
    latency_ms INTEGER,
    first_response_ms INTEGER,
    tool_call_ok INTEGER DEFAULT 0,
    read_only_ok INTEGER DEFAULT 0,
    rate_limited INTEGER DEFAULT 0,
    error TEXT,
    metadata_json TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (provider, model_name)
  );
  CREATE INDEX IF NOT EXISTS idx_provider_model_scores_provider_score
    ON provider_model_scores(provider, score DESC, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_provider_model_scores_status
    ON provider_model_scores(provider, smoke_status, rate_limited, score DESC);
`;

let currentDb = null;
let tableReady = false;

function resolveDbHandle(candidate) {
  if (!candidate) return null;
  if (typeof candidate.prepare === 'function' && typeof candidate.exec === 'function') return candidate;
  if (typeof candidate.getDbInstance === 'function') return resolveDbHandle(candidate.getDbInstance());
  if (typeof candidate.getDb === 'function') return resolveDbHandle(candidate.getDb());
  return null;
}

function validateDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('provider-model-scores requires a better-sqlite3 database instance');
  }
}

function ensureColumns() {
  const columns = new Set(
    currentDb.prepare('PRAGMA table_info(provider_model_scores)').all().map((column) => column.name),
  );

  const additions = [
    ['score_reason', 'TEXT'],
    ['smoke_status', "TEXT DEFAULT 'metadata'"],
    ['latency_ms', 'INTEGER'],
    ['first_response_ms', 'INTEGER'],
    ['tool_call_ok', 'INTEGER DEFAULT 0'],
    ['read_only_ok', 'INTEGER DEFAULT 0'],
    ['rate_limited', 'INTEGER DEFAULT 0'],
    ['error', 'TEXT'],
    ['metadata_json', 'TEXT'],
    ['checked_at', "TEXT DEFAULT (datetime('now'))"],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      currentDb.exec(`ALTER TABLE provider_model_scores ADD COLUMN ${name} ${definition}`);
    }
  }
}

function ensureInitialized() {
  if (!currentDb) {
    const database = require('../database');
    currentDb = resolveDbHandle(database);
  }
  validateDb(currentDb);
  if (!tableReady) {
    currentDb.exec(TABLE_SQL);
    ensureColumns();
    tableReady = true;
  }
}

function init(db) {
  currentDb = resolveDbHandle(db);
  tableReady = false;
  ensureInitialized();
}

function setDb(db) {
  init(db);
}

function getDb() {
  ensureInitialized();
  return currentDb;
}

function normalizeRequiredString(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return Math.round(numeric * 1000) / 1000;
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

function normalizeBooleanInteger(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' ? 1 : 0;
}

function normalizeMetadataJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeRecord(record) {
  return {
    provider: normalizeRequiredString('provider', record?.provider),
    model_name: normalizeRequiredString('model_name', record?.model_name || record?.modelName),
    score: normalizeScore(record?.score),
    score_reason: record?.score_reason || record?.scoreReason || null,
    smoke_status: String(record?.smoke_status || record?.smokeStatus || 'metadata').trim() || 'metadata',
    latency_ms: normalizeNullableInteger(record?.latency_ms ?? record?.latencyMs),
    first_response_ms: normalizeNullableInteger(record?.first_response_ms ?? record?.firstResponseMs),
    tool_call_ok: normalizeBooleanInteger(record?.tool_call_ok ?? record?.toolCallOk),
    read_only_ok: normalizeBooleanInteger(record?.read_only_ok ?? record?.readOnlyOk),
    rate_limited: normalizeBooleanInteger(record?.rate_limited ?? record?.rateLimited),
    error: record?.error ? String(record.error).slice(0, 2000) : null,
    metadata_json: normalizeMetadataJson(record?.metadata_json ?? record?.metadataJson ?? record?.metadata),
    checked_at: record?.checked_at || record?.checkedAt || new Date().toISOString(),
  };
}

function upsertModelScore(record) {
  const db = getDb();
  const row = normalizeRecord(record);

  db.prepare(`
    INSERT INTO provider_model_scores (
      provider, model_name, score, score_reason, smoke_status, latency_ms,
      first_response_ms, tool_call_ok, read_only_ok, rate_limited, error,
      metadata_json, checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model_name) DO UPDATE SET
      score = excluded.score,
      score_reason = excluded.score_reason,
      smoke_status = excluded.smoke_status,
      latency_ms = excluded.latency_ms,
      first_response_ms = excluded.first_response_ms,
      tool_call_ok = excluded.tool_call_ok,
      read_only_ok = excluded.read_only_ok,
      rate_limited = excluded.rate_limited,
      error = excluded.error,
      metadata_json = excluded.metadata_json,
      checked_at = excluded.checked_at
  `).run(
    row.provider,
    row.model_name,
    row.score,
    row.score_reason,
    row.smoke_status,
    row.latency_ms,
    row.first_response_ms,
    row.tool_call_ok,
    row.read_only_ok,
    row.rate_limited,
    row.error,
    row.metadata_json,
    row.checked_at,
  );

  return row;
}

function upsertModelScores(records) {
  const rows = Array.isArray(records) ? records : [];
  const db = getDb();
  const write = db.transaction((items) => items.map((item) => upsertModelScore(item)));
  return write(rows);
}

function listModelScores(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.provider) {
    where.push('provider = ?');
    params.push(normalizeRequiredString('provider', filters.provider));
  }
  if (filters.smoke_status || filters.smokeStatus) {
    where.push('smoke_status = ?');
    params.push(String(filters.smoke_status || filters.smokeStatus));
  }
  if (filters.rate_limited !== undefined || filters.rateLimited !== undefined) {
    where.push('rate_limited = ?');
    params.push(normalizeBooleanInteger(filters.rate_limited ?? filters.rateLimited));
  }
  if (filters.min_score !== undefined || filters.minScore !== undefined) {
    where.push('score >= ?');
    params.push(normalizeScore(filters.min_score ?? filters.minScore));
  }

  const limit = normalizeNullableInteger(filters.limit) || 100;
  const sql = `
    SELECT *
    FROM provider_model_scores
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY score DESC, COALESCE(latency_ms, 999999999) ASC, checked_at DESC, model_name ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, Math.min(limit, 500));
}

function getTopModelScores(provider, options = {}) {
  return listModelScores({
    provider,
    min_score: options.minScore,
    rate_limited: options.rateLimited,
    limit: options.limit || 20,
  });
}

function getModelScore(provider, modelName) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM provider_model_scores
    WHERE provider = ?
      AND model_name = ?
    LIMIT 1
  `).get(
    normalizeRequiredString('provider', provider),
    normalizeRequiredString('model_name', modelName),
  ) || null;
}

module.exports = {
  init,
  setDb,
  upsertModelScore,
  upsertModelScores,
  listModelScores,
  getTopModelScores,
  getModelScore,
  _normalizeRecord: normalizeRecord,
  TABLE_SQL,
};
