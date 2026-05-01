'use strict';

const factoryDecisions = require('../db/factory-decisions');
const decisionLog = require('./decision-log');
const { isWithinCooldown } = require('./auto-recovery/backoff');

const VERIFY_STALL_THRESHOLD_MS = 45 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 2;
const TERMINAL_VERIFY_GATE_REASONS = new Set([
  'branch_stale_vs_base',
]);

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

function resetRecoveryAttempts(db, projectId) {
  const hasColumn = hasVerifyRecoveryAttemptsColumn(db);
  if (hasColumn) {
    setRecoveryAttempts(db, projectId, 0, hasColumn);
    return;
  }
  inMemoryVerifyRecoveryAttempts.delete(projectId);
}

function hasAutoRecoveryColumns(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(factory_projects)').all();
    const names = new Set(columns.map((c) => c.name));
    return names.has('auto_recovery_last_action_at') && names.has('auto_recovery_attempts');
  } catch (_e) {
    void _e;
    return false;
  }
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getLatestVerifyDecision(db, projectId, batchId = null) {
  const batchFilter = batchId ? 'AND batch_id = ?' : '';
  const params = batchId ? [projectId, batchId] : [projectId];

  const row = db.prepare(`
    SELECT action, outcome_json
    FROM factory_decisions
    WHERE project_id = ?
      AND stage = 'verify'
      ${batchFilter}
    ORDER BY id DESC
    LIMIT 1
  `).get(...params);

  if (row) {
    return {
      action: row.action || null,
      outcome: parseJsonObject(row.outcome_json),
    };
  }

  if (batchId) {
    return getLatestVerifyDecision(db, projectId, null);
  }

  return null;
}

function isTerminalVerifyGate(stalledLoop, db) {
  const latest = getLatestVerifyDecision(db, stalledLoop.project_id, stalledLoop.batch_id || null);
  const latestReason = typeof latest?.outcome?.reason === 'string'
    ? latest.outcome.reason
    : null;

  return latest?.action === 'branch_stale_rebase_conflict'
    || (
      latest?.action === 'paused_at_gate'
      && TERMINAL_VERIFY_GATE_REASONS.has(latestReason)
    );
}

function listStalledVerifyLoops(db, thresholdMs = VERIFY_STALL_THRESHOLD_MS) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recoverStalledVerifyLoops requires a database handle');
  }

  const hasColumn = hasVerifyRecoveryAttemptsColumn(db);
  const attemptsSelect = hasColumn ? ', verify_recovery_attempts' : '';
  const hasArColumns = hasAutoRecoveryColumns(db);
  const arSelect = hasArColumns
    ? ', auto_recovery_last_action_at AS ar_last_action_at, auto_recovery_attempts AS ar_attempts'
    : '';
  const nowMs = Date.now();
  const rows = db.prepare(`
    SELECT
      id AS project_id,
      loop_state,
      loop_paused_at_stage AS paused_at_stage,
      loop_last_action_at AS last_action_at,
      loop_batch_id AS batch_id
      ${attemptsSelect}
      ${arSelect}
    FROM factory_projects
    -- @full-scan: same shape as stuck-loop-detector — small projects
    -- table, COALESCE-wrapped predicates aren't index-eligible.
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

    // Cooldown skip — if the auto-recovery engine is actively handling this
    // project (its own backoff window hasn't elapsed), stand down to avoid
    // double-retry contention.
    if (isWithinCooldown(row.ar_last_action_at, row.ar_attempts || 0, nowMs)) {
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
  resolveUnrecoverableVerify = null,
  shouldSkipStalledLoop = null,
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
  factoryDecisions.setDb(db);

  for (const stalledLoop of listStalledVerifyLoops(db)) {
    if (isTerminalVerifyGate(stalledLoop, db)) {
      continue;
    }

    if (typeof shouldSkipStalledLoop === 'function') {
      let skipRecovery = false;
      try {
        skipRecovery = Boolean(await shouldSkipStalledLoop(stalledLoop));
      } catch (err) {
        logger.warn('Failed to evaluate stalled VERIFY loop skip hook', {
          project_id: stalledLoop.project_id,
          err: err.message,
        });
      }
      if (skipRecovery) {
        continue;
      }
    }

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
      try {
        decisionLog.logDecision({
          project_id: stalledLoop.project_id,
          stage: 'verify',
          actor: 'verifier',
          action: 'factory_verify_unrecoverable',
          reasoning: `VERIFY stall reached max auto-recovery attempts (${stalledLoop.attempts}/${MAX_RECOVERY_ATTEMPTS}); operator must intervene.`,
          outcome: payload,
          confidence: 1,
        });
      } catch (logErr) {
        // Decision-log write is best-effort — keep recovery flow alive
        logger.warn('Failed to record factory_verify_unrecoverable decision', {
          project_id: stalledLoop.project_id,
          err: logErr.message,
        });
      }
      let resolution = null;
      let action = 'skipped_maxed';
      if (typeof resolveUnrecoverableVerify === 'function') {
        try {
          resolution = await resolveUnrecoverableVerify(payload);
          action = resolution?.action || 'resolved_maxed';
        } catch (err) {
          action = 'resolution_failed';
          resolution = { error: err.message };
          logger.error('Failed to resolve unrecoverable VERIFY loop', {
            event: 'factory_verify_unrecoverable_resolution_failed',
            project_id: stalledLoop.project_id,
            attempts: stalledLoop.attempts,
            err: err.message,
          });
        }
      }
      const entry = {
        project_id: stalledLoop.project_id,
        action,
        attempts: stalledLoop.attempts,
      };
      if (resolution) {
        entry.resolution = resolution;
      }
      actions.push(entry);
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
      try {
        decisionLog.logDecision({
          project_id: stalledLoop.project_id,
          stage: 'verify',
          actor: 'verifier',
          action: 'factory_verify_auto_retry',
          reasoning: `VERIFY stall detected (last action ${stalledLoop.last_action_at}); auto-retry attempt ${nextAttempts}/${MAX_RECOVERY_ATTEMPTS}.`,
          outcome: {
            attempts: nextAttempts,
            last_action_at: stalledLoop.last_action_at,
          },
          confidence: 1,
        });
      } catch (logErr) {
        logger.warn('Failed to record factory_verify_auto_retry decision', {
          project_id: stalledLoop.project_id,
          err: logErr.message,
        });
      }
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
  resetRecoveryAttempts,
};
