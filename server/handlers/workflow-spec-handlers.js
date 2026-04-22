'use strict';

const path = require('path');
const { parseSpec, discoverSpecs } = require('../workflow-spec');
const workflowHandlers = require('./workflow');
const { ErrorCodes, makeError } = require('./shared');

function resolveSpecPath(specPath, workingDirectory) {
  if (path.isAbsolute(specPath)) return path.normalize(specPath);
  const root = workingDirectory || process.cwd();
  return path.join(root, specPath);
}

function requireSpecPath(args) {
  if (!args || typeof args.spec_path !== 'string' || args.spec_path.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'spec_path is required');
  }
  return null;
}

function handleListWorkflowSpecs(args = {}) {
  const wd = args.working_directory || process.cwd();
  try {
    const specs = discoverSpecs(wd);
    const text = specs.length === 0
      ? `No workflow specs found in ${wd}/workflows/`
      : `Found ${specs.length} workflow spec(s):\n\n` +
        specs.map(s => `- **${s.name}** (${s.relative_path}) - ${s.valid ? `${s.task_count} tasks` : 'INVALID: ' + s.errors.join('; ')}`).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredData: { specs },
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to discover specs: ${err.message}`);
  }
}

function handleValidateWorkflowSpec(args = {}) {
  const missingPath = requireSpecPath(args);
  if (missingPath) return missingPath;

  const fullPath = resolveSpecPath(args.spec_path.trim(), args.working_directory);
  const result = parseSpec(fullPath);
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Invalid spec ${fullPath}:\n- ${result.errors.join('\n- ')}` }],
      structuredData: { valid: false, errors: result.errors },
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Spec ${fullPath} is valid. ${result.spec.tasks.length} tasks.` }],
    structuredData: { valid: true, spec: result.spec },
  };
}

function handleRunWorkflowSpec(args = {}) {
  const missingPath = requireSpecPath(args);
  if (missingPath) return missingPath;

  const fullPath = resolveSpecPath(args.spec_path.trim(), args.working_directory);
  const parsed = parseSpec(fullPath);
  if (!parsed.ok) {
    return {
      content: [{ type: 'text', text: `Invalid spec:\n- ${parsed.errors.join('\n- ')}` }],
      structuredData: { valid: false, errors: parsed.errors },
      isError: true,
    };
  }

  const spec = parsed.spec;
  const workflowDescription = typeof args.goal === 'string' && args.goal.trim().length > 0
    ? args.goal
    : spec.description;
  const createArgs = {
    name: spec.name,
    working_directory: args.working_directory || spec.working_directory,
    project: spec.project,
    routing_template: spec.routing_template,
    version_intent: spec.version_intent,
    priority: spec.priority,
    tasks: spec.tasks,
  };
  if (workflowDescription !== undefined) {
    createArgs.description = workflowDescription;
  }

  const createResult = workflowHandlers.handleCreateWorkflow(createArgs);

  if (createResult.isError) return createResult;

  const workflowId = (createResult.content?.[0]?.text || '').match(/([a-f0-9-]{36})/)?.[1];
  if (!workflowId) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Workflow created but could not extract workflow_id');
  }

  return {
    content: [
      { type: 'text', text: `Workflow created from ${fullPath}.\nID: ${workflowId}\nUse run_workflow to start it.` },
    ],
    structuredData: { workflow_id: workflowId, spec_path: fullPath },
    workflow_id: workflowId,
  };
}

module.exports = {
  handleListWorkflowSpecs,
  handleValidateWorkflowSpec,
  handleRunWorkflowSpec,
};
