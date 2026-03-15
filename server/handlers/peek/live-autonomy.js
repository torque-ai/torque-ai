'use strict';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeActionName(action) {
  return typeof action === 'string' ? action.trim() : '';
}

function isLiveEligible(riskLevel, policyMode) {
  const normalizedRiskLevel = normalizeString(riskLevel);
  const normalizedPolicyMode = normalizeString(policyMode);

  if (normalizedRiskLevel !== 'low') {
    return false;
  }

  return normalizedPolicyMode === 'live' || normalizedPolicyMode === 'warn';
}

function buildRiskJustification(riskLevel, resolvedMode) {
  const normalizedRiskLevel = normalizeString(riskLevel);
  const normalizedResolvedMode = normalizeString(resolvedMode);

  if (normalizedRiskLevel === 'low') {
    if (normalizedResolvedMode === 'live') {
      return 'Risk level is low, so the action is eligible for live execution without recovery gating.';
    }
    if (normalizedResolvedMode === 'canary') {
      return 'Risk level is low, but the resolved mode is canary, so the action remains gated and is not live eligible.';
    }
    if (normalizedResolvedMode === 'shadow') {
      return 'Risk level is low, but the resolved mode is shadow, so the action is not live eligible.';
    }
    if (normalizedResolvedMode === 'block') {
      return 'Risk level is low, but the policy resolved to block, so the action is not live eligible.';
    }

    return 'Risk level is low, but live execution is not enabled for the resolved mode, so the action is not live eligible.';
  }

  if (normalizedRiskLevel === 'medium') {
    return 'Risk level is medium, so the action stays gated and is not live eligible.';
  }

  if (normalizedRiskLevel === 'high') {
    return 'Risk level is high, so the action is not live eligible and must remain shadowed or blocked.';
  }

  return 'Risk level is unknown, so the action is not live eligible.';
}

function buildLiveEligibilityRecord(action, riskClassification, resolvedMode) {
  const riskLevel = normalizeString(riskClassification?.level) || 'unknown';
  const liveEligible = isLiveEligible(riskLevel, resolvedMode);

  return {
    action: normalizeActionName(action),
    risk_level: riskLevel,
    live_eligible: liveEligible,
    resolved_mode: normalizeString(resolvedMode) || null,
    risk_justification: buildRiskJustification(riskLevel, resolvedMode),
  };
}

module.exports = {
  isLiveEligible,
  buildLiveEligibilityRecord,
};
