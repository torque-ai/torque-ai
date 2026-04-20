'use strict';

// FOLLOW-UP: persist verify_recovery_attempts to factory_projects via new migration.

const VERIFY_STALL_THRESHOLD_MS = 45 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 2;

const inMemoryVerifyRecoveryAttempts = new Map();
const verifyRecoveryColumnCache = new WeakMap();

function parseAttempts(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasVerifyRecoveryAttemptsColumn(db) {
  if (verifyRecoveryColumnCache.has(db)) {
    return verifyRecoveryColumnCache.get(db);
  }

  let hasColumn = false;
  try {
    const columns = db.prepare('PRAGMA table_info(factory_projects)').all();
    hasColumn = columns.some((column) => column.name === 'verify_recovery_attempts');
  } catch (_e) {
    void _e;
    hasColumn = false;
  }

  verifyRecoveryColumnCache.set(db, hasColumn);
  return hasColumn;
}

function getRecoveryAttempts(projectId, dbAttempts, hasColumn) {
  if (hasColumn) {
    return parseAttempts(dbAttempts);
  }
  return parseAttempts(inMemoryVerifyRecoveryAttempts.get(projectId));
}

function setRecoveryAttempts(db, projectId, attempts, hasColumn) {
  if (hasColumn) {
    db.prepare(`
      UPDATE factory_projects
      SET verify_recovery_attempts = ?
      WHERE id = ?
    `).run(attempts, projectId);
    return;
  }

  inMemoryVerifyRecoveryAttempts.set(projectId, attempts);
}

function listStalledVerifyLoops(db, thresholdMs = VERIFY_STALL_THRESHOLD_MS) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recoverStalledVerifyLoops requires a database handle');
  }

  const hasColumn = hasVerifyRecoveryAttemptsColumn(db);
  const attemptsSelect = hasColumn ? ', verify_recovery_attempts' : '';
  const nowMs = Date.now();
  const rows = db.prepare(`
    SELECT
      id AS project_id,
      loop_state,
      loop_paused_at_stage AS paused_at_stage,
      loop_last_action_at AS last_action_at
      ${attemptsSelect}
    FROM factory_projects
    WHERE loop_last_action_at IS NOT NULL
      AND (
        COALESCE(UPPER(loop_state), 'IDLE') = 'VERIFY'
        OR (
          COALESCE(UPPER(loop_state), 'IDLE') = 'PAUSED'
          AND COALESCE(UPPER(loop_paused_at_stage), '') = 'VERIFY'
        )
      )
    ORDER BY loop_last_action_at ASC
  `).all();

  return rows.flatMap((row) => {
    const lastActionMs = Date.parse(row.last_action_at);
    if (!Number.isFinite(lastActionMs)) {
      return [];
    }

    if ((nowMs - lastActionMs) <= thresholdMs) {
      return [];
    }

    return [{
      ...row,
      attempts: getRecoveryAttempts(
        row.project_id,
        row.verify_recovery_attempts,
        hasColumn,
      ),
    }];
  });
}

async function recoverStalledVerifyLoops({
  db,
  logger,
  eventBus,
  retryFactoryVerify,
}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recoverStalledVerifyLoops requires a database handle');
  }
  if (!logger || typeof logger.warn !== 'function' || typeof logger.error !== 'function') {
    throw new Error('recoverStalledVerifyLoops requires a logger');
  }
  if (typeof retryFactoryVerify !== 'function') {
    throw new Error('recoverStalledVerifyLoops requires retryFactoryVerify');
  }

  const hasColumn = hasVerifyRecoveryAttemptsColumn(db);
  const actions = [];

  for (const stalledLoop of listStalledVerifyLoops(db)) {
    if (stalledLoop.attempts >= MAX_RECOVERY_ATTEMPTS) {
      const payload = {
        project_id: stalledLoop.project_id,
        attempts: stalledLoop.attempts,
        last_action_at: stalledLoop.last_action_at,
      };
      logger.error('Stalled VERIFY loop reached max auto-recovery attempts', {
        event: 'factory_verify_unrecoverable',
        ...payload,
      });
      eventBus?.emitFactoryVerifyUnrecoverable?.(payload);
      actions.push({
        project_id: stalledLoop.project_id,
        action: 'skipped_maxed',
        attempts: stalledLoop.attempts,
      });
      continue;
    }

    const nextAttempts = stalledLoop.attempts + 1;
    setRecoveryAttempts(db, stalledLoop.project_id, nextAttempts, hasColumn);

    try {
      await retryFactoryVerify({ project_id: stalledLoop.project_id });
      logger.warn('Auto-retrying stalled VERIFY loop', {
        event: 'factory_verify_auto_retry',
        project_id: stalledLoop.project_id,
        attempts: nextAttempts,
      });
      eventBus?.emitFactoryVerifyAutoRetry?.({
        project_id: stalledLoop.project_id,
        attempts: nextAttempts,
        last_action_at: stalledLoop.last_action_at,
      });
      actions.push({
        project_id: stalledLoop.project_id,
        action: 'retry',
        attempts: nextAttempts,
      });
    } catch (err) {
      logger.error('Auto-retry for stalled VERIFY loop failed', {
        event: 'factory_verify_retry_failed',
        project_id: stalledLoop.project_id,
        attempts: nextAttempts,
        last_action_at: stalledLoop.last_action_at,
        err: err.message,
      });
      actions.push({
        project_id: stalledLoop.project_id,
        action: 'terminated',
        attempts: nextAttempts,
      });
    }
  }

  return actions;
}

module.exports = {
  VERIFY_STALL_THRESHOLD_MS,
  MAX_RECOVERY_ATTEMPTS,
  listStalledVerifyLoops,
  recoverStalledVerifyLoops,
};
