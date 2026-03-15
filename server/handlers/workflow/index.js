/**
 * Workflow, pipeline, and template handlers
 * Extracted from tools.js
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const serverConfig = require('../../config');
const taskManager = require('../../task-manager');
const taskPolicyHooks = require('../../policy-engine/task-hooks');
const policyEngine = require('../../policy-engine/engine');
const shadowEnforcer = require('../../policy-engine/shadow-enforcer');
const {
  safeLimit,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TASK_LENGTH,
  safeDate,
  evaluateWorkflowVisibility,
  getWorkflowRestartGuardError,
  getWorkflowTaskCounts,
  requireWorkflow,
  ErrorCodes,
  makeError,
  formatTime
} = require('../shared');
const logger = require('../../logger').child({ component: 'workflow' });

const workflowTemplates = require('./templates');
const workflowDag = require('./dag');
const workflowAwait = require('./await');
const workflowAdvanced = require('./advanced');



// ============ Wave 4: Task Dependencies Handlers ============

function buildEmptyWorkflowCreationError(workflowName, nextStep, duplicatePlaceholder = null) {
  if (duplicatePlaceholder) {
    return {
      ...makeError(
        ErrorCodes.CONFLICT,
        `Workflow '${workflowName}' already has an empty ${duplicatePlaceholder.status} placeholder (${duplicatePlaceholder.id}). ${nextStep} Reuse that workflow or cancel/delete it instead of creating another empty entry.`
      )
    };
  }

  return {
    ...makeError(
      ErrorCodes.INVALID_PARAM,
      `Workflow '${workflowName}' must include at least one task before it can be created. Empty workflow placeholders are rejected to avoid pending workflow noise. ${nextStep}`
    )
  };
}

function buildEmptyWorkflowStartError(workflow) {
  return {
    ...makeError(
      ErrorCodes.INVALID_PARAM,
      `Workflow '${workflow.name}' (${workflow.id}) has no tasks and cannot be started. Add at least one workflow task before calling run_workflow, or cancel/delete the empty placeholder if it is leftover noise.`
    )
  };
}

function getEffectiveWorkflowTaskDescription(taskLike) {
  return (taskLike.task && typeof taskLike.task === 'string' && taskLike.task.trim().length > 0)
    ? taskLike.task
    : taskLike.task_description;
}

function safeParseInt(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function getPolicyBlockReason(result, fallback = 'Blocked by policy') {
  if (!result || typeof result !== 'object') return fallback;
  if (typeof result.reason === 'string' && result.reason.trim().length > 0) {
    return result.reason;
  }
  if (typeof result.error === 'string' && result.error.trim().length > 0) {
    return result.error;
  }

  const failedResult = Array.isArray(result.results)
    ? result.results.find((entry) => entry && (entry.outcome === 'fail' || entry.mode === 'block'))
    : null;
  if (!failedResult) return fallback;
  return failedResult.reason || failedResult.message || failedResult.policy_id || fallback;
}

function buildWorkflowTaskMetadata(taskLike) {
  const metaObj = {};
  if (Array.isArray(taskLike.context_from) && taskLike.context_from.length > 0) {
    metaObj.context_from = taskLike.context_from.slice();
  }
  if (taskLike.provider) {
    metaObj.user_provider_override = true;
  }
  return metaObj;
}

function evaluateWorkflowTaskSubmissionPolicy(taskLike, workflowId, workflowWorkingDirectory) {
  if (typeof taskPolicyHooks.evaluateTaskSubmissionPolicy !== 'function') {
    return null;
  }

  const defaultTimeout = safeParseInt(serverConfig.getInt('default_timeout', 30), 30, 1, 120);
  const resolvedTimeout = safeParseInt(
    taskLike.timeout_minutes === undefined ? defaultTimeout : taskLike.timeout_minutes,
    defaultTimeout,
    1,
    120
  );

  return taskPolicyHooks.evaluateTaskSubmissionPolicy({
    id: taskLike.id || taskLike.task_id || uuidv4(),
    task_description: taskLike.task_description,
    working_directory: taskLike.working_directory || workflowWorkingDirectory || null,
    timeout_minutes: resolvedTimeout,
    auto_approve: Boolean(taskLike.auto_approve),
    priority: taskLike.priority || 0,
    provider: taskLike.provider || null,
    model: taskLike.model || null,
    metadata: buildWorkflowTaskMetadata(taskLike),
    workflow_id: workflowId,
    workflow_node_id: taskLike.node_id || taskLike.workflow_node_id || null,
  });
}

function buildRejectedWorkflowTask(taskLike, reason) {
  return {
    node_id: taskLike.node_id || taskLike.workflow_node_id || null,
    task_description: taskLike.task_description || null,
    provider: taskLike.provider || null,
    reason,
  };
}

function appendRejectedTasks(output, rejectedTasks) {
  if (!Array.isArray(rejectedTasks) || rejectedTasks.length === 0) {
    return output;
  }

  output += `**Rejected Tasks:** ${rejectedTasks.length}\n`;
  for (const rejectedTask of rejectedTasks) {
    output += `- ${rejectedTask.node_id || '(auto)'}: ${rejectedTask.reason}\n`;
  }
  return output;
}

function evaluateWorkflowPolicyStage(stage, workflowData) {
  if (!shadowEnforcer.isEngineEnabled()) {
    return { skipped: true, reason: 'policy_engine_disabled', blocked: false };
  }

  const context = {
    ...workflowData,
    stage,
    target_type: 'workflow',
    target_id: workflowData.id || workflowData.workflow_id || workflowData.target_id || 'unknown',
    project_id: workflowData.project || workflowData.project_id || null,
    project_path: workflowData.working_directory || workflowData.workingDirectory || null,
    provider: workflowData.provider || null,
    changed_files: workflowData.changed_files || workflowData.changedFiles || null,
    evidence: workflowData.evidence || {},
    persist: true,
  };

  try {
    const result = policyEngine.evaluatePolicies(context);
    if (result.total_results === 0) {
      logger.warn(`[workflow-handlers] No policies configured for ${stage}; continuing fail-open`);
    }
    if (shadowEnforcer.isShadowOnly()) {
      if (result.summary.failed > 0 || result.summary.warned > 0) {
        logger.info(`[Shadow] ${stage}: ${result.summary.failed} fail, ${result.summary.warned} warn (non-blocking)`);
      }
      return { ...result, shadow: true, blocked: false };
    }
    return { ...result, shadow: false, blocked: result.summary.blocked > 0 };
  } catch (err) {
    logger.warn(`[workflow-handlers] Policy evaluation error at ${stage}: ${err.message}`);
    return { skipped: true, reason: 'evaluation_error', error: err.message, blocked: false };
  }
}

function buildWorkflowStartFailure(task, error) {
  return {
    task_id: task.id,
    node_id: task.workflow_node_id || task.node_id || null,
    provider: task.provider || null,
    error: error?.message || String(error)
  };
}

function isQueuedStartResult(result) {
  return Boolean(result && typeof result === 'object' && result.queued === true);
}

function classifyWorkflowStartOutcome(taskId, startResult) {
  if (isQueuedStartResult(startResult)) {
    return 'queued';
  }

  const updatedTask = db.getTask(taskId);
  if (updatedTask?.status === 'queued') {
    return 'queued';
  }
  if (updatedTask?.status === 'running') {
    return 'started';
  }
  if (updatedTask?.status && ['cancelled', 'failed', 'blocked', 'skipped', 'completed'].includes(updatedTask.status)) {
    return 'not_started';
  }

  // Test doubles do not always mutate task status like the real runtime path.
  return 'started';
}

function validateDependencyList(value, fieldName, nodeId, workflowId) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `${fieldName} must be an array for node '${nodeId || '(auto)'}' in workflow '${workflowId}'; received ${typeof value}`
    );
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      return makeError(
        ErrorCodes.INVALID_PARAM,
        `${fieldName} elements must be strings for node '${nodeId || '(auto)'}' in workflow '${workflowId}'; received ${typeof item}`
      );
    }
  }
  return null;
}

function hasWorkflowTaskCycle(taskDefs) {
  const depGraph = {};
  for (const task of taskDefs) {
    depGraph[task.node_id] = task.depends_on.slice();
  }

  const visited = new Set();
  const stack = new Set();

  function visit(nodeId) {
    if (stack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    stack.add(nodeId);
    for (const depNodeId of depGraph[nodeId] || []) {
      if (visit(depNodeId)) return true;
    }
    stack.delete(nodeId);
    return false;
  }

  for (const nodeId of Object.keys(depGraph)) {
    if (visit(nodeId)) return true;
  }
  return false;
}

function normalizeInitialWorkflowTasks(taskDefs, workflowId, workflowWorkingDirectory = null) {
  const normalized = [];
  const seenNodeIds = new Set();

  for (let i = 0; i < taskDefs.length; i++) {
    const taskDef = taskDefs[i];
    if (!taskDef || typeof taskDef !== 'object' || Array.isArray(taskDef)) {
      return {
        ...makeError(
          ErrorCodes.INVALID_PARAM,
          `tasks[${i}] must be an object with node_id and task_description fields`
        )
      };
    }

    const nodeId = typeof taskDef.node_id === 'string' ? taskDef.node_id.trim() : '';
    if (!nodeId) {
      return {
        ...makeError(
          ErrorCodes.INVALID_PARAM,
          `tasks[${i}].node_id must be a non-empty string when creating workflow '${workflowId}'`
        )
      };
    }
    if (seenNodeIds.has(nodeId)) {
      return {
        ...makeError(
          ErrorCodes.CONFLICT,
          `Duplicate workflow node_id '${nodeId}' in create_workflow payload for workflow '${workflowId}'`
        )
      };
    }
    seenNodeIds.add(nodeId);

    const effectiveDescription = getEffectiveWorkflowTaskDescription(taskDef);
    if (!effectiveDescription || typeof effectiveDescription !== 'string' || effectiveDescription.trim().length === 0) {
      return {
        ...makeError(
          ErrorCodes.INVALID_PARAM,
          `Invalid task_description for node '${nodeId}' in workflow '${workflowId}': expected a non-empty string`
        )
      };
    }
    if (effectiveDescription.length > MAX_TASK_LENGTH) {
      return {
        ...makeError(
          ErrorCodes.PARAM_TOO_LONG,
          `task_description for node '${nodeId}' in workflow '${workflowId}' is ${effectiveDescription.length} characters; maximum is ${MAX_TASK_LENGTH}`
        )
      };
    }

    const dependsOnError = validateDependencyList(taskDef.depends_on, 'depends_on', nodeId, workflowId);
    if (dependsOnError) return dependsOnError;

    const contextFromError = validateDependencyList(taskDef.context_from, 'context_from', nodeId, workflowId);
    if (contextFromError) return contextFromError;

    normalized.push({
      ...taskDef,
      id: uuidv4(),
      node_id: nodeId,
      task_description: effectiveDescription,
      depends_on: Array.isArray(taskDef.depends_on) ? taskDef.depends_on.slice() : [],
      context_from: Array.isArray(taskDef.context_from) ? taskDef.context_from.slice() : [],
    });
  }

  const nodeIds = new Set(normalized.map(task => task.node_id));
  for (const task of normalized) {
    for (const depNodeId of task.depends_on) {
      if (!nodeIds.has(depNodeId)) {
        return {
          ...makeError(
            ErrorCodes.RESOURCE_NOT_FOUND,
            `Dependency not found: ${depNodeId} for node '${task.node_id}' in workflow '${workflowId}'. Make sure every dependency is included in the create_workflow task list.`
          )
        };
      }
    }
    if (task.alternate_node_id && !nodeIds.has(task.alternate_node_id)) {
      return {
        ...makeError(
          ErrorCodes.RESOURCE_NOT_FOUND,
          `Alternate dependency node not found: ${task.alternate_node_id} for node '${task.node_id}' in workflow '${workflowId}'`
        )
      };
    }
  }

  if (hasWorkflowTaskCycle(normalized)) {
    return {
      ...makeError(
        ErrorCodes.INVALID_PARAM,
        `Circular dependency detected in create_workflow payload for workflow '${workflowId}'`
      )
    };
  }

  // Validate provider overrides for each task
  for (const task of normalized) {
    if (task.provider) {
      const providerErr = validateProviderOverride(task.provider);
      if (providerErr) {
        return { ...providerErr };
      }
    }
  }

  const acceptedTasks = [];
  const rejectedTasks = [];
  const rejectedNodeReasons = new Map();

  for (const task of normalized) {
    const policyResult = evaluateWorkflowTaskSubmissionPolicy(task, workflowId, workflowWorkingDirectory);
    if (policyResult?.blocked === true) {
      const reason = getPolicyBlockReason(policyResult, 'Task blocked by policy');
      rejectedTasks.push(buildRejectedWorkflowTask(task, reason));
      rejectedNodeReasons.set(task.node_id, reason);
      continue;
    }
    acceptedTasks.push(task);
  }

  let filteredTasks = acceptedTasks;
  let removedForDependencies = true;
  while (removedForDependencies) {
    removedForDependencies = false;
    const availableNodeIds = new Set(filteredTasks.map((task) => task.node_id));
    const nextTasks = [];

    for (const task of filteredTasks) {
      const missingDependency = task.depends_on.find((depNodeId) => !availableNodeIds.has(depNodeId));
      if (missingDependency) {
        const dependencyReason = rejectedNodeReasons.get(missingDependency);
        const reason = dependencyReason
          ? `Dependency '${missingDependency}' was rejected: ${dependencyReason}`
          : `Dependency '${missingDependency}' is not available after policy evaluation`;
        rejectedTasks.push(buildRejectedWorkflowTask(task, reason));
        rejectedNodeReasons.set(task.node_id, reason);
        removedForDependencies = true;
        continue;
      }

      if (task.alternate_node_id && !availableNodeIds.has(task.alternate_node_id)) {
        const alternateReason = rejectedNodeReasons.get(task.alternate_node_id);
        const reason = alternateReason
          ? `Alternate node '${task.alternate_node_id}' was rejected: ${alternateReason}`
          : `Alternate node '${task.alternate_node_id}' is not available after policy evaluation`;
        rejectedTasks.push(buildRejectedWorkflowTask(task, reason));
        rejectedNodeReasons.set(task.node_id, reason);
        removedForDependencies = true;
        continue;
      }

      nextTasks.push(task);
    }

    filteredTasks = nextTasks;
  }

  return { tasks: filteredTasks, rejected_tasks: rejectedTasks };
}

function validateProviderOverride(provider) {
  if (!provider) return null;
  const providerConfig = db.getProvider(provider);
  if (!providerConfig) {
    return makeError(
      ErrorCodes.RESOURCE_NOT_FOUND,
      `Unknown provider: ${provider}. Use list_providers to see available providers.`
    );
  }
  if (!providerConfig.enabled) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Provider '${provider}' is currently disabled. Enable it first or choose a different provider.`
    );
  }
  return null;
}

function createSeededWorkflowTasks(workflowId, workflowWorkingDirectory, taskDefs) {
  const defaultTimeout = safeParseInt(serverConfig.getInt('default_timeout', 30), 30, 1, 120);
  const nodeToTaskMap = {};

  for (const taskDef of taskDefs) {
    const taskId = taskDef.id || uuidv4();
    nodeToTaskMap[taskDef.node_id] = taskId;

    const metaObj = buildWorkflowTaskMetadata(taskDef);
    const metadata = Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null;

    const resolvedTimeout = safeParseInt(
      taskDef.timeout_minutes === undefined ? defaultTimeout : taskDef.timeout_minutes,
      defaultTimeout,
      1,
      120
    );

    db.createTask({
      id: taskId,
      status: taskDef.depends_on.length > 0 ? 'blocked' : 'pending',
      task_description: taskDef.task_description,
      working_directory: taskDef.working_directory || workflowWorkingDirectory,
      timeout_minutes: resolvedTimeout,
      auto_approve: taskDef.auto_approve || false,
      tags: taskDef.tags || [],
      workflow_id: workflowId,
      workflow_node_id: taskDef.node_id,
      provider: taskDef.provider,
      model: taskDef.model,
      metadata
    });
  }

  for (const taskDef of taskDefs) {
    if (taskDef.depends_on.length === 0) continue;
    const taskId = nodeToTaskMap[taskDef.node_id];
    for (const depNodeId of taskDef.depends_on) {
      db.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskId,
        depends_on_task_id: nodeToTaskMap[depNodeId],
        condition_expr: taskDef.condition,
        on_fail: taskDef.on_fail || 'skip',
        alternate_task_id: taskDef.alternate_node_id ? nodeToTaskMap[taskDef.alternate_node_id] : null
      });
    }
  }

  db.updateWorkflowCounts(workflowId);
}

function startWorkflowExecution(workflow) {
  const tasks = db.getWorkflowTasks(workflow.id);
  if (tasks.length === 0) {
    return { error: buildEmptyWorkflowStartError(workflow) };
  }

  db.updateWorkflow(workflow.id, {
    status: 'running',
    started_at: new Date().toISOString()
  });

  let started = 0;
  let queued = 0;
  let attemptedToStart = 0;
  const failedStarts = [];

  for (const task of tasks) {
    if (task.status === 'pending') {
      try {
        attemptedToStart += 1;
        const startResult = taskManager.startTask(task.id);
        const startOutcome = classifyWorkflowStartOutcome(task.id, startResult);
        if (startOutcome === 'queued') {
          queued += 1;
          continue;
        }
        if (startOutcome === 'started') {
          started += 1;
        }
      } catch (err) {
        failedStarts.push(buildWorkflowStartFailure(task, err));
        logger.debug('[workflow-handlers] non-critical error starting workflow task in batch:', err.message || err);
      }
    }
  }

  if (attemptedToStart > 0 && started === 0 && queued === 0) {
    const error = makeError(
      ErrorCodes.OPERATION_FAILED,
      `Failed to start workflow '${workflow.name}' (${workflow.id}). No workflow tasks could be started in this run.`,
      failedStarts
    );
    return {
      error: error,
      start_failures: failedStarts
    };
  }

  return {
    tasks,
    started,
    queued,
    blockedCount: tasks.filter(task => task.status === 'blocked').length,
    failedStarts
  };
}

/**
 * Create a new workflow
 */
function handleCreateWorkflow(args) {
  // Input validation
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'name must be a non-empty string');
  }
  if (args.name.length > MAX_NAME_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  if (args.description !== undefined && typeof args.description !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'description must be a string');
  }
  if (args.description && args.description.length > MAX_DESCRIPTION_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `description must be ${MAX_DESCRIPTION_LENGTH} characters or less`);
  }
  if (args.priority !== undefined && typeof args.priority !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'priority must be a number');
  }

  const trimmedName = args.name.trim();
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    const duplicatePlaceholder = db.findEmptyWorkflowPlaceholder(trimmedName, 'pending');
    return buildEmptyWorkflowCreationError(
      trimmedName,
      'Provide a non-empty tasks array in create_workflow, or use create_feature_workflow / instantiate_template to seed the DAG.',
      duplicatePlaceholder
    );
  }

  const workflowId = uuidv4();
  const normalizedTasks = normalizeInitialWorkflowTasks(args.tasks, workflowId, args.working_directory);
  if (normalizedTasks.error_code) {
    return normalizedTasks;
  }
  if (normalizedTasks.tasks.length === 0) {
    return {
      ...makeError(
        ErrorCodes.OPERATION_FAILED,
        `Workflow '${trimmedName}' was not created because every initial task was rejected by policy.`,
        { rejected_tasks: normalizedTasks.rejected_tasks }
      ),
      rejected_tasks: normalizedTasks.rejected_tasks
    };
  }

  const workflowPolicyResult = evaluateWorkflowPolicyStage('workflow_submit', {
    id: workflowId,
    name: trimmedName,
    description: args.description,
    priority: args.priority || 0,
    working_directory: args.working_directory || null,
    evidence: {
      requested_task_count: Array.isArray(args.tasks) ? args.tasks.length : 0,
      accepted_task_count: normalizedTasks.tasks.length,
      rejected_task_count: normalizedTasks.rejected_tasks.length,
    },
  });
  if (workflowPolicyResult?.blocked === true) {
    return makeError(
      ErrorCodes.OPERATION_FAILED,
      getPolicyBlockReason(workflowPolicyResult, 'Workflow blocked by policy')
    );
  }

  db.createWorkflow({
    id: workflowId,
    name: trimmedName,
    description: args.description,
    working_directory: args.working_directory,
    priority: args.priority
  });
  createSeededWorkflowTasks(workflowId, args.working_directory, normalizedTasks.tasks);

  let output = `## Workflow Created\n\n`;
  output += `**ID:** ${workflowId}\n`;
  output += `**Name:** ${trimmedName}\n`;
  output += `**Tasks:** ${normalizedTasks.tasks.length}\n`;
  if (args.description) output += `**Description:** ${args.description}\n`;
  output = appendRejectedTasks(output, normalizedTasks.rejected_tasks);
  output += `\nUse \`run_workflow\` to start this workflow, or \`add_workflow_task\` to extend it.`;

  return {
    content: [{ type: 'text', text: output }],
    rejected_tasks: normalizedTasks.rejected_tasks
  };
}


/**
 * Add a task to a workflow
 */
function handleAddWorkflowTask(args) {
  // Support both 'task' (full prompt, from REST/MCP submit_task convention)
  // and 'task_description' (from MCP add_workflow_task convention).
  // When both are provided, 'task' is the full prompt and 'task_description' is just a label.
  const effectiveDescription = (args.task && typeof args.task === 'string' && args.task.trim().length > 0)
    ? args.task
    : args.task_description;

  // Input validation
  if (!effectiveDescription || typeof effectiveDescription !== 'string' || effectiveDescription.trim().length === 0) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Invalid task_description for node '${args.node_id || '(auto)'}' in workflow '${args.workflow_id}': expected a non-empty string`
    );
  }
  if (effectiveDescription.length > MAX_TASK_LENGTH) {
    return makeError(
      ErrorCodes.PARAM_TOO_LONG,
      `task_description for node '${args.node_id || '(auto)'}' in workflow '${args.workflow_id}' is ${effectiveDescription.length} characters; maximum is ${MAX_TASK_LENGTH}`
    );
  }
  if (args.depends_on !== undefined && !Array.isArray(args.depends_on)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `depends_on must be an array for node '${args.node_id || '(auto)'}' in workflow '${args.workflow_id}'; received ${typeof args.depends_on}`
    );
  }
  if (Array.isArray(args.depends_on)) {
    for (const dep of args.depends_on) {
      if (typeof dep !== 'string') {
        return makeError(
          ErrorCodes.INVALID_PARAM,
          `depends_on elements must be strings for node '${args.node_id || '(auto)'}' in workflow '${args.workflow_id}'; received ${typeof dep}`
        );
      }
    }
  }

  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  // Validate provider override if specified
  if (args.provider) {
    const providerErr = validateProviderOverride(args.provider);
    if (providerErr) return providerErr;
  }

  // Create the task with error handling
  const taskId = uuidv4();
  const defaultTimeout = safeParseInt(serverConfig.getInt('default_timeout', 30), 30, 1, 120);
  const hasTimeoutOverride = args.timeout_minutes !== undefined;
  const resolvedTimeout = safeParseInt(
    hasTimeoutOverride ? args.timeout_minutes : defaultTimeout,
    defaultTimeout,
    1,
    120
  );

  const hasDependencies = args.depends_on && args.depends_on.length > 0;
  const taskStartFailures = [];

  // Inherit working_directory from workflow when not explicitly set on the task
  const taskWorkingDirectory = args.working_directory || workflow.working_directory;

  // Build metadata with context_from and provider override flag
  const policyTask = {
    id: taskId,
    node_id: args.node_id,
    task_description: effectiveDescription,
    working_directory: taskWorkingDirectory,
    timeout_minutes: resolvedTimeout,
    auto_approve: args.auto_approve || false,
    tags: args.tags || [],
    provider: args.provider,
    model: args.model,
    context_from: Array.isArray(args.context_from) ? args.context_from.slice() : [],
  };
  const policyResult = evaluateWorkflowTaskSubmissionPolicy(policyTask, args.workflow_id, workflow.working_directory);
  if (policyResult?.blocked === true) {
    const rejectedTask = buildRejectedWorkflowTask(
      policyTask,
      getPolicyBlockReason(policyResult, 'Task blocked by policy')
    );
    let output = `## Task Rejected by Policy\n\n`;
    output += `**Node ID:** ${args.node_id || '(auto)'}\n`;
    output += `**Workflow:** ${workflow.name}\n`;
    output += `**Reason:** ${rejectedTask.reason}\n`;
    return {
      content: [{ type: 'text', text: output }],
      rejected_tasks: [rejectedTask]
    };
  }

  const metaObj = buildWorkflowTaskMetadata(policyTask);
  const metadata = Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null;

  try {
    db.createTask({
      id: taskId,
      status: hasDependencies ? 'blocked' : 'pending',
      task_description: effectiveDescription,
      working_directory: taskWorkingDirectory,
      timeout_minutes: resolvedTimeout,
      auto_approve: args.auto_approve || false,
      tags: args.tags || [],
      workflow_id: args.workflow_id,
      workflow_node_id: args.node_id,
      provider: args.provider,
      model: args.model,
      metadata
    });
  } catch (err) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Failed to create task: ${err.message}`)
    };
  }

  // Add dependencies if specified
  if (hasDependencies) {
    // Find task IDs for the node_ids we depend on
    const workflowTasks = db.getWorkflowTasks(args.workflow_id);
    const nodeToTaskMap = {};
    for (const t of workflowTasks) {
      if (t.workflow_node_id) {
        nodeToTaskMap[t.workflow_node_id] = t.id;
      }
    }

    // RB-049: Detect circular dependencies before adding them
    const depGraph = {}; // nodeId -> [dependsOnNodeIds]
    for (const t of workflowTasks) {
      if (t.workflow_node_id) depGraph[t.workflow_node_id] = [];
    }
    // Build existing dependency edges
    for (const t of workflowTasks) {
      if (t.workflow_node_id) {
        const deps = db.getTaskDependencies ? db.getTaskDependencies(t.id) : [];
        for (const d of deps) {
          const depNode = workflowTasks.find(wt => wt.id === d.depends_on_task_id);
          if (depNode && depNode.workflow_node_id) {
            depGraph[t.workflow_node_id].push(depNode.workflow_node_id);
          }
        }
      }
    }
    // Add proposed edges for the new task
    const newNodeId = args.node_id || taskId;
    depGraph[newNodeId] = args.depends_on.slice();
    // DFS cycle check
    function hasCycle(node, visited, stack) {
      visited.add(node);
      stack.add(node);
      for (const dep of (depGraph[node] || [])) {
        if (stack.has(dep)) return true;
        if (!visited.has(dep) && hasCycle(dep, visited, stack)) return true;
      }
      stack.delete(node);
      return false;
    }
    const visited = new Set(), recStack = new Set();
    for (const node of Object.keys(depGraph)) {
      if (!visited.has(node) && hasCycle(node, visited, recStack)) {
        return makeError(ErrorCodes.INVALID_PARAM, `Circular dependency detected: adding ${newNodeId} -> [${args.depends_on.join(', ')}] creates a cycle`);
      }
    }

    for (const depNodeId of args.depends_on) {
      const depTaskId = nodeToTaskMap[depNodeId];
      if (!depTaskId) {
        return makeError(
          ErrorCodes.RESOURCE_NOT_FOUND,
          `Dependency not found: ${depNodeId} for node '${newNodeId}' in workflow '${args.workflow_id}'. Make sure dependent tasks are added first.`
        );
      }

      db.addTaskDependency({
        workflow_id: args.workflow_id,
        task_id: taskId,
        depends_on_task_id: depTaskId,
        condition_expr: args.condition,
        on_fail: args.on_fail || 'skip',
        alternate_task_id: args.alternate_node_id ? nodeToTaskMap[args.alternate_node_id] : null
      });
    }
  }

  // Update workflow task count
  db.updateWorkflowCounts(args.workflow_id);

  // Re-open completed/failed workflows when new tasks are added (extends the workflow)
  if (['completed', 'failed'].includes(workflow.status)) {
    db.updateWorkflow(args.workflow_id, { status: 'running', completed_at: null });
  }

  // If workflow is running or completed, auto-start the new task when possible
  // (completed workflows get extended when new tasks are added mid-review)
  let actualStatus = hasDependencies ? 'blocked' : 'pending';
  const workflowActive = ['running', 'completed', 'failed'].includes(workflow.status);
  if (workflowActive) {
    const terminalStates = ['completed', 'failed', 'cancelled', 'skipped'];
    if (hasDependencies) {
      // Check if all dependencies are already terminal
      const freshTasks = db.getWorkflowTasks(args.workflow_id);
      const allDepsTerminal = args.depends_on.every(nodeId => {
        const depTask = freshTasks.find(t => t.workflow_node_id === nodeId);
        return depTask && terminalStates.includes(depTask.status);
      });
      if (allDepsTerminal) {
        taskManager.unblockTask(taskId);
        const updated = db.getTask(taskId);
        actualStatus = updated ? updated.status : 'pending';
      }
    } else {
      // No deps and workflow is running → start immediately
      try {
        const startResult = taskManager.startTask(taskId);
        const updated = db.getTask(taskId);
        if (isQueuedStartResult(startResult)) {
          actualStatus = updated && updated.status && updated.status !== 'pending'
            ? updated.status
            : 'queued';
        } else {
          actualStatus = updated ? updated.status : 'pending';
        }
      } catch (err) {
        taskStartFailures.push({
          task_id: taskId,
          node_id: args.node_id || null,
          provider: args.provider || null,
          error: err?.message || String(err)
        });
        // startTask may fail if at capacity — task stays pending, processQueue will pick it up
        logger.debug('[workflow-handlers] non-critical error starting workflow task:', err.message || err);
      }
    }
  }

  let output = `## Task Added to Workflow\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Node ID:** ${args.node_id}\n`;
  output += `**Workflow:** ${workflow.name}\n`;
  output += `**Status:** ${actualStatus}\n`;

  if (hasDependencies) {
    output += `**Depends On:** ${args.depends_on.join(', ')}\n`;
    if (args.condition) output += `**Condition:** \`${args.condition}\`\n`;
    output += `**On Fail:** ${args.on_fail || 'skip'}\n`;
  }

  if (Array.isArray(args.context_from) && args.context_from.length > 0) {
    output += `**Context From:** ${args.context_from.join(', ')}\n`;
  }

  if (taskStartFailures.length > 0) {
    output += `**Start Failures:** ${taskStartFailures.length}\n`;
    for (const failure of taskStartFailures) {
      output += `- ${failure.node_id || failure.task_id}: ${failure.error}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }],
    start_failures: taskStartFailures
  };
}


/**
 * Start workflow execution
 */
function handleRunWorkflow(args) {
  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  if (workflow.status === 'running') {
    return {
      ...makeError(ErrorCodes.TASK_ALREADY_RUNNING, `Workflow already running: ${args.workflow_id}`)
    };
  }

  const workflowStatus = db.getWorkflowStatus(args.workflow_id) || workflow;
  const restartGuard = getWorkflowRestartGuardError(workflowStatus, {
    allowFreshPendingStart: true,
    allowPausedResume: true,
    attemptedAction: 'restart this workflow'
  });
  if (restartGuard) {
    return restartGuard;
  }

  const workflowPolicyResult = evaluateWorkflowPolicyStage('workflow_run', {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    working_directory: workflow.working_directory || null,
    status: workflow.status,
  });
  if (workflowPolicyResult?.blocked === true) {
    return makeError(
      ErrorCodes.OPERATION_FAILED,
      getPolicyBlockReason(workflowPolicyResult, 'Workflow blocked by policy')
    );
  }

  // No concurrent workflow limit — tasks queue naturally via the task scheduler
  const startResult = startWorkflowExecution(workflow);
  if (startResult.error) {
    return startResult.error;
  }

  let output = `## Workflow Started\n\n`;
  output += `**Workflow:** ${workflow.name}\n`;
  output += `**ID:** ${args.workflow_id}\n`;
  output += `**Total Tasks:** ${startResult.tasks.length}\n`;
  output += `**Tasks Started:** ${startResult.started}\n`;
  output += `**Tasks Queued:** ${startResult.queued}\n`;
  output += `**Blocked Tasks:** ${startResult.blockedCount}\n`;
  if (startResult.failedStarts && startResult.failedStarts.length > 0) {
    output += `**Tasks Failed to Start:** ${startResult.failedStarts.length}\n`;
    for (const failure of startResult.failedStarts) {
      output += `- ${failure.node_id || failure.task_id}: ${failure.error}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }],
    start_failures: startResult.failedStarts || []
  };
}


/**
 * Get workflow status
 */
function handleWorkflowStatus(args) {
  if (typeof db.reconcileStaleWorkflows === 'function') {
    db.reconcileStaleWorkflows(args.workflow_id);
  }
  const status = db.getWorkflowStatus(args.workflow_id);
  if (!status) {
    return {
      ...makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${args.workflow_id}`)
    };
  }

  const visibility = evaluateWorkflowVisibility(status);
  const counts = getWorkflowTaskCounts(status);
  let output = `## Workflow Status: ${status.name}\n\n`;
  output += `**ID:** ${status.id}\n`;
  output += `**Status:** ${status.status}\n`;
  output += `**Visibility:** ${visibility.label}\n`;
  output += `**Actionable:** ${visibility.actionable ? 'Yes' : 'No'}\n`;
  if (status.started_at) output += `**Started:** ${formatTime(status.started_at)}\n`;
  if (status.completed_at) output += `**Completed:** ${formatTime(status.completed_at)}\n`;
  output += `**Reason:** ${visibility.reason}\n`;
  output += `**Next Step:** ${visibility.next_step}\n`;

  output += `\n### Task Summary\n\n`;
  output += `| Status | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Completed | ${counts.completed} |\n`;
  output += `| Running | ${counts.running} |\n`;
  output += `| Pending | ${counts.pending} |\n`;
  output += `| Queued | ${counts.queued} |\n`;
  output += `| Blocked | ${counts.blocked} |\n`;
  if (counts.pending_provider_switch > 0) {
    output += `| Pending Switch | ${counts.pending_provider_switch} |\n`;
  }
  output += `| Failed | ${counts.failed} |\n`;
  output += `| Skipped | ${counts.skipped} |\n`;
  output += `| Cancelled | ${counts.cancelled} |\n`;
  output += `| **Total** | **${counts.total}** |\n`;

  // Show task details
  const taskList = Object.values(status.tasks);
  if (taskList.length > 0 && taskList.length <= 20) {
    output += `\n### Tasks\n\n`;
    output += `| Node | Status | Progress | Provider |\n`;
    output += `|------|--------|----------|----------|\n`;

    for (const task of taskList) {
      const nodeId = task.node_id || task.id.substring(0, 8);
      // TDA-13: Surface provider context so operators know what action is needed
      let providerCol = task.provider || '';
      if (task.status === 'pending_provider_switch') {
        const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
        const reason = meta._provider_switch_reason || meta.provider_switch_reason || '';
        providerCol = reason || `${task.provider || '?'} (switch pending)`;
      }
      output += `| ${nodeId} | ${task.status} | ${task.progress || 0}% | ${providerCol} |\n`;
    }
  }

  // ASCII DAG visualization
  const taskList2 = Object.values(status.tasks);
  if (taskList2.length > 0 && taskList2.length <= 50) {
    output += '\n## Task Graph\n```\n';
    for (const task of taskList2) {
      const deps = task.depends_on ? (typeof task.depends_on === 'string' ? JSON.parse(task.depends_on) : task.depends_on) : [];
      const status_icon = task.status === 'completed' ? '\u2713' : task.status === 'running' ? '\u2192' : task.status === 'failed' ? '\u2717' : '\u25CB';
      output += `${status_icon} ${task.node_id || task.id.slice(0, 8)} ${deps.length ? '<- [' + deps.join(', ') + ']' : ''}\n`;
    }
    output += '```\n';
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Cancel a workflow
 */
function handleCancelWorkflow(args) {
  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  const tasks = db.getWorkflowTasks(args.workflow_id);
  let cancelled = 0;

  for (const task of tasks) {
    // Re-fetch current status: cancelling a running task triggers handleWorkflowTermination
    // which may change dependent tasks' statuses (e.g. blocked -> skipped) mid-loop
    const current = db.getTask(task.id);
    const currentStatus = current ? current.status : task.status;
    if (['pending', 'running', 'blocked', 'queued', 'pending_provider_switch'].includes(currentStatus)) {
      if (currentStatus === 'running') {
        taskManager.cancelTask(task.id, args.reason || 'Workflow cancelled');
      } else {
        db.updateTaskStatus(task.id, 'cancelled');
      }
      cancelled++;
    }
  }

  db.updateWorkflow(args.workflow_id, {
    status: 'cancelled',
    completed_at: new Date().toISOString()
  });

  let output = `## Workflow Cancelled\n\n`;
  output += `**Workflow:** ${workflow.name}\n`;
  output += `**Tasks Cancelled:** ${cancelled}\n`;
  if (args.reason) output += `**Reason:** ${args.reason}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Pause a workflow
 */
function handlePauseWorkflow(args) {
  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  if (workflow.status !== 'running') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Workflow is not running. Current status: ${workflow.status}`)
    };
  }

  db.updateWorkflow(args.workflow_id, { status: 'paused' });

  let output = `## Workflow Paused\n\n`;
  output += `**Workflow:** ${workflow.name}\n`;
  output += `**Note:** Running tasks will complete, but no new tasks will start.\n`;
  output += `Use \`run_workflow\` to resume.`;

  return {
    content: [{ type: 'text', text: output }]
  };
}

/**
 * List workflows
 */
function handleListWorkflows(args) {
  if (typeof db.reconcileStaleWorkflows === 'function') {
    db.reconcileStaleWorkflows();
  }
  const workflows = db.listWorkflows({
    status: args.status,
    template_id: args.template_id,
    since: safeDate(args.since),
    limit: safeLimit(args.limit, 20)
  });

  if (workflows.length === 0) {
    return {
      content: [{ type: 'text', text: `No workflows found.` }]
    };
  }

  const annotated = workflows.map((workflow) => {
    const detailed = db.getWorkflowStatus(workflow.id) || workflow;
    const visibility = evaluateWorkflowVisibility(detailed);
    const counts = visibility.counts || getWorkflowTaskCounts(detailed);
    return { workflow, visibility, counts };
  });

  const hygiene = annotated.filter(entry => entry.visibility.state === 'hygiene');
  const actionable = annotated.filter(entry => entry.visibility.state === 'actionable' || entry.visibility.state === 'paused');
  const quiet = annotated.filter(entry => entry.visibility.state === 'quiet');

  function renderSection(title, rows) {
    if (rows.length === 0) return '';
    let section = `### ${title}\n\n`;
    section += `| Name | Status | Open/Total | Visibility | Created |\n`;
    section += `|------|--------|------------|------------|---------|\n`;
    for (const entry of rows) {
      const created = new Date(entry.workflow.created_at).toLocaleDateString();
      section += `| ${entry.workflow.name} | ${entry.workflow.status} | ${entry.counts.open}/${entry.counts.total} | ${entry.visibility.label} | ${created} |\n`;
    }
    return section + '\n';
  }

  let output = `## Workflows\n\n`;
  output += `**Actionable:** ${actionable.length} | **Hygiene Issues:** ${hygiene.length} | **Quiet:** ${quiet.length}\n\n`;
  output += renderSection('Actionable Workflows', actionable);
  output += renderSection('Workflow Hygiene Issues', hygiene);
  output += renderSection('Quiet Workflows', quiet);

  return {
    content: [{ type: 'text', text: output.trimEnd() }]
  };
}


/**
 * Get workflow execution history
 */
function handleWorkflowHistory(args) {
  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  const events = db.getWorkflowHistory(args.workflow_id);

  let output = `## Workflow History: ${workflow.name}\n\n`;

  if (events.length === 0) {
    output += `No events recorded.`;
    return { content: [{ type: 'text', text: output }] };
  }

  output += `| Time | Event | Task | Details |\n`;
  output += `|------|-------|------|--------|\n`;

  for (const event of events) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const node = event.node_id || event.task_id?.substring(0, 8) || '-';
    const details = event.details?.substring(0, 30) || (event.exit_code !== undefined ? `exit: ${event.exit_code}` : '-');
    output += `| ${time} | ${event.type} | ${node} | ${details} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ============ Create Feature Workflow (templated DAG) ============

/**
 * Create a standardized feature workflow following the pattern:
 * types → data → events → system → tests + wire
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
  const stepProviders = args.step_providers || {};
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
    const duplicatePlaceholder = db.findEmptyWorkflowPlaceholder(workflowName, 'pending');
    return buildEmptyWorkflowCreationError(
      workflowName,
      'Set at least one of types_task, events_task, data_task, system_task, tests_task, wire_task, or parallel_tasks before creating the feature workflow.',
      duplicatePlaceholder
    );
  }

  // Create workflow
  const workflowId = uuidv4();
  db.createWorkflow({
    id: workflowId,
    name: workflowName,
    description: args.description || `Auto-generated feature workflow for ${pascal}`
  });

  const tasks = [];

  // Step 1: Types (no deps)
  if (args.types_task) {
    const typesId = uuidv4();
    db.createTask({
      id: typesId,
      task_description: args.types_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-types`,
      status: 'pending',
      provider: stepProviders.types
    });
    tasks.push({ id: typesId, nodeId: `${kebab}-types`, step: 'types', provider: stepProviders.types });
  }

  // Step 2: Events (no deps, parallel with types)
  if (args.events_task) {
    const eventsId = uuidv4();
    db.createTask({
      id: eventsId,
      task_description: args.events_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-events`,
      status: 'pending',
      provider: stepProviders.events
    });
    tasks.push({ id: eventsId, nodeId: `${kebab}-events`, step: 'events', provider: stepProviders.events });
  }

  // Step 3: Data (depends on types)
  if (args.data_task) {
    const dataId = uuidv4();
    const typesTask = tasks.find(t => t.step === 'types');
    db.createTask({
      id: dataId,
      task_description: args.data_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-data`,
      status: typesTask ? 'blocked' : 'pending',
      provider: stepProviders.data
    });
    if (typesTask) {
      db.addTaskDependency({
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
    db.createTask({
      id: systemId,
      task_description: args.system_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-system`,
      status: hasDeps ? 'blocked' : 'pending',
      provider: stepProviders.system,
      metadata: JSON.stringify({ needs_review: true }),
    });
    if (dataTask) {
      db.addTaskDependency({
        workflow_id: workflowId,
        task_id: systemId,
        depends_on_task_id: dataTask.id,
      });
    }
    if (eventsTask) {
      db.addTaskDependency({
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
    db.createTask({
      id: testsId,
      task_description: args.tests_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-tests`,
      status: systemTask ? 'blocked' : 'pending',
      provider: stepProviders.tests
    });
    if (systemTask) {
      db.addTaskDependency({
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
    db.createTask({
      id: wireId,
      task_description: args.wire_task,
      working_directory: wdir,
      workflow_id: workflowId,
      workflow_node_id: `${kebab}-wire`,
      status: systemTask ? 'blocked' : 'pending',
      provider: stepProviders.wire
    });
    if (systemTask) {
      db.addTaskDependency({
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
      db.createTask({
        id: ptId,
        task_description: pt.task,
        working_directory: wdir,
        workflow_id: workflowId,
        workflow_node_id: nodeId,
        status: 'pending',
        provider: pt.provider || stepProviders.parallel
      });
      tasks.push({ id: ptId, nodeId, step: 'parallel', provider: pt.provider || stepProviders.parallel });
    }
  }

  db.updateWorkflowCounts(workflowId);

  // Auto-run if requested
  let started = 0;
  let queued = 0;
  let blocked = tasks.filter(t => t.step !== 'parallel' && !['types', 'events'].includes(t.step)).length;
  let startFailures = [];
  if (args.auto_run) {
    const startResult = startWorkflowExecution({
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
    const prov = t.provider || 'codex';
    output += `| ${t.nodeId} | ${t.step} | ${prov} | ${t.step === 'parallel' || !tasks.find(d => d.step === 'types') ? 'pending' : (t.step === 'types' || t.step === 'events' ? 'pending' : 'blocked')} |\n`;
  }

  if (!args.auto_run) {
    output += `\nUse \`run_workflow\` with ID \`${workflowId}\` to start, or \`await_workflow\` to start and wait.`;
  } else {
    output += `\nUse \`await_workflow\` with ID \`${workflowId}\` to wait for completion.`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Export a workflow as a portable JSON structure
 */
function handleExportWorkflow(args) {
  if (!args.workflow_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  const tasks = db.getWorkflowTasks(args.workflow_id);
  const exportedTasks = tasks.map(t => ({
    node_id: t.node_id || t.workflow_node_id,
    task_description: t.task_description,
    depends_on: t.depends_on ? (typeof t.depends_on === 'string' ? JSON.parse(t.depends_on) : t.depends_on) : [],
    provider: t.provider || null,
    model: t.model || null,
    timeout_minutes: t.timeout_minutes,
    working_directory: t.working_directory || null,
  }));

  const exportData = {
    workflow: {
      name: workflow.name,
      description: workflow.description || null,
      working_directory: workflow.working_directory || null,
      priority: workflow.priority || 0,
    },
    tasks: exportedTasks,
  };

  let output = `## Workflow Exported\n\n`;
  output += `**Name:** ${workflow.name}\n`;
  output += `**Tasks:** ${exportedTasks.length}\n\n`;
  output += '```json\n' + JSON.stringify(exportData, null, 2) + '\n```\n';

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Import a workflow from a portable JSON structure
 */
function handleImportWorkflow(args) {
  let importData = args.data;
  if (typeof importData === 'string') {
    try {
      importData = JSON.parse(importData);
    } catch (e) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid JSON: ${e.message}`);
    }
  }

  if (!importData || !importData.workflow || !Array.isArray(importData.tasks) || importData.tasks.length === 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'data must contain { workflow: { name, ... }, tasks: [...] } with at least one task');
  }

  const wf = importData.workflow;
  if (!wf.name || typeof wf.name !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'workflow.name is required');
  }

  // Create the workflow via the existing handler
  const createResult = handleCreateWorkflow({
    name: wf.name,
    description: wf.description || null,
    working_directory: args.working_directory || wf.working_directory || null,
    priority: wf.priority || 0,
    tasks: importData.tasks.map(t => ({
      node_id: t.node_id,
      task: t.task_description || t.task,
      depends_on: t.depends_on || [],
      provider: t.provider || null,
      model: t.model || null,
      timeout_minutes: t.timeout_minutes,
    })),
  });

  return createResult;
}

module.exports = {
  ...workflowTemplates,
  ...workflowDag,
  ...workflowAwait,
  ...workflowAdvanced,
  handleCreateWorkflow,
  handleAddWorkflowTask,
  handleRunWorkflow,
  handleWorkflowStatus,
  handleCancelWorkflow,
  handlePauseWorkflow,
  handleListWorkflows,
  handleWorkflowHistory,
  handleCreateFeatureWorkflow,
  handleExportWorkflow,
  handleImportWorkflow
};
