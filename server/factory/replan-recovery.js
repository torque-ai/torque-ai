'use strict';

const factoryDecisions = require('../db/factory-decisions');
const factoryIntake = require('../db/factory-intake');
const decisionLog = require('./decision-log');
const { defaultRegistry } = require('./recovery-strategies/registry');

const RECOVERABLE_TERMINAL_STATUSES = Object.freeze(['rejected', 'unactionable']);

const DECISION_ACTION_ATTEMPTED = 'replan_recovery_attempted';
const DECISION_ACTION_NO_STRATEGY = 'replan_recovery_no_strategy';
const DECISION_ACTION_FAILED = 'replan_recovery_strategy_failed';
const DECISION_ACTION_SPLIT = 'replan_recovery_split';
const DECISION_ACTION_EXHAUSTED = 'replan_recovery_exhausted';
const DECISION_STAGE = 'recover';
const DECISION_ACTOR = 'replan-recovery';
const BATCH_PREFIX = 'replan-recovery';

let lastSweepAtMs = null;

function resetReplanRecoverySweepStateForTests() {
  lastSweepAtMs = null;
}

function getBatchId(workItemId) {
  return `${BATCH_PREFIX}:${workItemId}`;
}

function listEligible(db, { strategyPatterns, hardCap }) {
  const placeholders = RECOVERABLE_TERMINAL_STATUSES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT wi.*, p.status AS project_status, p.trust_level AS project_trust_level
    FROM factory_work_items wi
    JOIN factory_projects p ON p.id = wi.project_id
    WHERE wi.status IN (${placeholders})
      AND p.status = 'running'
      AND p.trust_level = 'dark'
      AND wi.recovery_attempts < ?
    ORDER BY COALESCE(wi.last_recovery_at, wi.updated_at, wi.created_at) ASC, wi.id ASC
  `).all(...RECOVERABLE_TERMINAL_STATUSES, hardCap);

  return rows.filter((row) => {
    const reason = String(row.reject_reason || '');
    return strategyPatterns.some((p) => p.test(reason));
  });
}

function isCooldownElapsed(row, cooldownMs, nowMs) {
  if (!row.last_recovery_at) return true;
  const lastMs = Date.parse(row.last_recovery_at);
  if (!Number.isFinite(lastMs)) return true;
  const tier = Math.min(Number(row.recovery_attempts || 0), cooldownMs.length - 1);
  return (nowMs - lastMs) >= cooldownMs[tier];
}

function getOpenWorkItemCountForProject(projectId) {
  const items = factoryIntake.listOpenWorkItems({ project_id: projectId, limit: 100 });
  return Array.isArray(items) ? items.length : 0;
}

function appendHistory(currentJson, entry, max) {
  let arr = [];
  try {
    arr = JSON.parse(currentJson || '[]');
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  arr.push(entry);
  if (arr.length > max) arr = arr.slice(arr.length - max);
  return JSON.stringify(arr);
}

function buildHistoryForStrategy(workItem) {
  let recoveryRecords = [];
  try {
    recoveryRecords = JSON.parse(workItem.recovery_history_json || '[]') || [];
    if (!Array.isArray(recoveryRecords)) recoveryRecords = [];
  } catch { /* ignore */ }
  return {
    attempts: Number(workItem.recovery_attempts || 0),
    priorReason: workItem.reject_reason || null,
    priorDescription: workItem.description || null,
    priorPlans: [],
    recoveryRecords,
  };
}

async function runStrategyWithTimeout(strategy, args, timeoutMs) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`strategy timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([strategy.replan(args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function applyRewrote(db, workItem, updates, attemptCount, historyJson) {
  const desc = updates.description != null ? updates.description : workItem.description;
  const title = updates.title != null ? updates.title : workItem.title;
  const constraintsJson = updates.constraints != null
    ? JSON.stringify(updates.constraints)
    : workItem.constraints_json;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'pending',
        title = ?,
        description = ?,
        constraints_json = ?,
        reject_reason = NULL,
        claimed_by_instance_id = NULL,
        recovery_attempts = ?,
        recovery_history_json = ?,
        last_recovery_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(title, desc, constraintsJson, attemptCount, historyJson, now, now, workItem.id);
}

function applyEscalated(db, workItem, updates, attemptCount, historyJson) {
  let cur = {};
  try { cur = workItem.constraints_json ? JSON.parse(workItem.constraints_json) : {}; } catch { cur = {}; }
  const merged = { ...cur, ...(updates.constraints || {}) };
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'pending',
        constraints_json = ?,
        reject_reason = NULL,
        claimed_by_instance_id = NULL,
        recovery_attempts = ?,
        recovery_history_json = ?,
        last_recovery_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(merged), attemptCount, historyJson, now, now, workItem.id);
}

function applySplit(db, workItem, children, attemptCount, historyJson) {
  const tx = db.transaction(() => {
    const childIds = [];
    const now = new Date().toISOString();
    for (const child of children) {
      const childItem = factoryIntake.createWorkItem({
        project_id: workItem.project_id,
        source: 'recovery_split',
        title: child.title,
        description: child.description,
        priority: Math.max(0, Number(workItem.priority || 50) - 1),
        constraints: child.constraints || null,
      });
      db.prepare(`
        UPDATE factory_work_items
        SET linked_item_id = ?, depth = ?
        WHERE id = ?
      `).run(workItem.id, Number(workItem.depth || 0) + 1, childItem.id);
      childIds.push(childItem.id);
    }
    db.prepare(`
      UPDATE factory_work_items
      SET status = 'superseded',
          reject_reason = 'split_into_recovery_children',
          claimed_by_instance_id = NULL,
          recovery_attempts = ?,
          recovery_history_json = ?,
          last_recovery_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(attemptCount, historyJson, now, now, workItem.id);
    return childIds;
  });
  return tx();
}

function applyUnrecoverable(db, workItem, attemptCount, historyJson) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET status = 'needs_review',
        claimed_by_instance_id = NULL,
        recovery_attempts = ?,
        recovery_history_json = ?,
        last_recovery_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(attemptCount, historyJson, now, now, workItem.id);
}

function applyFailureNoStatusChange(db, workItem, attemptCount, historyJson) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET claimed_by_instance_id = NULL,
        recovery_attempts = ?,
        recovery_history_json = ?,
        last_recovery_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(attemptCount, historyJson, now, now, workItem.id);
}

function claimItem(db, workItem, instanceClaim) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE factory_work_items
    SET claimed_by_instance_id = ?, last_recovery_at = ?, updated_at = ?
    WHERE id = ? AND (claimed_by_instance_id IS NULL OR claimed_by_instance_id = ?)
  `).run(instanceClaim, now, now, workItem.id, instanceClaim);
}

function createDispatcher({
  db,
  logger,
  registry = defaultRegistry,
  factoryHealth,
  architectRunner,
  eventBus = null,
  instanceId = `replan-${Math.random().toString(16).slice(2)}`,
}) {
  const fH = factoryHealth || require('../db/factory-health');
  const aR = architectRunner || require('./architect-runner');

  async function runSweep({ config, nowMs = Date.now() }) {
    if (!config?.enabled) return [];
    factoryIntake.setDb(db);
    factoryDecisions.setDb(db);

    const strategyPatterns = registry.allReasonPatterns();
    if (strategyPatterns.length === 0) return [];

    const eligible = listEligible(db, { strategyPatterns, hardCap: config.hardCap });
    const actions = [];
    const reopenedThisSweepByProject = new Map();
    const openWorkItemCountByProject = new Map();
    let globalReopens = 0;

    for (const row of eligible) {
      if (Number(row.recovery_attempts || 0) >= config.hardCap) {
        const historyEntry = {
          attempt: Number(row.recovery_attempts || 0) + 1,
          strategy: 'none',
          prior_reject_reason: row.reject_reason,
          outcome: 'exhausted',
          timestamp: new Date(nowMs).toISOString(),
        };
        const hist = appendHistory(row.recovery_history_json, historyEntry, config.historyMaxEntries);
        applyUnrecoverable(db, row, Number(row.recovery_attempts || 0), hist);
        decisionLog.logDecision({
          project_id: row.project_id,
          stage: DECISION_STAGE,
          actor: DECISION_ACTOR,
          action: DECISION_ACTION_EXHAUSTED,
          reasoning: `Item ${row.id} reached hard-cap (${config.hardCap}); routing to needs_review.`,
          inputs: { work_item_id: row.id, attempts: row.recovery_attempts },
          outcome: { status: 'needs_review' },
          confidence: 1,
          batch_id: getBatchId(row.id),
        });
        if (eventBus?.emitFactoryReplanRecoveryExhausted) {
          eventBus.emitFactoryReplanRecoveryExhausted({
            project_id: row.project_id,
            work_item_id: row.id,
            total_attempts: row.recovery_attempts,
          });
        }
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'exhausted_to_needs_review' });
        continue;
      }

      if (!isCooldownElapsed(row, config.cooldownMs, nowMs)) {
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'skipped_cooldown' });
        continue;
      }

      const reopenedSoFar = reopenedThisSweepByProject.get(row.project_id) || 0;
      if (reopenedSoFar >= config.maxPerProjectPerSweep) {
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'skipped_project_sweep_limit' });
        continue;
      }

      if (globalReopens >= config.maxGlobalPerSweep) {
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'skipped_global_sweep_limit' });
        continue;
      }

      const openCount = openWorkItemCountByProject.has(row.project_id)
        ? openWorkItemCountByProject.get(row.project_id)
        : getOpenWorkItemCountForProject(row.project_id);
      openWorkItemCountByProject.set(row.project_id, openCount);
      if (openCount >= config.skipIfOpenCountGte) {
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'skipped_project_backpressure' });
        continue;
      }

      const strategy = registry.findByReason(row.reject_reason);
      if (!strategy) {
        decisionLog.logDecision({
          project_id: row.project_id,
          stage: DECISION_STAGE,
          actor: DECISION_ACTOR,
          action: DECISION_ACTION_NO_STRATEGY,
          reasoning: `No strategy registered for reject_reason="${row.reject_reason}"`,
          inputs: { work_item_id: row.id, reject_reason: row.reject_reason },
          outcome: {},
          confidence: 1,
          batch_id: getBatchId(row.id),
        });
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'no_strategy' });
        continue;
      }

      const instanceClaim = `${instanceId}:replan`;
      claimItem(db, row, instanceClaim);

      const history = buildHistoryForStrategy(row);
      const timeoutMs = strategy.name === 'escalate-architect'
        ? config.strategyTimeoutMsEscalate
        : config.strategyTimeoutMs;

      let result;
      try {
        result = await runStrategyWithTimeout(strategy, {
          workItem: row,
          history,
          deps: {
            db,
            logger,
            factoryIntake,
            decisionLog,
            architectRunner: aR,
            factoryHealth: fH,
            config,
            now: nowMs,
          },
        }, timeoutMs);
      } catch (err) {
        const historyEntry = {
          attempt: Number(row.recovery_attempts || 0) + 1,
          strategy: strategy.name,
          prior_reject_reason: row.reject_reason,
          outcome: 'failed',
          error_message: err.message,
          timestamp: new Date(nowMs).toISOString(),
        };
        const hist = appendHistory(row.recovery_history_json, historyEntry, config.historyMaxEntries);
        applyFailureNoStatusChange(db, row, Number(row.recovery_attempts || 0) + 1, hist);
        decisionLog.logDecision({
          project_id: row.project_id,
          stage: DECISION_STAGE,
          actor: DECISION_ACTOR,
          action: DECISION_ACTION_FAILED,
          reasoning: `Strategy "${strategy.name}" threw or timed out: ${err.message}`,
          inputs: { work_item_id: row.id, attempt: Number(row.recovery_attempts || 0) + 1 },
          outcome: { error: err.message },
          confidence: 1,
          batch_id: getBatchId(row.id),
        });
        actions.push({ project_id: row.project_id, work_item_id: row.id, action: 'failed', error: err.message });
        globalReopens++;
        reopenedThisSweepByProject.set(row.project_id, reopenedSoFar + 1);
        continue;
      }

      const nextAttemptCount = Number(row.recovery_attempts || 0) + 1;
      const historyEntry = {
        attempt: nextAttemptCount,
        strategy: strategy.name,
        prior_reject_reason: row.reject_reason,
        prior_description: row.description,
        outcome: result.outcome,
        timestamp: new Date(nowMs).toISOString(),
      };
      if (result.reason) historyEntry.reason = result.reason;
      const hist = appendHistory(row.recovery_history_json, historyEntry, config.historyMaxEntries);

      if (result.outcome === 'rewrote') {
        applyRewrote(db, row, result.updates || {}, nextAttemptCount, hist);
      } else if (result.outcome === 'escalated') {
        applyEscalated(db, row, result.updates || {}, nextAttemptCount, hist);
      } else if (result.outcome === 'split') {
        const childIds = applySplit(db, row, result.children || [], nextAttemptCount, hist);
        decisionLog.logDecision({
          project_id: row.project_id,
          stage: DECISION_STAGE,
          actor: DECISION_ACTOR,
          action: DECISION_ACTION_SPLIT,
          reasoning: `Decompose split work item ${row.id} into ${childIds.length} children.`,
          inputs: { parent_id: row.id, child_count: childIds.length },
          outcome: { child_ids: childIds, depth: Number(row.depth || 0) + 1 },
          confidence: 1,
          batch_id: getBatchId(row.id),
        });
      } else if (result.outcome === 'unrecoverable') {
        applyUnrecoverable(db, row, nextAttemptCount, hist);
        decisionLog.logDecision({
          project_id: row.project_id,
          stage: DECISION_STAGE,
          actor: DECISION_ACTOR,
          action: DECISION_ACTION_EXHAUSTED,
          reasoning: `Strategy "${strategy.name}" returned unrecoverable: ${result.reason || ''}`,
          inputs: { work_item_id: row.id, attempt: nextAttemptCount },
          outcome: { status: 'needs_review', reason: result.reason },
          confidence: 1,
          batch_id: getBatchId(row.id),
        });
        if (eventBus?.emitFactoryReplanRecoveryExhausted) {
          eventBus.emitFactoryReplanRecoveryExhausted({
            project_id: row.project_id,
            work_item_id: row.id,
            total_attempts: nextAttemptCount,
            reason: result.reason,
          });
        }
      }

      decisionLog.logDecision({
        project_id: row.project_id,
        stage: DECISION_STAGE,
        actor: DECISION_ACTOR,
        action: DECISION_ACTION_ATTEMPTED,
        reasoning: `Strategy "${strategy.name}" produced outcome "${result.outcome}".`,
        inputs: {
          work_item_id: row.id,
          strategy: strategy.name,
          attempt: nextAttemptCount,
          prior_reject_reason: row.reject_reason,
        },
        outcome: { outcome: result.outcome, reason: result.reason || null },
        confidence: 1,
        batch_id: getBatchId(row.id),
      });

      if (eventBus?.emitFactoryReplanRecoveryAttempted) {
        eventBus.emitFactoryReplanRecoveryAttempted({
          project_id: row.project_id,
          work_item_id: row.id,
          strategy: strategy.name,
          outcome: result.outcome,
          attempt: nextAttemptCount,
        });
      }

      actions.push({
        project_id: row.project_id,
        work_item_id: row.id,
        action: result.outcome,
        attempt: nextAttemptCount,
      });
      globalReopens++;
      reopenedThisSweepByProject.set(row.project_id, reopenedSoFar + 1);
    }

    return actions;
  }

  return { runSweep };
}

async function runReplanRecoverySweep({
  db,
  logger,
  config,
  registry = defaultRegistry,
  factoryHealth,
  architectRunner,
  eventBus,
  instanceId,
  nowMs = Date.now(),
} = {}) {
  if (!config?.enabled) return [];
  if (lastSweepAtMs !== null && (nowMs - lastSweepAtMs) < config.sweepIntervalMs) return [];
  lastSweepAtMs = nowMs;
  const dispatcher = createDispatcher({
    db, logger, registry, factoryHealth, architectRunner, eventBus, instanceId,
  });
  return dispatcher.runSweep({ config, nowMs });
}

function cleanupStaleReplanClaims(db, currentInstanceId) {
  if (!db || !currentInstanceId) return 0;
  const result = db.prepare(`
    UPDATE factory_work_items
    SET claimed_by_instance_id = NULL
    WHERE claimed_by_instance_id LIKE '%:replan'
      AND claimed_by_instance_id NOT LIKE ?
  `).run(`${currentInstanceId}:replan`);
  return result.changes;
}

module.exports = {
  createDispatcher,
  runReplanRecoverySweep,
  cleanupStaleReplanClaims,
  resetReplanRecoverySweepStateForTests,
  DECISION_ACTION_ATTEMPTED,
  DECISION_ACTION_NO_STRATEGY,
  DECISION_ACTION_FAILED,
  DECISION_ACTION_SPLIT,
  DECISION_ACTION_EXHAUSTED,
};
