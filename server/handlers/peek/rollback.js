'use strict';

function normalizeActionName(action) {
  return typeof action === 'string' ? action.trim() : '';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  return isPlainObject(value) ? { ...value } : null;
}

function cloneArray(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
    .filter(Boolean);
}

function resolveDeletedEntries(params = {}) {
  const listCandidates = [
    params.deleted_entries,
    params.deletedEntries,
    params.deleted_paths,
    params.deletedPaths,
    params.cache_entries,
    params.cacheEntries,
    params.files,
  ];

  for (const candidate of listCandidates) {
    const entries = cloneArray(candidate);
    if (entries.length > 0) {
      return entries;
    }
  }

  const directory = normalizeOptionalString(params.directory || params.path || params.cache_path || params.cachePath);
  return directory ? [directory] : [];
}

function resolveOriginalWindowPosition(params = {}) {
  const objectCandidates = [
    params.original_position,
    params.originalPosition,
    params.previous_position,
    params.previousPosition,
  ];

  for (const candidate of objectCandidates) {
    const snapshot = clonePlainObject(candidate);
    if (snapshot) {
      return snapshot;
    }
  }

  const scalarSnapshot = {};
  const scalarFields = ['x', 'y', 'width', 'height', 'left', 'top', 'right', 'bottom'];
  for (const field of scalarFields) {
    if (Number.isFinite(params[field])) {
      scalarSnapshot[field] = params[field];
    }
  }

  return Object.keys(scalarSnapshot).length > 0 ? scalarSnapshot : null;
}

function resolveThreadState(params = {}) {
  const stateCandidate = clonePlainObject(params.thread_state || params.threadState || params.state || params.snapshot);
  if (stateCandidate) {
    return stateCandidate;
  }

  const state = normalizeOptionalString(params.state_name || params.stateName || params.thread_status || params.threadStatus);
  return state ? { state } : null;
}

function buildNoopPlan(action, description, impact, extra = {}) {
  return {
    action,
    rollback_steps: [{
      step: 'noop',
      description,
      ...extra,
    }],
    can_rollback: false,
    estimated_impact: impact,
  };
}

const RISK_LEVEL_REQUIRED_EVIDENCE = Object.freeze({
  low: Object.freeze(['screenshot_before']),
  medium: Object.freeze(['screenshot_before', 'screenshot_after']),
  high: Object.freeze(['screenshot_before', 'screenshot_after', 'user_confirmation']),
});

const ACTION_RISK_LEVELS = Object.freeze({
  click: 'low',
  type: 'low',
  scroll: 'low',
  focus_window: 'medium',
  close_window: 'high',
  send_keys: 'medium',
  restart_process: 'medium',
  clear_temp_cache: 'low',
  reset_window_position: 'low',
  close_dialog: 'low',
  kill_hung_thread: 'high',
  force_kill_process: 'high',
  modify_registry_key: 'high',
  inject_accessibility_hook: 'high',
});

const ACTION_RISK_FLAGS = Object.freeze({
  force_kill_process: Object.freeze({
    requires_approval: true,
    approval_required: true,
    shadow_only: true,
    verification_callback: 'verify_process_killed',
    rollback_plan: 'Restart process from saved state',
  }),
  modify_registry_key: Object.freeze({
    requires_approval: true,
    approval_required: true,
    shadow_only: true,
    verification_callback: 'verify_registry_restored',
    rollback_plan: 'Restore registry key from backup',
  }),
  inject_accessibility_hook: Object.freeze({
    requires_approval: true,
    approval_required: true,
    shadow_only: true,
    verification_callback: 'verify_hook_injected',
    rollback_plan: 'Remove injected hook and restore original state',
  }),
});

const HIGH_RISK_VALIDATION_EVIDENCE = Object.freeze({
  force_kill_process: Object.freeze(['process_name', 'pid', 'kill_reason']),
  modify_registry_key: Object.freeze(['registry_path', 'original_value', 'new_value']),
  inject_accessibility_hook: Object.freeze(['target_process', 'hook_type', 'injection_method']),
});

function createRiskEvidence(level) {
  return RISK_LEVEL_REQUIRED_EVIDENCE[level] || RISK_LEVEL_REQUIRED_EVIDENCE.high;
}

function createRiskClassification(level, extra = null) {
  const classification = {
    level,
    requiredEvidence: createRiskEvidence(level),
  };

  if (isPlainObject(extra)) {
    Object.assign(classification, extra);
  }

  return Object.freeze(classification);
}

const RISK_CLASSIFICATION = Object.freeze(
  Object.fromEntries(
    Object.entries(ACTION_RISK_LEVELS).map(([action, level]) => [
      action,
      createRiskClassification(level, ACTION_RISK_FLAGS[action] || null),
    ]),
  ),
);

const CLASSIFIED_ACTION_RISK = Object.freeze(
  Object.fromEntries(
    Object.entries(RISK_CLASSIFICATION).map(([action, classification]) => [
      action,
      createRiskClassification(classification.level),
    ]),
  ),
);

const UNKNOWN_ACTION_RISK = createRiskClassification('high');

function classifyActionRisk(action) {
  const normalizedAction = normalizeActionName(action);
  return CLASSIFIED_ACTION_RISK[normalizedAction] || UNKNOWN_ACTION_RISK;
}

function resolveEvidenceFieldValue(params, field) {
  if (!isPlainObject(params)) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(params, field)) {
    return params[field];
  }

  const camelCaseField = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  return params[camelCaseField];
}

function hasSufficientEvidenceValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isPlainObject(value)) {
    return Object.keys(value).length > 0;
  }

  return true;
}

function validateHighRiskEvidence(action, params = {}) {
  const normalizedAction = normalizeActionName(action);
  const classification = classifyActionRisk(action);
  const requiredEvidence = Array.isArray(HIGH_RISK_VALIDATION_EVIDENCE[normalizedAction])
    ? HIGH_RISK_VALIDATION_EVIDENCE[normalizedAction]
    : Array.isArray(classification.requiredEvidence)
      ? classification.requiredEvidence
    : [];
  const missing = requiredEvidence.filter(
    (field) => !hasSufficientEvidenceValue(resolveEvidenceFieldValue(params, field)),
  );

  return {
    sufficient: missing.length === 0,
    missing,
  };
}

function createRollbackPlan(action, params = {}) {
  const normalizedAction = normalizeActionName(action);
  const actionParams = isPlainObject(params) ? params : {};

  switch (normalizedAction) {
    case 'restart_process':
      return buildNoopPlan(
        normalizedAction,
        'Process restarts cannot be rolled back after execution.',
        'medium',
        {
          process_name: normalizeOptionalString(
            actionParams.process_name || actionParams.processName || actionParams.name,
          ),
        },
      );

    case 'clear_temp_cache':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'log_deleted_entries',
          description: 'Record deleted cache entries for operator review.',
          deleted_entries: resolveDeletedEntries(actionParams),
        }],
        can_rollback: false,
        estimated_impact: 'medium',
      };

    case 'reset_window_position':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'restore_window_position',
          description: 'Restore the original window position captured before recovery.',
          window: normalizeOptionalString(
            actionParams.window_title || actionParams.windowTitle || actionParams.title,
          ),
          original_position: resolveOriginalWindowPosition(actionParams),
        }],
        can_rollback: true,
        estimated_impact: 'low',
      };

    case 'close_dialog':
      return buildNoopPlan(
        normalizedAction,
        'Closed dialogs are not reopened automatically.',
        'low',
        {
          dialog: normalizeOptionalString(
            actionParams.dialog_title || actionParams.dialogTitle || actionParams.title,
          ),
        },
      );

    case 'kill_hung_thread':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'log_thread_state',
          description: 'Capture the terminated thread context for postmortem analysis.',
          thread_id: normalizeOptionalString(
            actionParams.thread_id || actionParams.threadId || actionParams.id,
          ),
          thread_state: resolveThreadState(actionParams),
        }],
        can_rollback: false,
        estimated_impact: 'high',
      };

    case 'force_kill_process':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'log_process_termination',
          description: 'Record terminated process details for operator review and potential restart.',
          process_name: normalizeOptionalString(actionParams.process_name || actionParams.processName),
          pid: normalizeNonNegativeInteger(actionParams.pid, null),
          kill_reason: normalizeOptionalString(actionParams.kill_reason || actionParams.killReason),
        }],
        can_rollback: false,
        estimated_impact: 'high',
        rollback_plan: ACTION_RISK_FLAGS.force_kill_process.rollback_plan,
        verification_callback: ACTION_RISK_FLAGS.force_kill_process.verification_callback,
      };

    case 'modify_registry_key':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'restore_registry_value',
          description: 'Restore the original registry value before modification.',
          registry_path: normalizeOptionalString(actionParams.registry_path || actionParams.registryPath),
          original_value: actionParams.original_value ?? actionParams.originalValue ?? null,
          new_value: actionParams.new_value ?? actionParams.newValue ?? null,
        }],
        can_rollback: true,
        estimated_impact: 'high',
        rollback_plan: ACTION_RISK_FLAGS.modify_registry_key.rollback_plan,
        verification_callback: ACTION_RISK_FLAGS.modify_registry_key.verification_callback,
      };

    case 'inject_accessibility_hook':
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'remove_accessibility_hook',
          description: 'Remove the injected accessibility hook from the target process.',
          target_process: normalizeOptionalString(actionParams.target_process || actionParams.targetProcess),
          hook_type: normalizeOptionalString(actionParams.hook_type || actionParams.hookType),
          injection_method: normalizeOptionalString(actionParams.injection_method || actionParams.injectionMethod),
        }],
        can_rollback: true,
        estimated_impact: 'high',
        rollback_plan: ACTION_RISK_FLAGS.inject_accessibility_hook.rollback_plan,
        verification_callback: ACTION_RISK_FLAGS.inject_accessibility_hook.verification_callback,
      };

    default:
      return {
        action: normalizedAction,
        rollback_steps: [{
          step: 'log_manual_follow_up',
          description: 'No predefined rollback plan exists for this recovery action.',
        }],
        can_rollback: false,
        estimated_impact: 'medium',
      };
  }
}

function attachRollbackData(auditEntry, rollbackPlan) {
  const entry = isPlainObject(auditEntry) ? { ...auditEntry } : {};
  entry.rollback_plan = rollbackPlan ?? entry.rollback_plan ?? null;
  return entry;
}

function countPassingResults(results) {
  return results.filter((result) => result.outcome === 'pass').length;
}

function countFailingResults(results) {
  return results.filter((result) => result.outcome === 'fail').length;
}

function countWarnedResults(results) {
  return results.filter((result) => result.outcome === 'fail' && ['warn', 'advisory'].includes(result.mode)).length;
}

function countBlockedResults(results) {
  return results.filter((result) => result.outcome === 'fail' && result.mode === 'block').length;
}

function normalizeDetail(result) {
  return {
    policy_id: normalizeOptionalString(result.policy_id) || 'unknown',
    result: normalizeOptionalString(result.outcome) || 'unknown',
    evidence: Object.prototype.hasOwnProperty.call(result, 'evidence') ? result.evidence : null,
  };
}

function formatPolicyProof(evaluationResult) {
  const rawResult = isPlainObject(evaluationResult) ? evaluationResult : {};
  const visibleResults = Array.isArray(rawResult.results)
    ? rawResult.results.filter(isPlainObject)
    : [];
  const suppressedResults = Array.isArray(rawResult.suppressed_results)
    ? rawResult.suppressed_results.filter(isPlainObject)
    : [];
  const allResults = [...visibleResults, ...suppressedResults];
  const summary = isPlainObject(rawResult.summary) ? rawResult.summary : {};
  const mode = rawResult.shadow === true
    ? 'shadow'
    : allResults.some((result) => result.mode === 'block')
      ? 'block'
      : 'advisory';

  return {
    evaluated_at: normalizeOptionalString(rawResult.created_at || rawResult.evaluated_at) || new Date().toISOString(),
    policies_checked: normalizeNonNegativeInteger(rawResult.total_results, allResults.length),
    passed: normalizeNonNegativeInteger(summary.passed, countPassingResults(allResults)),
    warned: normalizeNonNegativeInteger(summary.warned, countWarnedResults(allResults)),
    failed: normalizeNonNegativeInteger(summary.failed, countFailingResults(allResults)),
    blocked: normalizeNonNegativeInteger(summary.blocked, countBlockedResults(allResults)),
    mode,
    details: allResults.map((result) => normalizeDetail(result)),
  };
}

module.exports = {
  normalizeActionName,
  normalizeOptionalString,
  normalizeNonNegativeInteger,
  isPlainObject,
  clonePlainObject,
  cloneArray,
  resolveDeletedEntries,
  resolveOriginalWindowPosition,
  resolveThreadState,
  buildNoopPlan,
  RISK_CLASSIFICATION,
  classifyActionRisk,
  validateHighRiskEvidence,
  createRollbackPlan,
  attachRollbackData,
  countPassingResults,
  countFailingResults,
  formatPolicyProof,
};
