'use strict';

const { randomUUID } = require('crypto');

const MAX_EXISTING_PROPOSAL_SCAN = 500;
const STUDY_PROPOSAL_RULE_NAME = 'Study proposal review';
const STUDY_PROPOSAL_RULE_TYPE = 'all';
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
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizePositiveInteger(value, fallback = 1, maxValue = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, maxValue);
}

/**
 * Resolves the task accessor from multiple possible sources.
 * Checks taskCore, db, and deps.taskAccessor in order for listTasks/createTask/submitTask.
 */
function resolveTaskAccessor({ taskCore, db, deps }) {
  return (
    (taskCore && (typeof taskCore.listTasks === 'function' || typeof taskCore.createTask === 'function' || typeof taskCore.submitTask === 'function') ? taskCore : null)
    || (db && (typeof db.listTasks === 'function' || typeof db.createTask === 'function' || typeof db.submitTask === 'function') ? db : null)
    || (deps.taskAccessor && (typeof deps.taskAccessor.listTasks === 'function' || typeof deps.taskAccessor.createTask === 'function' || typeof deps.taskAccessor.submitTask === 'function') ? deps.taskAccessor : null)
    || null
  );
}

/**
 * Submits a task record via the resolved task accessor.
 * Tries createTask first, then submitTask.
 */
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

/**
 * Ensures a study proposal approval rule exists for the given project.
 * Looks up existing rules first; creates one if none found.
 */
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

/**
 * Creates the metadata block for a submitted proposal task.
 */
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

/**
 * Checks whether a task in the system should suppress a new proposal with the same key.
 * Returns false for rejected or failed/cancelled tasks (allowing re-proposal).
 */
function isSuppressedStudyProposalTask(task) {
  const approvalStatus = String(task?.approval_status || '').trim().toLowerCase();
  const status = String(task?.status || '').trim().toLowerCase();
  if (approvalStatus === 'rejected') {
    return false;
  }
  return !['failed', 'cancelled'].includes(status);
}

/**
 * Filters out proposals whose keys already have active/pending tasks.
 * Returns { proposals: [...accepted], suppressed: [...deduped] }.
 */
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

/**
 * Factory that creates a proposal scheduler — handles task submission with
 * approval-rule integration, deduplication against active proposals, and
 * task record creation via the resolved task accessor.
 *
 * @param {object} deps
 * @param {object} deps.taskCore - task core service (listTasks, submitTask)
 * @param {object} [deps.logger] - logger instance
 * @param {object} [deps.db] - fallback database accessor
 * @param {object} [deps.schedulingAutomation] - approval rule/request service
 * @returns {object} { submitProposals, filterDuplicates, ensureApprovalRule }
 */
function createProposalScheduler({ taskCore, logger, db, ...deps } = {}) {
  const studyLogger = logger || createNoopLogger();
  const taskAccessor = resolveTaskAccessor({ taskCore, db, deps });
  const schedulingAutomation = deps.schedulingAutomation || require('../../db/scheduling-automation');

  /**
   * Filters proposals against existing active/pending tasks and returns
   * deduplication results.
   */
  function filterDuplicates(proposals, options = {}) {
    return filterDuplicateStudyProposals(proposals, taskAccessor, options);
  }

  /**
   * Ensures a study proposal approval rule exists for the given project.
   */
  function ensureApprovalRule(projectName) {
    return ensureStudyProposalApprovalRule(schedulingAutomation, projectName);
  }

  /**
   * Submits normalized proposals as pending tasks with approval rules.
   *
   * @param {string} workingDirectory - resolved working directory
   * @param {string} projectName - resolved project name
   * @param {Array} proposals - normalized proposal records to submit
   * @param {object} [options] - { proposalLimit }
   * @returns {{ submitted: Array, errors: Array }}
   */
  async function submitProposals(workingDirectory, projectName, proposals, options = {}) {
    const submitted = [];
    const errors = [];

    if (
      !Array.isArray(proposals)
      || proposals.length === 0
      || !taskAccessor
      || (typeof taskAccessor.submitTask !== 'function' && typeof taskAccessor.createTask !== 'function')
    ) {
      return { submitted, errors };
    }

    const proposalLimit = normalizePositiveInteger(
      options.proposalLimit,
      DEFAULT_PROPOSAL_LIMIT,
      MAX_PROPOSAL_LIMIT
    );
    const approvalRuleId = ensureStudyProposalApprovalRule(schedulingAutomation, projectName);

    for (const proposal of proposals.slice(0, proposalLimit)) {
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

    return { submitted, errors };
  }

  return {
    submitProposals,
    filterDuplicates,
    ensureApprovalRule,
  };
}

module.exports = {
  createProposalScheduler,
  // Exported for direct use / testing
  resolveTaskAccessor,
  submitTaskRecord,
  ensureStudyProposalApprovalRule,
  createSubmittedProposalMetadata,
  isSuppressedStudyProposalTask,
  filterDuplicateStudyProposals,
  parseTaskMetadata,
};
