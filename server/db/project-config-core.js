/**
 * db/project-config.js — Project management, config, health, budget, dependencies,
 * plan projects, integrations, reports, email, export
 *
 * Extracted from database.js Phase 3 decomposition.
 * Sub-modules: project-cache.js, validation-rules.js (pipeline-management + project-config-cache merged back in)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeJsonParse } = require('../utils/json');

// Cache and validation sub-modules
const projectCache = require('./project-cache');
const validationRules = require('./validation-rules');

// ============================================================
// Dependency injection (set by database.js init)
// ============================================================

let db = null;
let _getTask = null;
let _recordEvent = null;
const _dbFunctions = {};

function setDb(dbInstance) {
  db = dbInstance;
  // Forward to cache + validation sub-modules
  projectCache.setDb(dbInstance);
  validationRules.setDb(dbInstance);
}

function setGetTask(fn) {
  _getTask = fn;
  // Forward to sub-modules that need it
  projectCache.setGetTask(fn);
  validationRules.setGetTask(fn);
}

function setRecordEvent(fn) {
  _recordEvent = fn;
}

function setDbFunctions(fns) {
  Object.assign(_dbFunctions, fns);
  // Forward to project-cache sub-module
  projectCache.setDbFunctions(fns);
}

function getDbInstance() { return db; }

// Proxy helpers for injected functions
function getTask(...args) { return _getTask(...args); }
function getConfig(...args) { return _dbFunctions.getConfig ? _dbFunctions.getConfig(...args) : null; }
function getAllConfig(...args) { return _dbFunctions.getAllConfig ? _dbFunctions.getAllConfig(...args) : {}; }
function escapeLikePattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}
function cleanupWebhookLogs(...args) { return _dbFunctions.cleanupWebhookLogs ? _dbFunctions.cleanupWebhookLogs(...args) : undefined; }
function cleanupStreamData(...args) { return _dbFunctions.cleanupStreamData ? _dbFunctions.cleanupStreamData(...args) : undefined; }
function cleanupCoordinationEvents(...args) { return _dbFunctions.cleanupCoordinationEvents ? _dbFunctions.cleanupCoordinationEvents(...args) : undefined; }
function getRunningCount() { return _dbFunctions.getRunningCount ? _dbFunctions.getRunningCount() : 0; }
function getTokenUsageSummary(...args) { return _dbFunctions.getTokenUsageSummary ? _dbFunctions.getTokenUsageSummary(...args) : {}; }
function getScheduledTask(...args) { return _dbFunctions.getScheduledTask ? _dbFunctions.getScheduledTask(...args) : null; }


// Project root detection constants
const PROJECT_MARKERS = [
  'package.json', '.git', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'CMakeLists.txt', 'Makefile', '.sln', '.csproj',
  'pyproject.toml', 'setup.py', 'requirements.txt', 'Gemfile',
  'composer.json', 'mix.exs', 'build.sbt', 'stack.yaml',
  'deno.json', 'dune-project', 'flake.nix', '.project',
];

// ============================================================
// Project root detection
// ============================================================

/**
 * Find the project root directory by looking for project markers
 * Walks up the directory tree until it finds a marker or reaches root
 */
function findProjectRoot(startDir) {
  if (!startDir) return null;

  let currentDir = path.normalize(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    // Check for any project marker
    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(currentDir, marker);
      if (fs.existsSync(markerPath)) {
        return currentDir;
      }
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached root
    currentDir = parentDir;
  }

  // No marker found, return the original directory
  return startDir;
}

/**
 * Extract project identifier from working directory
 * Uses smart detection to find project root first
 */
function getProjectFromPath(workingDirectory) {
  if (!workingDirectory) return null;

  // Find the project root (smart detection)
  const projectRoot = findProjectRoot(workingDirectory);

  // Get the project name from the root directory
  const projectName = path.basename(projectRoot);

  return projectName || null;
}

/**
 * Get the full project root path
 */
function getProjectRoot(workingDirectory) {
  if (!workingDirectory) return null;
  return findProjectRoot(workingDirectory);
}

// ============================================================
// Budget alerts
// ============================================================

/**
 * Create a budget alert
 */
function createBudgetAlert(alert) {
  const stmt = db.prepare(`
    INSERT INTO budget_alerts (id, project, alert_type, threshold_percent, threshold_value, webhook_id, cooldown_minutes, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    alert.id,
    alert.project || null,
    alert.alert_type,
    alert.threshold_percent,
    alert.threshold_value || null,
    alert.webhook_id || null,
    alert.cooldown_minutes || 60,
    alert.enabled !== false ? 1 : 0,
    new Date().toISOString()
  );

  return getBudgetAlert(alert.id);
}

/**
 * Get a budget alert by ID
 */
function getBudgetAlert(id) {
  const stmt = db.prepare('SELECT * FROM budget_alerts WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List budget alerts
 */
function listBudgetAlerts(options = {}) {
  let query = 'SELECT * FROM budget_alerts';
  const conditions = [];
  const values = [];

  if (options.project) {
    conditions.push('(project = ? OR project IS NULL)');
    values.push(options.project);
  }
  if (options.alert_type) {
    conditions.push('alert_type = ?');
    values.push(options.alert_type);
  }
  if (options.enabled !== undefined) {
    conditions.push('enabled = ?');
    values.push(options.enabled ? 1 : 0);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...values).map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Update budget alert (e.g., last triggered time)
 */
const ALLOWED_BUDGET_ALERT_COLUMNS = new Set([
  'project', 'alert_type', 'threshold_percent', 'threshold_value',
  'webhook_id', 'cooldown_minutes', 'last_triggered_at', 'enabled'
]);

function updateBudgetAlert(id, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_BUDGET_ALERT_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return getBudgetAlert(id);

  values.push(id);
  db.prepare(`UPDATE budget_alerts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getBudgetAlert(id);
}

/**
 * Delete a budget alert
 */
function deleteBudgetAlert(id) {
  const result = db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check budget alerts against current usage
 * @param {string|null} [project=null] - Optional project filter.
 * @returns {Array<object>} Triggered alerts.
 */
function checkBudgetAlerts(project = null) {
  const alerts = listBudgetAlerts({ project, enabled: true });
  const triggered = [];

  for (const alert of alerts) {
    const cooldownOk = !alert.last_triggered_at ||
      (Date.now() - new Date(alert.last_triggered_at).getTime()) > (alert.cooldown_minutes * 60 * 1000);

    if (!cooldownOk) continue;

    let currentValue = 0;
    const thresholdValue = alert.threshold_value;

    if (alert.alert_type === 'daily_cost') {
      const usage = getTokenUsageSummary({ project: alert.project, period: 'day' });
      currentValue = usage.totalCost || 0;
    } else if (alert.alert_type === 'daily_tokens') {
      const usage = getTokenUsageSummary({ project: alert.project, period: 'day' });
      currentValue = usage.totalTokens || 0;
    } else if (alert.alert_type === 'monthly_cost') {
      const usage = getTokenUsageSummary({ project: alert.project, period: 'month' });
      currentValue = usage.totalCost || 0;
    }

    if (thresholdValue && currentValue >= thresholdValue * (alert.threshold_percent / 100)) {
      triggered.push({
        alert,
        currentValue,
        thresholdValue,
        percentUsed: thresholdValue > 0 ? Math.round((currentValue / thresholdValue) * 100) : 0
      });
    }
  }

  return triggered;
}

// ============================================================
// Task dependencies
// ============================================================

/**
 * Check if task dependencies are satisfied
 * @param {string} taskId - Task identifier.
 * @returns {object} Dependency status.
 */
function checkDependencies(taskId) {
  const task = getTask(taskId);
  if (!task || !task.depends_on) return { satisfied: true, pending: [] };

  // depends_on is already parsed by getTask
  const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
  const pending = [];

  for (const depId of dependsOn) {
    const depTask = getTask(depId);
    if (!depTask || depTask.status !== 'completed') {
      pending.push(depId);
    }
  }

  return {
    satisfied: pending.length === 0,
    pending
  };
}

/**
 * Get tasks waiting on a specific task
 */
function getDependentTasks(taskId) {
  // Security: Escape LIKE wildcards to prevent injection using shared helper
  const escapedTaskId = escapeLikePattern(taskId);
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE depends_on LIKE ? ESCAPE '\\'
    AND status IN ('pending', 'queued', 'blocked')
  `);
  return stmt.all(`%${escapedTaskId}%`);
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
    const tables = ['tasks', 'task_events', 'webhooks', 'webhook_logs', 'health_status', 'audit_log'];
    for (const table of tables) {
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
  const warningThreshold = parseInt(getConfig('memory_warning_percent') || '70', 10);
  const criticalThreshold = parseInt(getConfig('memory_critical_percent') || '85', 10);
  const maxRssMB = parseInt(getConfig('max_rss_mb') || '1024', 10); // 1GB default

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
    totalCleaned += cleanupHealthHistory(1);       // Keep only 1 day
    totalCleaned += cleanupWebhookLogs(1);         // Keep only 1 day
    totalCleaned += cleanupStreamData(1);          // Keep only 1 day
    totalCleaned += cleanupCoordinationEvents(1);  // Keep only 1 day

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
  const recentSlowQueries = projectCache.getSlowQueries(5);
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
// Scheduled tasks
// ============================================================

/**
 * Create a scheduled task
 */
function createScheduledTask(schedule) {
  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, priority, tags, schedule_type, cron_expression,
      scheduled_time, repeat_interval_minutes, next_run_at, max_runs,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    schedule.id,
    schedule.name,
    schedule.task_description,
    schedule.working_directory || null,
    schedule.timeout_minutes || 30,
    schedule.auto_approve ? 1 : 0,
    schedule.priority || 0,
    schedule.tags ? JSON.stringify(schedule.tags) : null,
    schedule.schedule_type,
    schedule.cron_expression || null,
    schedule.scheduled_time || null,
    schedule.repeat_interval_minutes || null,
    schedule.next_run_at,
    schedule.max_runs || null,
    'active',
    new Date().toISOString()
  );

  return getScheduledTask(schedule.id);
}

// ============================================================
// Project management
// ============================================================

/**
 * List all projects with task counts and stats
 */
function listProjects() {
  const stmt = db.prepare(`
    SELECT
      project,
      COUNT(*) as task_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status IN ('pending', 'queued', 'running') THEN 1 ELSE 0 END) as active_count,
      MIN(created_at) as first_task_at,
      MAX(created_at) as last_task_at
    FROM tasks
    WHERE project IS NOT NULL
    GROUP BY project
    ORDER BY last_task_at DESC
  `);

  const projects = stmt.all();

  // Also get cost data per project
  const costStmt = db.prepare(`
    SELECT
      project,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost
    FROM token_usage
    WHERE project IS NOT NULL
    GROUP BY project
  `);

  const costData = {};
  for (const row of costStmt.all()) {
    costData[row.project] = {
      total_tokens: row.total_tokens,
      total_cost: row.total_cost
    };
  }

  return projects.map(p => ({
    ...p,
    total_tokens: costData[p.project]?.total_tokens || 0,
    total_cost: costData[p.project]?.total_cost || 0
  }));
}

/**
 * Get detailed stats for a specific project
 */
function getProjectStats(project) {
  // Task counts by status
  const taskStmt = db.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM tasks
    WHERE project = ?
    GROUP BY status
  `);

  const tasksByStatus = {};
  for (const row of taskStmt.all(project)) {
    tasksByStatus[row.status] = row.count;
  }

  // Total tasks
  const totalTasks = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);

  // Recent tasks
  const recentStmt = db.prepare(`
    SELECT id, status, task_description, created_at, completed_at
    FROM tasks
    WHERE project = ?
    ORDER BY created_at DESC
    LIMIT 10
  `);
  const recentTasks = recentStmt.all(project);

  // Cost summary
  const costStmt = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost
    FROM token_usage
    WHERE project = ?
  `);
  const costSummary = costStmt.get(project);

  // Pipelines count
  const pipelineStmt = db.prepare(`
    SELECT COUNT(*) as count FROM pipelines WHERE project = ?
  `);
  const pipelineCount = pipelineStmt.get(project)?.count || 0;

  // Scheduled tasks count
  const scheduledStmt = db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_tasks WHERE project = ?
  `);
  const scheduledCount = scheduledStmt.get(project)?.count || 0;

  // Templates used
  const templateStmt = db.prepare(`
    SELECT template_name, COUNT(*) as count
    FROM tasks
    WHERE project = ? AND template_name IS NOT NULL
    GROUP BY template_name
    ORDER BY count DESC
    LIMIT 5
  `);
  const topTemplates = templateStmt.all(project);

  // Tags used
  const tagStmt = db.prepare(`
    SELECT tags FROM tasks WHERE project = ? AND tags IS NOT NULL
  `);
  const tagCounts = {};
  for (const row of tagStmt.all(project)) {
    try {
      const tags = JSON.parse(row.tags);
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    } catch { /* ignore */ }
  }

  return {
    project,
    total_tasks: totalTasks,
    tasks_by_status: tasksByStatus,
    pipelines: pipelineCount,
    scheduled_tasks: scheduledCount,
    cost: costSummary,
    top_templates: topTemplates,
    top_tags: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
    recent_tasks: recentTasks
  };
}

/**
 * Get current project from a working directory
 */
function getCurrentProject(workingDirectory) {
  return getProjectFromPath(workingDirectory);
}

// ============================================================
// Project configuration
// ============================================================

/**
 * Get project configuration
 */
function getProjectConfig(project) {
  const stmt = db.prepare('SELECT * FROM project_config WHERE project = ?');
  const config = stmt.get(project);

  if (config) {
    config.auto_approve = Boolean(config.auto_approve);
    config.enabled = Boolean(config.enabled);
    config.build_verification_enabled = Boolean(config.build_verification_enabled);
    config.rollback_on_build_failure = Boolean(config.rollback_on_build_failure);
    config.llm_safeguards_enabled = config.llm_safeguards_enabled !== 0;
    config.test_verification_enabled = Boolean(config.test_verification_enabled);
    config.rollback_on_test_failure = Boolean(config.rollback_on_test_failure);
    config.style_check_enabled = Boolean(config.style_check_enabled);
    config.auto_pr_enabled = Boolean(config.auto_pr_enabled);
  }

  return config;
}

/**
 * Set project configuration (creates or updates)
 */
function setProjectConfig(project, config) {
  const now = new Date().toISOString();

  const existing = getProjectConfig(project);

  if (existing) {
    // Update existing config
    const updates = [];
    const values = [];

    if (config.max_concurrent !== undefined) {
      updates.push('max_concurrent = ?');
      values.push(config.max_concurrent);
    }
    if (config.max_daily_cost !== undefined) {
      updates.push('max_daily_cost = ?');
      values.push(config.max_daily_cost);
    }
    if (config.max_daily_tokens !== undefined) {
      updates.push('max_daily_tokens = ?');
      values.push(config.max_daily_tokens);
    }
    if (config.default_timeout !== undefined) {
      updates.push('default_timeout = ?');
      values.push(config.default_timeout);
    }
    if (config.default_priority !== undefined) {
      updates.push('default_priority = ?');
      values.push(config.default_priority);
    }
    if (config.auto_approve !== undefined) {
      updates.push('auto_approve = ?');
      values.push(config.auto_approve ? 1 : 0);
    }
    if (config.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(config.enabled ? 1 : 0);
    }
    if (config.build_verification_enabled !== undefined) {
      updates.push('build_verification_enabled = ?');
      values.push(config.build_verification_enabled ? 1 : 0);
    }
    if (config.build_command !== undefined) {
      updates.push('build_command = ?');
      values.push(config.build_command);
    }
    if (config.build_timeout !== undefined) {
      updates.push('build_timeout = ?');
      values.push(config.build_timeout);
    }
    if (config.rollback_on_build_failure !== undefined) {
      updates.push('rollback_on_build_failure = ?');
      values.push(config.rollback_on_build_failure ? 1 : 0);
    }
    if (config.llm_safeguards_enabled !== undefined) {
      updates.push('llm_safeguards_enabled = ?');
      values.push(config.llm_safeguards_enabled ? 1 : 0);
    }
    if (config.test_verification_enabled !== undefined) {
      updates.push('test_verification_enabled = ?');
      values.push(config.test_verification_enabled ? 1 : 0);
    }
    if (config.test_command !== undefined) {
      updates.push('test_command = ?');
      values.push(config.test_command);
    }
    if (config.test_timeout !== undefined) {
      updates.push('test_timeout = ?');
      values.push(config.test_timeout);
    }
    if (config.rollback_on_test_failure !== undefined) {
      updates.push('rollback_on_test_failure = ?');
      values.push(config.rollback_on_test_failure ? 1 : 0);
    }
    if (config.style_check_enabled !== undefined) {
      updates.push('style_check_enabled = ?');
      values.push(config.style_check_enabled ? 1 : 0);
    }
    if (config.style_check_command !== undefined) {
      updates.push('style_check_command = ?');
      values.push(config.style_check_command);
    }
    if (config.style_check_timeout !== undefined) {
      updates.push('style_check_timeout = ?');
      values.push(config.style_check_timeout);
    }
    if (config.auto_pr_enabled !== undefined) {
      updates.push('auto_pr_enabled = ?');
      values.push(config.auto_pr_enabled ? 1 : 0);
    }
    if (config.auto_pr_base_branch !== undefined) {
      updates.push('auto_pr_base_branch = ?');
      values.push(config.auto_pr_base_branch);
    }
    if (config.default_provider !== undefined) {
      updates.push('default_provider = ?');
      values.push(config.default_provider);
    }
    if (config.default_model !== undefined) {
      updates.push('default_model = ?');
      values.push(config.default_model);
    }
    if (config.verify_command !== undefined) {
      updates.push('verify_command = ?');
      values.push(config.verify_command);
    }
    if (config.auto_fix_enabled !== undefined) {
      updates.push('auto_fix_enabled = ?');
      values.push(config.auto_fix_enabled ? 1 : 0);
    }
    if (config.test_pattern !== undefined) {
      updates.push('test_pattern = ?');
      values.push(config.test_pattern);
    }
    if (config.auto_verify_on_completion !== undefined) {
      updates.push('auto_verify_on_completion = ?');
      values.push(config.auto_verify_on_completion);
    }
    if (config.remote_agent_id !== undefined) {
      updates.push('remote_agent_id = ?');
      values.push(config.remote_agent_id);
    }
    if (config.remote_project_path !== undefined) {
      updates.push('remote_project_path = ?');
      values.push(config.remote_project_path);
    }
    if (config.prefer_remote_tests !== undefined) {
      updates.push('prefer_remote_tests = ?');
      values.push(config.prefer_remote_tests);
    }
    if (config.economy_policy !== undefined) {
      updates.push('economy_policy = ?');
      values.push(config.economy_policy);
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(project);

    if (updates.length > 1) {
      const stmt = db.prepare(`UPDATE project_config SET ${updates.join(', ')} WHERE project = ?`);
      stmt.run(...values);
    }
  } else {
    // Create new config
    const stmt = db.prepare(`
      INSERT INTO project_config (
        project, max_concurrent, max_daily_cost, max_daily_tokens,
        default_timeout, default_priority, auto_approve, enabled,
        build_verification_enabled, build_command, build_timeout, rollback_on_build_failure,
        llm_safeguards_enabled,
        test_verification_enabled, test_command, test_timeout, rollback_on_test_failure,
        style_check_enabled, style_check_command, style_check_timeout,
        auto_pr_enabled, auto_pr_base_branch,
        default_provider, default_model, verify_command, auto_fix_enabled, test_pattern,
        auto_verify_on_completion, remote_agent_id, remote_project_path, prefer_remote_tests,
        economy_policy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      project,
      config.max_concurrent || 0,
      config.max_daily_cost || 0,
      config.max_daily_tokens || 0,
      config.default_timeout || 30,
      config.default_priority || 0,
      config.auto_approve ? 1 : 0,
      config.enabled !== false ? 1 : 0,
      config.build_verification_enabled ? 1 : 0,
      config.build_command || null,
      config.build_timeout || 120,
      config.rollback_on_build_failure !== false ? 1 : 0,
      config.llm_safeguards_enabled !== false ? 1 : 0,
      config.test_verification_enabled ? 1 : 0,
      config.test_command || null,
      config.test_timeout || 300,
      config.rollback_on_test_failure ? 1 : 0,
      config.style_check_enabled ? 1 : 0,
      config.style_check_command || null,
      config.style_check_timeout || 60,
      config.auto_pr_enabled ? 1 : 0,
      config.auto_pr_base_branch || 'main',
      config.default_provider || null,
      config.default_model || null,
      config.verify_command || null,
      config.auto_fix_enabled ? 1 : 0,
      config.test_pattern || null,
      config.auto_verify_on_completion !== undefined ? (config.auto_verify_on_completion ? 1 : 0) : null,
      config.remote_agent_id || null,
      config.remote_project_path || null,
      config.prefer_remote_tests !== undefined ? (config.prefer_remote_tests ? 1 : 0) : 0,
      config.economy_policy || null,
      now,
      now
    );
  }

  return getProjectConfig(project);
}

// ============================================================
// Project metadata
// ============================================================

/**
 * Set project metadata (key-value storage for project-specific settings)
 */
function setProjectMetadata(project, key, value) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO project_metadata (project, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(project, key, value, now);
  return { project, key, value };
}

/**
 * Get project metadata by key
 */
function getProjectMetadata(project, key) {
  const stmt = db.prepare('SELECT value FROM project_metadata WHERE project = ? AND key = ?');
  const row = stmt.get(project, key);
  return row?.value || null;
}

/**
 * Get all metadata for a project
 */
function getAllProjectMetadata(project) {
  const stmt = db.prepare('SELECT key, value FROM project_metadata WHERE project = ?');
  const rows = stmt.all(project);
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================
// Project quotas and concurrency
// ============================================================

/**
 * Get count of running tasks for a project
 */
function getProjectRunningCount(project) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE project = ? AND status = 'running'
  `);
  return stmt.get(project)?.count || 0;
}

/**
 * Get today's usage for a project (for quota checking)
 */
function getProjectDailyUsage(project) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as cost
    FROM token_usage
    WHERE project = ? AND date(recorded_at) = ?
  `);

  return stmt.get(project, today) || { tokens: 0, cost: 0 };
}

/**
 * Check if a project can start a new task (quota and concurrency check)
 * @param {string} project - Project identifier.
 * @returns {object} Eligibility result.
 */
function canProjectStartTask(project) {
  const config = getProjectConfig(project);
  const globalConfig = getAllConfig();
  const globalMax = parseInt(globalConfig.max_concurrent) || 10;
  const defaultProjectMax = parseInt(globalConfig.default_project_max_concurrent) || 3;

  // Check if project is enabled
  if (config && !config.enabled) {
    return { allowed: false, reason: 'Project is disabled' };
  }

  // Check project-specific concurrency limit (use default if not explicitly set)
  const projectMax = (config && config.max_concurrent > 0) ? config.max_concurrent : defaultProjectMax;
  const running = getProjectRunningCount(project);
  if (running >= projectMax) {
    return {
      allowed: false,
      reason: `Project concurrency limit reached (${running}/${projectMax})`
    };
  }

  // Check global concurrency limit
  const globalRunning = getRunningCount();
  if (globalRunning >= globalMax) {
    return {
      allowed: false,
      reason: `Global concurrency limit reached (${globalRunning}/${globalMax})`
    };
  }

  // Check daily quotas
  if (config && (config.max_daily_cost > 0 || config.max_daily_tokens > 0)) {
    const usage = getProjectDailyUsage(project);

    if (config.max_daily_cost > 0 && usage.cost >= config.max_daily_cost) {
      return {
        allowed: false,
        reason: `Daily cost limit reached ($${usage.cost.toFixed(2)}/$${config.max_daily_cost.toFixed(2)})`
      };
    }

    if (config.max_daily_tokens > 0 && usage.tokens >= config.max_daily_tokens) {
      return {
        allowed: false,
        reason: `Daily token limit reached (${usage.tokens}/${config.max_daily_tokens})`
      };
    }
  }

  return { allowed: true };
}

/**
 * List all project configurations
 */
function listProjectConfigs() {
  const stmt = db.prepare('SELECT * FROM project_config ORDER BY project');
  const configs = stmt.all();

  return configs.map(c => ({
    ...c,
    auto_approve: Boolean(c.auto_approve),
    enabled: Boolean(c.enabled)
  }));
}

/**
 * Delete project configuration
 */
function deleteProjectConfig(project) {
  const stmt = db.prepare('DELETE FROM project_config WHERE project = ?');
  const result = stmt.run(project);
  return result.changes > 0;
}

/**
 * Get effective config for a project (merges project config with defaults)
 */
function getEffectiveProjectConfig(project) {
  const projConfig = getProjectConfig(project);
  const globalConfig = getAllConfig();
  const defaultProjectMax = parseInt(globalConfig.default_project_max_concurrent) || 3;

  return {
    project,
    max_concurrent: projConfig?.max_concurrent || defaultProjectMax, // Use default if not set
    max_daily_cost: projConfig?.max_daily_cost || 0, // 0 means unlimited
    max_daily_tokens: projConfig?.max_daily_tokens || 0, // 0 means unlimited
    default_timeout: projConfig?.default_timeout || parseInt(globalConfig.default_timeout) || 30,
    default_priority: projConfig?.default_priority || 0,
    auto_approve: projConfig?.auto_approve || false,
    enabled: projConfig?.enabled !== false,
    global_max_concurrent: parseInt(globalConfig.max_concurrent) || 10,
    default_project_max_concurrent: defaultProjectMax
  };
}

// ============================================================
// Reports and integrations
// ============================================================

/**
 * Create a report export record
 */
function createReportExport(reportType, format, filters = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO report_exports (id, report_type, format, filters, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, reportType, filters ? JSON.stringify(filters) : null, format, now);

  return { id, report_type: reportType, format, status: 'pending', created_at: now };
}

/**
 * Update report export status
 */
function updateReportExport(id, status, filePath = null, fileSize = null, rowCount = null, error = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE report_exports SET
      status = ?,
      file_path = COALESCE(?, file_path),
      file_size_bytes = COALESCE(?, file_size_bytes),
      row_count = COALESCE(?, row_count),
      error = ?,
      completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(status, filePath, fileSize, rowCount, error, status, now, id);
}

/**
 * Get report export
 */
function getReportExport(id) {
  return db.prepare('SELECT * FROM report_exports WHERE id = ?').get(id);
}

/**
 * List report exports
 */
function listReportExports(limit = 50) {
  return db.prepare(`
    SELECT * FROM report_exports ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Record integration health check
 */
function recordIntegrationHealth(integrationType, integrationId, status, latencyMs = null, errorMessage = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integration_health (integration_type, integration_id, status, latency_ms, error_message, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(integrationType, integrationId, status, latencyMs, errorMessage, now);
}

/**
 * Get integration health history
 */
function getIntegrationHealthHistory(integrationType = null, limit = 50) {
  if (integrationType) {
    return db.prepare(`
      SELECT * FROM integration_health WHERE integration_type = ? ORDER BY checked_at DESC LIMIT ?
    `).all(integrationType, limit);
  }
  return db.prepare(`
    SELECT * FROM integration_health ORDER BY checked_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get latest health status for each integration
 */
function getLatestIntegrationHealth() {
  return db.prepare(`
    SELECT ih.*
    FROM integration_health ih
    INNER JOIN (
      SELECT integration_type, integration_id, MAX(checked_at) as max_checked
      FROM integration_health
      GROUP BY integration_type, integration_id
    ) latest ON ih.integration_type = latest.integration_type
      AND ih.integration_id = latest.integration_id
      AND ih.checked_at = latest.max_checked
  `).all();
}

/**
 * Record integration test
 */
function recordIntegrationTest(integrationType, integrationId, testType, status, requestPayload = null, responseData = null, error = null, latencyMs = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO integration_tests (id, integration_type, integration_id, test_type, status, request_payload, response_data, error, latency_ms, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, integrationType, integrationId, testType, status, requestPayload, responseData, error, latencyMs, now);

  return { id, status, latency_ms: latencyMs };
}

/**
 * Get integration tests
 */
function getIntegrationTests(integrationType = null, limit = 50) {
  if (integrationType) {
    return db.prepare(`
      SELECT * FROM integration_tests WHERE integration_type = ? ORDER BY tested_at DESC LIMIT ?
    `).all(integrationType, limit);
  }
  return db.prepare(`
    SELECT * FROM integration_tests ORDER BY tested_at DESC LIMIT ?
  `).all(limit);
}

// ============================================================
// GitHub issues
// ============================================================

/**
 * Create GitHub issue link
 */
function createGitHubIssue(taskId, repo, issueNumber, issueUrl, title) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO github_issues (id, task_id, repo, issue_number, issue_url, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, taskId, repo, issueNumber, issueUrl, title, now);

  return { id, task_id: taskId, repo, issue_number: issueNumber, issue_url: issueUrl };
}

/**
 * Get GitHub issues for task
 */
function getGitHubIssuesForTask(taskId) {
  return db.prepare('SELECT * FROM github_issues WHERE task_id = ?').all(taskId);
}

/**
 * List GitHub issues
 */
function listGitHubIssues(repo = null, limit = 50) {
  if (repo) {
    return db.prepare(`
      SELECT * FROM github_issues WHERE repo = ? ORDER BY created_at DESC LIMIT ?
    `).all(repo, limit);
  }
  return db.prepare(`
    SELECT * FROM github_issues ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ============================================================
// Export
// ============================================================

/**
 * Export tasks to CSV format
 */
function exportTasksToCSV(filters = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.project) {
    query += ' AND project = ?';
    params.push(filters.project);
  }
  if (filters.from_date) {
    query += ' AND created_at >= ?';
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    query += ' AND created_at <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(filters.limit || 10000);

  const tasks = db.prepare(query).all(...params);

  // Convert to CSV
  if (tasks.length === 0) {
    return { csv: '', row_count: 0 };
  }

  const headers = Object.keys(tasks[0]);
  const csvLines = [headers.join(',')];

  for (const task of tasks) {
    const values = headers.map(h => {
      const val = task[h];
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
    });
    csvLines.push(values.join(','));
  }

  return { csv: csvLines.join('\n'), row_count: tasks.length };
}

/**
 * Export tasks to JSON format
 */
function exportTasksToJSON(filters = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.project) {
    query += ' AND project = ?';
    params.push(filters.project);
  }
  if (filters.from_date) {
    query += ' AND created_at >= ?';
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    query += ' AND created_at <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(filters.limit || 10000);

  const tasks = db.prepare(query).all(...params);
  return { json: JSON.stringify(tasks, null, 2), row_count: tasks.length };
}

// ============================================================
// Plan projects
// ============================================================

/**
 * Create a new plan project
 */
function createPlanProject(project) {
  const id = project.id || crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO plan_projects (id, name, description, source_file, status, total_tasks, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `);
  stmt.run(
    id,
    project.name,
    project.description || null,
    project.source_file || null,
    project.total_tasks || 0,
    new Date().toISOString()
  );
  return getPlanProject(id);
}

/**
 * Get plan project by ID
 */
function getPlanProject(projectId) {
  const stmt = db.prepare('SELECT * FROM plan_projects WHERE id = ?');
  return stmt.get(projectId);
}

/**
 * List plan projects with optional filtering
 */
function listPlanProjects(options = {}) {
  let query = 'SELECT * FROM plan_projects WHERE 1=1';
  const values = [];

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...values);
}

/**
 * Update plan project status and counters
 */
function updatePlanProject(projectId, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (['status', 'completed_tasks', 'failed_tasks', 'completed_at', 'total_tasks'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getPlanProject(projectId);

  values.push(projectId);
  const stmt = db.prepare(`UPDATE plan_projects SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getPlanProject(projectId);
}

/**
 * Link a task to a plan project with dependencies
 * @param {string} projectId - Plan project identifier.
 * @param {string} taskId - Task identifier.
 * @param {number} sequenceNumber - Task sequence number.
 * @param {Array<string>} [dependsOn=[]] - Task dependencies within the plan.
 * @returns {void}
 */
function addTaskToPlanProject(projectId, taskId, sequenceNumber, dependsOn = []) {
  const stmt = db.prepare(`
    INSERT INTO plan_project_tasks (project_id, task_id, sequence_number, depends_on)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(projectId, taskId, sequenceNumber, JSON.stringify(dependsOn));
}

/**
 * Get plan project task link
 */
function getPlanProjectTask(taskId) {
  const stmt = db.prepare('SELECT * FROM plan_project_tasks WHERE task_id = ?');
  const row = stmt.get(taskId);
  if (row && row.depends_on) {
    row.depends_on = JSON.parse(row.depends_on);
  }
  return row;
}

/**
 * Get all tasks for a plan project with their dependencies
 */
function getPlanProjectTasks(projectId) {
  const stmt = db.prepare(`
    SELECT pt.*, t.status, t.task_description, t.provider, t.created_at as task_created_at
    FROM plan_project_tasks pt
    JOIN tasks t ON pt.task_id = t.id
    WHERE pt.project_id = ?
    ORDER BY pt.sequence_number
  `);
  const rows = stmt.all(projectId);
  return rows.map(row => ({
    ...row,
    depends_on: safeJsonParse(row.depends_on, [])
  }));
}

/**
 * Get tasks that depend on a given task (within same plan project)
 */
function getDependentPlanTasks(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask) return [];

  const stmt = db.prepare(`
    SELECT pt.task_id, pt.depends_on
    FROM plan_project_tasks pt
    WHERE pt.project_id = ?
  `);
  const rows = stmt.all(projectTask.project_id);

  // Find tasks where depends_on includes this taskId
  return rows.filter(row => {
    const deps = safeJsonParse(row.depends_on, []);
    return deps.includes(taskId);
  }).map(row => row.task_id);
}

/**
 * Check if all dependencies of a plan project task are completed
 * @param {string} taskId - Task identifier.
 * @returns {boolean} True when all dependencies are completed.
 */
function areAllPlanDependenciesComplete(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask || !projectTask.depends_on || projectTask.depends_on.length === 0) {
    return true;
  }

  for (const depTaskId of projectTask.depends_on) {
    const depTask = getTask(depTaskId);
    if (!depTask || depTask.status !== 'completed') {
      return false;
    }
  }
  return true;
}

/**
 * Check if any dependency of a plan project task has failed
 */
function hasFailedPlanDependency(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask || !projectTask.depends_on || projectTask.depends_on.length === 0) {
    return false;
  }

  for (const depTaskId of projectTask.depends_on) {
    const depTask = getTask(depTaskId);
    if (depTask && (depTask.status === 'failed' || depTask.status === 'blocked')) {
      return true;
    }
  }
  return false;
}

/**
 * Delete a plan project and its task associations
 * @param {string} projectId
 */
function deletePlanProject(projectId) {
  const delTasks = db.prepare('DELETE FROM plan_project_tasks WHERE project_id = ?');
  const delProject = db.prepare('DELETE FROM plan_projects WHERE id = ?');
  delTasks.run(projectId);
  delProject.run(projectId);
}

// ============================================================
// Retry management (merged from project-config-cache.js)
// ============================================================

function incrementRetry(taskId) {
  const result = db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?').run(taskId);
  if (result.changes === 0) {
    return null;
  }

  const task = getTask(taskId);
  if (!task) return null;

  return {
    retryCount: task.retry_count,
    maxRetries: task.max_retries,
    shouldRetry: task.retry_count <= task.max_retries
  };
}

function configureTaskRetry(taskId, config) {
  const updates = [];
  const values = [];

  if (config.max_retries !== undefined) {
    updates.push('max_retries = ?');
    values.push(config.max_retries);
  }
  if (config.retry_strategy) {
    updates.push('retry_strategy = ?');
    values.push(config.retry_strategy);
  }
  if (config.retry_delay_seconds !== undefined) {
    updates.push('retry_delay_seconds = ?');
    values.push(config.retry_delay_seconds);
  }

  if (updates.length === 0) return getTask(taskId);

  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getTask(taskId);
}

function recordRetryAttempt(taskId, attempt) {
  const stmt = db.prepare(`
    INSERT INTO retry_history (task_id, attempt_number, delay_used, error_message, prompt_modification, retried_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    taskId,
    attempt.attempt_number,
    attempt.delay_used || 0,
    attempt.error_message || null,
    attempt.prompt_modification || null,
    new Date().toISOString()
  );

  db.prepare('UPDATE tasks SET last_retry_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
}

function getRetryHistory(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM retry_history WHERE task_id = ? ORDER BY attempt_number ASC
  `);
  return stmt.all(taskId);
}

function calculateRetryDelay(task) {
  const baseDelay = task.retry_delay_seconds || 30;
  const retryCount = task.retry_count || 0;
  const strategy = task.retry_strategy || 'exponential';

  const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
  const MAX_EXPONENT = 20;

  let delay;
  switch (strategy) {
    case 'exponential': {
      const boundedExponent = Math.min(retryCount, MAX_EXPONENT);
      delay = baseDelay * Math.pow(2, boundedExponent);
      break;
    }
    case 'linear':
      delay = baseDelay * (retryCount + 1);
      break;
    case 'fixed':
    default:
      delay = baseDelay;
      break;
  }

  return Math.min(delay, MAX_DELAY_SECONDS);
}

// ============================================================
// Pipeline CRUD (merged from pipeline-management.js)
// ============================================================

/**
 * Create a new pipeline
 */
function createPipeline(pipeline) {
  const stmt = db.prepare(`
    INSERT INTO pipelines (id, name, description, status, working_directory, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    pipeline.id,
    pipeline.name,
    pipeline.description || null,
    'pending',
    pipeline.working_directory || null,
    new Date().toISOString()
  );

  if (_recordEvent) _recordEvent('pipeline_created', pipeline.id, { name: pipeline.name });
  return getPipeline(pipeline.id);
}

/**
 * Get a pipeline by ID
 */
function getPipeline(id) {
  const stmt = db.prepare('SELECT * FROM pipelines WHERE id = ?');
  const pipeline = stmt.get(id);
  if (pipeline) {
    pipeline.steps = getPipelineSteps(id);
  }
  return pipeline;
}

/**
 * Add a step to a pipeline
 * @param {object} step - Pipeline step payload.
 * @returns {Array<object>} Updated pipeline steps.
 */
function addPipelineStep(step) {
  // Get next step order
  const maxOrder = db.prepare(
    'SELECT MAX(step_order) as max FROM pipeline_steps WHERE pipeline_id = ?'
  ).get(step.pipeline_id);

  const stepOrder = step.step_order !== undefined ? step.step_order : (maxOrder.max || 0) + 1;

  const stmt = db.prepare(`
    INSERT INTO pipeline_steps (pipeline_id, step_order, name, task_template, condition, timeout_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  stmt.run(
    step.pipeline_id,
    stepOrder,
    step.name,
    step.task_template,
    step.condition || null,
    step.timeout_minutes || 30
  );

  return getPipelineSteps(step.pipeline_id);
}

/**
 * Get all steps for a pipeline
 */
function getPipelineSteps(pipelineId) {
  const stmt = db.prepare(
    'SELECT * FROM pipeline_steps WHERE pipeline_id = ? ORDER BY step_order ASC'
  );
  return stmt.all(pipelineId).map(step => ({
    ...step,
    output_vars: safeJsonParse(step.output_vars, null)
  }));
}

/**
 * Update pipeline status
 */
function updatePipelineStatus(id, status, additionalFields = {}) {
  const updates = ['status = ?'];
  const values = [status];

  if (status === 'running' && !additionalFields.started_at) {
    updates.push('started_at = ?');
    values.push(new Date().toISOString());
  }

  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    updates.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  for (const [key, value] of Object.entries(additionalFields)) {
    updates.push(`${key} = ?`);
    values.push(value);
  }

  values.push(id);

  const stmt = db.prepare(`UPDATE pipelines SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getPipeline(id);
}

/**
 * Update pipeline step
 */
function updatePipelineStep(stepId, updates) {
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?`);
    if (key === 'output_vars') {
      values.push(JSON.stringify(value));
    } else {
      values.push(value);
    }
  }

  values.push(stepId);

  const stmt = db.prepare(`UPDATE pipeline_steps SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

/**
 * Atomic pipeline step status transition to prevent race conditions
 * @param {number} stepId - Pipeline step ID
 * @param {string} fromStatus - Expected current status (or array of valid statuses)
 * @param {string} toStatus - Target status
 * @param {Object} additionalUpdates - Additional fields to update
 * @returns {boolean} True if transition succeeded, false if status didn't match
 */
function transitionPipelineStepStatus(stepId, fromStatus, toStatus, additionalUpdates = {}) {
  const fields = ['status = ?'];
  const values = [toStatus];

  // Add additional updates
  for (const [key, value] of Object.entries(additionalUpdates)) {
    if (key === 'output_vars') {
      fields.push('output_vars = ?');
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(stepId);

  // Build WHERE clause for atomic transition
  let whereClause;
  if (Array.isArray(fromStatus)) {
    const placeholders = fromStatus.map(() => '?').join(', ');
    whereClause = `id = ? AND status IN (${placeholders})`;
    values.push(...fromStatus);
  } else {
    whereClause = `id = ? AND status = ?`;
    values.push(fromStatus);
  }

  const stmt = db.prepare(`UPDATE pipeline_steps SET ${fields.join(', ')} WHERE ${whereClause}`);
  const result = stmt.run(...values);

  return result.changes > 0;
}

/**
 * List all pipelines
 * Optimized to batch-fetch steps instead of N+1 queries
 */
function listPipelines(options = {}) {
  let query = 'SELECT * FROM pipelines';
  const values = [];

  if (options.status) {
    query += ' WHERE status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  const pipelines = stmt.all(...values);

  if (pipelines.length === 0) {
    return pipelines;
  }

  // Batch fetch all steps for all pipelines in a single query
  const pipelineIds = pipelines.map(p => p.id);
  const placeholders = pipelineIds.map(() => '?').join(', ');
  const stepsStmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id IN (${placeholders})
    ORDER BY pipeline_id, step_order ASC
  `);
  const allSteps = stepsStmt.all(...pipelineIds);

  // Group steps by pipeline_id
  const stepsByPipeline = new Map();
  for (const step of allSteps) {
    if (!stepsByPipeline.has(step.pipeline_id)) {
      stepsByPipeline.set(step.pipeline_id, []);
    }
    stepsByPipeline.get(step.pipeline_id).push({
      ...step,
      task_template: safeJsonParse(step.task_template, null)
    });
  }

  // Attach steps to each pipeline
  return pipelines.map(p => {
    p.steps = stepsByPipeline.get(p.id) || [];
    return p;
  });
}

/**
 * Get next step to run in a pipeline
 */
function getNextPipelineStep(pipelineId) {
  const stmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND status = 'pending'
    ORDER BY step_order ASC LIMIT 1
  `);
  return stmt.get(pipelineId);
}

/**
 * Add a parallel step to a pipeline
 * @param {object} step - Pipeline step payload.
 * @returns {Array<object>} Updated pipeline steps.
 */
function addParallelPipelineStep(step) {
  const maxOrder = db.prepare(
    'SELECT MAX(step_order) as max FROM pipeline_steps WHERE pipeline_id = ?'
  ).get(step.pipeline_id);

  const stepOrder = step.step_order !== undefined ? step.step_order : (maxOrder.max || 0) + 1;

  const stmt = db.prepare(`
    INSERT INTO pipeline_steps (pipeline_id, step_order, name, task_template, condition, timeout_minutes, status, parallel_group)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  stmt.run(
    step.pipeline_id,
    stepOrder,
    step.name,
    step.task_template,
    step.condition || 'on_success',
    step.timeout_minutes || 30,
    step.parallel_group || null
  );

  return getPipelineSteps(step.pipeline_id);
}

/**
 * Get steps in a parallel group
 */
function getParallelGroupSteps(pipelineId, parallelGroup) {
  const stmt = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND parallel_group = ?
    ORDER BY step_order ASC
  `);
  return stmt.all(pipelineId, parallelGroup);
}

/**
 * Check if all steps in a parallel group are completed
 */
function isParallelGroupComplete(pipelineId, parallelGroup) {
  const steps = getParallelGroupSteps(pipelineId, parallelGroup);
  return steps.every(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');
}

/**
 * Get next steps to run (handles both sequential and parallel)
 */
function getNextPipelineSteps(pipelineId) {
  // Get all pending steps
  const pendingSteps = db.prepare(`
    SELECT * FROM pipeline_steps
    WHERE pipeline_id = ? AND status = 'pending'
    ORDER BY step_order ASC
  `).all(pipelineId);

  if (pendingSteps.length === 0) return [];

  const firstStep = pendingSteps[0];

  // If first pending step has a parallel group, return all steps in that group
  if (firstStep.parallel_group) {
    return pendingSteps.filter(s => s.parallel_group === firstStep.parallel_group);
  }

  // Otherwise return just the first step (sequential)
  return [firstStep];
}

/**
 * Reconcile pipeline step status with actual task status
 * Fixes pipelines that are stuck due to cancelled tasks not updating step status
 * Returns count of fixed steps and failed pipelines
 */
function reconcilePipelineStepStatus() {
  const results = { stepsFixed: 0, pipelinesFailed: 0, errors: [] };

  // Find all pipeline steps that are marked as 'running' but their task is not running
  const stuckSteps = db.prepare(`
    SELECT ps.id as step_id, ps.pipeline_id, ps.task_id, ps.status as step_status,
           ps.name as step_name, ps.step_order,
           t.status as task_status, t.error_output,
           p.name as pipeline_name, p.status as pipeline_status
    FROM pipeline_steps ps
    JOIN tasks t ON ps.task_id = t.id
    JOIN pipelines p ON ps.pipeline_id = p.id
    WHERE ps.status = 'running'
      AND t.status IN ('cancelled', 'failed', 'completed')
  `).all();

  for (const step of stuckSteps) {
    try {
      // Determine new step status based on task status
      const newStepStatus = step.task_status === 'completed' ? 'completed' : 'failed';

      // Update the step status
      db.prepare(`UPDATE pipeline_steps SET status = ? WHERE id = ?`)
        .run(newStepStatus, step.step_id);

      results.stepsFixed++;

      // If task failed/cancelled, mark the pipeline as failed
      if (newStepStatus === 'failed' && step.pipeline_status === 'running') {
        const errorMsg = `Step ${step.step_order} (${step.step_name}) ${step.task_status}: ${(step.error_output || 'No error details').slice(0, 200)}`;
        db.prepare(`UPDATE pipelines SET status = 'failed', error = ? WHERE id = ?`)
          .run(errorMsg, step.pipeline_id);
        results.pipelinesFailed++;
      }
    } catch (err) {
      results.errors.push(`Step ${step.step_id}: ${err.message}`);
    }
  }

  return results;
}

// ============================================================
// Module exports — own functions + core-specific DI helpers
// ============================================================
const ownExports = {
  ...projectCache, // Re-export project-cache functions (own DI setters override below)
  setDb,
  setGetTask,
  setRecordEvent,
  setDbFunctions,
  getDbInstance,
  safeJsonParse,
  findProjectRoot,
  getProjectFromPath,
  getProjectRoot,
  createBudgetAlert,
  getBudgetAlert,
  listBudgetAlerts,
  updateBudgetAlert,
  deleteBudgetAlert,
  checkBudgetAlerts,
  checkDependencies,
  getDependentTasks,
  recordHealthCheck,
  getLatestHealthCheck,
  getHealthHistory,
  getHealthSummary,
  cleanupHealthHistory,
  getResourceMetrics,
  checkMemoryPressure,
  runEmergencyCleanup,
  vacuum,
  timedQuery,
  getDatabaseHealth,
  createScheduledTask,
  listProjects,
  getProjectStats,
  getCurrentProject,
  getProjectConfig,
  setProjectConfig,
  setProjectMetadata,
  getProjectMetadata,
  getAllProjectMetadata,
  getProjectRunningCount,
  getProjectDailyUsage,
  canProjectStartTask,
  listProjectConfigs,
  deleteProjectConfig,
  getEffectiveProjectConfig,
  createReportExport,
  updateReportExport,
  getReportExport,
  listReportExports,
  recordIntegrationHealth,
  getIntegrationHealthHistory,
  getLatestIntegrationHealth,
  recordIntegrationTest,
  getIntegrationTests,
  createGitHubIssue,
  getGitHubIssuesForTask,
  listGitHubIssues,
  exportTasksToCSV,
  exportTasksToJSON,
  createPlanProject,
  getPlanProject,
  listPlanProjects,
  updatePlanProject,
  addTaskToPlanProject,
  getPlanProjectTask,
  getPlanProjectTasks,
  getDependentPlanTasks,
  areAllPlanDependenciesComplete,
  hasFailedPlanDependency,
  deletePlanProject,
  // Retry management (merged from project-config-cache.js)
  incrementRetry,
  configureTaskRetry,
  recordRetryAttempt,
  getRetryHistory,
  calculateRetryDelay,
  // Pipeline management (merged from pipeline-management.js)
  createPipeline,
  getPipeline,
  addPipelineStep,
  getPipelineSteps,
  updatePipelineStatus,
  updatePipelineStep,
  transitionPipelineStepStatus,
  listPipelines,
  getNextPipelineStep,
  addParallelPipelineStep,
  getParallelGroupSteps,
  isParallelGroupComplete,
  getNextPipelineSteps,
  reconcilePipelineStepStatus,
};

module.exports = ownExports;
