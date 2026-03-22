'use strict';

const db = require('../../database');
const { ErrorCodes, makeError, requireTask } = require('../shared');

/**
 * Set expected output path for a task
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleSetExpectedOutputPath(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.expected_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'expected_directory is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const result = db.setExpectedOutputPath(args.task_id, args.expected_directory, {
    allowSubdirs: args.allow_subdirs !== false,
    filePatterns: args.file_patterns
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        message: 'Expected output path set',
        ...result
      }, null, 2)
    }]
  };
}


/**
 * Check for files created outside expected directories
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleCheckFileLocations(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.working_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const anomalies = db.checkFileLocationAnomalies(args.task_id, args.working_directory);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        working_directory: args.working_directory,
        anomalies_found: anomalies.length,
        anomalies,
        status: anomalies.length > 0 ? 'issues_found' : 'clean'
      }, null, 2)
    }]
  };
}


/**
 * Check for duplicate files in the working directory
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleCheckDuplicateFiles(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.working_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const duplicates = db.checkDuplicateFiles(args.task_id, args.working_directory, {
    fileExtensions: args.file_extensions
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        working_directory: args.working_directory,
        duplicates_found: duplicates.length,
        duplicates,
        status: duplicates.length > 0 ? 'duplicates_found' : 'clean'
      }, null, 2)
    }]
  };
}


/**
 * Get all file location issues for a task
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleGetFileLocationIssues(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const issues = db.getAllFileLocationIssues(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        ...issues,
        status: issues.total_issues > 0 ? 'issues_found' : 'clean'
      }, null, 2)
    }]
  };
}


/**
 * Record a file change for tracking
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleRecordFileChange(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.file_path) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  if (!args.change_type) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'change_type is required');

  const validTypes = ['created', 'modified', 'deleted'];
  if (!validTypes.includes(args.change_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, `change_type must be one of: ${validTypes.join(', ')}`);
  }

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const result = db.recordFileChange(args.task_id, args.file_path, args.change_type, {
    workingDirectory: args.working_directory
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        message: 'File change recorded',
        ...result
      }, null, 2)
    }]
  };
}


/**
 * Resolve a file location issue
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleResolveFileLocationIssue(args) {
  if (!args.issue_type) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'issue_type is required');
  if (!args.issue_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'issue_id is required');

  let result;
  if (args.issue_type === 'anomaly') {
    result = db.resolveFileLocationAnomaly(args.issue_id);
  } else if (args.issue_type === 'duplicate') {
    result = db.resolveDuplicateFile(args.issue_id);
  } else {
    return makeError(ErrorCodes.INVALID_PARAM, 'issue_type must be either "anomaly" or "duplicate"');
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        message: 'Issue resolved',
        issue_type: args.issue_type,
        result
      }, null, 2)
    }]
  };
}


/**
 * Search for similar files before creating new ones
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleSearchSimilarFiles(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  if (!args.search_term) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'search_term is required');
  if (!args.working_directory) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const result = db.searchSimilarFiles(args.task_id, args.search_term, args.working_directory, args.search_type || 'filename');

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}


/**
 * Get similar file search results
 * @param {object} args - Handler arguments.
 * @returns {object} Response payload.
 */
function handleGetSimilarFileResults(args) {
  if (!args.task_id) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const results = db.getSimilarFileSearchResults(args.task_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id: args.task_id,
        search_count: results.length,
        results
      }, null, 2)
    }]
  };
}

function createValidationFileHandlers() {
  return {
    handleSetExpectedOutputPath,
    handleCheckFileLocations,
    handleCheckDuplicateFiles,
    handleGetFileLocationIssues,
    handleRecordFileChange,
    handleResolveFileLocationIssue,
    handleSearchSimilarFiles,
    handleGetSimilarFileResults,
  };
}

module.exports = {
  handleSetExpectedOutputPath,
  handleCheckFileLocations,
  handleCheckDuplicateFiles,
  handleGetFileLocationIssues,
  handleRecordFileChange,
  handleResolveFileLocationIssue,
  handleSearchSimilarFiles,
  handleGetSimilarFileResults,
  createValidationFileHandlers,
};
