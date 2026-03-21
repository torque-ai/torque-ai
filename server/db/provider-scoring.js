'use strict';

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS provider_scores (
    provider TEXT PRIMARY KEY,
    cost_efficiency REAL DEFAULT 0,
    speed_score REAL DEFAULT 0,
    reliability_score REAL DEFAULT 0,
    quality_score REAL DEFAULT 0,
    composite_score REAL DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    total_tasks INTEGER DEFAULT 0,
    total_successes INTEGER DEFAULT 0,
    total_failures INTEGER DEFAULT 0,
    avg_duration_ms REAL DEFAULT 0,
    avg_cost_usd REAL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (datetime('now')),
    trusted INTEGER DEFAULT 0
  );
`;

const MIN_SAMPLES = 5;
const QUALITY_EMA_ALPHA = 0.3;
const DEFAULT_WEIGHTS = Object.freeze({
  cost: 0.15,
  speed: 0.25,
  reliability: 0.35,
  quality: 0.25,
});

let currentDb = null;
let tableReady = false;
let compositeWeights = { ...DEFAULT_WEIGHTS };

function validateDb(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('provider-scoring requires a better-sqlite3 database instance');
  }
}

function ensureInitialized() {
  if (!currentDb) {
    throw new Error('provider-scoring has not been initialized');
  }
  if (!tableReady) {
    currentDb.exec(TABLE_SQL);
    tableReady = true;
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeNonNegative(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
}

function normalizeQualityForComposite(value) {
  const numeric = normalizeNonNegative(value);
  if (numeric > 1) return clamp01(numeric / 100);
  return clamp01(numeric);
}

function computeCompositeScore(row) {
  if (!row || !row.trusted) return 0;

  const cost = clamp01(row.cost_efficiency);
  const speed = clamp01(row.speed_score);
  const reliability = clamp01(row.reliability_score);
  const quality = normalizeQualityForComposite(row.quality_score);

  return (
    cost * compositeWeights.cost +
    speed * compositeWeights.speed +
    reliability * compositeWeights.reliability +
    quality * compositeWeights.quality
  );
}

function getProviderRow(provider) {
  return currentDb.prepare('SELECT * FROM provider_scores WHERE provider = ?').get(provider) || null;
}

function recomputeRelativeScoresInternal() {
  const rows = currentDb.prepare(`
    SELECT provider, avg_duration_ms, avg_cost_usd, reliability_score, quality_score, trusted
    FROM provider_scores
  `).all();

  if (rows.length === 0) {
    return [];
  }

  const maxDuration = rows.reduce((max, row) => Math.max(max, normalizeNonNegative(row.avg_duration_ms)), 0);
  const maxCost = rows.reduce((max, row) => Math.max(max, normalizeNonNegative(row.avg_cost_usd)), 0);
  const updateStmt = currentDb.prepare(`
    UPDATE provider_scores
    SET cost_efficiency = ?,
        speed_score = ?,
        composite_score = ?,
        last_updated = datetime('now')
    WHERE provider = ?
  `);

  for (const row of rows) {
    const duration = normalizeNonNegative(row.avg_duration_ms);
    const cost = normalizeNonNegative(row.avg_cost_usd);
    const speedScore = maxDuration > 0 ? clamp01(1 - (duration / maxDuration)) : 1;
    const costEfficiency = maxCost > 0 ? clamp01(1 - (cost / maxCost)) : 1;
    const compositeScore = computeCompositeScore({
      ...row,
      speed_score: speedScore,
      cost_efficiency: costEfficiency,
    });

    updateStmt.run(costEfficiency, speedScore, compositeScore, row.provider);
  }

  return currentDb.prepare('SELECT * FROM provider_scores ORDER BY provider').all();
}

function validateWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new Error('Composite weights must be an object');
  }

  const nextWeights = { ...compositeWeights };
  for (const key of Object.keys(weights)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_WEIGHTS, key)) {
      throw new Error(`Unknown composite weight: ${key}`);
    }
    const numeric = Number(weights[key]);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`Composite weight ${key} must be a non-negative number`);
    }
    nextWeights[key] = numeric;
  }

  const sum = Object.values(nextWeights).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.05) {
    throw new Error(`Composite weights must sum to 1.0 (+/- 0.05). Received ${sum.toFixed(4)}`);
  }

  return nextWeights;
}

function init(db) {
  validateDb(db);
  currentDb = db;
  tableReady = false;
  ensureInitialized();
}

function recordTaskCompletion({ provider, success, durationMs, costUsd, qualityScore }) {
  ensureInitialized();

  const providerName = String(provider || '').trim();
  if (!providerName) {
    throw new Error('provider is required');
  }

  const durationValue = normalizeNonNegative(durationMs);
  const costValue = normalizeNonNegative(costUsd);
  const qualityValue = normalizeNonNegative(qualityScore);
  const successIncrement = success ? 1 : 0;
  const failureIncrement = success ? 0 : 1;

  const recordTransaction = currentDb.transaction(() => {
    currentDb.prepare(`
      INSERT INTO provider_scores (
        provider,
        reliability_score,
        quality_score,
        sample_count,
        total_tasks,
        total_successes,
        total_failures,
        avg_duration_ms,
        avg_cost_usd,
        trusted
      )
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, 0)
      ON CONFLICT(provider) DO UPDATE SET
        total_tasks = provider_scores.total_tasks + 1,
        total_successes = provider_scores.total_successes + ?,
        total_failures = provider_scores.total_failures + ?,
        avg_duration_ms = ((provider_scores.avg_duration_ms * provider_scores.total_tasks) + ?) / (provider_scores.total_tasks + 1),
        avg_cost_usd = ((provider_scores.avg_cost_usd * provider_scores.total_tasks) + ?) / (provider_scores.total_tasks + 1),
        reliability_score = (provider_scores.total_successes + ?) * 1.0 / (provider_scores.total_tasks + 1),
        quality_score = (? * ?) + ((1 - ?) * provider_scores.quality_score),
        sample_count = provider_scores.sample_count + 1,
        trusted = CASE
          WHEN provider_scores.sample_count + 1 >= ? THEN 1
          ELSE provider_scores.trusted
        END,
        last_updated = datetime('now')
    `).run(
      providerName,
      successIncrement,
      qualityValue,
      successIncrement,
      failureIncrement,
      durationValue,
      costValue,
      successIncrement,
      failureIncrement,
      durationValue,
      costValue,
      successIncrement,
      qualityValue,
      QUALITY_EMA_ALPHA,
      QUALITY_EMA_ALPHA,
      MIN_SAMPLES,
    );

    return recomputeRelativeScoresInternal();
  });

  recordTransaction();
  return getProviderRow(providerName);
}

function recomputeRelativeScores() {
  ensureInitialized();
  const recomputeTransaction = currentDb.transaction(() => recomputeRelativeScoresInternal());
  return recomputeTransaction();
}

function getProviderScore(provider) {
  ensureInitialized();

  const providerName = String(provider || '').trim();
  if (!providerName) return null;
  return getProviderRow(providerName);
}

function getAllProviderScores({ trustedOnly } = {}) {
  ensureInitialized();

  const sql = trustedOnly
    ? 'SELECT * FROM provider_scores WHERE trusted = 1 ORDER BY provider'
    : 'SELECT * FROM provider_scores ORDER BY provider';
  return currentDb.prepare(sql).all();
}

function getCompositeWeights() {
  return { ...compositeWeights };
}

function setCompositeWeights(weights) {
  compositeWeights = validateWeights(weights);
  if (currentDb) {
    ensureInitialized();
    recomputeRelativeScores();
  }
  return getCompositeWeights();
}

module.exports = {
  init,
  recordTaskCompletion,
  recomputeRelativeScores,
  getProviderScore,
  getAllProviderScores,
  getCompositeWeights,
  setCompositeWeights,
};
