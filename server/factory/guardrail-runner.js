'use strict';

const logger = require('../logger').child({ component: 'guardrail-runner' });
const guardrails = require('./guardrails');
const guardrailDb = require('../db/factory-guardrails');

function recordAndCollect(project_id, category, check_name, result, batch_id) {
  guardrailDb.recordEvent({
    project_id,
    category,
    check_name,
    status: result.status,
    details: result.details || {},
    batch_id: batch_id || null,
  });
  return { check_name, ...result };
}

function runPreBatchChecks(project_id, batch_plan, options = {}) {
  const results = [
    recordAndCollect(project_id, 'scope', 'checkScopeBudget', guardrails.checkScopeBudget(batch_plan)),
    recordAndCollect(project_id, 'scope', 'checkDecompositionDepth', guardrails.checkDecompositionDepth(batch_plan)),
    recordAndCollect(
      project_id,
      'control',
      'checkRateLimit',
      guardrails.checkRateLimit(options.recent_batches || [], options.max_per_hour),
    ),
  ];

  if (options.write_sets) {
    results.push(
      recordAndCollect(
        project_id,
        'conflict',
        'checkFileLocks',
        guardrails.checkFileLocks(options.write_sets),
      ),
    );
  }

  const passed = results.every((result) => result.status !== 'fail');
  logger.debug('Completed pre-batch guardrail checks', {
    project_id,
    passed,
    result_count: results.length,
  });

  return { passed, results };
}

function runPostBatchChecks(project_id, batch_id, files_changed, options = {}) {
  const results = [
    recordAndCollect(project_id, 'scope', 'checkBlastRadius', guardrails.checkBlastRadius(files_changed), batch_id),
    recordAndCollect(project_id, 'security', 'checkSecretFence', guardrails.checkSecretFence(files_changed), batch_id),
    recordAndCollect(
      project_id,
      'quality',
      'checkProportionality',
      guardrails.checkProportionality(files_changed, options.test_files_changed || []),
      batch_id,
    ),
  ];

  if (options.files_changed_content) {
    results.push(
      recordAndCollect(
        project_id,
        'silent_failure',
        'checkWorkaroundPatterns',
        guardrails.checkWorkaroundPatterns(options.files_changed_content),
        batch_id,
      ),
    );
  }

  const passed = results.every((result) => result.status !== 'fail');
  logger.debug('Completed post-batch guardrail checks', {
    project_id,
    batch_id,
    passed,
    result_count: results.length,
  });

  return { passed, results, batch_id };
}

function runPreShipChecks(project_id, batch_id, options = {}) {
  const results = [
    recordAndCollect(
      project_id,
      'quality',
      'checkTestRegression',
      guardrails.checkTestRegression(options.test_results || { passed: 0, failed: 0, skipped: 0 }),
      batch_id,
    ),
  ];

  if (options.before_scores && options.after_scores) {
    results.push(
      recordAndCollect(
        project_id,
        'quality',
        'checkHealthDelta',
        guardrails.checkHealthDelta(options.before_scores, options.after_scores),
        batch_id,
      ),
    );
  }

  if (options.estimated_cost !== undefined && options.budget_limit !== undefined) {
    results.push(
      recordAndCollect(
        project_id,
        'resource',
        'checkBudgetCeiling',
        guardrails.checkBudgetCeiling(options.estimated_cost, options.budget_limit),
        batch_id,
      ),
    );
  }

  const passed = results.every((result) => result.status !== 'fail');
  logger.debug('Completed pre-ship guardrail checks', {
    project_id,
    batch_id,
    passed,
    result_count: results.length,
  });

  return { passed, results, batch_id };
}

function getGuardrailSummary(project_id) {
  const status_map = guardrailDb.getGuardrailStatus(project_id);
  const latest_events = guardrailDb.getLatestByCategory(project_id);

  logger.debug('Loaded guardrail summary', {
    project_id,
    category_count: Object.keys(status_map).length,
    latest_event_count: latest_events.length,
  });

  return { status_map, latest_events };
}

module.exports = {
  runPreBatchChecks,
  runPostBatchChecks,
  runPreShipChecks,
  getGuardrailSummary,
};
