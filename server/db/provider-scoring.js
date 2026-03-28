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
    last_updated TEXT,
    trusted INTEGER DEFAULT 0
  );
`;

const MIN_SAMPLES = 5;
const QUALITY_EMA_ALPHA = 0.3;
const MAX_DURATION_MS = 600000;
const SPEED_DAMPENER = 1.0 / MAX_DURATION_MS;
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
    loadCompositeWeights();
    tableReady = true;
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

function normalizeQuality(value) {
  return clamp01(normalizeNonNegative(value));
}

function qualityEma(newSample, currentQuality) {
  if (!Number.isFinite(currentQuality)) {
    return normalizeQuality(newSample);
  }

  return (QUALITY_EMA_ALPHA * normalizeQuality(newSample)) + ((1 - QUALITY_EMA_ALPHA) * currentQuality);
}

function computeSpeedScore(avgDurationMs) {
  const avg = normalizeNonNegative(avgDurationMs);
  return clamp01(1 - (avg * SPEED_DAMPENER));
}

function computeCostEfficiency(avgCostUsd) {
  const avgCost = normalizeNonNegative(avgCostUsd);
  return clamp01(1 / (1 + avgCost * 10));
}

function computeCompositeScore(row) {
  if (!row || row.sample_count < MIN_SAMPLES) return 0;

  return clamp01(
    (clamp01(row.cost_efficiency) * compositeWeights.cost)
    + (clamp01(row.speed_score) * compositeWeights.speed)
    + (clamp01(row.reliability_score) * compositeWeights.reliability)
    + (normalizeQuality(row.quality_score) * compositeWeights.quality),
  );
}

function getNow() {
  return new Date().toISOString();
}

function getProviderRow(provider) {
  return currentDb.prepare('SELECT * FROM provider_scores WHERE provider = ?').get(provider) || null;
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
  try {
    const row = currentDb.prepare('SELECT value FROM config WHERE key = ?').get(WEIGHTS_CONFIG_KEY);
    if (!row || !row.value) return;
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object') {
      compositeWeights = validateWeights(parsed);
    }
  } catch (_e) {
    compositeWeights = { ...DEFAULT_WEIGHTS };
  }
}

function init(db) {
  validateDb(db);
  currentDb = db;
  tableReady = false;
  ensureInitialized();
}

function updateAxisAndComposite({
  providerName,
  totalTasks,
  totalSuccesses,
  totalFailures,
  avgDurationMs,
  avgCostUsd,
  qualityScore,
}) {
  const reliability = totalTasks > 0 ? totalSuccesses / totalTasks : 0;
  const speed = computeSpeedScore(avgDurationMs);
  const cost = computeCostEfficiency(avgCostUsd);
  const sampleCount = totalTasks;
  const trusted = sampleCount >= MIN_SAMPLES ? 1 : 0;

  const composite = computeCompositeScore({
    sample_count: sampleCount,
    cost_efficiency: cost,
    speed_score: speed,
    reliability_score: reliability,
    quality_score: qualityScore,
  });

  currentDb.prepare(`
    UPDATE provider_scores
    SET reliability_score = ?,
        quality_score = ?,
        speed_score = ?,
        cost_efficiency = ?,
        composite_score = ?,
        sample_count = ?,
        total_tasks = ?,
        total_successes = ?,
        total_failures = ?,
        avg_duration_ms = ?,
        avg_cost_usd = ?,
        trusted = ?,
        last_updated = ?
    WHERE provider = ?
  `).run(
    reliability,
    qualityScore,
    speed,
    cost,
    composite,
    sampleCount,
    totalTasks,
    totalSuccesses,
    totalFailures,
    avgDurationMs,
    avgCostUsd,
    trusted,
    getNow(),
    providerName,
  );
}

function insertAxisAndComposite({
  providerName,
  totalTasks,
  totalSuccesses,
  totalFailures,
  avgDurationMs,
  avgCostUsd,
  qualityScore,
}) {
  const reliability = totalTasks > 0 ? totalSuccesses / totalTasks : 0;
  const speed = computeSpeedScore(avgDurationMs);
  const cost = computeCostEfficiency(avgCostUsd);
  const sampleCount = totalTasks;
  const trusted = sampleCount >= MIN_SAMPLES ? 1 : 0;

  const composite = computeCompositeScore({
    sample_count: sampleCount,
    cost_efficiency: cost,
    speed_score: speed,
    reliability_score: reliability,
    quality_score: qualityScore,
  });

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
      avg_cost_usd,
      last_updated,
      trusted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    providerName,
    cost,
    speed,
    reliability,
    qualityScore,
    composite,
    sampleCount,
    totalTasks,
    totalSuccesses,
    totalFailures,
    avgDurationMs,
    avgCostUsd,
    getNow(),
    trusted,
  );
}

function recomputeComposite(provider) {
  const providerName = normalizeProvider(provider);
  ensureInitialized();

  const row = getProviderRow(providerName);
  if (!row) return null;

  const composite = computeCompositeScore({
    ...row,
    sample_count: row.sample_count,
    reliability_score: row.reliability_score,
    speed_score: row.speed_score,
    quality_score: row.quality_score,
    cost_efficiency: row.cost_efficiency,
  });

  currentDb.prepare(`
    UPDATE provider_scores
    SET composite_score = ?,
        trusted = ?,
        last_updated = ?
    WHERE provider = ?
  `).run(
    composite,
    row.sample_count >= MIN_SAMPLES ? 1 : 0,
    getNow(),
    providerName,
  );

  return getProviderRow(providerName);
}

function recomputeAllComposites() {
  const rows = currentDb.prepare('SELECT provider FROM provider_scores').all();
  if (rows.length === 0) return [];
  const txn = currentDb.transaction(() => {
    const updated = [];
    for (const row of rows) {
      const refreshed = recomputeComposite(row.provider);
      if (refreshed) {
        updated.push(refreshed);
      }
    }
    return updated;
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
      const avgCostUsd = cost;
      const qualityScoreNext = quality;
      insertAxisAndComposite({
        providerName,
        totalTasks,
        totalSuccesses,
        totalFailures,
        avgDurationMs,
        avgCostUsd,
        qualityScore: qualityScoreNext,
      });
      return;
    }

    const totalTasks = existing.total_tasks + 1;
    const totalSuccesses = existing.total_successes + successIncrement;
    const totalFailures = existing.total_failures + failureIncrement;
    const avgDurationMs = ((existing.avg_duration_ms * existing.total_tasks) + duration) / totalTasks;
    const avgCostUsd = ((existing.avg_cost_usd * existing.total_tasks) + cost) / totalTasks;
    const qualityScoreNext = qualityEma(quality, existing.quality_score);
    updateAxisAndComposite({
      providerName,
      totalTasks,
      totalSuccesses,
      totalFailures,
      avgDurationMs,
      avgCostUsd,
      qualityScore: qualityScoreNext,
    });
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
    ? 'SELECT * FROM provider_scores WHERE trusted = 1 ORDER BY composite_score DESC'
    : 'SELECT * FROM provider_scores ORDER BY composite_score DESC';
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
  MIN_SAMPLES,
};
