'use strict';

const SQLITE_ID_CHUNK_SIZE = 400;

const TASK_ID_CHILD_TABLES = [
  'pipeline_steps',
  'token_usage',
  'retry_history',
  'task_file_changes',
  'task_file_writes',
  'task_checkpoints',
  'task_event_subscriptions',
  'task_events',
  'task_suggestions',
  'approval_requests',
  'peek_recovery_approvals',
  'task_comments',
  'resource_usage',
  'task_claims',
  'work_stealing_log',
  'validation_results',
  'pending_approvals',
  'failure_matches',
  'retry_attempts',
  'diff_previews',
  'adversarial_reviews',
  'verification_checks',
  'quality_scores',
  'task_rollbacks',
  'build_checks',
  'cost_tracking',
  'task_fingerprints',
  'file_backups',
  'security_scans',
  'test_coverage',
  'style_checks',
  'change_impacts',
  'timeout_alerts',
  'output_violations',
  'expected_output_paths',
  'file_location_anomalies',
  'duplicate_file_detections',
  'type_verification_results',
  'build_error_analysis',
  'similar_file_search',
  'task_complexity_scores',
  'auto_rollbacks',
  'xaml_validation_results',
  'xaml_consistency_results',
  'smoke_test_results',
  'file_locks',
  'task_streams',
];

function normalizeTaskIds(taskIds) {
  if (!Array.isArray(taskIds)) return [];
  const seen = new Set();
  const normalized = [];
  for (const taskId of taskIds) {
    if (taskId === undefined || taskId === null) continue;
    const value = String(taskId).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function getExistingTables(db) {
  try {
    return new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
  } catch {
    return null;
  }
}

function hasTable(existingTables, tableName) {
  return !existingTables || existingTables.has(tableName);
}

function isIgnorableSchemaError(error) {
  return /no such (table|column)/i.test(error?.message || '');
}

function idPlaceholders(ids) {
  return ids.map(() => '?').join(',');
}

function forTaskIdChunks(taskIds, callback) {
  let total = 0;
  for (let index = 0; index < taskIds.length; index += SQLITE_ID_CHUNK_SIZE) {
    const chunk = taskIds.slice(index, index + SQLITE_ID_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    total += callback(chunk) || 0;
  }
  return total;
}

function deleteRowsByTaskId(db, tableName, taskIds, existingTables) {
  if (!hasTable(existingTables, tableName)) return 0;

  try {
    return forTaskIdChunks(taskIds, (chunk) => {
      const result = db.prepare(
        `DELETE FROM ${tableName} WHERE task_id IN (${idPlaceholders(chunk)})`,
      ).run(...chunk);
      return result.changes || 0;
    });
  } catch (error) {
    if (!isIgnorableSchemaError(error)) throw error;
    return 0;
  }
}

function deleteStreamChunksForTasks(db, taskIds, existingTables) {
  if (!hasTable(existingTables, 'stream_chunks') || !hasTable(existingTables, 'task_streams')) {
    return 0;
  }

  try {
    return forTaskIdChunks(taskIds, (chunk) => {
      const result = db.prepare(`
        DELETE FROM stream_chunks
        WHERE stream_id IN (
          SELECT id FROM task_streams WHERE task_id IN (${idPlaceholders(chunk)})
        )
      `).run(...chunk);
      return result.changes || 0;
    });
  } catch (error) {
    if (!isIgnorableSchemaError(error)) throw error;
    return 0;
  }
}

function deleteSimilarTaskRows(db, taskIds, existingTables) {
  if (!hasTable(existingTables, 'similar_tasks')) return 0;

  try {
    return forTaskIdChunks(taskIds, (chunk) => {
      const placeholders = idPlaceholders(chunk);
      const result = db.prepare(`
        DELETE FROM similar_tasks
        WHERE source_task_id IN (${placeholders})
           OR similar_task_id IN (${placeholders})
      `).run(...chunk, ...chunk);
      return result.changes || 0;
    });
  } catch (error) {
    if (!isIgnorableSchemaError(error)) throw error;
    return 0;
  }
}

function deleteTaskReplayRows(db, taskIds, existingTables) {
  if (!hasTable(existingTables, 'task_replays')) return 0;

  try {
    return forTaskIdChunks(taskIds, (chunk) => {
      const placeholders = idPlaceholders(chunk);
      const result = db.prepare(`
        DELETE FROM task_replays
        WHERE original_task_id IN (${placeholders})
           OR replay_task_id IN (${placeholders})
      `).run(...chunk, ...chunk);
      return result.changes || 0;
    });
  } catch (error) {
    if (!isIgnorableSchemaError(error)) throw error;
    return 0;
  }
}

function deleteTaskChildrenByIds(db, taskIds) {
  const normalizedIds = normalizeTaskIds(taskIds);
  if (!db || normalizedIds.length === 0) return {};

  const existingTables = getExistingTables(db);
  const deleted = {};

  deleted.stream_chunks = deleteStreamChunksForTasks(db, normalizedIds, existingTables);

  for (const tableName of TASK_ID_CHILD_TABLES) {
    deleted[tableName] = deleteRowsByTaskId(db, tableName, normalizedIds, existingTables);
  }

  deleted.similar_tasks = deleteSimilarTaskRows(db, normalizedIds, existingTables);
  deleted.task_replays = deleteTaskReplayRows(db, normalizedIds, existingTables);

  return deleted;
}

function deleteTaskRowsByIds(db, taskIds) {
  const normalizedIds = normalizeTaskIds(taskIds);
  if (!db || normalizedIds.length === 0) return 0;

  return forTaskIdChunks(normalizedIds, (chunk) => {
    const result = db.prepare(
      `DELETE FROM tasks WHERE id IN (${idPlaceholders(chunk)})`,
    ).run(...chunk);
    return result.changes || 0;
  });
}

module.exports = {
  deleteTaskChildrenByIds,
  deleteTaskRowsByIds,
  normalizeTaskIds,
};
