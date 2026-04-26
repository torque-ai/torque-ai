'use strict';

/**
 * Task Metadata Module
 *
 * Extracted from database.js — tags, groups, batch ops, archiving, file changes,
 * git integration, and task comments/timeline.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const path = require('path');
const logger = require('../logger').child({ component: 'task-metadata' });
const { safeJsonParse } = require('../utils/json');
const taskIntelligence = require('./task-intelligence');
const taskDebugger = require('./task-debugger');

let db;
let getTaskFn;
let getTaskEventsFn;
let getRetryHistoryFn;
let recordAuditLogFn;
let getApprovalHistoryFn;
let createTaskFn;
let _taskFileChangeColumnsCache = null;

function setDb(dbInstance) { db = dbInstance; taskIntelligence.setDb(dbInstance); taskDebugger.setDb(dbInstance); }
function setGetTask(fn) { getTaskFn = fn; taskIntelligence.setGetTask(fn); }
function setGetTaskEvents(fn) { getTaskEventsFn = fn; }
function setGetRetryHistory(fn) { getRetryHistoryFn = fn; }
function setRecordAuditLog(fn) { recordAuditLogFn = fn; }
function setGetApprovalHistory(fn) { getApprovalHistoryFn = fn; }
function setCreateTask(fn) { createTaskFn = fn; }


function escapeLikePattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}

function getTaskFileChangeColumns() {
  if (_taskFileChangeColumnsCache) return _taskFileChangeColumnsCache;
  _taskFileChangeColumnsCache = new Set(
    db.prepare('PRAGMA table_info(task_file_changes)')
      .all()
      .map((column) => column.name)
  );
  return _taskFileChangeColumnsCache;
}

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeLegacyFileChange(changeOrPath, changeType, options = {}) {
  if (changeOrPath && typeof changeOrPath === 'object' && !Array.isArray(changeOrPath)) {
    return { ...changeOrPath };
  }

  const normalizedOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};

  return {
    file_path: changeOrPath,
    change_type: changeType,
    stash_ref: pickFirstDefined(normalizedOptions.stash_ref, normalizedOptions.stashRef),
    original_content: pickFirstDefined(normalizedOptions.original_content, normalizedOptions.originalContent),
    file_size_bytes: pickFirstDefined(normalizedOptions.file_size_bytes, normalizedOptions.fileSizeBytes),
    working_directory: pickFirstDefined(normalizedOptions.working_directory, normalizedOptions.workingDirectory),
    relative_path: pickFirstDefined(normalizedOptions.relative_path, normalizedOptions.relativePath),
    is_outside_workdir: pickFirstDefined(normalizedOptions.is_outside_workdir, normalizedOptions.isOutsideWorkdir),
  };
}

function normalizeTrackedFileChange(changeOrPath, changeType, options = {}) {
  const change = normalizeLegacyFileChange(changeOrPath, changeType, options);
  const filePath = typeof change.file_path === 'string' ? change.file_path.trim() : '';
  const normalizedChangeType = typeof change.change_type === 'string' ? change.change_type.trim() : '';

  if (!filePath || !normalizedChangeType) {
    throw new Error('recordFileChange requires file_path and change_type');
  }

  const normalizedWorkingDirectory = typeof change.working_directory === 'string' && change.working_directory.trim()
    ? change.working_directory.trim()
    : null;

  let relativePath = typeof change.relative_path === 'string' && change.relative_path.trim()
    ? change.relative_path.trim()
    : filePath;
  let isOutsideWorkdir = change.is_outside_workdir ? 1 : 0;

  if (normalizedWorkingDirectory && change.relative_path === undefined && change.is_outside_workdir === undefined) {
    const normalizedFile = path.normalize(filePath);
    const normalizedWorkdir = path.normalize(normalizedWorkingDirectory);
    const rel = path.relative(normalizedWorkdir, normalizedFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      isOutsideWorkdir = 1;
    } else {
      relativePath = rel;
      isOutsideWorkdir = 0;
    }
  }

  const parsedFileSizeBytes = Number(change.file_size_bytes);
  const fileSizeBytes = Number.isFinite(parsedFileSizeBytes) && parsedFileSizeBytes >= 0
    ? parsedFileSizeBytes
    : null;

  return {
    file_path: filePath,
    change_type: normalizedChangeType,
    stash_ref: typeof change.stash_ref === 'string' && change.stash_ref.trim() ? change.stash_ref.trim() : null,
    original_content: typeof change.original_content === 'string' ? change.original_content : null,
    file_size_bytes: fileSizeBytes,
    working_directory: normalizedWorkingDirectory,
    relative_path: relativePath,
    is_outside_workdir: isOutsideWorkdir,
  };
}

// ============ Task File Changes Functions ============

/**
 * Record a file change for a task
 * @param {any} taskId
 * Supports both the modern object signature:
 *   recordFileChange(taskId, { file_path, change_type, ... })
 * and the legacy file-tracking signature:
 *   recordFileChange(taskId, filePath, changeType, options)
 *
 * @param {any} changeOrPath
 * @param {any} changeType
 * @param {any} options
 * @returns {any}
 */
function recordFileChange(taskId, changeOrPath, changeType, options = {}) {
  const availableColumns = getTaskFileChangeColumns();
  const change = normalizeTrackedFileChange(changeOrPath, changeType, options);
  const timestamp = new Date().toISOString();
  const columns = ['task_id', 'file_path', 'change_type'];
  const values = [taskId, change.file_path, change.change_type];

  if (availableColumns.has('file_size_bytes')) {
    columns.push('file_size_bytes');
    values.push(change.file_size_bytes);
  }
  if (availableColumns.has('working_directory')) {
    columns.push('working_directory');
    values.push(change.working_directory);
  }
  if (availableColumns.has('relative_path')) {
    columns.push('relative_path');
    values.push(change.relative_path);
  }
  if (availableColumns.has('is_outside_workdir')) {
    columns.push('is_outside_workdir');
    values.push(change.is_outside_workdir);
  }

  if (availableColumns.has('stash_ref')) {
    columns.push('stash_ref');
    values.push(change.stash_ref || null);
  }
  if (availableColumns.has('original_content')) {
    columns.push('original_content');
    values.push(change.original_content || null);
  }
  if (availableColumns.has('recorded_at')) {
    columns.push('recorded_at');
    values.push(timestamp);
  }
  if (availableColumns.has('created_at')) {
    columns.push('created_at');
    values.push(timestamp);
  }

  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`
    INSERT INTO task_file_changes (${columns.join(', ')})
    VALUES (${placeholders})
  `).run(...values);

  return {
    task_id: taskId,
    file_path: change.file_path,
    change_type: change.change_type,
    relative_path: change.relative_path,
    is_outside_workdir: change.is_outside_workdir === 1,
  };
}

/**
 * Get file changes for a task
 * @param {any} taskId
 * @returns {any}
 */
function getTaskFileChanges(taskId) {
  const availableColumns = getTaskFileChangeColumns();
  const orderClause = availableColumns.has('recorded_at')
    ? (availableColumns.has('created_at')
      ? 'COALESCE(recorded_at, created_at, \'\') ASC, id ASC'
      : 'recorded_at ASC, id ASC')
    : (availableColumns.has('created_at')
      ? 'created_at ASC, id ASC'
      : 'id ASC');
  const stmt = db.prepare(`SELECT * FROM task_file_changes WHERE task_id = ? ORDER BY ${orderClause}`);
  return stmt.all(taskId);
}

/**
 * Get rollback points for a task
 * @param {any} taskId
 * @returns {any}
 */
function getRollbackPoints(taskId) {
  const task = getTaskFn(taskId);
  const fileChanges = getTaskFileChanges(taskId);

  return {
    task: task ? {
      id: task.id,
      git_before_sha: task.git_before_sha,
      git_after_sha: task.git_after_sha,
      git_stash_ref: task.git_stash_ref
    } : null,
    fileChanges
  };
}

// ============ Task Groups Functions ============

/**
 * Create a task group
 */
function createTaskGroup(group) {
  const stmt = db.prepare(`
    INSERT INTO task_groups (id, name, project, description, default_priority, default_timeout, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    group.id,
    group.name,
    group.project || null,
    group.description || null,
    group.default_priority || 0,
    group.default_timeout ?? 30,
    new Date().toISOString()
  );

  return getTaskGroup(group.id);
}

/**
 * Get a task group by ID
 * @param {any} id
 * @returns {any}
 */
function getTaskGroup(id) {
  const stmt = db.prepare('SELECT * FROM task_groups WHERE id = ?');
  const group = stmt.get(id);
  if (group) {
    group.tasks = getGroupTasks(id);
    group.stats = getGroupStats(id);
  }
  return group;
}

/**
 * List task groups
 * @param {any} options
 * @returns {any}
 */
function listTaskGroups(options = {}) {
  let query = 'SELECT * FROM task_groups';
  const conditions = [];
  const values = [];

  if (options.project) {
    conditions.push('project = ?');
    values.push(options.project);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...values).map(group => ({
    ...group,
    stats: getGroupStats(group.id)
  }));
}

/**
 * Get tasks in a group
 * @param {any} groupId
 * @returns {any}
 */
function getGroupTasks(groupId) {
  const stmt = db.prepare('SELECT * FROM tasks WHERE group_id = ? ORDER BY created_at DESC');
  return stmt.all(groupId).map(row => ({
    ...row,
    auto_approve: Boolean(row.auto_approve),
    tags: safeJsonParse(row.tags, [])
  }));
}

/**
 * Get group statistics
 * @param {any} groupId
 * @returns {any}
 */
function getGroupStats(groupId) {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM tasks WHERE group_id = ?
  `);
  return stmt.get(groupId);
}

/**
 * Add task to group
 * @param {string} taskId - Task identifier.
 * @param {string} groupId - Group identifier.
 * @returns {object|null} Updated task or null when task is missing.
 */
function addTaskToGroup(taskId, groupId) {
  db.prepare('UPDATE tasks SET group_id = ? WHERE id = ?').run(groupId, taskId);
  return getTaskFn(taskId);
}

/**
 * Delete a task group
 */
function deleteTaskGroup(id, removeTasksFromGroup = true) {
  if (removeTasksFromGroup) {
    db.prepare('UPDATE tasks SET group_id = NULL WHERE group_id = ?').run(id);
  }
  const result = db.prepare('DELETE FROM task_groups WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============ Git Integration Functions ============

/**
 * Update task git state
 * @param {any} taskId
 * @param {any} gitState
 * @returns {any}
 */
function updateTaskGitState(taskId, gitState) {
  const updates = [];
  const values = [];

  if (gitState.before_sha !== undefined) {
    updates.push('git_before_sha = ?');
    values.push(gitState.before_sha);
  }
  if (gitState.after_sha !== undefined) {
    updates.push('git_after_sha = ?');
    values.push(gitState.after_sha);
  }
  if (gitState.stash_ref !== undefined) {
    updates.push('git_stash_ref = ?');
    values.push(gitState.stash_ref);
  }

  if (updates.length === 0) return getTaskFn(taskId);

  values.push(taskId);
  const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getTaskFn(taskId);
}

/**
 * Get tasks with git commits (for rollback candidates)
 * @param {any} options
 * @returns {any}
 */
function getTasksWithCommits(options = {}) {
  let query = `
    SELECT * FROM tasks
    WHERE git_after_sha IS NOT NULL
  `;
  const values = [];

  if (options.working_directory) {
    query += ' AND working_directory = ?';
    values.push(options.working_directory);
  }

  query += ' ORDER BY completed_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...values);
}

// ============ Task Tags Functions ============

/**
 * Add tags to a task
 * Enforces limits on total tag count and payload size to prevent unbounded growth
 * @param {string} taskId - Task identifier.
 * @param {Array<string>} newTags - Tags to add.
 * @returns {object|null} Updated task or null when task is missing.
 */
function addTaskTags(taskId, newTags) {
  const task = getTaskFn(taskId);
  if (!task) return null;

  if (!Array.isArray(newTags)) {
    throw new Error('tags must be an array');
  }
  if (!newTags.every(tag => typeof tag === 'string')) {
    throw new Error('tags must be an array of strings');
  }

  const MAX_TAGS_PER_TASK = 50;
  const MAX_TAGS_PAYLOAD_SIZE = 10000; // bytes

  const existingTags = task.tags || [];
  let uniqueTags = [...new Set([...existingTags, ...newTags])];

  // Enforce tag count limit
  if (uniqueTags.length > MAX_TAGS_PER_TASK) {
    uniqueTags = uniqueTags.slice(0, MAX_TAGS_PER_TASK);
    logger.warn(`Warning: Truncated tags for task ${taskId} to ${MAX_TAGS_PER_TASK} tags`);
  }

  const tagsJson = JSON.stringify(uniqueTags);

  // Enforce payload size limit
  if (tagsJson.length > MAX_TAGS_PAYLOAD_SIZE) {
    throw new Error(`Tags payload exceeds maximum size of ${MAX_TAGS_PAYLOAD_SIZE} bytes`);
  }

  db.prepare('UPDATE tasks SET tags = ? WHERE id = ?')
    .run(tagsJson, taskId);

  return getTaskFn(taskId);
}

/**
 * Remove tags from a task
 * @param {any} taskId
 * @param {any} tagsToRemove
 * @returns {any}
 */
function removeTaskTags(taskId, tagsToRemove) {
  const task = getTaskFn(taskId);
  if (!task) return null;

  if (!Array.isArray(tagsToRemove)) {
    throw new Error('tags must be an array');
  }
  if (!tagsToRemove.every(tag => typeof tag === 'string')) {
    throw new Error('tags must be an array of strings');
  }

  const existingTags = task.tags || [];
  const filteredTags = existingTags.filter(t => !tagsToRemove.includes(t));

  db.prepare('UPDATE tasks SET tags = ? WHERE id = ?')
    .run(JSON.stringify(filteredTags), taskId);

  return getTaskFn(taskId);
}

/**
 * Get all unique tags used across all tasks
 */
function getAllTags() {
  const rows = db.prepare(`
    SELECT DISTINCT je.value AS tag
    FROM tasks, json_each(tasks.tags) AS je
    WHERE tasks.tags IS NOT NULL AND json_valid(tasks.tags) AND tasks.status NOT IN ('deleted')
    ORDER BY je.value
  `).all();
  return rows.map((row) => row.tag);
}

/**
 * Get tag usage statistics
 * @returns {any}
 */
function getTagStats() {
  return db.prepare(`
    SELECT je.value AS tag, COUNT(*) AS count
    FROM tasks, json_each(tasks.tags) AS je
    WHERE tasks.tags IS NOT NULL AND json_valid(tasks.tags)
    GROUP BY je.value
    ORDER BY count DESC
  `).all();
}

// ============ Batch Operations Functions ============

/**
 * Batch cancel tasks by filter
 * @param {object} [options={}] - Cancellation filter options.
 * @returns {number} Number of tasks cancelled.
 */
function batchCancelTasks(options = {}) {
  const cancelReason = typeof options.cancel_reason === 'string' && options.cancel_reason.trim().length > 0
    ? options.cancel_reason.trim()
    : 'user';
  const conditions = [];
  const values = [cancelReason, new Date().toISOString()];

  // Status condition
  if (options.status) {
    conditions.push('status = ?');
    values.push(options.status);
  } else {
    conditions.push("status IN ('pending', 'queued', 'running')");
  }

  // Tags condition
  if (options.tags && options.tags.length > 0) {
    const tagConditions = options.tags.map(() => "tags LIKE ? ESCAPE '\\'");
    conditions.push(`(${tagConditions.join(' OR ')})`);
    options.tags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  // Age condition
  if (options.olderThan) {
    conditions.push('created_at < ?');
    values.push(options.olderThan);
  }

  // Provider condition
  if (options.provider) {
    conditions.push('provider = ?');
    values.push(options.provider);
  }

  const query = "UPDATE tasks SET status = 'cancelled', cancel_reason = ?, completed_at = ? WHERE " + conditions.join(' AND ');
  const stmt = db.prepare(query);
  const result = stmt.run(...values);
  return result.changes;
}

/**
 * Get tasks eligible for retry (failed tasks)
 * @param {any} options
 * @returns {any}
 */
function getRetryableTasks(options = {}) {
  let query = "SELECT * FROM tasks WHERE status IN ('failed', 'cancelled')";
  const values = [];

  if (options.tags && options.tags.length > 0) {
    const tagConditions = options.tags.map(() => "tags LIKE ? ESCAPE '\\'");
    query += ` AND (${tagConditions.join(' OR ')})`;
    options.tags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  } else {
    query += ' LIMIT 1000';
  }

  const stmt = db.prepare(query);
  return stmt.all(...values).map(row => ({
    ...row,
    tags: safeJsonParse(row.tags, null)
  }));
}

/**
 * Batch add tags to tasks
 * @param {Array<string>} taskIds - Task identifiers.
 * @param {Array<string>} tags - Tags to add.
 * @returns {number} Number of tasks updated.
 */
function batchAddTags(taskIds, tags) {
  let updated = 0;
  for (const taskId of taskIds) {
    const task = getTaskFn(taskId);
    if (task) {
      addTaskTags(taskId, tags);
      updated++;
    }
  }
  return updated;
}

/**
 * Batch add tags by filter
 * @param {object} options - Filter options.
 * @param {Array<string>} tags - Tags to add.
 * @returns {number} Number of tasks updated.
 */
function batchAddTagsByFilter(options, tags) {
  let query = 'SELECT id FROM tasks WHERE 1=1';
  const values = [];

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  if (options.existingTags && options.existingTags.length > 0) {
    const tagConditions = options.existingTags.map(() => "tags LIKE ? ESCAPE '\\'");
    query += ` AND (${tagConditions.join(' OR ')})`;
    options.existingTags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  const tasks = stmt.all(...values);
  const taskIds = tasks.map(t => t.id);

  return batchAddTags(taskIds, tags);
}

// ============ Archiving Functions ============

/**
 * Archive a single task
 * @param {string} taskId - Task identifier.
 * @param {string|null} [reason=null] - Archive reason.
 * @returns {object} Archive result object.
 */
function archiveTask(taskId, reason = null) {
  const task = getTaskFn(taskId);
  if (!task) return { success: false, reason: 'not_found' };

  const archivedAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO archived_tasks (id, original_data, archived_at, archive_reason)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    taskId,
    JSON.stringify(task),
    archivedAt,
    reason
  );

  // Delete from tasks table
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

  return { id: taskId, archived_at: archivedAt, success: true };
}

/**
 * Archive multiple tasks by filter
 * @param {object} [options={}] - Archive filter options.
 * @returns {object} Archive summary.
 */
function archiveTasks(options = {}) {
  // Normalize caller option shapes (RB-153)
  // Callers may pass { days_old, statuses } or { status, olderThan }
  if (options.days_old && !options.olderThan) {
    const cutoff = new Date(Date.now() - options.days_old * 24 * 60 * 60 * 1000).toISOString();
    options.olderThan = cutoff;
  }
  if (options.statuses && !options.status) {
    // statuses is an array - will be handled below
  }

  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

  let query = 'SELECT id FROM tasks WHERE 1=1';
  const values = [];

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  if (options.statuses && Array.isArray(options.statuses)) {
    // Filter to terminal statuses only (RB-153 safety)
    const safeStatuses = options.statuses.filter(s => TERMINAL_STATUSES.has(s));
    if (safeStatuses.length === 0) return { archived: 0, skipped_non_terminal: true };
    const placeholders = safeStatuses.map(() => '?').join(', ');
    query += ` AND status IN (${placeholders})`;
    values.push(...safeStatuses);
  }

  if (options.olderThan) {
    query += ' AND created_at < ?';
    values.push(options.olderThan);
  }

  if (options.tags && options.tags.length > 0) {
    const tagConditions = options.tags.map(() => "tags LIKE ? ESCAPE '\\'");
    query += ` AND (${tagConditions.join(' OR ')})`;
    options.tags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  // RB-153: Enforce terminal-state protection - never archive active tasks
  if (options.status && !TERMINAL_STATUSES.has(options.status)) {
    return { archived: 0, skipped_non_terminal: true };
  }

  const stmt = db.prepare(query);
  const tasks = stmt.all(...values);

  let count = 0;
  for (const task of tasks) {
    const result = archiveTask(task.id, options.reason || 'Bulk archive');
    if (result && result.success) count++;
  }

  return { archived: count };
}

/**
 * Get an archived task
 * @param {any} taskId
 * @returns {any}
 */
function getArchivedTask(taskId) {
  const stmt = db.prepare('SELECT * FROM archived_tasks WHERE id = ?');
  const row = stmt.get(taskId);
  if (row) {
    row.original_data = safeJsonParse(row.original_data, {});
  }
  return row;
}

/**
 * List archived tasks
 * @param {any} options
 * @returns {any}
 */
function listArchivedTasks(options = {}) {
  let query = 'SELECT * FROM archived_tasks';
  const values = [];

  query += ' ORDER BY archived_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  } else {
    query += ' LIMIT 100';
  }

  const stmt = db.prepare(query);
  return stmt.all(...values).map(row => ({
    ...row,
    original_data: safeJsonParse(row.original_data, {})
  }));
}

/**
 * Restore an archived task
 * @param {any} taskId
 * @returns {any}
 */
function restoreTask(taskId) {
  const archived = getArchivedTask(taskId);
  if (!archived) return null;

  // Re-create the task
  const task = archived.original_data;
  createTaskFn({
    id: task.id,
    status: task.status,
    task_description: task.task_description,
    working_directory: task.working_directory,
    timeout_minutes: task.timeout_minutes,
    auto_approve: task.auto_approve,
    priority: task.priority,
    context: safeJsonParse(task.context, null),
    tags: safeJsonParse(task.tags, null)
  });

  // Update with additional fields
  if (task.output || task.error_output || task.exit_code !== null) {
    db.prepare(`
      UPDATE tasks SET
        output = ?,
        error_output = ?,
        exit_code = ?,
        started_at = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      task.output,
      task.error_output,
      task.exit_code,
      task.started_at,
      task.completed_at,
      task.id
    );
  }

  // Delete from archive
  db.prepare('DELETE FROM archived_tasks WHERE id = ?').run(taskId);

  return task;
}

/**
 * Permanently delete an archived task
 */
function deleteArchivedTask(taskId) {
  const stmt = db.prepare('DELETE FROM archived_tasks WHERE id = ?');
  const result = stmt.run(taskId);
  return result.changes > 0;
}

/**
 * Get archive statistics
 * @returns {any}
 */
function getArchiveStats() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_archived,
      MIN(archived_at) as oldest_archive,
      MAX(archived_at) as newest_archive
    FROM archived_tasks
  `).get();

  const byReason = db.prepare(`
    SELECT archive_reason, COUNT(*) as count
    FROM archived_tasks
    GROUP BY archive_reason
  `).all();

  return {
    ...stats,
    by_reason: byReason
  };
}

// ============ Comments Functions ============

/**
 * Add a comment to a task
 * @param {string} taskId - Task identifier.
 * @param {string} commentText - Comment text.
 * @param {object} [options={}] - Additional comment options.
 * @returns {number} Comment identifier.
 */
function addTaskComment(taskId, commentText, options = {}) {
  const { author = 'user', commentType = 'note' } = options;

  const stmt = db.prepare(`
    INSERT INTO task_comments (task_id, author, comment_text, comment_type, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(taskId, author, commentText, commentType);

  // Record audit log
  recordAuditLogFn('task', taskId, 'comment_added', author, null, commentText, { commentType });

  return result.lastInsertRowid;
}

/**
 * Get comments for a task
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getTaskComments(taskId, options = {}) {
  const { commentType, limit = 100 } = options;

  let query = `SELECT * FROM task_comments WHERE task_id = ?`;
  const params = [taskId];

  if (commentType) {
    query += ` AND comment_type = ?`;
    params.push(commentType);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Delete a comment
 */
function deleteTaskComment(commentId, actor = 'user') {
  const comment = db.prepare(`SELECT * FROM task_comments WHERE id = ?`).get(commentId);
  if (!comment) return false;

  const stmt = db.prepare(`DELETE FROM task_comments WHERE id = ?`);
  const result = stmt.run(commentId);

  if (result.changes > 0) {
    recordAuditLogFn('task', comment.task_id, 'comment_deleted', actor, comment.comment_text, null, null);
  }

  return result.changes > 0;
}

// ============ Task Timeline Functions ============

/**
 * Get task timeline - all events in chronological order
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getTaskTimeline(taskId, options = {}) {
  const { limit = 100 } = options;
  const timeline = [];

  // Get task creation
  const task = getTaskFn(taskId);
  if (task) {
    timeline.push({
      type: 'created',
      timestamp: task.created_at,
      data: { description: (task.task_description || '').substring(0, 100) }
    });

    if (task.started_at) {
      timeline.push({
        type: 'started',
        timestamp: task.started_at,
        data: null
      });
    }

    if (task.completed_at) {
      timeline.push({
        type: task.status,
        timestamp: task.completed_at,
        data: { exit_code: task.exit_code }
      });
    }
  }

  // Get status change events
  const events = getTaskEventsFn(taskId, { limit: 500 });
  for (const event of events) {
    timeline.push({
      type: 'event',
      event_type: event.event_type,
      timestamp: event.created_at,
      data: {
        old_value: event.old_value,
        new_value: event.new_value,
        event_data: safeJsonParse(event.event_data, null)
      }
    });
  }

  // Get comments
  const comments = getTaskComments(taskId, { limit: 500 });
  for (const comment of comments) {
    timeline.push({
      type: 'comment',
      comment_type: comment.comment_type,
      timestamp: comment.created_at,
      data: {
        author: comment.author,
        text: comment.comment_text
      }
    });
  }

  // Get retry history
  const retries = typeof getRetryHistoryFn === 'function' ? getRetryHistoryFn(taskId) : [];
  for (const retry of retries) {
    timeline.push({
      type: 'retry',
      timestamp: retry.retried_at,
      data: {
        attempt: retry.attempt_number,
        delay: retry.delay_used,
        error: retry.error_message
      }
    });
  }

  // Get approval history
  const approvals = typeof getApprovalHistoryFn === 'function' ? getApprovalHistoryFn(taskId) : [];
  for (const approval of approvals) {
    timeline.push({
      type: 'approval',
      timestamp: approval.requested_at,
      data: {
        status: approval.status,
        rule: approval.rule_name,
        approved_by: approval.approved_by,
        approved_at: approval.approved_at
      }
    });
  }

  // Sort by timestamp and limit
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return timeline.slice(0, limit);
}


// Task Intelligence — see ./task-intelligence.js

// ============================================================
// Task Artifacts (merged from task-artifacts.js)
// ============================================================

function storeArtifact(artifact) {
  // Get config for limits
  const config = getArtifactConfig();
  const maxPerTask = parseInt(config.max_per_task || '20', 10);
  const retentionDays = parseInt(config.retention_days || '30', 10);
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Use atomic INSERT with subquery to prevent race condition
  // Only insert if the count for this task is below the limit
  const stmt = db.prepare(`
    INSERT INTO task_artifacts (
      id, task_id, name, file_path, mime_type, size_bytes, checksum, metadata, created_at, expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM task_artifacts WHERE task_id = ?) < ?
  `);

  const result = stmt.run(
    artifact.id,
    artifact.task_id,
    artifact.name,
    artifact.file_path,
    artifact.mime_type || null,
    artifact.size_bytes || null,
    artifact.checksum || null,
    artifact.metadata ? JSON.stringify(artifact.metadata) : null,
    now,
    expiresAt,
    artifact.task_id,  // For the WHERE subquery
    maxPerTask
  );

  // If no row was inserted, the limit was reached
  if (result.changes === 0) {
    throw new Error(`Maximum artifacts per task (${maxPerTask}) reached`);
  }

  return getArtifact(artifact.id);
}

/**
 * Get an artifact by ID
 */
function getArtifact(id) {
  const stmt = db.prepare('SELECT * FROM task_artifacts WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.metadata = safeJsonParse(row.metadata, null);
  }
  return row;
}

/**
 * List artifacts for a task
 */
function listArtifacts(taskId) {
  const stmt = db.prepare('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at DESC');
  return stmt.all(taskId).map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata, null)
  }));
}

/**
 * Delete an artifact
 */
function deleteArtifact(id) {
  const artifact = getArtifact(id);
  if (!artifact) return false;

  const stmt = db.prepare('DELETE FROM task_artifacts WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Get artifact config
 */
function getArtifactConfig() {
  const stmt = db.prepare('SELECT key, value FROM artifact_config');
  const rows = stmt.all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Set artifact config
 */
function setArtifactConfig(key, value) {
  const stmt = db.prepare('INSERT OR REPLACE INTO artifact_config (key, value) VALUES (?, ?)');
  stmt.run(key, String(value));
}

/**
 * Get expired artifacts for cleanup
 */
function getExpiredArtifacts() {
  const stmt = db.prepare('SELECT * FROM task_artifacts WHERE expires_at < ?');
  return stmt.all(new Date().toISOString()).map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata, null)
  }));
}

/**
 * Cleanup expired artifacts
 */
function cleanupExpiredArtifacts() {
  const expired = getExpiredArtifacts();
  const stmt = db.prepare('DELETE FROM task_artifacts WHERE expires_at < ?');
  const result = stmt.run(new Date().toISOString());
  return {
    deleted_count: result.changes,
    artifacts: expired
  };
}


// Task Debugger — see ./task-debugger.js

// ============================================================
// Bulk Operations (merged from bulk-operations.js)
// ============================================================

function createBulkOperation(operation) {
  const stmt = db.prepare(`
    INSERT INTO bulk_operations (
      id, operation_type, status, filter_criteria, affected_task_ids,
      total_tasks, succeeded_tasks, failed_tasks, dry_run, results, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    operation.id,
    operation.operation_type,
    operation.status || 'pending',
    JSON.stringify(operation.filter_criteria || {}),
    operation.affected_task_ids ? JSON.stringify(operation.affected_task_ids) : null,
    operation.total_tasks || 0,
    operation.succeeded_tasks || 0,
    operation.failed_tasks || 0,
    operation.dry_run ? 1 : 0,
    operation.results ? JSON.stringify(operation.results) : null,
    new Date().toISOString()
  );

  return getBulkOperation(operation.id);
}

/**
 * Get a bulk operation by ID
 */
function getBulkOperation(id) {
  const stmt = db.prepare('SELECT * FROM bulk_operations WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.filter_criteria = safeJsonParse(row.filter_criteria, {});
    row.affected_task_ids = safeJsonParse(row.affected_task_ids, []);
    row.results = safeJsonParse(row.results, null);
    row.dry_run = Boolean(row.dry_run);
  }
  return row;
}

/**
 * Update a bulk operation
 */
function updateBulkOperation(id, updates) {
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (updates.affected_task_ids !== undefined) {
    fields.push('affected_task_ids = ?');
    values.push(JSON.stringify(updates.affected_task_ids));
  }

  if (updates.total_tasks !== undefined) {
    fields.push('total_tasks = ?');
    values.push(updates.total_tasks);
  }

  if (updates.succeeded_tasks !== undefined) {
    fields.push('succeeded_tasks = ?');
    values.push(updates.succeeded_tasks);
  }

  if (updates.failed_tasks !== undefined) {
    fields.push('failed_tasks = ?');
    values.push(updates.failed_tasks);
  }

  if (updates.results !== undefined) {
    fields.push('results = ?');
    values.push(JSON.stringify(updates.results));
  }

  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }

  if (updates.status === 'completed' || updates.status === 'failed') {
    fields.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  if (fields.length === 0) return getBulkOperation(id);

  values.push(id);
  const stmt = db.prepare(`UPDATE bulk_operations SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getBulkOperation(id);
}

/**
 * List bulk operations with optional filtering
 */
function listBulkOperations(options = {}) {
  let query = 'SELECT * FROM bulk_operations';
  const conditions = [];
  const values = [];

  if (options.operation_type) {
    conditions.push('operation_type = ?');
    values.push(options.operation_type);
  }

  if (options.status) {
    conditions.push('status = ?');
    values.push(options.status);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...values);

  return rows.map(row => ({
    ...row,
    filter_criteria: safeJsonParse(row.filter_criteria, {}),
    affected_task_ids: safeJsonParse(row.affected_task_ids, []),
    results: safeJsonParse(row.results, null),
    dry_run: Boolean(row.dry_run)
  }));
}

/**
 * Perform a dry run of a bulk operation
 */
function dryRunBulkOperation(operationType, filterCriteria) {
  const tasks = getTasksMatchingFilter(filterCriteria);

  return {
    operation_type: operationType,
    filter_criteria: filterCriteria,
    affected_task_ids: tasks.map(t => t.id),
    total_tasks: tasks.length,
    preview: tasks.slice(0, 10).map(t => ({
      id: t.id,
      status: t.status,
      description: t.task_description ? t.task_description.substring(0, 50) + '...' : '(no description)'
    }))
  };
}

/**
 * Get tasks matching filter criteria
 */
function getTasksMatchingFilter(filterCriteria) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const values = [];

  if (filterCriteria.status) {
    if (Array.isArray(filterCriteria.status)) {
      if (filterCriteria.status.length === 0) {
        return []; // Empty status array matches nothing
      }
      query += ` AND status IN (${filterCriteria.status.map(() => '?').join(',')})`;
      values.push(...filterCriteria.status);
    } else {
      query += ' AND status = ?';
      values.push(filterCriteria.status);
    }
  }

  if (filterCriteria.tags && filterCriteria.tags.length > 0) {
    const tagConditions = filterCriteria.tags.map(() => "tags LIKE ? ESCAPE '\\'");
    query += ` AND (${tagConditions.join(' OR ')})`;
    filterCriteria.tags.forEach(tag => values.push(`%"${escapeLikePattern(tag)}"%`));
  }

  if (filterCriteria.older_than_hours) {
    const cutoff = new Date(Date.now() - filterCriteria.older_than_hours * 3600000);
    query += ' AND created_at < ?';
    values.push(cutoff.toISOString());
  }

  if (filterCriteria.project) {
    query += ' AND project = ?';
    values.push(filterCriteria.project);
  }

  const stmt = db.prepare(query);
  return stmt.all(...values);
}

// ============================================
// Factory function — one-call DI setup
// ============================================

/**
 * Create a fully-wired task-metadata instance.
 * @param {{ db: any, taskCore?: object, getTaskEvents?: Function, getRetryHistory?: Function, recordAuditLog?: Function, getApprovalHistory?: Function, createTaskFn?: Function }} options
 * @returns {object} All public functions from this module
 */
function createTaskMetadata({ db: dbInstance, taskCore, getTaskEvents, getRetryHistory, recordAuditLog, getApprovalHistory, createTaskFn } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore?.getTask) setGetTask(taskCore.getTask);
  if (getTaskEvents) setGetTaskEvents(getTaskEvents);
  if (getRetryHistory) setGetRetryHistory(getRetryHistory);
  if (recordAuditLog) setRecordAuditLog(recordAuditLog);
  if (getApprovalHistory) setGetApprovalHistory(getApprovalHistory);
  if (createTaskFn) setCreateTask(createTaskFn);
  return module.exports;
}

module.exports = {
  createTaskMetadata,
  // DI
  setDb,
  setGetTask,
  setGetTaskEvents,
  setGetRetryHistory,
  setRecordAuditLog,
  setGetApprovalHistory,
  setCreateTask,
  // Task File Changes
  recordFileChange,
  getTaskFileChanges,
  getRollbackPoints,
  // Task Groups
  createTaskGroup,
  getTaskGroup,
  listTaskGroups,
  getGroupTasks,
  getGroupStats,
  addTaskToGroup,
  deleteTaskGroup,
  // Git Integration
  updateTaskGitState,
  getTasksWithCommits,
  // Task Tags
  addTaskTags,
  removeTaskTags,
  getAllTags,
  getTagStats,
  // Batch Operations
  batchCancelTasks,
  getRetryableTasks,
  batchAddTags,
  batchAddTagsByFilter,
  // Archiving
  archiveTask,
  archiveTasks,
  getArchivedTask,
  listArchivedTasks,
  restoreTask,
  deleteArchivedTask,
  getArchiveStats,
  // Comments
  addTaskComment,
  getTaskComments,
  deleteTaskComment,
  // Timeline
  getTaskTimeline,
  // Task Intelligence (see ./task-intelligence.js)
  ...taskIntelligence,
  // Task Artifacts (merged from task-artifacts.js)
  storeArtifact,
  getArtifact,
  listArtifacts,
  deleteArtifact,
  getArtifactConfig,
  setArtifactConfig,
  getExpiredArtifacts,
  cleanupExpiredArtifacts,
  // Task Debugger (see ./task-debugger.js)
  ...taskDebugger,
  // Bulk Operations (merged from bulk-operations.js)
  createBulkOperation,
  getBulkOperation,
  updateBulkOperation,
  listBulkOperations,
  dryRunBulkOperation,
  getTasksMatchingFilter,
};
