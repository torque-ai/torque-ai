'use strict';

const factoryDecisions = require('../db/factory-decisions');
const factoryIntake = require('../db/factory-intake');
const {
  REJECT_RECOVERY_CONFIG_DEFAULTS,
  getRejectRecoveryConfig,
  parseBooleanConfigValue,
  parsePositiveIntegerConfigValue,
} = require('../db/config-core');
const decisionLog = require('./decision-log');

const RECOVERY_DECISION_ACTION = 'factory_rejected_item_auto_reopen';
const RECOVERY_DECISION_STAGE = 'learn';
const RECOVERY_DECISION_ACTOR = 'verifier';
const RECOVERY_BATCH_PREFIX = 'reject-recovery';
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_RECOVERY_CONFIG = Object.freeze({
  sweepIntervalMs: Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_sweep_interval_ms, 10),
  ageThresholdMs: Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_age_threshold_ms, 10),
  maxReopens: Number.parseInt(REJECT_RECOVERY_CONFIG_DEFAULTS.reject_recovery_max_reopens, 10),
});

const AUTO_REJECT_REASON_PATTERNS = Object.freeze([
  /^auto_/i,
  /auto[-_ ]rejected/i,
  /^verify_failed_after_\d+_retries$/i,
  /^plan_quality_gate_rejected_after_2_attempts$/i,
  /^no_worktree_for_batch/i,
  /^empty_branch_after_execute$/i,
  /^consecutive_empty_executions$/i,
  /^stuck_executing_over_1h_no_progress/i,
  /^cannot_generate_plan:/i,
  /^replan_generation_failed$/i,
  /^execute_spin_loop_\d+_starts_in_5min$/i,
  /^worktree_creation_failed:/i,
  /^execute_exception:/i,
  /^task_.+_failed$/i,
  /^worktree_and_branch_lost_during_verify$/i,
  /^dep_cascade_exhausted:/i,
  /^dep_resolver_unresolvable:/i,
]);

let lastSweepAtMs = null;

function normalizeRecoveryConfig(config = null) {
  if (!config) {
    return getRejectRecoveryConfig();
  }

  return {
    enabled: config.enabled !== undefined
      ? parseBooleanConfigValue(config.enabled, false)
      : parseBooleanConfigValue(config.reject_recovery_enabled, false),
    sweepIntervalMs: parsePositiveIntegerConfigValue(
      config.sweepIntervalMs ?? config.reject_recovery_sweep_interval_ms,
      DEFAULT_RECOVERY_CONFIG.sweepIntervalMs,
    ),
    ageThresholdMs: parsePositiveIntegerConfigValue(
      config.ageThresholdMs ?? config.reject_recovery_age_threshold_ms,
      DEFAULT_RECOVERY_CONFIG.ageThresholdMs,
    ),
    maxReopens: parsePositiveIntegerConfigValue(
      config.maxReopens ?? config.reject_recovery_max_reopens,
      DEFAULT_RECOVERY_CONFIG.maxReopens,
    ),
  };
}

function assertRecoveryDeps({ db, logger } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recoverRejectedWorkItems requires a database handle');
  }
  if (!logger || typeof logger.warn !== 'function' || typeof logger.error !== 'function') {
    throw new Error('recoverRejectedWorkItems requires a logger');
  }
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAutoRejectedReason(reason) {
  const text = String(reason || '').trim();
  if (!text) {
    return false;
  }

  const parsed = parseJsonObject(text);
  if (parsed) {
    return parsed.auto_rejected === true
      || parsed.action === 'auto_rejected'
      || AUTO_REJECT_REASON_PATTERNS.some((pattern) => pattern.test(String(parsed.reason || '')));
  }

  return AUTO_REJECT_REASON_PATTERNS.some((pattern) => pattern.test(text));
}

function getRecoveryBatchId(workItemId) {
  return `${RECOVERY_BATCH_PREFIX}:${workItemId}`;
}

function countPriorReopens(db, workItemId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM factory_decisions
    WHERE action = ?
      AND batch_id = ?
  `).get(RECOVERY_DECISION_ACTION, getRecoveryBatchId(workItemId));

  return Number(row?.count || 0);
}

function listRecoverableRejectedWorkItems(db, {
  ageThresholdMs,
  nowMs = Date.now(),
  limit = DEFAULT_SWEEP_LIMIT,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('listRecoverableRejectedWorkItems requires a database handle');
  }

  const rows = db.prepare(`
    SELECT
      wi.*,
      p.status AS project_status,
      p.trust_level AS project_trust_level
    FROM factory_work_items wi
    JOIN factory_projects p ON p.id = wi.project_id
    WHERE wi.status = 'rejected'
      AND p.status = 'running'
      AND p.trust_level = 'dark'
    ORDER BY wi.updated_at ASC, wi.id ASC
    LIMIT ?
  `).all(limit);

  return rows.filter((row) => {
    if (!isAutoRejectedReason(row.reject_reason)) {
      return false;
    }

    const updatedAt = row.updated_at || row.created_at;
    const updatedAtMs = Date.parse(updatedAt);
    return Number.isFinite(updatedAtMs) && (nowMs - updatedAtMs) >= ageThresholdMs;
  });
}

function recoverRejectedWorkItems({
  db,
  logger,
  config,
  nowMs = Date.now(),
} = {}) {
  assertRecoveryDeps({ db, logger });

  const recoveryConfig = normalizeRecoveryConfig(config);
  if (!recoveryConfig.enabled) {
    return [];
  }

  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);

  const actions = [];
  let reopenedCount = 0;
  const items = listRecoverableRejectedWorkItems(db, {
    ageThresholdMs: recoveryConfig.ageThresholdMs,
    nowMs,
  });

  for (const item of items) {
    const priorReopens = countPriorReopens(db, item.id);
    if (priorReopens >= recoveryConfig.maxReopens) {
      actions.push({
        project_id: item.project_id,
        work_item_id: item.id,
        action: 'skipped_maxed',
        reopens: priorReopens,
      });
      continue;
    }

    if (reopenedCount >= recoveryConfig.maxReopens) {
      break;
    }

    const nextReopens = priorReopens + 1;
    try {
      const reopened = factoryIntake.updateWorkItem(item.id, {
        status: 'pending',
        reject_reason: null,
        claimed_by_instance_id: null,
        batch_id: null,
      });

      logger.warn('Auto-reopening rejected factory work item', {
        event: RECOVERY_DECISION_ACTION,
        project_id: item.project_id,
        work_item_id: item.id,
        reopens: nextReopens,
        previous_reject_reason: item.reject_reason || null,
      });

      decisionLog.logDecision({
        project_id: item.project_id,
        stage: RECOVERY_DECISION_STAGE,
        actor: RECOVERY_DECISION_ACTOR,
        action: RECOVERY_DECISION_ACTION,
        reasoning: `Rejected work item ${item.id} exceeded age threshold and matched auto-reject recovery criteria; reopening (${nextReopens}/${recoveryConfig.maxReopens}).`,
        inputs: {
          work_item_id: item.id,
          previous_status: item.status,
          previous_reject_reason: item.reject_reason || null,
          age_threshold_ms: recoveryConfig.ageThresholdMs,
        },
        outcome: {
          work_item_id: reopened.id,
          status: reopened.status,
          reopens: nextReopens,
        },
        confidence: 1,
        batch_id: getRecoveryBatchId(item.id),
      });

      actions.push({
        project_id: item.project_id,
        work_item_id: item.id,
        action: 'reopened',
        reopens: nextReopens,
      });
      reopenedCount++;
    } catch (err) {
      logger.error('Auto-reopen for rejected factory work item failed', {
        event: 'factory_rejected_item_auto_reopen_failed',
        project_id: item.project_id,
        work_item_id: item.id,
        err: err.message,
      });
      actions.push({
        project_id: item.project_id,
        work_item_id: item.id,
        action: 'failed',
        reopens: priorReopens,
      });
    }
  }

  return actions;
}

function runRejectedRecoverySweep({
  db,
  logger,
  config,
  nowMs = Date.now(),
} = {}) {
  assertRecoveryDeps({ db, logger });

  const recoveryConfig = normalizeRecoveryConfig(config);
  if (!recoveryConfig.enabled) {
    return [];
  }

  if (
    lastSweepAtMs !== null
    && (nowMs - lastSweepAtMs) < recoveryConfig.sweepIntervalMs
  ) {
    return [];
  }

  lastSweepAtMs = nowMs;
  return recoverRejectedWorkItems({
    db,
    logger,
    config: recoveryConfig,
    nowMs,
  });
}

function resetRejectedRecoverySweepStateForTests() {
  lastSweepAtMs = null;
}

module.exports = {
  RECOVERY_DECISION_ACTION,
  listRecoverableRejectedWorkItems,
  recoverRejectedWorkItems,
  runRejectedRecoverySweep,
  isAutoRejectedReason,
  resetRejectedRecoverySweepStateForTests,
};
