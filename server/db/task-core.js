'use strict';

/**
 * db/task-core.js — Core task CRUD, status transitions, and queue operations.
 *
 * Extracted from database.js Phase 3.1 decomposition.
 * All inline task functions from database.js now live here.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setExternalFns() to receive cross-module helpers that would otherwise
 * create circular requires (getProjectFromPath, recordEvent, escapeLikePattern,
 * recordTaskFileWrite, notifyTaskStatusTransition).
 */

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'task-core' });
const { safeJsonParse } = require('../utils/json');
const { buildTaskFilterConditions, appendWhereClause } = require('./query-filters');
const { MAX_METADATA_SIZE } = require('../constants');
const { ErrorCodes } = require('../handlers/error-codes');
const eventBus = require('../event-bus');

// ============================================================
// Shared constants — mirrors database.js copies exactly
// ============================================================

// === SECURITY: Column whitelist for dynamic SQL queries (M1) ===
const ALLOWED_TASK_COLUMNS = new Set([
  'id', 'status', 'task_description', 'working_directory', 'timeout_minutes',
  'auto_approve', 'priority', 'context', 'output', 'error_output', 'exit_code',
  'pid', 'progress_percent', 'files_modified', 'created_at', 'started_at',
  'completed_at', 'retry_count', 'max_retries', 'depends_on', 'template_name',
  'isolated_workspace', 'git_before_sha', 'git_after_sha', 'git_stash_ref',
  'tags', 'project', 'retry_strategy', 'retry_delay_seconds', 'last_retry_at',
  'group_id', 'paused_at', 'pause_reason', 'approval_status', 'workflow_id',
  'workflow_node_id', 'claimed_by_agent', 'required_capabilities', 'ollama_host_id',
  'provider', 'model', 'original_provider', 'provider_switched_at',
  'mcp_instance_id', 'complexity', 'metadata', 'task_metadata',
  'partial_output'
]);

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

const TRANSACTION_RESULT_SENTINEL = 'TORQUE_TRANSACTION_RESULT';

function createTransactionResultError(result) {
  const error = new Error(TRANSACTION_RESULT_SENTINEL);
  error.code = TRANSACTION_RESULT_SENTINEL;
  error.result = result;
  return error;
}

// ============================================================
// Dependency injection
// ============================================================

let db = null;
let dbClosed = false;

// Cross-module function references (injected to avoid circular requires)
let _getProjectFromPath = null;
let _recordEvent = null;
let _escapeLikePattern = null;
let _recordTaskFileWrite = null;
let _notifyTaskStatusTransition = null;
let _getConfig = null;

function setDb(dbInstance) {
  if (dbInstance === null) {
    dbClosed = true;
  } else {
    dbClosed = false;
  }
  db = dbInstance;
}

/**
 * Set the dbClosed flag independently (for resetForTest).
 * @param {boolean} closed
 */
function setDbClosed(closed) {
  dbClosed = closed;
}

/**
 * Inject cross-module helpers.
 * @param {object} fns
 * @param {Function} fns.getProjectFromPath
 * @param {Function} fns.recordEvent
 * @param {Function} fns.escapeLikePattern
 * @param {Function} fns.recordTaskFileWrite
 * @param {Function} fns.notifyTaskStatusTransition
 * @param {Function} fns.getConfig
 */
function setExternalFns(fns) {
  if (fns.getProjectFromPath) _getProjectFromPath = fns.getProjectFromPath;
  if (fns.recordEvent) _recordEvent = fns.recordEvent;
  if (fns.escapeLikePattern) _escapeLikePattern = fns.escapeLikePattern;
  if (fns.recordTaskFileWrite) _recordTaskFileWrite = fns.recordTaskFileWrite;
  if (fns.notifyTaskStatusTransition) _notifyTaskStatusTransition = fns.notifyTaskStatusTransition;
  if (fns.getConfig) _getConfig = fns.getConfig;
}

// ============================================================
// Validate column name against whitelist
// ============================================================

/**
 * Validate column name against whitelist.
 * Throws if invalid column name detected.
 * @param {string} column
 * @param {Set} [allowedSet]
 * @returns {string}
 */
function validateColumnName(column, allowedSet = ALLOWED_TASK_COLUMNS) {
  if (!allowedSet.has(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return column;
}

// ============================================================
// Internal helpers
// ============================================================

function normalizeProviderValue(provider) {
  if (typeof provider !== 'string') return provider;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeApprovalStatus(value) {
  if (value === undefined) {
    return 'not_required';
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'none') {
    return 'not_required';
  }
  return normalized;
}

function normalizeMetadataObject(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return {};
  }
  if (typeof value === 'object') {
    return { ...value };
  }
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  }
  return {};
}

function applyProviderSwitchEnrichment(sourceTask, targetProvider, additionalFields = {}, providerSwitchReason = null) {
  const fromProvider = sourceTask?.provider || null;
  const normalizedTargetProvider = normalizeProviderValue(targetProvider);
  if (!fromProvider || !normalizedTargetProvider || normalizedTargetProvider === fromProvider) {
    return additionalFields;
  }

  const now = new Date().toISOString();
  if (!sourceTask.original_provider && !Object.prototype.hasOwnProperty.call(additionalFields, 'original_provider')) {
    additionalFields.original_provider = fromProvider;
  }
  if (!Object.prototype.hasOwnProperty.call(additionalFields, 'model')) {
    additionalFields.model = null;
  }
  // TDA-02: Clear host identity when moving away from an Ollama provider.
  const ollamaProviders = new Set(['ollama', 'hashline-ollama']);
  if (!ollamaProviders.has(normalizedTargetProvider) && !Object.prototype.hasOwnProperty.call(additionalFields, 'ollama_host_id')) {
    additionalFields.ollama_host_id = null;
  }
  if (!Object.prototype.hasOwnProperty.call(additionalFields, 'provider_switched_at')) {
    additionalFields.provider_switched_at = now;
  }

  const providerMeta = normalizeMetadataObject(
    Object.prototype.hasOwnProperty.call(additionalFields, 'metadata')
      ? additionalFields.metadata
      : sourceTask?.metadata
  );
  if (!providerMeta.requested_provider) {
    providerMeta.requested_provider = sourceTask?.original_provider || fromProvider;
  }

  const switchEntry = {
    from: fromProvider,
    to: normalizedTargetProvider,
    at: now,
    reason: providerSwitchReason || 'runtime_provider_fallback',
  };
  const history = Array.isArray(providerMeta.provider_switch_history)
    ? providerMeta.provider_switch_history
    : [];
  history.push(switchEntry);
  providerMeta.provider_switch_history = history.slice(-20);
  providerMeta.last_provider_switch = { ...switchEntry };
  additionalFields.metadata = providerMeta;

  return additionalFields;
}

function normalizeFilesModifiedField(value) {
  const parsed = typeof value === 'string'
    ? safeJsonParse(value, [])
    : value;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of parsed) {
    const filePath = typeof entry === 'string'
      ? entry
      : (entry && typeof entry.path === 'string' ? entry.path : '');
    const trimmed = String(filePath || '').trim();
    if (!trimmed) continue;

    const dedupeKey = trimmed.replace(/\\/g, '/');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }

  return normalized;
}

// ============================================================
// Core task CRUD
// ============================================================

function createTask(task) {
  if (dbClosed || !db) throw new Error('Database is closed');
  const normalizedProvider = normalizeProviderValue(task.provider);
  const normalizedApprovalStatus = normalizeApprovalStatus(task.approval_status);
  const resolvedProvider = normalizedProvider || (_getConfig ? _getConfig('default_provider') : null) || 'codex';
  const originalProvider = task.original_provider || resolvedProvider;
  const metadataObject = normalizeMetadataObject(task.metadata);
  if (!metadataObject.requested_provider) {
    metadataObject.requested_provider = resolvedProvider;
  }
  // Mark tasks that were auto-routed to the default provider (no explicit provider given).
  if (!normalizedProvider && !metadataObject.user_provider_override) {
    metadataObject.auto_routed = true;
  }
  // Validate task.id is a non-empty string
  if (!task.id || typeof task.id !== 'string' || task.id.trim().length === 0) {
    throw new Error('task.id must be a non-empty string');
  }

  // Validate working_directory is a real path before storing.
  if (task.working_directory) {
    const normalizedWd = path.resolve(task.working_directory);
    try {
      const stats = fs.statSync(normalizedWd);
      if (!stats.isDirectory()) {
        throw new Error(`working_directory is not a directory: ${task.working_directory}`);
      }
      // Use the resolved path to normalize separators
      task.working_directory = normalizedWd;
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`working_directory does not exist: ${task.working_directory} (resolved: ${normalizedWd}). If submitting via REST API, ensure backslashes are properly escaped in JSON.`);
      }
      throw err;
    }
  }

  // Auto-detect project from working directory
  const project = task.project || (_getProjectFromPath ? _getProjectFromPath(task.working_directory) : null);

  // RB-032: Bound metadata size to prevent overflow
  const metadataStr = task.metadata === null || task.metadata === undefined
    ? null
    : JSON.stringify(metadataObject);
  if (metadataStr && typeof metadataStr === 'string' && metadataStr.length > MAX_METADATA_SIZE) {
    throw new Error(`metadata exceeds maximum size (${metadataStr.length} > ${MAX_METADATA_SIZE} bytes)`);
  }
  const status = task.status || 'pending';

  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, status, task_description, working_directory,
      timeout_minutes, auto_approve, priority, context, created_at,
      max_retries, depends_on, template_name, isolated_workspace, approval_status, tags, project, provider, model,
      complexity, review_status, ollama_host_id, original_provider, provider_switched_at, metadata, workflow_id, workflow_node_id, stall_timeout_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    stmt.run(
      task.id,
      status,
      task.task_description,
      task.working_directory || null,
      task.timeout_minutes ?? 480,
      task.auto_approve ? 1 : 0,
      task.priority || 0,
      task.context ? JSON.stringify(task.context) : null,
      new Date().toISOString(),
      task.max_retries !== undefined ? task.max_retries : 2,
      task.depends_on ? JSON.stringify(task.depends_on) : null,
      task.template_name || null,
      task.isolated_workspace || null,
      normalizedApprovalStatus,
      task.tags ? JSON.stringify(task.tags) : null,
      project,
      normalizedProvider,
      task.model || null,
      task.complexity || 'normal',
      task.review_status || null,
      task.ollama_host_id || null,
      originalProvider,
      null, // provider_switched_at
      metadataStr,
      task.workflow_id || null,
      task.workflow_node_id || null,
      task.stall_timeout_seconds ?? null
    );
  } catch (err) {
    // F5: Translate SQLITE_FULL to a user-friendly message
    if (err.code === 'SQLITE_FULL' || /database or disk is full/i.test(err.message)) {
      throw new Error('Database disk space exhausted — cannot create task. Free disk space or run vacuum_database maintenance task.');
    }
    throw err;
  }

  if (status === 'queued' || status === 'pending') {
    eventBus.emitQueueChanged();
  }

  // Record analytics event
  if (_recordEvent) {
    _recordEvent('task_created', task.id, {
      template: task.template_name,
      has_dependencies: !!task.depends_on,
      tags: task.tags,
      project
    });
  }

  return getTask(task.id);
}

/**
 * Resolve a partial task ID to full UUID.
 * Returns the full ID if found, null otherwise.
 * @param {string} id
 * @returns {string|null}
 */
function resolveTaskId(id) {
  if (!id || !db) return null;
  if (id.length === 36) return id; // Already full UUID
  // Escape LIKE metacharacters so a prefix like "50%" doesn't match unintended rows
  const escapedId = id.replace(/[%_\\]/g, '\\$&');
  const startsWith = db.prepare("SELECT id FROM tasks WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at DESC").all(escapedId + '%');
  if (startsWith.length > 1) {
    const err = new Error(`Ambiguous task ID prefix "${id}" matches ${startsWith.length} tasks`);
    err.code = ErrorCodes.INVALID_PARAM;
    err.error_code = ErrorCodes.INVALID_PARAM;
    throw err;
  }
  if (startsWith.length === 1) {
    return startsWith[0].id;
  }
  return null;
}

/**
 * Get a task by ID (supports partial ID prefix matching).
 * @param {string} id
 * @returns {object|null}
 */
function getTask(id) {
  if (!id || !db) return null;

  // Resolve partial ID to full ID
  const fullId = id.length < 36 ? resolveTaskId(id) : id;
  if (!fullId) return null;

  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(fullId);

  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
    row.context = safeJsonParse(row.context, null);
    row.files_modified = safeJsonParse(row.files_modified, []);
    row.tags = safeJsonParse(row.tags, []);
    row.depends_on = safeJsonParse(row.depends_on, null);
    row.required_capabilities = safeJsonParse(row.required_capabilities, null);
    if (typeof row.metadata === 'string') {
      try {
        row.metadata = JSON.parse(row.metadata);
      } catch (_err) {
        void _err;
        // Corrupted metadata — return empty object so callers always get an object,
        // never a raw JSON string. The bad value stays in the DB and can be inspected;
        // we don't silently overwrite it here.
        row.metadata = {};
      }
    }
  }
  return row;
}

/**
 * Update non-status task fields without applying status transition rules.
 * Intended for post-completion metadata enrichment and similar in-place writes.
 * @param {string} id
 * @param {object} additionalFields
 * @returns {object|null}
 */
function updateTask(id, additionalFields = {}) {
  if (dbClosed || !db) {
    logger.warn(`[DB] Ignoring updateTask(${id}) — database is closed`);
    return null;
  }

  if (!additionalFields || typeof additionalFields !== 'object' || Array.isArray(additionalFields)) {
    throw new Error('updateTask additionalFields must be an object');
  }

  if (Object.prototype.hasOwnProperty.call(additionalFields, 'status')) {
    throw new Error('Use updateTaskStatus() to modify task status');
  }

  const entries = Object.entries(additionalFields);
  if (entries.length === 0) {
    return getTask(id);
  }

  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    additionalFields.provider = normalizeProviderValue(additionalFields.provider);
  }

  const updates = [];
  const values = [];

  // JSON column list — MUST be kept in sync with the equivalent list in updateTaskStatus().
  // Any column that stores serialized JSON must appear in BOTH lists so callers that
  // pass object values get them stringified regardless of which update path is used.
  // Currently: files_modified, context, tags, metadata, depends_on, required_capabilities.
  // If you add a new JSON column to the tasks table, add it to both lists.
  for (const [key, value] of Object.entries(additionalFields)) {
    validateColumnName(key, ALLOWED_TASK_COLUMNS);
    updates.push(`${key} = ?`);
    if (
      key === 'files_modified'
      || key === 'context'
      || key === 'tags'
      || key === 'metadata'
      || key === 'depends_on'
      || key === 'required_capabilities'
    ) {
      values.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
    } else {
      values.push(value);
    }
  }

  values.push(id);
  const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getTask(id);
}

/**
 * Update task status with transaction for critical transitions.
 * Critical transitions (running->completed/failed, any->cancelled) use transactions
 * to prevent race conditions in concurrent environments.
 * @param {string} id
 * @param {string} status
 * @param {object} additionalFields
 * @returns {object|null}
 */
function updateTaskStatus(id, status, additionalFields = {}) {
  if (dbClosed || !db) {
    logger.warn(`[DB] Ignoring updateTaskStatus(${id}, ${status}) — database is closed`);
    return null;
  }
  // Clone to avoid mutating the caller's object
  additionalFields = { ...additionalFields };
  const providerSwitchReason = typeof additionalFields._provider_switch_reason === 'string'
    ? additionalFields._provider_switch_reason
    : null;
  delete additionalFields._provider_switch_reason;
  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    additionalFields.provider = normalizeProviderValue(additionalFields.provider);
  }

  // When requeuing a task, clear the provider so routing can re-evaluate.
  // BUG-001 fix: preserve the provider when the user (or workflow node) explicitly
  // requested it — clearing it would discard the user_provider_override intent and
  // let smart-routing reassign the task to a different provider.
  if (status === 'queued' && !Object.prototype.hasOwnProperty.call(additionalFields, 'provider') && !additionalFields._preserveProvider) {
    let hasUserOverride = false;
    try {
      const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id);
      if (row && row.metadata) {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        hasUserOverride = !!meta.user_provider_override;
      }
    } catch (_e) { /* non-fatal — fall through to clear */ }
    if (!hasUserOverride) {
      additionalFields.provider = null;
    }
  }
  delete additionalFields._preserveProvider;

  const updates = ['status = ?'];
  const values = [status];
  let previousStatus = null;
  let setCompletedAt = status === 'completed' || status === 'failed';

  if (status === 'running' && !additionalFields.started_at) {
    updates.push('started_at = ?');
    values.push(new Date().toISOString());
  }

  // Extract internal flags before processing columns
  const softFail = additionalFields._softFail;
  delete additionalFields._softFail;

  // Track provider switch metadata when a provider transition occurs.
  if (Object.prototype.hasOwnProperty.call(additionalFields, 'provider')) {
    try {
      const currentTask = db.prepare('SELECT provider, original_provider, metadata FROM tasks WHERE id = ?').get(id);
      applyProviderSwitchEnrichment(currentTask, additionalFields.provider, additionalFields, providerSwitchReason);
    } catch (err) {
      logger.info(`[DB] Provider switch metadata enrichment failed for ${id}: ${err.message}`);
    }
  }

  for (const [key, value] of Object.entries(additionalFields)) {
    // Validate column name to prevent SQL injection
    validateColumnName(key, ALLOWED_TASK_COLUMNS);
    updates.push(`${key} = ?`);
    if (key === 'files_modified' || key === 'context' || key === 'tags' || key === 'metadata') {
      values.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
    } else {
      values.push(value);
    }
  }

  // Use transaction for critical status transitions to prevent race conditions
  const isCriticalTransition = ['completed', 'failed', 'cancelled', 'skipped', 'running'].includes(status);

  if (isCriticalTransition) {
    try {
      const criticalTransition = db.transaction(() => {
        // Verify task exists and hasn't already transitioned
        const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
        if (!current) {
          throw new Error(`Task not found: ${id}`);
        }

        // Prevent double-completion or invalid transitions
        if (current.status === status && Object.keys(additionalFields).length === 0) {
          throw createTransactionResultError(getTask(id));
        }
        if (TERMINAL_TASK_STATUSES.has(current.status) && !['pending', 'queued', 'waiting'].includes(status)) {
          if (softFail) {
            logger.warn(`[DB] Soft-fail: task ${id} already in terminal state '${current.status}', skipping transition to '${status}'`);
            throw createTransactionResultError(getTask(id));
          }
          throw new Error(`Cannot transition task ${id} from ${current.status} to ${status}`);
        }

        previousStatus = current.status;

        if (status === 'cancelled' && previousStatus === 'running') setCompletedAt = true;
        if (status === 'skipped') setCompletedAt = true;
        if (setCompletedAt) {
          updates.push('completed_at = ?');
          values.push(new Date().toISOString());
        }
        values.push(id);
        values.push(previousStatus);

        const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND status = ?`);
        const result = stmt.run(...values);
        if (result.changes === 0) {
          logger.warn(`[DB] Double-completion race: task ${id} status changed by another process (expected '${previousStatus}')`);
          throw createTransactionResultError(getTask(id));
        }
      });
      criticalTransition.immediate();
    } catch (err) {
      if (err?.code === TRANSACTION_RESULT_SENTINEL) {
        return err.result;
      }
      throw err;
    }
  } else {
    // Non-critical updates don't need transaction overhead
    const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
    if (!current) {
      values.push(id);
      const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      return null;
    }

    if (TERMINAL_TASK_STATUSES.has(current.status) && !['pending', 'queued', 'waiting'].includes(status)) {
      if (softFail) {
        return getTask(id);
      }
      throw new Error(`Cannot transition task ${id} from ${current.status} to ${status}`);
    }

    previousStatus = current.status;
    values.push(id);
    values.push(previousStatus);
    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND status = ?`);
    const result = stmt.run(...values);
    if (result.changes === 0) {
      // Concurrent update detected — re-read and return current state
      const refreshed = getTask(id);
      logger.warn(`[DB] Non-critical update race: task ${id} status changed concurrently (expected '${previousStatus}', now '${refreshed?.status}')`);
      return refreshed;
    }
  }

  if (status === 'queued' || status === 'pending' || TERMINAL_TASK_STATUSES.has(status)) {
    eventBus.emitQueueChanged();
  }

  if (TERMINAL_TASK_STATUSES.has(status) && Object.prototype.hasOwnProperty.call(additionalFields, 'files_modified')) {
    const modifiedFiles = normalizeFilesModifiedField(additionalFields.files_modified);
    for (const filePath of modifiedFiles) {
      try {
        if (_recordTaskFileWrite) _recordTaskFileWrite(id, filePath, null);
      } catch (err) {
        logger.debug(`[DB] Failed to record task file snapshot for ${id} ${filePath}: ${err.message}`);
      }
    }
  }

  if (TERMINAL_TASK_STATUSES.has(status) && previousStatus && previousStatus !== status) {
    if (_notifyTaskStatusTransition) _notifyTaskStatusTransition(id, status, previousStatus, getTask(id));
  }

  // Emit task:started for heartbeat notifications (only on actual transition to running)
  if (status === 'running' && previousStatus && previousStatus !== 'running') {
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      const updatedTask = getTask(id);
      if (updatedTask) {
        dispatchTaskEvent('started', updatedTask);
      }
    } catch {
      // Non-fatal — never block status transition
    }
  }

  return getTask(id);
}

/**
 * Return a task to queue after it was treated as starting but never reached a
 * truthful execution start. Clears transient execution artifacts so queued
 * state cannot masquerade as partially running or completed work.
 *
 * @param {string} id
 * @param {object} additionalFields
 * @returns {object|null}
 */
function requeueTaskAfterAttemptedStart(id, additionalFields = {}) {
  // Extract provider from patch — route it to metadata instead of the column
  const { provider: patchProvider, metadata: patchMetadata, ...restFields } = additionalFields;

  let metadataUpdate = patchMetadata;
  if (patchProvider) {
    // Read existing metadata, merge routing hints with any caller-supplied patch metadata.
    const task = getTask(id);
    const existingMeta = normalizeMetadataObject(task?.metadata);
    const patchMetaObject = normalizeMetadataObject(patchMetadata);
    metadataUpdate = {
      ...existingMeta,
      ...patchMetaObject,
      intended_provider: patchProvider,
      eligible_providers: [patchProvider],
    };
  }

  return updateTaskStatus(id, 'queued', {
    started_at: null,
    completed_at: null,
    pid: null,
    progress_percent: null,
    exit_code: null,
    mcp_instance_id: null,
    ollama_host_id: null,
    provider: null,
    ...restFields,
    ...(metadataUpdate != null ? { metadata: metadataUpdate } : {}),
  });
}

/**
 * Update task progress.
 * Progress is clamped to 0-100 range to handle edge cases.
 * @param {string} id
 * @param {number} progress
 * @param {string|null} output
 */
function updateTaskProgress(id, progress, output = null) {
  // Clamp progress to valid range (0-100) and handle edge cases
  let validProgress = 0;
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    validProgress = Math.max(0, Math.min(100, Math.round(progress)));
  } else if (typeof progress === 'string') {
    const parsed = parseInt(progress, 10);
    if (Number.isFinite(parsed)) {
      validProgress = Math.max(0, Math.min(100, parsed));
    }
  }

  const updates = ['progress_percent = ?'];
  const values = [validProgress];

  if (output !== null) {
    updates.push('output = COALESCE(output, \'\') || ?');
    values.push(output);
  }

  values.push(id);

  const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

/**
 * List tasks with optional filtering.
 * @param {object} options
 * @returns {Array}
 */
function listTasks(options = {}) {
  let query = 'SELECT * FROM tasks';
  const escapeFn = _escapeLikePattern || ((s) => s);
  const { conditions, values } = buildTaskFilterConditions(options, escapeFn);
  query = appendWhereClause(query, conditions);

  // Support custom ordering with whitelist validation
  const allowedOrderColumns = ['created_at', 'completed_at', 'started_at', 'priority', 'status', 'id'];
  const orderCol = allowedOrderColumns.includes(options.orderBy) ? options.orderBy : 'created_at';
  const orderDir = options.orderDir === 'desc' ? 'DESC' : 'ASC';
  const idDir = orderDir;
  query += ` ORDER BY ${orderCol} ${orderDir}, id ${idDir}`;

  // Apply limit with bounds validation to prevent excessive result sets
  const MAX_LIMIT = 10000;
  const DEFAULT_LIMIT = 1000;
  if (options.limit) {
    const boundedLimit = Math.max(1, Math.min(parseInt(options.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT));
    query += ' LIMIT ?';
    values.push(boundedLimit);
  } else {
    // Apply default limit to prevent unbounded queries
    query += ' LIMIT ?';
    values.push(DEFAULT_LIMIT);
  }

  // Apply offset for pagination
  if (options.offset && options.offset > 0) {
    query += ' OFFSET ?';
    values.push(parseInt(options.offset, 10));
  }

  // Validate query length to prevent DoS via pathologically large queries
  const MAX_QUERY_LENGTH = 10000;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query too complex: ${query.length} chars exceeds ${MAX_QUERY_LENGTH} limit`);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...values);

  return rows.map(row => ({
    ...row,
    auto_approve: Boolean(row.auto_approve),
    context: safeJsonParse(row.context, null),
    files_modified: safeJsonParse(row.files_modified, []),
    tags: safeJsonParse(row.tags, [])
  }));
}

/**
 * Fetch queued tasks with only the columns needed for queue processing.
 * Avoids fetching large TEXT blobs (output, error_output, context).
 * @param {number} limit - Maximum tasks to return (default 1000)
 * @returns {Array} Lightweight task rows
 */
function listQueuedTasksLightweight(limit = 1000) {
  if (!db || dbClosed) return [];
  return db.prepare(`
    SELECT t.id, t.status, t.provider, t.original_provider, t.model, t.priority,
           t.created_at, t.working_directory, t.timeout_minutes, t.auto_approve,
           t.retry_count, t.max_retries, t.depends_on, t.approval_status,
           t.ollama_host_id, t.stall_timeout_seconds, t.metadata, t.tags,
           COALESCE(w.priority, 0) as workflow_priority
    FROM tasks t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.status = 'queued'
    ORDER BY COALESCE(w.priority, 0) DESC, t.priority DESC, t.created_at ASC
    LIMIT ?
  `).all(limit);
}

/**
 * Delete all child records for a specific task ID from all FK-linked tables.
 */
function _cleanOrphanedTaskChildren(taskId) {
  const childTables = Object.freeze([
    'pipeline_steps', 'token_usage', 'retry_history', 'task_file_changes', 'task_file_writes',
    'task_streams', 'task_checkpoints', 'task_event_subscriptions', 'task_events',
    'task_suggestions', 'approval_requests', 'peek_recovery_approvals', 'task_comments', 'resource_usage',
    'task_claims', 'work_stealing_log', 'validation_results',
    'pending_approvals', 'failure_matches', 'retry_attempts', 'diff_previews',
    'quality_scores', 'task_rollbacks', 'build_checks', 'cost_tracking',
    'task_fingerprints', 'file_backups', 'security_scans', 'test_coverage',
    'style_checks', 'change_impacts', 'timeout_alerts', 'output_violations',
    'expected_output_paths', 'file_location_anomalies', 'duplicate_file_detections',
    'type_verification_results', 'build_error_analysis', 'similar_file_search',
    'task_complexity_scores', 'auto_rollbacks', 'xaml_validation_results',
    'xaml_consistency_results', 'smoke_test_results'
  ]);
  for (const table of childTables) {
    try { db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId); } catch (_e) { void _e; /* skip */ }
  }
  // Tables with non-standard FK columns
  try { db.prepare('DELETE FROM similar_tasks WHERE source_task_id = ? OR similar_task_id = ?').run(taskId, taskId); } catch (_e) { void _e; /* skip */ }
  try { db.prepare('DELETE FROM task_replays WHERE original_task_id = ? OR replay_task_id = ?').run(taskId, taskId); } catch (_e) { void _e; /* skip */ }
}

/**
 * Delete a task and all its child records (cascading).
 * Only tasks in terminal states (failed, completed, cancelled) can be deleted.
 * @param {string} taskId
 * @returns {object}
 */
function deleteTask(taskId) {
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'running' || task.status === 'queued' || task.status === 'pending') {
    throw new Error(`Cannot delete task ${taskId} — status is '${task.status}'. Cancel it first.`);
  }
  const del = db.transaction(() => {
    _cleanOrphanedTaskChildren(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  del();
  return { deleted: true, id: taskId, status: task.status };
}

/**
 * Delete all tasks matching a status filter (e.g. 'failed') with cascading.
 * Only terminal states allowed. Returns count of deleted tasks.
 * @param {string} status
 * @returns {object}
 */
function deleteTasks(status) {
  const allowed = ['failed', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    throw new Error(`Can only bulk-delete tasks with status: ${allowed.join(', ')}. Got: '${status}'`);
  }
  const del = db.transaction(() => {
    // Get IDs first for targeted child cleanup
    const taskIds = db.prepare('SELECT id FROM tasks WHERE status = ?').all(status).map(r => r.id);
    for (const id of taskIds) {
      _cleanOrphanedTaskChildren(id);
    }
    return db.prepare('DELETE FROM tasks WHERE status = ?').run(status);
  });
  const result = del();
  return { deleted: result.changes, status };
}

/**
 * Count tasks matching filter criteria (for pagination).
 * @param {object} options
 * @returns {number}
 */
function countTasks(options = {}) {
  let query = 'SELECT COUNT(*) as count FROM tasks';
  const escapeFn = _escapeLikePattern || ((s) => s);
  const { conditions, values } = buildTaskFilterConditions(options, escapeFn);
  query = appendWhereClause(query, conditions);

  const stmt = db.prepare(query);
  return stmt.get(...values).count;
}

/**
 * Count all tasks grouped by status in a single query.
 * @returns {object}
 */
function countTasksByStatus() {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE archived = 0 GROUP BY status').all();
  const counts = { running: 0, queued: 0, completed: 0, failed: 0, pending: 0, cancelled: 0, blocked: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Purge output/error_output from terminal tasks older than retentionDays.
 * Retains task metadata but frees potentially large TEXT columns.
 * @param {number} retentionDays - Tasks older than this have output cleared (default: 30)
 * @returns {number} Number of tasks purged
 */
function purgeOldTaskOutput(retentionDays = 30) {
  if (!db || dbClosed) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600000).toISOString();
  const result = db.prepare(`
    UPDATE tasks SET output = NULL, error_output = NULL
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND created_at < ?
      AND (output IS NOT NULL OR error_output IS NOT NULL)
  `).run(cutoff);
  return result.changes;
}

/**
 * Archive terminal tasks (completed, failed, cancelled) older than the given age.
 * Archived tasks are excluded from dashboard listings by default.
 * @param {number} maxAgeHours - Tasks older than this are archived (default: 24)
 * @returns {number} Number of tasks archived
 */
function archiveOldTasks(maxAgeHours = 24) {
  if (!db || dbClosed) return 0;
  const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
  const result = db.prepare(`
    UPDATE tasks SET archived = 1
    WHERE archived = 0
      AND status IN ('completed', 'failed', 'cancelled')
      AND created_at < ?
  `).run(cutoff);
  return result.changes;
}

/**
 * Get count of running tasks.
 * @returns {number}
 */
function getRunningCount() {
  if (!db || dbClosed) return 0;
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
  return stmt.get('running').count;
}

/**
 * Get count of running tasks for a single provider.
 * @param {string} provider
 * @returns {number}
 */
function getRunningCountByProvider(provider) {
  if (!db || dbClosed) return 0;
  const normalizedProvider = normalizeProviderValue(provider);
  if (!normalizedProvider) return 0;
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider = ?');
  return stmt.get('running', normalizedProvider).count;
}

/**
 * Get running tasks with only essential columns for stale check.
 * Much faster than listTasks() as it skips large TEXT columns.
 * @returns {Array}
 */
function getRunningTasksLightweight() {
  const stmt = db.prepare(`
    SELECT id, status, started_at, timeout_minutes, working_directory, task_description
    FROM tasks
    WHERE status = 'running'
  `);
  return stmt.all();
}

/**
 * Get next queued task (highest priority, oldest first).
 * Uses Wave 5 intelligent priority scoring when available.
 * @returns {object|null}
 */
function getNextQueuedTask() {
  // Perf note: the LEFT JOINs on task_priority_scores and workflows are intentional.
  // Both tables are small (indexed by task_id / id) and most queued tasks won't have
  // priority score rows, so SQLite uses the idx_tasks_status index on tasks first and
  // probes the two small tables per candidate row. The LIMIT 1 keeps the total work
  // proportional to the priority-score table size, not the full tasks table.
  const priorityStmt = db.prepare(`
    SELECT t.* FROM tasks t
    LEFT JOIN task_priority_scores p ON t.id = p.task_id
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.status = 'queued'
      AND (t.provider IS NULL OR t.provider != 'codex-pending')
    ORDER BY
      COALESCE(w.priority, 0) DESC,
      COALESCE(p.combined_score, 0) DESC,
      t.priority DESC,
      t.created_at ASC
    LIMIT 1
  `);
  const row = priorityStmt.get();

  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
    row.context = safeJsonParse(row.context, null);
  }
  return row;
}

/**
 * Atomically claim a task slot if under concurrency limits.
 * Checks global concurrency and optional per-provider limits in one transaction
 * before marking the task as running.
 * Returns { success: true, task } if claimed, { success: false, reason } otherwise.
 *
 * @param {string} taskId
 * @param {number} maxConcurrent
 * @param {string|null} mcpInstanceId
 * @param {string|null} provider
 * @param {number|null} providerLimit
 * @param {string[]} [providerGroup]
 * @param {number|null} [secondaryProviderLimit]
 * @param {string[]} [secondaryProviderGroup]
 * @returns {{ success: boolean, task?: object, reason?: string, runningCount?: number, providerRunningCount?: number }}
 */
function tryClaimTaskSlot(
  taskId,
  maxConcurrent,
  mcpInstanceId = null,
  provider = null,
  providerLimit = null,
  providerGroup = [],
  secondaryProviderLimit = null,
  secondaryProviderGroup = [],
) {
  const finalProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : null;
  const normalizedGroup = Array.isArray(providerGroup) && providerGroup.length > 0
    ? providerGroup.filter((p) => typeof p === 'string' && p.trim())
    : [];
  const normalizedSecondaryGroup = Array.isArray(secondaryProviderGroup) && secondaryProviderGroup.length > 0
    ? secondaryProviderGroup.filter((p) => typeof p === 'string' && p.trim())
    : [];
  const numericProviderLimit = (providerLimit != null && Number.isFinite(Number(providerLimit)))
    ? Number(providerLimit) : null;
  const numericSecondaryProviderLimit = (secondaryProviderLimit != null && Number.isFinite(Number(secondaryProviderLimit)))
    ? Number(secondaryProviderLimit) : null;
  const shouldCheckProviderLimit = Boolean(finalProvider && numericProviderLimit !== null);
  const shouldCheckSecondaryProviderLimit = Boolean(normalizedSecondaryGroup.length > 0 && numericSecondaryProviderLimit !== null);

  try {
    const claimTransaction = db.transaction(() => {
      // Get current running count
      const runningCount = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get('running').count;

      if (runningCount >= maxConcurrent) {
        throw createTransactionResultError({ success: false, reason: 'at_capacity', runningCount });
      }

      if (shouldCheckProviderLimit) {
        const providerRunning = normalizedGroup.length > 0
          ? db.prepare(
            `SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (${normalizedGroup.map(() => '?').join(',')})`
          ).get('running', ...normalizedGroup).count
          : db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider = ?')
            .get('running', finalProvider).count;
        if (providerRunning >= numericProviderLimit) {
          throw createTransactionResultError({
            success: false,
            reason: 'provider_at_capacity',
            providerRunningCount: providerRunning,
            providerLimit: numericProviderLimit,
            limitScope: normalizedGroup.length > 0 ? 'provider_group' : 'provider',
          });
        }
      }

      if (shouldCheckSecondaryProviderLimit) {
        const secondaryProviderRunning = db.prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE status = ? AND provider IN (${normalizedSecondaryGroup.map(() => '?').join(',')})`
        ).get('running', ...normalizedSecondaryGroup).count;
        if (secondaryProviderRunning >= numericSecondaryProviderLimit) {
          throw createTransactionResultError({
            success: false,
            reason: 'provider_at_capacity',
            providerRunningCount: secondaryProviderRunning,
            providerLimit: numericSecondaryProviderLimit,
            limitScope: 'category',
          });
        }
      }

      // Get the task to verify it exists and is in correct state
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) {
        throw createTransactionResultError({ success: false, reason: 'not_found' });
      }

      if (task.status === 'running') {
        throw createTransactionResultError({ success: false, reason: 'already_running' });
      }

      if (task.status !== 'queued' && task.status !== 'pending') {
        throw createTransactionResultError({ success: false, reason: 'invalid_status', status: task.status });
      }

      if (task.approval_status && task.approval_status !== 'approved' && task.approval_status !== 'not_required') {
        throw createTransactionResultError({
          success: false,
          reason: 'approval_not_approved',
          approval_status: task.approval_status,
        });
      }

      const providerSwitchFields = {};
      if (finalProvider) {
        try {
          applyProviderSwitchEnrichment(task, finalProvider, providerSwitchFields);
        } catch (err) {
          logger.info(`[DB] Provider switch metadata enrichment failed during slot claim for ${taskId}: ${err.message}`);
        }
      }

      const updateClauses = ['status = ?', 'started_at = ?'];
      const updateValues = ['running', new Date().toISOString()];

      if (mcpInstanceId) {
        updateClauses.push('mcp_instance_id = ?');
        updateValues.push(mcpInstanceId);
      }
      if (finalProvider) {
        updateClauses.push('provider = ?');
        updateValues.push(finalProvider);
      }
      for (const [key, value] of Object.entries(providerSwitchFields)) {
        validateColumnName(key, ALLOWED_TASK_COLUMNS);
        updateClauses.push(`${key} = ?`);
        if (key === 'metadata') {
          updateValues.push(value === undefined || value === null ? null : (typeof value === 'string' ? value : JSON.stringify(value)));
        } else {
          updateValues.push(value);
        }
      }

      // Atomically update to running status and stamp owning MCP instance
      const claimUpdate = db.prepare(
        `UPDATE tasks SET ${updateClauses.join(', ')} WHERE id = ? AND status IN ('queued', 'pending')`
      ).run(...updateValues, taskId);
      if (claimUpdate.changes === 0) {
        const latestTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!latestTask) {
          throw createTransactionResultError({ success: false, reason: 'not_found' });
        }
        if (latestTask.status === 'running') {
          throw createTransactionResultError({ success: false, reason: 'already_running' });
        }
        throw createTransactionResultError({ success: false, reason: 'invalid_status', status: latestTask.status });
      }

      // Return the updated task
      const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (updatedTask) {
        updatedTask.auto_approve = Boolean(updatedTask.auto_approve);
        updatedTask.context = safeJsonParse(updatedTask.context, null);
      }

      return { success: true, task: updatedTask };
    });
    return claimTransaction.immediate();
  } catch (error) {
    if (error?.code === TRANSACTION_RESULT_SENTINEL) {
      return error.result;
    }
    throw error;
  }
}

/**
 * Update only the metadata field of a task.
 * Named service method — callers must NOT use getDbInstance().prepare() directly.
 * @param {string} taskId
 * @param {object|string} metadata - Metadata object or JSON string
 * @returns {boolean} True if a row was updated
 */
function patchTaskMetadata(taskId, metadata) {
  if (!db) return false;
  const json = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  const result = db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(json, taskId);
  return result.changes > 0;
}

/**
 * Update metadata AND clear provider assignment atomically (slot-pull late binding).
 * Sets provider = NULL and metadata = ? for the given task.
 * @param {string} taskId
 * @param {object|string} metadata
 * @returns {boolean} True if a row was updated
 */
function patchTaskSlotBinding(taskId, metadata) {
  if (!db) return false;
  const json = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  const result = db.prepare('UPDATE tasks SET provider = NULL, metadata = ? WHERE id = ?').run(json, taskId);
  return result.changes > 0;
}

/**
 * Fetch recent completed tasks with non-trivial output, ordered by completion time descending.
 * Used by context-enrichment few-shot retrieval.
 * @param {number} limit - Max rows to return (default 50)
 * @returns {Array<{id, task_description, output, completed_at}>}
 */
function getRecentSuccessfulTasks(limit = 50) {
  if (!db) return [];
  return db.prepare(`
    SELECT id, task_description, output, completed_at
    FROM tasks
    WHERE status = 'completed'
      AND output IS NOT NULL
      AND length(output) > 50
      AND length(output) < 5000
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Atomically claim a queued task for a provider (slot-pull scheduler).
 * Only succeeds if the task is still in 'queued' status.
 * @param {string} taskId
 * @param {string} provider
 * @returns {boolean} True if claim succeeded (changes > 0)
 */
function claimSlotAtomic(taskId, provider) {
  if (!db) return false;
  const result = db.prepare(
    "UPDATE tasks SET provider = ? WHERE id = ? AND status = 'queued'"
  ).run(provider, taskId);
  return result.changes > 0;
}

/**
 * Clear provider assignment on a non-running task (slot-pull rollback on failed start).
 * Only clears when status != 'running' to avoid corrupting active tasks.
 * @param {string} taskId
 * @returns {boolean} True if a row was updated
 */
function clearProviderIfNotRunning(taskId) {
  if (!db) return false;
  const result = db.prepare(
    "UPDATE tasks SET provider = NULL WHERE id = ? AND status != 'running'"
  ).run(taskId);
  return result.changes > 0;
}

/**
 * Get task status (lightweight, single column) for slot-pull decision making.
 * @param {string} taskId
 * @returns {string|null} The status value or null if not found
 */
function getTaskStatus(taskId) {
  if (!db) return null;
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  return row ? row.status : null;
}

/**
 * Execute a slot-pull requeue transaction: reads task, updates metadata retry counts,
 * and either re-queues (provider = NULL) or permanently fails the task.
 * Encapsulates the BEGIN/COMMIT/ROLLBACK pattern from slot-pull-scheduler.
 *
 * @param {string} taskId
 * @param {string} failedProvider
 * @param {object} options
 * @param {boolean} options.deferTerminalWrite - When true, update metadata but don't set failed status
 * @param {function} getMaxRetriesFn - (provider) => number
 * @param {function} parseTaskMetaFn - (task) => object
 * @returns {{ requeued: boolean, exhausted: boolean, providerExhausted?: boolean, missing?: boolean }}
 */
function requeueAfterSlotFailure(taskId, failedProvider, options = {}, getMaxRetriesFn, parseTaskMetaFn) {
  if (!db) return { requeued: false, exhausted: false };
  const { deferTerminalWrite = false } = options;
  const txn = db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      return { requeued: false, exhausted: false, missing: true };
    }
    const meta = parseTaskMetaFn(task);
    const retryCounts = meta._provider_retry_counts || {};
    retryCounts[failedProvider] = (retryCounts[failedProvider] || 0) + 1;
    meta._provider_retry_counts = retryCounts;
    const maxRetries = getMaxRetriesFn(failedProvider);
    const providerExhausted = retryCounts[failedProvider] >= maxRetries;

    if (providerExhausted) {
      const eligible = (meta.eligible_providers || []).filter(p => p !== failedProvider);
      meta._failed_providers = [...new Set([...(meta._failed_providers || []), failedProvider].filter(Boolean))];
      if (eligible.length === 0) {
        meta.eligible_providers = [];
        if (deferTerminalWrite) {
          db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
          return { requeued: false, exhausted: true };
        }
        db.prepare("UPDATE tasks SET status = 'failed', provider = NULL, metadata = ?, completed_at = ? WHERE id = ?")
          .run(JSON.stringify(meta), new Date().toISOString(), taskId);
        return { requeued: false, exhausted: true };
      }
      meta.eligible_providers = eligible;
      db.prepare("UPDATE tasks SET status = 'queued', provider = NULL, metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), taskId);
      return { requeued: true, exhausted: false, providerExhausted: true };
    }

    db.prepare("UPDATE tasks SET status = 'queued', provider = NULL, metadata = ? WHERE id = ?")
      .run(JSON.stringify(meta), taskId);
    return { requeued: true, exhausted: false, providerExhausted: false };
  });
  return txn();
}

// ============================================================
// Factory function — one-call DI setup
// ============================================================

/**
 * Create a fully-wired task-core instance.
 * @param {{ db: any, externalFns?: object }} options
 * @returns {object} All public functions from this module
 */
function createTaskCore({ db: dbInstance, externalFns } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (externalFns) setExternalFns(externalFns);
  return module.exports;
}

module.exports = {
  createTaskCore,
  setDb,
  setDbClosed,
  setExternalFns,
  // Task CRUD
  createTask,
  getTask,
  updateTask,
  resolveTaskId,
  updateTaskStatus,
  requeueTaskAfterAttemptedStart,
  updateTaskProgress,
  // Task listing / counting
  listTasks,
  listQueuedTasksLightweight,
  deleteTask,
  deleteTasks,
  countTasks,
  countTasksByStatus,
  // Archive / purge
  archiveOldTasks,
  purgeOldTaskOutput,
  // Running counts
  getRunningCount,
  getRunningCountByProvider,
  getRunningTasksLightweight,
  // Queue / slot management
  getNextQueuedTask,
  tryClaimTaskSlot,
  // Named service methods (no raw SQL in callers)
  patchTaskMetadata,
  patchTaskSlotBinding,
  getRecentSuccessfulTasks,
  claimSlotAtomic,
  clearProviderIfNotRunning,
  getTaskStatus,
  requeueAfterSlotFailure,
  // Exported helpers (used by database.js and sub-modules via DI)
  validateColumnName,
  normalizeProviderValue,
  ALLOWED_TASK_COLUMNS,
  TERMINAL_TASK_STATUSES,
};
