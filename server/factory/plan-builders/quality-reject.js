// Plan-quality rejection payload builders. Pure helpers that take a
// quality verdict (from the plan-description scoring engine or the plan-
// quality gate) and produce the rejection structure that the loop-
// controller stores on the work item.
//
// Extracted from server/factory/loop-controller.js as part of Phase 1a of
// the god-object refactor. Behavior preserved; no signature changes.

const PLAN_DESCRIPTION_QUALITY_THRESHOLD = 80;

function buildPlanDescriptionQualityRejectPayload(descriptionQuality) {
  const failingTasks = (descriptionQuality?.failures || []).map((failure) => ({
    task_index: failure.task_index,
    task_title: failure.task_title,
    score: failure.score,
    threshold: failure.threshold,
    missing_specificity_signals: failure.missing_signals,
    reasons: failure.reasons,
  }));
  const firstFailure = failingTasks[0] || {};

  return {
    code: 'plan_description_quality_below_threshold',
    failing_task_index: firstFailure.task_index ?? null,
    failing_task_title: firstFailure.task_title ?? null,
    score: firstFailure.score ?? null,
    threshold: descriptionQuality?.threshold ?? PLAN_DESCRIPTION_QUALITY_THRESHOLD,
    missing_specificity_signals: firstFailure.missing_specificity_signals || [],
    reasons: firstFailure.reasons || [],
    failing_tasks: failingTasks,
  };
}

function buildPlanQualityGateRejectPayload(gateVerdict) {
  const hardFails = Array.isArray(gateVerdict?.hardFails) ? gateVerdict.hardFails : [];
  const rules = [...new Set(hardFails.map((failure) => failure.rule).filter(Boolean))];
  const reasons = hardFails
    .map((failure) => failure.detail || failure.rule)
    .filter(Boolean);
  const failingTasks = hardFails.map((failure) => ({
    task_index: typeof failure.taskNumber === 'number' ? failure.taskNumber - 1 : null,
    task_title: null,
    score: null,
    threshold: null,
    missing_specificity_signals: failure.rule ? [failure.rule] : [],
    reasons: [failure.detail || failure.rule].filter(Boolean),
    rule: failure.rule || null,
    task_number: typeof failure.taskNumber === 'number' ? failure.taskNumber : null,
  }));
  const firstFailure = failingTasks[0] || {};

  return {
    code: 'plan_quality_gate_failed',
    failing_task_index: firstFailure.task_index ?? null,
    failing_task_title: null,
    score: null,
    threshold: null,
    missing_specificity_signals: rules,
    reasons,
    failing_tasks: failingTasks,
    feedback_prompt: gateVerdict?.feedbackPrompt || null,
  };
}

function buildTerminalEscalationRejectReason(workItem, evidence) {
  const existing = String(workItem?.reject_reason || '').trim();
  if (/^escalation_exhausted\b/i.test(existing)) {
    return existing;
  }
  const kind = evidence?.kind || 'terminal_escalation';
  const shape = evidence?.reason_shape ? ` (${evidence.reason_shape})` : '';
  return `escalation_exhausted: ${kind}${shape}`;
}

module.exports = {
  PLAN_DESCRIPTION_QUALITY_THRESHOLD,
  buildPlanDescriptionQualityRejectPayload,
  buildPlanQualityGateRejectPayload,
  buildTerminalEscalationRejectReason,
};
