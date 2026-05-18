'use strict';

const factoryDecisions = require('../db/factory/decisions');
const factoryIntake = require('../db/factory/intake');
const configCore = require('../db/config-core');
const providerRoutingCore = require('../db/provider/routing-core');
const { clearPlanGenerationWaitFields } = require('./plan-generation/timeout-policy');

const RECOVERY_ACTION = 'provider_exhausted_work_item_reopened';
const RECOVERY_STAGE = 'learn';
const RECOVERY_ACTOR = 'auto-recovery';
const RECOVERY_STRATEGY = 'provider_exhaustion_reopen';
const DEFAULT_MAX_REOPENS_PER_PROJECT = 10;
const DEFAULT_SCAN_LIMIT = 250;
const RECOVERY_HISTORY_LIMIT = 10;

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeProviderName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function bindCapacityCheckStores(db) {
  if (!db || typeof db.prepare !== 'function') return;
  if (typeof configCore.setDb === 'function') {
    configCore.setDb(db);
  }
  if (typeof providerRoutingCore.setDb === 'function') {
    providerRoutingCore.setDb(db);
  }
}

function hasRecoveredProviderCapacity({ db } = {}) {
  try {
    bindCapacityCheckStores(db);
    const codexExhausted = configCore.getConfig('codex_exhausted') === '1';
    const providers = typeof providerRoutingCore.listProviders === 'function'
      ? providerRoutingCore.listProviders()
      : [];
    if (!Array.isArray(providers)) return false;

    return providers.some((provider) => {
      const name = normalizeProviderName(provider?.provider || provider?.name);
      if (!name || !provider?.enabled) return false;
      if (name === 'codex' && codexExhausted) return false;
      return typeof providerRoutingCore.isProviderAvailableForRouting === 'function'
        ? providerRoutingCore.isProviderAvailableForRouting(name)
        : true;
    });
  } catch {
    return false;
  }
}

function getNoProviderChainEvidence(workItem) {
  if (!workItem || workItem.status !== 'escalation_exhausted') {
    return null;
  }

  const rejectReason = String(workItem.reject_reason || '').trim();
  if (/^escalation_exhausted:\s*no_provider_chain\b/i.test(rejectReason)) {
    return {
      source: 'reject_reason',
      reason_shape: rejectReason.match(/\(([^)]+)\)/)?.[1] || null,
    };
  }

  const origin = parseJsonObject(workItem.origin_json || workItem.origin);
  const lastEscalation = origin.last_escalation;
  if (normalizeProviderName(lastEscalation?.kind) === 'no_provider_chain') {
    return {
      source: 'origin_last_escalation',
      reason_shape: typeof lastEscalation.reason_shape === 'string'
        ? lastEscalation.reason_shape
        : null,
    };
  }

  return null;
}

function countPriorProviderExhaustionRecoveries(workItem) {
  const history = parseJsonObject(workItem.recovery_history_json);
  const entries = Array.isArray(history) ? history : [];
  return entries.filter((entry) => entry?.strategy === RECOVERY_STRATEGY).length;
}

function appendRecoveryHistory(currentJson, entry) {
  let entries = [];
  try {
    const parsed = JSON.parse(currentJson || '[]');
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  entries.push(entry);
  return JSON.stringify(entries.slice(-RECOVERY_HISTORY_LIMIT));
}

function buildRecoveredOrigin(workItem, evidence, nowIso) {
  const origin = clearPlanGenerationWaitFields(parseJsonObject(workItem.origin_json || workItem.origin));
  const previousEscalationHistory = Array.isArray(origin.escalation_history)
    ? origin.escalation_history
    : [];
  const priorRecoveryHistory = Array.isArray(origin.provider_exhaustion_recovery_history)
    ? origin.provider_exhaustion_recovery_history
    : [];
  const recovery = {
    recovered_at: nowIso,
    source: evidence.source,
    reason_shape: evidence.reason_shape || null,
    previous_status: workItem.status,
    previous_reject_reason: workItem.reject_reason || null,
    previous_last_escalation: origin.last_escalation || null,
    previous_escalation_history_count: previousEscalationHistory.length,
  };

  delete origin.last_escalation;
  delete origin.escalation_history;
  origin.provider_exhaustion_recovery = recovery;
  origin.provider_exhaustion_recovery_history = [...priorRecoveryHistory, recovery].slice(-RECOVERY_HISTORY_LIMIT);
  return origin;
}

function listNoProviderChainExhaustedCandidates(db, projectId, { scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
  const rows = db.prepare(`
    SELECT *
    FROM factory_work_items
    WHERE project_id = ?
      AND status = 'escalation_exhausted'
    ORDER BY priority DESC, COALESCE(updated_at, created_at) ASC, id ASC
    LIMIT ?
  `).all(projectId, scanLimit);

  return rows
    .map(factoryIntake.parseWorkItem)
    .map((workItem) => ({ workItem, evidence: getNoProviderChainEvidence(workItem) }))
    .filter((entry) => entry.evidence);
}

function recoverNoProviderChainExhaustedWorkItemsForProject({
  db,
  project,
  logger = console,
  maxReopens = DEFAULT_MAX_REOPENS_PER_PROJECT,
  hasRecoveredCapacity = hasRecoveredProviderCapacity,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recoverNoProviderChainExhaustedWorkItemsForProject requires a database handle');
  }
  if (!project?.id) {
    throw new Error('recoverNoProviderChainExhaustedWorkItemsForProject requires a project');
  }
  if (project.status !== 'running' || project.trust_level !== 'dark') {
    return { scanned: 0, reopened: 0, skipped_reason: 'project_not_running_dark' };
  }

  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);

  const openItems = factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 1 });
  if (openItems.length > 0) {
    return { scanned: 0, reopened: 0, skipped_reason: 'open_work_exists' };
  }
  if (!hasRecoveredCapacity({ db })) {
    return { scanned: 0, reopened: 0, skipped_reason: 'provider_capacity_unavailable' };
  }

  const safeMax = Math.max(1, Number(maxReopens) || DEFAULT_MAX_REOPENS_PER_PROJECT);
  const candidates = listNoProviderChainExhaustedCandidates(db, project.id);
  const reopened = [];
  const nowIso = new Date().toISOString();

  for (const { workItem, evidence } of candidates) {
    if (reopened.length >= safeMax) break;
    if (countPriorProviderExhaustionRecoveries(workItem) > 0) continue;

    const origin = buildRecoveredOrigin(workItem, evidence, nowIso);
    const historyEntry = {
      strategy: RECOVERY_STRATEGY,
      outcome: 'reopened',
      timestamp: nowIso,
      prior_status: workItem.status,
      prior_reject_reason: workItem.reject_reason || null,
      evidence_source: evidence.source,
      reason_shape: evidence.reason_shape || null,
    };
    const historyJson = appendRecoveryHistory(workItem.recovery_history_json, historyEntry);

    const result = db.prepare(`
      UPDATE factory_work_items
      SET status = 'pending',
          reject_reason = NULL,
          claimed_by_instance_id = NULL,
          recovery_attempts = COALESCE(recovery_attempts, 0) + 1,
          recovery_history_json = ?,
          last_recovery_at = ?,
          origin_json = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'escalation_exhausted'
    `).run(historyJson, nowIso, JSON.stringify(origin), nowIso, workItem.id);

    if (result.changes !== 1) continue;

    reopened.push(workItem.id);
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: RECOVERY_STAGE,
      actor: RECOVERY_ACTOR,
      action: RECOVERY_ACTION,
      reasoning: 'Reopened a no-provider-chain exhausted work item after provider capacity became available and the project had no open work.',
      inputs: {
        work_item_id: workItem.id,
        previous_status: workItem.status,
        previous_reject_reason: workItem.reject_reason || null,
        evidence_source: evidence.source,
      },
      outcome: {
        work_item_id: workItem.id,
        next_status: 'pending',
        cleared_terminal_escalation: true,
      },
      confidence: 1,
      batch_id: `provider-exhaustion-recovery:${workItem.id}`,
    });
  }

  if (reopened.length > 0) {
    logger.info?.('Factory tick: reopened provider-exhausted work items', {
      project_id: project.id,
      reopened_work_item_ids: reopened,
      scanned: candidates.length,
    });
  }

  return { scanned: candidates.length, reopened: reopened.length, reopened_work_item_ids: reopened };
}

module.exports = {
  RECOVERY_ACTION,
  RECOVERY_STRATEGY,
  getNoProviderChainEvidence,
  hasRecoveredProviderCapacity,
  listNoProviderChainExhaustedCandidates,
  recoverNoProviderChainExhaustedWorkItemsForProject,
};
