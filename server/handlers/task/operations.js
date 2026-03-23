/**
 * Task Operations — Tags, health, scheduling, batch, output, export/import, archiving
 * Extracted from task-handlers.js during decomposition.
 *
 * Handlers: handleTagTask, handleUntagTask, handleListTags,
 *           handleCheckTaskProgress, handleHealthCheck, handleHealthStatus,
 *           handleCheckStalledTasks, handleScheduleTask, handleListScheduled,
 *           handleCancelScheduled, handlePauseScheduled, handleBatchCancel,
 *           handleBatchRetry, handleBatchTag, handleSearchOutputs,
 *           handleOutputStats, handleExportData, handleImportData,
 *           handleArchiveTask, handleArchiveTasks, handleListArchived,
 *           handleRestoreTask, handleGetArchiveStats
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { spawnSync } = require('child_process');
const configCore = require('../../db/config-core');
const eventTracking = require('../../db/event-tracking');
const taskCore = require('../../db/task-core');
const projectConfigCore = require('../../db/project-config-core');
const providerRoutingCore = require('../../db/provider-routing-core');
const taskMetadata = require('../../db/task-metadata');
const taskManager = require('../../task-manager');
const { TASK_TIMEOUTS } = require('../../constants');
const { safeLimit, safeOffset, safeDate, isPathTraversalSafe, MAX_BATCH_SIZE, ErrorCodes, makeError, requireTask } = require('../shared');
const { formatTime } = require('./utils');
const logger = require('../../logger').child({ component: 'task-operations' });


// ============ Task Tagging Handlers ============

/**
 * Add tags to a task
 */
function handleTagTask(args) {
  const { task: _task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  if (!args.tags || args.tags.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'No tags provided');
  }

  // Normalize tags (lowercase, trim)
  const normalizedTags = args.tags.map(t => t.toLowerCase().trim()).filter(t => t.length > 0);

  const updated = taskMetadata.addTaskTags(args.task_id, normalizedTags);

  return {
    content: [{
      type: 'text',
      text: `## Tags Added\n\n**Task:** ${args.task_id.slice(0, 8)}...\n**Added Tags:** ${normalizedTags.join(', ')}\n**All Tags:** ${updated.tags.join(', ')}`
    }]
  };
}


/**
 * Remove tags from a task
 */
function handleUntagTask(args) {
  const { task: _task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  if (!args.tags || args.tags.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'No tags provided');
  }

  // Normalize tags
  const normalizedTags = args.tags.map(t => t.toLowerCase().trim());

  const updated = taskMetadata.removeTaskTags(args.task_id, normalizedTags);

  return {
    content: [{
      type: 'text',
      text: `## Tags Removed\n\n**Task:** ${args.task_id.slice(0, 8)}...\n**Removed Tags:** ${normalizedTags.join(', ')}\n**Remaining Tags:** ${updated.tags.length > 0 ? updated.tags.join(', ') : '(none)'}`
    }]
  };
}


/**
 * List all tags with usage statistics
 */
function handleListTags(_args) {
  const allTags = taskMetadata.getAllTags();
  const tagStats = taskMetadata.getTagStats();

  if (allTags.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Tags\n\nNo tags found. Use \`tag_task\` to add tags to tasks.`
      }]
    };
  }

  let result = `## Tag Statistics\n\n`;
  result += `**Total Unique Tags:** ${allTags.length}\n\n`;
  result += `| Tag | Usage Count |\n`;
  result += `|-----|-------------|\n`;

  const structuredTags = [];
  for (const stat of tagStats) {
    result += `| ${stat.tag} | ${stat.count} |\n`;
    structuredTags.push({ name: stat.tag, usage_count: stat.count });
  }

  result += `\n### Usage\n`;
  result += `- Tag a task: \`tag_task({task_id: "...", tags: ["tag1", "tag2"]})\`\n`;
  result += `- Filter tasks: \`list_tasks({tags: ["tag1"]})\``;

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      total_unique: allTags.length,
      tags: structuredTags,
    },
  };
}


// ============ Health Monitoring Handlers ============

/**
 * Check if running tasks are actively producing output
 */
async function handleCheckTaskProgress(args) {
  try {

  const waitSeconds = Math.min(args.wait_seconds ?? 5, 300);

  // Snapshot 1
  const running1 = taskCore.listTasks({ status: 'running', limit: 20 });
  
  if (running1.length === 0) {
    return {
      content: [{ type: 'text', text: '## Task Progress Check\n\nNo running tasks.' }]
    };
  }

  const snap1 = new Map();
  running1.forEach(t => snap1.set(t.id, (t.output || '').length));

  // Wait
  await new Promise(r => setTimeout(r, waitSeconds * 1000));

  // Snapshot 2
  const running2 = taskCore.listTasks({ status: 'running', limit: 20 });

  let result = `## Task Progress Check (${waitSeconds}s interval)\n\n`;
  result += '| Task | Host | Runtime | Output | Growth | Status |\n';
  result += '|------|------|---------|--------|--------|--------|\n';

  const issues = [];

  for (const t of running2) {
    const taskId = t.id.slice(0, 12);
    const currLen = (t.output || '').length;
    const prevLen = snap1.get(t.id) || 0;
    const growth = currLen - prevLen;
    const runtime = Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000);
    const runtimeStr = runtime >= 60 ? `${Math.floor(runtime/60)}m ${runtime%60}s` : `${runtime}s`;

    // Check for known stall patterns
    const output = t.output || '';
    let status = '✓ Active';

    if (output.includes('exceeds the') && output.includes('token limit')) {
      status = '✗ CONTEXT EXCEEDED';
      issues.push(`${taskId}: Context limit exceeded - file too large`);
    } else if (output.includes('model') && output.includes('not found')) {
      status = '✗ MODEL NOT FOUND';
      issues.push(`${taskId}: Model not found on host`);
    } else if (output.includes('Connection timed out') || output.includes('APIConnectionError')) {
      status = '⚠ CONNECTION ERROR';
      issues.push(`${taskId}: Connection error to LLM`);
    } else if (growth === 0 && runtime > 30) {
      status = '⚠ No output';
      issues.push(`${taskId}: No new output in ${waitSeconds}s (runtime: ${runtimeStr})`);
    }

    const growthStr = growth > 0 ? `+${growth}` : growth === 0 ? '0' : `${growth}`;
    result += `| ${taskId} | ${t.ollama_host_id || 'n/a'} | ${runtimeStr} | ${currLen} | ${growthStr} | ${status} |\n`;
  }

  // Summary
  const queued = taskCore.countTasks({ status: 'queued' });
  const completed = taskCore.countTasks({ status: 'completed' });
  const failed = taskCore.countTasks({ status: 'failed' });

  result += `\n**Queue:** ${queued} waiting | ${running2.length} running | ${completed} done | ${failed} failed\n`;

  if (issues.length > 0) {
    result += `\n### ⚠️ Issues Detected\n`;
    issues.forEach(i => result += `- ${i}\n`);
  }

  const structuredData = {
    running_count: running2.length,
    tasks: running2.map(t => {
      const runtime = Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000);
      const currLen = (t.output || '').length;
      const prevLen = snap1.get(t.id) || 0;
      const growth = currLen - prevLen;
      let taskStatus = 'active';
      const taskOutput = t.output || '';
      if (taskOutput.includes('exceeds the') && taskOutput.includes('token limit')) {
        taskStatus = 'context_exceeded';
      } else if (taskOutput.includes('model') && taskOutput.includes('not found')) {
        taskStatus = 'model_not_found';
      } else if (taskOutput.includes('Connection timed out') || taskOutput.includes('APIConnectionError')) {
        taskStatus = 'connection_error';
      } else if (growth === 0 && runtime > 30) {
        taskStatus = 'no_output';
      }
      return {
        id: t.id,
        host: t.ollama_host_id || '',
        runtime_seconds: runtime,
        output_length: currLen,
        status: taskStatus,
      };
    }),
  };

  return {
    content: [{ type: 'text', text: result }],
    structuredData,
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Run a health check on Codex CLI
 */
function handleHealthCheck(args) {
  const checkType = args.check_type || 'connectivity';
  const startTime = Date.now();

  let status = 'healthy';
  let errorMessage = null;
  const details = {};

  try {
    // Test Codex CLI availability
    const result = spawnSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: TASK_TIMEOUTS.PROVIDER_CHECK
    });

    if (result.error) {
      status = 'unhealthy';
      errorMessage = `Codex CLI not accessible: ${result.error.message}`;
    } else if (result.status !== 0) {
      status = 'degraded';
      errorMessage = result.stderr || 'Codex CLI returned non-zero exit code';
    } else {
      details.version = result.stdout.trim();
    }

    // Additional checks for 'full' or 'performance' check types
    if ((checkType === 'full' || checkType === 'performance') && status === 'healthy') {
      // Check current running tasks
      const runningTasks = taskManager.getRunningTaskCount();
      const config = configCore.getAllConfig();
      const maxConcurrent = parseInt(config.max_concurrent || '3', 10);

      details.running_tasks = runningTasks;
      details.max_concurrent = maxConcurrent;
      details.capacity = `${runningTasks}/${maxConcurrent}`;

      if (runningTasks >= maxConcurrent) {
        status = 'degraded';
        details.reason = 'At capacity';
      }
    }

    // Check API connectivity for 'api' or 'full' check types
    if ((checkType === 'api' || checkType === 'full') && status === 'healthy') {
      // Simple check - verify Codex can start (with immediate exit)
      const apiResult = spawnSync('codex', ['--help'], {
        encoding: 'utf8',
        timeout: TASK_TIMEOUTS.HEALTH_CHECK
      });

      if (apiResult.error || apiResult.status !== 0) {
        details.api_status = 'unreachable';
      } else {
        details.api_status = 'reachable';
      }
    }

  } catch (error) {
    status = 'unhealthy';
    errorMessage = error.message;
  }

  const responseTime = Date.now() - startTime;

  // Record health check in database
  projectConfigCore.recordHealthCheck(
    checkType,
    status,
    responseTime,
    errorMessage,
    details
  );

  let result = `## Health Check: ${checkType.toUpperCase()}\n\n`;
  result += `**Status:** ${status === 'healthy' ? '✓ Healthy' : status === 'degraded' ? '⚠ Degraded' : '✗ Unhealthy'}\n`;
  result += `**Response Time:** ${responseTime}ms\n`;

  if (errorMessage) {
    result += `**Error:** ${errorMessage}\n`;
  }

  if (Object.keys(details).length > 0) {
    result += `\n### Details\n`;
    for (const [key, value] of Object.entries(details)) {
      result += `- **${key}:** ${value}\n`;
    }
  }

  const structuredData = { check_type: checkType, status, response_time_ms: responseTime };
  if (errorMessage) structuredData.error_message = errorMessage;
  if (Object.keys(details).length > 0) structuredData.details = details;

  return {
    content: [{ type: 'text', text: result }],
    structuredData,
  };
}


/**
 * Get health monitoring status and history
 */
function handleHealthStatus(args) {
  const summary = projectConfigCore.getHealthSummary();
  const latestCheck = projectConfigCore.getLatestHealthCheck();

  let result = `## Health Monitoring Status\n\n`;

  // Current status
  if (latestCheck) {
    const statusIcon = latestCheck.status === 'healthy' ? '✓' : latestCheck.status === 'degraded' ? '⚠' : '✗';
    result += `### Current Status: ${statusIcon} ${latestCheck.status.toUpperCase()}\n`;
    result += `**Last Check:** ${formatTime(latestCheck.checked_at)}\n`;
    result += `**Response Time:** ${latestCheck.response_time_ms}ms\n`;

    if (latestCheck.error_message) {
      result += `**Last Error:** ${latestCheck.error_message}\n`;
    }
  } else {
    result += `### Current Status: Unknown\n`;
    result += `No health checks recorded yet. Run \`health_check\` to check status.\n`;
  }

  // Summary stats
  if (summary.total_checks > 0) {
    result += `\n### Summary (Last 24h)\n`;
    result += `- **Total Checks:** ${summary.total_checks}\n`;
    result += `- **Healthy:** ${summary.healthy_count} (${summary.uptime_percentage.toFixed(1)}%)\n`;
    result += `- **Degraded:** ${summary.degraded_count}\n`;
    result += `- **Unhealthy:** ${summary.unhealthy_count}\n`;
    result += `- **Avg Response Time:** ${summary.avg_response_time.toFixed(0)}ms\n`;
  }

  // History
  if (args.include_history) {
    const history = providerRoutingCore.getHealthHistory({ limit: safeLimit(args.limit, 10) });

    if (history.length > 0) {
      result += `\n### Recent History\n\n`;
      result += `| Time | Type | Status | Response |\n`;
      result += `|------|------|--------|----------|\n`;

      for (const h of history) {
        const statusIcon = h.status === 'healthy' ? '✓' : h.status === 'degraded' ? '⚠' : '✗';
        result += `| ${formatTime(h.checked_at)} | ${h.check_type} | ${statusIcon} ${h.status} | ${h.response_time_ms}ms |\n`;
      }
    }
  }

  result += `\n### Usage\n`;
  result += `- Run check: \`health_check({check_type: "full"})\`\n`;
  result += `- View history: \`health_status({include_history: true})\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Check for stalled tasks (no output activity)
 */
function handleCheckStalledTasks(args) {
  const autoCancel = args.auto_cancel || false;
  const activities = taskManager.getAllTaskActivity();
  const stalledTasks = taskManager.checkStalledTasks(autoCancel);

  let result = `## Task Activity Monitor\n\n`;

  if (activities.length === 0) {
    result += `No running tasks.\n`;
    return { content: [{ type: 'text', text: result }] };
  }

  result += `### Running Tasks (${activities.length})\n\n`;
  result += `| Task | Elapsed | Last Activity | Status |\n`;
  result += `|------|---------|---------------|--------|\n`;

  for (const activity of activities) {
    const statusIcon = activity.isStalled ? '⚠️ STALLED' :
                       activity.lastActivitySeconds > 60 ? '⏳ Slow' :
                       activity.lastActivitySeconds > 30 ? '⏸️ Idle' : '✅ Active';
    result += `| ${activity.taskId.slice(0, 8)}... | ${activity.elapsedSeconds}s | ${activity.lastActivitySeconds}s ago | ${statusIcon} |\n`;
  }

  if (stalledTasks.length > 0) {
    result += `\n### ⚠️ Stalled Tasks (${stalledTasks.length})\n`;
    result += `Tasks with no output for >${activities[0]?.stallThreshold || 120}s:\n\n`;

    for (const stalled of stalledTasks) {
      if (autoCancel) {
        result += `- ${stalled.taskId.slice(0, 8)}... - **CANCELLED** (inactive ${stalled.lastActivitySeconds}s)\n`;
      } else {
        result += `- ${stalled.taskId.slice(0, 8)}... - No output for ${stalled.lastActivitySeconds}s\n`;
      }
    }

    if (!autoCancel) {
      result += `\nTo cancel stalled tasks: \`check_stalled_tasks({auto_cancel: true})\`\n`;
    }
  } else {
    result += `\n✅ No stalled tasks detected.\n`;
  }

  const structuredData = {
    running_count: activities.length,
    stalled_count: stalledTasks.length,
    tasks: activities.map(a => ({
      id: a.taskId,
      elapsed_seconds: a.elapsedSeconds,
      last_activity_seconds: a.lastActivitySeconds,
      is_stalled: !!a.isStalled,
    })),
  };

  return { content: [{ type: 'text', text: result }], structuredData };
}


// ============ Task Scheduling Handlers ============

/**
 * Schedule a task
 */
function handleScheduleTask(args) {
  // Input validation
  if (!args.task || typeof args.task !== 'string' || args.task.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task must be a non-empty string');
  }
  if (!args.schedule_type || !['once', 'interval'].includes(args.schedule_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'schedule_type must be "once" or "interval"');
  }
  if (args.timeout_minutes !== undefined && (typeof args.timeout_minutes !== 'number' || args.timeout_minutes < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'timeout_minutes must be a positive number');
  }
  if (args.priority !== undefined && typeof args.priority !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'priority must be a number');
  }
  if (args.interval_minutes !== undefined && (typeof args.interval_minutes !== 'number' || args.interval_minutes < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'interval_minutes must be a positive number');
  }
  if (args.max_runs !== undefined && (typeof args.max_runs !== 'number' || args.max_runs < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'max_runs must be a positive number');
  }

  const scheduleId = uuidv4();

  // Validate schedule type and required parameters
  if (args.schedule_type === 'once' && !args.run_at) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, '"run_at" is required for "once" schedule type');
  }

  if (args.schedule_type === 'interval' && !args.interval_minutes) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, '"interval_minutes" is required for "interval" schedule type');
  }

  // Calculate next run time
  let nextRunAt;
  if (args.schedule_type === 'once') {
    nextRunAt = args.run_at;
  } else if (args.schedule_type === 'interval') {
    // Start immediately or after first interval
    nextRunAt = args.run_at || new Date(Date.now() + args.interval_minutes * 60000).toISOString();
  }

  const scheduled = projectConfigCore.createScheduledTask({
    id: scheduleId,
    name: args.name,
    task_description: args.task,
    working_directory: args.working_directory,
    timeout_minutes: args.timeout_minutes || 30,
    priority: args.priority || 0,
    tags: args.tags,
    schedule_type: args.schedule_type,
    scheduled_time: args.run_at,
    repeat_interval_minutes: args.interval_minutes,
    next_run_at: nextRunAt,
    max_runs: args.max_runs
  });

  let result = `## Task Scheduled\n\n`;
  result += `**ID:** ${scheduleId}\n`;
  result += `**Name:** ${scheduled.name}\n`;
  result += `**Type:** ${scheduled.schedule_type}\n`;
  result += `**Next Run:** ${formatTime(scheduled.next_run_at)}\n`;

  if (scheduled.repeat_interval_minutes) {
    result += `**Interval:** Every ${scheduled.repeat_interval_minutes} minutes\n`;
  }
  if (scheduled.max_runs) {
    result += `**Max Runs:** ${scheduled.max_runs}\n`;
  }

  result += `\n**Task:** ${(scheduled.task_description || '').slice(0, 100)}...`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * List scheduled tasks
 */
function handleListScheduled(args) {
  const scheduled = projectConfigCore.listScheduledTasks({
    status: args.status,
    limit: safeLimit(args.limit, 20)
  });

  if (scheduled.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Scheduled Tasks\n\nNo scheduled tasks found. Use \`schedule_task\` to create one.`
      }]
    };
  }

  let result = `## Scheduled Tasks\n\n`;
  result += `| ID | Name | Type | Status | Next Run | Runs |\n`;
  result += `|----|------|------|--------|----------|------|\n`;

  for (const s of scheduled) {
    const nextRun = s.next_run_at ? formatTime(s.next_run_at) : 'N/A';
    const runs = s.max_runs ? `${s.run_count}/${s.max_runs}` : `${s.run_count}`;
    result += `| ${s.id.slice(0, 8)}... | ${(s.name || '').slice(0, 20)} | ${s.schedule_type} | ${s.status} | ${nextRun} | ${runs} |\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Cancel a scheduled task
 */
function handleCancelScheduled(args) {
  const scheduled = projectConfigCore.getScheduledTask(args.schedule_id);

  if (!scheduled) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Scheduled task not found: ${args.schedule_id}`);
  }

  const deleted = projectConfigCore.deleteScheduledTask(args.schedule_id);

  if (deleted) {
    return {
      content: [{
        type: 'text',
        text: `## Scheduled Task Cancelled\n\n**Name:** ${scheduled.name}\n**Ran:** ${scheduled.run_count} times`
      }]
    };
  }

  return makeError(ErrorCodes.OPERATION_FAILED, 'Failed to cancel scheduled task');
}


/**
 * Pause or resume a scheduled task
 */
function handlePauseScheduled(args) {
  if (!args.schedule_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'schedule_id is required');
  }
  if (args.action !== 'pause' && args.action !== 'resume') {
    return makeError(ErrorCodes.INVALID_PARAM, 'action must be "pause" or "resume"');
  }

  const scheduled = projectConfigCore.getScheduledTask(args.schedule_id);

  if (!scheduled) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Scheduled task not found: ${args.schedule_id}`);
  }

  const newStatus = args.action === 'pause' ? 'paused' : 'active';
  projectConfigCore.updateScheduledTask(args.schedule_id, { status: newStatus });

  return {
    content: [{
      type: 'text',
      text: `## Scheduled Task ${args.action === 'pause' ? 'Paused' : 'Resumed'}\n\n**Name:** ${scheduled.name}\n**Status:** ${newStatus}`
    }]
  };
}


// ============ Batch Operation Handlers ============

/**
 * Batch cancel tasks
 *
 * FIX: Previously only did a SQL UPDATE — running child processes were never killed,
 * causing zombie processes that held host slots and consumed resources indefinitely.
 * Now properly kills running processes via taskManager.cancelTask() before bulk-updating.
 */
function listTasksForBatchCancel(options = {}, statuses = []) {
  const results = [];
  const normalizedStatuses = [...new Set(
    statuses.filter((status) => typeof status === 'string' && status.trim())
  )];

  for (const status of normalizedStatuses) {
    let offset = 0;
    const limit = 1000;
    while (true) {
      const page = taskCore.listTasks({ ...options, status, limit, offset });
      results.push(...page);
      if (page.length < limit) {
        break;
      }
      offset += page.length;
    }
  }

  return results;
}

function handleBatchCancel(args) {
  // Input validation
  if (args.status !== undefined && typeof args.status !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'status must be a string');
  }
  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'tags must be an array');
  }
  if (args.older_than_hours !== undefined && (typeof args.older_than_hours !== 'number' || args.older_than_hours < 0)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'older_than_hours must be a non-negative number');
  }
  if (args.provider !== undefined && typeof args.provider !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'provider must be a string');
  }

  const options = {};

  if (args.status) {
    options.status = args.status;
  }

  if (args.tags) {
    options.tags = args.tags;
  }

  if (args.older_than_hours !== undefined && args.older_than_hours !== null) {
    const cutoff = new Date(Date.now() - args.older_than_hours * 3600000);
    options.olderThan = cutoff.toISOString();
  }

  if (args.provider) {
    options.provider = args.provider;
  }

  // Create bulk operation record
  const operationId = uuidv4();
  taskMetadata.createBulkOperation({
    id: operationId,
    operation_type: 'cancel',
    filter_criteria: options,
    dry_run: false
  });

  // FIX: Kill running processes BEFORE bulk DB update.
  // Previously batchCancelTasks() only did a SQL UPDATE — child processes kept running
  // as zombies, holding host slots and consuming resources. Now we first cancel running
  // tasks via cancelTask() which kills processes, frees slots, and triggers processQueue().
  // cancelTask() also updates DB status to 'cancelled', so batchCancelTasks() below
  // won't double-cancel them (its WHERE clause requires status IN running/queued/pending).
  const cancelledTaskIds = new Set();
  const killedTaskIds = new Set();
  if (!args.status || args.status === 'running') {
    const runningTasks = listTasksForBatchCancel(options, ['running']);
    for (const task of runningTasks) {
      try {
        taskManager.cancelTask(task.id, 'Batch cancel');
        killedTaskIds.add(task.id);
        cancelledTaskIds.add(task.id);
      } catch (err) {
        // Task may have already completed between query and cancel — continue
        logger.debug('[task-operations] non-critical error cancelling task in bulk:', err.message || err);
      }
    }
  }

  const bulkCandidateStatuses = args.status ? [args.status] : ['running', 'queued', 'pending'];
  const bulkCandidates = listTasksForBatchCancel(options, bulkCandidateStatuses);
  for (const task of bulkCandidates) {
    cancelledTaskIds.add(task.id);
  }

  // Bulk-update any remaining matching tasks, including running tasks we did not kill directly.
  taskMetadata.batchCancelTasks(options);
  const processesKilled = killedTaskIds.size;
  const totalCancelled = cancelledTaskIds.size;

  // Update operation with results
  taskMetadata.updateBulkOperation(operationId, {
    status: 'completed',
    total_tasks: totalCancelled,
    succeeded_tasks: totalCancelled,
    failed_tasks: 0
  });

  let result = `## Batch Cancel Complete\n\n`;
  result += `**Operation ID:** ${operationId}\n`;
  result += `**Tasks Cancelled:** ${totalCancelled}\n`;
  result += `**Running Processes Killed:** ${processesKilled}\n\n`;

  if (args.status) result += `- Status filter: ${args.status}\n`;
  if (args.tags) result += `- Tags filter: ${args.tags.join(', ')}\n`;
  if (args.older_than_hours) result += `- Older than: ${args.older_than_hours} hours\n`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Batch retry failed tasks
 */
function handleBatchRetry(args) {
  // Input validation
  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'tags must be an array');
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || args.limit < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'limit must be a positive number');
  }

  const options = {
    tags: args.tags,
    limit: safeLimit(args.limit, 10)
  };

  // Create bulk operation record
  const operationId = uuidv4();
  taskMetadata.createBulkOperation({
    id: operationId,
    operation_type: 'retry',
    filter_criteria: { ...options, include_cancelled: args.include_cancelled },
    dry_run: false
  });

  // Get retryable tasks
  const tasks = taskMetadata.getRetryableTasks(options);

  if (tasks.length === 0) {
    taskMetadata.updateBulkOperation(operationId, {
      status: 'completed',
      total_tasks: 0,
      succeeded_tasks: 0,
      failed_tasks: 0
    });
    return {
      content: [{
        type: 'text',
        text: `## Batch Retry\n\n**Operation ID:** ${operationId}\n\nNo failed tasks found matching filters.`
      }]
    };
  }

  // Filter to only failed if not including cancelled
  const toRetry = args.include_cancelled
    ? tasks
    : tasks.filter(t => t.status === 'failed');

  if (toRetry.length === 0) {
    taskMetadata.updateBulkOperation(operationId, {
      status: 'completed',
      total_tasks: 0,
      succeeded_tasks: 0,
      failed_tasks: 0
    });
    return {
      content: [{
        type: 'text',
        text: `## Batch Retry\n\n**Operation ID:** ${operationId}\n\nNo failed tasks found. Set include_cancelled=true to also retry cancelled tasks.`
      }]
    };
  }

  // Create retry tasks
  const retried = [];
  const affectedIds = [];
  for (const task of toRetry.slice(0, safeLimit(args.limit, 10))) {
    const newId = uuidv4();
    taskCore.createTask({
      id: newId,
      status: 'pending',
      task_description: task.task_description,
      working_directory: task.working_directory,
      timeout_minutes: task.timeout_minutes,
      auto_approve: task.auto_approve,
      priority: (task.priority || 0) + 1,
      tags: task.tags,
      context: { retry_of: task.id }
    });

    taskManager.startTask(newId);
    retried.push({ original: task.id, new: newId });
    affectedIds.push(newId);
  }

  // Update operation with results
  taskMetadata.updateBulkOperation(operationId, {
    status: 'completed',
    affected_task_ids: affectedIds,
    total_tasks: retried.length,
    succeeded_tasks: retried.length,
    failed_tasks: 0,
    results: { retried }
  });

  let result = `## Batch Retry Complete\n\n`;
  result += `**Operation ID:** ${operationId}\n`;
  result += `**Tasks Retried:** ${retried.length}\n\n`;
  result += `| Original | New Task |\n`;
  result += `|----------|----------|\n`;

  for (const r of retried) {
    result += `| ${r.original.slice(0, 8)}... | ${r.new.slice(0, 8)}... |\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Batch add tags to tasks
 */
function handleBatchTag(args) {
  // Input validation
  if (!args.tags || !Array.isArray(args.tags) || args.tags.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'tags must be a non-empty array');
  }
  if (args.filter_status !== undefined && typeof args.filter_status !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'filter_status must be a string');
  }
  if (args.filter_tags !== undefined && !Array.isArray(args.filter_tags)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'filter_tags must be an array');
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || args.limit < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'limit must be a positive number');
  }

  const options = {
    status: args.filter_status,
    existingTags: args.filter_tags,
    limit: safeLimit(args.limit, 50)
  };

  // Create bulk operation record
  const operationId = uuidv4();
  taskMetadata.createBulkOperation({
    id: operationId,
    operation_type: 'tag',
    filter_criteria: { ...options, tags_to_add: args.tags },
    dry_run: false
  });

  const updated = taskMetadata.batchAddTagsByFilter(options, args.tags);

  // Update operation with results
  taskMetadata.updateBulkOperation(operationId, {
    status: 'completed',
    total_tasks: updated,
    succeeded_tasks: updated,
    failed_tasks: 0
  });

  let result = `## Batch Tag Complete\n\n`;
  result += `**Operation ID:** ${operationId}\n`;
  result += `**Tasks Updated:** ${updated}\n`;
  result += `**Tags Added:** ${args.tags.join(', ')}\n\n`;

  if (args.filter_status) result += `- Status filter: ${args.filter_status}\n`;
  if (args.filter_tags) result += `- Tag filter: ${args.filter_tags.join(', ')}\n`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Output Search Handlers ============

/**
 * Search task outputs
 */
function handleSearchOutputs(args) {
  if (!args.pattern || args.pattern.length < 2) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Pattern must be at least 2 characters');
  }

  const results = eventTracking.searchTaskOutputs(args.pattern, {
    status: args.status,
    tags: args.tags,
    since: safeDate(args.since),
    limit: safeLimit(args.limit, 20)
  });

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Output Search\n\nNo matches found for "${args.pattern}"`
      }]
    };
  }

  let result = `## Output Search: "${args.pattern}"\n\n`;
  result += `**Matches:** ${results.length}\n\n`;

  for (const r of results) {
    result += `### Task: ${r.id.slice(0, 8)}...\n`;
    result += `**Status:** ${r.status} | **Created:** ${formatTime(r.created_at)}\n`;
    result += `**Description:** ${(r.task_description || '').slice(0, 60)}...\n\n`;

    if (r.snippets.length > 0) {
      result += `**Matches:**\n`;
      for (const s of r.snippets) {
        result += `- [${s.source}] ...${s.text}...\n`;
      }
    }
    result += `\n---\n\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get output statistics
 */
function handleOutputStats(_args) {
  const stats = eventTracking.getOutputStats();

  let result = `## Task Output Statistics\n\n`;
  result += `**Total Completed/Failed Tasks:** ${stats.total_tasks}\n`;
  result += `**Tasks with Output:** ${stats.tasks_with_output}\n`;
  result += `**Tasks with Errors:** ${stats.tasks_with_errors}\n`;

  // Format bytes nicely
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  };

  result += `\n### Storage\n`;
  result += `- **Output Size:** ${formatBytes(stats.total_output_bytes)}\n`;
  result += `- **Error Size:** ${formatBytes(stats.total_error_bytes)}\n`;
  result += `- **Total:** ${formatBytes((stats.total_output_bytes || 0) + (stats.total_error_bytes || 0))}\n`;

  // Error pattern analysis (L-7)
  if (stats.error_patterns && stats.error_patterns.length > 0) {
    result += `\n### Error Patterns\n\n`;
    result += `| Category | Count |\n`;
    result += `|----------|-------|\n`;
    for (const ep of stats.error_patterns) {
      result += `| ${ep.category} | ${ep.count} |\n`;
    }
  }

  // Daily error trend (L-8)
  if (stats.error_trend && stats.error_trend.length > 0) {
    result += `\n### Error Trend (Last 7 Days)\n\n`;
    result += `| Day | Errors |\n`;
    result += `|-----|--------|\n`;
    for (const et of stats.error_trend) {
      result += `| ${et.day} | ${et.error_count} |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Export/Import Handlers ============

/**
 * Export data to JSON
 */
function handleExportData(args) {
  const options = {};

  if (args.include && args.include.length > 0) {
    options.include = args.include;
  }

  if (args.task_status) {
    options.taskStatus = args.task_status;
  }

  if (args.task_limit) {
    options.taskLimit = args.task_limit;
  }

  const exportData = eventTracking.exportData(options);

  // Count items
  const counts = {
    tasks: exportData.data.tasks ? exportData.data.tasks.length : 0,
    templates: exportData.data.templates ? exportData.data.templates.length : 0,
    pipelines: exportData.data.pipelines ? exportData.data.pipelines.length : 0,
    scheduled_tasks: exportData.data.scheduled_tasks ? exportData.data.scheduled_tasks.length : 0
  };

  // Save to file if requested
  if (args.output_file) {
    // Path traversal protection
    if (!isPathTraversalSafe(args.output_file)) {
      return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid output file path: path traversal not allowed');
    }
    try {
      fs.writeFileSync(args.output_file, JSON.stringify(exportData, null, 2));

      return {
        content: [{
          type: 'text',
          text: `## Data Exported\n\n**File:** ${args.output_file}\n**Exported at:** ${exportData.exported_at}\n\n### Items Exported\n- Tasks: ${counts.tasks}\n- Templates: ${counts.templates}\n- Pipelines: ${counts.pipelines}\n- Scheduled Tasks: ${counts.scheduled_tasks}`
        }]
      };
    } catch (error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to write export file: ${error.message}`);
    }
  }

  // Return JSON as text
  let result = `## Data Export\n\n**Exported at:** ${exportData.exported_at}\n**Version:** ${exportData.version}\n\n`;
  result += `### Items Exported\n- Tasks: ${counts.tasks}\n- Templates: ${counts.templates}\n- Pipelines: ${counts.pipelines}\n- Scheduled Tasks: ${counts.scheduled_tasks}\n\n`;
  result += `### JSON Data\n\`\`\`json\n${JSON.stringify(exportData, null, 2).slice(0, 5000)}${JSON.stringify(exportData).length > 5000 ? '\n... (truncated)' : ''}\n\`\`\`\n\n`;
  result += `*Tip: Use output_file parameter to save full export to a file.*`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Import data from JSON
 */
function handleImportData(args) {
  if (!args.file_path && !args.json_data) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Either file_path or json_data is required');
  }

  let importObj;

  if (args.file_path) {
    // Path traversal protection
    if (!isPathTraversalSafe(args.file_path)) {
      return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid file path: path traversal not allowed');
    }
    try {
      const content = fs.readFileSync(args.file_path, 'utf8');
      importObj = eventTracking.safeJsonParse(content, null);
      if (importObj === null) {
        return makeError(ErrorCodes.INVALID_PARAM, 'Failed to parse import file: invalid JSON');
      }
    } catch (error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to read import file: ${error.message}`);
    }
  } else {
    importObj = eventTracking.safeJsonParse(args.json_data, null);
    if (importObj === null) {
      return makeError(ErrorCodes.INVALID_PARAM, 'Failed to parse JSON data: invalid JSON');
    }
  }

  // Validate batch sizes for imported data
  const tasksCount = Array.isArray(importObj.tasks) ? importObj.tasks.length : 0;
  const templatesCount = Array.isArray(importObj.templates) ? importObj.templates.length : 0;
  const maxImportBatch = MAX_BATCH_SIZE * 10; // Allow larger batch for imports (1000)

  if (tasksCount > maxImportBatch) {
    return makeError(ErrorCodes.INVALID_PARAM, `Too many tasks: maximum ${maxImportBatch} allowed per import`);
  }
  if (templatesCount > MAX_BATCH_SIZE) {
    return makeError(ErrorCodes.INVALID_PARAM, `Too many templates: maximum ${MAX_BATCH_SIZE} allowed per import`);
  }

  const options = {
    skipExisting: args.skip_existing !== false
  };

  const results = eventTracking.importData(importObj, options);

  let result = `## Data Import Complete\n\n`;
  result += `**Source:** ${args.file_path || 'JSON data'}\n`;
  result += `**Skip Existing:** ${options.skipExisting}\n\n`;

  result += `### Results\n`;
  result += `| Type | Imported | Skipped | Errors |\n`;
  result += `|------|----------|---------|--------|\n`;

  for (const [type, stats] of Object.entries(results)) {
    result += `| ${type} | ${stats.imported} | ${stats.skipped} | ${stats.errors.length} |\n`;
  }

  // Show errors if any
  const allErrors = [];
  for (const [type, stats] of Object.entries(results)) {
    for (const err of stats.errors) {
      allErrors.push(`[${type}] ${err}`);
    }
  }

  if (allErrors.length > 0) {
    result += `\n### Errors\n`;
    for (const err of allErrors.slice(0, 10)) {
      result += `- ${err}\n`;
    }
    if (allErrors.length > 10) {
      result += `... and ${allErrors.length - 10} more errors\n`;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Archiving Handlers ============

/**
 * Archive a single task
 */
function handleArchiveTask(args) {
  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  if (['pending', 'queued', 'running'].includes(task.status)) {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Cannot archive task with status: ${task.status}. Only completed, failed, or cancelled tasks can be archived.`);
  }

  const archived = taskMetadata.archiveTask(args.task_id, args.reason);

  if (!archived) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Failed to archive task');
  }

  return {
    content: [{
      type: 'text',
      text: `## Task Archived\n\n**ID:** ${args.task_id}\n**Description:** ${(task.task_description || '').slice(0, 60)}...\n**Status:** ${task.status}\n**Reason:** ${args.reason || '(none)'}\n\nUse \`restore_task({task_id: "${args.task_id}"})\` to restore.`
    }]
  };
}


/**
 * Bulk archive tasks
 */
function handleArchiveTasks(args) {
  const options = {
    status: args.status || 'completed',
    limit: safeLimit(args.limit, 50),
    reason: args.reason
  };

  if (args.older_than_days) {
    const cutoff = new Date(Date.now() - args.older_than_days * 24 * 60 * 60 * 1000);
    options.olderThan = cutoff.toISOString();
  }

  if (args.tags) {
    options.tags = args.tags;
  }

  const result = taskMetadata.archiveTasks(options);

  let text = `## Bulk Archive Complete\n\n`;
  text += `**Tasks Archived:** ${result.archived}\n`;
  text += `**Status Filter:** ${options.status}\n`;

  if (args.older_than_days) {
    text += `**Age Filter:** Older than ${args.older_than_days} days\n`;
  }

  if (args.tags) {
    text += `**Tag Filter:** ${args.tags.join(', ')}\n`;
  }

  if (args.reason) {
    text += `**Reason:** ${args.reason}\n`;
  }

  text += `\nUse \`list_archived\` to view archived tasks.`;

  return {
    content: [{ type: 'text', text }]
  };
}


/**
 * List archived tasks
 */
function handleListArchived(args) {
  const archived = taskMetadata.listArchivedTasks({
    limit: safeLimit(args.limit, 20),
    offset: safeOffset(args.offset)
  });

  if (archived.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Archived Tasks\n\nNo archived tasks found. Use \`archive_task\` or \`archive_tasks\` to archive completed tasks.`
      }]
    };
  }

  let result = `## Archived Tasks\n\n`;
  result += `| ID | Status | Description | Archived At | Reason |\n`;
  result += `|----|--------|-------------|-------------|--------|\n`;

  const structuredTasks = [];
  for (const a of archived) {
    const data = eventTracking.safeJsonParse(a.original_data, {});
    const status = data.status || 'unknown';
    const desc = (data.task_description || '').slice(0, 25);
    result += `| ${a.id.slice(0, 8)}... | ${status} | ${desc}... | ${formatTime(a.archived_at)} | ${(a.archive_reason || '-').slice(0, 15)} |\n`;
    structuredTasks.push({
      id: a.id,
      status,
      description: data.task_description || '',
      archived_at: a.archived_at || '',
      reason: a.archive_reason || '',
    });
  }

  result += `\nRestore with: \`restore_task({task_id: "..."})\``;

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      count: structuredTasks.length,
      tasks: structuredTasks,
    },
  };
}


/**
 * Restore an archived task
 */
function handleRestoreTask(args) {
  const archived = taskMetadata.getArchivedTask(args.task_id);

  if (!archived) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Archived task not found: ${args.task_id}`);
  }

  const restored = taskMetadata.restoreTask(args.task_id);

  if (!restored) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Failed to restore task');
  }

  return {
    content: [{
      type: 'text',
      text: `## Task Restored\n\n**ID:** ${restored.id}\n**Status:** ${restored.status}\n**Description:** ${(restored.task_description || '').slice(0, 60)}...\n\nTask is now back in the main task list.`
    }]
  };
}


/**
 * Get archive statistics
 */
function handleGetArchiveStats(_args) {
  const stats = taskMetadata.getArchiveStats();

  let result = `## Archive Statistics\n\n`;
  result += `**Total Archived:** ${stats.total_archived}\n`;
  result += `**Oldest Archive:** ${stats.oldest_archive ? formatTime(stats.oldest_archive) : 'N/A'}\n`;
  result += `**Newest Archive:** ${stats.newest_archive ? formatTime(stats.newest_archive) : 'N/A'}\n\n`;

  if (stats.by_status && Object.keys(stats.by_status).length > 0) {
    result += `### By Status\n`;
    result += `| Status | Count |\n`;
    result += `|--------|-------|\n`;
    for (const [status, count] of Object.entries(stats.by_status)) {
      result += `| ${status} | ${count} |\n`;
    }
  }

  if (stats.by_reason && Object.keys(stats.by_reason).length > 0) {
    result += `\n### By Reason\n`;
    result += `| Reason | Count |\n`;
    result += `|--------|-------|\n`;
    for (const [reason, count] of Object.entries(stats.by_reason)) {
      result += `| ${reason || '(no reason)'} | ${count} |\n`;
    }
  }

  result += `\n### Usage\n`;
  result += `- Archive old tasks: \`archive_tasks({older_than_days: 30})\`\n`;
  result += `- View archived: \`list_archived\`\n`;
  result += `- Restore task: \`restore_task({task_id: "..."})\``;

  return {
    content: [{ type: 'text', text: result }],
    structuredData: {
      total_archived: stats.total_archived,
      by_status: stats.by_status || {},
      by_reason: stats.by_reason || {},
    },
  };
}


function createTaskOperationsHandlers(deps) {
  return {
    handleTagTask,
    handleUntagTask,
    handleListTags,
    handleCheckTaskProgress,
    handleHealthCheck,
    handleHealthStatus,
    handleCheckStalledTasks,
    handleScheduleTask,
    handleListScheduled,
    handleCancelScheduled,
    handlePauseScheduled,
    handleBatchCancel,
    handleBatchRetry,
    handleBatchTag,
    handleSearchOutputs,
    handleOutputStats,
    handleExportData,
    handleImportData,
    handleArchiveTask,
    handleArchiveTasks,
    handleListArchived,
    handleRestoreTask,
    handleGetArchiveStats,
  };
}

module.exports = {
  handleTagTask,
  handleUntagTask,
  handleListTags,
  handleCheckTaskProgress,
  handleHealthCheck,
  handleHealthStatus,
  handleCheckStalledTasks,
  handleScheduleTask,
  handleListScheduled,
  handleCancelScheduled,
  handlePauseScheduled,
  handleBatchCancel,
  handleBatchRetry,
  handleBatchTag,
  handleSearchOutputs,
  handleOutputStats,
  handleExportData,
  handleImportData,
  handleArchiveTask,
  handleArchiveTasks,
  handleListArchived,
  handleRestoreTask,
  handleGetArchiveStats,
  createTaskOperationsHandlers,
};
