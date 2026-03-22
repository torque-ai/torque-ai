'use strict';

const workflowEngine = require('../db/workflow-engine');
const { resolveWorkflowConflicts } = require('../execution/conflict-resolver');
const { requireWorkflow, ErrorCodes, makeError } = require('./shared');

function formatConflictResolutionResult(workflow, result) {
  let output = `## Workflow Conflict Resolution: ${workflow.name}\n\n`;
  output += `**Workflow ID:** \`${workflow.id}\`\n`;
  output += `**Merged files:** ${result.merged.length}\n`;
  output += `**Manual conflicts:** ${result.conflicts.length}\n\n`;

  if (result.merged.length > 0) {
    output += '### Auto-Merged\n\n';
    output += '| File | Tasks | Action | Strategy |\n';
    output += '|------|-------|--------|----------|\n';
    for (const item of result.merged) {
      output += `| ${item.file_path} | ${item.task_ids.join(', ')} | ${item.action} | ${item.strategy} |\n`;
    }
    output += '\n';
  }

  if (result.conflicts.length > 0) {
    output += '### Manual Resolution Required\n\n';
    output += '| File | Tasks | Reason |\n';
    output += '|------|-------|--------|\n';
    for (const item of result.conflicts) {
      output += `| ${item.file_path} | ${item.task_ids.join(', ')} | ${item.reason} |\n`;
    }
  } else if (result.merged.length === 0) {
    output += 'No conflicted files were found for this workflow.\n';
  }

  return output;
}

function handleResolveWorkflowConflicts(args) {
  const workflowId = args.workflow_id;
  if (!workflowId || typeof workflowId !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const { workflow, error: wfErr } = requireWorkflow(workflowEngine, workflowId);
  if (wfErr) return wfErr;

  try {
    const result = resolveWorkflowConflicts(workflowId);
    return {
      ...result,
      content: [{ type: 'text', text: formatConflictResolutionResult(workflow, result) }]
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

function createConflictResolutionHandlers() {
  return {
    handleResolveWorkflowConflicts,
  };
}

module.exports = {
  handleResolveWorkflowConflicts,
  createConflictResolutionHandlers,
};
