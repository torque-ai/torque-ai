'use strict';

/**
 * Cron & Extended Scheduling Module
 *
 * Extracted from scheduling-automation.js — cron expression parsing/validation,
 * next-run calculation, schedule overlap detection, and CRUD for scheduled tasks.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

let db;

const { safeJsonParse } = require('../utils/json');
const { enforceVersionIntentForProject } = require('../versioning/version-intent');

function setDb(dbInstance) {
  db = dbInstance;
}

// Cron field validation ranges
const CRON_FIELD_RANGES = {
  minute: { min: 0, max: 59, name: 'minute' },
  hour: { min: 0, max: 23, name: 'hour' },
  day: { min: 1, max: 31, name: 'day of month' },
  month: { min: 1, max: 12, name: 'month' },
  dayOfWeek: { min: 0, max: 7, name: 'day of week' }  // 0 and 7 both mean Sunday
};

/**
 * Validate a single cron field value is within valid range
 * Returns { valid: true } or { valid: false, error: string }
 */
function validateCronFieldValue(value, range) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num < range.min || num > range.max) {
    return { valid: false, error: `${range.name} must be ${range.min}-${range.max}, got ${value}` };
  }
  return { valid: true };
}

/**
 * Validate a single cron field syntax and values
 * Returns { valid: true } or { valid: false, error: string }
 */
function validateCronField(field, range) {
  // Allow wildcard
  if (field === '*') return { valid: true };

  // Check for invalid characters first
  if (!/^[\d*,\-/]+$/.test(field)) {
    return { valid: false, error: `${range.name} contains invalid characters` };
  }

  // Handle */n syntax
  if (field.startsWith('*/')) {
    const interval = parseInt(field.substring(2), 10);
    if (!Number.isFinite(interval) || interval <= 0 || interval > range.max) {
      return { valid: false, error: `${range.name} step must be 1-${range.max}, got ${field.substring(2)}` };
    }
    return { valid: true };
  }

  // Handle comma-separated values
  if (field.includes(',')) {
    const values = field.split(',');
    for (const v of values) {
      const result = validateCronFieldValue(v.trim(), range);
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  // Handle range (e.g., 1-5)
  if (field.includes('-')) {
    const parts = field.split('-');
    if (parts.length !== 2) {
      return { valid: false, error: `${range.name} has invalid range syntax: ${field}` };
    }
    const startResult = validateCronFieldValue(parts[0].trim(), range);
    if (!startResult.valid) return startResult;
    const endResult = validateCronFieldValue(parts[1].trim(), range);
    if (!endResult.valid) return endResult;
    const start = parseInt(parts[0].trim(), 10);
    const end = parseInt(parts[1].trim(), 10);
    if (start > end) {
      return { valid: false, error: `${range.name} range start (${start}) must be <= end (${end})` };
    }
    return { valid: true };
  }

  // Single value
  return validateCronFieldValue(field, range);
}

/**
 * Parse and validate cron expression
 * Supports: minute hour day month dayOfWeek
 * Examples: "0 * * * *" (every hour), "star/15 * * * *" (every 15 mins, star=asterisk)
 * Throws Error with detailed message on invalid input
 */
function parseCronExpression(expression) {
  if (typeof expression !== 'string') {
    throw new Error('CRON_INVALID_TYPE: cron expression must be a string');
  }

  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new Error('CRON_EMPTY: cron expression cannot be empty');
  }

  if (trimmed.length > 100) {
    throw new Error('CRON_TOO_LONG: cron expression exceeds maximum length of 100 characters');
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`CRON_FIELD_COUNT: cron expression must have 5 fields (minute hour day month dayOfWeek), got ${parts.length}`);
  }

  const fieldNames = ['minute', 'hour', 'day', 'month', 'dayOfWeek'];
  for (let i = 0; i < 5; i++) {
    const result = validateCronField(parts[i], CRON_FIELD_RANGES[fieldNames[i]]);
    if (!result.valid) {
      throw new Error(`CRON_INVALID_FIELD: ${result.error}`);
    }
  }

  return {
    minute: parts[0],
    hour: parts[1],
    day: parts[2],
    month: parts[3],
    dayOfWeek: parts[4]
  };
}

/**
 * Calculate next run time from cron expression
 * Implements correct cron semantics:
 * - If both day-of-month and day-of-week are specified (not '*'), use OR logic
 * - This matches standard cron behavior where a date can match either field
 * Returns null on invalid cron expression instead of throwing
 */
function calculateNextRun(cronExpression, fromDate = new Date(), timezone = null) {
  let cron;
  try {
    cron = parseCronExpression(cronExpression);
  } catch {
    // Invalid cron expression - return null instead of throwing
    return null;
  }
  const next = new Date(fromDate);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Helper to get date components in the target timezone using Intl.DateTimeFormat
  let getDateParts;
  if (timezone) {
    try {
      // Validate timezone by creating a formatter — throws on invalid IANA timezone
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false,
      });
      getDateParts = (date) => {
        const parts = {};
        for (const { type, value } of fmt.formatToParts(date)) {
          parts[type] = parseInt(value, 10);
        }
        return {
          minute: parts.minute,
          hour: parts.hour === 24 ? 0 : parts.hour,
          day: parts.day,
          month: parts.month,
          dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
        };
      };
    } catch {
      // Invalid timezone — fall back to local time
      getDateParts = null;
    }
  }

  if (!getDateParts) {
    getDateParts = (date) => ({
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    });
  }

  // Determine day matching mode
  // Per cron spec: if both day-of-month and day-of-week are restricted (not '*'),
  // match if EITHER condition is true (OR logic)
  const daySpecified = cron.day !== '*';
  const dayOfWeekSpecified = cron.dayOfWeek !== '*';
  const useDayOrLogic = daySpecified && dayOfWeekSpecified;

  // Simple implementation: advance by 1 minute and check each slot
  // For production, use a proper cron library
  for (let i = 0; i < 1440 * 366; i++) { // Check up to 366 days
    next.setMinutes(next.getMinutes() + 1);

    const p = getDateParts(next);
    const minute = p.minute;
    const hour = p.hour;
    const day = p.day;
    const month = p.month;
    const dayOfWeek = p.dayOfWeek;
    const normalizedDayOfWeek = dayOfWeek % 7;

    // Check minute, hour, and month (always AND logic)
    // Pass rangeMin: minute=0, hour=0, month=1 (months are 1-12)
    if (!matchesCronField(cron.minute, minute, 0) ||
        !matchesCronField(cron.hour, hour, 0) ||
        !matchesCronField(cron.month, month, 1)) {
      continue;
    }

    // Check day-of-month and day-of-week
    // Use OR logic when both are specified, otherwise AND
    // rangeMin: day=1 (days are 1-31), dayOfWeek=0 (days are 0-6)
    let dayMatches;
    if (useDayOrLogic) {
      // OR: match if either day-of-month OR day-of-week matches
      dayMatches = matchesCronField(cron.day, day, 1) || matchesCronField(cron.dayOfWeek, normalizedDayOfWeek, 0);
    } else {
      // AND: match if both match (one or both may be '*' which always matches)
      dayMatches = matchesCronField(cron.day, day, 1) && matchesCronField(cron.dayOfWeek, normalizedDayOfWeek, 0);
    }

    if (dayMatches) {
      return next;
    }
  }

  return null;
}

/**
 * Check if a value matches a cron field
 * Returns false for invalid field syntax rather than throwing
 * @param {string} field - The cron field pattern
 * @param {number} value - The current value to check
 * @param {number} rangeMin - Minimum value for this field (0 for minute/hour, 1 for day/month)
 */
function matchesCronField(field, value, rangeMin = 0) {
  if (field === '*') return true;

  try {
    // Handle */n syntax
    // For fields starting at 0 (minute, hour, dayOfWeek): value % n == 0
    // For fields starting at 1 (day, month): (value - 1) % n == 0
    if (field.startsWith('*/')) {
      const interval = parseInt(field.substring(2), 10);
      // Guard against division by zero and NaN
      if (!Number.isFinite(interval) || interval <= 0) {
        return false;
      }
      // Adjust for 1-based fields (day, month) so */2 matches 1,3,5,7,9,11 for months
      const adjustedValue = rangeMin === 1 ? value - 1 : value;
      return adjustedValue % interval === 0;
    }

    // Handle comma-separated values
    if (field.includes(',')) {
      const values = field.split(',').map(v => parseInt(v.trim(), 10));
      // Check all values are valid numbers
      if (values.some(v => !Number.isFinite(v))) {
        return false;
      }
      return values.includes(value);
    }

    // Handle range (e.g., 1-5)
    if (field.includes('-')) {
      const parts = field.split('-');
      if (parts.length !== 2) return false;
      const start = parseInt(parts[0].trim(), 10);
      const end = parseInt(parts[1].trim(), 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
      }
      return value >= start && value <= end;
    }

    // Single value
    const parsed = parseInt(field, 10);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return parsed === value;
  } catch {
    // Safety catch for any unexpected errors
    return false;
  }
}

/**
 * Detect schedule overlaps by computing next N run times and checking for collisions
 * @param {string} cronExpression - Cron expression to check
 * @param {Object} options - Options
 * @param {number} options.checkCount - Number of future runs to check (default 10)
 * @param {number} options.toleranceMinutes - Minutes within which runs are considered overlapping (default 5)
 * @param {string[]} options.excludeIds - Schedule IDs to exclude from comparison
 * @returns {Array} Array of overlapping schedules with overlap times
 */
function detectScheduleOverlaps(cronExpression, options = {}) {
  const { checkCount = 10, toleranceMinutes = 5, excludeIds = [] } = options;
  const toleranceMs = toleranceMinutes * 60 * 1000;

  // Get all enabled schedules except excluded ones
  const schedules = listScheduledTasks({ enabled_only: true });
  const compareSchedules = schedules.filter(s => !excludeIds.includes(String(s.id)));

  if (compareSchedules.length === 0) return [];

  // Calculate next N run times for the new expression
  const newRunTimes = [];
  let nextTime = new Date();
  for (let i = 0; i < checkCount; i++) {
    const next = calculateNextRun(cronExpression, nextTime);
    if (!next) break;
    newRunTimes.push(next.getTime());
    nextTime = new Date(next.getTime() + 60000); // Move 1 minute forward
  }

  if (newRunTimes.length === 0) return [];

  // Check for overlaps with existing schedules
  const overlaps = [];
  for (const schedule of compareSchedules) {
    let schedNextTime = new Date();
    const scheduleOverlaps = [];

    for (let i = 0; i < checkCount; i++) {
      const schedNext = calculateNextRun(schedule.cron_expression, schedNextTime);
      if (!schedNext) break;
      const schedNextMs = schedNext.getTime();

      // Check if this run time is within tolerance of any new run time
      for (const newRunMs of newRunTimes) {
        if (Math.abs(schedNextMs - newRunMs) <= toleranceMs) {
          scheduleOverlaps.push({
            existingTime: new Date(schedNextMs).toISOString(),
            newTime: new Date(newRunMs).toISOString(),
            differenceMinutes: Math.round(Math.abs(schedNextMs - newRunMs) / 60000)
          });
        }
      }

      schedNextTime = new Date(schedNextMs + 60000);
    }

    if (scheduleOverlaps.length > 0) {
      overlaps.push({
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        cron_expression: schedule.cron_expression,
        overlaps: scheduleOverlaps
      });
    }
  }

  return overlaps;
}

/**
 * Create a scheduled task (cron-based)
 * Compatible with existing scheduled_tasks schema
 */
function createCronScheduledTask(data) {
  const now = new Date().toISOString();
  const { v4: uuidv4 } = require('uuid');

  // Version intent enforcement for versioned projects
  const workDir = (data.task_config && data.task_config.working_directory) || null;
  if (workDir) {
    const intent = data.version_intent || (data.task_config && data.task_config.version_intent);
    enforceVersionIntentForProject(db, workDir, intent);
  }

  // Validate cron expression
  parseCronExpression(data.cron_expression);

  // Calculate next run (timezone-aware if provided)
  const timezone = data.timezone || null;
  const nextRun = calculateNextRun(data.cron_expression, new Date(), timezone);

  const scheduleId = uuidv4();
  const taskConfig = data.task_config || {};

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, schedule_type, cron_expression, next_run_at, enabled, created_at, task_config, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    scheduleId,
    data.name,
    taskConfig.task || 'Scheduled task',
    taskConfig.working_directory || null,
    taskConfig.timeout_minutes || 30,
    taskConfig.auto_approve ? 1 : 0,
    'cron',
    data.cron_expression,
    nextRun ? nextRun.toISOString() : null,
    data.enabled !== false ? 1 : 0,
    now,
    JSON.stringify(taskConfig),
    now,
    timezone
  );

  return {
    id: scheduleId,
    name: data.name,
    cron_expression: data.cron_expression,
    timezone: timezone,
    task_config: taskConfig,
    enabled: data.enabled !== false,
    next_run_at: nextRun ? nextRun.toISOString() : null
  };
}

/**
 * Create a one-time scheduled task that fires at a specific datetime.
 * Accepts either run_at (ISO 8601) or delay (e.g., "4h", "2h30m").
 * After firing, the schedule is auto-deleted by markScheduledTaskRun.
 */
function createOneTimeSchedule(data) {
  // Version intent enforcement for versioned projects
  const workDir = (data.task_config && data.task_config.working_directory) || null;
  if (workDir) {
    const intent = data.version_intent || (data.task_config && data.task_config.version_intent);
    enforceVersionIntentForProject(db, workDir, intent);
  }
  const { v4: uuidv4 } = require('uuid');
  const now = new Date();

  let runAt;
  if (data.run_at) {
    runAt = new Date(data.run_at);
  } else if (data.delay) {
    const delayMs = parseDelay(data.delay);
    runAt = new Date(now.getTime() + delayMs);
  } else {
    throw new Error('ONE_TIME_NO_TIME: either run_at or delay is required');
  }

  if (runAt.getTime() < now.getTime() - 60000) {
    throw new Error('ONE_TIME_PAST: scheduled time must be in the future');
  }

  const scheduleId = uuidv4();
  const taskConfig = data.task_config || {};
  const runAtIso = runAt.toISOString();

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, schedule_type, cron_expression, scheduled_time, next_run_at,
      enabled, created_at, task_config, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const nowIso = now.toISOString();
  stmt.run(
    scheduleId,
    data.name,
    taskConfig.task || 'One-time scheduled task',
    taskConfig.working_directory || null,
    taskConfig.timeout_minutes || 30,
    taskConfig.auto_approve ? 1 : 0,
    'once',
    null,
    runAtIso,
    runAtIso,
    data.enabled !== false ? 1 : 0,
    nowIso,
    JSON.stringify(taskConfig),
    nowIso,
    data.timezone || null
  );

  return {
    id: scheduleId,
    name: data.name,
    schedule_type: 'once',
    run_at: runAtIso,
    timezone: data.timezone || null,
    task_config: taskConfig,
    enabled: data.enabled !== false,
    next_run_at: runAtIso,
  };
}

/**
 * Toggle scheduled task enabled state
 * @param {any} id
 * @param {any} enabled
 * @returns {any}
 */
function toggleScheduledTask(id, enabled) {
  const now = new Date().toISOString();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  const newEnabled = enabled !== undefined ? enabled : !schedule.enabled;

  let nextRun = schedule.next_run_at;
  if (newEnabled && !schedule.enabled) {
    if (schedule.schedule_type === 'once') {
      nextRun = schedule.scheduled_time || schedule.next_run_at;
    } else {
      const next = calculateNextRun(schedule.cron_expression, new Date(), schedule.timezone || null);
      nextRun = next ? next.toISOString() : null;
    }
  }

  const stmt = db.prepare(`
    UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(newEnabled ? 1 : 0, nextRun, now, id);

  return getScheduledTask(id);
}

// Enhanced versions (Wave 2 Phase 5 — replaces basic L6448-6626 versions)

/**
 * Get a scheduled task by ID or name
 * @param {any} identifier
 * @returns {any}
 */
function getScheduledTask(identifier) {
  const stmt = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE id = ? OR name = ?
  `);
  const row = stmt.get(identifier, identifier);

  if (row) {
    row.task_config = safeJsonParse(row.task_config, {});
    row.enabled = Boolean(row.enabled);
  }

  return row;
}

/**
 * List scheduled tasks
 * @param {any} options
 * @returns {any}
 */
function listScheduledTasks(options = {}) {
  const { enabled_only = false, limit = 50 } = options;

  let query = 'SELECT * FROM scheduled_tasks';
  const params = [];

  if (enabled_only) {
    query += ' WHERE enabled = 1';
  }

  query += ' ORDER BY next_run_at ASC NULLS LAST LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  return rows.map(row => ({
    ...row,
    task_config: safeJsonParse(row.task_config, {}),
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Update a scheduled task
 * @param {any} id
 * @param {any} updates
 * @returns {any}
 */
function updateScheduledTask(id, updates) {
  const now = new Date().toISOString();
  const fields = [];
  const params = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }

  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    params.push(updates.timezone || null);
  }

  if (updates.cron_expression !== undefined) {
    parseCronExpression(updates.cron_expression);
    fields.push('cron_expression = ?');
    params.push(updates.cron_expression);

    // Recalculate next run (use updated timezone if provided, else fetch existing schedule's timezone)
    let tz = updates.timezone !== undefined ? (updates.timezone || null) : null;
    if (tz === null && updates.cron_expression !== undefined && updates.timezone === undefined) {
      const existing = getScheduledTask(id);
      tz = existing?.timezone || null;
    }
    const nextRun = calculateNextRun(updates.cron_expression, new Date(), tz);
    fields.push('next_run_at = ?');
    params.push(nextRun ? nextRun.toISOString() : null);
  }

  if (updates.run_at !== undefined) {
    const runAt = new Date(updates.run_at);
    if (runAt.getTime() < Date.now() - 60000) {
      throw new Error('ONE_TIME_PAST: scheduled time must be in the future');
    }
    const runAtIso = runAt.toISOString();
    fields.push('scheduled_time = ?');
    params.push(runAtIso);
    fields.push('next_run_at = ?');
    params.push(runAtIso);
  }

  if (updates.task_description !== undefined) {
    fields.push('task_description = ?');
    params.push(updates.task_description);
  }

  if (updates.task_config !== undefined) {
    // Partial merge: merge caller's keys into existing task_config
    const existing = getScheduledTask(id);
    const merged = { ...(existing?.task_config || {}), ...updates.task_config };
    fields.push('task_config = ?');
    params.push(JSON.stringify(merged));
  }

  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }

  if (fields.length === 0) return null;

  fields.push('updated_at = ?');
  params.push(now);
  params.push(id);

  const stmt = db.prepare(`
    UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?
  `);
  stmt.run(...params);

  return getScheduledTask(id);
}

/**
 * Delete a scheduled task
 */
function deleteScheduledTask(id) {
  const stmt = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Get scheduled tasks that are due to run
 * @returns {any}
 */
function getDueScheduledTasks() {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `);
  const rows = stmt.all(now);

  return rows.map(row => ({
    ...row,
    task_config: safeJsonParse(row.task_config, {}),
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Mark a scheduled task as run and update next run time
 * @param {any} id
 * @returns {any}
 */
function markScheduledTaskRun(id) {
  const now = new Date();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  if (schedule.schedule_type === 'once') {
    deleteScheduledTask(id);
    return null;
  }

  const nextRun = calculateNextRun(schedule.cron_expression, now, schedule.timezone || null);

  const stmt = db.prepare(`
    UPDATE scheduled_tasks
    SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(now.toISOString(), nextRun ? nextRun.toISOString() : null, now.toISOString(), id);

  return getScheduledTask(id);
}

/**
 * Parse a delay string into milliseconds.
 * Format: concatenated segments of \d+[dhm]
 * Examples: "30m", "4h", "2h30m", "1d6h"
 * @param {string} delayStr - The delay string to parse
 * @returns {number} Delay in milliseconds
 * @throws {Error} On invalid or zero-duration input
 */
function parseDelay(delayStr) {
  if (typeof delayStr !== 'string' || delayStr.trim().length === 0) {
    throw new Error('DELAY_EMPTY: delay string cannot be empty');
  }

  const pattern = /(\d+)([dhm])/g;
  let totalMs = 0;
  let match;
  let matchCount = 0;

  while ((match = pattern.exec(delayStr)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    matchCount++;

    switch (unit) {
      case 'd': totalMs += value * 24 * 60 * 60 * 1000; break;
      case 'h': totalMs += value * 60 * 60 * 1000; break;
      case 'm': totalMs += value * 60 * 1000; break;
    }
  }

  if (matchCount === 0) {
    throw new Error(`DELAY_INVALID: cannot parse delay string "${delayStr}" -- expected format like "4h", "30m", "2h30m"`);
  }

  if (totalMs <= 0) {
    throw new Error('DELAY_ZERO: delay must be greater than zero');
  }

  return totalMs;
}

// ============================================
// Exports
// ============================================

module.exports = {
  setDb,

  // Cron & Extended Scheduling
  CRON_FIELD_RANGES,
  validateCronFieldValue,
  validateCronField,
  parseCronExpression,
  calculateNextRun,
  matchesCronField,
  detectScheduleOverlaps,
  parseDelay,
  createCronScheduledTask,
  createOneTimeSchedule,
  toggleScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  getDueScheduledTasks,
  markScheduledTaskRun,
};
