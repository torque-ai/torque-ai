'use strict';

const { ErrorCodes, makeError } = require('../shared');
const {
  peekHttpGetWithRetry,
  peekHttpPostWithRetry,
  resolvePeekHost,
  resolvePeekTaskContext,
} = require('./shared');
const {
  attachRollbackData,
  RISK_CLASSIFICATION,
  classifyActionRisk,
  createRollbackPlan,
  formatPolicyProof,
} = require('./rollback');
const { buildLiveEligibilityRecord } = require('./live-autonomy');
const taskHooks = require('../../policy-engine/task-hooks');
const { fireWebhookForEvent } = require('./webhook-outbound');
const logger = require('../../logger').child({ component: 'peek-recovery' });

const DEFAULT_RECOVERY_TIMEOUT_MS = 15000;
const RECOVERY_ALLOWED_ENDPOINT = '/recovery/is-allowed-action';
const RECOVERY_EXECUTE_ENDPOINT = '/recovery/execute';
const RECOVERY_STATUS_ENDPOINT = '/recovery/status';

function getRecoveryTimeoutMs(args) {
  const timeoutSeconds = Number(args?.timeout_seconds);
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return timeoutSeconds * 1000;
  }
  return DEFAULT_RECOVERY_TIMEOUT_MS;
}

function normalizeActionName(action) {
  return typeof action === 'string' ? action.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveRecoveryArgs(args) {
  if (!isPlainObject(args)) {
    return {
      action: '',
      actionParams: {},
    };
  }

  return {
    action: normalizeActionName(args.action || args.action_name),
    actionParams: args.params ?? args.action_params ?? args.recovery_params ?? {},
  };
}

function normalizeRecoveryRiskLevel(actionOrRiskLevel = null) {
  if (typeof actionOrRiskLevel !== 'string') {
    return null;
  }

  const normalizedValue = actionOrRiskLevel.trim().toLowerCase();
  if (!normalizedValue) {
    return null;
  }

  if (normalizedValue === 'low' || normalizedValue === 'medium' || normalizedValue === 'high') {
    return normalizedValue;
  }

  return classifyActionRisk(actionOrRiskLevel)?.level || null;
}

function isTruthyConfigFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === '1'
    || normalizedValue === 'true'
    || normalizedValue === 'yes'
    || normalizedValue === 'on';
}

function isLiveModeEnabled() {
  try {
    const configCore = require('../../db/config-core');
    return isTruthyConfigFlag(configCore?.getConfig?.('live_mode_enabled'));
  } catch {
    return false;
  }
}

function resolveRecoveryMode(actionOrRiskLevel = null) {
  const riskLevel = normalizeRecoveryRiskLevel(actionOrRiskLevel);

  if (riskLevel === 'low' && isLiveModeEnabled()) {
    return 'live';
  }
  if (riskLevel === 'medium') {
    return 'canary';
  }

  return 'shadow';
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeActionSpec(spec, actionName = '') {
  if (!isPlainObject(spec)) {
    return null;
  }

  return {
    name: normalizeActionName(spec.name || actionName),
    max_retries: normalizeNonNegativeInteger(spec.max_retries, 0),
    timeout_ms: normalizeNonNegativeNumber(spec.timeout_ms, 0),
    stop_condition: typeof spec.stop_condition === 'string' && spec.stop_condition.trim()
      ? spec.stop_condition.trim()
      : null,
  };
}

function buildStopCondition(actionSpec) {
  if (!actionSpec) {
    return null;
  }
  if (actionSpec.stop_condition) {
    return actionSpec.stop_condition;
  }
  if (actionSpec.timeout_ms > 0) {
    return `Stop after ${1 + actionSpec.max_retries} attempt(s) or ${actionSpec.timeout_ms} ms.`;
  }
  return `Stop after ${1 + actionSpec.max_retries} attempt(s).`;
}

function normalizeAllowedActionPayload(payload, action) {
  const data = isPlainObject(payload) ? payload : {};
  const actionSpec = normalizeActionSpec(
    data.action_spec || data.spec || data.actionSpec || data.allowed_action,
    action,
  );
  const allowed = data.allowed === true
    || data.is_allowed === true
    || data.isAllowed === true
    || (!!actionSpec && data.allowed !== false && data.is_allowed !== false);
  const reason = typeof data.reason === 'string' && data.reason.trim()
    ? data.reason.trim()
    : (typeof data.error === 'string' && data.error.trim() ? data.error.trim() : null);

  return {
    allowed,
    actionSpec,
    reason,
  };
}

function buildActionSpecRecord(actionName, actionSpec, retryBudgets, stopConditions) {
  const normalizedName = normalizeActionName(actionName);
  if (!normalizedName) {
    return null;
  }

  const normalizedSpec = normalizeActionSpec(actionSpec, normalizedName) || {
    name: normalizedName,
    max_retries: normalizeNonNegativeInteger(retryBudgets?.[normalizedName], 0),
    timeout_ms: 0,
    stop_condition: null,
  };

  const stopCondition = typeof stopConditions?.[normalizedName] === 'string' && stopConditions[normalizedName].trim()
    ? stopConditions[normalizedName].trim()
    : buildStopCondition(normalizedSpec);

  return {
    name: normalizedName,
    max_retries: normalizeNonNegativeInteger(
      retryBudgets?.[normalizedName],
      normalizedSpec.max_retries,
    ),
    stop_condition: stopCondition,
  };
}

function normalizeRecoveryCapabilities(payload) {
  const data = isPlainObject(payload) ? payload : {};
  const retryBudgets = isPlainObject(data.retry_budgets) ? data.retry_budgets : {};
  const stopConditions = isPlainObject(data.stop_conditions) ? data.stop_conditions : {};
  const actionSpecs = new Map();

  if (Array.isArray(data.allowed_actions)) {
    for (const action of data.allowed_actions) {
      if (typeof action === 'string') {
        const spec = buildActionSpecRecord(action, null, retryBudgets, stopConditions);
        if (spec) {
          actionSpecs.set(spec.name, spec);
        }
      } else if (isPlainObject(action)) {
        const spec = buildActionSpecRecord(
          action.name || action.action || action.action_name,
          action.action_spec || action.spec || action,
          retryBudgets,
          stopConditions,
        );
        if (spec) {
          actionSpecs.set(spec.name, spec);
        }
      }
    }
  }

  if (Array.isArray(data.actions)) {
    for (const action of data.actions) {
      if (!isPlainObject(action)) continue;
      const spec = buildActionSpecRecord(
        action.name || action.action || action.action_name,
        action.action_spec || action.spec || action,
        retryBudgets,
        stopConditions,
      );
      if (spec) {
        actionSpecs.set(spec.name, spec);
      }
    }
  }

  if (isPlainObject(data.action_specs)) {
    for (const [actionName, spec] of Object.entries(data.action_specs)) {
      const normalizedSpec = buildActionSpecRecord(actionName, spec, retryBudgets, stopConditions);
      if (normalizedSpec) {
        actionSpecs.set(normalizedSpec.name, normalizedSpec);
      }
    }
  }

  const allowedActions = Array.from(actionSpecs.keys()).sort();
  const normalizedRetryBudgets = {};
  const normalizedStopConditions = {};

  for (const actionName of allowedActions) {
    const spec = actionSpecs.get(actionName);
    normalizedRetryBudgets[actionName] = spec.max_retries;
    normalizedStopConditions[actionName] = spec.stop_condition;
  }

  return {
    allowed_actions: allowedActions,
    retry_budgets: normalizedRetryBudgets,
    stop_conditions: normalizedStopConditions,
  };
}

function extractRetryCount(args) {
  const candidates = [
    args?.retry_count,
    args?.retryCount,
    args?.attempt,
    args?.attempts,
  ];

  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }

  return 0;
}

function buildPolicyTaskData(args, context, action, mode, hostName, actionSpec, actionParams) {
  const task = context?.task || {};
  return {
    id: context?.taskId || `peek-recovery:${action}`,
    taskId: context?.taskId || null,
    project: task.project || task.project_id || 'peek',
    project_id: task.project_id || context?.workflowId || null,
    working_directory: task.working_directory || null,
    provider: 'peek',
    command: `peek_recovery:${action}`,
    evidence: {
      peek_recovery: true,
      host: hostName,
      action,
      mode,
      bounded: true,
      retry_budget: actionSpec?.max_retries ?? null,
      stop_condition: buildStopCondition(actionSpec),
      params_present: Object.keys(actionParams || {}).sort(),
    },
  };
}

function resolveApprovalRequester(args = {}, taskContext = null) {
  const candidates = [
    args?.requested_by,
    args?.requestedBy,
    args?.requested_by_user,
    args?.requestedByUser,
    taskContext?.task?.requested_by,
    taskContext?.task?.requestedBy,
    taskContext?.task?.created_by,
    taskContext?.task?.createdBy,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return 'system';
}

function normalizeApprovalStatus(status) {
  if (typeof status !== 'string') {
    return null;
  }

  const normalizedStatus = status.trim().toLowerCase();
  return ['pending', 'approved', 'denied'].includes(normalizedStatus)
    ? normalizedStatus
    : null;
}

function normalizeApprovalId(approvalId) {
  if (Number.isInteger(approvalId) && approvalId > 0) {
    return approvalId;
  }

  const numericId = Number(approvalId);
  if (Number.isInteger(numericId) && numericId > 0) {
    return numericId;
  }

  return null;
}

function createApprovalAuditRecord(action, approvalRow = null) {
  const status = normalizeApprovalStatus(approvalRow?.status);
  const approved = status === 'approved';
  const record = {
    action: normalizeActionName(action),
    approved,
    blocked: !approved,
    approval_required: true,
    approval_id: normalizeApprovalId(approvalRow?.id),
    reason: approved ? 'Approval granted' : 'High-risk action requires approval',
  };

  if (status) {
    record.status = status;
  }
  if (typeof approvalRow?.requested_by === 'string' && approvalRow.requested_by.trim()) {
    record.requested_by = approvalRow.requested_by.trim();
  }
  if (typeof approvalRow?.approved_by === 'string' && approvalRow.approved_by.trim()) {
    record.approved_by = approvalRow.approved_by.trim();
  }
  if (typeof approvalRow?.requested_at === 'string' && approvalRow.requested_at.trim()) {
    record.requested_at = approvalRow.requested_at;
  }
  if (typeof approvalRow?.resolved_at === 'string' && approvalRow.resolved_at.trim()) {
    record.resolved_at = approvalRow.resolved_at;
  }

  return record;
}

async function resolveHighRiskApproval(action, args = {}, taskContext = null) {
  const normalizedAction = normalizeActionName(action);
  if (!normalizedAction) {
    return createApprovalAuditRecord(action);
  }

  // Try direct human approval via elicitation before DB-based approval
  try {
    const { elicit } = require('../../mcp/elicitation');
    const sessionOrId = args?.__session || args?.__mcpSession || args?.mcp_session_id
      || taskContext?.__session || taskContext?.mcp_session_id;
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
        return {
          ...createApprovalAuditRecord(normalizedAction),
          approved: true,
          blocked: false,
          reason: 'Approved via elicitation',
        };
      } else if (response.action === 'accept' && response.content?.decision === 'reject') {
        return {
          ...createApprovalAuditRecord(normalizedAction),
          approved: false,
          blocked: true,
          reason: 'Rejected via elicitation',
        };
      }
      // decline/cancel → fall through to existing DB-based approval
    }
  } catch (elicitError) {
    logger.warn(`Elicitation failed for ${normalizedAction}: ${elicitError.message}`);
  }

  try {
    const peekRecoveryApprovals = require('../../db/peek-recovery-approvals');
    if (
      typeof peekRecoveryApprovals.getApprovalForAction !== 'function'
      || typeof peekRecoveryApprovals.requestApproval !== 'function'
    ) {
      return createApprovalAuditRecord(normalizedAction);
    }

    const taskId = taskContext?.taskId || null;
    const latestApproval = peekRecoveryApprovals.getApprovalForAction(normalizedAction, taskId);
    if (normalizeApprovalStatus(latestApproval?.status) === 'approved') {
      return createApprovalAuditRecord(normalizedAction, latestApproval);
    }

    const approvalRow = normalizeApprovalStatus(latestApproval?.status) === 'pending'
      ? latestApproval
      : peekRecoveryApprovals.requestApproval(
        normalizedAction,
        taskId,
        resolveApprovalRequester(args, taskContext),
      );

    return createApprovalAuditRecord(normalizedAction, approvalRow);
  } catch (approvalError) {
    logger.warn(`Approval lookup failed for ${normalizedAction}: ${approvalError.message}`);
    return createApprovalAuditRecord(normalizedAction);
  }
}

function buildAuditEntry(
  action,
  mode,
  success,
  durationMs,
  attempts,
  error,
  policyProof,
  rollbackPlan,
  riskLevel = null,
  baseEntry = null,
  eligibility = null,
) {
  const entry = isPlainObject(baseEntry) ? { ...baseEntry } : {};
  entry.action_name = normalizeActionName(entry.action_name || action);
  entry.mode = typeof entry.mode === 'string' && entry.mode.trim() ? entry.mode.trim() : mode;
  entry.risk_level = typeof riskLevel === 'string' && riskLevel.trim()
    ? riskLevel.trim()
    : (typeof entry.risk_level === 'string' && entry.risk_level.trim() ? entry.risk_level.trim() : null);
  entry.live_eligible = typeof eligibility?.live_eligible === 'boolean'
    ? eligibility.live_eligible
    : (typeof entry.live_eligible === 'boolean' ? entry.live_eligible : null);
  entry.risk_justification = typeof eligibility?.risk_justification === 'string' && eligibility.risk_justification.trim()
    ? eligibility.risk_justification.trim()
    : (typeof entry.risk_justification === 'string' && entry.risk_justification.trim()
      ? entry.risk_justification.trim()
      : null);
  entry.success = success;
  entry.duration_ms = normalizeNonNegativeNumber(entry.duration_ms, durationMs);
  entry.attempts = normalizeNonNegativeInteger(entry.attempts, attempts);
  entry.error = error == null ? (entry.error ?? null) : String(error);
  entry.completed_at = typeof entry.completed_at === 'string' && entry.completed_at.trim()
    ? entry.completed_at
    : new Date().toISOString();
  entry.policy_proof = policyProof ?? entry.policy_proof ?? null;
  return attachRollbackData(entry, rollbackPlan);
}

function buildRecoveryResult({
  action,
  mode,
  riskLevel = null,
  startedAt,
  success,
  attempts = 0,
  error = null,
  policyProof = null,
  rollbackPlan = null,
  auditEntry = null,
  eligibility = null,
  blocked = false,
  approvalRequired = false,
  approvalId = null,
}) {
  const durationMs = Date.now() - startedAt;
  const normalizedSuccess = success === true;
  const normalizedError = error == null ? null : String(error);
  const normalizedAuditEntry = buildAuditEntry(
    action,
    mode,
    normalizedSuccess,
    durationMs,
    attempts,
    normalizedError,
    policyProof,
    rollbackPlan,
    riskLevel,
    auditEntry,
    eligibility,
  );
  const normalizedEligibility = isPlainObject(eligibility)
    ? {
      ...eligibility,
      action: typeof eligibility.action === 'string' && eligibility.action.trim()
        ? eligibility.action.trim()
        : action,
      risk_level: normalizedAuditEntry.risk_level,
      live_eligible: normalizedAuditEntry.live_eligible,
      resolved_mode: typeof eligibility.resolved_mode === 'string' && eligibility.resolved_mode.trim()
        ? eligibility.resolved_mode.trim()
        : mode,
      risk_justification: normalizedAuditEntry.risk_justification,
    }
    : null;

  const result = {
    success: normalizedSuccess,
    action,
    mode,
    risk_level: normalizedAuditEntry.risk_level,
    live_eligible: normalizedAuditEntry.live_eligible,
    eligibility: normalizedEligibility,
    duration_ms: normalizedAuditEntry.duration_ms,
    audit_entry: normalizedAuditEntry,
    policy_proof: policyProof,
  };

  if (blocked === true) {
    result.blocked = true;
  }
  if (approvalRequired === true) {
    result.approval_required = true;
  }
  if (normalizeApprovalId(approvalId)) {
    result.approval_id = normalizeApprovalId(approvalId);
  }

  return result;
}

function buildExecutionPayload(action, actionParams, mode) {
  return {
    action,
    params: actionParams,
    mode,
    simulate: mode === 'shadow',
    dry_run: mode === 'shadow',
    extra_monitoring: mode === 'canary',
    monitoring: {
      level: mode,
      extra: mode === 'canary',
    },
  };
}

function mergeExecutionAuditEntry(executionAuditEntry, approvalRecord = null, extraAuditEntry = null) {
  const entry = isPlainObject(executionAuditEntry) ? { ...executionAuditEntry } : {};

  if (approvalRecord) {
    entry.approval = approvalRecord;
  }
  if (isPlainObject(extraAuditEntry)) {
    Object.assign(entry, extraAuditEntry);
  }

  return Object.keys(entry).length > 0 ? entry : null;
}

function createShadowPrecheckRecord(stepResult) {
  return {
    mode: 'shadow',
    success: stepResult.ok,
    attempts: stepResult.attempts,
    error: stepResult.error,
  };
}

async function executeRecoveryStep({
  hostUrl,
  action,
  actionParams,
  mode,
  timeoutMs,
  actionSpec,
}) {
  let executeResult;
  try {
    executeResult = await peekHttpPostWithRetry(
      hostUrl + RECOVERY_EXECUTE_ENDPOINT,
      buildExecutionPayload(action, actionParams, mode),
      timeoutMs,
    );
  } catch (executionError) {
    return {
      ok: false,
      attempts: mode === 'shadow' ? 0 : 1,
      error: executionError.message || String(executionError),
      auditEntry: null,
    };
  }

  if (executeResult.error) {
    return {
      ok: false,
      attempts: mode === 'shadow' ? 0 : 1,
      error: `Recovery execution failed: ${executeResult.error}`,
      auditEntry: null,
    };
  }

  const executionData = isPlainObject(executeResult.data) ? executeResult.data : {};
  const attempts = normalizeNonNegativeInteger(executionData.attempts, mode === 'shadow' ? 0 : 1);
  let executionError = null;

  if (typeof executionData.error === 'string' && executionData.error.trim()) {
    executionError = executionData.error.trim();
  }
  if (actionSpec && attempts > actionSpec.max_retries + 1) {
    executionError = executionError || `Retry budget exceeded for '${action}': ${attempts - 1} > ${actionSpec.max_retries}.`;
  }

  return {
    ok: executionData.success === true && !executionError,
    attempts,
    error: executionError,
    auditEntry: executionData.audit_entry,
  };
}

async function handlePeekRecovery(args = {}) {
  const startedAt = Date.now();
  const { action, actionParams } = resolveRecoveryArgs(args);
  const riskClassification = classifyActionRisk(action);
  const riskMetadata = RISK_CLASSIFICATION[normalizeActionName(action)] || null;
  const approvalRequired = riskMetadata?.approval_required === true || riskMetadata?.requires_approval === true;
  const riskLevel = riskClassification?.level || null;
  const mode = resolveRecoveryMode(action);
  const eligibility = buildLiveEligibilityRecord(action, riskClassification, mode);
  let hostName = null;
  let policyProof = null;
  let rollbackPlan = null;
  let approvalRecord = null;
  const finalizeRecoveryResult = (result) => {
    try {
      const { recordRecoveryMetric } = require('../../db/recovery-metrics');
      recordRecoveryMetric({
        action,
        mode,
        success: result?.success,
        risk_level: riskClassification?.level || null,
        duration_ms: result?.duration_ms,
        attempts: result?.audit_entry?.attempts ?? 1,
        error: result?.audit_entry?.error || null,
        host: hostName,
        policy_blocked: !!policyProof?.blocked,
        approval_required: approvalRequired,
        approval_granted: !!approvalRecord?.approved,
      });
    } catch {}
    fireWebhookForEvent('peek.recovery.executed', {
      action,
      mode,
      success: result?.success === true,
    }).catch(() => {});
    return result;
  };

  try {
    if (!action) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required');
    }

    if (!isPlainObject(actionParams)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'params must be a plain object');
    }

    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) {
      return resolvedHost.error;
    }
    ({ hostName } = resolvedHost);
    const { hostUrl } = resolvedHost;
    const timeoutMs = getRecoveryTimeoutMs(args);

    let allowedResult;
    try {
      allowedResult = await peekHttpPostWithRetry(
        hostUrl + RECOVERY_ALLOWED_ENDPOINT,
        { action },
        timeoutMs,
      );
    } catch (allowedError) {
      return finalizeRecoveryResult(buildRecoveryResult({
        action,
        mode,
        riskLevel,
        startedAt,
        success: false,
        error: `Allowed-action validation failed: ${allowedError.message || String(allowedError)}`,
        eligibility,
      }));
    }

    if (allowedResult.error) {
      return finalizeRecoveryResult(buildRecoveryResult({
        action,
        mode,
        riskLevel,
        startedAt,
        success: false,
        error: `Allowed-action validation failed: ${allowedResult.error}`,
        eligibility,
      }));
    }

    const { allowed, actionSpec, reason } = normalizeAllowedActionPayload(allowedResult.data, action);
    if (!allowed) {
      return finalizeRecoveryResult(buildRecoveryResult({
        action,
        mode,
        riskLevel,
        startedAt,
        success: false,
        error: reason || `Recovery action '${action}' is not allowed.`,
        eligibility,
      }));
    }

    const retryCount = extractRetryCount(args);
    if (actionSpec && retryCount > actionSpec.max_retries) {
      rollbackPlan = createRollbackPlan(action, actionParams);
      return finalizeRecoveryResult(buildRecoveryResult({
        action,
        mode,
        riskLevel,
        startedAt,
        success: false,
        error: `Retry budget exceeded for '${action}': ${retryCount} > ${actionSpec.max_retries}.`,
        rollbackPlan,
        eligibility,
      }));
    }

    rollbackPlan = createRollbackPlan(action, actionParams);

    let taskContext = null;
    try {
      taskContext = resolvePeekTaskContext(args);
    } catch (contextError) {
      logger.warn(`Recovery task context resolution failed for ${action}: ${contextError.message}`);
      taskContext = null;
    }

    const policyTaskData = buildPolicyTaskData(
      args,
      taskContext,
      action,
      mode,
      hostName,
      actionSpec,
      actionParams,
    );
    const policyEvaluation = taskHooks.evaluateAtStage(
      'task_pre_execute',
      policyTaskData,
    );
    policyProof = formatPolicyProof(policyEvaluation);

    if (policyEvaluation?.blocked && policyEvaluation.shadow !== true) {
      return finalizeRecoveryResult(buildRecoveryResult({
        action,
        mode,
        riskLevel,
        startedAt,
        success: false,
        error: 'Blocked by policy engine.',
        policyProof,
        rollbackPlan,
        eligibility,
      }));
    }

    if (approvalRequired) {
      approvalRecord = await resolveHighRiskApproval(action, args, taskContext);
      if (!approvalRecord.approved) {
        return finalizeRecoveryResult(buildRecoveryResult({
          action,
          mode,
          riskLevel,
          startedAt,
          success: false,
          error: 'High-risk action requires approval',
          policyProof,
          rollbackPlan,
          auditEntry: {
            approval: approvalRecord,
          },
          eligibility,
          blocked: approvalRecord.blocked,
          approvalRequired: approvalRecord.approval_required,
          approvalId: approvalRecord.approval_id,
        }));
      }
    }

    let shadowPrecheck = null;
    if (mode === 'canary') {
      const shadowStep = await executeRecoveryStep({
        hostUrl,
        action,
        actionParams,
        mode: 'shadow',
        timeoutMs,
        actionSpec,
      });
      shadowPrecheck = createShadowPrecheckRecord(shadowStep);

      if (!shadowStep.ok) {
        return finalizeRecoveryResult(buildRecoveryResult({
          action,
          mode,
          riskLevel,
          startedAt,
          success: false,
          attempts: shadowStep.attempts,
          error: shadowStep.error || 'Shadow execution reported unsuccessful result.',
          policyProof,
          rollbackPlan,
          auditEntry: mergeExecutionAuditEntry(
            shadowStep.auditEntry,
            approvalRecord,
            {
              mode,
              shadow_precheck: shadowPrecheck,
            },
          ),
          eligibility,
        }));
      }
    }

    const executionMode = mode === 'canary' ? 'canary' : mode;
    const executionStep = await executeRecoveryStep({
      hostUrl,
      action,
      actionParams,
      mode: executionMode,
      timeoutMs,
      actionSpec,
    });

    return finalizeRecoveryResult(buildRecoveryResult({
      action,
      mode,
      riskLevel,
      startedAt,
      success: executionStep.ok,
      attempts: executionStep.attempts,
      error: executionStep.error,
      policyProof,
      rollbackPlan,
      auditEntry: mergeExecutionAuditEntry(
        executionStep.auditEntry,
        approvalRecord,
        shadowPrecheck ? { shadow_precheck: shadowPrecheck } : null,
      ),
      eligibility,
    }));
  } catch (err) {
    logger.warn(`Recovery handler failed for ${action || 'unknown'}: ${err.message}`);
    return finalizeRecoveryResult(buildRecoveryResult({
      action,
      mode,
      riskLevel,
      startedAt,
      success: false,
      error: err.message || String(err),
      policyProof,
      rollbackPlan,
      eligibility,
    }));
  }
}

async function handlePeekRecoveryStatus(args = {}) {
  try {
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) {
      return resolvedHost.error;
    }

    const { hostUrl } = resolvedHost;
    const timeoutMs = getRecoveryTimeoutMs(args);
    const statusResult = await peekHttpGetWithRetry(hostUrl + RECOVERY_STATUS_ENDPOINT, timeoutMs);

    if (statusResult.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Recovery status failed: ${statusResult.error}`);
    }

    if (statusResult.data && typeof statusResult.data.error === 'string' && statusResult.data.error.trim()) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Recovery status failed: ${statusResult.data.error.trim()}`);
    }

    const capabilities = normalizeRecoveryCapabilities(statusResult.data);
    return {
      success: true,
      mode: resolveRecoveryMode(),
      allowed_actions: capabilities.allowed_actions,
      retry_budgets: capabilities.retry_budgets,
      stop_conditions: capabilities.stop_conditions,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function createPeekRecoveryHandlers() {
  return {
    handlePeekRecovery,
    handlePeekRecoveryStatus,
    resolveRecoveryMode,
  };
}

module.exports = {
  handlePeekRecovery,
  handlePeekRecoveryStatus,
  resolveRecoveryMode,
  createPeekRecoveryHandlers,
};
