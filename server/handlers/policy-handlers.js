'use strict';

const engine = require('../policy-engine/engine');
const evaluationStore = require('../policy-engine/evaluation-store');
const profileStore = require('../policy-engine/profile-store');
const { ErrorCodes, makeError } = require('./error-codes');
const {
  safeDate,
  safeLimit,
  safeOffset,
} = require('./shared');

const POLICY_STAGES = [
  'task_submit',
  'task_pre_execute',
  'task_complete',
  'workflow_submit',
  'workflow_run',
  'manual_review',
];

const POLICY_MODES = ['off', 'shadow', 'advisory', 'warn', 'block'];
const POLICY_OUTCOMES = ['pass', 'fail', 'skipped', 'degraded', 'overridden'];
const POLICY_ERROR_CODES = Object.freeze({
  VALIDATION: 'validation_error',
  POLICY_NOT_FOUND: 'policy_not_found',
  EVALUATION_NOT_FOUND: 'evaluation_not_found',
  OVERRIDE_NOT_ALLOWED: 'override_not_allowed',
  POLICY_MODE_INVALID: 'policy_mode_invalid',
  OPERATION_FAILED: 'operation_failed',
});

function validateArgsObject(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return makeCoreError(POLICY_ERROR_CODES.VALIDATION, 'Arguments object is required', {
      mcpCode: ErrorCodes.INVALID_PARAM,
    });
  }
  return null;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function validateOptionalString(args, field) {
  if (args[field] === undefined) return null;
  if (args[field] !== null && typeof args[field] !== 'string') {
    return makeCoreError(POLICY_ERROR_CODES.VALIDATION, `${field} must be a string`, {
      mcpCode: ErrorCodes.INVALID_PARAM,
      details: { field },
    });
  }
  return null;
}

function validateOptionalEnum(args, field, values, options = {}) {
  if (args[field] === undefined) return null;
  return validateRequiredEnum(args, field, values, options);
}

function validateRequiredPolicyLookup(args) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;
  return validateRequiredString(args, 'policy_id', 'policy_id');
}

function validateRequiredString(args, field, label = field, options = {}) {
  if (!args[field] || typeof args[field] !== 'string' || args[field].trim().length === 0) {
    return makeCoreError(options.code || POLICY_ERROR_CODES.VALIDATION, `${label} is required and must be a non-empty string`, {
      mcpCode: options.mcpCode || ErrorCodes.MISSING_REQUIRED_PARAM,
      details: { field },
      status: options.status || 400,
    });
  }
  return null;
}

function validateRequiredEnum(args, field, values, options = {}) {
  if (!args[field] || !values.includes(args[field])) {
    return makeCoreError(options.code || POLICY_ERROR_CODES.VALIDATION, `${field} must be one of: ${values.join(', ')}`, {
      mcpCode: options.mcpCode || ErrorCodes.INVALID_PARAM,
      details: { field, allowed: values },
      status: options.status || 400,
    });
  }
  return null;
}

function validateOptionalStringArray(args, field) {
  if (args[field] === undefined) return null;
  if (!Array.isArray(args[field]) || args[field].some((entry) => typeof entry !== 'string')) {
    return makeCoreError(POLICY_ERROR_CODES.VALIDATION, `${field} must be an array of strings`, {
      mcpCode: ErrorCodes.INVALID_PARAM,
      details: { field },
    });
  }
  return null;
}

function makeCoreError(code, message, options = {}) {
  return {
    error: {
      code,
      message,
      details: options.details || {},
      status: options.status || 400,
      mcpCode: options.mcpCode || ErrorCodes.OPERATION_FAILED,
    },
  };
}

function isCoreError(result) {
  return Boolean(result && result.error && typeof result.error.code === 'string');
}

function mapPolicyError(error, fallbackCode = POLICY_ERROR_CODES.OPERATION_FAILED) {
  const message = error?.message || String(error);

  if (/policy evaluation not found/i.test(message)) {
    return makeCoreError(POLICY_ERROR_CODES.EVALUATION_NOT_FOUND, message, {
      status: 404,
      mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (/policy not found/i.test(message)) {
    return makeCoreError(POLICY_ERROR_CODES.POLICY_NOT_FOUND, message, {
      status: 404,
      mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (
    /required/i.test(message)
    || /unsupported policy stage/i.test(message)
    || /does not match evaluation policy_id/i.test(message)
    || /must be a string/i.test(message)
    || /must be a valid ISO date-time/i.test(message)
  ) {
    return makeCoreError(POLICY_ERROR_CODES.VALIDATION, message, {
      mcpCode: ErrorCodes.INVALID_PARAM,
    });
  }
  if (/does not allow overrides/i.test(message) || /reason_code .* not allowed/i.test(message)) {
    return makeCoreError(POLICY_ERROR_CODES.OVERRIDE_NOT_ALLOWED, message, {
      mcpCode: ErrorCodes.INVALID_PARAM,
    });
  }

  return makeCoreError(fallbackCode, message, {
    status: 500,
    mcpCode: ErrorCodes.OPERATION_FAILED,
  });
}

function formatCountMessage(noun, count) {
  return `Found ${count} ${noun}${count === 1 ? '' : 's'}`;
}

function toMcpError(result) {
  const details = result.error.details && Object.keys(result.error.details).length > 0
    ? result.error.details
    : null;
  return makeError(result.error.mcpCode, result.error.message, details);
}

function buildScopedPolicies(args, rules) {
  const explicitProfileId = normalizeOptionalString(args.profile_id);
  const projectId = normalizeOptionalString(args.project_id);

  if (!explicitProfileId && !projectId) {
    return {
      profile: null,
      policies: rules,
    };
  }

  let profile = null;
  if (explicitProfileId) {
    profile = profileStore.getPolicyProfile(explicitProfileId);
    if (!profile) {
      return makeCoreError(POLICY_ERROR_CODES.VALIDATION, `Policy profile not found: ${explicitProfileId}`, {
        mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
        details: { profile_id: explicitProfileId },
      });
    }
  } else if (projectId) {
    profile = profileStore.resolvePolicyProfile({
      project_id: projectId,
      include_disabled: true,
    });
  }

  if (!profile) {
    return {
      profile: null,
      policies: [],
    };
  }

  const bindingMap = new Map(
    profileStore
      .listPolicyBindings({
        profile_id: profile.id,
        enabled_only: args.enabled_only === true,
      })
      .map((binding) => [binding.policy_id, binding]),
  );

  const policies = rules
    .filter((rule) => bindingMap.has(rule.id))
    .map((rule) => profileStore.buildEffectiveRule(rule, bindingMap.get(rule.id), profile))
    .filter((rule) => (args.enabled_only === true ? rule.enabled !== false : true));

  return { profile, policies };
}

function listPoliciesCore(args = {}) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;

  let error = validateOptionalString(args, 'project_id'); if (error) return error;
  error = validateOptionalString(args, 'profile_id'); if (error) return error;
  error = validateOptionalString(args, 'category'); if (error) return error;
  error = validateOptionalEnum(args, 'stage', POLICY_STAGES); if (error) return error;
  error = validateOptionalEnum(args, 'mode', POLICY_MODES); if (error) return error;

  try {
    const rules = profileStore.listPolicyRules({
      category: normalizeOptionalString(args.category),
      stage: normalizeOptionalString(args.stage),
      enabled_only: args.enabled_only === true,
    });

    const scoped = buildScopedPolicies(args, rules);
    if (isCoreError(scoped)) return scoped;

    const policies = (normalizeOptionalString(args.mode)
      ? scoped.policies.filter((policy) => policy.mode === args.mode)
      : scoped.policies);

    return {
      policies,
      count: policies.length,
      profile_id: scoped.profile?.id || normalizeOptionalString(args.profile_id),
      project_id: normalizeOptionalString(args.project_id),
    };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function getPolicyCore(args = {}) {
  const error = validateRequiredPolicyLookup(args);
  if (error) return error;

  try {
    const policyId = args.policy_id.trim();
    const policy = profileStore.getPolicyRule(policyId);
    if (!policy) {
      return makeCoreError(POLICY_ERROR_CODES.POLICY_NOT_FOUND, `Policy not found: ${policyId}`, {
        status: 404,
        mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
      });
    }

    return {
      policy,
    };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function setPolicyModeCore(args = {}) {
  let error = validateRequiredPolicyLookup(args);
  if (error) return error;
  error = validateRequiredEnum(args, 'mode', POLICY_MODES, {
    code: POLICY_ERROR_CODES.POLICY_MODE_INVALID,
  }); if (error) return error;
  error = validateRequiredString(args, 'reason', 'reason'); if (error) return error;

  try {
    const policyId = args.policy_id.trim();
    const rule = profileStore.getPolicyRule(policyId);
    if (!rule) {
      return makeCoreError(POLICY_ERROR_CODES.POLICY_NOT_FOUND, `Policy not found: ${policyId}`, {
        status: 404,
        mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
      });
    }

    const previousMode = rule.mode;
    const policy = profileStore.savePolicyRule({
      ...rule,
      mode: args.mode,
    });

    return {
      policy,
      previous_mode: previousMode,
      reason: args.reason.trim(),
      changed: previousMode !== policy.mode,
    };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function evaluatePoliciesCore(args = {}) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;

  let error = validateRequiredString(args, 'stage', 'stage'); if (error) return error;
  error = validateRequiredEnum(args, 'stage', POLICY_STAGES); if (error) return error;
  error = validateRequiredString(args, 'target_type', 'target_type'); if (error) return error;
  error = validateRequiredString(args, 'target_id', 'target_id'); if (error) return error;
  error = validateOptionalString(args, 'project_id'); if (error) return error;
  error = validateOptionalString(args, 'profile_id'); if (error) return error;
  error = validateOptionalString(args, 'project_path'); if (error) return error;
  error = validateOptionalString(args, 'provider'); if (error) return error;
  error = validateOptionalStringArray(args, 'changed_files'); if (error) return error;

  try {
    return engine.evaluatePolicies(args);
  } catch (err) {
    return mapPolicyError(err);
  }
}

function listPolicyEvaluationsCore(args = {}) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;

  let error = validateOptionalString(args, 'project_id'); if (error) return error;
  error = validateOptionalString(args, 'policy_id'); if (error) return error;
  error = validateOptionalString(args, 'profile_id'); if (error) return error;
  error = validateOptionalEnum(args, 'stage', POLICY_STAGES); if (error) return error;
  error = validateOptionalEnum(args, 'outcome', POLICY_OUTCOMES); if (error) return error;
  error = validateOptionalString(args, 'target_type'); if (error) return error;
  error = validateOptionalString(args, 'target_id'); if (error) return error;
  error = validateOptionalString(args, 'scope_fingerprint'); if (error) return error;

  try {
    const limit = args.limit === undefined ? undefined : safeLimit(args.limit, 50);
    const offset = args.offset === undefined ? undefined : safeOffset(args.offset);
    const evaluations = evaluationStore.listPolicyEvaluations({
      project_id: normalizeOptionalString(args.project_id),
      policy_id: normalizeOptionalString(args.policy_id),
      profile_id: normalizeOptionalString(args.profile_id),
      stage: normalizeOptionalString(args.stage),
      outcome: normalizeOptionalString(args.outcome),
      suppressed: args.suppressed,
      target_type: normalizeOptionalString(args.target_type),
      target_id: normalizeOptionalString(args.target_id),
      scope_fingerprint: normalizeOptionalString(args.scope_fingerprint),
      include_overrides: args.include_overrides === true,
      limit,
      offset,
    });

    return {
      evaluations,
      count: evaluations.length,
      limit: limit ?? null,
      offset: offset ?? 0,
    };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function getPolicyEvaluationCore(args = {}) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;

  const error = validateRequiredString(args, 'evaluation_id', 'evaluation_id');
  if (error) return error;

  try {
    const evaluationId = args.evaluation_id.trim();
    const evaluation = evaluationStore.getPolicyEvaluation(evaluationId, {
      include_overrides: args.include_overrides !== false,
    });

    if (!evaluation) {
      return makeCoreError(POLICY_ERROR_CODES.EVALUATION_NOT_FOUND, `Policy evaluation not found: ${evaluationId}`, {
        status: 404,
        mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
      });
    }

    return { evaluation };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function overridePolicyDecisionCore(args = {}) {
  const argsError = validateArgsObject(args);
  if (argsError) return argsError;

  let error = validateRequiredString(args, 'evaluation_id', 'evaluation_id'); if (error) return error;
  error = validateRequiredString(args, 'reason_code', 'reason_code'); if (error) return error;
  error = validateOptionalString(args, 'policy_id'); if (error) return error;
  error = validateOptionalString(args, 'decision'); if (error) return error;
  error = validateOptionalString(args, 'notes'); if (error) return error;
  error = validateOptionalString(args, 'actor'); if (error) return error;

  let expiresAt = null;
  if (args.expires_at !== undefined && args.expires_at !== null) {
    if (typeof args.expires_at !== 'string') {
      return makeCoreError(POLICY_ERROR_CODES.VALIDATION, 'expires_at must be a string', {
        mcpCode: ErrorCodes.INVALID_PARAM,
        details: { field: 'expires_at' },
      });
    }
    expiresAt = safeDate(args.expires_at);
    if (!expiresAt) {
      return makeCoreError(POLICY_ERROR_CODES.VALIDATION, 'expires_at must be a valid ISO date-time', {
        mcpCode: ErrorCodes.INVALID_PARAM,
        details: { field: 'expires_at' },
      });
    }
  }

  try {
    const evaluationId = args.evaluation_id.trim();
    const evaluation = evaluationStore.getPolicyEvaluation(evaluationId, { include_overrides: false });
    if (!evaluation) {
      return makeCoreError(POLICY_ERROR_CODES.EVALUATION_NOT_FOUND, `Policy evaluation not found: ${evaluationId}`, {
        status: 404,
        mcpCode: ErrorCodes.RESOURCE_NOT_FOUND,
      });
    }
    if (!evaluation.override_allowed) {
      return makeCoreError(POLICY_ERROR_CODES.OVERRIDE_NOT_ALLOWED, `Policy evaluation ${evaluationId} does not allow overrides`, {
        mcpCode: ErrorCodes.INVALID_PARAM,
      });
    }

    const policyId = normalizeOptionalString(args.policy_id);
    if (policyId && policyId !== evaluation.policy_id) {
      return makeCoreError(POLICY_ERROR_CODES.VALIDATION, `Override policy_id ${policyId} does not match evaluation policy_id ${evaluation.policy_id}`, {
        mcpCode: ErrorCodes.INVALID_PARAM,
        details: {
          policy_id: policyId,
          evaluation_policy_id: evaluation.policy_id,
        },
      });
    }

    const allowedReasonCodes = Array.isArray(evaluation.evaluation?.override_policy?.reason_codes)
      ? evaluation.evaluation.override_policy.reason_codes.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    if (allowedReasonCodes.length > 0 && !allowedReasonCodes.includes(args.reason_code.trim())) {
      return makeCoreError(POLICY_ERROR_CODES.OVERRIDE_NOT_ALLOWED, `Override reason_code ${args.reason_code.trim()} is not allowed for policy ${evaluation.policy_id}`, {
        mcpCode: ErrorCodes.INVALID_PARAM,
        details: { allowed_reason_codes: allowedReasonCodes },
      });
    }

    const result = evaluationStore.createPolicyOverride({
      evaluation_id: evaluationId,
      policy_id: policyId,
      decision: normalizeOptionalString(args.decision) || 'override',
      reason_code: args.reason_code.trim(),
      notes: normalizeOptionalString(args.notes),
      actor: normalizeOptionalString(args.actor),
      expires_at: expiresAt,
    });

    return {
      override: result.override,
      evaluation: result.evaluation,
    };
  } catch (err) {
    return mapPolicyError(err);
  }
}

function handleListPolicies(args = {}) {
  const result = listPoliciesCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: formatCountMessage('policy', result.policies.length),
    }],
  };
}

function handleGetPolicy(args = {}) {
  const result = getPolicyCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: `Loaded policy ${result.policy.id}`,
    }],
  };
}

function handleSetPolicyMode(args = {}) {
  const result = setPolicyModeCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: `Policy ${result.policy.id} mode set to ${result.policy.mode}`,
    }],
  };
}

function handleEvaluatePolicies(args = {}) {
  const result = evaluatePoliciesCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: `Evaluated ${result.total_results} policy result(s) for ${result.stage}:${result.target.type}:${result.target.id}`,
    }],
  };
}

function handleListPolicyEvaluations(args = {}) {
  const result = listPolicyEvaluationsCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: formatCountMessage('policy evaluation', result.evaluations.length),
    }],
  };
}

function handleOverridePolicyDecision(args = {}) {
  const result = overridePolicyDecisionCore(args);
  if (isCoreError(result)) return toMcpError(result);
  return {
    ...result,
    content: [{
      type: 'text',
      text: `Recorded policy override ${result.override.id} for evaluation ${result.override.evaluation_id}`,
    }],
  };
}

module.exports = {
  POLICY_ERROR_CODES,
  POLICY_MODES,
  POLICY_OUTCOMES,
  POLICY_STAGES,
  isCoreError,
  listPoliciesCore,
  getPolicyCore,
  setPolicyModeCore,
  evaluatePoliciesCore,
  listPolicyEvaluationsCore,
  getPolicyEvaluationCore,
  overridePolicyDecisionCore,
  handleListPolicies,
  handleGetPolicy,
  handleSetPolicyMode,
  handleEvaluatePolicies,
  handleListPolicyEvaluations,
  handleOverridePolicyDecision,
};
