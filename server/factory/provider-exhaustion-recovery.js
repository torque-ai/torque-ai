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
const PROVIDER_CHAIN_EXHAUSTION_REJECT_REASON_RE =
  /^escalation_exhausted:\s*(?:restored terminal\s+)?(no_provider_chain|chain_exhausted)\b/i;
// `no_provider_chain` / `chain_exhausted` only mean the recovery chain ran
// out — NOT that a provider was unavailable. The reason_shape in parens is
// the real recurring failure. These shapes mean the provider DID produce
// output and it was rejected on content/quality grounds (the provider
// worked); a recovered provider will not change that, so reopening just
// re-grinds to the same rejection (observed on DLPhone 2026-05-22: ~16
// plan-quality reopens, all re-failed). Such items belong in replan / human
// triage (the recovery inbox), not a blind provider retry — so the
// reopen predicate skips them and leaves them escalation_exhausted.
const INTRINSIC_FAILURE_REASON_SHAPE_RE =
  /plan_quality|plan_lint|description_quality|empty_branch|off_scope/i;

function isIntrinsicFailureShape(reasonShape) {
  return typeof reasonShape === 'string'
    && reasonShape.length > 0
    && INTRINSIC_FAILURE_REASON_SHAPE_RE.test(reasonShape);
}

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

function getRejectReasonEvidence(rejectReason) {
  const normalized = String(rejectReason || '').trim();
  const match = PROVIDER_CHAIN_EXHAUSTION_REJECT_REASON_RE.exec(normalized);
  if (!match) return null;
  const reasonShape = normalized.match(/\(([^)]+)\)/)?.[1] || null;
  // Tightening: skip items whose recurring failure is intrinsic (provider
  // produced output, output was rejected) rather than a capacity failure.
  if (isIntrinsicFailureShape(reasonShape)) return null;
  return {
    source: 'reject_reason',
    exhaustion_kind: normalizeProviderName(match[1]),
    reason_shape: reasonShape,
  };
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

  const rejectReasonEvidence = getRejectReasonEvidence(workItem.reject_reason);
  if (rejectReasonEvidence) return rejectReasonEvidence;

  const origin = parseJsonObject(workItem.origin_json || workItem.origin);
  const lastEscalation = origin.last_escalation;
  const lastEscalationKind = normalizeProviderName(lastEscalation?.kind);
  if (lastEscalationKind === 'no_provider_chain' || lastEscalationKind === 'chain_exhausted') {
    const reasonShape = typeof lastEscalation.reason_shape === 'string'
      ? lastEscalation.reason_shape
      : null;
    // Tightening: same intrinsic-failure skip as the reject_reason path.
    if (isIntrinsicFailureShape(reasonShape)) return null;
    return {
      source: 'origin_last_escalation',
      exhaustion_kind: lastEscalationKind,
      reason_shape: reasonShape,
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
    exhaustion_kind: evidence.exhaustion_kind || null,
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
  const reopenWorkItemStmt = db.prepare(`
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
  `);

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
      exhaustion_kind: evidence.exhaustion_kind || null,
      reason_shape: evidence.reason_shape || null,
    };
    const historyJson = appendRecoveryHistory(workItem.recovery_history_json, historyEntry);

    const result = reopenWorkItemStmt.run(historyJson, nowIso, JSON.stringify(origin), nowIso, workItem.id);

    if (result.changes !== 1) continue;

    reopened.push(workItem.id);
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: RECOVERY_STAGE,
      actor: RECOVERY_ACTOR,
      action: RECOVERY_ACTION,
      reasoning: 'Reopened a provider-chain exhausted work item after provider capacity became available and the project had no open work.',
      inputs: {
        work_item_id: workItem.id,
        previous_status: workItem.status,
        previous_reject_reason: workItem.reject_reason || null,
        evidence_source: evidence.source,
        exhaustion_kind: evidence.exhaustion_kind || null,
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
