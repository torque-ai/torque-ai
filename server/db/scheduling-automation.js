'use strict';

/**
 * Scheduling & Automation Module
 *
 * Extracted from database.js — templates, maintenance schedules, task scheduling,
 * approval workflows, collaboration & audit, cron/extended scheduling,
 * resource usage tracking, and reporting functions.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setter injection for cross-module dependencies (getTask, recordTaskEvent, etc.)
 *
 * Sub-modules:
 *   - db/approval-workflows.js  — approval rules, requests, auto-approval
 *   - db/cron-scheduling.js     — cron parsing, next-run calculation, scheduled tasks CRUD
 */

let db;
let _getTaskFn;
let getPipelineFn;
let createPipelineFn;
let _auditLogColumnsCache = null;
const { createHash } = require('crypto');
const { safeJsonParse } = require('../utils/json');

const approvalWorkflows = require('./approval-workflows');
const cronScheduling = require('./cron-scheduling');

function setDb(dbInstance) {
  if (dbInstance !== db) { _auditLogColumnsCache = null; }
  db = dbInstance;
  approvalWorkflows.setDb(dbInstance);
  cronScheduling.setDb(dbInstance);
  // Wire recordAuditLog into approval-workflows (defined in this file, needs db to be set)
  approvalWorkflows.setRecordAuditLog(recordAuditLog);
}

function setGetTask(fn) {
  _getTaskFn = fn;
  approvalWorkflows.setGetTask(fn);
}

function setRecordTaskEvent(fn) {
  approvalWorkflows.setRecordTaskEvent(fn);
}

function setGetPipeline(fn) {
  getPipelineFn = fn;
}

function setCreatePipeline(fn) {
  createPipelineFn = fn;
}

function getAuditLogColumns() {
  if (!db) {
    return { chainSupported: false, previousHashColumn: false, chainHashColumn: false };
  }
  if (_auditLogColumnsCache) return _auditLogColumnsCache;

  const pragmaResult = db.prepare('PRAGMA table_info(audit_log)').all();
  const columns = new Set(pragmaResult.map((column) => column.name));

  const hasPreviousHash = columns.has('previous_hash');
  const hasChainHash = columns.has('chain_hash');

  _auditLogColumnsCache = {
    chainSupported: hasPreviousHash && hasChainHash,
    previousHashColumn: hasPreviousHash,
    chainHashColumn: hasChainHash,
  };
  return _auditLogColumnsCache;
}

function getLatestAuditChainHash() {
  const columns = getAuditLogColumns();
  if (!columns.chainSupported) return null;

  const row = db.prepare('SELECT chain_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return row ? row.chain_hash : null;
}

function normalizeAuditField(value) {
  if (value === undefined) return null;
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function computeAuditChainHash(payload) {
  const text = JSON.stringify(payload);
  return createHash('sha256').update(text).digest('hex');
}


// ============================================
// Templates
// ============================================

/**
 * Create or update a template
 * @param {any} template
 * @returns {any}
 */
function saveTemplate(template) {
  const stmt = db.prepare(`
    INSERT INTO templates (
      name, description, task_template, default_timeout,
      default_priority, auto_approve, created_at, usage_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(name) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      task_template = excluded.task_template,
      default_timeout = excluded.default_timeout,
      default_priority = excluded.default_priority,
      auto_approve = excluded.auto_approve,
      usage_count = usage_count
  `);

  stmt.run(
    template.name,
    template.description || null,
    template.task_template,
    template.default_timeout ?? 30,
    template.default_priority || 0,
    template.auto_approve ? 1 : 0,
    new Date().toISOString()
  );

  return getTemplate(template.name);
}

/**
 * Get a template by name
 * @param {any} name
 * @returns {any}
 */
function getTemplate(name) {
  const stmt = db.prepare('SELECT * FROM templates WHERE name = ?');
  const row = stmt.get(name);
  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
  }
  return row;
}

/**
 * List all templates
 * @returns {any}
 */
function listTemplates() {
  const stmt = db.prepare('SELECT * FROM templates ORDER BY usage_count DESC');
  return stmt.all().map(row => ({
    ...row,
    auto_approve: Boolean(row.auto_approve)
  }));
}

/**
 * Increment template usage count
 * @param {any} name
 * @returns {any}
 */
function incrementTemplateUsage(name) {
  const stmt = db.prepare('UPDATE templates SET usage_count = usage_count + 1 WHERE name = ?');
  stmt.run(name);
}

/**
 * Delete a template
 */
function deleteTemplate(name) {
  const stmt = db.prepare('DELETE FROM templates WHERE name = ?');
  const result = stmt.run(name);
  return result.changes > 0;
}

// ============================================
// Maintenance Schedules
// ============================================

/**
 * Create or update a maintenance schedule
 * @param {any} schedule
 * @returns {any}
 */
function setMaintenanceSchedule(schedule) {
  const intervalMinutes = normalizeMaintenanceInterval(schedule);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO maintenance_schedule (id, task_type, schedule_type, interval_minutes, cron_expression, next_run_at, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM maintenance_schedule WHERE id = ?), ?))
  `);

  const now = new Date().toISOString();
  const nextRun = schedule.next_run_at || calculateNextMaintenanceRun(schedule);

  stmt.run(
    schedule.id,
    schedule.task_type,
    schedule.schedule_type,
    intervalMinutes,
    schedule.cron_expression || null,
    nextRun,
    schedule.enabled !== false ? 1 : 0,
    schedule.id,
    now
  );

  return getMaintenanceSchedule(schedule.id);
}

function normalizeMaintenanceInterval(schedule) {
  const isInterval = schedule?.schedule_type === 'interval';
  if (!isInterval) {
    return null;
  }

  if (schedule.interval_minutes === undefined || schedule.interval_minutes === null) {
    throw new Error('INTERVAL_MINUTES_REQUIRED: interval_minutes is required for interval schedules');
  }

  if (
    typeof schedule.interval_minutes !== 'number' ||
    !Number.isFinite(schedule.interval_minutes) ||
    !Number.isInteger(schedule.interval_minutes) ||
    schedule.interval_minutes <= 0
  ) {
    throw new Error('INTERVAL_MINUTES_INVALID: interval_minutes must be a positive integer');
  }

  return schedule.interval_minutes;
}

/**
 * Get a maintenance schedule
 * @param {any} id
 * @returns {any}
 */
function getMaintenanceSchedule(id) {
  const stmt = db.prepare('SELECT * FROM maintenance_schedule WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List maintenance schedules
 * @returns {any}
 */
function listMaintenanceSchedules() {
  return db.prepare('SELECT * FROM maintenance_schedule ORDER BY task_type').all().map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Get due maintenance tasks
 * @returns {any}
 */
function getDueMaintenanceTasks() {
  // Exclude NULL next_run_at — cron schedules with no parser return NULL,
  // and including them would fire the task on every tick
  const stmt = db.prepare(`
    SELECT * FROM maintenance_schedule
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
  `);
  return stmt.all(new Date().toISOString()).map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Mark maintenance task as run
 * @param {any} id
 * @returns {any}
 */
function markMaintenanceRun(id) {
  const schedule = getMaintenanceSchedule(id);
  if (!schedule) return null;

  const nextRun = calculateNextMaintenanceRun(schedule);
  db.prepare('UPDATE maintenance_schedule SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(new Date().toISOString(), nextRun, id);

  return getMaintenanceSchedule(id);
}

/**
 * Calculate next maintenance run time
 */
function calculateNextMaintenanceRun(schedule) {
  if (schedule.schedule_type === 'interval') {
    const intervalMinutes = normalizeMaintenanceInterval(schedule);
    return new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
  }
  // For cron, would need a cron parser - for now just use interval
  return null;
}

/**
 * Delete a maintenance schedule
 */
function deleteMaintenanceSchedule(id) {
  const result = db.prepare('DELETE FROM maintenance_schedule WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================
// Collaboration & Audit
// ============================================

// Comments and Timeline functions are in db/task-metadata.js

/**
 * Record an audit log entry
 * @param {any} entityType
 * @param {any} entityId
 * @param {any} action
 * @param {any} actor
 * @param {any} oldValue
 * @param {any} newValue
 * @param {any} metadata
 * @returns {any}
 */
function recordAuditLog(entityType, entityId, action, actor = 'system', oldValue = null, newValue = null, metadata = null) {
  // Check if auditing is enabled for this action
  const auditEnabled = getAuditConfig('enabled');
  if (auditEnabled === '0') return null;

  const trackedActions = getAuditConfig('tracked_actions');
  if (trackedActions && trackedActions !== '*') {
    const actions = safeJsonParse(trackedActions, []);
    if (Array.isArray(actions) && !actions.includes(action) && !actions.includes('*')) return null;
  }

  const eventTimestamp = new Date().toISOString();
  const normalizedOldValue = normalizeAuditField(oldValue);
  const normalizedNewValue = normalizeAuditField(newValue);
  const normalizedMetadata = normalizeAuditField(metadata);

  const columns = getAuditLogColumns();
  if (columns.chainSupported) {
    const insertChainedAudit = db.transaction(() => {
      const previousHash = getLatestAuditChainHash();
      const chainHash = computeAuditChainHash({
        entityType,
        entityId,
        action,
        actor,
        oldValue: normalizedOldValue,
        newValue: normalizedNewValue,
        metadata: normalizedMetadata,
        previousHash,
        timestamp: eventTimestamp,
      });

      const stmt = db.prepare(`
        INSERT INTO audit_log (entity_type, entity_id, action, actor, old_value, new_value, metadata, previous_hash, chain_hash, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        entityType,
        entityId,
        action,
        actor,
        normalizedOldValue,
        normalizedNewValue,
        normalizedMetadata,
        previousHash,
        chainHash,
        eventTimestamp,
      );

      return result.lastInsertRowid;
    });

    return insertChainedAudit();
  }

  const stmt = db.prepare(`
    INSERT INTO audit_log (entity_type, entity_id, action, actor, old_value, new_value, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    entityType,
    entityId,
    action,
    actor,
    normalizedOldValue,
    normalizedNewValue,
    normalizedMetadata,
    eventTimestamp,
  );

  return result.lastInsertRowid;
}

/**
 * Query audit log
 * @param {any} options
 * @returns {any}
 */
function getAuditLog(options = {}) {
  const { entityType, entityId, action, actor, since, until, limit = 100, offset = 0 } = options;

  let query = `SELECT * FROM audit_log WHERE 1=1`;
  const params = [];

  if (entityType) {
    query += ` AND entity_type = ?`;
    params.push(entityType);
  }

  if (entityId) {
    query += ` AND entity_id = ?`;
    params.push(entityId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (actor) {
    query += ` AND actor = ?`;
    params.push(actor);
  }

  if (since) {
    query += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    query += ` AND timestamp <= ?`;
    params.push(until);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get audit log count for filtering
 * @param {any} options
 * @returns {any}
 */
function getAuditLogCount(options = {}) {
  const { entityType, entityId, action, actor, since, until } = options;

  let query = `SELECT COUNT(*) as count FROM audit_log WHERE 1=1`;
  const params = [];

  if (entityType) {
    query += ` AND entity_type = ?`;
    params.push(entityType);
  }

  if (entityId) {
    query += ` AND entity_id = ?`;
    params.push(entityId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (actor) {
    query += ` AND actor = ?`;
    params.push(actor);
  }

  if (since) {
    query += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    query += ` AND timestamp <= ?`;
    params.push(until);
  }

  const stmt = db.prepare(query);
  return stmt.get(...params).count;
}

/**
 * Export audit log to various formats
 */
function exportAuditLog(options = {}) {
  const { format = 'json', since, until, limit = 10000 } = options;

  const logs = getAuditLog({ since, until, limit });

  if (format === 'json') {
    return JSON.stringify(logs, null, 2);
  }

  if (format === 'csv') {
    if (logs.length === 0) return 'id,entity_type,entity_id,action,actor,old_value,new_value,timestamp\n';

    const headers = ['id', 'entity_type', 'entity_id', 'action', 'actor', 'old_value', 'new_value', 'timestamp'];
    const rows = logs.map(log =>
      headers.map(h => {
        const val = log[h];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
      }).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  return logs;
}

/**
 * Get audit configuration
 * @param {any} key
 * @returns {any}
 */
function getAuditConfig(key) {
  const stmt = db.prepare(`SELECT value FROM audit_config WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * Set audit configuration
 * @param {any} key
 * @param {any} value
 * @returns {any}
 */
function setAuditConfig(key, value) {
  const stmt = db.prepare(`
    INSERT INTO audit_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);
  stmt.run(key, value, value);
  return true;
}

/**
 * Get all audit configuration
 */
function getAllAuditConfig() {
  const stmt = db.prepare(`SELECT * FROM audit_config`);
  const rows = stmt.all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Clean up old audit logs
 */
function cleanupAuditLog(daysToKeep = 90) {
  const retentionDays = getAuditConfig('retention_days');
  const rawDays = retentionDays ? parseInt(retentionDays, 10) : daysToKeep;
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(rawDays || 90, 3650));

  const stmt = db.prepare(`
    DELETE FROM audit_log
    WHERE timestamp < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(boundedDays);
  return result.changes;
}

/**
 * Get audit statistics
 * @param {any} options
 * @returns {any}
 */
function getAuditStats(options = {}) {
  const { since, until } = options;

  let whereClause = '1=1';
  const params = [];

  if (since) {
    whereClause += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    whereClause += ` AND timestamp <= ?`;
    params.push(until);
  }

  const totalStmt = db.prepare(`SELECT COUNT(*) as count FROM audit_log WHERE ${whereClause}`);
  const total = totalStmt.get(...params).count;

  const byEntityStmt = db.prepare(`
    SELECT entity_type, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY entity_type ORDER BY count DESC
  `);
  const byEntity = byEntityStmt.all(...params);

  const byActionStmt = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY action ORDER BY count DESC LIMIT 20
  `);
  const byAction = byActionStmt.all(...params);

  const byActorStmt = db.prepare(`
    SELECT actor, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY actor ORDER BY count DESC LIMIT 10
  `);
  const byActor = byActorStmt.all(...params);

  return { total, byEntity, byAction, byActor };
}

// ============================================
// Resource Usage Tracking
// ============================================

/**
 * Record resource usage for a task
 * @param {any} data
 * @returns {any}
 */
function recordResourceUsage(data) {
  const stmt = db.prepare(`
    INSERT INTO resource_usage (task_id, cpu_percent, memory_mb, disk_io_mb, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.task_id,
    data.cpu_percent || null,
    data.memory_mb || null,
    data.disk_io_mb || null,
    data.timestamp || new Date().toISOString()
  );

  return { id: result.lastInsertRowid };
}

/**
 * Get resource usage for a task
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getResourceUsage(taskId, options = {}) {
  const { limit = 100, start_time, end_time } = options;

  let query = 'SELECT * FROM resource_usage WHERE task_id = ?';
  const params = [taskId];

  if (start_time) {
    query += ' AND timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    query += ' AND timestamp <= ?';
    params.push(end_time);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get aggregated resource usage for a project
 * @param {any} project
 * @param {any} options
 * @returns {any}
 */
function getResourceUsageByProject(project, options = {}) {
  const { start_time, end_time } = options;

  let whereClause = 't.project = ?';
  const params = [project];

  if (start_time) {
    whereClause += ' AND r.timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    whereClause += ' AND r.timestamp <= ?';
    params.push(end_time);
  }

  const stmt = db.prepare(`
    SELECT
      COUNT(DISTINCT r.task_id) as task_count,
      COUNT(r.id) as sample_count,
      AVG(r.cpu_percent) as avg_cpu,
      MAX(r.cpu_percent) as max_cpu,
      AVG(r.memory_mb) as avg_memory,
      MAX(r.memory_mb) as max_memory,
      SUM(r.disk_io_mb) as total_disk_io
    FROM resource_usage r
    JOIN tasks t ON r.task_id = t.id
    WHERE ${whereClause}
  `);

  return stmt.get(...params);
}

/**
 * Set resource limits for a project
 * @param {any} project
 * @param {any} limits
 * @returns {any}
 */
function setResourceLimits(project, limits) {
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO resource_limits (project, max_cpu_percent, max_memory_mb, max_concurrent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET
      max_cpu_percent = COALESCE(excluded.max_cpu_percent, resource_limits.max_cpu_percent),
      max_memory_mb = COALESCE(excluded.max_memory_mb, resource_limits.max_memory_mb),
      max_concurrent = COALESCE(excluded.max_concurrent, resource_limits.max_concurrent),
      updated_at = excluded.updated_at
  `);
  stmt.run(
    project,
    limits.max_cpu_percent !== undefined ? limits.max_cpu_percent : null,
    limits.max_memory_mb !== undefined ? limits.max_memory_mb : null,
    limits.max_concurrent !== undefined ? limits.max_concurrent : null,
    now,
    now
  );

  return getResourceLimits(project);
}

/**
 * Get resource limits for a project
 * @param {any} project
 * @returns {any}
 */
function getResourceLimits(project) {
  const stmt = db.prepare('SELECT * FROM resource_limits WHERE project = ?');
  return stmt.get(project);
}

/**
 * Get all resource limits
 */
function getAllResourceLimits() {
  const stmt = db.prepare('SELECT * FROM resource_limits ORDER BY project');
  return stmt.all();
}

/**
 * Delete resource limits for a project
 */
function deleteResourceLimits(project) {
  const stmt = db.prepare('DELETE FROM resource_limits WHERE project = ?');
  const result = stmt.run(project);
  return result.changes > 0;
}

/**
 * Generate resource usage report
 * @param {any} options
 * @returns {any}
 */
function getResourceReport(options = {}) {
  const { project, start_time, end_time, group_by = 'day' } = options;

  // Build time grouping
  let timeGroup;
  switch (group_by) {
    case 'hour':
      timeGroup = "strftime('%Y-%m-%d %H:00', r.timestamp)";
      break;
    case 'day':
      timeGroup = "strftime('%Y-%m-%d', r.timestamp)";
      break;
    case 'week':
      timeGroup = "strftime('%Y-W%W', r.timestamp)";
      break;
    default:
      timeGroup = "strftime('%Y-%m-%d', r.timestamp)";
  }

  let whereClause = '1=1';
  const params = [];

  if (project) {
    whereClause += ' AND t.project = ?';
    params.push(project);
  }

  if (start_time) {
    whereClause += ' AND r.timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    whereClause += ' AND r.timestamp <= ?';
    params.push(end_time);
  }

  const stmt = db.prepare(`
    SELECT
      ${timeGroup} as period,
      COUNT(DISTINCT r.task_id) as task_count,
      COUNT(r.id) as sample_count,
      ROUND(AVG(r.cpu_percent), 2) as avg_cpu,
      ROUND(MAX(r.cpu_percent), 2) as max_cpu,
      ROUND(AVG(r.memory_mb), 2) as avg_memory,
      ROUND(MAX(r.memory_mb), 2) as max_memory,
      ROUND(SUM(r.disk_io_mb), 2) as total_disk_io
    FROM resource_usage r
    JOIN tasks t ON r.task_id = t.id
    WHERE ${whereClause}
    GROUP BY period
    ORDER BY period DESC
  `);

  return stmt.all(...params);
}

// ============================================
// Reporting & Pipeline Duplication
// ============================================

/**
 * Export tasks report in various formats
 */
function exportTasksReport(options = {}) {
  const { project, status, start_date, end_date, tags, include_output = false } = options;

  let whereClause = '1=1';
  const params = [];

  if (project) {
    whereClause += ' AND project = ?';
    params.push(project);
  }

  if (status) {
    if (Array.isArray(status)) {
      whereClause += ` AND status IN (${status.map(() => '?').join(',')})`;
      params.push(...status);
    } else {
      whereClause += ' AND status = ?';
      params.push(status);
    }
  }

  if (start_date) {
    whereClause += ' AND created_at >= ?';
    params.push(start_date);
  }

  if (end_date) {
    whereClause += ' AND created_at <= ?';
    params.push(end_date);
  }

  // Select columns based on include_output
  const columns = include_output
    ? '*'
    : 'id, status, task_description, project, priority, progress_percent, exit_code, created_at, started_at, completed_at, files_modified';

  const stmt = db.prepare(`
    SELECT ${columns} FROM tasks
    WHERE ${whereClause}
    ORDER BY created_at DESC
  `);

  let tasks = stmt.all(...params);

  // Filter by tags if specified (tags stored as JSON array in tasks.tags column)
  if (tags && tags.length > 0) {
    tasks = tasks.filter(t => {
      if (!t.tags) return false;
      try {
        const taskTags = JSON.parse(t.tags);
        return Array.isArray(taskTags) && tags.some(tag => taskTags.includes(tag));
      } catch { return false; }
    });
  }

  // Get summary stats
  const summary = {
    total: tasks.length,
    by_status: {},
    by_project: {}
  };

  for (const task of tasks) {
    summary.by_status[task.status] = (summary.by_status[task.status] || 0) + 1;
    if (task.project) {
      summary.by_project[task.project] = (summary.by_project[task.project] || 0) + 1;
    }
  }

  return { tasks, summary };
}

/**
 * Clone a pipeline with new parameters
 */
function duplicatePipeline(pipelineId, newName, paramOverrides = {}) {
  const pipeline = getPipelineFn ? getPipelineFn(pipelineId) : null;
  if (!pipeline) return null;

  // Parse and modify the pipeline definition
  const definition = safeJsonParse(pipeline.definition, []);
  if (!Array.isArray(definition)) return null;

  // Apply parameter overrides to each step
  if (paramOverrides.working_directory) {
    definition.forEach(step => {
      step.working_directory = paramOverrides.working_directory;
    });
  }

  if (paramOverrides.auto_approve !== undefined) {
    definition.forEach(step => {
      step.auto_approve = paramOverrides.auto_approve;
    });
  }

  if (paramOverrides.timeout_minutes) {
    definition.forEach(step => {
      step.timeout_minutes = paramOverrides.timeout_minutes;
    });
  }

  // Create new pipeline
  if (createPipelineFn) {
    return createPipelineFn({
      name: newName,
      description: `Clone of ${pipeline.name}${paramOverrides.description ? ': ' + paramOverrides.description : ''}`,
      definition
    });
  }
  return null;
}

// ============================================
// Factory function — one-call DI setup
// ============================================

/**
 * Create a fully-wired scheduling-automation instance.
 * @param {{ db: any, taskCore?: object, recordTaskEvent?: Function, getPipeline?: Function, createPipeline?: Function }} options
 * @returns {object} All public functions from this module
 */
function createSchedulingAutomation({ db: dbInstance, taskCore, recordTaskEvent, getPipeline, createPipeline } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore?.getTask) setGetTask(taskCore.getTask);
  if (recordTaskEvent) setRecordTaskEvent(recordTaskEvent);
  if (getPipeline) setGetPipeline(getPipeline);
  if (createPipeline) setCreatePipeline(createPipeline);
  // Wire recordAuditLog into approval-workflows now that audit section is initialized
  approvalWorkflows.setRecordAuditLog(recordAuditLog);
  return module.exports;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Sub-module spreads first — parent's named exports override any collisions
  ...approvalWorkflows,
  ...cronScheduling,

  // Factory
  createSchedulingAutomation,

  // Dependency injection (parent versions cascade to sub-modules)
  setDb,
  setGetTask,
  setRecordTaskEvent,
  setGetPipeline,
  setCreatePipeline,

  // Templates
  saveTemplate,
  getTemplate,
  listTemplates,
  incrementTemplateUsage,
  deleteTemplate,

  // Maintenance Schedules
  setMaintenanceSchedule,
  getMaintenanceSchedule,
  listMaintenanceSchedules,
  getDueMaintenanceTasks,
  markMaintenanceRun,
  calculateNextMaintenanceRun,
  deleteMaintenanceSchedule,

  // Audit
  getAuditLogColumns,
  recordAuditLog,
  getAuditLog,
  getAuditLogCount,
  exportAuditLog,
  getAuditConfig,
  setAuditConfig,
  getAllAuditConfig,
  cleanupAuditLog,
  getAuditStats,

  // Resource Usage
  recordResourceUsage,
  getResourceUsage,
  getResourceUsageByProject,
  setResourceLimits,
  getResourceLimits,
  getAllResourceLimits,
  deleteResourceLimits,
  getResourceReport,

  // Reporting & Pipeline
  exportTasksReport,
  duplicatePipeline,
};
