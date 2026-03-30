/**
 * Create Feature Workflow handler — extracted from workflow/index.js
 *
 * Builds a standardized feature workflow DAG with optional review checkpoints.
 */

const { v4: uuidv4 } = require('uuid');
const taskCore = require('../../db/task-core');
const workflowEngine = require('../../db/workflow-engine');
const projectConfigCoreModule = require('../../db/project-config-core');
const {
  ErrorCodes,
  makeError,
} = require('../shared');

let _startWorkflowExecution;
let _buildEmptyWorkflowCreationError;

function init({ startWorkflowExecution, buildEmptyWorkflowCreationError }) {
  _startWorkflowExecution = startWorkflowExecution;
  _buildEmptyWorkflowCreationError = buildEmptyWorkflowCreationError;
}

function getProjectConfigCore() {
  try {
    const { defaultContainer } = require('../../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.get === 'function'
      && defaultContainer.has('projectConfigCore')
    ) {
      return defaultContainer.get('projectConfigCore');
    }
  } catch (_e) {
    // Fall back to the direct module below.
  }

  return projectConfigCoreModule;
}

/**
 * Create a standardized feature workflow with optional adversarial-review
 * checkpoints between code-producing steps.
 * This eliminates repetitive workflow construction for game system features.
 */
function handleCreateFeatureWorkflow(args) {
  if (!args.feature_name || typeof args.feature_name !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'feature_name must be a non-empty string');
  }
  if (!args.working_directory || typeof args.working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const name = args.feature_name.trim();
  const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/\s+/g, '-');
  const _camel = name.charAt(0).toLowerCase() + name.slice(1);
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  const wdir = args.working_directory;
  const projectConfigCore = getProjectConfigCore();
  const config = projectConfigCore?.getProjectConfig?.(wdir) || {};
  const reviewMode = config.adversarial_review || 'off';
  const adversarialReviewEnabled = reviewMode === 'auto' || reviewMode === 'always';
  const stepProviders = args.step_providers || {};
  const routingTemplate = args.routing_template || null;
  const fixedStepNodeIds = [
    `${kebab}-types`,
    `${kebab}-events`,
    `${kebab}-data`,
    `${kebab}-system`,
    `${kebab}-tests`,
    `${kebab}-wire`
  ];
  if (adversarialReviewEnabled) {
    fixedStepNodeIds.push(
      `review-${kebab}-types`,
      `review-${kebab}-data`,
      `review-${kebab}-events`,
      `review-${kebab}-system`,
      `review-${kebab}-wire`
    );
  }
  const fixedStepNodeIdSet = new Set(fixedStepNodeIds);
  if (args.parallel_tasks !== undefined && !Array.isArray(args.parallel_tasks)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'parallel_tasks must be an array');
  }
  const workflowName = args.workflow_name || `Feature: ${pascal}`;
  const parallelTasks = Array.isArray(args.parallel_tasks) ? args.parallel_tasks : [];
  for (let i = 0; i < parallelTasks.length; i++) {
    const task = parallelTasks[i];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      return makeError(ErrorCodes.INVALID_PARAM, `parallel_tasks[${i}] must be an object`);
    }
    if (!task.task || typeof task.task !== 'string' || task.task.trim().length === 0) {
      return makeError(ErrorCodes.INVALID_PARAM, `parallel_tasks[${i}].task must be a non-empty string`);
    }
    if (task.node_id !== undefined && typeof task.node_id !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, `parallel_tasks[${i}].node_id must be a string when provided`);
    }
  }
  const plannedTaskCount =
    (args.types_task ? 1 : 0) +
    (args.events_task ? 1 : 0) +
    (args.data_task ? 1 : 0) +
    (args.system_task ? 1 : 0) +
    (args.tests_task ? 1 : 0) +
    (args.wire_task ? 1 : 0) +
    parallelTasks.length;

  if (plannedTaskCount === 0) {
    const duplicatePlaceholder = workflowEngine.findEmptyWorkflowPlaceholder(workflowName, 'pending');
    return _buildEmptyWorkflowCreationError(
      workflowName,
      'Set at least one of types_task, events_task, data_task, system_task, tests_task, wire_task, or parallel_tasks before creating the feature workflow.',
      duplicatePlaceholder
    );
  }

  // Create workflow — store routing_template in context for inheritance by tasks
  const workflowId = uuidv4();
  const workflowContext = {};
  if (routingTemplate) {
    workflowContext._routing_template = routingTemplate;
  }
  if (adversarialReviewEnabled) {
    workflowContext.adversarial_review_enabled = true;
  }
  const resolvedWorkflowContext = Object.keys(workflowContext).length > 0 ? workflowContext : undefined;
  workflowEngine.createWorkflow({
    id: workflowId,
    name: workflowName,
    description: args.description || `Auto-generated feature workflow for ${pascal}`,
    context: resolvedWorkflowContext,
  });

  const tasks = [];

  // Build metadata for a feature workflow task.
  // step_providers takes priority (explicit provider override).
  // If no step_provider is set, routing_template is propagated for smart routing.
  const buildStepMeta = (stepProvider, extraMeta, options = {}) => {
    const { inheritRouting = true } = options;
    const meta = { ...extraMeta };
    if (inheritRouting && !stepProvider && routingTemplate) {
      meta._routing_template = routingTemplate;
    }
    return Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined;
  };

  const reviewableSteps = new Set(['types', 'data', 'events', 'system', 'wire']);

  const getStepMetadata = (stepName) => {
    const extraMeta = {};
    if (stepName === 'system') {
      extraMeta.needs_review = true;
    }
    if (adversarialReviewEnabled && reviewableSteps.has(stepName)) {
      extraMeta.adversarial_review = true;
    }

    return buildStepMeta(
      stepProviders[stepName],
      Object.keys(extraMeta).length > 0 ? extraMeta : undefined
    );
  };

  const createWorkflowTaskRecord = ({
    nodeId,
    step,
    taskDescription,
    status,
    provider,
    metadata,
    tags,
    kind = 'step',
  }) => {
    const id = uuidv4();
    taskCore.createTask({
      id,
      task_description: taskDescription,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: nodeId,
      status,
      provider,
      metadata,
      tags,
    });
    const record = {
      id,
      nodeId,
      step,
      provider: provider || null,
      status,
      kind,
    };
    tasks.push(record);
    return record;
  };

  const addDependencies = (taskRecord, dependencyRecords) => {
    for (const dep of dependencyRecords.filter(Boolean)) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskRecord.id,
        depends_on_task_id: dep.id,
      });
    }
  };

  const createStepTask = (stepName, dependencyRecords = []) => {
    const taskDescription = args[`${stepName}_task`];
    if (!taskDescription) {
      return null;
    }

    const deps = dependencyRecords.filter(Boolean);
    const record = createWorkflowTaskRecord({
      nodeId: `${kebab}-${stepName}`,
      step: stepName,
      taskDescription,
      status: deps.length > 0 ? 'blocked' : 'pending',
      provider: stepProviders[stepName],
      metadata: getStepMetadata(stepName),
    });
    addDependencies(record, deps);
    return record;
  };

  const createReviewTask = (stepName, sourceTask) => {
    if (!sourceTask) {
      return null;
    }

    const reviewRecord = createWorkflowTaskRecord({
      nodeId: `review-${sourceTask.nodeId}`,
      step: `review-${stepName}`,
      taskDescription: `Review the ${stepName} step output. Check get_adversarial_reviews for the task and present the verdict.`,
      status: 'blocked',
      metadata: buildStepMeta(
        undefined,
        { context_from: [sourceTask.nodeId] },
        { inheritRouting: false }
      ),
      tags: ['review-checkpoint'],
      kind: 'review',
    });
    addDependencies(reviewRecord, [sourceTask]);
    return reviewRecord;
  };

  if (adversarialReviewEnabled) {
    let previousTerminalTask = null;
    const orderedSteps = ['types', 'data', 'events', 'system', 'tests', 'wire'];

    for (const stepName of orderedSteps) {
      const stepTask = createStepTask(stepName, previousTerminalTask ? [previousTerminalTask] : []);
      if (!stepTask) {
        continue;
      }

      if (reviewableSteps.has(stepName)) {
        previousTerminalTask = createReviewTask(stepName, stepTask);
      } else {
        previousTerminalTask = stepTask;
      }
    }
  } else {
    const typesTask = createStepTask('types');
    const eventsTask = createStepTask('events');
    const dataTask = createStepTask('data', typesTask ? [typesTask] : []);
    const systemDeps = [dataTask, eventsTask].filter(Boolean);
    const systemTask = createStepTask('system', systemDeps);
    createStepTask('tests', systemTask ? [systemTask] : []);
    createStepTask('wire', systemTask ? [systemTask] : []);
  }

  // Add extra parallel tasks (tests that run alongside, no deps)
  if (parallelTasks.length > 0) {
    for (let i = 0; i < parallelTasks.length; i++) {
      const pt = parallelTasks[i];
      const ptId = uuidv4();
      let nodeId = pt.node_id || `parallel-${i}`;
      if (fixedStepNodeIdSet.has(nodeId)) {
        nodeId = `parallel-${nodeId}`;
      }
      const ptProvider = pt.provider || stepProviders.parallel;
      taskCore.createTask({
        id: ptId,
        task_description: pt.task,
        working_directory: wdir,
        workflow_id: workflowId,
        workflow_node_id: nodeId,
        status: 'pending',
        provider: ptProvider,
        metadata: buildStepMeta(ptProvider),
      });
      tasks.push({ id: ptId, nodeId, step: 'parallel', provider: ptProvider || null, status: 'pending', kind: 'parallel' });
    }
  }

  workflowEngine.updateWorkflowCounts(workflowId);

  // Auto-run if requested
  let started = 0;
  let queued = 0;
  let blocked = tasks.filter(t => t.status === 'blocked').length;
  let startFailures = [];
  if (args.auto_run) {
    const startResult = _startWorkflowExecution({
      id: workflowId,
      name: workflowName
    });
    if (startResult.error) {
      return startResult.error;
    }
    started = startResult.started;
    queued = startResult.queued;
    blocked = startResult.blockedCount;
    startFailures = startResult.failedStarts || [];
  }

  let output = `## Feature Workflow Created${args.auto_run ? ' & Started' : ''}\n\n`;
  output += `**ID:** ${workflowId}\n`;
  output += `**Feature:** ${pascal}\n`;
  output += `**Tasks:** ${tasks.length}\n`;
  if (routingTemplate) {
    output += `**Routing Template:** ${routingTemplate}\n`;
  }
  if (args.auto_run) {
    output += `**Started:** ${started} tasks\n`;
    output += `**Queued:** ${queued} tasks\n`;
    output += `**Blocked:** ${blocked}\n`;
    if (startFailures.length > 0) {
      output += `**Tasks Failed to Start:** ${startFailures.length}\n`;
      for (const failure of startFailures) {
        output += `- ${failure.node_id || failure.task_id}: ${failure.error}\n`;
      }
    }
  }
  output += `\n### DAG\n\n`;
  output += `| Node | Step | Provider | Status |\n|------|------|----------|--------|\n`;
  for (const t of tasks) {
    const prov = t.kind === 'review'
      ? 'checkpoint'
      : (t.provider || (routingTemplate ? `via ${routingTemplate}` : 'smart routing'));
    output += `| ${t.nodeId} | ${t.step} | ${prov} | ${t.status} |\n`;
  }

  if (!args.auto_run) {
    output += `\nUse \`run_workflow\` with ID \`${workflowId}\` to start, or \`await_workflow\` to start and wait.`;
  } else {
    output += `\nUse \`await_workflow\` with ID \`${workflowId}\` to wait for completion.`;
  }

  return { content: [{ type: 'text', text: output }] };
}

module.exports = {
  init,
  handleCreateFeatureWorkflow,
};
