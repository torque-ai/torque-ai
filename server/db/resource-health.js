// Extracted from project-config-core.js — Health checks, Resource metrics, Memory pressure
'use strict';

const path = require('path');
const fs = require('fs');
const { safeJsonParse } = require('../utils/json');

// ============================================================
// Dependency injection (set by parent module)
// ============================================================

let db = null;
const _deps = {
  getConfig: () => null,
  cleanupWebhookLogs: () => 0,
  cleanupStreamData: () => 0,
  cleanupCoordinationEvents: () => 0,
  getSlowQueries: () => [],
};

function setDb(d) { db = d; }

/**
 * Initialize with dependencies from parent module.
 * @param {object} deps
 * @param {function} deps.getConfig
 * @param {function} deps.cleanupWebhookLogs
 * @param {function} deps.cleanupStreamData
 * @param {function} deps.cleanupCoordinationEvents
 * @param {function} deps.getSlowQueries
 */
function init(deps) {
  if (deps.getConfig) _deps.getConfig = deps.getConfig;
  if (deps.cleanupWebhookLogs) _deps.cleanupWebhookLogs = deps.cleanupWebhookLogs;
  if (deps.cleanupStreamData) _deps.cleanupStreamData = deps.cleanupStreamData;
  if (deps.cleanupCoordinationEvents) _deps.cleanupCoordinationEvents = deps.cleanupCoordinationEvents;
  if (deps.getSlowQueries) _deps.getSlowQueries = deps.getSlowQueries;
}

// ============================================================
// Health checks
// ============================================================

/**
 * Record a health check result
 */
function recordHealthCheck(checkType, status, responseTimeMs, errorMessage = null, details = null) {
  const stmt = db.prepare(`
    INSERT INTO health_status (check_type, status, response_time_ms, error_message, details, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    checkType,
    status,
    responseTimeMs,
    errorMessage,
    details ? JSON.stringify(details) : null,
    new Date().toISOString()
  );
}

/**
 * Get latest health check (optionally for a specific type)
 */
function getLatestHealthCheck(checkType = null) {
  let stmt;
  let row;

  if (checkType) {
    stmt = db.prepare(`
      SELECT * FROM health_status
      WHERE check_type = ?
      ORDER BY checked_at DESC
      LIMIT 1
    `);
    row = stmt.get(checkType);
  } else {
    stmt = db.prepare(`
      SELECT * FROM health_status
      ORDER BY checked_at DESC
      LIMIT 1
    `);
    row = stmt.get();
  }

  if (row && row.details) {
    row.details = safeJsonParse(row.details, null);
  }
  return row;
}

/**
 * Get health check history
 */
function getHealthHistory(options = {}) {
  const checkType = options.checkType;
  const limit = options.limit || 50;

  let stmt;
  let rows;

  if (checkType) {
    stmt = db.prepare(`
      SELECT * FROM health_status
      WHERE check_type = ?
      ORDER BY checked_at DESC
      LIMIT ?
    `);
    rows = stmt.all(checkType, limit);
  } else {
    stmt = db.prepare(`
      SELECT * FROM health_status
      ORDER BY checked_at DESC
      LIMIT ?
    `);
    rows = stmt.all(limit);
  }

  return rows.map(row => ({
    ...row,
    details: safeJsonParse(row.details, null)
  }));
}

/**
 * Get health summary (all types)
 */
function getHealthSummary() {
  const types = db.prepare(`
    SELECT DISTINCT check_type FROM health_status
  `).all();

  const summary = {};
  for (const { check_type } of types) {
    const latest = getLatestHealthCheck(check_type);
    const history = getHealthHistory({ checkType: check_type, limit: 10 });

    // Calculate uptime percentage from recent checks
    const successCount = history.filter(h => h.status === 'healthy').length;
    const uptimePercent = history.length > 0 ? Math.round((successCount / history.length) * 100) : 0;

    // Calculate average response time
    const responseTimes = history.filter(h => h.response_time_ms).map(h => h.response_time_ms);
    const avgResponseTime = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : 0;

    summary[check_type] = {
      status: latest ? latest.status : 'unknown',
      lastCheck: latest ? latest.checked_at : null,
      uptimePercent,
      avgResponseTime,
      lastError: latest && latest.status !== 'healthy' ? latest.error_message : null
    };
  }

  return summary;
}

/**
 * Cleanup old health records (keep last N days)
 * Pre-calculates cutoff time to avoid race conditions with concurrent cleanup
 */
function cleanupHealthHistory(daysToKeep = 7) {
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(parseInt(daysToKeep, 10) || 7, 3650));

  // Pre-calculate cutoff time to ensure consistent behavior
  // and avoid race conditions when multiple cleanups run concurrently
  const cutoffMs = Date.now() - (boundedDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs).toISOString();

  const stmt = db.prepare(`
    DELETE FROM health_status
    WHERE checked_at < ?
  `);
  const result = stmt.run(cutoffDate);
  return result.changes;
}

/**
 * Purge rows from high-growth tables that are not covered by user-configured
 * log retention settings. These tables grow continuously and must always be
 * trimmed regardless of whether cleanup_log_days is set.
 *
 * - coordination_events:   retain 7 days
 * - health_status:         retain 7 days
 * - task_file_writes:      retain 30 days (no FK constraint -- no cascade delete)
 * - quota_daily_usage: retain 90 days (aggregated usage metrics)
 * - task-file-write-snapshots/: disk files older than 30 days (content-addressed
 *   JSON blobs written by file-tracking.js conflict detection)
 *
 * @param {object} dbInstance - better-sqlite3 Database instance
 * @param {object} [opts]
 * @param {string} [opts.dataDir] - Override data directory for snapshot cleanup
 *   (defaults to centralized data-dir resolution)
 * @returns {{ coordination_events: number, health_status: number, task_file_writes: number, quota_daily_usage: number, snapshot_files: number }}
 */
function purgeGrowthTables(dbInstance, opts = {}) {
  const conn = dbInstance || db;
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();

  const deleted = {
    coordination_events: 0,
    health_status: 0,
    task_file_writes: 0,
    quota_daily_usage: 0,
    snapshot_files: 0,
  };

  try {
    deleted.coordination_events = conn.prepare(
      'DELETE FROM coordination_events WHERE created_at < ?'
    ).run(sevenDaysAgo).changes;
  } catch (_e) { void _e; }

  try {
    deleted.health_status = conn.prepare(
      'DELETE FROM health_status WHERE checked_at < ?'
    ).run(sevenDaysAgo).changes;
  } catch (_e) { void _e; }

  try {
    // task_file_writes has no FK constraint and no created_at column -- use written_at
    deleted.task_file_writes = conn.prepare(
      'DELETE FROM task_file_writes WHERE written_at < ?'
    ).run(thirtyDaysAgo).changes;
  } catch (_e) { void _e; }

  try {
    // quota_daily_usage aggregates daily per-provider request counts.
    // 90 days is sufficient for billing/trend analysis; older rows waste space.
    deleted.quota_daily_usage = conn.prepare(
      'DELETE FROM quota_daily_usage WHERE date < ?'
    ).run(ninetyDaysAgo.slice(0, 10)).changes; // date column is 'YYYY-MM-DD'
  } catch (_e) { void _e; }

  // Purge content-addressed snapshot files older than 30 days from disk.
  // These are written by file-tracking.js recordTaskFileWrite() for conflict detection.
  try {
    const dataDir = opts.dataDir || require('../data-dir').getDataDir();
    const snapshotDir = path.join(dataDir, 'task-file-write-snapshots');
    if (fs.existsSync(snapshotDir)) {
      const cutoffMs = now - 30 * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(snapshotDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(snapshotDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            deleted.snapshot_files++;
          }
        } catch (_fe) { void _fe; }
      }
    }
  } catch (_e) { void _e; }

  return deleted;
}

// ============================================================
// Resource metrics and memory pressure
// ============================================================

/**
 * Get current resource usage metrics
 * Returns memory usage, database size, and table row counts
 */
function getResourceMetrics() {
  const metrics = {
    timestamp: new Date().toISOString(),
    memory: {},
    database: {},
    tables: {}
  };

  // Node.js memory usage
  try {
    const memUsage = process.memoryUsage();
    metrics.memory = {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),    // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),  // MB
      rss: Math.round(memUsage.rss / 1024 / 1024),              // MB
      external: Math.round(memUsage.external / 1024 / 1024),    // MB
      heapUsedPercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
    };
  } catch (err) {
    metrics.memory.error = err.message;
  }

  // Database size
  try {
    const pageCount = db.prepare('PRAGMA page_count').get();
    const pageSize = db.prepare('PRAGMA page_size').get();
    const freelistCount = db.prepare('PRAGMA freelist_count').get();
    metrics.database = {
      sizeBytes: (pageCount?.page_count || 0) * (pageSize?.page_size || 4096),
      sizeMB: Math.round(((pageCount?.page_count || 0) * (pageSize?.page_size || 4096)) / 1024 / 1024 * 10) / 10,
      freePages: freelistCount?.freelist_count || 0
    };
  } catch (err) {
    metrics.database.error = err.message;
  }

  // Key table row counts
  try {
    const ALLOWED_TABLES = new Set(['tasks', 'task_events', 'webhooks', 'webhook_logs', 'health_status', 'audit_log']);
    for (const table of ALLOWED_TABLES) {
      if (!ALLOWED_TABLES.has(table)) throw new Error(`Disallowed table: ${table}`);
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
        metrics.tables[table] = count?.count || 0;
      } catch (_e) {
        void _e;
        // Table might not exist
        metrics.tables[table] = -1;
      }
    }
  } catch (err) {
    metrics.tables.error = err.message;
  }

  return metrics;
}

/**
 * Check if system is under memory pressure
 * Returns { underPressure: boolean, level: string, metrics: object }
 * Levels: 'normal', 'warning', 'critical'
 */
function checkMemoryPressure() {
  const memUsage = process.memoryUsage();
  const heapPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  const rssMB = memUsage.rss / 1024 / 1024;

  // Configurable thresholds (defaults: warning at 70%, critical at 85%)
  const warningThreshold = parseInt(_deps.getConfig('memory_warning_percent') || '70', 10);
  const criticalThreshold = parseInt(_deps.getConfig('memory_critical_percent') || '85', 10);
  const maxRssMB = parseInt(_deps.getConfig('max_rss_mb') || '1024', 10); // 1GB default

  let level = 'normal';
  let underPressure = false;

  if (heapPercent >= criticalThreshold || rssMB >= maxRssMB) {
    level = 'critical';
    underPressure = true;
  } else if (heapPercent >= warningThreshold) {
    level = 'warning';
    underPressure = true;
  }

  return {
    underPressure,
    level,
    metrics: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapPercent: Math.round(heapPercent),
      rssMB: Math.round(rssMB),
      warningThreshold,
      criticalThreshold,
      maxRssMB
    }
  };
}

/**
 * Run emergency cleanup when under critical memory pressure
 * Returns number of records cleaned up
 */
function runEmergencyCleanup() {
  let totalCleaned = 0;

  // Aggressive cleanup of oldest records
  try {
    totalCleaned += cleanupHealthHistory(1);                // Keep only 1 day
    totalCleaned += _deps.cleanupWebhookLogs(1);            // Keep only 1 day
    totalCleaned += _deps.cleanupStreamData(1);             // Keep only 1 day
    totalCleaned += _deps.cleanupCoordinationEvents(1);     // Keep only 1 day

    // Force database cleanup
    db.exec('VACUUM');
  } catch (_err) {
    void _err;
    // Silently handle errors during emergency cleanup
  }

  return totalCleaned;
}

/**
 * Run VACUUM to reclaim disk space and optimize database
 * Should be run during low-activity periods as it can be slow for large databases
 * Returns { success: boolean, sizeBefore?: number, sizeAfter?: number, error?: string }
 */
function vacuum() {
  try {
    // Get size before
    const pageCountBefore = db.prepare('PRAGMA page_count').get();
    const pageSize = db.prepare('PRAGMA page_size').get();
    const sizeBefore = (pageCountBefore?.page_count || 0) * (pageSize?.page_size || 4096);

    // Run VACUUM
    db.exec('VACUUM');

    // Get size after
    const pageCountAfter = db.prepare('PRAGMA page_count').get();
    const sizeAfter = (pageCountAfter?.page_count || 0) * (pageSize?.page_size || 4096);

    return {
      success: true,
      sizeBefore,
      sizeAfter,
      reclaimed: sizeBefore - sizeAfter
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

// Slow query detection constants
const SLOW_QUERY_THRESHOLD_MS = 100;
const MAX_SLOW_QUERY_LOG = 50;
const slowQueryLog = [];

/**
 * Execute a query with timing and slow query detection
 * @param {string} description - Human-readable description of the query
 * @param {Function} queryFn - Function that executes the query
 * @returns The result of queryFn
 */
function timedQuery(description, queryFn) {
  const startTime = Date.now();
  try {
    return queryFn();
  } finally {
    const duration = Date.now() - startTime;
    if (duration >= SLOW_QUERY_THRESHOLD_MS) {
      const entry = {
        description,
        durationMs: duration,
        timestamp: new Date().toISOString()
      };
      slowQueryLog.push(entry);
      if (slowQueryLog.length > MAX_SLOW_QUERY_LOG) {
        slowQueryLog.shift(); // Remove oldest
      }
    }
  }
}

/**
 * Comprehensive database health check
 * Returns detailed health metrics and diagnostics
 */
function getDatabaseHealth() {
  const health = {
    timestamp: new Date().toISOString(),
    status: 'healthy',
    checks: {},
    metrics: {},
    warnings: []
  };

  // Check 1: Database connectivity
  try {
    db.prepare('SELECT 1').get();
    health.checks.connectivity = { status: 'pass', message: 'Database is responsive' };
  } catch (err) {
    health.checks.connectivity = { status: 'fail', message: err.message };
    health.status = 'unhealthy';
  }

  // Check 2: Integrity check (quick version)
  try {
    const integrityResult = db.prepare('PRAGMA quick_check(1)').get();
    if (integrityResult?.quick_check === 'ok') {
      health.checks.integrity = { status: 'pass', message: 'Database integrity OK' };
    } else {
      health.checks.integrity = { status: 'warn', message: 'Integrity check returned: ' + JSON.stringify(integrityResult) };
      health.warnings.push('Database integrity check returned unexpected result');
    }
  } catch (err) {
    health.checks.integrity = { status: 'fail', message: err.message };
    health.status = 'degraded';
  }

  // Check 3: Database size and fragmentation
  try {
    const pageCount = db.prepare('PRAGMA page_count').get();
    const pageSize = db.prepare('PRAGMA page_size').get();
    const freelistCount = db.prepare('PRAGMA freelist_count').get();

    const totalPages = pageCount?.page_count || 0;
    const freePages = freelistCount?.freelist_count || 0;
    const sizeBytes = totalPages * (pageSize?.page_size || 4096);
    const fragmentation = totalPages > 0 ? (freePages / totalPages * 100).toFixed(1) : 0;

    health.metrics.sizeBytes = sizeBytes;
    health.metrics.sizeMB = Math.round(sizeBytes / 1024 / 1024 * 10) / 10;
    health.metrics.totalPages = totalPages;
    health.metrics.freePages = freePages;
    health.metrics.fragmentationPercent = parseFloat(fragmentation);

    if (fragmentation > 20) {
      health.warnings.push(`High fragmentation (${fragmentation}%) - consider running VACUUM`);
      health.checks.fragmentation = { status: 'warn', message: `${fragmentation}% fragmentation` };
    } else {
      health.checks.fragmentation = { status: 'pass', message: `${fragmentation}% fragmentation` };
    }
  } catch (err) {
    health.checks.size = { status: 'fail', message: err.message };
  }

  // Check 4: Table row counts for key tables
  try {
    const tables = {
      tasks: 'SELECT COUNT(*) as count FROM tasks',
      task_events: 'SELECT COUNT(*) as count FROM task_events',
      webhooks: 'SELECT COUNT(*) as count FROM webhooks',
      webhook_logs: 'SELECT COUNT(*) as count FROM webhook_logs',
      health_status: 'SELECT COUNT(*) as count FROM health_status'
    };

    health.metrics.tableCounts = {};
    for (const [table, query] of Object.entries(tables)) {
      try {
        const result = db.prepare(query).get();
        health.metrics.tableCounts[table] = result?.count || 0;

        // Warn if table is very large
        if (result?.count > 100000) {
          health.warnings.push(`Table '${table}' has ${result.count} rows - consider cleanup`);
        }
      } catch {
        health.metrics.tableCounts[table] = -1; // Table might not exist
      }
    }
    health.checks.tables = { status: 'pass', message: 'Table counts retrieved' };
  } catch (err) {
    health.checks.tables = { status: 'fail', message: err.message };
  }

  // Check 5: Slow queries
  const recentSlowQueries = _deps.getSlowQueries(5);
  health.metrics.recentSlowQueries = recentSlowQueries.length;
  if (recentSlowQueries.length > 0) {
    health.checks.performance = {
      status: 'warn',
      message: `${recentSlowQueries.length} slow queries recently`,
      details: recentSlowQueries
    };
    health.warnings.push(`${recentSlowQueries.length} slow queries detected recently`);
  } else {
    health.checks.performance = { status: 'pass', message: 'No recent slow queries' };
  }

  // Overall status
  const failedChecks = Object.values(health.checks).filter(c => c.status === 'fail').length;
  const warnChecks = Object.values(health.checks).filter(c => c.status === 'warn').length;

  if (failedChecks > 0) {
    health.status = 'unhealthy';
  } else if (warnChecks > 0) {
    health.status = 'degraded';
  }

  return health;
}

// ============================================================
// Module exports
// ============================================================

module.exports = {
  setDb,
  init,
  recordHealthCheck,
  getLatestHealthCheck,
  getHealthHistory,
  getHealthSummary,
  cleanupHealthHistory,
  purgeGrowthTables,
  getResourceMetrics,
  checkMemoryPressure,
  runEmergencyCleanup,
  vacuum,
  timedQuery,
  getDatabaseHealth,
};
