'use strict';

const { buildBundle } = require('../runs/build-bundle');
const { replayWorkflow } = require('../runs/replay');
const { ErrorCodes, makeError } = require('./shared');

function handleBuildRunBundle(args = {}) {
  if (!args.workflow_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  try {
    const dir = buildBundle(args.workflow_id);
    if (!dir) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Workflow ${args.workflow_id} not found`);
    }

    return {
      content: [{ type: 'text', text: `Bundle written to ${dir}` }],
      structuredData: { bundle_dir: dir, workflow_id: args.workflow_id },
    };
  } catch (error) {
    return makeError(ErrorCodes.OPERATION_FAILED, error.message);
  }
}

function handleReplayWorkflow(args = {}) {
  if (!args.bundle_dir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'bundle_dir is required');
  }

  const result = replayWorkflow(args.bundle_dir);
  if (!result.ok) {
    return makeError(ErrorCodes.OPERATION_FAILED, result.error);
  }

  return {
    content: [{ type: 'text', text: `Replay created workflow ${result.workflow_id} (from ${result.source_workflow_id})` }],
    structuredData: result,
  };
}

module.exports = { handleBuildRunBundle, handleReplayWorkflow };
