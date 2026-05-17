'use strict';

const path = require('path');

const {
  createProposalScheduler,
  resolveTaskAccessor,
  filterDuplicateStudyProposals,
} = require('./proposal-scheduler');

const SIGNIFICANCE_ORDER = ['none', 'baseline', 'low', 'moderate', 'high', 'critical'];
const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL = 'moderate';
const DEFAULT_PROPOSAL_MIN_SCORE = 0;
const SIGNIFICANCE_REASON_LIMIT = 4;
const DEFAULT_PROPOSAL_LIMIT = 2;
const MAX_PROPOSAL_LIMIT = 5;

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

function createProposer({ taskCore, logger, db, ...deps } = {}) {
  const studyLogger = logger || createNoopLogger();
  const taskAccessor = resolveTaskAccessor({ taskCore, db, deps });

  // Delegate scheduling automation to proposal-scheduler
  const scheduler = createProposalScheduler({ taskCore, logger: studyLogger, db, ...deps });

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
        submitted: [],
        errors,
      };
    }

    // Delegate actual task submission and approval-rule management to scheduler
    const schedulerResult = await scheduler.submitProposals(
      workingDirectory,
      projectName,
      normalizedSuggested,
      { proposalLimit: evaluation.proposalLimit }
    );

    return {
      policy: existingProposals.policy,
      suggested: normalizedSuggested,
      submitted: schedulerResult.submitted,
      errors: [...errors, ...schedulerResult.errors],
    };
  }

  return { submitProposals, filterProposals };
}

module.exports = { createProposer };
