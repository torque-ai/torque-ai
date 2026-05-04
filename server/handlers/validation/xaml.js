'use strict';

const fileTracking = require('../../db/file/tracking');
const { requireString } = require('../shared');

/**
 * Validate XAML semantics
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleValidateXamlSemantics(args) {
  let err;
  err = requireString(args, 'task_id'); if (err) return err;
  err = requireString(args, 'file_path'); if (err) return err;
  err = requireString(args, 'content'); if (err) return err;

  const result = fileTracking.validateXamlSemantics(args.task_id, args.file_path, args.content);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        file_path: args.file_path,
        validation_passed: result.passed,
        issue_count: result.issues.length,
        issues: result.issues
      }, null, 2)
    }]
  };
}


/**
 * Get XAML validation results
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleGetXamlValidationResults(args) {
  const err = requireString(args, 'task_id');
  if (err) return err;

  const results = fileTracking.getXamlValidationResults(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        result_count: results.length,
        results
      }, null, 2)
    }]
  };
}


/**
 * Check XAML/code-behind consistency
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleCheckXamlConsistency(args) {
  let err;
  err = requireString(args, 'task_id'); if (err) return err;
  err = requireString(args, 'xaml_path'); if (err) return err;
  err = requireString(args, 'xaml_content'); if (err) return err;
  err = requireString(args, 'codebehind_content'); if (err) return err;

  const result = fileTracking.checkXamlCodeBehindConsistency(
    args.task_id,
    args.xaml_path,
    args.xaml_content,
    args.codebehind_content
  );

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        xaml_path: args.xaml_path,
        consistency_passed: result.passed,
        issue_count: result.issues.length,
        issues: result.issues
      }, null, 2)
    }]
  };
}


/**
 * Get XAML consistency check results
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleGetXamlConsistencyResults(args) {
  const err = requireString(args, 'task_id');
  if (err) return err;

  const results = fileTracking.getXamlConsistencyResults(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        result_count: results.length,
        results
      }, null, 2)
    }]
  };
}


/**
 * Run app startup smoke test
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleRunAppSmokeTest(args) {
  let err;
  err = requireString(args, 'task_id'); if (err) return err;
  err = requireString(args, 'working_directory'); if (err) return err;

  const timeoutSeconds = args.timeout_seconds || 10;

  // Use the synchronous version for MCP tool handlers
  const result = fileTracking.runAppSmokeTestSync(
    args.task_id,
    args.working_directory,
    {
      timeoutSeconds,
      projectFile: args.project_file || null
    }
  );

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        smoke_test_passed: result.passed,
        exit_code: result.exit_code,
        startup_time_ms: result.startup_time_ms,
        error_output: result.error_output || null
      }, null, 2)
    }]
  };
}


/**
 * Get smoke test results
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleGetSmokeTestResults(args) {
  const err = requireString(args, 'task_id');
  if (err) return err;

  const results = fileTracking.getSmokeTestResults(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        result_count: results.length,
        results
      }, null, 2)
    }]
  };
}

function createValidationXamlHandlers() {
  return {
    handleValidateXamlSemantics,
    handleGetXamlValidationResults,
    handleCheckXamlConsistency,
    handleGetXamlConsistencyResults,
    handleRunAppSmokeTest,
    handleGetSmokeTestResults,
  };
}

module.exports = {
  handleValidateXamlSemantics,
  handleGetXamlValidationResults,
  handleCheckXamlConsistency,
  handleGetXamlConsistencyResults,
  handleRunAppSmokeTest,
  handleGetSmokeTestResults,
  createValidationXamlHandlers,
};
