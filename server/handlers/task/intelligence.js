/**
 * Task Intelligence — Streaming, control, smart intelligence, collaboration,
 *                     bulk operations, duration prediction, review, delete
 * Extracted from task-handlers.js during decomposition.
 *
 * Handlers: handleStreamTaskOutput, handleGetTaskLogs, handleSubscribeTaskEvents,
 *           handlePollTaskEvents, handlePauseTask, handleResumeTask,
 *           handleListPausedTasks, handleSuggestImprovements, handleFindSimilarTasks,
 *           handleLearnDefaults, handleApplySmartDefaults, handleAddComment,
 *           handleListComments, handleTaskTimeline, handleDryRunBulk,
 *           handleBulkOperationStatus, handleListBulkOperations,
 *           handlePredictDuration, handleDurationInsights, handleCalibratePredictions,
 *           handleStartPendingTask, handleSetTaskReviewStatus,
 *           handleListPendingReviews, handleListTasksNeedingCorrection,
 *           handleSetTaskComplexity, handleGetComplexityRouting, handleDeleteTask
 */

const taskCore = require('../../db/task-core');
const analytics = require('../../db/analytics');
const hostManagement = require('../../db/host/management');
const schedulingAutomation = require('../../db/scheduling-automation');
const taskMetadata = require('../../db/task-metadata');
const webhooksStreaming = require('../../db/webhooks-streaming');
const taskManager = require('../../task-manager');
const { safeLimit, safeOffset, MAX_LIMIT, ErrorCodes, makeError, requireTask } = require('../shared');
const logger = require('../../logger').child({ component: 'task-intelligence' });


// ============================================================
// Wave 2 Phase 1: Real-time & Control Handlers
// ============================================================

/**
 * Stream task output - get live output chunks
 */
function handleStreamTaskOutput(args) {
  const { task_id, since_sequence = 0, limit = 50 } = args;
  // Validate sequence number (non-negative integer, bounded)
  const safeSequence = safeOffset(since_sequence);
  const safeStreamLimit = safeLimit(limit, 50, 500);

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const chunks = webhooksStreaming.getLatestStreamChunks(task_id, safeSequence, safeStreamLimit);
  const maxSequence = chunks.length > 0
    ? Math.max(...chunks.map(c => c.sequence_num))
    : since_sequence;

  // Combine chunks into output
  const output = chunks.map(c => c.chunk_data).join('');

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        task_id,
        status: task.status,
        chunk_count: chunks.length,
        last_sequence: maxSequence,
        has_more: chunks.length === limit,
        output
      }, null, 2)
    }]
  };
}


/**
 * Get task logs with filtering
 */
function handleGetTaskLogs(args) {
  const { task_id, level, search, limit = 500 } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const logs = webhooksStreaming.getTaskLogs(task_id, { level, search, limit });

  // Format logs for display
  let output = `## Task Logs: ${task_id}\n\n`;
  output += `**Status:** ${task.status}\n`;
  output += `**Filter:** level=${level || 'all'}, search=${search || 'none'}\n`;
  output += `**Results:** ${logs.length} entries\n\n`;
  output += '```\n';

  for (const log of logs) {
    const prefix = log.type === 'stderr' ? '[ERR]' : '[OUT]';
    output += `${log.timestamp} ${prefix} ${log.content}`;
    if (!log.content.endsWith('\n')) output += '\n';
  }

  output += '```';

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Subscribe to task events
 */
function handleSubscribeTaskEvents(args) {
  const { task_id, event_types = ['status_change'], expires_in_minutes = 60 } = args;

  // Validate task exists if specified
  if (task_id) {
    const { error: taskErr } = requireTask(task_id);
    if (taskErr) return taskErr;
  }

  if (!Array.isArray(event_types)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'event_types must be an array');
  }

  const VALID_EVENT_TYPES = ['status_change', 'completed', 'failed', 'started', 'cancelled', 'output', 'output_update'];
  for (const et of event_types) {
    if (!VALID_EVENT_TYPES.includes(et)) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid event type: ${et}. Valid types: ${VALID_EVENT_TYPES.join(', ')}`);
    }
  }

  if (typeof expires_in_minutes !== 'number' || expires_in_minutes <= 0 || expires_in_minutes > 10080) {
    return makeError(ErrorCodes.INVALID_PARAM, 'expires_in_minutes must be a positive number (max 10080 = 1 week)');
  }

  const subscriptionId = webhooksStreaming.createEventSubscription(task_id, event_types, expires_in_minutes);

  return {
    content: [{
      type: 'text',
      text: `## Event Subscription Created\n\n` +
        `**Subscription ID:** \`${subscriptionId}\`\n` +
        `**Task:** ${task_id || 'All tasks'}\n` +
        `**Events:** ${event_types.join(', ')}\n` +
        `**Expires in:** ${expires_in_minutes} minutes\n\n` +
        `Use \`poll_task_events\` with this subscription ID to receive events.`
    }]
  };
}


/**
 * Poll for task events
 */
function handlePollTaskEvents(args) {
  const { subscription_id } = args;

  const result = webhooksStreaming.pollSubscription(subscription_id);

  if (!result) {
    return makeError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, `Subscription not found: ${subscription_id}`);
  }

  if (result.expired) {
    return {
      content: [{
        type: 'text',
        text: `## Subscription Expired\n\nThe subscription \`${subscription_id}\` has expired. Create a new one with \`subscribe_task_events\`.`
      }]
    };
  }

  if (result.events.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No New Events\n\nNo events since last poll for subscription \`${subscription_id}\`.`
      }]
    };
  }

  let output = `## Task Events\n\n`;
  output += `**Subscription:** \`${subscription_id}\`\n`;
  output += `**Events:** ${result.events.length}\n\n`;

  for (const event of result.events) {
    output += `### ${event.event_type}\n`;
    output += `- **Task:** ${event.task_id}\n`;
    output += `- **Time:** ${event.created_at}\n`;
    if (event.old_value || event.new_value) {
      output += `- **Change:** ${event.old_value} → ${event.new_value}\n`;
    }
    if (event.event_data) {
      output += `- **Data:** ${event.event_data}\n`;
    }
    output += '\n';
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Pause a running task
 */
function handlePauseTask(args) {
  const { task_id, reason } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'running') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Cannot pause task with status '${task.status}'. Only running tasks can be paused.`);
  }

  // Pause the process using task manager
  const paused = taskManager.pauseTask(task_id, reason);
  if (!paused) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to pause task: ${task_id}`);
  }

  // Save checkpoint
  const checkpoint = taskManager.getTaskProgress(task_id);
  if (checkpoint) {
    webhooksStreaming.saveTaskCheckpoint(task_id, checkpoint, 'pause');
  }

  // Update database status
  webhooksStreaming.pauseTask(task_id, reason);

  return {
    content: [{
      type: 'text',
      text: `## Task Paused\n\n` +
        `**Task ID:** ${task_id}\n` +
        `**Reason:** ${reason || 'Not specified'}\n` +
        `**Checkpoint saved:** Yes\n\n` +
        `Use \`resume_task\` to continue execution.`
    }]
  };
}


/**
 * Resume a paused task
 */
function handleResumeTask(args) {
  const { task_id } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'paused') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Cannot resume task with status '${task.status}'. Only paused tasks can be resumed.`);
  }

  // Get checkpoint
  const checkpoint = webhooksStreaming.getTaskCheckpoint(task_id);

  // Resume the process
  const resumed = taskManager.resumeTask(task_id);
  if (!resumed) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to resume task: ${task_id}`);
  }

  // Clear pause state
  webhooksStreaming.clearPauseState(task_id);
  webhooksStreaming.recordTaskEvent(task_id, 'status_change', 'paused', 'running', null);

  const pauseDuration = task.paused_at
    ? Math.round((Date.now() - new Date(task.paused_at).getTime()) / 1000 / 60)
    : 0;

  return {
    content: [{
      type: 'text',
      text: `## Task Resumed\n\n` +
        `**Task ID:** ${task_id}\n` +
        `**Was paused for:** ${pauseDuration} minutes\n` +
        `**Checkpoint restored:** ${checkpoint ? 'Yes' : 'No'}\n\n` +
        `Task is now running.`
    }]
  };
}


/**
 * List all paused tasks
 */
function handleListPausedTasks(args) {
  const { project, limit = 50 } = args;

  const tasks = webhooksStreaming.listPausedTasks({ project, limit });

  if (tasks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Paused Tasks\n\nNo paused tasks found${project ? ` for project: ${project}` : ''}.`
      }]
    };
  }

  let output = `## Paused Tasks\n\n`;
  output += `| ID | Description | Paused Duration | Reason |\n`;
  output += `|----|-------------|-----------------|--------|\n`;

  for (const task of tasks) {
    const desc = task.task_description.substring(0, 40) + (task.task_description.length > 40 ? '...' : '');
    const duration = task.paused_minutes ? `${Math.round(task.paused_minutes)} min` : 'Unknown';
    output += `| ${task.id.substring(0, 8)} | ${desc} | ${duration} | ${task.pause_reason || '-'} |\n`;
  }

  output += `\n**Total:** ${tasks.length} paused task(s)`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ============================================================
// Wave 2 Phase 2: Smart Task Intelligence Handlers
// ============================================================

/**
 * Analyze failed task and suggest improvements
 */
function handleSuggestImprovements(args) {
  const { task_id } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'failed') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not failed (status: ${task.status}). Only failed tasks can be analyzed.`);
  }

  // Generate suggestions
  const suggestions = taskMetadata.generateTaskSuggestions(task_id);

  if (suggestions.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Suggestions Found\n\nNo specific improvements could be identified for task \`${task_id}\`.\n\n` +
          `**Error output:**\n\`\`\`\n${(task.error_output || 'No error output').substring(0, 500)}\n\`\`\``
      }]
    };
  }

  let output = `## Improvement Suggestions for Task ${task_id.substring(0, 8)}\n\n`;
  output += `**Task:** ${task.task_description.substring(0, 100)}...\n`;
  output += `**Status:** Failed\n\n`;

  output += `### Suggestions (${suggestions.length}):\n\n`;

  for (const s of suggestions.sort((a, b) => b.confidence - a.confidence)) {
    const confidenceBar = '█'.repeat(Math.round(s.confidence * 10)) + '░'.repeat(10 - Math.round(s.confidence * 10));
    output += `**${s.type}** [${confidenceBar}] ${Math.round(s.confidence * 100)}%\n`;
    output += `> ${s.suggestion}\n\n`;
  }

  if (task.error_output) {
    output += `### Error Output (truncated):\n\`\`\`\n${task.error_output.substring(0, 300)}...\n\`\`\``;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Find similar tasks
 */
function handleFindSimilarTasks(args) {
  const { task_id, limit = 10, min_similarity = 0.3, status_filter } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const results = taskMetadata.findSimilarTasks(task_id, {
    limit,
    minSimilarity: min_similarity,
    statusFilter: status_filter
  });

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Similar Tasks Found\n\nNo tasks found with similarity >= ${min_similarity * 100}% for:\n\n` +
          `> ${task.task_description.substring(0, 200)}`
      }]
    };
  }

  let output = `## Similar Tasks for ${task_id.substring(0, 8)}\n\n`;
  output += `**Source task:** ${task.task_description.substring(0, 80)}...\n`;
  output += `**Minimum similarity:** ${min_similarity * 100}%\n\n`;

  output += `| Similarity | ID | Status | Description |\n`;
  output += `|------------|-----|--------|-------------|\n`;

  for (const r of results) {
    const pct = Math.round(r.similarity * 100);
    const desc = r.task.task_description.substring(0, 40) + '...';
    output += `| ${pct}% | ${r.task.id.substring(0, 8)} | ${r.task.status} | ${desc} |\n`;
  }

  output += `\n**Found:** ${results.length} similar task(s)`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Learn defaults from task history
 */
function handleLearnDefaults(args) {
  const { task_limit = 100 } = args;

  const result = taskMetadata.learnFromRecentTasks(task_limit);

  // Get current learned patterns
  const patterns = taskMetadata.getTaskPatterns({ minHitCount: 1, limit: 20 });

  let output = `## Learning Complete\n\n`;
  output += `**Tasks analyzed:** ${result.tasksProcessed}\n`;
  output += `**Tasks with patterns:** ${result.patternsLearned}\n\n`;

  if (patterns.length === 0) {
    output += `No patterns learned yet. Run more successful tasks to build patterns.`;
  } else {
    output += `### Learned Patterns (${patterns.length}):\n\n`;
    output += `| Type | Pattern | Hits | Success Rate | Suggested Config |\n`;
    output += `|------|---------|------|--------------|------------------|\n`;

    for (const p of patterns) {
      const config = `timeout=${p.suggested_config.timeout_minutes}m, priority=${p.suggested_config.priority}`;
      output += `| ${p.pattern_type} | ${p.pattern_value} | ${p.hit_count} | ${Math.round(p.success_rate * 100)}% | ${config} |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Apply smart defaults to a task description
 */
function handleApplySmartDefaults(args) {
  const { task_description, project } = args;

  const defaults = taskMetadata.getSmartDefaults(task_description, project);

  let output = `## Smart Defaults\n\n`;
  output += `**Task:** ${task_description.substring(0, 100)}${task_description.length > 100 ? '...' : ''}\n`;
  if (project) {
    output += `**Project:** ${project}\n`;
  }
  output += `\n`;

  output += `### Suggested Configuration:\n\n`;
  output += `| Setting | Value | Confidence |\n`;
  output += `|---------|-------|------------|\n`;
  output += `| timeout_minutes | ${defaults.timeout_minutes} | ${defaults.matched_patterns.length > 0 ? Math.round(defaults.confidence * 100) + '%' : 'default'} |\n`;
  output += `| auto_approve | ${defaults.auto_approve} | ${defaults.matched_patterns.length > 0 ? Math.round(defaults.confidence * 100) + '%' : 'default'} |\n`;
  output += `| priority | ${defaults.priority} | ${defaults.matched_patterns.length > 0 ? Math.round(defaults.confidence * 100) + '%' : 'default'} |\n`;

  if (defaults.matched_patterns.length > 0) {
    output += `\n### Matched Patterns:\n\n`;
    for (const p of defaults.matched_patterns) {
      output += `- **${p.type}:** "${p.value}" (${p.hit_count} hits, ${Math.round(p.success_rate * 100)}% success)\n`;
    }
  } else {
    output += `\n*No patterns matched. Using default values. Run \`learn_defaults\` to build patterns from task history.*`;
  }

  output += `\n\n### Example Usage:\n\`\`\`json\n`;
  output += JSON.stringify({
    task: task_description.substring(0, 50) + '...',
    timeout_minutes: defaults.timeout_minutes,
    auto_approve: defaults.auto_approve,
    priority: defaults.priority
  }, null, 2);
  output += `\n\`\`\``;

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ============================================================
// Wave 2 Phase 4: Collaboration & Audit Handlers
// ============================================================

/**
 * Add a comment to a task
 */
function handleAddComment(args) {
  const { task_id, comment, comment_type = 'note', author = 'user' } = args;

  // Verify task exists
  const { task: _task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const result = taskMetadata.addTaskComment(task_id, comment, {
    author,
    commentType: comment_type
  });

  // Record audit log (positional args: entityType, entityId, action, actor, oldValue, newValue, metadata)
  try {
    schedulingAutomation.recordAuditLog('comment', String(result), 'create', author, null, null,
      JSON.stringify({ task_id, comment_type, comment: comment.substring(0, 100) }));
  } catch (err) {
    logger.debug('[task-intelligence] non-critical error writing audit log:', err.message || err);
  }

  const typeIcon = {
    note: '📝',
    blocker: '🚫',
    resolution: '✅'
  }[comment_type] || '📝';

  return {
    content: [{
      type: 'text',
      text: `${typeIcon} Comment added to task ${task_id.substring(0, 8)}...\n\n**Type:** ${comment_type}\n**Author:** ${author}\n**Comment:** ${comment}`
    }]
  };
}


/**
 * List comments for a task
 */
function handleListComments(args) {
  const { task_id, comment_type } = args;

  // Verify task exists
  const { task: _task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const comments = taskMetadata.getTaskComments(task_id, { commentType: comment_type });

  if (comments.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Comments for Task ${task_id.substring(0, 8)}...\n\nNo comments found${comment_type ? ` of type '${comment_type}'` : ''}.`
      }]
    };
  }

  const typeIcon = {
    note: '📝',
    blocker: '🚫',
    resolution: '✅'
  };

  let output = `## Comments for Task ${task_id.substring(0, 8)}...\n\n`;

  for (const c of comments) {
    const icon = typeIcon[c.comment_type] || '📝';
    const time = new Date(c.created_at).toLocaleString();
    output += `### ${icon} ${c.comment_type.toUpperCase()} by ${c.author}\n`;
    output += `*${time}*\n\n`;
    output += `${c.comment_text}\n\n---\n\n`;
  }

  output += `**Total:** ${comments.length} comment(s)`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get full task timeline
 */
function handleTaskTimeline(args) {
  const { task_id } = args;

  // Verify task exists
  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const timeline = taskMetadata.getTaskTimeline(task_id);

  if (timeline.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Timeline for Task ${task_id.substring(0, 8)}...\n\nNo timeline events found.`
      }]
    };
  }

  const eventIcon = {
    created: '🆕',
    status_change: '🔄',
    comment: '💬',
    retry: '🔁',
    approval_requested: '⏳',
    approved: '✅',
    rejected: '❌'
  };

  let output = `## Timeline for Task ${task_id.substring(0, 8)}...\n\n`;
  output += `**Task:** ${task.task_description.substring(0, 50)}...\n`;
  output += `**Current Status:** ${task.status}\n\n`;
  output += `---\n\n`;

  for (const event of timeline) {
    const eventType = event.event_type || event.type || 'unknown';
    const icon = eventIcon[eventType] || '📌';
    const time = new Date(event.timestamp).toLocaleString();

    output += `### ${icon} ${eventType.replace('_', ' ').toUpperCase()}\n`;
    output += `*${time}*\n\n`;

    if (event.details) {
      output += `${event.details}\n\n`;
    }

    output += `---\n\n`;
  }

  output += `**Total Events:** ${timeline.length}`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ============================================================
// Wave 3 Phase 1: Bulk Operations Handlers
// ============================================================

/**
 * Dry run bulk operation - preview without executing
 */
function handleDryRunBulk(args) {
  const { operation, status, tags, older_than_hours, project } = args;

  const filterCriteria = {};
  if (status) {
    filterCriteria.status = Array.isArray(status) ? status : [status];
  }
  if (tags) filterCriteria.tags = tags;
  if (older_than_hours) filterCriteria.older_than_hours = older_than_hours;
  if (project) filterCriteria.project = project;

  const result = taskMetadata.dryRunBulkOperation(operation, filterCriteria);

  let output = `## Dry Run: ${operation.toUpperCase()} Operation\n\n`;
  output += `**Total Tasks Affected:** ${result.total_tasks}\n\n`;

  if (result.total_tasks === 0) {
    output += `No tasks match the specified filters.\n`;
  } else {
    output += `### Filter Criteria\n\n`;
    output += '```json\n';
    output += JSON.stringify(filterCriteria, null, 2);
    output += '\n```\n\n';

    output += `### Preview (first 10)\n\n`;
    output += `| ID | Status | Description |\n`;
    output += `|----|--------|-------------|\n`;

    for (const t of result.preview) {
      output += `| ${t.id.substring(0, 8)}... | ${t.status} | ${t.description} |\n`;
    }

    if (result.total_tasks > 10) {
      output += `\n*...and ${result.total_tasks - 10} more tasks*\n`;
    }

    output += `\n> Use the actual batch operation (batch_cancel, batch_retry, etc.) to execute.`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get bulk operation status
 */
function handleBulkOperationStatus(args) {
  const operation = taskMetadata.getBulkOperation(args.operation_id);

  if (!operation) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Bulk operation not found: ${args.operation_id}`);
  }

  let output = `## Bulk Operation: ${operation.id.substring(0, 8)}...\n\n`;
  output += `**Type:** ${operation.operation_type}\n`;
  output += `**Status:** ${operation.status}\n`;
  output += `**Created:** ${new Date(operation.created_at).toLocaleString('en-US')}\n`;

  if (operation.completed_at) {
    output += `**Completed:** ${new Date(operation.completed_at).toLocaleString('en-US')}\n`;
  }

  output += `\n### Progress\n\n`;
  output += `| Metric | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Total Tasks | ${operation.total_tasks} |\n`;
  output += `| Succeeded | ${operation.succeeded_tasks} |\n`;
  output += `| Failed | ${operation.failed_tasks} |\n`;

  if (operation.error) {
    output += `\n### Error\n\n${operation.error}\n`;
  }

  if (operation.results) {
    output += `\n### Results\n\n`;
    output += '```json\n';
    output += JSON.stringify(operation.results, null, 2);
    output += '\n```\n';
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List bulk operations
 */
function handleListBulkOperations(args) {
  const operations = taskMetadata.listBulkOperations({
    operation_type: args.operation_type,
    status: args.status,
    limit: safeLimit(args.limit, 20)
  });

  let output = `## Bulk Operations\n\n`;

  if (operations.length === 0) {
    output += `No bulk operations found.\n`;
  } else {
    output += `| ID | Type | Status | Tasks | Created |\n`;
    output += `|----|------|--------|-------|--------|\n`;

    for (const op of operations) {
      const created = new Date(op.created_at).toLocaleString();
      output += `| ${op.id.substring(0, 8)}... | ${op.operation_type} | ${op.status} | ${op.total_tasks} | ${created} |\n`;
    }

    output += `\n**Total:** ${operations.length} operations`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ============================================================
// Wave 3 Phase 2: Duration Prediction Handlers
// ============================================================

/**
 * Predict task duration
 */
function handlePredictDuration(args) {
  const { task_description, template_name, project } = args;

  const prediction = analytics.predictDuration(task_description, {
    template_name,
    project
  });

  let output = `## Duration Prediction\n\n`;
  output += `**Task:** ${task_description.substring(0, 100)}${task_description.length > 100 ? '...' : ''}\n\n`;
  output += `### Estimate\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Predicted Duration | ${prediction.predicted_minutes} minutes |\n`;
  output += `| Confidence | ${Math.round(prediction.confidence * 100)}% |\n`;

  output += `\n### Contributing Factors\n\n`;
  output += `| Source | Name | Value (sec) | Weight |\n`;
  output += `|--------|------|-------------|--------|\n`;

  for (const factor of prediction.factors) {
    output += `| ${factor.source} | ${factor.name} | ${Math.round(factor.value)} | ${Math.round(factor.weight * 100)}% |\n`;
  }

  if (prediction.confidence < 0.5) {
    output += `\n> **Note:** Low confidence prediction. Consider running \`calibrate_predictions\` to improve accuracy with more historical data.`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get duration prediction insights
 */
function handleDurationInsights(args) {
  const insights = analytics.getDurationInsights({
    project: args.project,
    limit: safeLimit(args.limit, 20)
  });

  let output = `## Duration Prediction Insights\n\n`;

  output += `### Accuracy Metrics\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Total Predictions | ${insights.accuracy.total_predictions} |\n`;
  output += `| Average Error | ${insights.accuracy.avg_error_percent || 'N/A'}% |\n`;
  output += `| Within 20% Accuracy | ${insights.accuracy.within_20_percent || 'N/A'}% |\n`;

  if (insights.models.length > 0) {
    output += `\n### Prediction Models\n\n`;
    output += `| Type | Key | Samples | Avg (sec) |\n`;
    output += `|------|-----|---------|----------|\n`;

    for (const model of insights.models) {
      output += `| ${model.model_type} | ${model.model_key || 'global'} | ${model.sample_count} | ${Math.round(model.avg_seconds || 0)} |\n`;
    }
  }

  if (insights.recent_predictions.length > 0) {
    output += `\n### Recent Predictions\n\n`;
    output += `| Task | Predicted | Actual | Error |\n`;
    output += `|------|-----------|--------|-------|\n`;

    for (const pred of insights.recent_predictions.slice(0, 10)) {
      const predicted = Math.round(pred.predicted_seconds / 60);
      const actual = pred.actual_seconds ? Math.round(pred.actual_seconds / 60) : '-';
      const error = pred.error_percent ? `${Math.round(pred.error_percent)}%` : '-';
      output += `| ${pred.task_id?.substring(0, 8) || 'N/A'}... | ${predicted}m | ${actual}${actual !== '-' ? 'm' : ''} | ${error} |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Calibrate prediction models
 */
function handleCalibratePredictions(_args) {
  const results = analytics.calibratePredictionModels();

  let output = `## Prediction Models Calibrated\n\n`;
  output += `**Models Updated:** ${results.models_updated}\n`;
  output += `**Samples Processed:** ${results.samples_processed}\n\n`;

  if (results.models_updated > 0) {
    output += `Prediction models have been recalculated based on historical task data.\n`;
    output += `Use \`duration_insights\` to view the updated models.`;
  } else {
    output += `No models were updated. This may indicate insufficient historical data.\n`;
    output += `Models require at least 2-3 completed tasks to calibrate.`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Start a pending task by changing status to queued
 */
function handleStartPendingTask(args) {
  const { task_id } = args;

  if (!task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'pending') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task ${task_id} is not pending (status: ${task.status})`);
  }

  taskCore.updateTaskStatus(task_id, 'queued');
  taskManager.processQueue();

  let output = `## Task Started\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Task ID | \`${task_id}\` |\n`;
  output += `| Previous Status | pending |\n`;
  output += `| New Status | queued |\n`;

  // Check if this is an aggregation task
  if (task.metadata) {
    try {
      const meta = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : JSON.parse(task.metadata || '{}');
      if (meta.is_aggregation && meta.chunk_task_ids) {
        output += `\n### Aggregation Task\n`;
        output += `This task will aggregate ${meta.chunk_task_ids.length} chunk reviews for \`${meta.file_path}\`.\n`;
      }
    } catch (err) {
      logger.debug('[task-intelligence] non-critical error parsing chunked aggregation metadata:', err.message || err);
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


// ============================================================
// Task Review & Complexity Routing Handlers
// ============================================================

/**
 * Set task review status
 */
function handleSetTaskReviewStatus(args) {
  if (!args.task_id || typeof args.task_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id must be a non-empty string');
  }
  if (!args.status || !['pending', 'approved', 'needs_correction'].includes(args.status)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'status must be one of: pending, approved, needs_correction');
  }

  hostManagement.setTaskReviewStatus(args.task_id, args.status, args.notes || null);

  let output = `## Task Review Status Updated\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Task ID | ${args.task_id} |\n`;
  output += `| Status | ${args.status} |\n`;
  if (args.notes) {
    output += `| Notes | ${args.notes} |\n`;
  }
  output += `| Reviewed At | ${new Date().toISOString()} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List tasks pending review
 */
function handleListPendingReviews(args) {
  const limit = Math.min(args.limit || 20, MAX_LIMIT);
  const tasks = hostManagement.getTasksPendingReview(limit);

  if (!tasks || tasks.length === 0) {
    return {
      content: [{ type: 'text', text: '## No Tasks Pending Review\n\nAll completed tasks have been reviewed.' }]
    };
  }

  let output = `## Tasks Pending Review (${tasks.length})\n\n`;
  output += `| Task ID | Description | Complexity | Provider | Completed |\n`;
  output += `|---------|-------------|------------|----------|----------|\n`;

  for (const task of tasks) {
    const desc = (task.task_description || '').substring(0, 50) + ((task.task_description || '').length > 50 ? '...' : '');
    output += `| ${task.id} | ${desc} | ${task.complexity || 'normal'} | ${task.provider || 'unknown'} | ${task.completed_at || 'N/A'} |\n`;
  }

  output += `\n### Next Steps\n`;
  output += `- Use \`set_task_review_status\` to approve or mark tasks for correction\n`;
  output += `- Use \`get_result\` to view task outputs before approving\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List tasks needing correction
 */
function handleListTasksNeedingCorrection(_args) {
  const tasks = hostManagement.getTasksNeedingCorrection();

  if (!tasks || tasks.length === 0) {
    return {
      content: [{ type: 'text', text: '## No Tasks Needing Correction\n\nNo tasks are currently marked for correction.' }]
    };
  }

  let output = `## Tasks Needing Correction (${tasks.length})\n\n`;

  for (const task of tasks) {
    output += `### ${task.id}\n`;
    output += `**Description:** ${(task.task_description || '').substring(0, 100)}\n`;
    output += `**Complexity:** ${task.complexity || 'normal'}\n`;
    output += `**Review Notes:** ${task.review_notes || 'No notes provided'}\n`;
    output += `**Reviewed At:** ${task.reviewed_at || 'N/A'}\n\n`;
  }

  output += `### Next Steps\n`;
  output += `- Fix the issues noted in each task\n`;
  output += `- Resubmit corrected tasks using \`submit_task\` or \`smart_submit_task\`\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Set task complexity
 */
function handleSetTaskComplexity(args) {
  if (!args.task_id || typeof args.task_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id must be a non-empty string');
  }
  if (!args.complexity || !['simple', 'normal', 'complex'].includes(args.complexity)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'complexity must be one of: simple, normal, complex');
  }

  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  taskCore.updateTaskStatus(args.task_id, task.status, { complexity: args.complexity });

  return {
    content: [{ type: 'text', text: `## Task Complexity Set\n\nTask ${args.task_id} complexity set to **${args.complexity}**.\n\nRouting:\n- simple → Laptop WSL\n- normal → Desktop\n- complex → Codex` }]
  };
}


/**
 * Get complexity-based routing destination
 */
function handleGetComplexityRouting(args) {
  if (!args.complexity || !['simple', 'normal', 'complex'].includes(args.complexity)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'complexity must be one of: simple, normal, complex');
  }

  const routing = hostManagement.routeTask(args.complexity);

  let output = `## Complexity Routing for "${args.complexity}"\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Complexity | ${args.complexity} |\n`;
  output += `| Provider | ${routing.provider} |\n`;
  if (routing.host) {
    output += `| Host | ${routing.host} |\n`;
  }
  if (routing.model) {
    output += `| Model | ${routing.model} |\n`;
  }
  output += `| Rule | ${routing.rule || 'Default'} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Delete task(s) by ID or status
 */
function handleDeleteTask(args) {
  if (args.status) {
    try {
      const result = taskCore.deleteTasks(args.status);
      return { content: [{ type: 'text', text: `Deleted ${result.deleted} task(s) with status '${result.status}'.` }] };
    } catch (err) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to delete tasks: ${err.message}`);
    }
  } else if (args.task_id) {
    try {
      const result = taskCore.deleteTask(args.task_id);
      return { content: [{ type: 'text', text: `Deleted task ${result.id} (was '${result.status}').` }] };
    } catch (err) {
      return makeError(ErrorCodes.TASK_NOT_FOUND, `Failed to delete task: ${err.message}`);
    }
  } else {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide either task_id (single) or status (bulk) to delete tasks.');
  }
}


function createTaskIntelligenceHandlers(_deps) {
  return {
    handleStreamTaskOutput,
    handleGetTaskLogs,
    handleSubscribeTaskEvents,
    handlePollTaskEvents,
    handlePauseTask,
    handleResumeTask,
    handleListPausedTasks,
    handleSuggestImprovements,
    handleFindSimilarTasks,
    handleLearnDefaults,
    handleApplySmartDefaults,
    handleAddComment,
    handleListComments,
    handleTaskTimeline,
    handleDryRunBulk,
    handleBulkOperationStatus,
    handleListBulkOperations,
    handlePredictDuration,
    handleDurationInsights,
    handleCalibratePredictions,
    handleStartPendingTask,
    handleSetTaskReviewStatus,
    handleListPendingReviews,
    handleListTasksNeedingCorrection,
    handleSetTaskComplexity,
    handleGetComplexityRouting,
    handleDeleteTask,
  };
}

module.exports = {
  handleStreamTaskOutput,
  handleGetTaskLogs,
  handleSubscribeTaskEvents,
  handlePollTaskEvents,
  handlePauseTask,
  handleResumeTask,
  handleListPausedTasks,
  handleSuggestImprovements,
  handleFindSimilarTasks,
  handleLearnDefaults,
  handleApplySmartDefaults,
  handleAddComment,
  handleListComments,
  handleTaskTimeline,
  handleDryRunBulk,
  handleBulkOperationStatus,
  handleListBulkOperations,
  handlePredictDuration,
  handleDurationInsights,
  handleCalibratePredictions,
  handleStartPendingTask,
  handleSetTaskReviewStatus,
  handleListPendingReviews,
  handleListTasksNeedingCorrection,
  handleSetTaskComplexity,
  handleGetComplexityRouting,
  handleDeleteTask,
  createTaskIntelligenceHandlers,
};
