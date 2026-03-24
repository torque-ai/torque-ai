/**
 * Task Pipeline — Templates, analytics, retry, pipelines, smart routing
 * Extracted from task-handlers.js during decomposition.
 *
 * Handlers: handleSaveTemplate, handleListTemplates, handleUseTemplate,
 *           handleGetAnalytics, handleRetryTask, handleCreatePipeline,
 *           handleRunPipeline, handleGetPipelineStatus, handleListPipelines,
 *           handlePreviewDiff, handleCommitTask, handleRollbackTask,
 *           handleListCommits, handleAnalyzeTask
 */

const { v4: uuidv4 } = require('uuid');
const childProcess = require('child_process');
const taskCore = require('../../db/task-core');
const eventTracking = require('../../db/event-tracking');
const fileTracking = require('../../db/file-tracking');
const projectConfigCore = require('../../db/project-config-core');
const schedulingAutomation = require('../../db/scheduling-automation');
const taskMetadata = require('../../db/task-metadata');
const taskManager = require('../../task-manager');
const logger = require('../../logger').child({ component: 'task-handlers' });
const { TASK_TIMEOUTS } = require('../../constants');
const { escapeRegExp, safeLimit,
        MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_TASK_LENGTH, MAX_BATCH_SIZE, ErrorCodes, makeError, requireTask } = require('../shared');
const { formatTime } = require('./utils');

// ── Git utilities ──────────────────────────────────────────

function execGit(gitArgs, cwd) {
  try {
    if (!Array.isArray(gitArgs)) {
      throw Object.assign(new Error('execGit requires an array of arguments, not a string'), { code: ErrorCodes.INTERNAL_ERROR });
    }
    const result = childProcess.spawnSync('git', gitArgs, {
      cwd,
      encoding: 'utf8',
      timeout: TASK_TIMEOUTS.GIT_ADD_ALL,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      return { success: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return { success: false, error: result.stderr || 'Git command failed' };
    }
    return { success: true, output: result.stdout };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function execGitCommit(message, cwd) {
  try {
    const result = childProcess.spawnSync('git', ['commit', '-m', message], {
      cwd,
      encoding: 'utf8',
      timeout: TASK_TIMEOUTS.GIT_ADD_ALL
    });
    if (result.error) {
      return { success: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return { success: false, error: result.stderr || 'Git commit failed' };
    }
    return { success: true, output: result.stdout };
  } catch (error) {
    return { success: false, error: error.message };
  }
}


// ── Template Handlers ──────────────────────────────────────

/**
 * Save a task template
 */
function handleSaveTemplate(args) {
  // Input validation
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name must be a non-empty string');
  }
  if (args.name.length > MAX_NAME_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  if (!args.task_template || typeof args.task_template !== 'string' || args.task_template.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_template must be a non-empty string');
  }
  if (args.task_template.length > MAX_TASK_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `task_template must be ${MAX_TASK_LENGTH} characters or less`);
  }
  if (args.description !== undefined && typeof args.description !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'description must be a string');
  }
  if (args.description && args.description.length > MAX_DESCRIPTION_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `description must be ${MAX_DESCRIPTION_LENGTH} characters or less`);
  }
  if (args.default_timeout !== undefined && (typeof args.default_timeout !== 'number' || args.default_timeout < 1)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'default_timeout must be a positive number');
  }
  if (args.default_priority !== undefined && typeof args.default_priority !== 'number') {
    return makeError(ErrorCodes.INVALID_PARAM, 'default_priority must be a number');
  }

  const template = schedulingAutomation.saveTemplate({
    name: args.name.trim(),
    description: args.description,
    task_template: args.task_template,
    default_timeout: args.default_timeout,
    default_priority: args.default_priority,
    auto_approve: args.auto_approve
  });

  eventTracking.recordEvent('template_saved', null, { name: args.name });

  return {
    content: [{
      type: 'text',
      text: `## Template Saved: ${template.name}\n\n**Description:** ${template.description || '(none)'}\n**Default Timeout:** ${template.default_timeout} minutes\n**Default Priority:** ${template.default_priority}\n\nUse with: \`use_template({template_name: "${template.name}", variables: {...}})\``
    }]
  };
}


/**
 * List all templates
 */
function handleListTemplates(_args) {
  const templates = schedulingAutomation.listTemplates();

  if (templates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Task Templates\n\nNo templates saved yet. Use \`save_template\` to create one.`
      }]
    };
  }

  let result = `## Task Templates\n\n| Name | Description | Usage Count | Timeout |\n|------|-------------|-------------|---------|\n`;

  for (const t of templates) {
    result += `| ${t.name} | ${(t.description || '-').slice(0, 40)} | ${t.usage_count} | ${t.default_timeout}m |\n`;
  }

  result += `\nUse a template with: \`use_template({template_name: "name", variables: {...}})\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Create a task from a template
 */
function handleUseTemplate(args) {
  const template = schedulingAutomation.getTemplate(args.template_name);

  if (!template) {
    return makeError(ErrorCodes.TEMPLATE_NOT_FOUND, `Template not found: ${args.template_name}`);
  }

  // Substitute variables in template
  let taskDescription = template.task_template;
  if (args.variables) {
    for (const [key, value] of Object.entries(args.variables)) {
      // Validate key is a safe string
      if (typeof key !== 'string' || key.length > 100) {
        return makeError(ErrorCodes.INVALID_PARAM, 'Invalid variable key: keys must be strings under 100 characters');
      }
      // Validate and coerce value to safe string
      let safeValue;
      if (value === null || value === undefined) {
        safeValue = '';
      } else if (typeof value === 'string') {
        safeValue = value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        safeValue = String(value);
      } else if (Array.isArray(value) || typeof value === 'object') {
        // Reject complex types that could cause unexpected behavior
        return makeError(ErrorCodes.INVALID_PARAM, `Invalid variable value for "${key}": arrays and objects are not allowed. Use string, number, or boolean values.`);
      } else {
        safeValue = String(value);
      }
      // Limit value length to prevent memory issues
      if (safeValue.length > 10000) {
        return makeError(ErrorCodes.PARAM_TOO_LONG, `Variable "${key}" value too long (max 10000 characters)`);
      }
      // Escape special regex characters to prevent ReDoS
      const escapedKey = escapeRegExp(key);
      taskDescription = taskDescription.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), safeValue);
    }
  }

  // Check for unsubstituted placeholders
  const remaining = taskDescription.match(/\{[^}]+\}/g);
  if (remaining) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `Template has unsubstituted variables: ${remaining.join(', ')}\n\nProvide these in the variables parameter.`);
  }

  const taskId = uuidv4();

  taskCore.createTask({
    id: taskId,
    status: 'pending',
    task_description: taskDescription,
    working_directory: args.working_directory,
    timeout_minutes: template.default_timeout,
    auto_approve: template.auto_approve,
    priority: args.priority !== undefined ? args.priority : template.default_priority,
    template_name: template.name
  });

  schedulingAutomation.incrementTemplateUsage(template.name);

  const result = taskManager.startTask(taskId);

  return {
    content: [{
      type: 'text',
      text: result.queued
        ? `Task created from template "${template.name}" and queued (ID: ${taskId})`
        : `Task created from template "${template.name}" and started (ID: ${taskId})`
    }]
  };
}


// ── Analytics Handler ──────────────────────────────────────

/**
 * Get analytics summary
 */
function handleGetAnalytics(args) {
  const analytics = eventTracking.getAnalytics({
    includeEvents: args.include_events
  });

  let result = `## TORQUE Analytics\n\n`;

  result += `### Task Statistics\n\n`;
  result += `| Status | Count |\n|--------|-------|\n`;
  for (const [status, count] of Object.entries(analytics.tasksByStatus)) {
    result += `| ${status} | ${count} |\n`;
  }

  result += `\n**Success Rate:** ${analytics.successRate}%\n`;
  result += `**Avg Duration:** ${analytics.avgDurationMinutes} minutes\n`;
  result += `**Tasks (24h):** ${analytics.tasksLast24h}\n`;

  if (analytics.topTemplates && analytics.topTemplates.length > 0) {
    result += `\n### Top Templates\n\n`;
    for (const t of analytics.topTemplates) {
      result += `- ${t.name}: ${t.usage_count} uses\n`;
    }
  }

  if (analytics.recentEvents && analytics.recentEvents.length > 0) {
    result += `\n### Recent Events\n\n`;
    for (const e of analytics.recentEvents.slice(0, 10)) {
      result += `- [${formatTime(e.timestamp)}] ${e.event_type}`;
      if (e.task_id) result += ` (${e.task_id.slice(0, 8)}...)`;
      result += `\n`;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ── Retry Handler ──────────────────────────────────────────

/**
 * Retry a failed task
 */
function handleRetryTask(args) {
  // Input validation
  if (args.modified_task !== undefined) {
    if (typeof args.modified_task !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'modified_task must be a string');
    }
    if (args.modified_task.length > MAX_TASK_LENGTH) {
      return makeError(ErrorCodes.PARAM_TOO_LONG, `modified_task must be ${MAX_TASK_LENGTH} characters or less`);
    }
  }

  const { task: originalTask, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  if (originalTask.status !== 'failed' && originalTask.status !== 'cancelled') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Can only retry failed or cancelled tasks. Current status: ${originalTask.status}`);
  }

  const taskId = uuidv4();
  let taskDescription = args.modified_task || originalTask.task_description;

  // Inject resume context from the failed original task
  try {
    const resumeJson = originalTask.resume_context;
    if (resumeJson && !args.modified_task) { // Don't override user-provided modified_task
      const { formatResumeContextForPrompt } = require('../../utils/resume-context');
      const parsed = typeof resumeJson === 'string' ? JSON.parse(resumeJson) : resumeJson;
      const preamble = formatResumeContextForPrompt(parsed);
      if (preamble) taskDescription = preamble + '\n\n' + taskDescription;
    }
  } catch { /* resume context injection is best-effort */ }

  taskCore.createTask({
    id: taskId,
    status: 'pending',
    task_description: taskDescription,
    working_directory: originalTask.working_directory,
    timeout_minutes: originalTask.timeout_minutes,
    auto_approve: originalTask.auto_approve,
    priority: (originalTask.priority ?? 0) + 1, // Slightly higher priority for retries
    template_name: originalTask.template_name,
    context: { retry_of: args.task_id }
  });

  eventTracking.recordEvent('task_retried', taskId, { original_task: args.task_id });

  const result = taskManager.startTask(taskId);

  return {
    content: [{
      type: 'text',
      text: result.queued
        ? `Retry task queued (ID: ${taskId}). Original: ${args.task_id.slice(0, 8)}...`
        : `Retry task started (ID: ${taskId}). Original: ${args.task_id.slice(0, 8)}...`
    }]
  };
}


// ── Pipeline Handlers ──────────────────────────────────────

/**
 * Create a task pipeline
 */
function handleCreatePipeline(args) {
  // Input validation
  if (!args.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name must be a non-empty string');
  }
  if (args.name.length > MAX_NAME_LENGTH) {
    return makeError(ErrorCodes.PARAM_TOO_LONG, `name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  if (!args.steps || !Array.isArray(args.steps) || args.steps.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'steps must be a non-empty array');
  }
  if (args.steps.length > MAX_BATCH_SIZE) {
    return makeError(ErrorCodes.INVALID_PARAM, `steps must have ${MAX_BATCH_SIZE} or fewer items`);
  }
  // Validate each step
  for (let i = 0; i < args.steps.length; i++) {
    const step = args.steps[i];
    if (!step.name || typeof step.name !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `Step ${i + 1}: name is required`);
    }
    if (!step.task_template || typeof step.task_template !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `Step ${i + 1}: task_template is required`);
    }
  }

  const pipelineId = uuidv4();

  const pipeline = projectConfigCore.createPipeline({
    id: pipelineId,
    name: args.name.trim(),
    description: args.description,
    working_directory: args.working_directory
  });

  // Add steps
  for (let i = 0; i < args.steps.length; i++) {
    const step = args.steps[i];
    projectConfigCore.addPipelineStep({
      pipeline_id: pipelineId,
      step_order: i + 1,
      name: step.name,
      task_template: step.task_template,
      condition: step.condition || 'on_success',
      timeout_minutes: step.timeout_minutes || 30
    });
  }

  const createdPipeline = projectConfigCore.getPipeline(pipelineId);

  let result = `## Pipeline Created: ${pipeline.name}\n\n`;
  result += `**ID:** ${pipelineId}\n`;
  result += `**Description:** ${pipeline.description || '(none)'}\n`;
  result += `**Steps:** ${createdPipeline.steps.length}\n\n`;

  result += `### Steps\n`;
  for (const step of createdPipeline.steps) {
    result += `${step.step_order}. **${step.name}** (${step.condition || 'on_success'})\n`;
  }

  result += `\nRun with: \`run_pipeline({pipeline_id: "${pipelineId}"})\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Run a pipeline
 */
function handleRunPipeline(args) {
  const pipeline = projectConfigCore.getPipeline(args.pipeline_id);

  if (!pipeline) {
    return makeError(ErrorCodes.PIPELINE_NOT_FOUND, `Pipeline not found: ${args.pipeline_id}`);
  }

  if (pipeline.status === 'running') {
    return makeError(ErrorCodes.TASK_ALREADY_RUNNING, 'Pipeline is already running');
  }

  // Only allow starting from pending status (completed/failed need explicit reset)
  if (pipeline.status !== 'pending') {
    return makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Pipeline cannot be started from '${pipeline.status}' status. Only 'pending' pipelines can be started.`);
  }

  // Start the pipeline
  projectConfigCore.updatePipelineStatus(args.pipeline_id, 'running');
  eventTracking.recordEvent('pipeline_started', args.pipeline_id, { name: pipeline.name });

  // Start first step
  const firstStep = pipeline.steps[0];
  if (firstStep) {
    let taskDescription = firstStep.task_template;

    // Substitute variables if provided
    if (args.variables) {
      for (const [key, value] of Object.entries(args.variables)) {
        // Escape special regex characters to prevent ReDoS
        const escapedKey = escapeRegExp(key);
        taskDescription = taskDescription.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), value);
      }
    }

    const taskId = uuidv4();
    const taskContext = { pipeline_id: args.pipeline_id, step_id: firstStep.id };
    logger.info(`[Pipeline] Creating first task ${taskId} with context: ${JSON.stringify(taskContext)}`);

    taskCore.createTask({
      id: taskId,
      status: 'pending',
      task_description: taskDescription,
      working_directory: pipeline.working_directory,
      timeout_minutes: firstStep.timeout_minutes,
      context: taskContext
    });

    // Verify context was stored
    const verifyTask = taskCore.getTask(taskId);
    logger.info(`[Pipeline] Verified task context after create: ${JSON.stringify(verifyTask?.context)}`);

    projectConfigCore.updatePipelineStatus(args.pipeline_id, 'running', { current_step: 1 });

    let startResult;
    try {
      startResult = taskManager.startTask(taskId);
    } catch (startErr) {
      // Revert pipeline status on start failure
      projectConfigCore.updatePipelineStatus(args.pipeline_id, 'failed', { error: `Failed to start first step: ${startErr.message}` });
      projectConfigCore.updatePipelineStep(firstStep.id, { status: 'failed' });
      return makeError(ErrorCodes.OPERATION_FAILED, `Pipeline start failed: ${startErr.message}`);
    }

    projectConfigCore.updatePipelineStep(firstStep.id, {
      task_id: taskId,
      status: startResult?.queued === true ? 'queued' : 'running',
    });
  }

  return {
    content: [{
      type: 'text',
      text: `Pipeline "${pipeline.name}" started.\n\nUse \`get_pipeline_status({pipeline_id: "${args.pipeline_id}"})\` to monitor progress.`
    }]
  };
}


/**
 * Get pipeline status
 */
function handleGetPipelineStatus(args) {
  const pipeline = projectConfigCore.getPipeline(args.pipeline_id);

  if (!pipeline) {
    return makeError(ErrorCodes.PIPELINE_NOT_FOUND, `Pipeline not found: ${args.pipeline_id}`);
  }

  let result = `## Pipeline: ${pipeline.name}\n\n`;
  result += `**ID:** ${pipeline.id}\n`;
  result += `**Status:** ${pipeline.status}\n`;
  result += `**Current Step:** ${pipeline.current_step} / ${pipeline.steps.length}\n`;

  if (pipeline.started_at) {
    result += `**Started:** ${formatTime(pipeline.started_at)}\n`;
  }
  if (pipeline.completed_at) {
    result += `**Completed:** ${formatTime(pipeline.completed_at)}\n`;
  }
  if (pipeline.error) {
    result += `**Error:** ${pipeline.error}\n`;
  }

  result += `\n### Steps\n\n`;
  result += `| # | Name | Status | Task ID |\n`;
  result += `|---|------|--------|--------|\n`;

  for (const step of pipeline.steps) {
    const taskIdDisplay = step.task_id ? step.task_id.slice(0, 8) + '...' : '-';
    result += `| ${step.step_order} | ${step.name} | ${step.status} | ${taskIdDisplay} |\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * List all pipelines
 */
function handleListPipelines(args) {
  const pipelines = projectConfigCore.listPipelines({
    status: args.status,
    limit: safeLimit(args.limit, 20)
  });

  if (pipelines.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Pipelines\n\nNo pipelines found. Create one with \`create_pipeline\`.`
      }]
    };
  }

  let result = `## Pipelines\n\n`;
  result += `| ID | Name | Status | Steps | Created |\n`;
  result += `|----|------|--------|-------|--------|\n`;

  for (const p of pipelines) {
    result += `| ${p.id.slice(0, 8)}... | ${p.name} | ${p.status} | ${p.steps.length} | ${formatTime(p.created_at)} |\n`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Preview diff for a task
 */
function handlePreviewDiff(args) {
  const { task, error: taskErr } = requireTask(args.task_id);
  if (taskErr) return taskErr;

  const cwd = args.working_directory || task.working_directory || process.cwd();

  // Check if in git repo
  const statusResult = execGit(['status', '--porcelain'], cwd);
  if (!statusResult.success) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Not a git repository or git error: ${statusResult.error}`);
  }

  // Get diff
  const diffResult = execGit(['diff'], cwd);
  if (!diffResult.success && diffResult.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Git diff failed: ${diffResult.error}`);
  }
  const stagedDiffResult = execGit(['diff', '--staged'], cwd);
  if (!stagedDiffResult.success && stagedDiffResult.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Git diff --staged failed: ${stagedDiffResult.error}`);
  }

  let result = `## File Changes for Task: ${args.task_id.slice(0, 8)}...\n\n`;

  if (!diffResult.output && !stagedDiffResult.output) {
    result += `No uncommitted changes found.\n`;

    // Check if there's a commit from this task
    if (task.git_after_sha) {
      const showResult = execGit(['show', '--stat', task.git_after_sha], cwd);
      if (showResult.success) {
        result += `\n### Committed Changes\n\n\`\`\`\n${showResult.output.slice(0, 2000)}\n\`\`\``;
      }
    }
  } else {
    if (stagedDiffResult.output) {
      result += `### Staged Changes\n\n\`\`\`diff\n${stagedDiffResult.output.slice(0, 3000)}\n\`\`\`\n\n`;
    }
    if (diffResult.output) {
      result += `### Unstaged Changes\n\n\`\`\`diff\n${diffResult.output.slice(0, 3000)}\n\`\`\``;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Commit task changes
 */
function handleCommitTask(args) {
  const { task, error: taskErr2 } = requireTask(args.task_id);
  if (taskErr2) return taskErr2;

  const cwd = args.working_directory || task.working_directory || process.cwd();

  // Get current HEAD before commit
  const beforeShaResult = execGit(['rev-parse', 'HEAD'], cwd);
  const beforeSha = beforeShaResult.success ? beforeShaResult.output.trim() : null;

  // Stage all changes
  const addResult = execGit(['add', '-A'], cwd);
  if (!addResult.success) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to stage changes: ${addResult.error}`);
  }

  // Check if there's anything to commit
  const statusResult = execGit(['diff', '--staged', '--quiet'], cwd);
  if (statusResult.success) {
    return {
      content: [{ type: 'text', text: `No staged changes to commit.` }]
    };
  }

  // Create commit message
  const commitMessage = args.message || `Codex task: ${(task.task_description || '').slice(0, 50)}`;

  // Commit using safe spawn
  const commitResult = execGitCommit(commitMessage, cwd);
  if (!commitResult.success) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to commit: ${commitResult.error}`);
  }

  // Get new HEAD
  const afterShaResult = execGit(['rev-parse', 'HEAD'], cwd);
  const afterSha = afterShaResult.success ? afterShaResult.output.trim() : null;

  // Update task with git info
  taskMetadata.updateTaskGitState(args.task_id, {
    before_sha: beforeSha,
    after_sha: afterSha
  });

  eventTracking.recordEvent('task_committed', args.task_id, { sha: afterSha });

  return {
    content: [{
      type: 'text',
      text: `## Commit Created\n\n**SHA:** ${afterSha}\n**Message:** ${commitMessage}\n\nTo rollback: \`rollback_task({task_id: "${args.task_id}"})\``
    }]
  };
}


/**
 * Rollback a task
 */
function handleRollbackTask(args) {
  const { task_id, reason } = args;

  if (!task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const { task: _task, error: taskErr3 } = requireTask(task_id);
  if (taskErr3) return taskErr3;

  // Create rollback record
  const rollbackId = fileTracking.createRollback(task_id, 'git', null, null, reason || 'User requested rollback', 'user');

  // In a real implementation, this would run git commands to rollback
  // For now, just record the intent

  return {
    content: [{
      type: 'text',
      text: `## Rollback Initiated\n\n**Rollback ID:** ${rollbackId}\n**Task:** ${task_id}\n**Reason:** ${reason || 'User requested'}\n**Status:** Pending\n\nNote: Git rollback commands need to be run manually or via automation.`
    }]
  };
}


/**
 * List tasks with commits
 */
function handleListCommits(args) {
  const tasks = taskMetadata.getTasksWithCommits({
    working_directory: args.working_directory,
    limit: safeLimit(args.limit, 10)
  });

  if (tasks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Committed Tasks\n\nNo tasks have been committed yet. Use \`commit_task\` after a task completes.`
      }]
    };
  }

  let result = `## Committed Tasks\n\n`;
  result += `| Task ID | SHA | Description | Committed |\n`;
  result += `|---------|-----|-------------|----------|\n`;

  for (const t of tasks) {
    result += `| ${t.id.slice(0, 8)}... | ${(t.git_after_sha || '').slice(0, 7)} | ${(t.task_description || '').slice(0, 30)}... | ${formatTime(t.completed_at)} |\n`;
  }

  result += `\nRollback with: \`rollback_task({task_id: "..."})\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ── Smart Routing Handler ──────────────────────────────────

/**
 * Analyze a task to determine best routing (Codex vs Claude)
 */
function handleAnalyzeTask(args) {
  if (!args.task_description || typeof args.task_description !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_description is required');
  }
  const description = args.task_description.toLowerCase();

  // Scoring factors
  let codexScore = 0;
  let claudeScore = 0;
  const factors = [];

  // === Codex-favorable indicators ===

  // Single file operations
  if (/single file|one file|this file|the file/i.test(description)) {
    codexScore += 2;
    factors.push({ factor: 'Single file operation', favors: 'codex', weight: 2 });
  }

  // Unit tests
  if (/unit test|write test|add test|test for|tests for/i.test(description)) {
    codexScore += 3;
    factors.push({ factor: 'Unit test writing', favors: 'codex', weight: 3 });
  }

  // Documentation
  if (/document|docstring|jsdoc|comment|readme/i.test(description)) {
    codexScore += 2;
    factors.push({ factor: 'Documentation task', favors: 'codex', weight: 2 });
  }

  // Simple refactoring
  if (/rename|extract function|extract method|move function/i.test(description)) {
    codexScore += 2;
    factors.push({ factor: 'Simple refactoring', favors: 'codex', weight: 2 });
  }

  // Bug fix with clear steps
  if (/fix the bug|bug fix|error fix|fix this error/i.test(description) && /should|must|needs to/i.test(description)) {
    codexScore += 2;
    factors.push({ factor: 'Clear bug fix', favors: 'codex', weight: 2 });
  }

  // Utility scripts
  if (/script|utility|helper|tool/i.test(description) && !/architecture|design|plan/i.test(description)) {
    codexScore += 2;
    factors.push({ factor: 'Utility script', favors: 'codex', weight: 2 });
  }

  // === Claude-favorable indicators ===

  // Architectural decisions
  if (/architect|design|structure|organize|plan/i.test(description)) {
    claudeScore += 3;
    factors.push({ factor: 'Architectural decision', favors: 'claude', weight: 3 });
  }

  // Multi-file changes
  if (/multiple files|several files|across files|many files|refactor.*system/i.test(description)) {
    claudeScore += 3;
    factors.push({ factor: 'Multi-file changes', favors: 'claude', weight: 3 });
  }

  // Security sensitive
  if (/security|auth|authentication|password|credential|secret|encrypt|token/i.test(description)) {
    claudeScore += 3;
    factors.push({ factor: 'Security-sensitive', favors: 'claude', weight: 3 });
  }

  // Complex integration
  if (/integrat|connect.*to|api.*design|system.*interaction/i.test(description)) {
    claudeScore += 2;
    factors.push({ factor: 'Complex integration', favors: 'claude', weight: 2 });
  }

  // Requires context/discussion
  if (/discuss|decide|consider|evaluate|compare|choose|which approach/i.test(description)) {
    claudeScore += 2;
    factors.push({ factor: 'Requires discussion', favors: 'claude', weight: 2 });
  }

  // Database schema changes
  if (/schema|migration|database design|data model/i.test(description)) {
    claudeScore += 2;
    factors.push({ factor: 'Database schema', favors: 'claude', weight: 2 });
  }

  // Performance optimization (needs analysis)
  if (/optimi|performance|speed up|slow|bottleneck/i.test(description)) {
    claudeScore += 1;
    factors.push({ factor: 'Performance optimization', favors: 'claude', weight: 1 });
  }

  // Determine recommendation
  const recommendation = codexScore > claudeScore ? 'codex' : 'claude';
  const confidence = Math.abs(codexScore - claudeScore);
  let confidenceLevel = 'low';
  if (confidence >= 4) confidenceLevel = 'high';
  else if (confidence >= 2) confidenceLevel = 'medium';

  // Build response
  let result = `## Task Analysis\n\n`;
  result += `**Task:** ${(args.task_description || '').slice(0, 100)}...\n\n`;
  result += `### Recommendation: ${recommendation.toUpperCase()}\n`;
  result += `**Confidence:** ${confidenceLevel}\n`;
  result += `**Codex Score:** ${codexScore} | **Claude Score:** ${claudeScore}\n\n`;

  result += `### Factors Considered\n\n`;
  result += `| Factor | Favors | Weight |\n`;
  result += `|--------|--------|--------|\n`;
  for (const f of factors) {
    result += `| ${f.factor} | ${f.favors} | +${f.weight} |\n`;
  }

  if (factors.length === 0) {
    result += `| No strong indicators found | - | 0 |\n`;
  }

  result += `\n### Reasoning\n\n`;
  if (recommendation === 'codex') {
    result += `This task appears well-suited for Codex because it is:\n`;
    result += `- Well-defined with clear scope\n`;
    result += `- Likely contained to specific files\n`;
    result += `- Does not require extensive conversation or context\n\n`;
    result += `**To delegate:** \`submit_task({task: "..."})\``;
  } else {
    result += `This task should stay with Claude because it:\n`;
    result += `- May require architectural decisions\n`;
    result += `- Could benefit from discussion and context\n`;
    result += `- May involve security or cross-cutting concerns\n\n`;
    result += `**Continue working on this task directly.**`;
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


function createTaskPipelineHandlers(_deps) {
  return {
    handleSaveTemplate,
    handleListTemplates,
    handleUseTemplate,
    handleGetAnalytics,
    handleRetryTask,
    handleCreatePipeline,
    handleRunPipeline,
    handleGetPipelineStatus,
    handleListPipelines,
    handlePreviewDiff,
    handleCommitTask,
    handleRollbackTask,
    handleListCommits,
    handleAnalyzeTask,
  };
}

module.exports = {
  handleSaveTemplate,
  handleListTemplates,
  handleUseTemplate,
  handleGetAnalytics,
  handleRetryTask,
  handleCreatePipeline,
  handleRunPipeline,
  handleGetPipelineStatus,
  handleListPipelines,
  handlePreviewDiff,
  handleCommitTask,
  handleRollbackTask,
  handleListCommits,
  handleAnalyzeTask,
  createTaskPipelineHandlers,
};
