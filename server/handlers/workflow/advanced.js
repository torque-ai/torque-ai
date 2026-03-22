/**
 * Advanced workflow handlers (fork/replay/retry/report-style operations)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const taskManager = require('../../task-manager');
const logger = require('../../logger').child({ component: 'workflow-advanced' });
const { ErrorCodes, getWorkflowRestartGuardError, makeError, requireWorkflow, requireTask } = require('../shared');
const { handleWorkflowTermination } = require('../../execution/workflow-runtime');

/**
 * Fork a workflow into parallel branches
 */
function handleForkWorkflow(args) {
  const { workflow_id, branches, merge_strategy = 'all' } = args;

  // Input validation
  if (!workflow_id || typeof workflow_id !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'workflow_id must be a non-empty string');
  }
  if (!Array.isArray(branches) || branches.length < 2) {
    return makeError(ErrorCodes.INVALID_PARAM, 'branches must have at least 2 items');
  }
  if (!['all', 'any', 'first'].includes(merge_strategy)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'merge_strategy must be "all", "any", or "first"');
  }

  // Verify workflow exists
  const { workflow: _workflow, error: wfErr } = requireWorkflow(db, workflow_id);
  if (wfErr) return wfErr;

  const fork = db.createWorkflowFork({
    id: uuidv4(),
    workflow_id,
    branches,
    branch_count: branches.length,
    merge_strategy
  });

  // Create tasks for each branch.
  // NOTE: Fork tasks are created with no DAG dependency edges between branches or
  // to the parent workflow's existing tasks. This is a known limitation — branch tasks
  // start immediately as independent queued tasks without inheriting workflow position.
  // A future improvement would wire each branch's first task to depend on the fork
  // creation point and each branch's last task into the merge node.
  const branchTaskIds = {};
  for (const branch of branches) {
    branchTaskIds[branch.name] = [];
    for (const taskDesc of branch.tasks) {
      const taskId = uuidv4();
      db.createTask({
        id: taskId,
        task_description: taskDesc,
        workflow_id,
        status: 'queued'
      });
      branchTaskIds[branch.name].push(taskId);
    }
  }

  let output = `## Workflow Forked\n\n`;
  output += `**Fork ID:** \`${fork.id}\`\n`;
  output += `**Workflow:** ${workflow_id}\n`;
  output += `**Branches:** ${branches.length}\n`;
  output += `**Merge Strategy:** ${merge_strategy}\n\n`;
  output += `### Branches\n\n`;
  for (const branch of branches) {
    output += `**${branch.name}:** ${branch.tasks.length} tasks\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Merge workflow branches
 */
function handleMergeWorkflows(args) {
  const { fork_id, combine_outputs = true } = args;

  // Input validation
  if (!fork_id || typeof fork_id !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'fork_id must be a non-empty string');
  }

  const fork = db.getWorkflowFork(fork_id);
  if (!fork) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Fork not found: ${fork_id}`);
  }

  // Update fork status
  db.updateWorkflowForkStatus(fork_id, 'merged');

  let output = `## Workflow Branches Merged\n\n`;
  output += `**Fork ID:** \`${fork_id}\`\n`;
  output += `**Workflow:** ${fork.workflow_id}\n`;
  output += `**Strategy:** ${fork.merge_strategy}\n`;
  output += `**Outputs Combined:** ${combine_outputs}\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Replay a task with optional modifications
 */
function handleReplayTask(args) {
  const { task_id, modified_inputs, new_working_directory } = args;

  // Input validation
  if (!task_id || typeof task_id !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'task_id must be a non-empty string');
  }

  // Get original task
  const { task: originalTask, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  // Create new task based on original
  const replayTaskId = uuidv4();
  const taskDescription = modified_inputs?.task || originalTask.task_description;
  const workingDir = new_working_directory || originalTask.working_directory;

  db.createTask({
    id: replayTaskId,
    task_description: taskDescription,
    working_directory: workingDir,
    timeout_minutes: originalTask.timeout_minutes,
    auto_approve: originalTask.auto_approve,
    priority: originalTask.priority,
    template_name: originalTask.template_name,
    status: 'queued'
  });

  // Record replay
  db.createTaskReplay({
    id: uuidv4(),
    original_task_id: task_id,
    replay_task_id: replayTaskId,
    modified_inputs
  });

  let output = `## Task Replayed\n\n`;
  output += `**Original Task:** \`${task_id}\`\n`;
  output += `**Replay Task:** \`${replayTaskId}\`\n`;
  output += `**Status:** Queued\n`;
  if (modified_inputs) {
    output += `**Modified Inputs:** ${Object.keys(modified_inputs).join(', ')}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Compare two task executions
 */
function handleDiffTaskRuns(args) {
  const { task_id_a, task_id_b, compare_fields = ['output', 'files_modified', 'duration', 'exit_code'] } = args;

  // Input validation
  if (!task_id_a || !task_id_b) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Both task_id_a and task_id_b are required');
  }

  const { task: taskA, error: errA } = requireTask(db, task_id_a);
  if (errA) return errA;
  const { task: taskB, error: errB } = requireTask(db, task_id_b);
  if (errB) return errB;

  const diff = {};

  for (const field of compare_fields) {
    let valueA, valueB;

    switch (field) {
      case 'duration':
        if (taskA.completed_at && taskA.started_at) {
          valueA = (new Date(taskA.completed_at) - new Date(taskA.started_at)) / 1000;
        }
        if (taskB.completed_at && taskB.started_at) {
          valueB = (new Date(taskB.completed_at) - new Date(taskB.started_at)) / 1000;
        }
        break;
      default:
        valueA = taskA[field];
        valueB = taskB[field];
    }

    diff[field] = {
      a: valueA,
      b: valueB,
      same: JSON.stringify(valueA) === JSON.stringify(valueB)
    };
  }

  let output = `## Task Comparison\n\n`;
  output += `| Field | Task A | Task B | Same |\n`;
  output += `|-------|--------|--------|------|\n`;
  for (const [field, result] of Object.entries(diff)) {
    const aVal = typeof result.a === 'string' ? result.a.substring(0, 30) : result.a;
    const bVal = typeof result.b === 'string' ? result.b.substring(0, 30) : result.b;
    output += `| ${field} | ${aVal || 'N/A'} | ${bVal || 'N/A'} | ${result.same ? '✓' : '✗'} |\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Duplicate a pipeline
 */
function handleDuplicatePipeline(args) {
  const { pipeline_id, new_name, working_directory, auto_approve, timeout_minutes, description } = args;

  const newPipeline = db.duplicatePipeline(pipeline_id, new_name, {
    working_directory,
    auto_approve,
    timeout_minutes,
    description
  });

  if (!newPipeline) {
    return makeError(ErrorCodes.PIPELINE_NOT_FOUND, `Pipeline not found: ${pipeline_id}`);
  }

  let output = `## Pipeline Cloned\n\n`;
  output += `**New Pipeline:** ${newPipeline.name}\n`;
  output += `**ID:** ${newPipeline.id}\n`;
  output += `**Description:** ${newPipeline.description}\n\n`;

  const definition = db.safeJsonParse(newPipeline.definition, []);
  output += `**Steps:** ${definition.length}\n\n`;

  output += `| Step | Task |\n`;
  output += `|------|------|\n`;

  for (let i = 0; i < definition.length; i++) {
    const step = definition[i];
    const taskText = step.task || '';
    const task = taskText.substring(0, 50) + (taskText.length > 50 ? '...' : '');
    output += `| ${i + 1} | ${task} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Export tasks report
 */
function handleExportReport(args) {
  const {
    format = 'markdown',
    project,
    status,
    start_date,
    end_date,
    tags,
    include_output = false
  } = args;

  // Parse status if comma-separated
  const statusFilter = status ? status.split(',').map(s => s.trim()) : null;

  const { tasks, summary } = db.exportTasksReport({
    project,
    status: statusFilter,
    start_date,
    end_date,
    tags,
    include_output
  });

  if (tasks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Task Report\n\nNo tasks found matching the criteria.`
      }]
    };
  }

  let output = '';

  if (format === 'csv') {
    output = `## Task Report (CSV)\n\n`;
    output += `**Total Tasks:** ${summary.total}\n\n`;
    output += '```csv\n';
    output += 'id,status,task_description,project,priority,progress_percent,exit_code,created_at\n';

    for (const t of tasks) {
      const desc = `"${(t.task_description || '').replace(/"/g, '""')}"`;
      output += `${t.id},${t.status},${desc},${t.project || ''},${t.priority || 0},${t.progress_percent || 0},${t.exit_code || ''},${t.created_at}\n`;
    }

    output += '```\n';
  } else if (format === 'json') {
    output = `## Task Report (JSON)\n\n`;
    output += `**Total Tasks:** ${summary.total}\n\n`;

    output += `### Summary\n\n`;
    output += '```json\n';
    output += JSON.stringify(summary, null, 2);
    output += '\n```\n\n';

    output += `### Tasks (first 20)\n\n`;
    output += '```json\n';
    output += JSON.stringify(tasks.slice(0, 20), null, 2);
    if (tasks.length > 20) {
      output += `\n// ... ${tasks.length - 20} more tasks`;
    }
    output += '\n```\n';
  } else {
    // Markdown format
    output = `## Task Report\n\n`;

    output += `### Summary\n\n`;
    output += `- **Total Tasks:** ${summary.total}\n`;

    if (Object.keys(summary.by_status).length > 0) {
      output += `- **By Status:**\n`;
      for (const [s, count] of Object.entries(summary.by_status)) {
        output += `  - ${s}: ${count}\n`;
      }
    }

    if (Object.keys(summary.by_project).length > 0) {
      output += `- **By Project:**\n`;
      for (const [p, count] of Object.entries(summary.by_project)) {
        output += `  - ${p}: ${count}\n`;
      }
    }

    output += `\n### Tasks\n\n`;
    output += `| ID | Status | Description | Project | Created |\n`;
    output += `|----|--------|-------------|---------|--------|\n`;

    for (const t of tasks.slice(0, 50)) {
      const desc = (t.task_description || '').substring(0, 30) + '...';
      const created = new Date(t.created_at).toLocaleDateString();
      output += `| ${t.id.substring(0, 8)} | ${t.status} | ${desc} | ${t.project || '-'} | ${created} |\n`;
    }

    if (tasks.length > 50) {
      output += `\n*Showing 50 of ${tasks.length} tasks*`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Retry workflow from a specific task
 */
function handleRetryWorkflowFrom(args) {
  const { workflow, error: wfErr } = requireWorkflow(db, args.workflow_id);
  if (wfErr) return wfErr;

  const task = db.getTask(args.from_task_id);
  if (!task || task.workflow_id !== args.workflow_id) {
    return makeError(
      ErrorCodes.TASK_NOT_FOUND,
      `Task not found in workflow ${args.workflow_id}: ${args.from_task_id} (retry_from_task)`
    );
  }

  const workflowStatus = db.getWorkflowStatus(args.workflow_id) || workflow;
  const restartGuard = getWorkflowRestartGuardError(workflowStatus, {
    attemptedAction: 'retry this workflow from a task'
  });
  if (restartGuard) {
    return restartGuard;
  }

  // Reset the task and all its dependents
  const toReset = [args.from_task_id];
  const deps = db.getWorkflowDependencies(args.workflow_id);

  // BFS to find all downstream tasks
  const queue = [args.from_task_id];
  const visited = new Set(queue);

  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = deps.filter(d => d.depends_on_task_id === current);

    for (const dep of dependents) {
      if (!visited.has(dep.task_id)) {
        visited.add(dep.task_id);
        toReset.push(dep.task_id);
        queue.push(dep.task_id);
      }
    }
  }

  // Reset tasks
  let resetCount = 0;
  for (const taskId of toReset) {
    const taskToReset = db.getTask(taskId);
    if (taskToReset?.status === 'running') {
      continue;
    }
    if (taskToReset) {
      const hasDeps = deps.some(d => d.task_id === taskId);
      db.updateTaskStatus(taskId, hasDeps ? 'blocked' : 'pending');
      resetCount++;
    }
  }

  // Update workflow status and clear the acknowledged set so await_workflow
  // will yield the retried tasks again rather than treating them as already seen.
  const currentCtx = (workflow.context && typeof workflow.context === 'object') ? workflow.context : {};
  db.updateWorkflow(args.workflow_id, {
    status: 'running',
    completed_at: null,
    context: { ...currentCtx, acknowledged_tasks: [] }
  });

  // Start tasks that are now pending
  const tasks = db.getWorkflowTasks(args.workflow_id);
  for (const t of tasks) {
    if (t.status === 'pending') {
      try {
        taskManager.startTask(t.id);
      } catch (err) {
        // May be queued
        logger.debug('[workflow-handlers] non-critical error restarting pending workflow task:', err.message || err);
      }
    }
  }

  let output = `## Workflow Restarted\n\n`;
  output += `**From Task:** ${task.workflow_node_id || args.from_task_id.substring(0, 8)}\n`;
  output += `**Tasks Reset:** ${resetCount}\n`;
  output += `**Workflow Status:** running\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Manually skip a blocked task
 */
function handleSkipTask(args) {
  const { task, error: taskErr } = requireTask(db, args.task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'blocked') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not blocked. Current status: ${task.status}`)
    };
  }

  // Update task to skipped
  db.updateTaskStatus(args.task_id, 'skipped', {
    error_output: args.reason || 'Manually skipped'
  });

  // If part of workflow, use the shared runtime to evaluate dependents (avoids duplication)
  if (task.workflow_id) {
    db.updateWorkflowCounts(task.workflow_id);
    handleWorkflowTermination(args.task_id);
  }

  let output = `## Task Skipped\n\n`;
  output += `**Task:** ${task.workflow_node_id || args.task_id.substring(0, 8)}\n`;
  if (args.reason) output += `**Reason:** ${args.reason}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}

function createWorkflowAdvancedHandlers(deps) {
  return {
    handleForkWorkflow,
    handleMergeWorkflows,
    handleReplayTask,
    handleDiffTaskRuns,
    handleDuplicatePipeline,
    handleExportReport,
    handleRetryWorkflowFrom,
    handleSkipTask,
  };
}

module.exports = {
  handleForkWorkflow,
  handleMergeWorkflows,
  handleReplayTask,
  handleDiffTaskRuns,
  handleDuplicatePipeline,
  handleExportReport,
  handleRetryWorkflowFrom,
  handleSkipTask,
  createWorkflowAdvancedHandlers,
};
