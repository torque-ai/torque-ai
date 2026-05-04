'use strict';

/**
 * Provider Health History — extracted from provider-routing-core.js
 *
 * Persistent storage for provider health window data.
 * Uses dependency injection for the database instance.
 */

let db;

function setDb(dbInstance) {
  db = dbInstance;
  if (db && typeof db.exec === 'function') {
    ensureHealthTable();
  }
}

function ensureHealthTable() {
  if (!db) {
    throw new Error('Database not set');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_health_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT,
      total_checks INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      failure_rate REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_health_history_provider_window
      ON provider_health_history(provider, window_start);
    CREATE INDEX IF NOT EXISTS idx_provider_health_history_window_start
      ON provider_health_history(window_start);
  `);
}

function normalizeIsoDate(value, fieldName) {
  if (!value) {
    if (fieldName) {
      throw new Error(`${fieldName} is required`);
    }
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName || 'date'}: ${value}`);
  }

  return parsed.toISOString();
}

function normalizeWindowData(windowData = {}) {
  const windowStart = normalizeIsoDate(
    windowData.window_start ?? windowData.windowStart,
    'window_start'
  );
  const windowEndValue = windowData.window_end ?? windowData.windowEnd;
  const windowEnd = windowEndValue ? normalizeIsoDate(windowEndValue, 'window_end') : null;

  const successes = Number(
    windowData.successes ?? windowData.success_count ?? windowData.successCount ?? 0
  );
  const failures = Number(
    windowData.failures ?? windowData.failure_count ?? windowData.failureCount ?? 0
  );

  let totalChecks = Number(
    windowData.total_checks ?? windowData.totalChecks ?? windowData.sample_count ?? windowData.sampleCount
  );
  if (!Number.isFinite(totalChecks)) {
    totalChecks = successes + failures;
  }

  let failureRate = Number(windowData.failure_rate ?? windowData.failureRate);
  if (!Number.isFinite(failureRate)) {
    failureRate = totalChecks > 0 ? failures / totalChecks : 0;
  }

  return {
    windowStart,
    windowEnd,
    totalChecks: Math.max(0, totalChecks),
    successes: Math.max(0, successes),
    failures: Math.max(0, failures),
    failureRate,
  };
}

function mapRow(row) {
  if (!row) {
    return row;
  }

  return {
    provider: row.provider,
    window_start: row.window_start,
    window_end: row.window_end,
    total_checks: Number(row.total_checks) || 0,
    successes: Number(row.successes) || 0,
    failures: Number(row.failures) || 0,
    failure_rate: Number(row.failure_rate) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function persistHealthWindow(provider, windowData) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('provider is required');
  }

  ensureHealthTable();
  const normalized = normalizeWindowData(windowData);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO provider_health_history (
      provider,
      window_start,
      window_end,
      total_checks,
      successes,
      failures,
      failure_rate,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, window_start) DO UPDATE SET
      window_end = excluded.window_end,
      total_checks = excluded.total_checks,
      successes = excluded.successes,
      failures = excluded.failures,
      failure_rate = excluded.failure_rate,
      updated_at = excluded.updated_at
  `).run(
    provider,
    normalized.windowStart,
    normalized.windowEnd,
    normalized.totalChecks,
    normalized.successes,
    normalized.failures,
    normalized.failureRate,
    now,
    now
  );

  return mapRow(
    db.prepare(`
      SELECT provider, window_start, window_end, total_checks, successes, failures, failure_rate, created_at, updated_at
      FROM provider_health_history
      WHERE provider = ? AND window_start = ?
    `).get(provider, normalized.windowStart)
  );
}

function getHealthHistory(provider, days = 30) {
  if (!provider || typeof provider !== 'string') {
    return [];
  }

  ensureHealthTable();
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 30;
  const cutoff = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000)).toISOString();

  return db.prepare(`
    SELECT provider, window_start, window_end, total_checks, successes, failures, failure_rate, created_at, updated_at
    FROM provider_health_history
    WHERE provider = ? AND window_start >= ?
    ORDER BY window_start ASC
  `).all(provider, cutoff).map(mapRow);
}

function averageFailureRate(rows) {
  if (!rows.length) {
    return 0;
  }

  const total = rows.reduce((sum, row) => sum + (Number(row.failure_rate) || 0), 0);
  return total / rows.length;
}

function getHealthTrend(provider, days = 30) {
  const history = getHealthHistory(provider, days);
  if (history.length < 2) {
    return {
      provider,
      days,
      trend: 'insufficient_data',
      window_count: history.length,
      previous_failure_rate: null,
      recent_failure_rate: null,
    };
  }

  const splitIndex = Math.max(1, Math.floor(history.length / 2));
  const previousWindows = history.slice(0, splitIndex);
  const recentWindows = history.slice(splitIndex);

  const previousFailureRate = averageFailureRate(previousWindows);
  const recentFailureRate = averageFailureRate(recentWindows);
  const delta = recentFailureRate - previousFailureRate;

  let trend = 'stable';
  if (Math.abs(delta) >= 0.02) {
    trend = delta < 0 ? 'improving' : 'degrading';
  }

  return {
    provider,
    days,
    trend,
    window_count: history.length,
    previous_failure_rate: previousFailureRate,
    recent_failure_rate: recentFailureRate,
  };
}

function pruneHealthHistory(days = 30) {
  ensureHealthTable();
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 30;
  const cutoff = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000)).toISOString();

  const result = db.prepare(`
    DELETE FROM provider_health_history
    WHERE window_start < ?
  `).run(cutoff);

  return result.changes;
}

module.exports = {
  setDb,
  ensureHealthTable,
  persistHealthWindow,
  getHealthHistory,
  getHealthTrend,
  pruneHealthHistory,
};
