'use strict';

/**
 * Event Tracking Module
 *
 * Extracted from analytics-metrics.js — event recording, analytics queries,
 * success metrics, format success tracking, output search, export/import.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const { safeJsonParse } = require('../utils/json');

let db;
let getTaskFn;
const dbFunctions = {};

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { getTaskFn = fn; }
function setDbFunctions(fns) { Object.assign(dbFunctions, fns); }

// ============================================
// Local Helpers (shared with analytics-metrics)
// ============================================


/**
 * Escape special LIKE pattern characters to prevent SQL injection
 */
function escapeLikePattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// Analytics
// ============================================

function recordEvent(eventType, taskId = null, data = null) {
  const stmt = db.prepare(`
    INSERT INTO analytics (event_type, task_id, data, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    eventType,
    taskId,
    data ? JSON.stringify(data) : null,
    new Date().toISOString()
  );
}

/**
 * Get analytics summary
 */
function getAnalytics(options = {}) {
  const results = {};

  // Total tasks by status
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM tasks GROUP BY status
  `).all();
  results.tasksByStatus = {};
  for (const row of statusCounts) {
    results.tasksByStatus[row.status] = row.count;
  }

  // Success rate
  const completed = results.tasksByStatus.completed || 0;
  const failed = results.tasksByStatus.failed || 0;
  const total = completed + failed;
  results.successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Average duration for completed tasks
  const avgDuration = db.prepare(`
    SELECT AVG(
      (julianday(completed_at) - julianday(started_at)) * 24 * 60
    ) as avg_minutes
    FROM tasks
    WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
  `).get();
  results.avgDurationMinutes = avgDuration.avg_minutes ? Math.round(avgDuration.avg_minutes * 10) / 10 : 0;

  // Tasks in last 24 hours
  const last24h = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE created_at > datetime('now', '-24 hours')
  `).get();
  results.tasksLast24h = last24h.count;

  // Most used templates
  const topTemplates = db.prepare(`
    SELECT name, usage_count FROM templates
    ORDER BY usage_count DESC LIMIT 5
  `).all();
  results.topTemplates = topTemplates;

  // Recent events
  if (options.includeEvents) {
    const recentEvents = db.prepare(`
      SELECT * FROM analytics
      ORDER BY timestamp DESC LIMIT ?
    `).all(options.eventLimit || 20);
    results.recentEvents = recentEvents.map(e => ({
      ...e,
      data: safeJsonParse(e.data, null)
    }));
  }

  return results;
}

// ============================================
// Success Metrics
// ============================================

/**
 * Record success metrics for a period
 */
function recordSuccessMetrics(metrics) {
  const values = [
    metrics.period_start,
    metrics.period_type,
    metrics.project || null,
    metrics.template || null,
    metrics.total_tasks || 0,
    metrics.successful_tasks || 0,
    metrics.failed_tasks || 0,
    metrics.cancelled_tasks || 0,
    metrics.avg_duration_seconds || null,
    new Date().toISOString()
  ];

  // Use upsert to make rollups idempotent when rerun for the same period/project.
  try {
    const upsertStmt = db.prepare(`
      INSERT INTO success_metrics (
        period_start, period_type, project, template,
        total_tasks, successful_tasks, failed_tasks, cancelled_tasks, avg_duration_seconds, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_type, period_start, project) DO UPDATE SET
        template = excluded.template,
        total_tasks = excluded.total_tasks,
        successful_tasks = excluded.successful_tasks,
        failed_tasks = excluded.failed_tasks,
        cancelled_tasks = excluded.cancelled_tasks,
        avg_duration_seconds = excluded.avg_duration_seconds,
        created_at = excluded.created_at
    `);
    upsertStmt.run(...values);
    return;
  } catch (err) {
    // Backward-compatible fallback when the DB schema doesn't include
    // the required UNIQUE constraint yet.
    if (err.message && err.message.includes('ON CONFLICT clause does not match')) {
      db.prepare(`
        DELETE FROM success_metrics
        WHERE period_type = ? AND period_start = ? AND (
          project = ? OR (project IS NULL AND ? IS NULL)
        )
      `).run(metrics.period_type, metrics.period_start, metrics.project || null, metrics.project || null);

      const insertStmt = db.prepare(`
        INSERT INTO success_metrics (period_start, period_type, project, template, total_tasks, successful_tasks, failed_tasks, cancelled_tasks, avg_duration_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(...values);
      return;
    }
    throw err;
  }
}

/**
 * Get success rates grouped by project/template/time
 */
function getSuccessRates(options = {}) {
  // Whitelist allowed GROUP BY columns to prevent SQL injection
  const ALLOWED_GROUP_BY = ['project', 'template', 'period_type', 'period_start'];
  const groupBy = ALLOWED_GROUP_BY.includes(options.groupBy) ? options.groupBy : 'project';

  let query = `
    SELECT
      ${groupBy} as group_key,
      SUM(total_tasks) as total,
      SUM(successful_tasks) as successful,
      SUM(failed_tasks) as failed,
      SUM(cancelled_tasks) as cancelled,
      AVG(avg_duration_seconds) as avg_duration
    FROM success_metrics
    WHERE 1=1
  `;
  const values = [];

  if (options.project) {
    query += ' AND project = ?';
    values.push(options.project);
  }
  if (options.template) {
    query += ' AND template = ?';
    values.push(options.template);
  }
  if (options.period_type) {
    query += ' AND period_type = ?';
    values.push(options.period_type);
  }
  if (options.from_date) {
    query += ' AND period_start >= ?';
    values.push(options.from_date);
  }
  if (options.to_date) {
    query += ' AND period_start <= ?';
    values.push(options.to_date);
  }

  query += ` GROUP BY ${groupBy}`;

  return db.prepare(query).all(...values).map(row => ({
    ...row,
    success_rate: row.total > 0 ? Math.round((row.successful / row.total) * 100) : 0
  }));
}

/**
 * Record a format success/failure for hashline format tracking
 */
function recordFormatSuccess(model, editFormat, success, failureReason, durationSeconds) {
  const stmt = db.prepare(`
    INSERT INTO format_success_rates (model, edit_format, success, failure_reason, duration_seconds, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(model, editFormat, success ? 1 : 0, failureReason || null, durationSeconds || null, new Date().toISOString());
}

/**
 * Get success rate for a specific model + format combination
 */
function getFormatSuccessRate(model, editFormat) {
  const rows = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(success) as successes,
      AVG(duration_seconds) as avg_duration
    FROM format_success_rates
    WHERE model = ? AND edit_format = ?
  `).all(model, editFormat);

  const row = rows[0];
  if (!row || row.total === 0) return { total: 0, successes: 0, rate: 0, avg_duration: 0 };
  return {
    total: row.total,
    successes: row.successes,
    rate: Math.round((row.successes / row.total) * 100) / 100,
    avg_duration: Math.round(row.avg_duration || 0)
  };
}

/**
 * Determine best edit format for a model based on success rates
 */
function getBestFormatForModel(model) {
  const getConfig = dbFunctions.getConfig || (() => null);
  const minSamples = parseInt(getConfig('hashline_lite_min_samples') || '3', 10);
  const threshold = parseFloat(getConfig('hashline_lite_threshold') || '0.5');

  const hashline = getFormatSuccessRate(model, 'hashline');
  const lite = getFormatSuccessRate(model, 'hashline-lite');

  // Not enough data yet — no recommendation
  if (hashline.total < minSamples && lite.total < minSamples) {
    return { format: null, reason: 'insufficient_data', hashline, lite };
  }

  // If hashline has enough data and is below threshold, recommend lite
  if (hashline.total >= minSamples && hashline.rate < threshold) {
    return { format: 'hashline-lite', reason: 'hashline_below_threshold', hashline, lite };
  }

  // If lite has enough data and outperforms hashline
  if (lite.total >= minSamples && hashline.total >= minSamples && lite.rate > hashline.rate) {
    return { format: 'hashline-lite', reason: 'lite_outperforms', hashline, lite };
  }

  return { format: 'hashline', reason: 'hashline_acceptable', hashline, lite };
}

/**
 * Get summary of all format success rates across all models
 */
function getFormatSuccessRatesSummary() {
  return db.prepare(`
    SELECT
      model,
      edit_format,
      COUNT(*) as total,
      SUM(success) as successes,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
      ROUND(CAST(SUM(success) AS REAL) / COUNT(*) * 100, 1) as success_rate_pct,
      ROUND(AVG(duration_seconds), 0) as avg_duration_s,
      GROUP_CONCAT(DISTINCT failure_reason) as failure_reasons
    FROM format_success_rates
    GROUP BY model, edit_format
    ORDER BY model, edit_format
  `).all();
}

/**
 * Compare performance between periods
 */
function comparePerformance(options) {
  const current = getSuccessRates({
    ...options,
    from_date: options.current_from,
    to_date: options.current_to
  });

  const previous = getSuccessRates({
    ...options,
    from_date: options.previous_from,
    to_date: options.previous_to
  });

  // Validate arrays before using .map() and .find()
  const currentArr = Array.isArray(current) ? current : [];
  const previousArr = Array.isArray(previous) ? previous : [];

  return {
    current: currentArr,
    previous: previousArr,
    comparison: currentArr.map(c => {
      const p = previousArr.find(pr => pr.group_key === c.group_key);
      return {
        group_key: c.group_key,
        current_rate: c.success_rate,
        previous_rate: p ? p.success_rate : null,
        change: p ? c.success_rate - p.success_rate : null
      };
    })
  };
}

/**
 * Calculate and store success metrics for recent tasks
 */
function aggregateSuccessMetrics(periodType = 'day') {
  const periodStart = periodType === 'day'
    ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    : new Date(new Date().setDate(1)).toISOString();

  // Get metrics by project
  const projectMetrics = db.prepare(`
    SELECT
      project,
      COUNT(*) as total_tasks,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_tasks,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_tasks,
      AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400
          ELSE NULL END) as avg_duration_seconds
    FROM tasks
    WHERE created_at >= ?
    GROUP BY project
  `).all(periodStart);

  for (const metrics of projectMetrics) {
    recordSuccessMetrics({
      period_start: periodStart,
      period_type: periodType,
      ...metrics
    });
  }

  return projectMetrics;
}

// ============================================
// Output Search
// ============================================

/**
 * Search task outputs for a pattern
 */
function searchTaskOutputs(pattern, options = {}) {
  let query = `
    SELECT id, status, task_description, output, error_output, created_at, completed_at
    FROM tasks
    WHERE (output LIKE ? ESCAPE '\\' OR error_output LIKE ? ESCAPE '\\')
  `;
  const escapedPattern = escapeLikePattern(pattern);
  const values = [`%${escapedPattern}%`, `%${escapedPattern}%`];

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  if (options.tags && options.tags.length > 0) {
    const tagConditions = options.tags.map(() => "tags LIKE ? ESCAPE '\\'");
    query += ` AND (${tagConditions.join(' OR ')})`;
    options.tags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  if (options.since) {
    query += ' AND created_at >= ?';
    values.push(options.since);
  }

  query += ' ORDER BY completed_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  } else {
    query += ' LIMIT 50';
  }

  const stmt = db.prepare(query);
  const results = stmt.all(...values);

  // Extract matching snippets
  return results.map(row => {
    const snippets = [];
    const regex = new RegExp(`.{0,50}${escapeRegex(pattern)}.{0,50}`, 'gi');

    if (row.output) {
      const matches = row.output.match(regex) || [];
      matches.slice(0, 3).forEach(m => snippets.push({ source: 'output', text: m }));
    }

    if (row.error_output) {
      const matches = row.error_output.match(regex) || [];
      matches.slice(0, 3).forEach(m => snippets.push({ source: 'error', text: m }));
    }

    return {
      id: row.id,
      status: row.status,
      task_description: row.task_description,
      created_at: row.created_at,
      completed_at: row.completed_at,
      snippets
    };
  });
}

/**
 * Get task output statistics
 */
function getOutputStats() {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total_tasks,
      SUM(CASE WHEN output IS NOT NULL THEN 1 ELSE 0 END) as tasks_with_output,
      SUM(CASE WHEN error_output IS NOT NULL THEN 1 ELSE 0 END) as tasks_with_errors,
      SUM(LENGTH(output)) as total_output_bytes,
      SUM(LENGTH(error_output)) as total_error_bytes
    FROM tasks
    WHERE status IN ('completed', 'failed')
  `);
  const base = stmt.get();

  // Error pattern frequency analysis (L-7)
  const patternStmt = db.prepare(`
    SELECT
      CASE
        WHEN error_output LIKE '%timeout%' OR error_output LIKE '%timed out%' OR error_output LIKE '%ETIMEDOUT%' THEN 'timeout'
        WHEN error_output LIKE '%out of memory%' OR error_output LIKE '%OOM%' OR error_output LIKE '%ENOMEM%' THEN 'memory'
        WHEN error_output LIKE '%not found%' OR error_output LIKE '%ENOENT%' OR error_output LIKE '%404%' THEN 'not_found'
        WHEN error_output LIKE '%ECONNREFUSED%' OR error_output LIKE '%ECONNRESET%' OR error_output LIKE '%connection%refused%' OR error_output LIKE '%connection%reset%' THEN 'connection'
        WHEN error_output LIKE '%EACCES%' OR error_output LIKE '%permission denied%' OR error_output LIKE '%403%' THEN 'permission'
        WHEN error_output LIKE '%SyntaxError%' OR error_output LIKE '%syntax error%' OR error_output LIKE '%parse error%' THEN 'syntax'
        WHEN error_output LIKE '%rate limit%' OR error_output LIKE '%429%' OR error_output LIKE '%too many requests%' OR error_output LIKE '%quota%' THEN 'rate_limit'
        ELSE 'other'
      END as category,
      COUNT(*) as count
    FROM tasks
    WHERE status = 'failed' AND error_output IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `);
  const error_patterns = patternStmt.all();

  // Daily error trend for last 7 days (L-8)
  const trendStmt = db.prepare(`
    SELECT
      DATE(completed_at) as day,
      COUNT(*) as error_count
    FROM tasks
    WHERE status = 'failed'
      AND completed_at >= datetime('now', '-7 days')
    GROUP BY DATE(completed_at)
    ORDER BY day ASC
  `);
  const error_trend = trendStmt.all();

  return { ...base, error_patterns, error_trend };
}

// ============================================
// Export/Import
// ============================================

/**
 * Export all data as JSON object
 */
function exportData(options = {}) {
  const getPipelineSteps = dbFunctions.getPipelineSteps;
  const getAllConfig = dbFunctions.getAllConfig;
  const { redactConfigObject } = require('../utils/sensitive-keys');

  const exportObj = {
    version: '2.0',
    exported_at: new Date().toISOString(),
    data: {}
  };

  // Export tasks
  if (options.tasks !== false) {
    // Build query with filters pushed into SQL to avoid fetching unbounded rows
    let taskSql = 'SELECT * FROM tasks';
    const params = [];
    if (options.status) {
      taskSql += ' WHERE status = ?';
      params.push(options.status);
    }
    taskSql += ' ORDER BY created_at DESC';
    if (options.limit) {
      taskSql += ' LIMIT ?';
      params.push(options.limit);
    } else {
      taskSql += ' LIMIT 10000';
    }
    const tasks = db.prepare(taskSql).all(...params);
    exportObj.data.tasks = tasks.map(t => ({
      ...t,
      tags: safeJsonParse(t.tags, null),
      context: safeJsonParse(t.context, null),
      files_modified: safeJsonParse(t.files_modified, null)
    }));
  }

  // Export templates
  if (options.templates !== false) {
    const templatesStmt = db.prepare('SELECT * FROM templates LIMIT 10000');
    exportObj.data.templates = templatesStmt.all();
  }

  // Export pipelines with steps
  if (options.pipelines !== false) {
    const pipelinesStmt = db.prepare('SELECT * FROM pipelines LIMIT 10000');
    const pipelines = pipelinesStmt.all();
    exportObj.data.pipelines = pipelines.map(p => {
      const steps = getPipelineSteps(p.id);
      return { ...p, steps };
    });
  }

  // Export scheduled tasks
  if (options.scheduled !== false) {
    const scheduledStmt = db.prepare('SELECT * FROM scheduled_tasks LIMIT 10000');
    exportObj.data.scheduled_tasks = scheduledStmt.all().map(s => ({
      ...s,
      tags: safeJsonParse(s.tags, null)
    }));
  }

  // Export config (redact sensitive keys like API keys and secrets)
  if (options.config !== false) {
    exportObj.data.config = redactConfigObject(getAllConfig());
  }

  return exportObj;
}

/**
 * Import data from JSON object
 */
function importData(importObj, options = {}) {
  const getTask = getTaskFn;
  const createTask = dbFunctions.createTask;
  const getTemplate = dbFunctions.getTemplate;
  const saveTemplate = dbFunctions.saveTemplate;
  const deleteTemplate = dbFunctions.deleteTemplate;
  const getPipeline = dbFunctions.getPipeline;
  const createPipeline = dbFunctions.createPipeline;
  const addPipelineStep = dbFunctions.addPipelineStep;
  const getScheduledTask = dbFunctions.getScheduledTask;
  const deleteScheduledTask = dbFunctions.deleteScheduledTask;
  const createScheduledTask = dbFunctions.createScheduledTask;

  const results = {
    tasks: { imported: 0, skipped: 0, errors: [] },
    templates: { imported: 0, skipped: 0, errors: [] },
    pipelines: { imported: 0, skipped: 0, errors: [] },
    scheduled_tasks: { imported: 0, skipped: 0, errors: [] }
  };

  const skipExisting = options.skipExisting !== false;

  // Import tasks
  if (importObj.data.tasks && options.tasks !== false) {
    for (const task of importObj.data.tasks) {
      try {
        const existing = getTask(task.id);
        if (existing && skipExisting) {
          results.tasks.skipped++;
          continue;
        }

        if (existing) {
          // Update existing task
          db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        }

        createTask({
          ...task,
          tags: task.tags,
          context: task.context
        });
        results.tasks.imported++;
      } catch (err) {
        results.tasks.errors.push({ id: task.id, error: err.message });
      }
    }
  }

  // Import templates
  if (importObj.data.templates && options.templates !== false) {
    for (const template of importObj.data.templates) {
      try {
        const existing = getTemplate(template.name);
        if (existing && skipExisting) {
          results.templates.skipped++;
          continue;
        }

        if (existing) {
          deleteTemplate(template.name);
        }

        saveTemplate(template);
        results.templates.imported++;
      } catch (err) {
        results.templates.errors.push({ name: template.name, error: err.message });
      }
    }
  }

  // Import pipelines
  if (importObj.data.pipelines && options.pipelines !== false) {
    for (const pipeline of importObj.data.pipelines) {
      try {
        const existing = getPipeline(pipeline.id);
        if (existing && skipExisting) {
          results.pipelines.skipped++;
          continue;
        }

        if (existing) {
          db.prepare('DELETE FROM pipeline_steps WHERE pipeline_id = ?').run(pipeline.id);
          db.prepare('DELETE FROM pipelines WHERE id = ?').run(pipeline.id);
        }

        createPipeline({
          id: pipeline.id,
          name: pipeline.name,
          description: pipeline.description,
          working_directory: pipeline.working_directory
        });

        if (pipeline.steps) {
          for (const step of pipeline.steps) {
            addPipelineStep({
              pipeline_id: pipeline.id,
              step_order: step.step_order,
              name: step.name,
              task_template: step.task_template,
              condition: step.condition,
              timeout_minutes: step.timeout_minutes
            });
          }
        }

        results.pipelines.imported++;
      } catch (err) {
        results.pipelines.errors.push({ id: pipeline.id, error: err.message });
      }
    }
  }

  // Import scheduled tasks
  if (importObj.data.scheduled_tasks && options.scheduled !== false) {
    for (const scheduled of importObj.data.scheduled_tasks) {
      try {
        const existing = getScheduledTask(scheduled.id);
        if (existing && skipExisting) {
          results.scheduled_tasks.skipped++;
          continue;
        }

        if (existing) {
          deleteScheduledTask(scheduled.id);
        }

        createScheduledTask({
          ...scheduled,
          tags: scheduled.tags
        });
        results.scheduled_tasks.imported++;
      } catch (err) {
        results.scheduled_tasks.errors.push({ id: scheduled.id, error: err.message });
      }
    }
  }

  return results;
}

module.exports = {
  setDb,
  setGetTask,
  setDbFunctions,

  // Helpers (re-exported for other modules)
  safeJsonParse,
  escapeLikePattern,
  escapeRegex,

  // Analytics
  recordEvent,
  getAnalytics,

  // Success Metrics
  recordSuccessMetrics,
  getSuccessRates,
  comparePerformance,
  aggregateSuccessMetrics,

  // Format Success
  recordFormatSuccess,
  getFormatSuccessRate,
  getBestFormatForModel,
  getFormatSuccessRatesSummary,

  // Output Search
  searchTaskOutputs,
  getOutputStats,

  // Export/Import
  exportData,
  importData,
};
