'use strict';

/**
 * Task Execution Policy Hooks
 *
 * Extracted from task-manager.js — policy evaluation at submit, pre-execute,
 * and completion stages. Wraps the raw task-hooks module with structured
 * task data normalization and safe error handling.
 *
 * Uses init() dependency injection.
 */

const logger = require('../logger').child({ component: 'task-execution-hooks' });
const taskHooks = require('./task-hooks');

let _db = null;

function init(deps = {}) {
  if (deps.db) _db = deps.db;
}

/**
 * Normalize arbitrary task data into a canonical policy task object.
 * Resolves project from path if not already present.
 * @param {Object} taskData
 * @param {Object} overrides
 * @returns {Object}
 */
function buildPolicyTaskData(taskData = {}, overrides = {}) {
  const source = (taskData && typeof taskData === 'object') ? taskData : {};
  const merged = { ...source, ...overrides };
  const workingDirectory = merged.working_directory || merged.workingDirectory || null;
  let project = merged.project || merged.project_id || merged.projectId || null;

  if (!project && workingDirectory && _db && typeof _db.getProjectFromPath === 'function') {
    try {
      project = _db.getProjectFromPath(workingDirectory);
    } catch (err) {
      logger.info(`[Policy] Failed to resolve project for ${workingDirectory}: ${err.message}`);
    }
  }

  const evidence = (merged.evidence && typeof merged.evidence === 'object')
    ? { ...merged.evidence }
    : {};

  if (merged.status) evidence.status = merged.status;
  if (merged.exit_code !== undefined) evidence.exit_code = merged.exit_code;
  if (merged.review_status) evidence.review_status = merged.review_status;

  return {
    ...merged,
    id: merged.id || merged.taskId || merged.task_id || 'unknown',
    taskId: merged.taskId || merged.task_id || merged.id || 'unknown',
    project,
    project_id: project,
    working_directory: workingDirectory,
    changed_files: merged.changed_files || merged.changedFiles || merged.files_modified || null,
    evidence,
  };
}

/**
 * Extract a human-readable block reason from a policy result object.
 * @param {Object} result - Policy evaluation result
 * @param {string} stage - Stage label for fallback message
 * @returns {string}
 */
function getPolicyBlockReason(result, stage) {
  const fallback = `Blocked by policy during ${stage}`;
  if (!result || typeof result !== 'object') return fallback;

  const failedResult = Array.isArray(result.results)
    ? result.results.find((entry) => entry && (entry.outcome === 'fail' || entry.mode === 'block'))
    : null;

  if (!failedResult) return fallback;
  return failedResult.reason || failedResult.message || failedResult.policy_id || fallback;
}

/**
 * Evaluate task submission policy. Returns { blocked, ... }.
 * @param {Object} taskData
 * @returns {Object}
 */
function evaluateTaskSubmissionPolicy(taskData) {
  const policyTaskData = buildPolicyTaskData(taskData);

  try {
    const result = taskHooks.onTaskSubmit(policyTaskData) || { blocked: false };
    if (result.blocked === true) {
      logger.info(`[Policy] Task ${policyTaskData.id} blocked on submit: ${getPolicyBlockReason(result, 'submit')}`);
    }
    return result;
  } catch (err) {
    logger.info(`[Policy] Submit hook failed for task ${policyTaskData.id}: ${err.message}`);
    return { blocked: false, skipped: true, reason: 'policy_hook_error', error: err.message };
  }
}

/**
 * Evaluate task pre-execute policy. Returns { blocked, ... }.
 * @param {Object} taskData
 * @returns {Object}
 */
function evaluateTaskPreExecutePolicy(taskData) {
  const policyTaskData = buildPolicyTaskData(taskData);

  try {
    const result = taskHooks.onTaskPreExecute(policyTaskData) || { blocked: false };
    if (result.blocked === true) {
      logger.info(`[Policy] Task ${policyTaskData.id} blocked before execution: ${getPolicyBlockReason(result, 'pre-execute')}`);
    }
    return result;
  } catch (err) {
    logger.info(`[Policy] Pre-execute hook failed for task ${policyTaskData.id}: ${err.message}`);
    return { blocked: false, skipped: true, reason: 'policy_hook_error', error: err.message };
  }
}

/**
 * Fire the task completion policy hook. Non-blocking; errors are swallowed.
 * @param {Object} taskData
 * @returns {Object}
 */
function fireTaskCompletionPolicyHook(taskData) {
  const policyTaskData = buildPolicyTaskData(taskData);

  try {
    return taskHooks.onTaskComplete(policyTaskData);
  } catch (err) {
    logger.info(`[Policy] Completion hook failed for task ${policyTaskData.id}: ${err.message}`);
    return { blocked: false, skipped: true, reason: 'policy_hook_error', error: err.message };
  }
}

module.exports = {
  init,
  buildPolicyTaskData,
  getPolicyBlockReason,
  evaluateTaskSubmissionPolicy,
  evaluateTaskPreExecutePolicy,
  fireTaskCompletionPolicyHook,
};
