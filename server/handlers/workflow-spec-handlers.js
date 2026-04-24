'use strict';

const path = require('path');
const { parseSpec, discoverSpecs } = require('../workflow-spec');
const workflowHandlers = require('./workflow');
const {
  ErrorCodes,
  makeError,
  optionalString,
  requireArray,
  requireString,
} = require('./shared');

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
  const description =
    typeof spec.description === 'string'
      ? spec.description
      : typeof args.goal === 'string'
        ? args.goal
        : undefined;
  const createArgs = {
    name: spec.name,
    description,
    working_directory: args.working_directory || spec.working_directory,
    project: spec.project,
    routing_template: spec.routing_template,
    version_intent: spec.version_intent,
    priority: spec.priority,
    model_stylesheet: spec.model_stylesheet,
    tasks: spec.tasks,
  };

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

async function handleBenchWorkflowSpecs(args = {}) {
  const goalError = requireString(args, 'goal');
  if (goalError) return goalError;

  const specsError = requireArray(args, 'specs');
  if (specsError) return specsError;

  const workingDirectoryError = optionalString(args, 'working_directory');
  if (workingDirectoryError) return workingDirectoryError;

  if (args.specs.length < 2) {
    return makeError(ErrorCodes.INVALID_PARAM, 'specs must contain at least two workflow spec paths');
  }

  if (args.specs.some((specPath) => typeof specPath !== 'string' || specPath.trim().length === 0)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'specs must only contain non-empty string paths');
  }

  if (args.runs_per_variant !== undefined) {
    const runsPerVariant = typeof args.runs_per_variant === 'string'
      ? Number(args.runs_per_variant)
      : args.runs_per_variant;
    if (!Number.isInteger(runsPerVariant) || runsPerVariant < 1 || runsPerVariant > 10) {
      return makeError(ErrorCodes.INVALID_PARAM, 'runs_per_variant must be an integer between 1 and 10');
    }
  }

  try {
    // Lazy-load the runner because it depends on handleRunWorkflowSpec.
    const { runBench } = require('../bench/runner');
    const { renderReport } = require('../bench/render-report');
    const result = await runBench(args);
    const report = renderReport(result);
    return {
      content: [{ type: 'text', text: report }],
      structuredData: { ...result, report },
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, err.message || String(err));
  }
}

module.exports = {
  handleListWorkflowSpecs,
  handleValidateWorkflowSpec,
  handleRunWorkflowSpec,
  handleBenchWorkflowSpecs,
};
