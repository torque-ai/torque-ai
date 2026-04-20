'use strict';

const taskCore = require('../db/task-core');
const hostManagement = require('../db/host-management');
const workflowEngine = require('../db/workflow-engine');
const taskManager = require('../task-manager');
const { getTaskInfoPressureLevel } = require('./task/core');
const { ErrorCodes, makeError, getWorkflowTaskCounts, evaluateWorkflowVisibility } = require('./shared');

const MAX_RUNNING = 5;
const MAX_QUEUED = 5;
const MAX_RECENT_COMPLETED = 3;
const MAX_RECENT_FAILED = 10;
const ERROR_SNIPPET_LENGTH = 200;
const OUTPUT_TAIL_LENGTH = 500;

/**
 * Build compact queue-scope context digest.
 */
function buildQueueContext(args) {
  const pressureLevel = getTaskInfoPressureLevel();
  const includeOutput = Boolean(args.include_output);

  // Running tasks (fetch all for accurate count, then slice for compact output)
  const running = taskCore.listTasks({ status: 'running', orderDir: 'desc' });
  const runningTasks = running.slice(0, MAX_RUNNING).map(task => {
    const progress = taskManager.getTaskProgress(task.id);
    const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
    return {
      id: task.id,
      provider: task.provider || null,
      progress: progress?.progress || 0,
      elapsed_seconds: progress?.elapsedSeconds || null,
      description: (task.task_description || '').slice(0, 200),
      is_stalled: activity?.isStalled || false,
    };
  });

  // Queued tasks (fetch all for accurate count, slice for compact output)
  const allQueued = taskCore.listTasks({ status: 'queued', orderDir: 'desc' });
  const queued = allQueued.slice(0, MAX_QUEUED);
  const queuedNext = queued.map(task => ({
    id: task.id,
    priority: task.priority || 0,
    description: (task.task_description || '').slice(0, 200),
  }));

  // Recent completed (most recent first)
  const completed = taskCore.listTasks({ status: 'completed', limit: MAX_RECENT_COMPLETED, orderDir: 'desc' });
  const completedLast3 = completed.map(task => {
    const entry = {
      id: task.id,
      status: 'completed',
      exit_code: task.exit_code != null ? task.exit_code : null,
      duration_seconds: (task.started_at && task.completed_at)
        ? Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000)
        : null,
      description: (task.task_description || '').slice(0, 200),
    };
    if (includeOutput && task.output) {
      entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
    }
    return entry;
  });
  const completedAll = taskCore.listTasks({ status: 'completed' });
  const completedCount = completedAll.length;

  // Recent failed (most recent first)
  const failed = taskCore.listTasks({ status: 'failed', limit: MAX_RECENT_FAILED, orderDir: 'desc' });
  const failedTasks = failed.map(task => {
    const errorSource = task.error_output || task.output || '';
    const entry = {
      id: task.id,
      status: 'failed',
      exit_code: task.exit_code != null ? task.exit_code : null,
      error_snippet: errorSource.slice(0, ERROR_SNIPPET_LENGTH) || null,
      description: (task.task_description || '').slice(0, 200),
    };
    if (includeOutput && task.output) {
      entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
    }
    return entry;
  });
  const failedAll = taskCore.listTasks({ status: 'failed' });
  const failedCount = failedAll.length;

  // Active workflows
  const allWorkflows = typeof workflowEngine.listWorkflows === 'function' ? workflowEngine.listWorkflows({}) : [];
  const activeWfs = allWorkflows.filter(wf => wf.status === 'running' || wf.status === 'pending');
  const workflowDigest = activeWfs.slice(0, 5).map(wf => {
    let completedTasks = 0;
    let totalTasks = 0;
    try {
      const detailed = workflowEngine.getWorkflowStatus(wf.id);
      if (detailed) {
        const counts = getWorkflowTaskCounts(detailed);
        completedTasks = counts.completed;
        totalTasks = counts.total;
      }
    } catch { /* ignore */ }
    return {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      completed: completedTasks,
      total: totalTasks,
    };
  });

  // Provider health (Ollama hosts only)
  const healthy = [];
  const down = [];
  const degraded = [];
  try {
    const hosts = typeof hostManagement.listOllamaHosts === 'function' ? hostManagement.listOllamaHosts({}) : [];
    for (const host of hosts) {
      if (host.status === 'healthy') healthy.push(host.name || host.id);
      else if (host.status === 'down') down.push(host.name || host.id);
      else if (host.status === 'degraded') degraded.push(host.name || host.id);
    }
  } catch { /* ignore */ }

  return {
    scope: 'queue',
    pressure_level: pressureLevel,
    running: { count: running.length, tasks: runningTasks },
    queued: { count: allQueued.length, next: queuedNext },
    recent_completed: { count: completedCount, last_3: completedLast3 },
    recent_failed: { count: failedCount, tasks: failedTasks },
    active_workflows: { count: activeWfs.length, workflows: workflowDigest },
    provider_health: { healthy, down, degraded },
  };
}

/**
 * Format queue context as compact markdown.
 */
function formatQueueMarkdown(ctx) {
  const lines = [];
  lines.push(`## Context — Queue Overview`);
  lines.push(`**Pressure:** ${ctx.pressure_level} | **Running:** ${ctx.running.count} | **Queued:** ${ctx.queued.count}`);

  if (ctx.running.tasks.length > 0) {
    lines.push(`\n### Running`);
    for (const t of ctx.running.tasks) {
      const stall = t.is_stalled ? ' STALLED' : '';
      lines.push(`- ${t.id.slice(0, 8)}... ${t.provider || '?'} ${t.progress}%${stall} — ${t.description}`);
    }
  }

  if (ctx.recent_failed.tasks.length > 0) {
    lines.push(`\n### Recent Failures (${ctx.recent_failed.count})`);
    for (const t of ctx.recent_failed.tasks) {
      lines.push(`- ${t.id.slice(0, 8)}... exit=${t.exit_code} — ${t.description}`);
    }
  }

  if (ctx.active_workflows.workflows.length > 0) {
    lines.push(`\n### Active Workflows`);
    for (const wf of ctx.active_workflows.workflows) {
      lines.push(`- ${wf.name} [${wf.status}] ${wf.completed}/${wf.total}`);
    }
  }

  lines.push(`\n**Hosts:** ${ctx.provider_health.healthy.length} healthy, ${ctx.provider_health.down.length} down`);

  return lines.join('\n');
}

/**
 * Main handler — dispatches to queue or workflow scope.
 * Export name: handleGetContext → auto-dispatched as tool 'get_context'
 */
function handleGetContext(args) {
  if (args.workflow_id) {
    return buildWorkflowContext(args);
  }

  const ctx = buildQueueContext(args);
  return {
    content: [{ type: 'text', text: formatQueueMarkdown(ctx) }],
    structuredData: ctx,
  };
}

/**
 * Parse depends_on which may be a JSON string or array.
 */
function parseDeps(depsRaw) {
  if (!depsRaw) return [];
  if (Array.isArray(depsRaw)) return depsRaw;
  if (typeof depsRaw === 'string') {
    try { return JSON.parse(depsRaw); } catch { return []; }
  }
  return [];
}

function getTaskNodeId(task) {
  return task?.node_id || task?.workflow_node_id || task?.id?.substring(0, 8) || '?';
}

function getTaskElapsedSeconds(task) {
  if (!task?.started_at) return null;
  const endTime = task.completed_at ? new Date(task.completed_at) : new Date();
  return Math.round((endTime - new Date(task.started_at)) / 1000);
}

function getWorkflowDependencyEndpoints(dep) {
  return {
    from: dep.from || dep.depends_on_task_id,
    to: dep.to || dep.task_id,
  };
}

function getWorkflowTaskList(status) {
  const statusTasks = Object.values(status.tasks || {});
  if (typeof workflowEngine.getWorkflowTasks !== 'function' || !status.id) {
    return statusTasks;
  }

  try {
    const rawTasks = workflowEngine.getWorkflowTasks(status.id) || [];
    const rawById = new Map(rawTasks.map(task => [task.id, task]));
    if (statusTasks.length === 0) {
      return rawTasks;
    }
    return statusTasks.map(task => {
      const raw = rawById.get(task.id);
      if (!raw) return task;
      return {
        ...raw,
        ...task,
        workflow_node_id: task.workflow_node_id || raw.workflow_node_id,
        node_id: task.node_id || raw.workflow_node_id || raw.node_id,
        depends_on: task.depends_on || raw.depends_on,
      };
    });
  } catch {
    return statusTasks;
  }
}

/**
 * Build compact workflow-scope context digest.
 */
function buildWorkflowContext(args) {
  const includeOutput = Boolean(args.include_output);

  const status = workflowEngine.getWorkflowStatus(args.workflow_id);
  if (!status) {
    return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${args.workflow_id}`);
  }

  const taskList = getWorkflowTaskList(status);
  const enrichedStatus = { ...status, tasks: taskList };
  const visibility = evaluateWorkflowVisibility(enrichedStatus);
  const counts = getWorkflowTaskCounts(enrichedStatus);

  // Build dependency map: task_id -> array of dependency node_ids
  // status.dependencies has { from: depends_on_task_id, to: task_id }
  // We need: for each task, what node_ids does it depend on?
  // "from" is the dependency (upstream), "to" is the dependent (downstream)
  const taskIdToNodeId = {};
  for (const task of taskList) {
    taskIdToNodeId[task.id] = getTaskNodeId(task);
  }
  const depsByTaskId = {};
  for (const dep of (status.dependencies || [])) {
    const endpoints = getWorkflowDependencyEndpoints(dep);
    if (!endpoints.to || !endpoints.from) continue;
    if (!depsByTaskId[endpoints.to]) depsByTaskId[endpoints.to] = [];
    // Store the node_id of the upstream task
    const upstreamNodeId = taskIdToNodeId[endpoints.from] || endpoints.from;
    depsByTaskId[endpoints.to].push(upstreamNodeId);
  }

  // Elapsed time from workflow start
  let elapsedSeconds = null;
  if (status.started_at) {
    const endTime = status.completed_at ? new Date(status.completed_at) : new Date();
    elapsedSeconds = Math.round((endTime - new Date(status.started_at)) / 1000);
  }

  // Categorize tasks
  const completedTasks = [];
  const runningTasks = [];
  const failedTasks = [];
  const blockedTasks = [];
  const nextActionable = [];
  const alerts = [];

  // Track completed node_ids for blocked_by and next_actionable computation
  const completedNodeIds = new Set();
  for (const task of taskList) {
    if (task.status === 'completed') completedNodeIds.add(getTaskNodeId(task));
  }

  // Track failed node_ids for blocked vs next_actionable distinction
  const failedNodeIds = new Set();
  for (const task of taskList) {
    if (task.status === 'failed') failedNodeIds.add(getTaskNodeId(task));
  }

  for (const task of taskList) {
    const nodeId = getTaskNodeId(task);
    const deps = depsByTaskId[task.id] || parseDeps(task.depends_on);

    switch (task.status) {
      case 'completed': {
        const entry = {
          node_id: nodeId,
          exit_code: task.exit_code != null ? task.exit_code : null,
          duration_seconds: task.started_at && task.completed_at ? getTaskElapsedSeconds(task) : null,
        };
        if (includeOutput && task.output) {
          entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
        }
        completedTasks.push(entry);
        break;
      }
      case 'running': {
        const progress = taskManager.getTaskProgress(task.id);
        const activity = taskManager.getTaskActivity(task.id, { skipGitCheck: true });
        runningTasks.push({
          node_id: nodeId,
          provider: task.provider || null,
          elapsed_seconds: progress?.elapsedSeconds ?? getTaskElapsedSeconds(task),
          progress: progress?.progress ?? task.progress ?? task.progress_percent ?? 0,
        });
        // Stall alerts
        if (activity?.isStalled) {
          alerts.push(`Task ${nodeId} stalled (no output ${activity.lastActivitySeconds}s)`);
        }
        break;
      }
      case 'failed': {
        const errorSource = task.error_output || task.output || '';
        const entry = {
          node_id: nodeId,
          exit_code: task.exit_code != null ? task.exit_code : null,
          error_snippet: errorSource.slice(0, ERROR_SNIPPET_LENGTH) || null,
        };
        if (includeOutput && task.output) {
          entry.output_tail = task.output.slice(-OUTPUT_TAIL_LENGTH);
        }
        failedTasks.push(entry);
        break;
      }
      default: {
        // pending, queued, blocked, skipped, cancelled
        if (deps.length > 0) {
          const incompleteDeps = deps.filter(d => !completedNodeIds.has(d));
          if (incompleteDeps.length > 0) {
            // Check if any incomplete dep has failed — if so, this is truly blocked
            const hasFailedDep = incompleteDeps.some(d => failedNodeIds.has(d));
            if (hasFailedDep) {
              blockedTasks.push({ node_id: nodeId, blocked_by: incompleteDeps });
            } else {
              // Deps still running/pending but not failed — actionable soon (ready: false)
              nextActionable.push({ node_id: nodeId, depends_on: deps, ready: false });
            }
          } else {
            // All deps completed — this task is actionable now
            nextActionable.push({ node_id: nodeId, depends_on: deps, ready: true });
          }
        } else if (task.status === 'pending' || task.status === 'queued') {
          // No deps and not started — actionable
          nextActionable.push({ node_id: nodeId, depends_on: [], ready: true });
        }
        break;
      }
    }

    // Provider fallback alerts from metadata
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
      if (meta._provider_switch_reason) {
        alerts.push(`Task ${nodeId} fell back: ${meta._provider_switch_reason}`);
      }
    } catch { /* ignore parse errors */ }
  }

  const ctx = {
    scope: 'workflow',
    workflow: {
      id: status.id,
      name: status.name,
      status: status.status,
      visibility: visibility.label,
      elapsed_seconds: elapsedSeconds,
    },
    counts: {
      completed: counts.completed,
      running: counts.running,
      queued: counts.queued,
      pending: counts.pending,
      blocked: counts.blocked,
      failed: counts.failed,
      skipped: counts.skipped,
      cancelled: counts.cancelled,
      total: counts.total,
    },
    completed_tasks: completedTasks,
    running_tasks: runningTasks,
    failed_tasks: failedTasks,
    blocked_tasks: blockedTasks,
    next_actionable: nextActionable,
    alerts: alerts,
  };

  return {
    content: [{ type: 'text', text: formatWorkflowMarkdown(ctx) }],
    structuredData: ctx,
  };
}

/**
 * Format workflow context as compact markdown.
 */
function formatWorkflowMarkdown(ctx) {
  const lines = [];
  lines.push(`## Context — ${ctx.workflow.name}`);
  lines.push(`**Status:** ${ctx.workflow.status} | **Visibility:** ${ctx.workflow.visibility}`);
  lines.push(`**Progress:** ${ctx.counts.completed}/${ctx.counts.total} completed, ${ctx.counts.running} running, ${ctx.counts.failed} failed`);

  if (ctx.running_tasks.length > 0) {
    lines.push(`\n### Running`);
    for (const t of ctx.running_tasks) {
      lines.push(`- ${t.node_id} — ${t.provider || '?'} ${t.progress}%`);
    }
  }

  if (ctx.failed_tasks.length > 0) {
    lines.push(`\n### Failed`);
    for (const t of ctx.failed_tasks) {
      lines.push(`- ${t.node_id} — exit=${t.exit_code}`);
    }
  }

  if (ctx.blocked_tasks.length > 0) {
    lines.push(`\n### Blocked`);
    for (const t of ctx.blocked_tasks) {
      lines.push(`- ${t.node_id} ← waiting on [${t.blocked_by.join(', ')}]`);
    }
  }

  if (ctx.next_actionable.length > 0) {
    lines.push(`\n### Next`);
    for (const t of ctx.next_actionable) {
      lines.push(`- ${t.node_id}${t.ready ? ' (ready)' : ''}`);
    }
  }

  if (ctx.alerts.length > 0) {
    lines.push(`\n### Alerts`);
    for (const a of ctx.alerts) {
      lines.push(`- ${a}`);
    }
  }

  return lines.join('\n');
}

function createContextHandler() {
  return {
    handleGetContext,
  };
}

module.exports = {
  buildQueueContext,
  formatQueueMarkdown,
  handleGetContext,
  parseDeps,
  buildWorkflowContext,
  formatWorkflowMarkdown,
  createContextHandler,
};
