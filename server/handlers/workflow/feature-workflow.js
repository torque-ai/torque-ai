/**
 * Create Feature Workflow handler — extracted from workflow/index.js
 *
 * Builds a standardized feature workflow DAG:
 * types -> data -> events -> system -> tests + wire
 */

const { v4: uuidv4 } = require('uuid');
const taskCore = require('../../db/task-core');
const workflowEngine = require('../../db/workflow-engine');
const projectConfigCore = require('../../db/project-config-core');
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

/**
 * Create a standardized feature workflow following the pattern:
 * types -> data -> events -> system -> tests + wire
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
  const projectConfig = projectConfigCore ? projectConfigCore.getProjectConfig(wdir) : {};
  const adversarialReviewEnabled = projectConfig.adversarial_review === 'auto' || projectConfig.adversarial_review === 'always';
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
  const buildStepMeta = (stepProvider, extraMeta) => {
    const meta = { ...extraMeta };
    if (!stepProvider && routingTemplate) {
      meta._routing_template = routingTemplate;
    }
    return Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined;
  };

  // Step 1: Types (no deps)
  if (args.types_task) {
    const typesId = uuidv4();
    taskCore.createTask({
      id: typesId,
      task_description: args.types_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-types`,
      status: 'pending',
      provider: stepProviders.types,
      metadata: buildStepMeta(stepProviders.types, adversarialReviewEnabled ? { adversarial_review: true } : undefined),
    });
    tasks.push({ id: typesId, nodeId: `${kebab}-types`, step: 'types', provider: stepProviders.types });
  }

  // Step 2: Events (no deps, parallel with types)
  if (args.events_task) {
    const eventsId = uuidv4();
    taskCore.createTask({
      id: eventsId,
      task_description: args.events_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-events`,
      status: 'pending',
      provider: stepProviders.events,
      metadata: buildStepMeta(stepProviders.events, adversarialReviewEnabled ? { adversarial_review: true } : undefined),
    });
    tasks.push({ id: eventsId, nodeId: `${kebab}-events`, step: 'events', provider: stepProviders.events });
  }

  // Step 3: Data (depends on types)
  if (args.data_task) {
    const dataId = uuidv4();
    const typesTask = tasks.find(t => t.step === 'types');
    taskCore.createTask({
      id: dataId,
      task_description: args.data_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-data`,
      status: typesTask ? 'blocked' : 'pending',
      provider: stepProviders.data,
      metadata: buildStepMeta(stepProviders.data, adversarialReviewEnabled ? { adversarial_review: true } : undefined),
    });
    if (typesTask) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: dataId,
        depends_on_task_id: typesTask.id,
      });
    }
    tasks.push({ id: dataId, nodeId: `${kebab}-data`, step: 'data', provider: stepProviders.data });
  }

  // Step 4: System (depends on data + events)
  if (args.system_task) {
    const systemId = uuidv4();
    const dataTask = tasks.find(t => t.step === 'data');
    const eventsTask = tasks.find(t => t.step === 'events');
    const hasDeps = dataTask || eventsTask;
    taskCore.createTask({
      id: systemId,
      task_description: args.system_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-system`,
      status: hasDeps ? 'blocked' : 'pending',
      provider: stepProviders.system,
      metadata: buildStepMeta(
        stepProviders.system,
        {
          needs_review: true,
          ...(adversarialReviewEnabled ? { adversarial_review: true } : {}),
        }
      ),
    });
    if (dataTask) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: systemId,
        depends_on_task_id: dataTask.id,
      });
    }
    if (eventsTask) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: systemId,
        depends_on_task_id: eventsTask.id,
      });
    }
    tasks.push({ id: systemId, nodeId: `${kebab}-system`, step: 'system', provider: stepProviders.system });
  }

  // Step 5: Tests (depends on system)
  if (args.tests_task) {
    const testsId = uuidv4();
    const systemTask = tasks.find(t => t.step === 'system');
    taskCore.createTask({
      id: testsId,
      task_description: args.tests_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-tests`,
      status: systemTask ? 'blocked' : 'pending',
      provider: stepProviders.tests,
      metadata: buildStepMeta(stepProviders.tests),
    });
    if (systemTask) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: testsId,
        depends_on_task_id: systemTask.id,
      });
    }
    tasks.push({ id: testsId, nodeId: `${kebab}-tests`, step: 'tests', provider: stepProviders.tests });
  }

  // Step 6: Wire (depends on system, parallel with tests)
  if (args.wire_task) {
    const wireId = uuidv4();
    const systemTask = tasks.find(t => t.step === 'system');
    taskCore.createTask({
      id: wireId,
      task_description: args.wire_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-wire`,
      status: systemTask ? 'blocked' : 'pending',
      provider: stepProviders.wire,
      metadata: buildStepMeta(stepProviders.wire, adversarialReviewEnabled ? { adversarial_review: true } : undefined),
    });
    if (systemTask) {
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: wireId,
        depends_on_task_id: systemTask.id,
      });
    }
    tasks.push({ id: wireId, nodeId: `${kebab}-wire`, step: 'wire', provider: stepProviders.wire });
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
      tasks.push({ id: ptId, nodeId, step: 'parallel', provider: ptProvider });
    }
  }

  workflowEngine.updateWorkflowCounts(workflowId);

  // Auto-run if requested
  let started = 0;
  let queued = 0;
  let blocked = tasks.filter(t => t.step !== 'parallel' && !['types', 'events'].includes(t.step)).length;
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
    const prov = t.provider || (routingTemplate ? `via ${routingTemplate}` : 'smart routing');
    output += `| ${t.nodeId} | ${t.step} | ${prov} | ${t.step === 'parallel' || !tasks.find(d => d.step === 'types') ? 'pending' : (t.step === 'types' || t.step === 'events' ? 'pending' : 'blocked')} |\n`;
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
