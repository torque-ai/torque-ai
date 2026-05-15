// Recovery decision helpers. Pure functions used by the loop controller
// to classify rejection shapes, detect same-shape escalation, and decide
// whether an empty-merge failure should quarantine a work item.
//
// Extracted from server/factory/loop-controller.js as Phase 1c of the
// god-object refactor. Behavior preserved; no signature changes.
//
// Two clusters live here:
//   1. Same-shape escalation — detect when N consecutive rejections share
//      the same normalized reason + signals, signaling the system should
//      escalate to the next provider instead of churning indefinitely.
//   2. Empty-merge quarantine — detect "no commits ahead of <base>"
//      merge-time failures and quarantine after threshold matching prior
//      occurrences for the same work item.

// Phase X5 (2026-05-01): when same-shape failures repeat, escalate.
// "Same shape" = the normalized rejection reason matches the prior N
// rejections AND any structured signals (missing_specificity_signals)
// also match. After SAME_SHAPE_THRESHOLD repeats, the system bumps to
// the next architect provider in the project's provider_chain. After
// the chain is exhausted (no more providers to try), the work item
// transitions to terminal 'escalation_exhausted' — distinct from
// 'rejected' so the dashboard shows "system tried everything" vs
// "system gave up after N retries."
const SAME_SHAPE_THRESHOLD = 3;
const ESCALATION_HISTORY_MAX = 20;

// Strip variable parts (UUIDs, error messages) so two rejections from
// the same root cause normalize to the same key.
function normalizeRejectionReasonForShape(reason) {
  if (!reason || typeof reason !== 'string') return 'unknown';
  // Drop everything after the first colon (": ${err.message}", task IDs, etc.)
  const head = reason.split(':')[0].trim();
  return head.toLowerCase();
}

function normalizeMissingSignalsForShape(entry) {
  return (entry?.missing_signals || []).slice().sort().join(',');
}

function isSameShapeEscalationEntry(entry, currentShape, currentSignals) {
  return normalizeRejectionReasonForShape(entry?.reason) === currentShape
    && normalizeMissingSignalsForShape(entry) === currentSignals;
}

function detectSameShapeEscalation(escalationHistory, currentEntry) {
  if (!Array.isArray(escalationHistory) || escalationHistory.length < SAME_SHAPE_THRESHOLD - 1) {
    return false;
  }
  const currentShape = normalizeRejectionReasonForShape(currentEntry.reason);
  const currentSignals = normalizeMissingSignalsForShape(currentEntry);
  const recent = escalationHistory.slice(-(SAME_SHAPE_THRESHOLD - 1));
  if (recent.every((entry) => isSameShapeEscalationEntry(entry, currentShape, currentSignals))) {
    return true;
  }

  // Fixed transient failures may interleave between semantic plan rejections.
  // Count matching entries in the retained window so persistent same-shape
  // rejections still escalate instead of churning in needs_replan forever.
  const retainedWindow = escalationHistory.slice(-ESCALATION_HISTORY_MAX);
  const matchingCount = retainedWindow.filter(
    (entry) => isSameShapeEscalationEntry(entry, currentShape, currentSignals)
  ).length;
  return matchingCount >= SAME_SHAPE_THRESHOLD - 1;
}

function shouldClearPlanPathForNeedsReplan(_workItem, planPath) {
  return Boolean(planPath && typeof planPath === 'string');
}

// Fix 2: detect the "no commits ahead of <base>" merge-time failure that
// signals an empty execution. Pure helpers are exported for testability.
function isEmptyBranchMergeError(message) {
  return typeof message === 'string' && /no commits ahead/i.test(message);
}

function countPriorEmptyMergeFailuresForWorkItem(decisions, workItemId) {
  if (!Array.isArray(decisions) || workItemId == null) return 0;
  return decisions.filter((d) => {
    if (!d || d.action !== 'worktree_merge_failed') return false;
    const outcome = d.outcome || {};
    if (outcome.work_item_id !== workItemId) return false;
    return isEmptyBranchMergeError(outcome.error || '');
  }).length;
}

function shouldQuarantineForEmptyMerges({ currentErrorMessage, priorDecisions, workItemId, threshold = 1 }) {
  if (!isEmptyBranchMergeError(currentErrorMessage)) return false;
  return countPriorEmptyMergeFailuresForWorkItem(priorDecisions, workItemId) >= threshold;
}

function isMergeTargetOperatorBlockedError(err) {
  return Boolean(err && (
    err.code === 'IN_PROGRESS_GIT_OPERATION'
    || err.code === 'MAIN_REPO_SEMANTIC_DRIFT'
  ));
}

module.exports = {
  SAME_SHAPE_THRESHOLD,
  ESCALATION_HISTORY_MAX,
  normalizeRejectionReasonForShape,
  normalizeMissingSignalsForShape,
  isSameShapeEscalationEntry,
  detectSameShapeEscalation,
  shouldClearPlanPathForNeedsReplan,
  isEmptyBranchMergeError,
  countPriorEmptyMergeFailuresForWorkItem,
  shouldQuarantineForEmptyMerges,
  isMergeTargetOperatorBlockedError,
};
