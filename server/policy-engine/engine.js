'use strict';

const { createHash, randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'policy-engine' });
const database = require('../database');
const matchers = require('./matchers');
const profileStore = require('./profile-store');
const evaluationStore = require('./evaluation-store');
const architectureAdapter = require('./adapters/architecture');
const featureFlagAdapter = require('./adapters/feature-flag');
const refactorDebtAdapter = require('./adapters/refactor-debt');
const releaseGateAdapter = require('./adapters/release-gate');

const POLICY_STAGES = new Set([
  'task_submit',
  'task_pre_execute',
  'task_complete',
  'workflow_submit',
  'workflow_run',
  'manual_review',
]);

const POLICY_MODES = new Set(['off', 'shadow', 'advisory', 'warn', 'block']);
const POLICY_OUTCOMES = new Set(['pass', 'fail', 'skipped', 'degraded', 'overridden']);
const REFACTOR_BACKLOG_POLICY_ID = 'refactor_backlog_required_for_hotspot_worsening';
const ARCHITECTURE_BOUNDARY_POLICY_ID = 'architecture_boundary_violation';
const FEATURE_FLAG_POLICY_ID = 'feature_flag_required_for_user_visible_change';
const RELEASE_GATE_POLICY_ID = 'release_gate_required_for_production_surface';
const ARCHITECTURE_BOUNDARY_TYPES = new Set(['layer', 'module', 'package']);

function normalizeStage(stage) {
  const normalized = String(stage || '').trim();
  if (!normalized) {
    throw new Error('policy evaluation stage is required');
  }
  if (!POLICY_STAGES.has(normalized)) {
    throw new Error(`unsupported policy stage: ${normalized}`);
  }
  return normalized;
}

function normalizeMode(mode, fallback = 'advisory') {
  const normalized = String(mode || fallback).trim().toLowerCase();
  return POLICY_MODES.has(normalized) ? normalized : fallback;
}

function normalizeOutcome(outcome, fallback = 'pass') {
  const normalized = String(outcome || fallback).trim().toLowerCase();
  return POLICY_OUTCOMES.has(normalized) ? normalized : fallback;
}

function normalizeTarget(targetType, targetId) {
  const type = String(targetType || '').trim().toLowerCase();
  const id = String(targetId || '').trim();
  if (!type) throw new Error('policy evaluation target_type is required');
  if (!id) throw new Error('policy evaluation target_id is required');
  return { type, id };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableSerialize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function asBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'on', 'enabled', 'passed', 'pass'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled', 'failed', 'fail'].includes(normalized)) return false;
  }
  return null;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeBoundaryPatternList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => matchers.normalizePath(entry))
    .filter(Boolean);
}

function resolvePolicyDbHandle() {
  if (typeof database.getDbInstance === 'function') {
    return database.getDbInstance();
  }
  if (typeof database.getDb === 'function') {
    return database.getDb();
  }
  return null;
}

function normalizeArchitectureBoundarySeed(boundary = {}, defaultProject = null) {
  const id = normalizeOptionalString(boundary.id);
  const project = normalizeOptionalString(boundary.project) || normalizeOptionalString(defaultProject);
  const name = normalizeOptionalString(boundary.name);
  const boundaryType = normalizeOptionalString(boundary.boundary_type || boundary.boundaryType)?.toLowerCase();
  const sourcePatterns = normalizeBoundaryPatternList(
    boundary.source_patterns || boundary.sourcePatterns,
  );

  if (
    !id
    || !project
    || !name
    || !boundaryType
    || !ARCHITECTURE_BOUNDARY_TYPES.has(boundaryType)
    || sourcePatterns.length === 0
  ) {
    return null;
  }

  return {
    id,
    project,
    name,
    boundary_type: boundaryType,
    source_patterns: sourcePatterns,
    allowed_dependencies: normalizeBoundaryPatternList(
      boundary.allowed_dependencies || boundary.allowedDependencies,
    ),
    forbidden_dependencies: normalizeBoundaryPatternList(
      boundary.forbidden_dependencies || boundary.forbiddenDependencies,
    ),
    enabled: boundary.enabled === undefined ? 1 : (boundary.enabled ? 1 : 0),
  };
}

function seedArchitectureBoundariesFromProfile(profile, projectId) {
  const db = resolvePolicyDbHandle();
  const boundaries = Array.isArray(profile?.profile_json?.architecture_boundaries)
    ? profile.profile_json.architecture_boundaries
    : [];
  if (!db || boundaries.length === 0) {
    return;
  }

  const rows = boundaries
    .map((boundary) => normalizeArchitectureBoundarySeed(boundary, projectId || profile?.project))
    .filter(Boolean);
  if (rows.length === 0) {
    return;
  }

  const upsertBoundary = db.prepare(`
    INSERT INTO architecture_boundaries (
      id, project, name, boundary_type, source_patterns,
      allowed_dependencies, forbidden_dependencies, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      name = excluded.name,
      boundary_type = excluded.boundary_type,
      source_patterns = excluded.source_patterns,
      allowed_dependencies = excluded.allowed_dependencies,
      forbidden_dependencies = excluded.forbidden_dependencies,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `);

  db.transaction((entries) => {
    for (const entry of entries) {
      upsertBoundary.run(
        entry.id,
        entry.project,
        entry.name,
        entry.boundary_type,
        JSON.stringify(entry.source_patterns),
        JSON.stringify(entry.allowed_dependencies),
        JSON.stringify(entry.forbidden_dependencies),
        entry.enabled,
      );
    }
  })(rows);
}

function getNestedValue(source, path) {
  if (!source) return undefined;
  let current = source;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function resolveEvidenceCandidate(context, paths) {
  for (const path of paths) {
    const value = getNestedValue(context, path);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function isNormalizedEvidenceResult(value) {
  return isPlainObject(value)
    && (
      Object.prototype.hasOwnProperty.call(value, 'available')
      || Object.prototype.hasOwnProperty.call(value, 'satisfied')
      || Object.prototype.hasOwnProperty.call(value, 'value')
    );
}

function normalizeEvidenceResult(type, value) {
  const normalizedType = String(value?.type || type || 'unknown').trim() || type || 'unknown';
  const available = value?.available === undefined ? true : Boolean(value.available);
  let satisfied = value?.satisfied;

  if (satisfied === undefined) {
    if (available === false) {
      satisfied = null;
    } else {
      const normalizedBoolean = asBoolean(value?.value);
      satisfied = normalizedBoolean === null ? Boolean(value?.value) : normalizedBoolean;
    }
  }

  return {
    type: normalizedType,
    available,
    satisfied: satisfied === undefined ? null : satisfied,
    value: Object.prototype.hasOwnProperty.call(value || {}, 'value') ? value.value : undefined,
  };
}

function resolveEvidenceRequirement(requirement, context = {}) {
  const normalizedRequirement = typeof requirement === 'string'
    ? { type: requirement }
    : (requirement || {});
  const type = String(normalizedRequirement.type || '').trim();
  if (!type) {
    return {
      type: 'unknown',
      available: false,
      satisfied: null,
      value: undefined,
    };
  }

  const evidencePaths = {
    command_profile_valid: [
      ['evidence', 'command_profile_valid'],
      ['command_profile_valid'],
      ['command_validation', 'allowed'],
    ],
    verify_command_passed: [
      ['evidence', 'verify_command_passed'],
      ['verify_command_passed'],
      ['verify', 'passed'],
      ['verification', 'passed'],
    ],
    test_command_passed: [
      ['evidence', 'test_command_passed'],
      ['test_command_passed'],
      ['test', 'passed'],
      ['tests', 'passed'],
    ],
    build_command_passed: [
      ['evidence', 'build_command_passed'],
      ['build_command_passed'],
      ['build', 'passed'],
    ],
    approval_recorded: [
      ['evidence', 'approval_recorded'],
      ['approval_recorded'],
      ['approval', 'approved'],
      ['review', 'approved'],
    ],
    override_recorded: [
      ['evidence', 'override_recorded'],
      ['override_recorded'],
      ['override', 'recorded'],
    ],
    changed_files_classified: [
      ['evidence', 'changed_files_classified'],
      ['changed_files_classified'],
      ['changed_files'],
    ],
    migration_present: [
      ['evidence', 'migration_present'],
      ['migration_present'],
      ['migration', 'present'],
    ],
    docs_updated: [
      ['evidence', 'docs_updated'],
      ['docs_updated'],
      ['docs', 'updated'],
    ],
    artifact_generated: [
      ['evidence', 'artifact_generated'],
      ['artifact_generated'],
      ['artifacts', 'generated'],
    ],
    provider_allowed: [
      ['evidence', 'provider_allowed'],
      ['provider_allowed'],
      ['provider', 'allowed'],
    ],
    rollout_note_present: [
      ['evidence', 'rollout_note_present'],
      ['rollout_note_present'],
    ],
    feature_flag_present: [
      ['evidence', 'feature_flag_present'],
      ['feature_flag_present'],
    ],
  };

  const value = resolveEvidenceCandidate(
    context,
    evidencePaths[type] || [
      ['evidence', type],
      [type],
    ],
  );
  if (value === undefined) {
    return {
      type,
      available: false,
      satisfied: null,
      value: undefined,
    };
  }

  if (isNormalizedEvidenceResult(value)) {
    return normalizeEvidenceResult(type, value);
  }

  if (type === 'changed_files_classified') {
    const changedFiles = matchers.extractChangedFiles({ changed_files: value });
    return {
      type,
      available: true,
      satisfied: Array.isArray(changedFiles),
      value: changedFiles,
    };
  }

  const normalizedBoolean = asBoolean(value);
  return {
    type,
    available: true,
    satisfied: normalizedBoolean === null ? Boolean(value) : normalizedBoolean,
    value,
  };
}

function recordPolicyEvidence(evidence, policyId, value, satisfied) {
  evidence[policyId] = {
    type: policyId,
    available: true,
    satisfied,
    value,
  };
}

function recordUnavailablePolicyEvidence(evidence, policyId, error) {
  evidence[policyId] = {
    type: policyId,
    available: false,
    satisfied: null,
    value: {
      reason: error?.message || String(error || 'unknown policy evidence error'),
    },
  };
}

function collectActivePolicyEvidence(context, effectiveRules = [], profile = null) {
  const evidence = isPlainObject(context.evidence) ? { ...context.evidence } : {};
  const activePolicyIds = new Set(
    effectiveRules
      .map((rule) => String(rule?.id || rule?.policy_id || '').trim())
      .filter(Boolean),
  );
  const hasRefactorBacklogPolicy = activePolicyIds.has(REFACTOR_BACKLOG_POLICY_ID);
  const hasArchitectureBoundaryPolicy = activePolicyIds.has(ARCHITECTURE_BOUNDARY_POLICY_ID);
  const hasFeatureFlagPolicy = activePolicyIds.has(FEATURE_FLAG_POLICY_ID);
  const hasReleaseGatePolicy = activePolicyIds.has(RELEASE_GATE_POLICY_ID);

  if (
    !hasRefactorBacklogPolicy
    && !hasArchitectureBoundaryPolicy
    && !hasFeatureFlagPolicy
    && !hasReleaseGatePolicy
  ) {
    return {
      ...context,
      evidence,
    };
  }

  if (context.stage === 'task_complete') {
    if (hasRefactorBacklogPolicy) {
      try {
        const refactorEvidence = refactorDebtAdapter.collectEvidence(
          {
            ...context,
            id: context.target_id,
            task_id: context.target_id,
            project: context.project_id || context.project || null,
          },
          context.changed_files,
        );
        const hasViolation = Array.isArray(refactorEvidence.hotspots_worsened)
          && refactorEvidence.hotspots_worsened.length > 0
          && refactorEvidence.has_backlog_item === false;

        evidence.hotspots_worsened = refactorEvidence.hotspots_worsened;
        evidence.has_backlog_item = refactorEvidence.has_backlog_item;
        evidence.files_checked = refactorEvidence.files_checked;
        recordPolicyEvidence(
          evidence,
          REFACTOR_BACKLOG_POLICY_ID,
          refactorEvidence,
          !hasViolation,
        );
      } catch (error) {
        recordUnavailablePolicyEvidence(evidence, REFACTOR_BACKLOG_POLICY_ID, error);
      }
    }

    if (hasArchitectureBoundaryPolicy) {
      try {
        seedArchitectureBoundariesFromProfile(profile, context.project_id || context.project || null);

        const architectureEvidence = architectureAdapter.collectEvidence(
          {
            ...context,
            id: context.target_id,
            task_id: context.target_id,
            project: context.project_id || context.project || null,
            working_directory: context.project_path || context.working_directory || context.workingDirectory || null,
          },
          context.changed_files,
        );
        const hasViolation = Array.isArray(architectureEvidence.violations)
          && architectureEvidence.violations.length > 0;

        evidence.violations = architectureEvidence.violations;
        evidence.boundaries_checked = architectureEvidence.boundaries_checked;
        evidence.files_scanned = architectureEvidence.files_scanned;
        recordPolicyEvidence(
          evidence,
          ARCHITECTURE_BOUNDARY_POLICY_ID,
          architectureEvidence,
          !hasViolation,
        );
      } catch (error) {
        recordUnavailablePolicyEvidence(evidence, ARCHITECTURE_BOUNDARY_POLICY_ID, error);
      }
    }

    if (hasFeatureFlagPolicy) {
      try {
        const featureFlagEvidence = featureFlagAdapter.collectEvidence(
          {
            ...context,
            id: context.target_id,
            task_id: context.target_id,
            project: context.project_id || context.project || null,
            working_directory: context.project_path || context.working_directory || context.workingDirectory || null,
          },
          context.changed_files,
        );
        const hasViolation = Array.isArray(featureFlagEvidence.user_visible_changes)
          && featureFlagEvidence.user_visible_changes.length > 0
          && featureFlagEvidence.has_feature_flag === false;

        evidence.user_visible_changes = featureFlagEvidence.user_visible_changes;
        evidence.feature_flags_found = featureFlagEvidence.feature_flags_found;
        evidence.has_feature_flag = featureFlagEvidence.has_feature_flag;
        recordPolicyEvidence(
          evidence,
          FEATURE_FLAG_POLICY_ID,
          featureFlagEvidence,
          !hasViolation,
        );
      } catch (error) {
        recordUnavailablePolicyEvidence(evidence, FEATURE_FLAG_POLICY_ID, error);
      }
    }
  }

  if (context.stage === 'manual_review' && hasReleaseGatePolicy) {
    try {
      const releaseId = normalizeOptionalString(
        context.release_id
          || context.releaseId
          || context.target_id
          || context.targetId,
      );
      if (!releaseId) {
        throw new Error('release_id is required for release gate evaluation');
      }

      const releaseGateEvidence = releaseGateAdapter.evaluateGates(
        releaseId,
        context.project_id || context.project || null,
      );

      evidence.gates = releaseGateEvidence.gates;
      evidence.all_passed = releaseGateEvidence.all_passed;
      evidence.blocking_gates = releaseGateEvidence.blocking_gates;
      recordPolicyEvidence(
        evidence,
        RELEASE_GATE_POLICY_ID,
        releaseGateEvidence,
        releaseGateEvidence.all_passed === true,
      );
    } catch (error) {
      recordUnavailablePolicyEvidence(evidence, RELEASE_GATE_POLICY_ID, error);
    }
  }

  return {
    ...context,
    evidence,
  };
}

function deriveSeverity(rule, outcome, mode) {
  if (outcome === 'pass' || outcome === 'skipped') {
    return null;
  }

  const actionSeverity = Array.isArray(rule.actions)
    ? rule.actions.find((action) => action && typeof action === 'object' && action.severity)?.severity
    : null;
  if (actionSeverity) {
    return String(actionSeverity).trim().toLowerCase();
  }

  if (outcome === 'degraded') return 'warning';
  if (mode === 'block') return 'error';
  if (mode === 'warn' || mode === 'advisory') return 'warning';
  return 'info';
}

function isFindingOutcome(outcome) {
  return !['pass', 'skipped'].includes(normalizeOutcome(outcome));
}

function normalizeRequirementSnapshot(requirements = []) {
  return Array.isArray(requirements)
    ? requirements.map((result) => ({
        type: result?.type || 'unknown',
        available: result?.available ?? false,
        satisfied: result?.satisfied ?? null,
      }))
    : [];
}

function computeScopeFingerprint(rule, context, matcherResult) {
  return hashObject({
    stage: context.stage,
    target_type: context.target_type,
    target_id: context.target_id,
    project_id: context.project_id || null,
    project_path: matchers.extractProjectPath(context),
    provider: matchers.extractProvider(context),
    matcher: rule.matcher || {},
    matched_files: matcherResult?.matched_files || [],
    excluded_files: matcherResult?.excluded_files || [],
  });
}

function computeFindingFingerprint({ rule, outcome, mode, severity, message, evidence, overrideAllowed }) {
  return hashObject({
    policy_id: rule.id,
    outcome: normalizeOutcome(outcome, outcome),
    mode: normalizeMode(mode, mode),
    severity: severity || null,
    message: message || null,
    override_allowed: Boolean(overrideAllowed),
    requirements: normalizeRequirementSnapshot(evidence?.requirements),
  });
}

function buildEvidenceSnapshot(context, matcherResult, requirementResults) {
  return {
    changed_files: matchers.extractChangedFiles(context) || [],
    matched_files: matcherResult?.matched_files || [],
    excluded_files: matcherResult?.excluded_files || [],
    provider: matchers.extractProvider(context),
    project_path: matchers.extractProjectPath(context),
    requirements: requirementResults.map((result) => ({
      type: result.type,
      available: result.available,
      satisfied: result.satisfied,
      value: result.value,
    })),
  };
}

function resolveSuppressionState({
  rule,
  context,
  outcome,
  mode,
  severity,
  message,
  evidence,
  overrideAllowed,
  scopeFingerprint,
  persist,
  forceRescan,
}) {
  if (!persist || forceRescan || !scopeFingerprint || !isFindingOutcome(outcome)) {
    return {
      suppressed: false,
      suppression_reason: null,
      replay_of_evaluation_id: null,
    };
  }

  const previousEvaluation = evaluationStore.getLatestPolicyEvaluationForScope({
    policy_id: rule.id,
    stage: context.stage,
    target_type: context.target_type,
    target_id: context.target_id,
    scope_fingerprint: scopeFingerprint,
  });

  if (!previousEvaluation) {
    return {
      suppressed: false,
      suppression_reason: null,
      replay_of_evaluation_id: null,
    };
  }

  const currentFindingFingerprint = computeFindingFingerprint({
    rule,
    outcome,
    mode,
    severity,
    message,
    evidence,
    overrideAllowed,
  });
  const previousFindingFingerprint = computeFindingFingerprint({
    rule,
    outcome: previousEvaluation.outcome,
    mode: previousEvaluation.mode,
    severity: previousEvaluation.severity,
    message: previousEvaluation.message,
    evidence: previousEvaluation.evidence,
    overrideAllowed: previousEvaluation.override_allowed,
  });

  if (currentFindingFingerprint !== previousFindingFingerprint) {
    return {
      suppressed: false,
      suppression_reason: null,
      replay_of_evaluation_id: null,
    };
  }

  return {
    suppressed: true,
    suppression_reason: 'unchanged_scope_replay',
    replay_of_evaluation_id: previousEvaluation.id,
  };
}

function summarizePolicyResults(results) {
  const summary = {
    passed: 0,
    failed: 0,
    warned: 0,
    blocked: 0,
    degraded: 0,
    skipped: 0,
    overridden: 0,
    suppressed: 0,
  };

  for (const result of results) {
    if (result.outcome === 'pass') summary.passed += 1;
    if (result.outcome === 'fail') summary.failed += 1;
    if (result.outcome === 'degraded') summary.degraded += 1;
    if (result.outcome === 'skipped') summary.skipped += 1;
    if (result.outcome === 'overridden') summary.overridden += 1;
    if (result.outcome === 'fail' && (result.mode === 'warn' || result.mode === 'advisory')) {
      summary.warned += 1;
    }
    if (result.outcome === 'fail' && result.mode === 'block') {
      summary.blocked += 1;
    }
  }

  return summary;
}

function resolveResultMessage({ matcherResult, unavailableRequirements, failedRequirements, mode }) {
  if (matcherResult?.state === 'degraded') {
    return matcherResult.reason || 'required matcher context is unavailable';
  }
  if (matcherResult?.state === 'no_match') {
    return matcherResult.reason || 'policy matcher did not apply to this target';
  }
  if (mode === 'off') {
    return 'policy mode is off';
  }
  if (unavailableRequirements.length > 0) {
    return `required evidence unavailable: ${unavailableRequirements.map((entry) => entry.type).join(', ')}`;
  }
  if (failedRequirements.length > 0) {
    return `required evidence failed: ${failedRequirements.map((entry) => entry.type).join(', ')}`;
  }
  return 'policy requirements satisfied';
}

function resolveOverrideMap(input = {}) {
  const map = new Map();
  const rawOverrides = input.override_decisions || input.overrideDecisions || [];
  const entries = Array.isArray(rawOverrides) ? rawOverrides : Object.values(rawOverrides || {});

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.policy_id || typeof entry.policy_id !== 'string') continue;
    map.set(entry.policy_id, entry);
  }

  return map;
}

function evaluateSinglePolicy(rule, context, options = {}) {
  const matcherResult = matchers.evaluateMatcher(rule.matcher, context);
  const requirementResults = Array.isArray(rule.required_evidence)
    ? rule.required_evidence.map((requirement) => resolveEvidenceRequirement(requirement, context))
    : [];
  const unavailableRequirements = requirementResults.filter((result) => result.available === false);
  const failedRequirements = requirementResults.filter((result) => result.available === true && result.satisfied === false);

  let outcome = 'pass';
  if (rule.mode === 'off') {
    outcome = 'skipped';
  } else if (matcherResult.state === 'degraded') {
    outcome = 'degraded';
  } else if (matcherResult.state === 'no_match') {
    outcome = 'skipped';
  } else if (unavailableRequirements.length > 0) {
    outcome = 'degraded';
  } else if (failedRequirements.length > 0) {
    outcome = 'fail';
  }

  const message = resolveResultMessage({
    matcherResult,
    unavailableRequirements,
    failedRequirements,
    mode: rule.mode,
  });
  const severity = deriveSeverity(rule, outcome, rule.mode);
  const evidence = buildEvidenceSnapshot(context, matcherResult, requirementResults);
  const overrideAllowed = Boolean(rule.override_policy?.allowed);
  const scopeFingerprint = computeScopeFingerprint(rule, context, matcherResult);
  const suppression = resolveSuppressionState({
    rule,
    context,
    outcome,
    mode: rule.mode,
    severity,
    message,
    evidence,
    overrideAllowed,
    scopeFingerprint,
    persist: options.persist !== false,
    forceRescan: options.force_rescan === true,
  });

  const evaluationPayload = {
    batch_id: options.batch_id,
    policy_id: rule.id,
    profile_id: rule.profile_id || null,
    binding_id: rule.binding_id || null,
    target: {
      type: context.target_type,
      id: context.target_id,
    },
    matcher: matcherResult,
    mode: rule.mode,
    override_policy: rule.override_policy || {},
    scope_fingerprint: scopeFingerprint,
    suppressed: suppression.suppressed,
    replay_of_evaluation_id: suppression.replay_of_evaluation_id,
    message,
    evaluated_at: options.evaluated_at,
  };

  const persisted = options.persist === false
    ? {
        id: null,
        policy_id: rule.id,
        profile_id: rule.profile_id || null,
        stage: context.stage,
        target_type: context.target_type,
        target_id: context.target_id,
        project: context.project_id || null,
        mode: rule.mode,
        outcome,
        severity,
        message,
        evidence,
        evaluation: evaluationPayload,
        override_allowed: overrideAllowed,
        scope_fingerprint: scopeFingerprint,
        replay_of_evaluation_id: suppression.replay_of_evaluation_id,
        suppressed: suppression.suppressed,
        suppression_reason: suppression.suppression_reason,
        created_at: options.evaluated_at,
      }
    : evaluationStore.createPolicyEvaluation({
        policy_id: rule.id,
        profile_id: rule.profile_id || null,
        stage: context.stage,
        target_type: context.target_type,
        target_id: context.target_id,
        project: context.project_id || null,
        mode: rule.mode,
        outcome,
        severity,
        message,
        evidence,
        evaluation: evaluationPayload,
        override_allowed: overrideAllowed,
        scope_fingerprint: scopeFingerprint,
        replay_of_evaluation_id: suppression.replay_of_evaluation_id,
        suppressed: suppression.suppressed,
        suppression_reason: suppression.suppression_reason,
        created_at: options.evaluated_at,
      });

  return {
    evaluation_id: persisted.id,
    policy_id: rule.id,
    profile_id: rule.profile_id || null,
    outcome: normalizeOutcome(persisted.outcome || outcome, outcome),
    mode: normalizeMode(persisted.mode || rule.mode, rule.mode),
    severity: persisted.severity || severity,
    message: persisted.message || message,
    evidence: persisted.evidence || evidence,
    override_allowed: persisted.override_allowed ?? overrideAllowed,
    scope_fingerprint: persisted.scope_fingerprint || scopeFingerprint,
    replay_of_evaluation_id: persisted.replay_of_evaluation_id || suppression.replay_of_evaluation_id,
    suppressed: persisted.suppressed ?? suppression.suppressed,
    suppression_reason: persisted.suppression_reason || suppression.suppression_reason,
    created_at: persisted.created_at || options.evaluated_at,
  };
}

function evaluatePolicies(input = {}) {
  const stage = normalizeStage(input.stage);
  const target = normalizeTarget(input.target_type || input.targetType, input.target_id || input.targetId);
  const evaluatedAt = input.evaluated_at || new Date().toISOString();
  const evaluationBatchId = input.evaluation_id || input.evaluationId || randomUUID();
  const forceRescan = input.force_rescan === true || input.forceRescan === true;
  const profile = profileStore.resolvePolicyProfile({
    profile_id: input.profile_id || input.profileId,
    project_id: input.project_id || input.projectId,
    project_path: input.project_path || input.projectPath || input.working_directory || input.workingDirectory,
    provider: input.provider,
    changed_files: input.changed_files || input.changedFiles,
    target_type: target.type,
  });

  const context = {
    ...input,
    stage,
    target_type: target.type,
    target_id: target.id,
    project_id: input.project_id || input.projectId || input.project || null,
    project_path: input.project_path || input.projectPath || input.working_directory || input.workingDirectory || null,
    changed_files: input.changed_files || input.changedFiles || null,
    provider: input.provider || null,
  };

  const effectiveRules = profileStore.resolvePoliciesForStage({
    stage,
    profile,
    project_id: context.project_id,
    project_path: context.project_path,
    provider: context.provider,
    changed_files: context.changed_files,
    target_type: target.type,
  });
  const evaluationContext = collectActivePolicyEvidence(context, effectiveRules, profile);

  const overrideMap = resolveOverrideMap(input);
  const allResults = [];
  const results = [];
  const suppressedResults = [];

  for (const rule of effectiveRules) {
    const hasOverride = overrideMap.has(rule.id);
    const result = evaluateSinglePolicy(rule, evaluationContext, {
      batch_id: evaluationBatchId,
      evaluated_at: evaluatedAt,
      persist: input.persist !== false,
      force_rescan: forceRescan || hasOverride,
    });

    const override = overrideMap.get(rule.id);
    if (override && result.evaluation_id) {
      const overrideResult = evaluationStore.createPolicyOverride({
        evaluation_id: result.evaluation_id,
        policy_id: rule.id,
        decision: override.decision || 'override',
        reason_code: override.reason_code || override.reasonCode,
        notes: override.notes || null,
        actor: override.actor || null,
        expires_at: override.expires_at || override.expiresAt || null,
      });
      const updatedEvaluation = overrideResult.evaluation;
      result.outcome = updatedEvaluation.outcome;
      result.message = updatedEvaluation.message;
      result.evidence = updatedEvaluation.evidence || result.evidence;
    }

    allResults.push(result);
    if (result.suppressed) {
      suppressedResults.push(result);
    } else {
      results.push(result);
    }
  }

  const summary = summarizePolicyResults(results);
  summary.suppressed = suppressedResults.length;
  logger.debug(`[Policy] Evaluated ${allResults.length} rule(s) for ${stage}:${target.type}:${target.id}`);

  return {
    evaluation_id: evaluationBatchId,
    stage,
    target,
    profile_id: profile?.id || null,
    summary,
    results,
    suppressed_results: suppressedResults,
    total_results: allResults.length,
    created_at: evaluatedAt,
  };
}

module.exports = {
  evaluatePolicies,
  summarizePolicyResults,
};
