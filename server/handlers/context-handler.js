'use strict';

const db = require('../database');
const taskManager = require('../task-manager');
const { getTaskInfoPressureLevel } = require('./task/core');
const { ErrorCodes, makeError, getWorkflowTaskCounts, evaluateWorkflowVisibility } = require('./shared');
const logger = require('../logger');

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
  const running = db.listTasks({ status: 'running', orderDir: 'desc' });
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
  const allQueued = db.listTasks({ status: 'queued', orderDir: 'desc' });
  const queued = allQueued.slice(0, MAX_QUEUED);
  const queuedNext = queued.map(task => ({
    id: task.id,
    priority: task.priority || 0,
    description: (task.task_description || '').slice(0, 200),
  }));

  // Recent completed (most recent first)
  const completed = db.listTasks({ status: 'completed', limit: MAX_RECENT_COMPLETED, orderDir: 'desc' });
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
  const completedAll = db.listTasks({ status: 'completed' });
  const completedCount = completedAll.length;

  // Recent failed (most recent first)
  const failed = db.listTasks({ status: 'failed', limit: MAX_RECENT_FAILED, orderDir: 'desc' });
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
  const failedAll = db.listTasks({ status: 'failed' });
  const failedCount = failedAll.length;

  // Active workflows
  const allWorkflows = typeof db.listWorkflows === 'function' ? db.listWorkflows({}) : [];
  const activeWfs = allWorkflows.filter(wf => wf.status === 'running' || wf.status === 'pending');
  const workflowDigest = activeWfs.slice(0, 5).map(wf => {
    let completedTasks = 0;
    let totalTasks = 0;
    try {
      const detailed = db.getWorkflowStatus(wf.id);
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
    const hosts = typeof db.listOllamaHosts === 'function' ? db.listOllamaHosts({}) : [];
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

// Placeholder for Task 4 — workflow scope
function buildWorkflowContext(args) {
  return makeError(ErrorCodes.OPERATION_FAILED, 'Workflow scope not yet implemented');
}

module.exports = {
  handleGetContext,
};
