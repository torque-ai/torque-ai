/**
 * Code analysis, complexity, coverage, style, and audit handlers
 * Extracted from validation-handlers.js
 */

const taskCore = require('../../db/task-core');
const fileTracking = require('../../db/file-tracking');
const { CODE_EXTENSIONS, SOURCE_EXTENSIONS } = require('../../constants');
const { ErrorCodes, makeError, requireTask } = require('../shared');

/**
 * Check test coverage for a task
 */
function handleCheckTestCoverage(args) {
  const { task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.file_path) {
      const coverage = fileTracking.checkTestCoverage(args.task_id, change.file_path, task.working_directory);
      results.push(coverage);
    }
  }

  const hasTests = results.filter(r => r.has_test).length;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_checked: results.length,
        files_with_tests: hasTests,
        coverage_percentage: results.length > 0 ? Math.round((hasTests / results.length) * 100) : 0,
        results: results
      }, null, 2)
    }]
  };
}

/**
 * Run code style check
 */
function handleRunStyleCheck(args) {
  const { task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.file_path) {
      const styleResult = fileTracking.runStyleCheck(args.task_id, change.file_path, task.working_directory, args.auto_fix || false);
      results.push(styleResult);
    }
  }

  const issueCount = results.reduce((sum, r) => sum + (r.issue_count || 0), 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_checked: results.length,
        total_issues: issueCount,
        auto_fix: args.auto_fix || false,
        results: results
      }, null, 2)
    }]
  };
}

/**
 * Analyze change impact for a task
 */
function handleAnalyzeChangeImpact(args) {
  const { task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const impacts = [];

  for (const change of fileChanges) {
    if (change.file_path) {
      const impact = fileTracking.analyzeChangeImpact(args.task_id, change.file_path, task.working_directory);
      impacts.push(impact);
    }
  }

  const totalImpactedFiles = impacts.reduce((sum, i) => sum + (i.impacted_files ? i.impacted_files.length : 0), 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_analyzed: impacts.length,
        total_impacted_files: totalImpactedFiles,
        impacts: impacts
      }, null, 2)
    }]
  };
}

/**
 * Get timeout alerts
 */
function handleGetTimeoutAlerts(args) {
  const alerts = fileTracking.getTimeoutAlerts(args.task_id, args.status);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        alerts: alerts,
        count: alerts.length
      }, null, 2)
    }]
  };
}

/**
 * Configure output size limits
 */
function handleConfigureOutputLimits(args) {
  if (!args.provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }

  fileTracking.setOutputLimit(
    args.provider,
    args.max_output_bytes || 1048576,
    args.max_file_size_bytes || 524288,
    args.max_file_changes || 20,
    args.enabled !== false
  );

  return {
    content: [{
      type: 'text',
      text: `Output limits configured for ${args.provider}: max ${args.max_output_bytes || 1048576} bytes output, ${args.max_file_size_bytes || 524288} bytes/file`
    }]
  };
}

/**
 * Get audit trail events
 */
function handleGetAuditTrail(args) {
  const trail = fileTracking.getAuditTrail({
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    event_type: args.event_type,
    action: args.action,
    limit: args.limit || 100,
    offset: args.offset || 0
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        events: trail,
        count: trail.length,
        limit: args.limit || 100,
        offset: args.offset || 0
      }, null, 2)
    }]
  };
}

/**
 * Get audit summary statistics
 */
function handleGetAuditSummary(args) {
  const days = args.days || 7;
  const summary = fileTracking.getAuditSummary(days);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        days,
        summary: summary
      }, null, 2)
    }]
  };
}

/**
 * Scan for dependency vulnerabilities
 */
async function handleScanVulnerabilities(args) {
  try {

  if (!args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }


  const taskId = args.task_id || `scan-${Date.now()}`;
  const results = await fileTracking.runVulnerabilityScan(taskId, args.working_directory);

  const totalVulns = results.reduce((sum, r) => sum + (r.vulnerabilities?.total || 0), 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: taskId,
        working_directory: args.working_directory,
        scans_run: results.length,
        total_vulnerabilities: totalVulns,
        results: results
      }, null, 2)
    }]
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * Get vulnerability scan results
 */
function handleGetVulnerabilityResults(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const results = fileTracking.getVulnerabilityScanResults(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ task_id: args.task_id, results }, null, 2)
    }]
  };
}

/**
 * Analyze code complexity
 */
function handleAnalyzeComplexity(args) {
  const { task: _task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
        const metrics = fileTracking.analyzeCodeComplexity(args.task_id, change.file_path, change.new_content);
        results.push(metrics);
      }
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_analyzed: results.length,
        results
      }, null, 2)
    }]
  };
}

/**
 * Get complexity metrics
 */
function handleGetComplexityMetrics(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const metrics = fileTracking.getComplexityMetrics(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ task_id: args.task_id, metrics }, null, 2)
    }]
  };
}

/**
 * Detect dead code
 */
function handleDetectDeadCode(args) {
  const { task: _task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const allDeadCode = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext.toLowerCase())) {
        const deadCode = fileTracking.detectDeadCode(args.task_id, change.file_path, change.new_content);
        allDeadCode.push(...deadCode.map(d => ({ ...d, file_path: change.file_path })));
      }
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        dead_code_count: allDeadCode.length,
        results: allDeadCode
      }, null, 2)
    }]
  };
}

/**
 * Get dead code results
 */
function handleGetDeadCodeResults(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const results = fileTracking.getDeadCodeResults(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ task_id: args.task_id, results }, null, 2)
    }]
  };
}

/**
 * Validate API contract
 */
async function handleValidateApiContract(args) {
  try {

  if (!args.task_id || !args.contract_file || !args.working_directory) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id, contract_file, and working_directory are required');
  }


  const result = await fileTracking.validateApiContract(args.task_id, args.contract_file, args.working_directory);

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
 * Check documentation coverage
 */
function handleCheckDocCoverage(args) {
  const { task: _task, error: taskErr } = requireTask(taskCore, args.task_id);
  if (taskErr) return taskErr;

  const fileChanges = fileTracking.getTaskFileChanges(args.task_id);
  const results = [];

  for (const change of fileChanges) {
    if (change.new_content && change.file_path) {
      const ext = change.file_path.substring(change.file_path.lastIndexOf('.'));
      if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
        const coverage = fileTracking.checkDocCoverage(args.task_id, change.file_path, change.new_content);
        results.push(coverage);
      }
    }
  }

  const avgCoverage = results.length > 0
    ? results.reduce((sum, r) => sum + r.coverage_percent, 0) / results.length
    : 0;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        files_checked: results.length,
        average_coverage: Math.round(avgCoverage * 10) / 10,
        results
      }, null, 2)
    }]
  };
}

/**
 * Get documentation coverage results
 */
function handleGetDocCoverageResults(args) {
  if (!args.task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const results = fileTracking.getDocCoverageResults(args.task_id);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ task_id: args.task_id, results }, null, 2)
    }]
  };
}

function createValidationAnalysisHandlers() {
  return {
    handleCheckTestCoverage,
    handleRunStyleCheck,
    handleAnalyzeChangeImpact,
    handleGetTimeoutAlerts,
    handleConfigureOutputLimits,
    handleGetAuditTrail,
    handleGetAuditSummary,
    handleScanVulnerabilities,
    handleGetVulnerabilityResults,
    handleAnalyzeComplexity,
    handleGetComplexityMetrics,
    handleDetectDeadCode,
    handleGetDeadCodeResults,
    handleValidateApiContract,
    handleCheckDocCoverage,
    handleGetDocCoverageResults,
  };
}

module.exports = {
  handleCheckTestCoverage,
  handleRunStyleCheck,
  handleAnalyzeChangeImpact,
  handleGetTimeoutAlerts,
  handleConfigureOutputLimits,
  handleGetAuditTrail,
  handleGetAuditSummary,
  handleScanVulnerabilities,
  handleGetVulnerabilityResults,
  handleAnalyzeComplexity,
  handleGetComplexityMetrics,
  handleDetectDeadCode,
  handleGetDeadCodeResults,
  handleValidateApiContract,
  handleCheckDocCoverage,
  handleGetDocCoverageResults,
  createValidationAnalysisHandlers,
};
