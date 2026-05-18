'use strict';

const {
  getWorkItemOriginObject,
} = require('./shared/workitem-accessors');

// Minimum delay between a needs_replan rejection and PRIORITIZE re-pickup.
// Without this cooldown, a rejected item loops straight back into PLAN on the
// next tick, racing the architect against itself.
const NEEDS_REPLAN_COOLDOWN_MS = 5 * 60 * 1000;
const NEEDS_REPLAN_PLAN_QUALITY_SELECTION_PENALTY = 32;
const NEEDS_REPLAN_GENERIC_REJECTION_SELECTION_PENALTY = 16;
const NEEDS_REPLAN_HISTORY_PENALTY_STEP = 4;
const NEEDS_REPLAN_HISTORY_PENALTY_MAX = 12;
const NEEDS_REPLAN_PLAN_QUALITY_PENALTY_PATTERN =
  /(?:plan_quality_gate_rejected_after_intrabatch_retries|pre_written_plan_rejected_by_quality_gate|plan_already_satisfied_no_new_work|already\s+(?:complete|satisfied)|\bno-?op\b|same-shape)/i;
const NEEDS_REPLAN_GENERIC_REJECTION_PENALTY_PATTERN =
  /(?:cannot_generate_plan|empty_branch_after_execute|zero_diff|verify_failed|worktree_[a-z_]*failed|execute_exception|task_\d+_failed|dep_(?:cascade|resolver)_)/i;
const SQLITE_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function parseFactoryTimestampMs(value) {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (!text) return Number.NaN;
  const normalized = SQLITE_UTC_TIMESTAMP_PATTERN.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  return Date.parse(normalized);
}

function getNeedsReplanCooldownInfo(item, nowMs = Date.now()) {
  if (!item || item.status !== 'needs_replan') {
    return { active: false, updatedAtMs: Number.NaN, remainingMs: 0 };
  }
  const updatedAtMs = parseFactoryTimestampMs(item.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    return { active: false, updatedAtMs, remainingMs: 0 };
  }
  const remainingMs = NEEDS_REPLAN_COOLDOWN_MS - (nowMs - updatedAtMs);
  return {
    active: remainingMs > 0,
    updatedAtMs,
    remainingMs: Math.max(0, remainingMs),
  };
}

function buildNeedsReplanPenaltyEvidence(item) {
  const origin = getWorkItemOriginObject(item);
  const evidenceParts = [
    item?.reject_reason,
    origin?.last_rejection_reason,
    origin?.last_gate_feedback,
  ];

  if (origin?.last_rejection_details) {
    evidenceParts.push(JSON.stringify(origin.last_rejection_details));
  }
  if (origin?.last_plan_description_quality_rejection) {
    evidenceParts.push(JSON.stringify(origin.last_plan_description_quality_rejection));
  }
  if (Array.isArray(origin?.escalation_history)) {
    evidenceParts.push(origin.escalation_history
      .map((entry) => entry && entry.reason)
      .filter(Boolean)
      .join('\n'));
  }

  return {
    evidence: evidenceParts.filter(Boolean).join('\n'),
    historyCount: Array.isArray(origin?.escalation_history) ? origin.escalation_history.length : 0,
  };
}

function getNeedsReplanSelectionPenalty(item) {
  if (!item || item.status !== 'needs_replan') {
    return { penalty: 0, label: null };
  }

  const { evidence, historyCount } = buildNeedsReplanPenaltyEvidence(item);
  if (!evidence.trim()) {
    return { penalty: 0, label: null };
  }

  let penalty = 0;
  let label = null;
  if (NEEDS_REPLAN_PLAN_QUALITY_PENALTY_PATTERN.test(evidence)) {
    penalty = NEEDS_REPLAN_PLAN_QUALITY_SELECTION_PENALTY;
    label = 'plan_quality_or_noop_rejection';
  } else if (NEEDS_REPLAN_GENERIC_REJECTION_PENALTY_PATTERN.test(evidence)) {
    penalty = NEEDS_REPLAN_GENERIC_REJECTION_SELECTION_PENALTY;
    label = 'prior_replan_rejection';
  }

  if (penalty > 0 && historyCount > 1) {
    penalty += Math.min(
      NEEDS_REPLAN_HISTORY_PENALTY_MAX,
      (historyCount - 1) * NEEDS_REPLAN_HISTORY_PENALTY_STEP,
    );
  }

  return { penalty, label };
}

module.exports = {
  NEEDS_REPLAN_COOLDOWN_MS,
  getNeedsReplanCooldownInfo,
  getNeedsReplanSelectionPenalty,
  parseFactoryTimestampMs,
};
