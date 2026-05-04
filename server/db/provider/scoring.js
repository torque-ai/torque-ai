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
    p95_duration_ms REAL DEFAULT 0,
    avg_cost_usd REAL DEFAULT 0,
    last_updated TEXT,
    trusted INTEGER DEFAULT 0
  );
`;

const MIN_SAMPLES = 5;
const SHARED_LEARNING_MIN_SAMPLES = 3;
const SHARED_LEARNING_MIN_CONFIDENCE = 0.6;
const SHARED_LEARNING_MAX_PENALTY = 0.35;
const QUALITY_EMA_ALPHA = 0.3;
const DEFAULT_WEIGHTS = Object.freeze({
  cost: 0.15,
  speed: 0.25,
  reliability: 0.35,
  quality: 0.25,
});
const WEIGHTS_CONFIG_KEY = 'provider_scoring_composite_weights';

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
    ensureProviderScoresColumns();
    loadCompositeWeights();
    tableReady = true;
  }
}

function ensureProviderScoresColumns() {
  const columns = new Set(
    currentDb.prepare('PRAGMA table_info(provider_scores)').all().map((column) => column.name),
  );

  if (!columns.has('p95_duration_ms')) {
    currentDb.exec('ALTER TABLE provider_scores ADD COLUMN p95_duration_ms REAL DEFAULT 0');
  }
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim();
  if (!normalized) {
    throw new Error('provider is required');
  }
  return normalized;
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

function normalizeCount(value) {
  return Math.floor(normalizeNonNegative(value));
}

function normalizeQuality(value) {
  return clamp01(normalizeNonNegative(value));
}

function qualityEma(newSample, currentQuality) {
  const current = Number(currentQuality);
  if (!Number.isFinite(current)) {
    return normalizeQuality(newSample);
  }

  return (QUALITY_EMA_ALPHA * normalizeQuality(newSample)) + ((1 - QUALITY_EMA_ALPHA) * current);
}

function computeReliability(totalSuccesses, totalTasks) {
  const tasks = normalizeCount(totalTasks);
  if (tasks <= 0) return 0;
  return clamp01(normalizeCount(totalSuccesses) / tasks);
}

function computeSpeedScore(avgDurationMs, maxDurationMs) {
  const avg = normalizeNonNegative(avgDurationMs);
  const max = normalizeNonNegative(maxDurationMs);
  if (avg === 0 || max === 0) return 1;
  return clamp01(1 - (avg / max));
}

function computeCostEfficiency(avgCostUsd, maxCostUsd) {
  const avgCost = normalizeNonNegative(avgCostUsd);
  const maxCost = normalizeNonNegative(maxCostUsd);
  if (avgCost === 0 || maxCost === 0) return 1;
  return clamp01(1 - (avgCost / maxCost));
}

function computeCompositeScore(row) {
  if (!row || normalizeCount(row.sample_count) < MIN_SAMPLES) return 0;

  return clamp01(
    (clamp01(row.cost_efficiency) * compositeWeights.cost)
    + (clamp01(row.speed_score) * compositeWeights.speed)
    + (clamp01(row.reliability_score) * compositeWeights.reliability)
    + (normalizeQuality(row.quality_score) * compositeWeights.quality),
  );
}

function computeSharedLearningPenalty(row, options = {}) {
  const minSamples = normalizeCount(options.minSamples ?? SHARED_LEARNING_MIN_SAMPLES);
  const minConfidence = clamp01(Number(options.minConfidence ?? SHARED_LEARNING_MIN_CONFIDENCE));
  const maxPenalty = clamp01(Number(options.maxPenalty ?? SHARED_LEARNING_MAX_PENALTY));
  const sampleCount = normalizeCount(row?.sample_count ?? row?.sampleCount);
  const confidence = clamp01(Number(row?.confidence));

  if (sampleCount < minSamples || confidence < minConfidence || maxPenalty <= 0) {
    return 0;
  }

  const sampleFactor = clamp01((sampleCount - minSamples + 1) / Math.max(1, minSamples));
  return clamp01(Math.min(maxPenalty, maxPenalty * confidence * (0.5 + (sampleFactor * 0.5))));
}

function getNow() {
  return new Date().toISOString();
}

function getProviderRow(provider) {
  return currentDb.prepare('SELECT * FROM provider_scores WHERE provider = ?').get(provider) || null;
}

function getProviderRows() {
  return currentDb.prepare('SELECT * FROM provider_scores ORDER BY provider ASC').all();
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
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`Composite weights must sum to 1.0. Received ${sum.toFixed(4)}`);
  }

  return nextWeights;
}

function persistCompositeWeights(weights) {
  if (!currentDb) return;
  try {
    const stmt = currentDb.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    stmt.run(WEIGHTS_CONFIG_KEY, JSON.stringify(weights));
  } catch (_e) {
    // Configuration persistence is optional; callers can still override weights in-memory.
  }
}

function loadCompositeWeights() {
  compositeWeights = { ...DEFAULT_WEIGHTS };
  try {
    const row = currentDb.prepare('SELECT value FROM config WHERE key = ?').get(WEIGHTS_CONFIG_KEY);
    if (!row || !row.value) return;
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object') {
      compositeWeights = validateWeights(parsed);
    }
  } catch (_e) {}
}

function init(db) {
  validateDb(db);
  currentDb = db;
  tableReady = false;
  ensureInitialized();
}

function refreshRelativeScores() {
  const rows = getProviderRows();
  if (rows.length === 0) return [];

  const maxDurationMs = rows.reduce(
    (max, row) => Math.max(max, normalizeNonNegative(row.avg_duration_ms)),
    0,
  );
  const maxCostUsd = rows.reduce(
    (max, row) => Math.max(max, normalizeNonNegative(row.avg_cost_usd)),
    0,
  );
  const now = getNow();

  const updateScoreStmt = currentDb.prepare(`
    UPDATE provider_scores
    SET reliability_score = ?,
        speed_score = ?,
        cost_efficiency = ?,
        composite_score = ?,
        trusted = ?,
        last_updated = ?
    WHERE provider = ?
  `);

  const refreshed = [];
  for (const row of rows) {
    const persistedSampleCount = normalizeCount(row.sample_count);
    const sampleCount = persistedSampleCount > 0 ? persistedSampleCount : normalizeCount(row.total_tasks);
    const reliability = computeReliability(row.total_successes, row.total_tasks);
    const speed = computeSpeedScore(row.avg_duration_ms, maxDurationMs);
    const cost = computeCostEfficiency(row.avg_cost_usd, maxCostUsd);
    const trusted = sampleCount >= MIN_SAMPLES ? 1 : 0;
    const composite = computeCompositeScore({
      sample_count: sampleCount,
      cost_efficiency: cost,
      speed_score: speed,
      reliability_score: reliability,
      quality_score: row.quality_score,
    });

    updateScoreStmt.run(
      reliability,
      speed,
      cost,
      composite,
      trusted,
      now,
      row.provider,
    );

    refreshed.push({
      ...row,
      reliability_score: reliability,
      speed_score: speed,
      cost_efficiency: cost,
      composite_score: composite,
      trusted,
      last_updated: now,
    });
  }

  return refreshed;
}

function updateProviderAggregate({
  providerName,
  totalTasks,
  totalSuccesses,
  totalFailures,
  avgDurationMs,
  p95DurationMs,
  avgCostUsd,
  qualityScore,
}) {
  currentDb.prepare(`
    UPDATE provider_scores
    SET quality_score = ?,
        sample_count = ?,
        total_tasks = ?,
        total_successes = ?,
        total_failures = ?,
        avg_duration_ms = ?,
        p95_duration_ms = ?,
        avg_cost_usd = ?,
        last_updated = ?
    WHERE provider = ?
  `).run(
    qualityScore,
    totalTasks,
    totalTasks,
    totalSuccesses,
    totalFailures,
    avgDurationMs,
    p95DurationMs,
    avgCostUsd,
    getNow(),
    providerName,
  );
}

function insertProviderAggregate({
  providerName,
  totalTasks,
  totalSuccesses,
  totalFailures,
  avgDurationMs,
  p95DurationMs,
  avgCostUsd,
  qualityScore,
}) {
  currentDb.prepare(`
    INSERT INTO provider_scores (
      provider,
      cost_efficiency,
      speed_score,
      reliability_score,
      quality_score,
      composite_score,
      sample_count,
      total_tasks,
      total_successes,
      total_failures,
      avg_duration_ms,
      p95_duration_ms,
      avg_cost_usd,
      last_updated,
      trusted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    providerName,
    0,
    0,
    0,
    qualityScore,
    0,
    totalTasks,
    totalTasks,
    totalSuccesses,
    totalFailures,
    avgDurationMs,
    p95DurationMs,
    avgCostUsd,
    getNow(),
    0,
  );
}

function recomputeComposite(provider) {
  const providerName = normalizeProvider(provider);
  ensureInitialized();

  if (!getProviderRow(providerName)) return null;
  refreshRelativeScores();
  return getProviderRow(providerName);
}

function recomputeAllComposites() {
  ensureInitialized();
  const txn = currentDb.transaction(() => {
    return refreshRelativeScores();
  });
  return txn();
}

function recordTaskCompletion({
  provider,
  success,
  durationMs,
  costUsd,
  qualityScore,
}) {
  ensureInitialized();

  const providerName = normalizeProvider(provider);
  const isSuccess = Boolean(success);
  const duration = normalizeNonNegative(durationMs);
  const cost = normalizeNonNegative(costUsd);
  const quality = normalizeQuality(qualityScore);

  const recordTransaction = currentDb.transaction(() => {
    const existing = getProviderRow(providerName);
    const successIncrement = isSuccess ? 1 : 0;
    const failureIncrement = isSuccess ? 0 : 1;

    if (!existing) {
      const totalTasks = 1;
      const totalSuccesses = successIncrement;
      const totalFailures = failureIncrement;
      const avgDurationMs = duration;
      const p95DurationMs = duration;
      const avgCostUsd = cost;
      const qualityScoreNext = quality;
      insertProviderAggregate({
        providerName,
        totalTasks,
        totalSuccesses,
        totalFailures,
        avgDurationMs,
        p95DurationMs,
        avgCostUsd,
        qualityScore: qualityScoreNext,
      });
      refreshRelativeScores();
      return;
    }

    const existingTotalTasks = normalizeCount(existing.total_tasks);
    const totalTasks = existingTotalTasks + 1;
    const totalSuccesses = normalizeCount(existing.total_successes) + successIncrement;
    const totalFailures = normalizeCount(existing.total_failures) + failureIncrement;
    const avgDurationMs = (
      (normalizeNonNegative(existing.avg_duration_ms) * existingTotalTasks) + duration
    ) / totalTasks;
    const p95DurationMs = Math.max(normalizeNonNegative(existing.p95_duration_ms), duration);
    const avgCostUsd = (
      (normalizeNonNegative(existing.avg_cost_usd) * existingTotalTasks) + cost
    ) / totalTasks;
    const qualityScoreNext = qualityEma(quality, existing.quality_score);
    updateProviderAggregate({
      providerName,
      totalTasks,
      totalSuccesses,
      totalFailures,
      avgDurationMs,
      p95DurationMs,
      avgCostUsd,
      qualityScore: qualityScoreNext,
    });
    refreshRelativeScores();
  });

  recordTransaction();
  const row = getProviderRow(providerName);
  if (!row) return null;
  return row;
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
    ? 'SELECT * FROM provider_scores WHERE trusted = 1 ORDER BY composite_score DESC, provider ASC'
    : 'SELECT * FROM provider_scores ORDER BY trusted DESC, composite_score DESC, provider ASC';
  return currentDb.prepare(sql).all();
}

function getCompositeWeights() {
  return { ...compositeWeights };
}

function setCompositeWeights(weights) {
  compositeWeights = validateWeights(weights);
  persistCompositeWeights(compositeWeights);
  if (currentDb) {
    ensureInitialized();
    recomputeAllComposites();
  }
  return getCompositeWeights();
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProviderScoring({ db: dbInstance } = {}) {
  if (dbInstance) init(dbInstance);
  return module.exports;
}

module.exports = {
  init,
  createProviderScoring,
  recordTaskCompletion,
  recomputeRelativeScores: recomputeAllComposites,
  getProviderScore,
  getAllProviderScores,
  getCompositeWeights,
  setCompositeWeights,
  recalculateComposite: recomputeComposite,
  computeSharedLearningPenalty,
  MIN_SAMPLES,
  SHARED_LEARNING_MIN_SAMPLES,
  SHARED_LEARNING_MIN_CONFIDENCE,
  SHARED_LEARNING_MAX_PENALTY,
};
