'use strict';

const db = require('../database');

const PROVIDER_TABLES = ['provider_config', 'providers'];
const PROVIDER_SQL = `COALESCE(NULLIF(LOWER(TRIM(provider)), ''), 'unknown')`;

function getDbInstanceOrThrow() {
  if (!db || typeof db.getDbInstance !== 'function') {
    throw new Error('Database module does not expose getDbInstance()');
  }

  const instance = db.getDbInstance();
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('Database instance is not available');
  }

  return instance;
}

function normalizeWindowHours(windowHours, defaultValue) {
  const value = windowHours === undefined ? defaultValue : Number(windowHours);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('windowHours must be a positive number');
  }
  return value;
}

function getCutoffIso(windowHours) {
  return new Date(Date.now() - (windowHours * 60 * 60 * 1000)).toISOString();
}

function resolveProviderTable(instance) {
  const tableRow = instance.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (${PROVIDER_TABLES.map(() => '?').join(', ')})
    ORDER BY CASE name
      WHEN 'provider_config' THEN 0
      WHEN 'providers' THEN 1
      ELSE 2
    END
    LIMIT 1
  `).get(...PROVIDER_TABLES);

  if (!tableRow || !PROVIDER_TABLES.includes(tableRow.name)) {
    throw new Error('Provider configuration table was not found');
  }

  return tableRow.name;
}

function rowsToCountMap(rows) {
  const byProvider = {};
  for (const row of rows) {
    byProvider[row.provider] = Number(row.total) || 0;
  }
  return byProvider;
}

function rowsToAverageMap(rows) {
  const byProvider = {};
  for (const row of rows) {
    byProvider[row.provider] = row.averageDurationSeconds == null
      ? 0
      : roundMetric(row.averageDurationSeconds);
  }
  return byProvider;
}

function roundMetric(value, decimals = 3) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  const factor = 10 ** decimals;
  return Math.round(numericValue * factor) / factor;
}

function getTasksPerHour(windowHours = 24) {
  const normalizedWindowHours = normalizeWindowHours(windowHours, 24);
  const instance = getDbInstanceOrThrow();
  const cutoff = getCutoffIso(normalizedWindowHours);

  const providerRows = instance.prepare(`
    SELECT
      ${PROVIDER_SQL} AS provider,
      COUNT(*) AS total
    FROM tasks
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND completed_at >= ?
    GROUP BY ${PROVIDER_SQL}
    ORDER BY total DESC, provider ASC
  `).all(cutoff);

  const total = providerRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);

  return {
    total,
    perHour: total / normalizedWindowHours,
    byProvider: rowsToCountMap(providerRows),
  };
}

function getProviderUtilization(windowHours = 1) {
  normalizeWindowHours(windowHours, 1);

  const instance = getDbInstanceOrThrow();
  const providerTable = resolveProviderTable(instance);
  const rows = instance.prepare(`
    SELECT
      p.provider AS provider,
      COUNT(t.id) AS running,
      COALESCE(p.max_concurrent, 0) AS maxConcurrent,
      CASE
        WHEN COALESCE(p.max_concurrent, 0) > 0
          THEN ROUND((COUNT(t.id) * 100.0) / p.max_concurrent, 1)
        ELSE 0
      END AS utilization
    FROM ${providerTable} p
    LEFT JOIN tasks t
      ON t.provider = p.provider
     AND t.status = 'running'
    WHERE COALESCE(p.enabled, 0) = 1
    GROUP BY p.provider, p.max_concurrent
    ORDER BY p.provider ASC
  `).all();

  return {
    providers: rows.map((row) => ({
      provider: row.provider,
      running: Number(row.running) || 0,
      maxConcurrent: Number(row.maxConcurrent) || 0,
      utilization: Number(row.utilization) || 0,
    })),
  };
}

function getAverageDuration(windowHours = 24) {
  const normalizedWindowHours = normalizeWindowHours(windowHours, 24);
  const instance = getDbInstanceOrThrow();
  const cutoff = getCutoffIso(normalizedWindowHours);

  const durationExpression = `
    CASE
      WHEN created_at IS NOT NULL
       AND completed_at IS NOT NULL
       AND julianday(completed_at) >= julianday(created_at)
      THEN (julianday(completed_at) - julianday(created_at)) * 86400.0
      ELSE NULL
    END
  `;

  const overallRow = instance.prepare(`
    SELECT AVG(${durationExpression}) AS averageDurationSeconds
    FROM tasks
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND completed_at >= ?
  `).get(cutoff);

  const providerRows = instance.prepare(`
    SELECT
      ${PROVIDER_SQL} AS provider,
      AVG(${durationExpression}) AS averageDurationSeconds
    FROM tasks
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND completed_at >= ?
    GROUP BY ${PROVIDER_SQL}
    ORDER BY provider ASC
  `).all(cutoff);

  return {
    overall: overallRow && overallRow.averageDurationSeconds != null
      ? roundMetric(overallRow.averageDurationSeconds)
      : 0,
    byProvider: rowsToAverageMap(providerRows),
  };
}

function getThroughputSummary(windowHours = 24) {
  const normalizedWindowHours = normalizeWindowHours(windowHours, 24);

  return {
    tasksPerHour: getTasksPerHour(normalizedWindowHours),
    providerUtilization: getProviderUtilization(normalizedWindowHours),
    averageDuration: getAverageDuration(normalizedWindowHours),
  };
}

module.exports = {
  getTasksPerHour,
  getProviderUtilization,
  getAverageDuration,
  getThroughputSummary,
};
