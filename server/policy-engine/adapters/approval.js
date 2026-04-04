'use strict';

const schedulingAutomation = require('../../db/scheduling-automation');
const evaluationStore = require('../evaluation-store');
const { RISK_CLASSIFICATION } = require('../../plugins/snapscope/handlers/rollback');

const APPROVAL_EVIDENCE_TYPE = 'approval_recorded';
const POLICY_APPROVAL_SOURCE = 'policy-engine';
const POLICY_APPROVAL_RULE_PREFIX = 'Policy approval';
const POLICY_APPROVAL_KEYWORD_PREFIX = '__torque_policy_approval__';
const PEEK_HIGH_RISK_APPROVAL_TYPE = 'peek_recovery_high_risk';
const PEEK_HIGH_RISK_APPROVAL_SOURCE = 'peek-recovery';
const PEEK_HIGH_RISK_APPROVAL_RULE_PREFIX = 'Peek recovery high-risk approval';
const PEEK_HIGH_RISK_APPROVAL_KEYWORD_PREFIX = '__torque_peek_recovery_high_risk__';

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLower(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collectCandidateValues(source, paths) {
  if (!isPlainObject(source) || !Array.isArray(paths)) return [];

  const values = [];
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0) continue;

    let candidates = [source];
    for (const segment of path) {
      const nextCandidates = [];

      for (const candidate of candidates) {
        const entries = Array.isArray(candidate) ? candidate : [candidate];
        for (const entry of entries) {
          if (
            !isPlainObject(entry)
            || !Object.prototype.hasOwnProperty.call(entry, segment)
            || entry[segment] === undefined
            || entry[segment] === null
          ) {
            continue;
          }

          nextCandidates.push(entry[segment]);
        }
      }

      if (nextCandidates.length === 0) {
        candidates = [];
        break;
      }

      candidates = nextCandidates;
    }

    if (candidates.length > 0) {
      values.push(...candidates);
    }
  }

  return values;
}

function resolveValue(sources, paths) {
  const candidateSources = Array.isArray(sources) ? sources : [sources];
  for (const source of candidateSources) {
    for (const candidate of collectCandidateValues(source, paths)) {
      const normalized = normalizeNonEmptyString(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function resolveTaskId(...sources) {
  return resolveValue(sources, [
    ['task_id'],
    ['taskId'],
    ['task', 'id'],
    ['task', 'task_id'],
    ['task', 'taskId'],
    ['target_id'],
    ['targetId'],
    ['target', 'id'],
    ['target', 'task_id'],
    ['target', 'taskId'],
  ]);
}

function resolvePolicyId(...sources) {
  return resolveValue(sources, [
    ['policy_id'],
    ['policyId'],
    ['policy', 'id'],
    ['policy', 'policy_id'],
    ['policy', 'policyId'],
  ]);
}

function resolveProject(...sources) {
  return resolveValue(sources, [
    ['project'],
    ['project_id'],
    ['projectId'],
    ['task', 'project'],
    ['task', 'project_id'],
    ['task', 'projectId'],
    ['target', 'project'],
    ['target', 'project_id'],
    ['target', 'projectId'],
  ]);
}

function resolveEvaluationId(...sources) {
  return resolveValue(sources, [
    ['evaluation_id'],
    ['evaluationId'],
    ['policy_evaluation_id'],
    ['policyEvaluationId'],
    ['evaluation', 'id'],
    ['evaluation', 'evaluation_id'],
    ['evaluation', 'evaluationId'],
    ['task', 'evaluation_id'],
    ['task', 'evaluationId'],
    ['task', 'policy_evaluation_id'],
    ['task', 'policyEvaluationId'],
    ['target', 'evaluation_id'],
    ['target', 'evaluationId'],
    ['target', 'policy_evaluation_id'],
    ['target', 'policyEvaluationId'],
  ]);
}

function resolveBooleanValue(...sources) {
  const truthyValues = new Set(['true', '1', 'yes', 'on', 'enabled', 'passed', 'pass']);
  const falsyValues = new Set(['false', '0', 'no', 'off', 'disabled', 'failed', 'fail']);

  for (const source of sources) {
    for (const candidate of collectCandidateValues(source, [
      ['override_recorded'],
      ['overrideRecorded'],
      ['evidence', 'override_recorded'],
      ['evidence', 'overrideRecorded'],
      ['override', 'recorded'],
    ])) {
      if (candidate === true || candidate === false) {
        return candidate;
      }

      if (typeof candidate === 'number') {
        return candidate !== 0;
      }

      const normalized = normalizeLower(candidate);
      if (normalized && truthyValues.has(normalized)) {
        return true;
      }
      if (normalized && falsyValues.has(normalized)) {
        return false;
      }
    }
  }

  return null;
}

function resolveApprovalType(options = {}) {
  const normalized = typeof options === 'string'
    ? normalizeLower(options)
    : normalizeLower(resolveValue([options], [
      ['approvalType'],
      ['approval_type'],
      ['approval', 'type'],
      ['approval', 'approval_type'],
    ]));
  return normalized === PEEK_HIGH_RISK_APPROVAL_TYPE
    ? PEEK_HIGH_RISK_APPROVAL_TYPE
    : 'policy';
}

function buildPolicyApprovalRuleName(policyId, options = {}) {
  const normalizedPolicyId = normalizeNonEmptyString(policyId) || policyId;
  const approvalType = resolveApprovalType(options);
  if (approvalType === PEEK_HIGH_RISK_APPROVAL_TYPE) {
    return `${PEEK_HIGH_RISK_APPROVAL_RULE_PREFIX}: ${normalizedPolicyId}`;
  }

  return `${POLICY_APPROVAL_RULE_PREFIX}: ${normalizedPolicyId}`;
}

function buildPolicyApprovalCondition(policyId, options = {}) {
  const normalizedPolicyId = normalizeNonEmptyString(policyId) || policyId;
  const approvalType = resolveApprovalType(options);
  if (approvalType === PEEK_HIGH_RISK_APPROVAL_TYPE) {
    return {
      source: PEEK_HIGH_RISK_APPROVAL_SOURCE,
      approval_type: PEEK_HIGH_RISK_APPROVAL_TYPE,
      action: normalizedPolicyId,
      manual_only: true,
      keywords: [`${PEEK_HIGH_RISK_APPROVAL_KEYWORD_PREFIX}:${normalizedPolicyId}`],
    };
  }

  return {
    source: POLICY_APPROVAL_SOURCE,
    policy_id: normalizedPolicyId,
    manual_only: true,
    // Use an impossible keyword match so the rule can back approval_requests
    // without auto-matching unrelated queued tasks during scheduler checks.
    keywords: [`${POLICY_APPROVAL_KEYWORD_PREFIX}:${normalizedPolicyId}`],
  };
}

function safeListApprovalRules(project) {
  if (typeof schedulingAutomation.listApprovalRules !== 'function') {
    return [];
  }

  try {
    return schedulingAutomation.listApprovalRules({
      enabledOnly: false,
      limit: 1000,
      ...(project ? { project } : {}),
    });
  } catch {
    return [];
  }
}

function isPolicyApprovalRule(rule, policyId, options = {}) {
  if (!rule) return false;

  const approvalType = resolveApprovalType(options);
  const expectedName = buildPolicyApprovalRuleName(policyId, options);
  if (normalizeNonEmptyString(rule.name) === expectedName) {
    return true;
  }

  if (!isPlainObject(rule.condition)) {
    return false;
  }

  if (approvalType === PEEK_HIGH_RISK_APPROVAL_TYPE) {
    return normalizeNonEmptyString(rule.condition.source) === PEEK_HIGH_RISK_APPROVAL_SOURCE
      && normalizeNonEmptyString(rule.condition.approval_type) === PEEK_HIGH_RISK_APPROVAL_TYPE
      && normalizeNonEmptyString(rule.condition.action) === policyId;
  }

  return normalizeNonEmptyString(rule.condition.source) === POLICY_APPROVAL_SOURCE
    && normalizeNonEmptyString(rule.condition.policy_id) === policyId;
}

function findPolicyApprovalRules(policyId, project = null, options = {}) {
  if (!policyId) return [];

  return safeListApprovalRules(project).filter((rule) => isPolicyApprovalRule(rule, policyId, options));
}

function safeGetApprovalHistory(taskId) {
  if (!taskId || typeof schedulingAutomation.getApprovalHistory !== 'function') {
    return [];
  }

  try {
    const history = schedulingAutomation.getApprovalHistory(taskId);
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

function safeGetApprovalRequest(taskId) {
  if (!taskId || typeof schedulingAutomation.getApprovalRequest !== 'function') {
    return null;
  }

  try {
    return schedulingAutomation.getApprovalRequest(taskId) || null;
  } catch {
    return null;
  }
}

function getMatchingApprovalRequest(taskId, policyId, project, options = {}) {
  if (!taskId) return null;
  if (!policyId) return safeGetApprovalRequest(taskId);

  const history = safeGetApprovalHistory(taskId);
  if (history.length === 0) return null;

  const matchingRules = findPolicyApprovalRules(policyId, project, options);
  const matchingRuleIds = new Set(matchingRules.map((rule) => rule.id));
  const expectedName = buildPolicyApprovalRuleName(policyId, options);

  return history.find((request) => matchingRuleIds.has(request.rule_id) || request.rule_name === expectedName) || null;
}

function getLatestEvaluationWithOverrides(taskId, policyId, evaluationId) {
  if (evaluationId && typeof evaluationStore.getPolicyEvaluation === 'function') {
    try {
      const evaluation = evaluationStore.getPolicyEvaluation(evaluationId, { include_overrides: true });
      if (evaluation && (!policyId || evaluation.policy_id === policyId)) {
        return evaluation;
      }
    } catch {
      // Fall through to target lookup below.
    }
  }

  if (!taskId || !policyId || typeof evaluationStore.listPolicyEvaluations !== 'function') {
    return null;
  }

  try {
    const evaluations = evaluationStore.listPolicyEvaluations({
      policy_id: policyId,
      target_type: 'task',
      target_id: taskId,
      include_overrides: true,
      limit: 1,
    });
    return Array.isArray(evaluations) ? evaluations[0] || null : null;
  } catch {
    return null;
  }
}

function hasRecordedOverride(policyId, taskId, ...sources) {
  const explicitOutcome = normalizeLower(resolveValue(sources, [
    ['outcome'],
    ['policyOutcome', 'outcome'],
  ]));
  if (explicitOutcome === 'overridden') {
    return true;
  }

  const explicitBypass = resolveBooleanValue(...sources);
  if (explicitBypass === true) {
    return true;
  }

  const evaluationId = resolveEvaluationId(...sources);
  const evaluation = getLatestEvaluationWithOverrides(taskId, policyId, evaluationId);
  if (!evaluation) {
    return false;
  }

  return evaluation.outcome === 'overridden' || Boolean(evaluation.latest_override);
}

/**
 * Ensures a policy approval rule exists for the specified policy.
 * Creates a new approval rule if one doesn't already exist.
 * 
 * @param {string} policyId - The ID of the policy to create an approval rule for
 * @param {Object} options - Configuration options for the approval rule
 * @param {Object} options.context - The context object containing task and policy information
 * @param {Object} options.policyOutcome - The policy outcome information
 * @param {string} [options.project] - The project associated with the rule
 * @param {number} [options.requiredApprovers] - Number of required approvers
 * @param {number} [options.autoApproveAfterMinutes] - Minutes after which to auto-approve
 * @returns {Object} The approval rule object
 */
function ensurePolicyApprovalRule(policyId, options = {}) {
  const project = resolveProject(options, options.context, options.policyOutcome);
  const existing = findPolicyApprovalRules(policyId, project, options)[0];
  if (existing) {
    return existing;
  }

  if (typeof schedulingAutomation.createApprovalRule !== 'function') {
    throw new Error('approval rule creation is unavailable');
  }

  const ruleId = schedulingAutomation.createApprovalRule(
    buildPolicyApprovalRuleName(policyId, options),
    'keyword',
    buildPolicyApprovalCondition(policyId, options),
    {
      ...(project ? { project } : {}),
      ...(options.requiredApprovers !== undefined ? { requiredApprovers: options.requiredApprovers } : {}),
      ...(options.autoApproveAfterMinutes !== undefined
        ? { autoApproveAfterMinutes: options.autoApproveAfterMinutes }
        : {}),
    },
  );

  if (typeof schedulingAutomation.getApprovalRule === 'function') {
    return schedulingAutomation.getApprovalRule(ruleId);
  }

  return {
    id: ruleId,
    name: buildPolicyApprovalRuleName(policyId, options),
    project: project || null,
    rule_type: 'keyword',
    condition: buildPolicyApprovalCondition(policyId, options),
  };
}

/**
 * Collects approval evidence for a policy evaluation.
 * 
 * @param {Object} context - The context object containing task and policy information
 * @returns {Object} Approval evidence object with type, available, and satisfied properties
 */
function collectApprovalEvidence(context = {}) {
  const taskId = resolveTaskId(context);
  const policyId = resolvePolicyId(context);
  const project = resolveProject(context);
  const request = getMatchingApprovalRequest(taskId, policyId, project);

  return {
    type: APPROVAL_EVIDENCE_TYPE,
    available: Boolean(request),
    satisfied: request ? normalizeLower(request.status) === 'approved' : false,
  };
}

/**
 * Resolves the peek recovery action from the provided sources.
 * 
 * @param {...Object} sources - Sources to resolve the action from
 * @returns {string|null} The resolved action name or null if not found
 */
function resolvePeekRecoveryAction(...sources) {
  return resolveValue(sources, [
    ['action'],
    ['action_name'],
    ['evidence', 'action'],
    ['evidence', 'action_name'],
  ]);
}

/**
 * Determines if a peek recovery action is considered high risk.
 * 
 * @param {string} action - The action to check
 * @param {Object} context - The context object containing evidence information
 * @returns {boolean} True if the action is high risk, false otherwise
 */
function isHighRiskPeekRecoveryAction(action, context = {}) {
  if (context?.evidence?.peek_recovery !== true) {
    return false;
  }

  const normalizedAction = normalizeNonEmptyString(action);
  if (!normalizedAction) {
    return false;
  }

  return RISK_CLASSIFICATION[normalizedAction]?.requires_approval === true;
}

/**
 * Determines if approval is required for a policy outcome.
 * 
 * @param {Object} policyOutcome - The policy outcome to check
 * @param {Object} context - The context object containing task and policy information
 * @returns {boolean} True if approval is required, false otherwise
 */
function requireApprovalForOutcome(policyOutcome = {}, context = {}) {
  const highRiskAction = resolvePeekRecoveryAction(context, policyOutcome);
  if (isHighRiskPeekRecoveryAction(highRiskAction, context)) {
    const taskId = resolveTaskId(policyOutcome, context);
    const existingRequest = getMatchingApprovalRequest(
      taskId,
      highRiskAction,
      resolveProject(policyOutcome, context),
      { approvalType: PEEK_HIGH_RISK_APPROVAL_TYPE },
    );
    if (!existingRequest) {
      return true;
    }

    const highRiskStatus = normalizeLower(existingRequest.status);
    if (highRiskStatus === 'approved' || highRiskStatus === 'rejected' || highRiskStatus === 'pending') {
      return false;
    }

    return true;
  }

  const outcome = normalizeLower(policyOutcome.outcome);
  const mode = normalizeLower(policyOutcome.mode);
  if (outcome !== 'fail' || mode !== 'warn') {
    return false;
  }

  const taskId = resolveTaskId(policyOutcome, context);
  const policyId = resolvePolicyId(policyOutcome, context);
  if (hasRecordedOverride(policyId, taskId, policyOutcome, context)) {
    return false;
  }

  const existingRequest = getMatchingApprovalRequest(taskId, policyId, resolveProject(policyOutcome, context));
  if (!existingRequest) {
    return true;
  }

  const status = normalizeLower(existingRequest.status);
  if (status === 'approved' || status === 'rejected' || status === 'pending') {
    return false;
  }

  return true;
}

/**
 * Checks if a high-risk Peek recovery action requires approval.
 * 
 * @param {string} action - The Peek recovery action to check
 * @param {Object} context - The context object containing task and policy information
 * @returns {Promise<Object>} An object with approval status and reason
 */
async function requireHighRiskApproval(action, context = {}) {
  const normalizedAction = normalizeNonEmptyString(action);
  const classification = normalizedAction ? RISK_CLASSIFICATION[normalizedAction] : null;

  if (!classification || classification.requires_approval !== true) {
    return {
      approved: true,
      approval_id: null,
      reason: 'Approval not required',
    };
  }

  const taskId = resolveTaskId(context);
  if (!taskId) {
    return {
      approved: false,
      approval_id: null,
      reason: 'High-risk action requires approval',
    };
  }

  // Try direct human approval via elicitation before DB-based approval
  const { elicit } = require('../../mcp/elicitation');
  const sessionOrId = context.__session || context.__mcpSession || context.mcp_session_id;
  if (sessionOrId) {
    const response = await elicit(sessionOrId, {
      message: `High-risk Peek recovery action: "${normalizedAction}". Approve?`,
      requestedSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['approve', 'reject'] },
        },
        required: ['decision'],
      },
    });

    if (response.action === 'accept' && response.content?.decision === 'approve') {
      return { approved: true, approval_id: null, reason: 'Approved via elicitation' };
    } else if (response.action === 'accept' && response.content?.decision === 'reject') {
      return { approved: false, approval_id: null, reason: 'Rejected via elicitation' };
    }
    // decline/cancel → fall through to existing DB-based approval
  }

  const project = resolveProject(context);
  let request = getMatchingApprovalRequest(
    taskId,
    normalizedAction,
    project,
    { approvalType: PEEK_HIGH_RISK_APPROVAL_TYPE },
  );

  if (!request) {
    const attachment = attachApprovalRequest(taskId, normalizedAction, {
      project,
      context,
      approvalType: PEEK_HIGH_RISK_APPROVAL_TYPE,
    });
    request = getMatchingApprovalRequest(
      taskId,
      normalizedAction,
      project,
      { approvalType: PEEK_HIGH_RISK_APPROVAL_TYPE },
    ) || (attachment.request_id
      ? {
        id: attachment.request_id,
        status: 'pending',
      }
      : null);
  }

  const approvalId = normalizeNonEmptyString(request?.id);
  const status = normalizeLower(request?.status);
  if (!approvalId || status !== 'approved') {
    return {
      approved: false,
      approval_id: approvalId,
      reason: 'High-risk action requires approval',
    };
  }

  return {
    approved: true,
    approval_id: approvalId,
    reason: 'Approval granted',
  };
}

/**
 * Creates an approval request for a policy or high-risk action.
 * 
 * @param {string} taskId - The ID of the task requiring approval
 * @param {string} policyId - The ID of the policy associated with the approval
 * @param {Object} options - Configuration options for the approval request
 * @param {Object} options.context - The context object containing task and policy information
 * @param {Object} options.policyOutcome - The policy outcome information
 * @param {string} [options.project] - The project associated with the approval
 * @param {string} [options.approvalType] - The type of approval ('policy' or 'peek_recovery_high_risk')
 * @returns {Object} An object with approval request details
 */
function attachApprovalRequest(taskId, policyId, options = {}) {
  const normalizedTaskId = normalizeNonEmptyString(taskId);
  const normalizedPolicyId = normalizeNonEmptyString(policyId);
  const approvalType = resolveApprovalType(options);
  if (!normalizedTaskId) {
    throw new Error('taskId is required');
  }
  if (!normalizedPolicyId) {
    throw new Error('policyId is required');
  }

  if (
    approvalType !== PEEK_HIGH_RISK_APPROVAL_TYPE
    && hasRecordedOverride(normalizedPolicyId, normalizedTaskId, options, options.context, options.policyOutcome)
  ) {
    return {
      attached: false,
      bypassed: true,
      request_id: null,
      rule_id: null,
    };
  }

  const rule = ensurePolicyApprovalRule(normalizedPolicyId, options);
  if (!rule || !rule.id) {
    throw new Error(`Unable to resolve approval rule for policy ${normalizedPolicyId}`);
  }
  if (typeof schedulingAutomation.createApprovalRequest !== 'function') {
    throw new Error('approval request creation is unavailable');
  }

  return {
    attached: true,
    bypassed: false,
    request_id: schedulingAutomation.createApprovalRequest(normalizedTaskId, rule.id),
    rule_id: rule.id,
  };
}

module.exports = {
  collectApprovalEvidence,
  requireApprovalForOutcome,
  requireHighRiskApproval,
  attachApprovalRequest,
  PEEK_HIGH_RISK_APPROVAL_TYPE,
};
