'use strict';

const evaluationStore = require('./evaluation-store');
const profileStore = require('./profile-store');

const POLICY_MODE_ORDER = ['off', 'shadow', 'advisory', 'warn', 'block'];
const PROMOTION_ORDER = ['shadow', 'advisory', 'warn', 'block'];
const PROMOTION_WINDOW_DAYS = 7;
const PROMOTION_MIN_EVALUATIONS = 20;
const FALSE_POSITIVE_REASON_CODE = 'policy_false_positive';

const PROMOTION_THRESHOLDS = Object.freeze({
  benchmark_pass_rate_min: 0.95,
  false_positive_rate_max: 0.10,
  override_rate_max: 0.20,
});

function normalizeMode(mode, fallback = 'shadow') {
  const normalized = String(mode || fallback).trim().toLowerCase();
  return POLICY_MODE_ORDER.includes(normalized) ? normalized : fallback;
}

function normalizeRate(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function resolveThresholds(overrides = {}) {
  return {
    benchmark_pass_rate_min: normalizeRate(
      overrides.benchmark_pass_rate_min,
      PROMOTION_THRESHOLDS.benchmark_pass_rate_min,
    ),
    false_positive_rate_max: normalizeRate(
      overrides.false_positive_rate_max,
      PROMOTION_THRESHOLDS.false_positive_rate_max,
    ),
    override_rate_max: normalizeRate(
      overrides.override_rate_max,
      PROMOTION_THRESHOLDS.override_rate_max,
    ),
  };
}

function getPromotionTarget(mode) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === 'off') {
    return 'shadow';
  }

  const index = PROMOTION_ORDER.indexOf(normalizedMode);
  if (index === -1 || index === PROMOTION_ORDER.length - 1) {
    return normalizedMode;
  }
  return PROMOTION_ORDER[index + 1];
}

function getDemotionTarget(mode) {
  const normalizedMode = normalizeMode(mode);
  const index = PROMOTION_ORDER.indexOf(normalizedMode);
  if (index <= 0) {
    return normalizedMode;
  }
  return PROMOTION_ORDER[index - 1];
}

function normalizeRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}

function resolveWindowStart(windowDays = PROMOTION_WINDOW_DAYS) {
  const numeric = Number(windowDays);
  const normalizedWindowDays = Number.isFinite(numeric) && numeric > 0
    ? numeric
    : PROMOTION_WINDOW_DAYS;
  return new Date(Date.now() - normalizedWindowDays * 24 * 60 * 60 * 1000).toISOString();
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value, fallback) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function resolvePolicyState(policyId) {
  const normalizedPolicyId = normalizeRequiredString(policyId, 'policyId');
  const rule = profileStore.getPolicyRule(normalizedPolicyId);

  if (!rule) {
    throw new Error(`Policy not found: ${normalizedPolicyId}`);
  }

  const bindings = profileStore.listPolicyBindings({
    policy_id: normalizedPolicyId,
    enabled_only: true,
  });
  const effectiveModes = bindings.length > 0
    ? bindings.map((binding) => normalizeMode(binding.mode_override || rule.mode, rule.mode || 'shadow'))
    : [normalizeMode(rule.mode, 'shadow')];
  const uniqueModes = [...new Set(effectiveModes)];

  return {
    policyId: normalizedPolicyId,
    rule,
    bindings,
    currentMode: uniqueModes[0],
    effectiveModes: uniqueModes,
    modeConflict: uniqueModes.length > 1,
  };
}

function getPromotionMetrics(policyId, windowDays = PROMOTION_WINDOW_DAYS) {
  const overrideStats = evaluationStore.getOverrideRate(policyId, windowDays);
  const windowStart = toTimestamp(resolveWindowStart(windowDays));
  const falsePositiveEvaluations = new Set(
    evaluationStore
      .listPolicyOverrides({ policy_id: policyId })
      .filter((override) => {
        if (!override) return false;
        if ((override.decision || 'override') !== 'override') return false;
        if (override.reason_code !== FALSE_POSITIVE_REASON_CODE) return false;
        return toTimestamp(override.created_at) >= windowStart;
      })
      .map((override) => override.evaluation_id || override.id),
  );
  const evaluationCount = Number(overrideStats.total_evaluations || 0);

  return {
    evaluationCount,
    overrideRate: normalizeRate(overrideStats.rate, 0),
    falsePositiveCount: falsePositiveEvaluations.size,
    falsePositiveRate: evaluationCount === 0
      ? 0
      : normalizeRate(falsePositiveEvaluations.size / evaluationCount, 0),
  };
}

function getPromotionAssessment(policyId, options = {}) {
  const state = resolvePolicyState(policyId);
  const metrics = getPromotionMetrics(policyId, options.windowDays);
  const currentMode = state.modeConflict ? 'mixed' : state.currentMode;
  const transitionAvailable = ['shadow', 'advisory', 'warn'].includes(currentMode);
  const eligible = !state.modeConflict
    && transitionAvailable
    && metrics.evaluationCount >= PROMOTION_MIN_EVALUATIONS
    && metrics.falsePositiveRate < PROMOTION_THRESHOLDS.false_positive_rate_max;

  return {
    policyId: state.policyId,
    currentMode,
    suggestedMode: eligible ? getPromotionTarget(currentMode) : currentMode,
    falsePositiveRate: metrics.falsePositiveRate,
    overrideRate: metrics.overrideRate,
    evaluationCount: metrics.evaluationCount,
    eligible,
    rule: state.rule,
    bindings: state.bindings,
    modeConflict: state.modeConflict,
  };
}

function appendDemotionMetadata(container, entry) {
  const base = isPlainObject(container) ? cloneJson(container, {}) : {};
  const promotion = isPlainObject(base.promotion) ? cloneJson(base.promotion, {}) : {};
  const demotions = Array.isArray(promotion.demotions)
    ? cloneJson(promotion.demotions, [])
    : [];

  return {
    ...base,
    promotion: {
      ...promotion,
      last_demotion: entry,
      demotions: [entry, ...demotions].slice(0, 10),
    },
  };
}

function toEffectivePolicy(rule, bindings) {
  const primaryBinding = Array.isArray(bindings) && bindings.length > 0 ? bindings[0] : null;
  return {
    ...rule,
    policy_id: rule.id,
    profile_id: primaryBinding?.profile_id || null,
    binding_id: primaryBinding?.id || null,
    binding_json: primaryBinding?.binding_json || {},
    mode: normalizeMode(primaryBinding?.mode_override || rule.mode, rule.mode || 'shadow'),
  };
}

function persistModeChange(state, nextMode, options = {}) {
  const demotionEntry = options.demotionReason
    ? {
      from_mode: state.currentMode,
      to_mode: nextMode,
      reason: options.demotionReason,
      recorded_at: new Date().toISOString(),
    }
    : null;

  if (state.bindings.length === 0) {
    const updatedRule = profileStore.savePolicyRule({
      ...state.rule,
      mode: nextMode,
      override_policy: demotionEntry
        ? appendDemotionMetadata(state.rule.override_policy, demotionEntry)
        : state.rule.override_policy,
    });
    return toEffectivePolicy(updatedRule, []);
  }

  const updatedBindings = state.bindings.map((binding) => profileStore.savePolicyBinding({
    ...binding,
    mode_override: nextMode,
    binding_json: demotionEntry
      ? appendDemotionMetadata(binding.binding_json, demotionEntry)
      : binding.binding_json,
  }));

  return toEffectivePolicy(state.rule, updatedBindings);
}

function evaluatePromotion(input = {}) {
  const currentMode = normalizeMode(input.current_mode || input.currentMode);
  const thresholds = resolveThresholds(input.thresholds || {});
  const benchmarkPassRate = normalizeRate(
    input.benchmark_pass_rate ?? input.benchmarkPassRate,
    0,
  );
  const falsePositiveRate = normalizeRate(
    input.false_positive_rate ?? input.falsePositiveRate,
    0,
  );
  const overrideRate = normalizeRate(
    input.override_rate ?? input.overrideRate,
    0,
  );
  const deterministic = input.deterministic !== false;
  const canaryReviewCompleted = input.canary_review_completed === undefined
    ? Boolean(input.canaryReviewCompleted)
    : Boolean(input.canary_review_completed);
  const overridePathVerified = input.override_path_verified === undefined
    ? Boolean(input.overridePathVerified)
    : Boolean(input.override_path_verified);

  const benchmarkAccepted = benchmarkPassRate >= thresholds.benchmark_pass_rate_min;
  const falsePositiveExceeded = falsePositiveRate > thresholds.false_positive_rate_max;
  const overrideRateExceeded = overrideRate > thresholds.override_rate_max;

  if (falsePositiveExceeded && ['warn', 'block'].includes(currentMode)) {
    return {
      current_mode: currentMode,
      next_mode: getDemotionTarget(currentMode),
      decision: 'demote',
      reasons: ['false_positive_rate_exceeds_threshold'],
      thresholds,
      metrics: {
        benchmark_pass_rate: benchmarkPassRate,
        false_positive_rate: falsePositiveRate,
        override_rate: overrideRate,
      },
    };
  }

  const promotionReady = benchmarkAccepted
    && canaryReviewCompleted
    && overridePathVerified
    && !falsePositiveExceeded;

  if (currentMode === 'shadow' && promotionReady) {
    return {
      current_mode: currentMode,
      next_mode: 'advisory',
      decision: 'promote',
      reasons: ['promotion_gates_met'],
      thresholds,
      metrics: {
        benchmark_pass_rate: benchmarkPassRate,
        false_positive_rate: falsePositiveRate,
        override_rate: overrideRate,
      },
    };
  }

  if (currentMode === 'advisory' && promotionReady) {
    return {
      current_mode: currentMode,
      next_mode: 'warn',
      decision: 'promote',
      reasons: ['promotion_gates_met'],
      thresholds,
      metrics: {
        benchmark_pass_rate: benchmarkPassRate,
        false_positive_rate: falsePositiveRate,
        override_rate: overrideRate,
      },
    };
  }

  if (currentMode === 'warn' && promotionReady && deterministic && !overrideRateExceeded) {
    return {
      current_mode: currentMode,
      next_mode: 'block',
      decision: 'promote',
      reasons: ['promotion_gates_met'],
      thresholds,
      metrics: {
        benchmark_pass_rate: benchmarkPassRate,
        false_positive_rate: falsePositiveRate,
        override_rate: overrideRate,
      },
    };
  }

  const reasons = [];
  if (!benchmarkAccepted) reasons.push('benchmark_pass_rate_below_threshold');
  if (!canaryReviewCompleted) reasons.push('canary_review_incomplete');
  if (!overridePathVerified) reasons.push('override_path_unverified');
  if (falsePositiveExceeded) reasons.push('false_positive_rate_exceeds_threshold');
  if (currentMode === 'warn' && !deterministic) reasons.push('block_requires_deterministic_policy');
  if (currentMode === 'warn' && overrideRateExceeded) reasons.push('override_rate_exceeds_threshold');

  return {
    current_mode: currentMode,
    next_mode: currentMode,
    decision: 'hold',
    reasons: reasons.length > 0 ? reasons : ['no_transition'],
    thresholds,
    metrics: {
      benchmark_pass_rate: benchmarkPassRate,
      false_positive_rate: falsePositiveRate,
      override_rate: overrideRate,
    },
  };
}

function canPromote(policyId) {
  const assessment = getPromotionAssessment(policyId);
  return {
    eligible: assessment.eligible,
    currentMode: assessment.currentMode,
    suggestedMode: assessment.suggestedMode,
    falsePositiveRate: assessment.falsePositiveRate,
    evaluationCount: assessment.evaluationCount,
  };
}

function promote(policyId, toMode) {
  const state = resolvePolicyState(policyId);
  if (state.modeConflict) {
    throw new Error(`Policy ${state.policyId} has inconsistent modes across enabled bindings`);
  }

  const normalizedTargetMode = normalizeRequiredString(toMode, 'toMode').toLowerCase();
  if (!POLICY_MODE_ORDER.includes(normalizedTargetMode)) {
    throw new Error(`Invalid mode: ${toMode}`);
  }

  const expectedTarget = getPromotionTarget(state.currentMode);
  if (
    !['shadow', 'advisory', 'warn'].includes(state.currentMode)
    || expectedTarget !== normalizedTargetMode
  ) {
    throw new Error(`Invalid promotion transition: ${state.currentMode} -> ${normalizedTargetMode}`);
  }

  return persistModeChange(state, normalizedTargetMode);
}

function demote(policyId, reason) {
  const state = resolvePolicyState(policyId);
  if (state.modeConflict) {
    throw new Error(`Policy ${state.policyId} has inconsistent modes across enabled bindings`);
  }

  const normalizedReason = normalizeRequiredString(reason, 'reason');
  if (!['block', 'warn', 'advisory'].includes(state.currentMode)) {
    throw new Error(`Invalid demotion transition: ${state.currentMode}`);
  }

  const nextMode = getDemotionTarget(state.currentMode);
  return persistModeChange(state, nextMode, { demotionReason: normalizedReason });
}

function getPromotionStatus() {
  return profileStore
    .listPolicyRules({ enabled_only: false })
    .map((rule) => {
      const assessment = getPromotionAssessment(rule.id);
      return {
        policyId: rule.id,
        currentMode: assessment.currentMode,
        suggestedMode: assessment.suggestedMode,
        overrideRate: assessment.overrideRate,
        falsePositiveRate: assessment.falsePositiveRate,
        evaluationCount: assessment.evaluationCount,
        eligible: assessment.eligible,
      };
    })
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
}

module.exports = {
  PROMOTION_ORDER,
  PROMOTION_THRESHOLDS,
  normalizeMode,
  getPromotionTarget,
  getDemotionTarget,
  evaluatePromotion,
  canPromote,
  promote,
  demote,
  getPromotionStatus,
};
