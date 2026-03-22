/**
 * LLM safeguards, type verification, build analysis, auto-rollback,
 * i18n, accessibility, config/test baselines, and resource estimation handlers
 * Extracted from validation-handlers.js
 */

const db = require('../../database');
const { SOURCE_EXTENSIONS, UI_EXTENSIONS } = require('../../constants');
const { ErrorCodes, makeError, requireTask } = require('../shared');

/**
 * Capture test baseline
 */
async function handleCaptureTestBaseline(args) {
  try {

  if (!args.task_id || !args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id and working_directory are required');
  }


  const baseline = await db.captureTestBaseline(args.task_id, args.working_directory);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        baseline
      }, null, 2)
    }]
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Detect regressions
 */
async function handleDetectRegressions(args) {
  try {

  if (!args.task_id || !args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id and working_directory are required');
  }


  const baselineKey = `test_baseline_${args.task_id}`;
  const baselineJson = db.getConfig(baselineKey);
  let baseline = baselineJson ? JSON.parse(baselineJson) : null;

  if (!baseline) {
    baseline = await db.captureTestBaseline(args.task_id, args.working_directory);
  }

  const result = await db.detectRegressions(args.task_id, args.working_directory, baseline);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        ...result
      }, null, 2)
    }]
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Capture config baselines
 */
function handleCaptureConfigBaselines(args) {
  if (!args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const result = db.captureConfigBaselines(args.working_directory);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        working_directory: args.working_directory,
        ...result
      }, null, 2)
    }]
  };
}

/**
 * Detect configuration drift
 */
function handleDetectConfigDrift(args) {
  if (!args.task_id || !args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id and working_directory are required');
  }

  const result = db.detectConfigDrift(args.task_id, args.working_directory);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        working_directory: args.working_directory,
        ...result
      }, null, 2)
    }]
  };
}

/**
 * Estimate resource usage
 */
function handleEstimateResources(args) {
  const { task: _task, error: taskErr } = requireTask(db, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = db.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext.toLowerCase())) {
        const estimate = db.estimateResourceUsage(args.task_id, change.file_path, change.new_content);
        results.push(estimate);
      }
    }
  }

  const hasRisks = results.some(r => r.risk_factors?.length > 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_analyzed: results.length,
        has_risk_factors: hasRisks,
        results
      }, null, 2)
    }]
  };
}

/**
 * Check internationalization
 */
function handleCheckI18n(args) {
  const { task: _task, error: taskErr } = requireTask(db, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = db.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const uiExtensions = ['.js', '.ts', '.jsx', '.tsx'];
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (uiExtensions.includes(ext.toLowerCase())) {
        const i18nResult = db.checkI18n(args.task_id, change.file_path, change.new_content);
        results.push(i18nResult);
      }
    }
  }

  const totalHardcoded = results.reduce((sum, r) => sum + r.hardcoded_strings_count, 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_checked: results.length,
        total_hardcoded_strings: totalHardcoded,
        results
      }, null, 2)
    }]
  };
}

/**
 * Check accessibility
 */
function handleCheckAccessibility(args) {
  const { task: _task, error: taskErr } = requireTask(db, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = db.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (UI_EXTENSIONS.has(ext.toLowerCase())) {
        const a11yResult = db.checkAccessibility(args.task_id, change.file_path, change.new_content);
        results.push(a11yResult);
      }
    }
  }

  const totalViolations = results.reduce((sum, r) => sum + r.violations_count, 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_checked: results.length,
        total_violations: totalViolations,
        results
      }, null, 2)
    }]
  };
}

/**
 * Get safeguard tool configurations
 */
function handleGetSafeguardTools(args) {
  const tools = db.getSafeguardToolConfigs(args.safeguard_type);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        safeguard_type: args.safeguard_type || 'all',
        tools,
        count: tools.length
      }, null, 2)
    }]
  };
}

/**
 * Verify type references exist in codebase
 */
function handleVerifyTypeReferences(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.file_path) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  if (!args.content) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'content is required');
  if (!args.working_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');

  const result = db.verifyTypeReferences(args.task_id, args.file_path, args.content, args.working_directory);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Get type verification results
 */
function handleGetTypeVerificationResults(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');

  const results = db.getTypeVerificationResults(args.task_id);
  const missingTypes = results.filter(r => !r.exists_in_codebase);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        total_types: results.length,
        missing_types: missingTypes.length,
        results,
        status: missingTypes.length > 0 ? 'types_missing' : 'verified'
      }, null, 2)
    }]
  };
}

/**
 * Analyze build output for errors
 */
function handleAnalyzeBuildOutput(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.build_output) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'build_output is required');

  const result = db.analyzeBuildOutput(args.task_id, args.build_output);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Get build error analysis
 */
function handleGetBuildErrorAnalysis(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');

  const results = db.getBuildErrorAnalysis(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        error_count: results.length,
        results,
        has_namespace_conflicts: results.some(e => e.error_type === 'namespace_conflict'),
        has_missing_types: results.some(e => e.error_type === 'missing_type')
      }, null, 2)
    }]
  };
}

/**
 * Calculate task complexity score
 */
function handleCalculateTaskComplexity(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.task_description) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_description is required');

  const result = db.calculateTaskComplexityScore(args.task_id, args.task_description);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Get task complexity score
 */
function handleGetTaskComplexityScore(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');

  const result = db.getTaskComplexityScore(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result || { message: 'No complexity score found for task' }, null, 2)
    }]
  };
}

/**
 * Perform auto-rollback
 */
function handlePerformAutoRollback(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.working_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  if (!args.trigger_reason) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'trigger_reason is required');

  const result = db.performAutoRollback(args.task_id, args.working_directory, args.trigger_reason);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

/**
 * Get auto-rollback history
 */
function handleGetAutoRollbackHistory(args) {
  const results = db.getAutoRollbackHistory(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id || 'all',
        rollback_count: results.length,
        results
      }, null, 2)
    }]
  };
}

function createValidationSafeguardHandlers() {
  return {
    handleCaptureTestBaseline,
    handleDetectRegressions,
    handleCaptureConfigBaselines,
    handleDetectConfigDrift,
    handleEstimateResources,
    handleCheckI18n,
    handleCheckAccessibility,
    handleGetSafeguardTools,
    handleVerifyTypeReferences,
    handleGetTypeVerificationResults,
    handleAnalyzeBuildOutput,
    handleGetBuildErrorAnalysis,
    handleCalculateTaskComplexity,
    handleGetTaskComplexityScore,
    handlePerformAutoRollback,
    handleGetAutoRollbackHistory,
  };
}

module.exports = {
  handleCaptureTestBaseline,
  handleDetectRegressions,
  handleCaptureConfigBaselines,
  handleDetectConfigDrift,
  handleEstimateResources,
  handleCheckI18n,
  handleCheckAccessibility,
  handleGetSafeguardTools,
  handleVerifyTypeReferences,
  handleGetTypeVerificationResults,
  handleAnalyzeBuildOutput,
  handleGetBuildErrorAnalysis,
  handleCalculateTaskComplexity,
  handleGetTaskComplexityScore,
  handlePerformAutoRollback,
  handleGetAutoRollbackHistory,
  createValidationSafeguardHandlers,
};
