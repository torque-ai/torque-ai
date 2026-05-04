/**
 * Integration handlers aggregator.
 *
 * Keeps reporting, integration status, git helpers, dependency views,
 * and chunked review handlers local; re-exports routing/plan/infra handlers.
 */

const path = require('path');
const database = require('../../database');
const eventTracking = require('../../db/event-tracking');
const projectConfigCore = require('../../db/project-config-core');
const providerRoutingCore = require('../../db/provider/routing-core');
const taskMetadata = require('../../db/task-metadata');
const taskManager = require('../../task-manager');
const chunkedReview = require('../../chunked-review');
const shared = require('../shared');
const { isPathTraversalSafe, requireString, requireEnum, ErrorCodes, makeError } = shared;
const { resolveOllamaModel } = require('../../providers/ollama-shared');
const { DEFAULT_FALLBACK_MODEL } = require('../../constants');

// ============================================================
// Wave 9: Integration Expansion Handlers (Option 5)
// ============================================================

/**
 * Export tasks as CSV
 */
function handleExportReportCSV(args) {
  const filters = {
    status: args.status,
    project: args.project,
    from_date: args.from_date,
    to_date: args.to_date,
    limit: args.limit || 1000
  };

  const result = projectConfigCore.exportTasksToCSV(filters);

  // Create export record
  const exportRecord = projectConfigCore.createReportExport('tasks', 'csv', filters);
  projectConfigCore.updateReportExport(exportRecord.id, 'completed', null, result.csv.length, result.row_count);

  let output = `## CSV Export\n\n`;
  output += `- **Rows:** ${result.row_count}\n`;
  output += `- **Size:** ${result.csv.length} bytes\n`;
  output += `- **Export ID:** ${exportRecord.id}\n\n`;

  if (result.row_count > 0 && result.row_count <= 10) {
    output += `### Preview\n\n\`\`\`csv\n${result.csv}\n\`\`\`\n`;
  } else if (result.row_count > 10) {
    const lines = result.csv.split('\n').slice(0, 11);
    output += `### Preview (first 10 rows)\n\n\`\`\`csv\n${lines.join('\n')}\n...\n\`\`\`\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Export tasks as JSON
 */
function handleExportReportJSON(args) {
  const filters = {
    status: args.status,
    project: args.project,
    from_date: args.from_date,
    to_date: args.to_date,
    limit: args.limit || 1000
  };

  const result = projectConfigCore.exportTasksToJSON(filters);

  // Create export record
  const exportRecord = projectConfigCore.createReportExport('tasks', 'json', filters);
  projectConfigCore.updateReportExport(exportRecord.id, 'completed', null, result.json.length, result.row_count);

  let output = `## JSON Export\n\n`;
  output += `- **Rows:** ${result.row_count}\n`;
  output += `- **Size:** ${result.json.length} bytes\n`;
  output += `- **Export ID:** ${exportRecord.id}\n\n`;

  if (result.row_count > 0 && result.row_count <= 3) {
    output += `### Data\n\n\`\`\`json\n${result.json}\n\`\`\`\n`;
  } else if (result.row_count > 3) {
    let tasks = [];
    try {
      const parsedTasks = JSON.parse(result.json);
      if (!Array.isArray(parsedTasks)) {
        return makeError(ErrorCodes.INVALID_PARAM, 'Export payload is malformed: expected an array of tasks');
      }

      tasks = parsedTasks
        .map((entry) => {
          if (entry === null || entry === undefined) {
            return null;
          }
          if (typeof entry === 'string') {
            try {
              return JSON.parse(entry);
            } catch {
              return null;
            }
          }
          return entry;
        })
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    } catch (err) {
      return makeError(ErrorCodes.INVALID_PARAM, `Malformed task export JSON: ${err.message}`);
    }

    const preview = JSON.stringify(tasks.slice(0, 3), null, 2);
    output += `### Preview (first 3 records)\n\n\`\`\`json\n${preview}\n\`\`\`\n`;
    if (tasks.length > 3) {
      output += `\n... and ${tasks.length - 3} more records\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List all integrations
 */
function handleListIntegrations(args) {
  const { include_disabled = false } = args;

  const integrations = providerRoutingCore.listIntegrationConfigs();
  const filtered = include_disabled
    ? integrations
    : integrations.filter(i => i.enabled);

  let output = `## Configured Integrations\n\n`;

  if (filtered.length === 0) {
    output += `No integrations configured${include_disabled ? '' : ' (enabled)'}.\n`;
    output += `\nUse \`configure_integration\` to set up Slack, Discord, or other services.\n`;
  } else {
    output += `| Type | ID | Status | Created |\n`;
    output += `|------|-----|--------|--------|\n`;
    for (const i of filtered) {
      const status = i.enabled ? '✓ Enabled' : '✗ Disabled';
      output += `| ${i.integration_type} | ${i.id} | ${status} | ${i.created_at} |\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Check integration health
 */
async function handleIntegrationHealth(args) {
  try {
  
  const { integration_type = 'all', include_history = false } = args;
  

  const integrations = providerRoutingCore.listIntegrationConfigs();
  const toCheck = integration_type === 'all'
    ? integrations.filter(i => i.enabled)
    : integrations.filter(i => i.integration_type === integration_type && i.enabled);

  let output = `## Integration Health\n\n`;

  if (toCheck.length === 0) {
    output += `No ${integration_type === 'all' ? '' : integration_type + ' '}integrations configured or enabled.\n`;
    return { content: [{ type: 'text', text: output }] };
  }

  output += `| Integration | Status | Latency |\n`;
  output += `|-------------|--------|----------|\n`;

  const structuredIntegrations = [];
  for (const integration of toCheck) {
    const startTime = Date.now();
    let status = 'unknown';
    let latency = null;
    let error = null;

    try {
      // Simple connectivity check
      const config = typeof integration.config === 'string'
        ? JSON.parse(integration.config)
        : integration.config;

      if (config.webhook_url) {
        // Just validate URL is parseable
        new URL(config.webhook_url);
        status = 'reachable';
        latency = Date.now() - startTime;
      } else {
        status = 'configured';
        latency = 0;
      }
    } catch (e) {
      status = 'error';
      error = e.message;
    }

    projectConfigCore.recordIntegrationHealth(integration.integration_type, integration.id, status, latency, error);

    const statusIcon = status === 'reachable' || status === 'configured' ? '✓' : '✗';
    output += `| ${integration.integration_type} | ${statusIcon} ${status} | ${latency !== null ? latency + 'ms' : 'N/A'} |\n`;
    structuredIntegrations.push({
      name: integration.integration_type,
      status,
      latency_ms: latency !== null ? latency : null,
    });
  }

  if (include_history) {
    const history = projectConfigCore.getIntegrationHealthHistory(integration_type === 'all' ? null : integration_type, 10);
    if (history.length > 0) {
      output += `\n### Recent Health Checks\n\n`;
      output += `| Type | Status | Latency | Time |\n`;
      output += `|------|--------|---------|------|\n`;
      for (const h of history) {
        output += `| ${h.integration_type} | ${h.status} | ${h.latency_ms || 'N/A'}ms | ${h.checked_at} |\n`;
      }
    }
  }

  return {
    content: [{ type: 'text', text: output }],
    structuredData: {
      count: structuredIntegrations.length,
      integrations: structuredIntegrations,
    },
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Test integration by sending a message
 */
async function handleTestIntegration(args) {
  try {
  
  const { integration_type, message = 'This is a test message from TORQUE' } = args;
  

  const err = requireEnum(args, 'integration_type', ['slack', 'discord']);
  if (err) return err;

  const integration = providerRoutingCore.getEnabledIntegration(integration_type);
  if (!integration) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `${integration_type} integration not configured or not enabled`);
  }

  const config = typeof integration.config === 'string'
    ? JSON.parse(integration.config)
    : integration.config;

  if (!config.webhook_url) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, `${integration_type} integration missing webhook_url`);
  }

  const startTime = Date.now();
  let status = 'failed';
  let error = null;
  let responseData = null;

  try {
    const https = require('https');
    const url = new URL(config.webhook_url);

    let payload;
    if (integration_type === 'slack') {
      payload = JSON.stringify({ text: `🧪 Test: ${message}` });
    } else {
      payload = JSON.stringify({ content: `🧪 Test: ${message}` });
    }

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            status = 'success';
            responseData = data || 'OK';
            resolve();
          } else {
            error = `HTTP ${res.statusCode}: ${data}`;
            reject(Object.assign(new Error(error), { code: ErrorCodes.INTERNAL_ERROR }));
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (e) {
    error = e.message;
  }

  const latency = Date.now() - startTime;
  projectConfigCore.recordIntegrationTest(integration_type, integration.id, 'message', status, message, responseData, error, latency);

  let output = `## Integration Test: ${integration_type}\n\n`;
  output += `- **Status:** ${status === 'success' ? '✓ Success' : '✗ Failed'}\n`;
  output += `- **Latency:** ${latency}ms\n`;
  output += `- **Message:** ${message}\n`;
  if (error) {
    output += `- **Error:** ${error}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Disable an integration
 */
function handleDisableIntegration(args) {
  const { integration_type } = args;

  const err = requireString(args, 'integration_type');
  if (err) return err;

  const integration = providerRoutingCore.getIntegrationConfig(`${integration_type}_config`);
  if (!integration) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `${integration_type} integration not configured`);
  }

  // Update config to disabled
  const config = typeof integration.config === 'string'
    ? JSON.parse(integration.config)
    : integration.config;

  providerRoutingCore.saveIntegrationConfig({
    id: integration.id,
    integration_type: integration.integration_type,
    config,
    enabled: false
  });

  let output = `## Integration Disabled\n\n`;
  output += `**Type:** ${integration_type}\n`;
  output += `**Status:** Disabled\n\n`;
  output += `Use \`enable_integration\` to re-enable.\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Enable an integration
 */
function handleEnableIntegration(args) {
  const { integration_type } = args;

  const err = requireString(args, 'integration_type');
  if (err) return err;

  const integration = providerRoutingCore.getIntegrationConfig(`${integration_type}_config`);
  if (!integration) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `${integration_type} integration not configured. Use configure_integration first.`);
  }

  // Update config to enabled
  const config = typeof integration.config === 'string'
    ? JSON.parse(integration.config)
    : integration.config;

  providerRoutingCore.saveIntegrationConfig({
    id: integration.id,
    integration_type: integration.integration_type,
    config,
    enabled: true
  });

  let output = `## Integration Enabled\n\n`;
  output += `**Type:** ${integration_type}\n`;
  output += `**Status:** Enabled\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List report exports
 */
function handleListReportExports(args) {
  const { limit = 50 } = args;

  const exports = projectConfigCore.listReportExports(limit);

  let output = `## Report Exports\n\n`;

  if (exports.length === 0) {
    output += `No exports found.\n`;
  } else {
    output += `| ID | Type | Format | Rows | Status | Date |\n`;
    output += `|-----|------|--------|------|--------|------|\n`;
    for (const e of exports) {
      output += `| ${e.id.substring(0, 8)}... | ${e.report_type} | ${e.format} | ${e.row_count || 'N/A'} | ${e.status} | ${e.created_at} |\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


// ============ Phase 2: Git Integration & Visibility Handlers ============

/**
 * View task changes using git diff
 */
function handleTaskChanges(args) {
  const task_id = (typeof args.task_id === 'string' ? args.task_id : '').trim();
  if (!task_id) {
    return makeError(ErrorCodes.INVALID_PARAM, 'task_id is required and must be a non-empty string');
  }

  const task = database.getTask(task_id);
  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${task_id}`);
  }

  if (!task.git_before_sha || !task.git_after_sha) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No git tracking data available for this task.');
  }

  const workDir = task.working_directory || process.cwd();
  const format = args.format || 'summary';

  let diffArgs = [];
  switch (format) {
    case 'full':
      diffArgs = ['diff', task.git_before_sha, task.git_after_sha];
      break;
    case 'stat':
      diffArgs = ['diff', '--stat', task.git_before_sha, task.git_after_sha];
      break;
    case 'summary':
    default:
      diffArgs = ['diff', '--name-status', task.git_before_sha, task.git_after_sha];
  }

  try {
    const { safeGitExec } = require('../../utils/git');
    const output = safeGitExec(diffArgs, { cwd: workDir, timeout: 10000 });

    return {
      content: [{
        type: 'text',
        text: `## Task Changes (${format})\n\n` +
          `**Task:** ${task_id.substring(0, 8)}...\n` +
          `**Before:** ${task.git_before_sha.substring(0, 8)}\n` +
          `**After:** ${task.git_after_sha.substring(0, 8)}\n\n` +
          '```\n' + (output || 'No changes') + '\n```'
      }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Error getting diff: ${err.message}`);
  }
}


/**
 * Rollback specific file from a task
 */
function handleRollbackFile(args) {
  const task_id = (typeof args.task_id === 'string' ? args.task_id : '').trim();
  if (!task_id) {
    return makeError(ErrorCodes.INVALID_PARAM, 'task_id is required and must be a non-empty string');
  }

  const task = database.getTask(task_id);
  if (!task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${task_id}`);
  }

  if (!task.git_before_sha) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No git tracking data available for rollback.');
  }

  const workDir = task.working_directory || process.cwd();

  // Validate file path to prevent path traversal attacks
  if (!args.file_path || typeof args.file_path !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required and must be a string');
  }
  if (!isPathTraversalSafe(args.file_path, workDir)) {
    return makeError(ErrorCodes.PATH_TRAVERSAL, 'Invalid file path: path traversal not allowed');
  }

  try {
    const { safeGitExec: safeGit } = require('../../utils/git');
    safeGit(['checkout', task.git_before_sha, '--', args.file_path], { cwd: workDir, maxBuffer: 10 * 1024 * 1024, timeout: 10000 });

    // Record the file change in the rollback metadata table used by rollback views.
    taskMetadata.recordFileChange(task_id, {
      file_path: args.file_path,
      change_type: 'rollback',
      working_directory: workDir,
    });

    return {
      content: [{
        type: 'text',
        text: `File rolled back: ${args.file_path}\nReverted to state before task ${task_id.substring(0, 8)}...`
      }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Rollback failed: ${err.message}`);
  }
}


/**
 * Stash changes
 */
function handleStashChanges(args) {
  let workDir;
  if (args.task_id) {
    const task = database.getTask(args.task_id);
    if (!task) {
      return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
    }
    workDir = task.working_directory || process.cwd();
  } else {
    workDir = args.working_directory || process.cwd();
  }

  try {
    const stashArgs = ['stash', 'push'];
    if (args.message) {
      stashArgs.push('-m', args.message);
    }

    const { safeGitExec: sgit } = require('../../utils/git');
    sgit(stashArgs, { cwd: workDir, maxBuffer: 10 * 1024 * 1024, timeout: 15000 });

    // Get the stash ref
    const stashRef = sgit(['stash', 'list', '-n', '1'], { cwd: workDir }).trim();

    if (args.task_id) {
      taskMetadata.recordFileChange(args.task_id, {
        file_path: '*',
        change_type: 'stash',
        stash_ref: stashRef,
        working_directory: workDir,
      });
      taskMetadata.updateTaskGitState(args.task_id, { stash_ref: stashRef });
    }

    return {
      content: [{
        type: 'text',
        text: `Changes stashed successfully.\n**Ref:** ${stashRef || 'stash@{0}'}`
      }]
    };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Stash failed: ${err.message}`);
  }
}


/**
 * List rollback points for a task
 */
function handleListRollbackPoints(args) {
  const points = taskMetadata.getRollbackPoints(args.task_id);

  if (!points.task) {
    return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
  }

  let result = `## Rollback Points for Task ${args.task_id.substring(0, 8)}...\n\n`;

  result += `### Git State\n`;
  result += `- **Before SHA:** ${points.task.git_before_sha || 'Not recorded'}\n`;
  result += `- **After SHA:** ${points.task.git_after_sha || 'Not recorded'}\n`;
  result += `- **Stash Ref:** ${points.task.git_stash_ref || 'None'}\n\n`;

  if (points.fileChanges.length > 0) {
    result += `### File Changes\n`;
    result += `| File | Type | Stash |\n`;
    result += `|------|------|-------|\n`;
    for (const fc of points.fileChanges) {
      result += `| ${fc.file_path} | ${fc.change_type} | ${fc.stash_ref || '-'} |\n`;
    }
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * Get success rates
 */
function handleSuccessRates(args) {
  const rates = eventTracking.getSuccessRates({
    groupBy: args.group_by || 'project',
    project: args.project,
    template: args.template,
    period_type: args.period_type,
    from_date: args.from_date,
    to_date: args.to_date
  });

  if (rates.length === 0) {
    return {
      content: [{ type: 'text', text: 'No metrics data available. Run `run_maintenance` to aggregate metrics.' }],
      structuredData: { count: 0, rates: [] },
    };
  }

  let result = `## Success Rates by ${args.group_by || 'project'}\n\n`;
  result += `| ${args.group_by || 'Project'} | Total | Success | Failed | Rate |\n`;
  result += `|---|-------|---------|--------|------|\n`;

  for (const r of rates) {
    result += `| ${r.group_key || 'Unknown'} | ${r.total} | ${r.successful} | ${r.failed} | ${r.success_rate}% |\n`;
  }

  const structuredData = {
    count: rates.length,
    rates: rates.map(r => ({
      group_key: r.group_key || 'Unknown',
      total: r.total,
      successful: r.successful,
      failed: r.failed,
      success_rate: r.success_rate,
    })),
  };

  return { content: [{ type: 'text', text: result }], structuredData };
}


/**
 * Compare performance between periods
 */
function handleComparePerformance(args) {
  const comparison = eventTracking.comparePerformance({
    current_from: args.current_from,
    current_to: args.current_to,
    previous_from: args.previous_from,
    previous_to: args.previous_to,
    groupBy: args.group_by || 'project'
  });

  let result = `## Performance Comparison\n\n`;
  result += `**Current:** ${args.current_from} to ${args.current_to}\n`;
  result += `**Previous:** ${args.previous_from} to ${args.previous_to}\n\n`;

  result += `| ${args.group_by || 'Project'} | Current | Previous | Change |\n`;
  result += `|---|---------|----------|--------|\n`;

  for (const c of comparison.comparison) {
    const change = c.change !== null ? (c.change >= 0 ? `+${c.change}%` : `${c.change}%`) : 'N/A';
    result += `| ${c.group_key || 'Unknown'} | ${c.current_rate}% | ${c.previous_rate !== null ? c.previous_rate + '%' : 'N/A'} | ${change} |\n`;
  }

  return { content: [{ type: 'text', text: result }] };
}


/**
 * View task dependencies as Mermaid diagram
 */
function handleViewDependencies(args) {
  let tasks;

  if (args.task_id) {
    const task = database.getTask(args.task_id);
    if (!task) {
      return makeError(ErrorCodes.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
    }
    tasks = [task, ...projectConfigCore.getDependentTasks(args.task_id)];
  } else {
    const statuses = args.include_completed
      ? ['pending', 'queued', 'running', 'completed']
      : ['pending', 'queued', 'running'];
    tasks = database.listTasks({ project: args.project, statuses, limit: 100 });
  }

  // Build Mermaid diagram
  let mermaid = '```mermaid\ngraph TD\n';

  for (const task of tasks) {
    const shortId = task.id.substring(0, 8);
    const label = task.task_description.substring(0, 20).replace(/"/g, "'");
    mermaid += `  ${shortId}["${label}..."]\n`;

    if (task.depends_on) {
      const deps = typeof task.depends_on === 'string' ? eventTracking.safeJsonParse(task.depends_on, []) : (task.depends_on || []);
      for (const dep of deps) {
        if (dep && typeof dep === 'string') {
          mermaid += `  ${dep.substring(0, 8)} --> ${shortId}\n`;
        }
      }
    }
  }

  mermaid += '```';

  return { content: [{ type: 'text', text: `## Task Dependencies\n\n${mermaid}` }] };
}



/**
 * Preview how a file would be chunked for review
 */
function handleGetFileChunks(args) {
  const { file_path, token_limit } = args;

  if (!file_path || typeof file_path !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path must be a non-empty string');
  }

  const chunkInfo = chunkedReview.generateReviewChunks(file_path, token_limit || chunkedReview.DEFAULT_CONTEXT_LIMIT);

  if (chunkInfo.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, chunkInfo.error);
  }

  let output = `## File Chunk Analysis\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| File | \`${file_path}\` |\n`;
  output += `| Total Lines | ${chunkInfo.totalLines} |\n`;
  output += `| Estimated Tokens | ${chunkInfo.totalTokens.toLocaleString()} |\n`;
  output += `| Needs Chunking | ${chunkInfo.needsChunking ? 'Yes' : 'No'} |\n`;

  if (chunkInfo.needsChunking) {
    output += `| Strategy | ${chunkInfo.strategy} |\n`;
    output += `| Token Limit | ${chunkInfo.tokenLimit.toLocaleString()} |\n`;
    output += `| Chunks | ${chunkInfo.chunks.length} |\n`;

    output += `\n### Chunks\n\n`;
    output += `| # | Lines | Tokens | Description |\n`;
    output += `|---|-------|--------|-------------|\n`;

    chunkInfo.chunks.forEach((chunk, i) => {
      output += `| ${i + 1} | ${chunk.startLine}-${chunk.endLine} | ${chunk.tokens.toLocaleString()} | ${chunk.description} |\n`;
    });
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Submit a large file for chunked review
 */
async function handleSubmitChunkedReview(args) {
  try {
  
  const { file_path, review_type, custom_prompt, model, token_limit, priority } = args;
  

  if (!file_path || typeof file_path !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path must be a non-empty string');
  }

  // Define review prompts for different review types
  const reviewPrompts = {
    code_review: `Review this code section for:
- Code quality and readability
- Potential bugs or logic errors
- Performance issues
- Best practice violations
- Security concerns

Provide specific, actionable feedback with line numbers.`,
    security_audit: `Perform a security audit of this code section:
- Input validation issues
- Injection vulnerabilities (SQL, command, XSS)
- Authentication/authorization flaws
- Sensitive data exposure
- Cryptographic weaknesses

Rate each issue by severity (Critical, High, Medium, Low).`,
    documentation: `Review this code section for documentation:
- Missing or unclear function/method documentation
- Incorrect or outdated comments
- Missing parameter descriptions
- Unclear variable/function names
- Complex logic needing explanation

Suggest documentation improvements.`,
    refactoring: `Analyze this code section for refactoring opportunities:
- Code duplication
- Long functions that should be split
- Complex conditionals
- Poor separation of concerns
- Opportunities for abstraction

Provide specific refactoring suggestions.`,
    bug_hunt: `Hunt for bugs in this code section:
- Off-by-one errors
- Null/undefined handling
- Race conditions
- Resource leaks
- Edge cases not handled
- Type coercion issues

List each potential bug with line numbers and explanation.`
  };

  const basePrompt = custom_prompt || reviewPrompts[review_type || 'code_review'];
  const fileName = path.basename(file_path);

  // Generate chunks
  const chunkInfo = chunkedReview.generateReviewChunks(file_path, token_limit || chunkedReview.DEFAULT_CONTEXT_LIMIT);

  if (chunkInfo.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, chunkInfo.error);
  }

  // If no chunking needed, submit single task
  if (!chunkInfo.needsChunking) {
    const routingResult = providerRoutingCore.analyzeTaskForRouting(`Review ${fileName}`, process.cwd(), [file_path]);
    const taskId = require('uuid').v4();

    const singleReviewProvider = model ? 'ollama' : routingResult.provider;
    database.createTask({
      id: taskId,
      task_description: `${basePrompt}\n\nFile: ${fileName}\n\nReview the entire file.`,
      working_directory: process.cwd(),
      status: 'queued',
      provider: null,  // deferred assignment
      model: model || routingResult.model,
      timeout_minutes: 30,
      priority: priority || 0,
      metadata: JSON.stringify({
        intended_provider: singleReviewProvider,
        chunked_review: false,
        file_path: file_path,
        review_type: review_type || 'code_review'
      })
    });

    taskManager.processQueue();

    return { content: [{ type: 'text', text: `## Single Review Task Submitted\n\nFile is small enough for single review.\n\n| Task ID | \`${taskId}\` |\n|---------|------------|\n\nUse \`get_task_status\` to check progress.` }] };
  }

  // Generate chunk tasks
  const chunkTasks = chunkedReview.generateChunkTasks(file_path, basePrompt, chunkInfo);
  const taskIds = [];

  // Read file content for chunk extraction
  const fs = require('fs');
  const fileContent = await fs.promises.readFile(file_path, 'utf8');
  const lines = fileContent.split('\n');

  // Submit each chunk as a separate task
  for (let i = 0; i < chunkTasks.length; i++) {
    const chunkTask = chunkTasks[i];
    const chunk = chunkInfo.chunks[i];
    const taskId = require('uuid').v4();

    // Extract chunk content
    const chunkLines = lines.slice(chunk.startLine - 1, chunk.endLine);
    const chunkContent = chunkLines.map((line, idx) => `${chunk.startLine + idx}: ${line}`).join('\n');

    const fullTask = `${chunkTask.task}\n\n---\n\n\`\`\`\n${chunkContent}\n\`\`\``;

    const routingResult = providerRoutingCore.analyzeTaskForRouting(`Review ${fileName}`, process.cwd(), [file_path]);

    const chunkProvider = model ? 'ollama' : routingResult.provider;
    database.createTask({
      id: taskId,
      task_description: fullTask,
      working_directory: process.cwd(),
      status: 'queued',
      provider: null,  // deferred assignment
      model: model || routingResult.model,
      timeout_minutes: 30,
      priority: priority || 0,
      metadata: JSON.stringify({
        intended_provider: chunkProvider,
        chunked_review: true,
        file_path: file_path,
        chunk_number: i + 1,
        total_chunks: chunkTasks.length,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        review_type: review_type || 'code_review'
      })
    });

    taskIds.push(taskId);
  }

  // Create aggregation task with 'pending' status - won't run until chunks complete
  // The task includes chunk IDs so results can be aggregated later
  const aggTask = chunkedReview.generateAggregationTask(file_path, chunkTasks.length, taskIds);
  const aggTaskId = require('uuid').v4();

  database.createTask({
    id: aggTaskId,
    task_description: aggTask.task,
    working_directory: process.cwd(),
    status: 'pending', // NOT queued - must be manually started after chunks complete
    provider: null,  // deferred assignment
    model: model || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL,
    timeout_minutes: 30,
    priority: priority || 0,
    metadata: JSON.stringify({
      intended_provider: model ? 'ollama' : 'ollama',
      chunked_review: true,
      is_aggregation: true,
      awaiting_chunks: true,
      file_path: file_path,
      chunk_task_ids: taskIds,
      review_type: review_type || 'code_review'
    })
  });

  taskManager.processQueue();

  let output = `## Chunked Review Submitted\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| File | \`${fileName}\` |\n`;
  output += `| Strategy | ${chunkInfo.strategy} |\n`;
  output += `| Chunks | ${chunkTasks.length} |\n`;
  output += `| Review Type | ${review_type || 'code_review'} |\n`;
  output += `| Aggregation Task | \`${aggTaskId}\` (pending) |\n`;

  output += `\n### Chunk Tasks\n\n`;
  output += `| # | Task ID | Lines |\n`;
  output += `|---|---------|-------|\n`;

  taskIds.forEach((id, i) => {
    const chunk = chunkInfo.chunks[i];
    output += `| ${i + 1} | \`${id.slice(0, 12)}...\` | ${chunk.startLine}-${chunk.endLine} |\n`;
  });

  output += `\n### Next Steps\n`;
  output += `1. Monitor chunk progress with \`check_status\`\n`;
  output += `2. Once all chunks complete, start the aggregation task:\n`;
  output += `   \`start_pending_task task_id="${aggTaskId}"\`\n`;
  output += `3. The aggregation will combine all chunk reviews into a final report.`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}



const routingHandlers = require('./routing');
const planHandlers = require('./plans');
const infraHandlers = require('./infra');

function createIntegrationHandlers(_deps) {
  return {
    handleExportReportCSV,
    handleExportReportJSON,
    handleListIntegrations,
    handleIntegrationHealth,
    handleTestIntegration,
    handleDisableIntegration,
    handleEnableIntegration,
    handleListReportExports,
    handleTaskChanges,
    handleRollbackFile,
    handleStashChanges,
    handleListRollbackPoints,
    handleSuccessRates,
    handleComparePerformance,
    handleViewDependencies,
    handleGetFileChunks,
    handleSubmitChunkedReview,
    ...routingHandlers,
    ...planHandlers,
    ...infraHandlers,
  };
}

module.exports = {
  handleExportReportCSV,
  handleExportReportJSON,
  handleListIntegrations,
  handleIntegrationHealth,
  handleTestIntegration,
  handleDisableIntegration,
  handleEnableIntegration,
  handleListReportExports,
  handleTaskChanges,
  handleRollbackFile,
  handleStashChanges,
  handleListRollbackPoints,
  handleSuccessRates,
  handleComparePerformance,
  handleViewDependencies,
  handleGetFileChunks,
  handleSubmitChunkedReview,
  ...routingHandlers,
  ...planHandlers,
  ...infraHandlers,
  createIntegrationHandlers,
};
