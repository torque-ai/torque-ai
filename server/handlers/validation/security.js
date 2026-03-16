/**
 * Security, rate limiting, file lock, and backup handlers
 * Extracted from validation-handlers.js
 */

const db = require('../../database');
const { requireTask, ErrorCodes, makeError } = require('../shared');

/**
 * Get rate limits for all providers or a specific provider
 */
function handleGetRateLimits(args) {
  const limits = db.getRateLimits(args.provider);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        rate_limits: limits,
        count: limits.length
      }, null, 2)
    }]
  };
}

/**
 * Set rate limit for a provider
 */
function handleSetRateLimit(args) {
  if (!args.provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }
  if (!args.max_value || args.max_value < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, 'max_value must be a positive number');
  }

  db.setRateLimit(
    args.provider,
    args.limit_type || 'requests',
    args.max_value,
    args.window_seconds || 60,
    args.enabled !== false
  );

  return {
    content: [{
      type: 'text',
      text: `Rate limit set for ${args.provider}: ${args.max_value} ${args.limit_type || 'requests'} per ${args.window_seconds || 60} seconds`
    }]
  };
}

/**
 * Run security scan on a task's output
 */
function handleRunSecurityScan(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const { task: _task, error: taskErr } = requireTask(db, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = db.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content) {
      const scanResults = db.runSecurityScan(args.task_id, change.file_path, change.new_content);
      results.push(...scanResults);
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        issues_found: results.length,
        results: results
      }, null, 2)
    }]
  };
}

/**
 * Get security scan results for a task
 */
function handleGetSecurityResults(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const results = db.getSecurityScanResults(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        issues_found: results.length,
        results: results
      }, null, 2)
    }]
  };
}

/**
 * List security rules
 */
function handleListSecurityRules(args) {
  const rules = db.getSecurityRules(args.category, args.enabled);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        rules: rules,
        count: rules.length
      }, null, 2)
    }]
  };
}

/**
 * Get active file locks
 */
function handleGetFileLocks(args) {
  const locks = db.getActiveFileLocks(args.working_directory);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        locks: locks,
        count: locks.length
      }, null, 2)
    }]
  };
}

/**
 * Release file locks for a task
 */
function handleReleaseFileLocks(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const released = db.releaseAllFileLocks(args.task_id);
  return {
    content: [{
      type: 'text',
      text: `Released ${released} file lock(s) for task ${args.task_id}`
    }]
  };
}

/**
 * List backups for a task
 */
function handleListBackups(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const backups = db.getTaskBackups(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        backups: backups,
        count: backups.length
      }, null, 2)
    }]
  };
}

/**
 * Restore a file from backup
 */
function handleRestoreBackup(args) {
  if (!args.backup_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'backup_id is required');
  }

  const result = db.restoreFileBackup(args.backup_id);

  if (result.success) {
    return {
      content: [{
        type: 'text',
        text: `Restored ${result.file_path} from backup`
      }]
    };
  } else {
    return makeError(ErrorCodes.OPERATION_FAILED, result.error || 'Failed to restore backup');
  }
}

module.exports = {
  handleGetRateLimits,
  handleSetRateLimit,
  handleRunSecurityScan,
  handleGetSecurityResults,
  handleListSecurityRules,
  handleGetFileLocks,
  handleReleaseFileLocks,
  handleListBackups,
  handleRestoreBackup,
};
