'use strict';

const { resumeWorkflow, resumeAllRunningWorkflows } = require('../execution/workflow-resume');
const { ErrorCodes, makeError } = require('./shared');

function handleResumeWorkflow(args = {}) {
  if (!args.workflow_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const result = resumeWorkflow(args.workflow_id);
  if (result.error === 'not_found') {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Workflow ${args.workflow_id} not found`);
  }
  if (result.skipped) {
    return {
      content: [{ type: 'text', text: `Skipped: ${result.reason}` }],
      structuredData: result,
    };
  }

  const text = `Resumed workflow ${args.workflow_id}: unblocked ${result.unblocked} task(s)${result.finalized ? ', workflow finalized' : ''}`;
  return {
    content: [{ type: 'text', text }],
    structuredData: result,
  };
}

function handleResumeAllWorkflows() {
  const result = resumeAllRunningWorkflows();
  return {
    content: [{ type: 'text', text: `Evaluated ${result.workflows_evaluated} running workflow(s); unblocked ${result.tasks_unblocked} task(s).` }],
    structuredData: result,
  };
}

module.exports = { handleResumeWorkflow, handleResumeAllWorkflows };
