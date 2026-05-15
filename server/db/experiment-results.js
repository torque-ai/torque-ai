'use strict';

/**
 * Experiment Results DB Store — persists SDK experiment results to SQLite.
 *
 * Follows the same self-initializing pattern as provider/model-scores.js:
 * lazy table creation on first access, DI-injected DB handle.
 *
 * Table: experiment_results
 *   id           TEXT PRIMARY KEY  — experiment UUID
 *   name         TEXT NOT NULL     — human-readable experiment name
 *   dataset_identity TEXT          — SHA256 hash of the dataset
 *   started_at   TEXT              — ISO timestamp
 *   completed_at TEXT              — ISO timestamp
 *   scorer_count INTEGER           — number of scorers used
 *   aggregate_json TEXT            — JSON-serialized aggregate metrics
 *   rows_json    TEXT              — JSON-serialized row results
 *   metadata_json TEXT             — JSON-serialized experiment metadata
 *   created_at   TEXT NOT NULL     — insertion timestamp
 */

const { resolveContainerDbService, unwrapDbHandle } = require('../utils/db-accessor');

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS experiment_results (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_identity TEXT,
    started_at TEXT,
    completed_at TEXT,
    scorer_count INTEGER DEFAULT 1,
    aggregate_json TEXT,
    rows_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_experiment_results_name
    ON experiment_results(name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_experiment_results_dataset
    ON experiment_results(dataset_identity, created_at DESC);
`;

let currentDb = null;
let tableReady = false;

function resolveDbHandle(candidate) {
  const handle = unwrapDbHandle(candidate);
  return handle && typeof handle.exec === 'function' ? handle : null;
}

function resolveRegisteredDbHandle() {
  try {
    const { defaultContainer } = require('../container');
    return resolveDbHandle(resolveContainerDbService(defaultContainer));
  } catch {
    return null;
  }
}

function validateDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('experiment-results requires a better-sqlite3 database instance');
  }
}

function ensureInitialized() {
  if (!currentDb) {
    currentDb = resolveRegisteredDbHandle();
  }
  validateDb(currentDb);
  if (!tableReady) {
    currentDb.exec(TABLE_SQL);
    tableReady = true;
  }
}

function init(db) {
  currentDb = resolveDbHandle(db);
  tableReady = false;
  ensureInitialized();
}

function setDb(db) {
  currentDb = resolveDbHandle(db);
  tableReady = false;
  if (db !== null && db !== undefined) {
    ensureInitialized();
  }
}

function getDb() {
  ensureInitialized();
  return currentDb;
}

// ── Serialization helpers ──

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ── CRUD ──

/**
 * Store an experiment result. The result object should come from runExperiment().
 * @param {object} result — immutable experiment result from evals/experiment.js
 * @returns {object} the stored row (without JSON expansion)
 */
function storeExperimentResult(result) {
  if (!result || !result.id) {
    throw new Error('storeExperimentResult: result with id is required');
  }
  const db = getDb();

  const row = {
    id: result.id,
    name: result.name || '',
    dataset_identity: result.dataset_identity || null,
    started_at: result.started_at || null,
    completed_at: result.completed_at || null,
    scorer_count: typeof result.scorer_count === 'number' ? result.scorer_count : 1,
    aggregate_json: safeJsonStringify(result.aggregate) || '{}',
    rows_json: safeJsonStringify(result.rows) || '[]',
    metadata_json: safeJsonStringify(result.metadata) || '{}',
    created_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT OR REPLACE INTO experiment_results (
      id, name, dataset_identity, started_at, completed_at,
      scorer_count, aggregate_json, rows_json, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.name,
    row.dataset_identity,
    row.started_at,
    row.completed_at,
    row.scorer_count,
    row.aggregate_json,
    row.rows_json,
    row.metadata_json,
    row.created_at,
  );

  return row;
}

/**
 * Retrieve an experiment result by ID. Returns the expanded object or null.
 * @param {string} experimentId
 * @returns {object|null}
 */
function getExperimentResult(experimentId) {
  if (!experimentId) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM experiment_results WHERE id = ?').get(experimentId);
  if (!row) return null;
  return expandRow(row);
}

/**
 * List all stored experiment results, ordered by created_at DESC.
 * @param {object} [filters]
 * @param {string} [filters.name] — filter by exact name
 * @param {string} [filters.dataset_identity] — filter by dataset identity
 * @param {number} [filters.limit] — max results (default 200)
 * @returns {object[]}
 */
function listExperimentResults(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.name) {
    where.push('name = ?');
    params.push(filters.name);
  }
  if (filters.dataset_identity) {
    where.push('dataset_identity = ?');
    params.push(filters.dataset_identity);
  }

  const limit = Math.min(Math.max(1, Number(filters.limit) || 200), 1000);
  const sql = `
    SELECT * FROM experiment_results
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params, limit).map(expandRow);
}

/**
 * Delete an experiment result by ID.
 * @param {string} experimentId
 * @returns {boolean} true if a row was deleted
 */
function deleteExperimentResult(experimentId) {
  if (!experimentId) return false;
  const db = getDb();
  const info = db.prepare('DELETE FROM experiment_results WHERE id = ?').run(experimentId);
  return info.changes > 0;
}

/**
 * Count stored experiment results.
 * @returns {number}
 */
function countExperimentResults() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM experiment_results').get();
  return row ? row.cnt : 0;
}

// ── Internal ──

function expandRow(row) {
  return {
    id: row.id,
    name: row.name,
    dataset_identity: row.dataset_identity,
    started_at: row.started_at,
    completed_at: row.completed_at,
    scorer_count: row.scorer_count,
    aggregate: safeJsonParse(row.aggregate_json) || {},
    rows: safeJsonParse(row.rows_json) || [],
    metadata: safeJsonParse(row.metadata_json) || {},
    created_at: row.created_at,
  };
}

module.exports = {
  init,
  setDb,
  storeExperimentResult,
  getExperimentResult,
  listExperimentResults,
  deleteExperimentResult,
  countExperimentResults,
  TABLE_SQL,
};
