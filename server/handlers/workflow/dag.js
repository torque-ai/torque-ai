/**
 * Workflow DAG and dependency analysis handlers
 */

const db = require('../../database');
const {
  ErrorCodes,
  makeError,
  requireTask,
  requireWorkflow
} = require('../shared');

function getTaskLabel(task) {
  return task?.workflow_node_id || task?.id?.substring(0, 8) || 'unknown';
}

function getTaskDurationSeconds(task) {
  if (Number.isFinite(task?.duration_seconds) && task.duration_seconds >= 0) {
    return task.duration_seconds;
  }

  if (task?.started_at && task?.completed_at) {
    const startedAt = new Date(task.started_at).getTime();
    const completedAt = new Date(task.completed_at).getTime();
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
      return Math.round((completedAt - startedAt) / 1000);
    }
  }

  return 0;
}

/**
 * Format a second duration as a human-readable string.
 * e.g. 272 → "272s", 0.5 → "0.5s"
 *
 * NOTE: Takes SECONDS (from getDurationSeconds). await.js has a homonymous
 * function that takes MILLISECONDS — intentionally different units matching
 * each module's data source.
 */
function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  if (safeSeconds < 1) {
    return '0s';
  }
  if (Number.isInteger(safeSeconds)) {
    return `${safeSeconds}s`;
  }
  return `${safeSeconds.toFixed(1)}s`;
}

/**
 * Get dependency graph visualization
 */
function handleDependencyGraph(args) {
  const workflowResult = requireWorkflow(db, args.workflow_id);
  if (workflowResult.error) return workflowResult.error;
  const { workflow } = workflowResult;

  const tasks = db.getWorkflowTasks(args.workflow_id);
  const deps = db.getWorkflowDependencies(args.workflow_id);

  // Build node map
  const nodeMap = {};
  for (const t of tasks) {
    nodeMap[t.id] = t.workflow_node_id || t.id.substring(0, 8);
  }

  const format = args.format || 'mermaid';

  if (format === 'json') {
    const graph = {
      nodes: tasks.map(t => ({
        id: t.id,
        node_id: t.workflow_node_id,
        status: t.status
      })),
      edges: deps.map(d => ({
        from: d.depends_on_task_id,
        to: d.task_id,
        condition: d.condition_expr,
        on_fail: d.on_fail
      }))
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }]
    };
  }

  if (format === 'mermaid') {
    let output = '```mermaid\ngraph TD\n';

    // Add nodes with status colors
    for (const t of tasks) {
      const nodeId = nodeMap[t.id];
      const statusClass = {
        completed: ':::completed',
        failed: ':::failed',
        running: ':::running',
        blocked: ':::blocked',
        pending: ':::pending',
        skipped: ':::skipped'
      }[t.status] || '';

      output += `  ${nodeId}["${nodeId}"]${statusClass}\n`;
    }

    // Add edges
    for (const d of deps) {
      const from = nodeMap[d.depends_on_task_id];
      const to = nodeMap[d.task_id];
      const label = d.condition_expr ? `|${d.condition_expr.substring(0, 20)}|` : '';
      output += `  ${from} -->${label} ${to}\n`;
    }

    output += '```';

    return {
      content: [{ type: 'text', text: `## Dependency Graph: ${workflow.name}\n\n${output}` }]
    };
  }

  // ASCII format
  let output = `## Dependency Graph: ${workflow.name}\n\n`;
  output += '```\n';

  for (const t of tasks) {
    const nodeId = nodeMap[t.id];
    const taskDeps = deps.filter(d => d.task_id === t.id);

    if (taskDeps.length === 0) {
      output += `[${nodeId}] (${t.status})\n`;
    } else {
      const depNodes = taskDeps.map(d => nodeMap[d.depends_on_task_id]).join(', ');
      output += `[${nodeId}] (${t.status}) <- ${depNodes}\n`;
    }
  }

  output += '```';

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Find critical path through workflow
 */
function handleCriticalPath(args) {
  const workflowResult = requireWorkflow(db, args.workflow_id);
  if (workflowResult.error) return workflowResult.error;
  const { workflow } = workflowResult;

  const tasks = db.getWorkflowTasks(args.workflow_id);
  const deps = db.getWorkflowDependencies(args.workflow_id);

  // Build adjacency list
  const graph = {};
  const nodeMap = {};
  const taskMap = {};
  for (const t of tasks) {
    graph[t.id] = [];
    nodeMap[t.id] = getTaskLabel(t);
    taskMap[t.id] = t;
  }
  for (const d of deps) {
    if (graph[d.depends_on_task_id]) {
      graph[d.depends_on_task_id].push(d.task_id);
    }
  }

  // Find longest path using DFS
  const memo = {};
  function longestPath(nodeId) {
    if (memo[nodeId] !== undefined) return memo[nodeId];

    const neighbors = graph[nodeId] || [];
    const nodeDuration = getTaskDurationSeconds(taskMap[nodeId]);
    if (neighbors.length === 0) {
      memo[nodeId] = { length: 1, duration: nodeDuration, path: [nodeId] };
      return memo[nodeId];
    }

    let maxLen = 0;
    let maxDuration = -1;
    let maxPath = [nodeId];

    for (const next of neighbors) {
      const result = longestPath(next);
      const candidateLength = result.length + 1;
      const candidateDuration = result.duration + nodeDuration;
      if (candidateDuration > maxDuration
          || (candidateDuration === maxDuration && candidateLength > maxLen)) {
        maxLen = candidateLength;
        maxDuration = candidateDuration;
        maxPath = [nodeId, ...result.path];
      }
    }

    memo[nodeId] = {
      length: maxLen,
      duration: Math.max(0, maxDuration),
      path: maxPath
    };
    return memo[nodeId];
  }

  // Find nodes with no incoming edges (start nodes)
  const hasIncoming = new Set(deps.map(d => d.task_id));
  const startNodes = tasks.filter(t => !hasIncoming.has(t.id));

  let criticalPath = { length: 0, duration: 0, path: [] };
  for (const start of startNodes) {
    const result = longestPath(start.id);
    if (result.duration > criticalPath.duration
        || (result.duration === criticalPath.duration && result.length > criticalPath.length)) {
      criticalPath = result;
    }
  }

  let bottleneckTask = null;
  let bottleneckDuration = -1;
  for (const nodeId of criticalPath.path) {
    const task = taskMap[nodeId];
    const duration = getTaskDurationSeconds(task);
    if (duration > bottleneckDuration) {
      bottleneckDuration = duration;
      bottleneckTask = task;
    }
  }

  let output = `## Critical Path: ${workflow.name}\n\n`;
  output += `**Length:** ${criticalPath.length} tasks\n\n`;
  output += `**Duration:** ${formatDuration(criticalPath.duration)} total\n\n`;
  output += `**Bottleneck:** ${bottleneckTask ? `${getTaskLabel(bottleneckTask)} (${formatDuration(bottleneckDuration)})` : 'N/A'}\n\n`;
  output += `**Path:**\n`;

  for (let i = 0; i < criticalPath.path.length; i++) {
    const nodeId = criticalPath.path[i];
    const nodeName = nodeMap[nodeId];
    const arrow = i < criticalPath.path.length - 1 ? ' →' : '';
    const duration = getTaskDurationSeconds(taskMap[nodeId]);
    output += `${i + 1}. ${nodeName} (${formatDuration(duration)})${arrow}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * What-if simulation
 */
function handleWhatIf(args) {
  const workflowResult = requireWorkflow(db, args.workflow_id);
  if (workflowResult.error) return workflowResult.error;

  const taskResult = requireTask(db, args.task_id);
  if (taskResult.error) return taskResult.error;

  const { task } = taskResult;
  if (task.workflow_id !== args.workflow_id) {
    return {
      ...makeError(
        ErrorCodes.TASK_NOT_FOUND,
        `Task not found in workflow ${args.workflow_id}: ${args.task_id} (what-if simulation)`
      )
    };
  }

  // Get dependents
  const dependents = db.getTaskDependents(args.task_id);
  const simulatedStatus = args.simulated_status;
  const exitCode = args.simulated_exit_code || (simulatedStatus === 'failed' ? 1 : 0);

  // Build context for condition evaluation
  const context = {
    exit_code: exitCode,
    status: simulatedStatus,
    output: '',
    error_output: '',
    duration_seconds: 60
  };

  let output = `## What-If Analysis\n\n`;
  output += `**Task:** ${task.workflow_node_id || task.id.substring(0, 8)}\n`;
  output += `**Simulated Status:** ${simulatedStatus}\n`;
  output += `**Simulated Exit Code:** ${exitCode}\n\n`;

  if (dependents.length === 0) {
    output += `This task has no dependents. The simulation has no downstream effects.`;
    return { content: [{ type: 'text', text: output }] };
  }

  output += `### Effects on Dependents\n\n`;
  output += `| Task | Condition | Result | Action |\n`;
  output += `|------|-----------|--------|--------|\n`;

  for (const dep of dependents) {
    const depTask = db.getTask(dep.task_id);
    const nodeName = depTask?.workflow_node_id || dep.task_id.substring(0, 8);
    const condition = dep.condition_expr || '(none)';

    let conditionPasses = true;
    if (dep.condition_expr) {
      conditionPasses = db.evaluateCondition(dep.condition_expr, context);
    }

    let result, action;
    if (conditionPasses) {
      result = '✓ Pass';
      action = 'Unblock';
    } else {
      result = '✗ Fail';
      action = dep.on_fail === 'cancel' ? 'Cancel workflow' :
               dep.on_fail === 'skip' ? 'Skip task' :
               dep.on_fail === 'continue' ? 'Continue anyway' :
               dep.on_fail === 'run_alternate' ? 'Run alternate' : 'Skip';
    }

    output += `| ${nodeName} | \`${condition.substring(0, 20)}\` | ${result} | ${action} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List blocked tasks
 */
function handleBlockedTasks(args) {
  let workflow = null;
  if (args.workflow_id) {
    const workflowResult = requireWorkflow(db, args.workflow_id);
    if (workflowResult.error) return workflowResult.error;
    workflow = workflowResult.workflow;
  }

  const tasks = db.getBlockedTasks(args.workflow_id);

  if (tasks.length === 0) {
    return {
      content: [{ type: 'text', text: workflow ? `No blocked tasks found in workflow ${workflow.name}.` : 'No blocked tasks found.' }]
    };
  }

  let output = workflow ? `## Blocked Tasks: ${workflow.name}\n\n` : '## Blocked Tasks\n\n';
  output += `| Task | Workflow | Waiting On |\n`;
  output += `|------|----------|------------|\n`;

  for (const task of tasks) {
    const nodeName = task.workflow_node_id || task.id.substring(0, 8);
    const deps = db.getTaskDependencies(task.id);
    const waitingOn = deps
      .filter(d => !['completed', 'failed', 'cancelled', 'skipped'].includes(d.depends_on_status))
      .map(d => {
        const depTask = db.getTask(d.depends_on_task_id);
        return depTask?.workflow_node_id || d.depends_on_task_id.substring(0, 8);
      })
      .join(', ');

    output += `| ${nodeName} | ${task.workflow_id?.substring(0, 8) || '-'} | ${waitingOn || 'all deps complete'} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}

module.exports = {
  handleDependencyGraph,
  handleCriticalPath,
  handleWhatIf,
  handleBlockedTasks
};
