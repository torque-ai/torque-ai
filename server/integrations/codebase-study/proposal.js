'use strict';

const path = require('path');
const { randomUUID } = require('crypto');

const SIGNIFICANCE_ORDER = ['none', 'baseline', 'low', 'moderate', 'high', 'critical'];
const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL = 'moderate';
const DEFAULT_PROPOSAL_MIN_SCORE = 0;
const MAX_EXISTING_PROPOSAL_SCAN = 500;
const SIGNIFICANCE_REASON_LIMIT = 4;
const DEFAULT_PROPOSAL_LIMIT = 2;
const MAX_PROPOSAL_LIMIT = 5;
const STUDY_PROPOSAL_RULE_NAME = 'Study proposal review';
const STUDY_PROPOSAL_RULE_TYPE = 'all';

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function toRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = toRepoPath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizePositiveInteger(value, fallback = 1, maxValue = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, maxValue);
}

function normalizeStudyThresholdLevel(value, fallback = DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL) {
  const normalized = String(value || '').trim().toLowerCase();
  return SIGNIFICANCE_ORDER.includes(normalized) ? normalized : fallback;
}

function compareStudySignificanceLevels(left, right) {
  return SIGNIFICANCE_ORDER.indexOf(normalizeStudyThresholdLevel(left, 'none'))
    - SIGNIFICANCE_ORDER.indexOf(normalizeStudyThresholdLevel(right, 'none'));
}

function normalizeStudyDelta(studyDelta) {
  if (!studyDelta || typeof studyDelta !== 'object') {
    return null;
  }

  return {
    ...studyDelta,
    significance: studyDelta.significance && typeof studyDelta.significance === 'object'
      ? {
          ...studyDelta.significance,
          reasons: uniqueStrings(studyDelta.significance.reasons || []).slice(0, SIGNIFICANCE_REASON_LIMIT),
        }
      : {
          level: 'none',
          score: 0,
          reasons: [],
        },
  };
}

function createProposalRecord(key, proposal) {
  const source = proposal && typeof proposal === 'object' ? proposal : {};
  return {
    key: String(key || source.key || '').trim(),
    title: source.title,
    rationale: source.rationale,
    task: source.task,
    tags: uniqueStrings(source.tags),
    files: uniquePaths(source.files),
    related_tests: uniquePaths(source.related_tests),
    validation_commands: uniqueStrings(source.validation_commands),
    affected_invariants: uniqueStrings(source.affected_invariants),
    priority: Number.isInteger(source.priority) ? source.priority : 50,
    kind: source.kind || 'study-followup',
    trace: source.trace && typeof source.trace === 'object'
      ? { ...source.trace }
      : null,
  };
}

function shouldSubmitStudyProposals(studyDelta, options = {}) {
  if (options.submitProposals !== true) {
    return { allowed: false, reason: 'submission_disabled' };
  }

  const runMode = String(studyDelta?.run?.mode || '').trim().toLowerCase();
  if (!studyDelta || runMode.startsWith('baseline')) {
    return { allowed: false, reason: 'baseline_run' };
  }

  const changedFiles = Array.isArray(studyDelta?.changed_files?.repo_delta)
    ? studyDelta.changed_files.repo_delta
    : [];
  if (changedFiles.length === 0) {
    return { allowed: false, reason: 'no_repo_delta' };
  }

  const significanceLevel = normalizeStudyThresholdLevel(studyDelta?.significance?.level, 'none');
  const thresholdLevel = normalizeStudyThresholdLevel(
    options.proposalSignificanceLevel,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
  );
  if (compareStudySignificanceLevels(significanceLevel, thresholdLevel) < 0) {
    return {
      allowed: false,
      reason: 'below_significance_threshold',
      threshold_level: thresholdLevel,
      actual_level: significanceLevel,
    };
  }

  const significanceScore = normalizeNonNegativeInteger(studyDelta?.significance?.score);
  const minimumScore = normalizeNonNegativeInteger(options.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE);
  if (significanceScore < minimumScore) {
    return {
      allowed: false,
      reason: 'below_score_threshold',
      threshold_score: minimumScore,
      actual_score: significanceScore,
    };
  }

  return {
    allowed: true,
    threshold_level: thresholdLevel,
    threshold_score: minimumScore,
  };
}

function parseTaskMetadata(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isSuppressedStudyProposalTask(task) {
  const approvalStatus = String(task?.approval_status || '').trim().toLowerCase();
  const status = String(task?.status || '').trim().toLowerCase();
  if (approvalStatus === 'rejected') {
    return false;
  }
  return !['failed', 'cancelled'].includes(status);
}

function filterDuplicateStudyProposals(proposals, taskAccessor, options = {}) {
  const input = Array.isArray(proposals) ? proposals : [];
  if (!taskAccessor || typeof taskAccessor.listTasks !== 'function' || input.length === 0) {
    return {
      proposals: input,
      suppressed: [],
    };
  }

  const existingTasks = taskAccessor.listTasks({
    project: options.project,
    tag: 'study-delta-proposal',
    limit: MAX_EXISTING_PROPOSAL_SCAN,
    includeArchived: true,
  });
  const existingByKey = new Map();
  for (const task of Array.isArray(existingTasks) ? existingTasks : []) {
    if (!isSuppressedStudyProposalTask(task)) {
      continue;
    }
    const metadata = parseTaskMetadata(task.metadata);
    const key = String(metadata?.study_proposal?.key || '').trim();
    if (!key || existingByKey.has(key)) {
      continue;
    }
    existingByKey.set(key, task);
  }

  const seenKeys = new Set();
  const accepted = [];
  const suppressed = [];
  for (const proposal of input) {
    const key = String(proposal?.key || '').trim();
    if (!key) {
      accepted.push(proposal);
      continue;
    }
    if (seenKeys.has(key)) {
      suppressed.push({
        key,
        title: proposal.title,
        reason: 'duplicate_within_run',
      });
      continue;
    }
    seenKeys.add(key);
    if (existingByKey.has(key)) {
      suppressed.push({
        key,
        title: proposal.title,
        reason: 'existing_pending_or_active_proposal',
        existing_task_id: existingByKey.get(key)?.id || null,
      });
      continue;
    }
    accepted.push(proposal);
  }

  return {
    proposals: accepted,
    suppressed,
  };
}

function resolveTaskAccessor({ taskCore, db, deps }) {
  return (
    (taskCore && (typeof taskCore.listTasks === 'function' || typeof taskCore.createTask === 'function' || typeof taskCore.submitTask === 'function') ? taskCore : null)
    || (db && (typeof db.listTasks === 'function' || typeof db.createTask === 'function' || typeof db.submitTask === 'function') ? db : null)
    || (deps.taskAccessor && (typeof deps.taskAccessor.listTasks === 'function' || typeof deps.taskAccessor.createTask === 'function' || typeof deps.taskAccessor.submitTask === 'function') ? deps.taskAccessor : null)
    || null
  );
}

function submitTaskRecord(taskAccessor, task) {
  if (!taskAccessor) {
    return null;
  }
  if (typeof taskAccessor.createTask === 'function') {
    return taskAccessor.createTask(task);
  }
  if (typeof taskAccessor.submitTask === 'function') {
    return taskAccessor.submitTask(task);
  }
  return null;
}

function resolveWorkingDirectory(studyId, evaluation = {}) {
  const candidates = [
    evaluation.workingDirectory,
    evaluation.working_directory,
    evaluation.studyId,
    evaluation.study_id,
    studyId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function resolveProjectName(projectName, workingDirectory) {
  if (typeof projectName === 'string' && projectName.trim()) {
    return projectName.trim();
  }
  if (typeof workingDirectory === 'string' && workingDirectory.trim()) {
    return path.basename(workingDirectory.trim());
  }
  return '';
}

function normalizePolicyThresholdLevel(policy = {}) {
  return normalizeStudyThresholdLevel(
    policy.proposalSignificanceLevel ?? policy.threshold_level ?? policy.thresholdLevel,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
  );
}

function normalizePolicyThresholdScore(policy = {}) {
  return normalizeNonNegativeInteger(
    policy.proposalMinScore ?? policy.threshold_score ?? policy.thresholdScore,
    DEFAULT_PROPOSAL_MIN_SCORE
  );
}

function createSubmittedProposalMetadata(proposal) {
  return {
    source: 'codebase-study',
    key: proposal.key,
    title: proposal.title,
    rationale: proposal.rationale,
    kind: proposal.kind,
    files: uniquePaths(proposal.files),
    related_tests: uniquePaths(proposal.related_tests),
    validation_commands: uniqueStrings(proposal.validation_commands),
    affected_invariants: uniqueStrings(proposal.affected_invariants),
    trace: proposal.trace && typeof proposal.trace === 'object'
      ? { ...proposal.trace }
      : null,
    created_at: new Date().toISOString(),
  };
}

function ensureStudyProposalApprovalRule(schedulingAutomation, projectName) {
  const existingRule = (schedulingAutomation.listApprovalRules?.({
    project: projectName,
    enabledOnly: false,
    limit: 200,
  }) || []).find((rule) => rule.name === STUDY_PROPOSAL_RULE_NAME);

  if (existingRule?.id) {
    return existingRule.id;
  }

  return schedulingAutomation.createApprovalRule(
    STUDY_PROPOSAL_RULE_NAME,
    STUDY_PROPOSAL_RULE_TYPE,
    {},
    {
      project: projectName,
      requiredApprovers: 1,
    }
  );
}

function createProposer({ taskCore, logger, db, ...deps } = {}) {
  const studyLogger = logger || createNoopLogger();
  const taskAccessor = resolveTaskAccessor({ taskCore, db, deps });
  const schedulingAutomation = deps.schedulingAutomation || require('../../db/scheduling-automation');

  function filterProposals(proposals, policy = {}) {
    const normalizedProposals = Array.isArray(proposals)
      ? proposals.map((proposal) => createProposalRecord(proposal?.key, proposal))
      : [];
    const studyDelta = normalizeStudyDelta(
      policy.studyDelta
      || policy.study_delta
      || policy.evaluation?.studyDelta
      || policy.evaluation?.study_delta
      || null
    );
    const projectName = resolveProjectName(
      policy.project || policy.evaluation?.project,
      policy.workingDirectory || policy.working_directory || policy.evaluation?.workingDirectory || policy.evaluation?.working_directory || ''
    );
    const proposalGate = shouldSubmitStudyProposals(studyDelta, {
      submitProposals: policy.submitProposals === true,
      proposalSignificanceLevel: policy.proposalSignificanceLevel ?? policy.threshold_level ?? policy.thresholdLevel,
      proposalMinScore: policy.proposalMinScore ?? policy.threshold_score ?? policy.thresholdScore,
    });
    const dedupedProposalSet = taskAccessor && typeof taskAccessor.listTasks === 'function'
      ? filterDuplicateStudyProposals(normalizedProposals, taskAccessor, { project: projectName })
      : { proposals: normalizedProposals, suppressed: [] };

    const proposalPolicy = {
      allowed: proposalGate.allowed,
      reason: proposalGate.reason || null,
      threshold_level: proposalGate.threshold_level || normalizePolicyThresholdLevel(policy),
      threshold_score: proposalGate.threshold_score ?? normalizePolicyThresholdScore(policy),
      suppressed_count: dedupedProposalSet.suppressed.length,
    };
    const errors = dedupedProposalSet.suppressed.length > 0
      ? dedupedProposalSet.suppressed.map((item) => ({
          title: item.title,
          error: proposalGate.allowed
            ? `Suppressed duplicate proposal (${item.reason})`
            : `Proposal gate closed (${proposalGate.reason})`,
          existing_task_id: item.existing_task_id || null,
        }))
      : [];

    studyLogger.debug('Filtered study proposals', {
      proposalCount: normalizedProposals.length,
      keptCount: dedupedProposalSet.proposals.length,
      suppressedCount: dedupedProposalSet.suppressed.length,
      allowed: proposalPolicy.allowed,
      reason: proposalPolicy.reason,
    });

    return {
      policy: proposalPolicy,
      suggested: dedupedProposalSet.proposals,
      submitted: [],
      errors,
    };
  }

  async function submitProposals(studyId, evaluation = {}) {
    const workingDirectory = resolveWorkingDirectory(studyId, evaluation);
    const projectName = resolveProjectName(evaluation.project, workingDirectory);
    const existingProposals = evaluation.proposals
      && typeof evaluation.proposals === 'object'
      && !Array.isArray(evaluation.proposals)
      ? evaluation.proposals
      : filterProposals(
          Array.isArray(evaluation.proposals)
            ? evaluation.proposals
            : (Array.isArray(evaluation.suggestedProposals) ? evaluation.suggestedProposals : []),
          evaluation
        );

    const normalizedSuggested = Array.isArray(existingProposals.suggested)
      ? existingProposals.suggested.map((proposal) => createProposalRecord(proposal?.key, proposal))
      : [];
    const submitted = [];
    const errors = Array.isArray(existingProposals.errors) ? existingProposals.errors.slice() : [];

    if (
      existingProposals.policy?.allowed !== true
      || normalizedSuggested.length === 0
      || !taskAccessor
      || (typeof taskAccessor.submitTask !== 'function' && typeof taskAccessor.createTask !== 'function')
    ) {
      return {
        policy: existingProposals.policy || {
          allowed: false,
          reason: 'submission_disabled',
          threshold_level: normalizePolicyThresholdLevel(evaluation),
          threshold_score: normalizePolicyThresholdScore(evaluation),
          suppressed_count: 0,
        },
        suggested: normalizedSuggested,
        submitted,
        errors,
      };
    }

    const proposalLimit = normalizePositiveInteger(
      evaluation.proposalLimit,
      DEFAULT_PROPOSAL_LIMIT,
      MAX_PROPOSAL_LIMIT
    );
    const approvalRuleId = ensureStudyProposalApprovalRule(schedulingAutomation, projectName);

    for (const proposal of normalizedSuggested.slice(0, proposalLimit)) {
      try {
        const taskId = randomUUID();
        submitTaskRecord(taskAccessor, {
          id: taskId,
          status: 'pending',
          task_description: `[Study Proposal] ${proposal.title}\n\n${proposal.task}`,
          working_directory: workingDirectory,
          project: projectName,
          tags: uniqueStrings([...(proposal.tags || []), 'study-delta-proposal', 'pending-approval']),
          timeout_minutes: 30,
          auto_approve: false,
          priority: proposal.priority,
          approval_status: 'pending',
          metadata: {
            version_intent: 'internal',
            study_proposal: createSubmittedProposalMetadata(proposal),
          },
        });

        const approvalId = schedulingAutomation.createApprovalRequest(taskId, approvalRuleId);
        submitted.push({
          title: proposal.title,
          task_id: taskId,
          approval_id: approvalId,
        });
      } catch (error) {
        errors.push({
          title: proposal.title,
          error: error.message || String(error),
        });
        studyLogger.warn('Failed to submit study proposal', {
          title: proposal.title,
          error: error.message || String(error),
        });
      }
    }

    return {
      policy: existingProposals.policy,
      suggested: normalizedSuggested,
      submitted,
      errors,
    };
  }

  return { submitProposals, filterProposals };
}

module.exports = { createProposer };
