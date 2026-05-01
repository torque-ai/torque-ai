'use strict';

const { normalizeMetadata } = require('../utils/normalize-metadata');

function getRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.tasks)) return result.tasks;
  return [];
}

function isRestartResubmission(task) {
  const meta = normalizeMetadata(task?.metadata);
  return Boolean(meta.resubmitted_from) || Number(meta.restart_resubmit_count || 0) > 0;
}

function promotePendingRestartResubmissions(db, options = {}) {
  if (!db || typeof db.listTasks !== 'function' || typeof db.updateTaskStatus !== 'function') {
    return { scanned: 0, promoted: 0, failed: 0 };
  }

  const logger = options.logger || console;
  const limit = options.limit || 100;
  const pending = getRows(db.listTasks({ status: 'pending', limit }));
  let promoted = 0;
  let failed = 0;

  for (const task of pending) {
    if (!isRestartResubmission(task)) continue;
    try {
      const updated = db.updateTaskStatus(task.id, 'queued', { _preserveProvider: true });
      if (updated?.status === 'queued') {
        promoted++;
      }
    } catch (err) {
      failed++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('Failed to queue restart-resubmitted task ' + task.id + ': ' + err.message);
      }
    }
  }

  if (promoted > 0 && logger && typeof logger.info === 'function') {
    logger.info('Queued pending restart-resubmitted tasks', { promoted, scanned: pending.length });
  }

  return { scanned: pending.length, promoted, failed };
}

module.exports = {
  isRestartResubmission,
  promotePendingRestartResubmissions,
};
