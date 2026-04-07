/**
 * Task Project — Cost/token tracking, project management, groups, advanced analytics
 * Extracted from task-handlers.js during decomposition.
 *
 * Handlers: handleRecordUsage, handleGetTaskUsage, handleCostSummary,
 *           handleEstimateCost, handleListProjects, handleProjectStats,
 *           handleCurrentProject, handleConfigureProject, handleGetProjectConfig,
 *           handleListProjectConfigs, handleCloneTask, handleBulkImportTasks,
 *           handleValidateImport, handleCreateGroup, handleListGroups,
 *           handleGroupAction, handleForecastCosts, handleSetDefaultLimits
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const configCore = require('../../db/config-core');
const costTracking = require('../../db/cost-tracking');
const taskCore = require('../../db/task-core');
const eventTracking = require('../../db/event-tracking');
const projectConfigCore = require('../../db/project-config-core');
const taskMetadata = require('../../db/task-metadata');
const serverConfig = require('../../config');
const taskManager = require('../../task-manager');
const { safeLimit, safeDate, isPathTraversalSafe, MAX_BATCH_SIZE, ErrorCodes, makeError } = require('../shared');
const { formatTime } = require('./utils');
const logger = require('../../logger').child({ component: 'task-project' });


// ============ Cost/Token Tracking Handlers ============

/**
 * Record token usage for a task
 */
function handleRecordUsage(args) {
  const task = taskCore.getTask(args.task_id);

  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  const usage = costTracking.recordTokenUsage(args.task_id, {
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
    model: args.model || 'codex'
  });

  return {
    content: [{
      type: 'text',
      text: `## Usage Recorded\n\n**Task:** ${args.task_id.slice(0, 8)}...\n**Model:** ${usage.model}\n**Input Tokens:** ${usage.input_tokens.toLocaleString()}\n**Output Tokens:** ${usage.output_tokens.toLocaleString()}\n**Total Tokens:** ${usage.total_tokens.toLocaleString()}\n**Estimated Cost:** $${usage.estimated_cost_usd.toFixed(4)}`
    }]
  };
}


/**
 * Get token usage for a specific task
 */
function handleGetTaskUsage(args) {
  const task = taskCore.getTask(args.task_id);

  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  const usage = costTracking.getTaskTokenUsage(args.task_id);

  if (!usage || usage.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Task Usage: ${args.task_id.slice(0, 8)}...\n\nNo usage data recorded for this task.\n\nUse \`record_usage\` to record token usage.`
      }]
    };
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  let result = `## Task Usage: ${args.task_id.slice(0, 8)}...\n\n`;
  result += `**Description:** ${(task.task_description || '').slice(0, 50)}...\n\n`;
  result += `| Time | Model | Input | Output | Cost |\n`;
  result += `|------|-------|-------|--------|------|\n`;

  for (const u of usage) {
    totalInput += u.input_tokens;
    totalOutput += u.output_tokens;
    totalCost += u.estimated_cost_usd;
    result += `| ${formatTime(u.recorded_at)} | ${u.model} | ${u.input_tokens.toLocaleString()} | ${u.output_tokens.toLocaleString()} | $${u.estimated_cost_usd.toFixed(4)} |\n`;
  }

  result += `\n### Totals\n`;
  result += `- **Input Tokens:** ${totalInput.toLocaleString()}\n`;
  result += `- **Output Tokens:** ${totalOutput.toLocaleString()}\n`;
  result += `- **Total Tokens:** ${(totalInput + totalOutput).toLocaleString()}\n`;
  result += `- **Total Cost:** $${totalCost.toFixed(4)}\n`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get cost summary
 */
function handleCostSummary(args) {
  // Determine project filter
  let projectFilter = null;
  if (!args.all_projects) {
    projectFilter = args.project || projectConfigCore.getCurrentProject(process.cwd());
  }

  let result = `## Cost Summary`;
  if (projectFilter) result += ` (Project: ${projectFilter})`;
  if (args.all_projects) result += ` (All Projects)`;
  result += `\n\n`;

  // Get overall summary
  const summary = costTracking.getTokenUsageSummary({
    since: safeDate(args.since),
    model: args.model,
    project: projectFilter
  });

  result += `### Overall\n`;
  result += `- **Total Input Tokens:** ${summary.total_input_tokens.toLocaleString()}\n`;
  result += `- **Total Output Tokens:** ${summary.total_output_tokens.toLocaleString()}\n`;
  result += `- **Total Tokens:** ${summary.total_tokens.toLocaleString()}\n`;
  result += `- **Total Cost:** $${summary.total_cost_usd.toFixed(4)}\n`;
  result += `- **Tasks Tracked:** ${summary.task_count}\n`;

  // Breakdown by model
  if (summary.by_model && Object.keys(summary.by_model).length > 0) {
    result += `\n### By Model\n`;
    result += `| Model | Input | Output | Cost |\n`;
    result += `|-------|-------|--------|------|\n`;

    for (const [model, stats] of Object.entries(summary.by_model)) {
      result += `| ${model} | ${stats.input_tokens.toLocaleString()} | ${stats.output_tokens.toLocaleString()} | $${stats.cost_usd.toFixed(4)} |\n`;
    }
  }

  // Period breakdown if requested
  if (args.period) {
    const periodData = costTracking.getCostByPeriod(args.period, safeLimit(args.limit, 30));

    if (periodData && periodData.length > 0) {
      result += `\n### By ${args.period.charAt(0).toUpperCase() + args.period.slice(1)}\n`;
      result += `| Period | Tokens | Cost |\n`;
      result += `|--------|--------|------|\n`;

      for (const p of periodData) {
        result += `| ${p.period} | ${(p.tokens || 0).toLocaleString()} | $${(p.cost || 0).toFixed(4)} |\n`;
      }
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Estimate cost for a task description
 */
function handleEstimateCost(args) {
  if (!args.task_description) {
    return makeError(ErrorCodes.VALIDATION_ERROR, 'task_description is required');
  }
  const estimate = costTracking.estimateCost(args.task_description, args.model || 'codex');

  let result = `## Cost Estimate\n\n`;
  result += `**Model:** ${estimate.model}\n`;
  result += `**Task Length:** ${args.task_description.length} characters\n\n`;
  result += `### Estimated Usage\n`;
  result += `- **Input Tokens:** ~${estimate.estimated_input_tokens.toLocaleString()}\n`;
  result += `- **Output Tokens:** ~${estimate.estimated_output_tokens.toLocaleString()}\n`;
  result += `- **Total Tokens:** ~${estimate.estimated_total_tokens.toLocaleString()}\n`;
  result += `- **Estimated Cost:** ~$${estimate.estimated_cost_usd.toFixed(4)}\n\n`;
  result += `*Note: This is a rough estimate. Actual usage depends on task complexity and Codex response.*`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Project Management Handlers ============

/**
 * List all projects
 */
function handleListProjects(_args) {
  const projects = taskCore.listKnownProjects();

  if (projects.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Projects\n\nNo projects found. Tasks will be automatically assigned to a project based on their working directory.`
      }]
    };
  }

  let result = `## Projects\n\n`;
  result += `| Project | Tasks | Last Active | Config |\n`;
  result += `|---------|-------|-------------|--------|\n`;

  for (const p of projects) {
    result += `| ${p.name} | ${p.task_count} | ${p.last_active ? formatTime(p.last_active) : 'N/A'} | ${p.has_config ? 'Yes' : 'No'} |\n`;
  }

  result += `\n### Summary\n`;
  result += `- **Total Projects:** ${projects.length}\n`;
  result += `- **Total Tasks:** ${projects.reduce((sum, p) => sum + p.task_count, 0)}\n`;
  result += `- **Configured Projects:** ${projects.filter((p) => p.has_config).length}\n`;

  result += `\nUse \`project_stats({project: "name"})\` for detailed stats on a specific project.`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get detailed project statistics
 */
function handleProjectStats(args) {
  // Use specified project or detect from current directory
  const project = args.project || projectConfigCore.getCurrentProject(process.cwd());

  if (!project) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Unable to determine project. Please specify a project name or run from within a project directory.');
  }

  const stats = projectConfigCore.getProjectStats(project);

  let result = `## Project: ${project}\n\n`;

  // Task summary
  result += `### Tasks\n`;
  result += `- **Total:** ${stats.total_tasks}\n`;

  if (Object.keys(stats.tasks_by_status).length > 0) {
    for (const [status, count] of Object.entries(stats.tasks_by_status)) {
      result += `- **${status}:** ${count}\n`;
    }
  }

  result += `- **Pipelines:** ${stats.pipelines}\n`;
  result += `- **Scheduled Tasks:** ${stats.scheduled_tasks}\n`;

  // Cost summary
  result += `\n### Cost\n`;
  result += `- **Total Tokens:** ${stats.cost.total_tokens.toLocaleString()}\n`;
  result += `- **Total Cost:** $${stats.cost.total_cost.toFixed(4)}\n`;

  // Top templates
  if (stats.top_templates && stats.top_templates.length > 0) {
    result += `\n### Top Templates\n`;
    for (const t of stats.top_templates) {
      result += `- ${t.template_name}: ${t.count} uses\n`;
    }
  }

  // Top tags
  if (stats.top_tags && stats.top_tags.length > 0) {
    result += `\n### Top Tags\n`;
    for (const t of stats.top_tags) {
      result += `- ${t.tag}: ${t.count} tasks\n`;
    }
  }

  // Recent tasks
  if (stats.recent_tasks && stats.recent_tasks.length > 0) {
    result += `\n### Recent Tasks\n`;
    result += `| ID | Status | Description | Created |\n`;
    result += `|----|--------|-------------|--------|\n`;

    for (const task of stats.recent_tasks.slice(0, 5)) {
      result += `| ${task.id.slice(0, 8)}... | ${task.status} | ${(task.task_description || '').slice(0, 25)}... | ${formatTime(task.created_at)} |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get current project from working directory
 */
function handleCurrentProject(args) {
  const workingDir = args.working_directory || process.cwd();
  const projectRoot = projectConfigCore.getProjectRoot(workingDir);
  const project = projectConfigCore.getCurrentProject(workingDir);

  if (!project) {
    return {
      content: [{
        type: 'text',
        text: `## Current Project\n\n**Working Directory:** ${workingDir}\n**Project:** (none detected)\n\nThe project name is derived from the project root directory.`
      }]
    };
  }

  // Get quick stats for this project
  const stats = projectConfigCore.getProjectStats(project);
  const config = projectConfigCore.getEffectiveProjectConfig(project);
  const canStart = projectConfigCore.canProjectStartTask(project);

  let result = `## Current Project\n\n`;
  result += `**Working Directory:** ${workingDir}\n`;
  result += `**Project Root:** ${projectRoot}\n`;
  result += `**Project:** ${project}\n`;
  result += `**Can Submit Tasks:** ${canStart.allowed ? 'Yes' : `No - ${canStart.reason}`}\n\n`;

  result += `### Quick Stats\n`;
  result += `- **Total Tasks:** ${stats.total_tasks}\n`;
  result += `- **Running Tasks:** ${projectConfigCore.getProjectRunningCount(project)}\n`;
  result += `- **Total Cost:** $${stats.cost.total_cost.toFixed(4)}\n`;

  // Show quotas if set
  if (config.max_concurrent > 0 || config.max_daily_cost > 0 || config.max_daily_tokens > 0) {
    const usage = projectConfigCore.getProjectDailyUsage(project);
    result += `\n### Quotas\n`;
    if (config.max_concurrent > 0) {
      result += `- **Concurrency:** ${projectConfigCore.getProjectRunningCount(project)}/${config.max_concurrent}\n`;
    }
    if (config.max_daily_cost > 0) {
      result += `- **Daily Cost:** $${usage.cost.toFixed(2)}/$${config.max_daily_cost.toFixed(2)}\n`;
    }
    if (config.max_daily_tokens > 0) {
      result += `- **Daily Tokens:** ${usage.tokens}/${config.max_daily_tokens}\n`;
    }
  }

  if (Object.keys(stats.tasks_by_status).length > 0) {
    result += `\n### Tasks by Status\n`;
    for (const [status, count] of Object.entries(stats.tasks_by_status)) {
      result += `- ${status}: ${count}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Configure project settings
 */
function handleConfigureProject(args) {
  const project = args.project || projectConfigCore.getCurrentProject(process.cwd());

  if (!project) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Unable to determine project. Please specify a project name.');
  }

  // Build config object from provided args
  const config = {};
  if (args.max_concurrent !== undefined) config.max_concurrent = args.max_concurrent;
  if (args.max_daily_cost !== undefined) config.max_daily_cost = args.max_daily_cost;
  if (args.max_daily_tokens !== undefined) config.max_daily_tokens = args.max_daily_tokens;
  if (args.default_timeout !== undefined) config.default_timeout = args.default_timeout;
  if (args.default_priority !== undefined) config.default_priority = args.default_priority;
  if (args.auto_approve !== undefined) config.auto_approve = args.auto_approve;
  if (args.enabled !== undefined) config.enabled = args.enabled;
  // Build verification settings
  if (args.build_verification_enabled !== undefined) config.build_verification_enabled = args.build_verification_enabled;
  if (args.build_command !== undefined) config.build_command = args.build_command;
  if (args.build_timeout !== undefined) config.build_timeout = args.build_timeout;
  if (args.rollback_on_build_failure !== undefined) config.rollback_on_build_failure = args.rollback_on_build_failure;
  // Test verification settings
  if (args.test_verification_enabled !== undefined) config.test_verification_enabled = args.test_verification_enabled;
  if (args.test_command !== undefined) config.test_command = args.test_command;
  if (args.test_timeout !== undefined) config.test_timeout = args.test_timeout;
  if (args.rollback_on_test_failure !== undefined) config.rollback_on_test_failure = args.rollback_on_test_failure;

  if (Object.keys(config).length === 0) {
    // No config provided, show current config
    return handleGetProjectConfig({ project });
  }

  // Update config
  const updated = projectConfigCore.setProjectConfig(project, config);

  let result = `## Project Configuration Updated\n\n`;
  result += `**Project:** ${project}\n\n`;
  result += `### Settings\n`;
  result += `| Setting | Value |\n`;
  result += `|---------|-------|\n`;
  result += `| Max Concurrent | ${updated.max_concurrent || 'Global'} |\n`;
  result += `| Max Daily Cost | ${updated.max_daily_cost > 0 ? '$' + updated.max_daily_cost.toFixed(2) : 'Unlimited'} |\n`;
  result += `| Max Daily Tokens | ${updated.max_daily_tokens > 0 ? updated.max_daily_tokens.toLocaleString() : 'Unlimited'} |\n`;
  result += `| Default Timeout | ${updated.default_timeout} min |\n`;
  result += `| Default Priority | ${updated.default_priority} |\n`;
  result += `| Auto-Approve | ${updated.auto_approve ? 'Yes' : 'No'} |\n`;
  result += `| Enabled | ${updated.enabled ? 'Yes' : 'No'} |\n`;
  result += `\n### Build Verification\n`;
  result += `| Setting | Value |\n`;
  result += `|---------|-------|\n`;
  result += `| Build Verification | ${updated.build_verification_enabled ? 'Enabled' : 'Disabled'} |\n`;
  result += `| Build Command | ${updated.build_command || 'Auto-detect'} |\n`;
  result += `| Build Timeout | ${updated.build_timeout || 120}s |\n`;
  result += `| Rollback on Failure | ${updated.rollback_on_build_failure !== false ? 'Yes' : 'No'} |\n`;

  result += `\n### Test Verification\n`;
  result += `| Setting | Value |\n`;
  result += `|---------|-------|\n`;
  result += `| Test Verification | ${updated.test_verification_enabled ? 'Enabled' : 'Disabled'} |\n`;
  result += `| Test Command | ${updated.test_command || 'Auto-detect'} |\n`;
  result += `| Test Timeout | ${updated.test_timeout || 300}s |\n`;
  result += `| Rollback on Failure | ${updated.rollback_on_test_failure ? 'Yes' : 'No'} |\n`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * Get project configuration
 */
function handleGetProjectConfig(args) {
  const project = args.project || projectConfigCore.getCurrentProject(process.cwd());

  if (!project) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Unable to determine project. Please specify a project name.');
  }

  const config = projectConfigCore.getEffectiveProjectConfig(project);
  const usage = projectConfigCore.getProjectDailyUsage(project);
  const canStart = projectConfigCore.canProjectStartTask(project);

  let result = `## Project Configuration: ${project}\n\n`;

  result += `### Limits\n`;
  result += `| Setting | Value | Current |\n`;
  result += `|---------|-------|--------|\n`;
  result += `| Max Concurrent | ${config.max_concurrent || `Global (${config.global_max_concurrent})`} | ${projectConfigCore.getProjectRunningCount(project)} running |\n`;
  result += `| Max Daily Cost | ${config.max_daily_cost > 0 ? '$' + config.max_daily_cost.toFixed(2) : 'Unlimited'} | $${usage.cost.toFixed(2)} used |\n`;
  result += `| Max Daily Tokens | ${config.max_daily_tokens > 0 ? config.max_daily_tokens.toLocaleString() : 'Unlimited'} | ${usage.tokens.toLocaleString()} used |\n`;

  result += `\n### Defaults\n`;
  result += `| Setting | Value |\n`;
  result += `|---------|-------|\n`;
  result += `| Default Timeout | ${config.default_timeout} min |\n`;
  result += `| Default Priority | ${config.default_priority} |\n`;
  result += `| Auto-Approve | ${config.auto_approve ? 'Yes' : 'No'} |\n`;
  result += `| Enabled | ${config.enabled ? 'Yes' : 'No'} |\n`;

  result += `\n### Status\n`;
  result += `**Can Submit Tasks:** ${canStart.allowed ? 'Yes' : `No - ${canStart.reason}`}\n`;

  result += `\n### Configure\n`;
  result += `\`\`\`\nconfigure_project({\n`;
  result += `  project: "${project}",\n`;
  result += `  max_concurrent: 2,      // Limit concurrent tasks\n`;
  result += `  max_daily_cost: 5.00,   // Limit daily spending\n`;
  result += `  max_daily_tokens: 50000 // Limit daily tokens\n`;
  result += `})\n\`\`\``;

  return {
    content: [{ type: 'text', text: result }]
  };
}


/**
 * List all project configurations
 */
function handleListProjectConfigs(_args) {
  const configs = projectConfigCore.listProjectConfigs();

  if (configs.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Project Configurations\n\nNo project configurations found. Projects use global defaults until configured.\n\nUse \`configure_project\` to set project-specific limits.`
      }]
    };
  }

  let result = `## Project Configurations\n\n`;
  result += `| Project | Max Concurrent | Daily Cost Limit | Daily Token Limit | Enabled |\n`;
  result += `|---------|----------------|------------------|-------------------|--------|\n`;

  for (const c of configs) {
    result += `| ${c.project} | ${c.max_concurrent || 'Global'} | ${c.max_daily_cost > 0 ? '$' + c.max_daily_cost.toFixed(2) : '-'} | ${c.max_daily_tokens > 0 ? c.max_daily_tokens.toLocaleString() : '-'} | ${c.enabled ? 'Yes' : 'No'} |\n`;
  }

  result += `\n*Use \`get_project_config({project: "name"})\` for detailed config.*`;

  return {
    content: [{ type: 'text', text: result }]
  };
}


// ============ Phase 3: Workflow & Templates Handlers ============

/**
 * Clone a task
 */
function handleCloneTask(args) {
  const original = taskCore.getTask(args.task_id);
  if (!original) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  const newTaskId = uuidv4();
  taskCore.createTask({
    id: newTaskId,
    status: 'pending',
    task_description: args.task || original.task_description,
    working_directory: args.working_directory || original.working_directory,
    timeout_minutes: original.timeout_minutes,
    auto_approve: original.auto_approve,
    priority: args.priority !== undefined ? args.priority : original.priority,
    tags: args.tags || original.tags,
    max_retries: original.max_retries,
    retry_strategy: original.retry_strategy,
    retry_delay_seconds: original.retry_delay_seconds
  });

  let result = `Task cloned!\n**New ID:** ${newTaskId}\n**Original:** ${args.task_id.substring(0, 8)}...`;

  if (args.start_immediately) {
    const startResult = taskManager.startTask(newTaskId);
    result += startResult.queued ? '\n**Status:** Queued' : '\n**Status:** Started';
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * Bulk import tasks
 */
function handleBulkImportTasks(args) {
  let data;

  try {
    if (args.file_path) {
      // Path traversal protection
      if (!isPathTraversalSafe(args.file_path)) {
        return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid file path: path traversal not allowed');
      }
      const content = fs.readFileSync(args.file_path, 'utf-8');
      if (args.file_path.endsWith('.yaml') || args.file_path.endsWith('.yml')) {
        // Basic YAML parsing (for simple structures)
        return makeError(ErrorCodes.INVALID_PARAM, 'YAML import not yet supported. Use JSON format.');
      }
      data = eventTracking.safeJsonParse(content, null);
      if (data === null) {
        return makeError(ErrorCodes.INVALID_PARAM, 'Failed to parse JSON file');
      }
    } else if (args.content) {
      data = eventTracking.safeJsonParse(args.content, null);
      if (data === null) {
        return makeError(ErrorCodes.INVALID_PARAM, 'Failed to parse JSON content');
      }
    } else {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide either file_path or content');
    }
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, `Parse error: ${err.message}`);
  }

  const tasks = data.tasks || data;
  if (!Array.isArray(tasks)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid format: expected tasks array');
  }

  // Batch size limit
  if (tasks.length > MAX_BATCH_SIZE) {
    return makeError(ErrorCodes.INVALID_PARAM, `Too many tasks: maximum ${MAX_BATCH_SIZE} allowed per import`);
  }

  const created = [];
  const taskMap = {}; // For dependency resolution

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const taskId = uuidv4();
    taskMap[`$${i}`] = taskId;

    // Resolve dependencies
    let depends_on = null;
    if (t.depends_on !== undefined && t.depends_on !== null) {
      const depsArray = Array.isArray(t.depends_on) ? t.depends_on : [t.depends_on];
      depends_on = depsArray.map(dep => {
        const depStr = String(dep);
        if (depStr.startsWith('$')) {
          return taskMap[depStr] || depStr;
        }
        return depStr;
      });
    }

    const task = taskCore.createTask({
      id: taskId,
      status: 'pending',
      task_description: t.task,
      working_directory: t.working_directory || args.working_directory,
      timeout_minutes: t.timeout_minutes || 30,
      priority: t.priority || 0,
      tags: t.tags || [],
      depends_on
    });

    created.push(task);

    if (args.start_immediately && (!depends_on || depends_on.length === 0)) {
      taskManager.startTask(taskId);
    }
  }

  return {
    content: [{
      type: 'text',
      text: `Imported ${created.length} tasks.\n` +
        created.map(t => `- ${t.id.substring(0, 8)}... : ${t.task_description.substring(0, 40)}...`).join('\n')
    }]
  };
}


/**
 * Validate import file (dry-run)
 */
function handleValidateImport(args) {
  let data;

  try {
    if (args.file_path) {
      // Security: Validate path traversal
      if (!isPathTraversalSafe(args.file_path)) {
        return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid file path: path traversal not allowed');
      }
      const content = fs.readFileSync(args.file_path, 'utf-8');
      data = JSON.parse(content);
    } else if (args.content) {
      data = JSON.parse(args.content);
    } else {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide either file_path or content');
    }
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, `Parse error: ${err.message}`);
  }

  const tasks = data.tasks || data;
  if (!Array.isArray(tasks)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid format: expected tasks array');
  }

  const errors = [];
  const warnings = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.task) {
      errors.push(`Task ${i}: missing required 'task' field`);
    }
    if (t.depends_on) {
      for (const dep of t.depends_on) {
        if (typeof dep !== 'string') {
          errors.push(`Task ${i}: depends_on element must be a string, got ${typeof dep}`);
          continue;
        }
        if (dep.startsWith('$')) {
          const idx = parseInt(dep.substring(1), 10);
          if (idx >= i) {
            warnings.push(`Task ${i}: depends on future task ${dep}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return makeError(ErrorCodes.INVALID_PARAM, `Validation failed:\n` + errors.map(e => `- ${e}`).join('\n'));
  }

  let result = `✓ Validation passed!\n\n**Tasks:** ${tasks.length}`;
  if (warnings.length > 0) {
    result += `\n\n**Warnings:**\n` + warnings.map(w => `- ${w}`).join('\n');
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * Create a task group
 */
function handleCreateGroup(args) {
  const groupId = uuidv4();

  const group = taskMetadata.createTaskGroup({
    id: groupId,
    name: args.name,
    project: args.project,
    description: args.description,
    default_priority: args.default_priority || 0,
    default_timeout: args.default_timeout || 30
  });

  return {
    content: [{
      type: 'text',
      text: `Task group created!\n` +
        `- **ID:** ${groupId}\n` +
        `- **Name:** ${group.name}\n` +
        `- **Project:** ${group.project || 'None'}`
    }]
  };
}


/**
 * List task groups
 */
function handleListGroups(args) {
  const groups = taskMetadata.listTaskGroups({ project: args.project });

  if (groups.length === 0) {
    return { content: [{ type: 'text', text: 'No task groups found.' }] };
  }

  let result = `## Task Groups\n\n`;
  result += `| Name | Project | Tasks | Running | Completed | Failed |\n`;
  result += `|------|---------|-------|---------|-----------|--------|\n`;

  for (const g of groups) {
    const s = g.stats || {};
    result += `| ${g.name} | ${g.project || '-'} | ${s.total || 0} | ${s.running || 0} | ${s.completed || 0} | ${s.failed || 0} |\n`;
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * Perform bulk action on a group
 */
function handleGroupAction(args) {
  const group = taskMetadata.getTaskGroup(args.group_id);
  if (!group) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Group not found: ${args.group_id}`);
  }

  const tasks = taskMetadata.getGroupTasks(args.group_id);
  let affected = 0;

  switch (args.action) {
    case 'start_all':
      for (const task of tasks) {
        if (task.status === 'pending' || task.status === 'queued') {
          try {
            taskManager.startTask(task.id);
            affected++;
          } catch (err) {
            logger.debug('[task-project] non-critical error starting task in batch action:', err.message || err);
          }
        }
      }
      break;

    case 'cancel_all':
      for (const task of tasks) {
        if (task.status === 'running' || task.status === 'queued') {
          taskManager.cancelTask(task.id, 'Group action: cancel_all');
          affected++;
        }
      }
      break;

    case 'retry_failed':
      for (const task of tasks) {
        if (task.status === 'failed') {
          // Create new task with same description
          const newTaskId = uuidv4();
          taskCore.createTask({
            id: newTaskId,
            status: 'pending',
            task_description: task.task_description,
            working_directory: task.working_directory,
            timeout_minutes: task.timeout_minutes,
            auto_approve: task.auto_approve,
            priority: task.priority,
            tags: task.tags,
            group_id: args.group_id
          });
          taskManager.startTask(newTaskId);
          affected++;
        }
      }
      break;

    default:
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${args.action}. Valid actions: start_all, cancel_all, retry_failed, set_priority, add_tags, remove_tags`);
  }

  return {
    content: [{
      type: 'text',
      text: `Group action '${args.action}' completed.\n**Affected tasks:** ${affected}`
    }]
  };
}


// ============ Phase 4: Advanced Analytics Handlers ============

/**
 * Forecast future costs
 */
function handleForecastCosts(args) {
  const daysAhead = Number(args.days_ahead || 30);
  if (!Number.isFinite(daysAhead) || daysAhead < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, 'days_ahead must be a positive number');
  }
  const basedOnDays = args.based_on_days || 30;

  // Get historical data (getCostByPeriod takes period string + limit)
  const history = costTracking.getCostByPeriod('day', basedOnDays);

  if (!history || history.length < 7) {
    return {
      content: [{
        type: 'text',
        text: 'Not enough historical data for forecasting. Need at least 7 days of data.'
      }]
    };
  }

  // Simple linear regression
  const n = history.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const cost = history[i].cost || 0;
    sumX += i;
    sumY += cost;
    sumXY += i * cost;
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // Calculate forecast
  const forecasts = [];
  let totalForecast = 0;

  for (let i = 0; i < daysAhead; i++) {
    const day = n + i;
    const predicted = Math.max(0, intercept + slope * day);
    totalForecast += predicted;
    if (i < 7 || i === daysAhead - 1) {
      forecasts.push({ day: i + 1, cost: predicted.toFixed(2) });
    }
  }

  const avgDaily = totalForecast / daysAhead;
  const trend = slope > 0.01 ? 'increasing' : slope < -0.01 ? 'decreasing' : 'stable';

  let result = `## Cost Forecast\n\n`;
  result += `**Project:** ${args.project || 'All'}\n`;
  result += `**Based on:** ${basedOnDays} days of history\n`;
  result += `**Trend:** ${trend}\n\n`;
  result += `### ${daysAhead}-Day Forecast\n`;
  result += `- **Total:** $${totalForecast.toFixed(2)}\n`;
  result += `- **Daily Avg:** $${avgDaily.toFixed(2)}\n\n`;
  result += `| Day | Predicted Cost |\n|-----|---------------|\n`;

  for (const f of forecasts) {
    result += `| ${f.day} | $${f.cost} |\n`;
  }

  return { content: [{ type: 'text', text: result }] };
}

/**
 * Delete a cost budget by ID or name
 */
function handleDeleteBudget(args) {
  const { budget_id } = args;
  if (!budget_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'budget_id is required');
  }
  const result = costTracking.deleteBudget(budget_id);
  if (!result.deleted) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Budget not found: ${budget_id}`);
  }
  return {
    content: [{ type: 'text', text: `Budget ${budget_id} deleted.` }]
  };
}

/**
 * Set default limits for new projects
 */
function handleSetDefaultLimits(args) {
  if (args.max_concurrent !== undefined) {
    configCore.setConfig('default_project_max_concurrent', String(args.max_concurrent));
  }
  if (args.max_daily_cost !== undefined) {
    configCore.setConfig('default_project_max_daily_cost', String(args.max_daily_cost));
  }
  if (args.auto_create_config !== undefined) {
    configCore.setConfig('auto_create_project_config', args.auto_create_config ? '1' : '0');
  }

  const config = {
    max_concurrent: serverConfig.get('default_project_max_concurrent') || '3',
    max_daily_cost: serverConfig.get('default_project_max_daily_cost') || '0',
    auto_create: serverConfig.get('auto_create_project_config') || '1'
  };

  return {
    content: [{
      type: 'text',
      text: `## Default Project Limits\n\n` +
        `- **Max Concurrent:** ${config.max_concurrent}\n` +
        `- **Max Daily Cost:** $${config.max_daily_cost} ${config.max_daily_cost === '0' ? '(unlimited)' : ''}\n` +
        `- **Auto-create Config:** ${config.auto_create === '1' ? 'Yes' : 'No'}`
    }]
  };
}


function createTaskProjectHandlers(_deps) {
  return {
    handleRecordUsage,
    handleGetTaskUsage,
    handleCostSummary,
    handleEstimateCost,
    handleListProjects,
    handleProjectStats,
    handleCurrentProject,
    handleConfigureProject,
    handleGetProjectConfig,
    handleListProjectConfigs,
    handleCloneTask,
    handleBulkImportTasks,
    handleValidateImport,
    handleCreateGroup,
    handleListGroups,
    handleGroupAction,
    handleForecastCosts,
    handleDeleteBudget,
    handleSetDefaultLimits,
  };
}

module.exports = {
  handleRecordUsage,
  handleGetTaskUsage,
  handleCostSummary,
  handleEstimateCost,
  handleListProjects,
  handleProjectStats,
  handleCurrentProject,
  handleConfigureProject,
  handleGetProjectConfig,
  handleListProjectConfigs,
  handleCloneTask,
  handleBulkImportTasks,
  handleValidateImport,
  handleCreateGroup,
  handleListGroups,
  handleGroupAction,
  handleForecastCosts,
  handleDeleteBudget,
  handleSetDefaultLimits,
  createTaskProjectHandlers,
};
