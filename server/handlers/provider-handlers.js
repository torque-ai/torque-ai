/**
 * Provider handlers aggregator
 * Extracted from tools.js
 */

const db = require('../database');
const taskManager = require('../task-manager');
const dashboard = require('../dashboard-server');
const { ErrorCodes, makeError } = require('./error-codes');

// ============================================
// PROVIDER MANAGEMENT HANDLERS
// ============================================

/**
 * Approve provider switch for a task
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleApproveProviderSwitch(args) {
  const { task_id, new_provider = 'claude-cli' } = args;

  if (!task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const task = db.approveProviderSwitch(task_id, new_provider);
  if (!task) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Task not found or cannot be approved');
  }

  // Process queue to start the task with new provider
  taskManager.processQueue();

  let output = `## Provider Switch Approved\n\n`;
  output += `Task **${task_id}** will now retry with **${new_provider}**.\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Status | ${task.status} |\n`;
  output += `| Provider | ${task.provider} |\n`;
  output += `| Original Provider | ${task.original_provider || 'N/A'} |\n`;
  output += `| Switched At | ${task.provider_switched_at || 'N/A'} |\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Reject provider switch for a task
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleRejectProviderSwitch(args) {
  const { task_id, reason } = args;

  if (!task_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required');
  }

  const task = db.rejectProviderSwitch(task_id, reason);
  if (!task) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Task not found or cannot be approved');
  }

  let output = `## Provider Switch Rejected\n\n`;
  output += `Task **${task_id}** has been marked as failed.\n\n`;
  if (reason) {
    output += `**Reason:** ${reason}\n\n`;
  }
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Status | ${task.status} |\n`;
  output += `| Provider | ${task.provider} |\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List all configured providers
 * @param {Object} [args] - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleListProviders() {
  const providers = db.listProviders();
  const defaultProvider = db.getDefaultProvider();

  let output = `## Configured Providers\n\n`;
  output += `**Default Provider:** ${defaultProvider}\n\n`;

  if (providers.length === 0) {
    output += `No providers configured.\n`;
  } else {
    output += `| Provider | Enabled | Priority | CLI Path | Max Concurrent |\n`;
    output += `|----------|---------|----------|----------|----------------|\n`;
    for (const p of providers) {
      const isDefault = p.provider === defaultProvider ? ' (default)' : '';
      output += `| ${p.provider}${isDefault} | ${p.enabled ? 'Yes' : 'No'} | ${p.priority} | ${p.cli_path || 'auto'} | ${p.max_concurrent} |\n`;
    }
    output += `\n### Quota Error Patterns\n\n`;
    for (const p of providers) {
      if (p.quota_error_patterns && p.quota_error_patterns.length > 0) {
        output += `**${p.provider}:** ${p.quota_error_patterns.join(', ')}\n`;
      }
    }
  }

  const structuredData = {
    default_provider: defaultProvider,
    count: providers.length,
    providers: providers.map(p => ({
      name: p.provider,
      enabled: !!p.enabled,
      priority: p.priority,
      max_concurrent: p.max_concurrent,
    })),
  };

  return { content: [{ type: 'text', text: output }], structuredData };
}


/**
 * Configure a provider
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleConfigureProvider(args) {
  const { provider, enabled, cli_path, quota_error_patterns, max_concurrent } = args;

  if (!provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }

  const existingProvider = db.getProvider(provider);
  if (!existingProvider) {
    return makeError(ErrorCodes.INVALID_PARAM, `Unknown provider: ${provider}`);
  }

  // RB-027: Validate provider config values
  if (max_concurrent !== undefined) {
    if (typeof max_concurrent !== 'number' || !Number.isInteger(max_concurrent) || max_concurrent < 1 || max_concurrent > 100) {
      return makeError(
        ErrorCodes.INVALID_PARAM,
        `Invalid max_concurrent for provider '${provider}': received '${max_concurrent}', expected an integer between 1 and 100`
      );
    }
  }
  if (cli_path !== undefined && typeof cli_path !== 'string') {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Invalid cli_path for provider '${provider}': received type '${typeof cli_path}', expected string`
    );
  }
  if (quota_error_patterns !== undefined && !Array.isArray(quota_error_patterns)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Invalid quota_error_patterns for provider '${provider}': expected an array of strings`
    );
  }

  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
  if (cli_path !== undefined) updates.cli_path = cli_path;
  if (quota_error_patterns !== undefined) updates.quota_error_patterns = quota_error_patterns;
  if (max_concurrent !== undefined) updates.max_concurrent = max_concurrent;

  const updated = db.updateProvider(provider, updates);

  let output = `## Provider Updated: ${provider}\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Enabled | ${updated.enabled ? 'Yes' : 'No'} |\n`;
  output += `| Priority | ${updated.priority} |\n`;
  output += `| CLI Path | ${updated.cli_path || 'auto'} |\n`;
  output += `| Max Concurrent | ${updated.max_concurrent} |\n`;
  output += `| Quota Patterns | ${updated.quota_error_patterns?.join(', ') || 'none'} |\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get provider statistics
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleProviderStats(args) {
  const { provider, days = 30 } = args;

  if (!provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }

  const stats = db.getProviderStats(provider, days);
  const providerConfig = db.getProvider(provider);

  let output = `## Provider Statistics: ${provider}\n\n`;
  output += `**Period:** Last ${days} days\n\n`;

  if (!providerConfig) {
    output += `*Provider not found*\n`;
  } else {
    output += `### Configuration\n`;
    output += `| Setting | Value |\n`;
    output += `|---------|-------|\n`;
    output += `| Enabled | ${providerConfig.enabled ? 'Yes' : 'No'} |\n`;
    output += `| Priority | ${providerConfig.priority} |\n`;
    output += `| Max Concurrent | ${providerConfig.max_concurrent} |\n\n`;

    output += `### Usage Statistics\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Tasks | ${stats.total_tasks} |\n`;
    output += `| Successful | ${stats.successful_tasks} |\n`;
    output += `| Failed | ${stats.failed_tasks} |\n`;
    output += `| Success Rate | ${stats.success_rate}% |\n`;
    output += `| Total Tokens | ${stats.total_tokens?.toLocaleString() || 'N/A'} |\n`;
    output += `| Total Cost | ${stats.total_cost ? '$' + stats.total_cost.toFixed(4) : 'N/A'} |\n`;
    output += `| Avg Duration | ${stats.avg_duration_seconds ? Math.round(stats.avg_duration_seconds) + 's' : 'N/A'} |\n`;
  }

  const structuredData = {
    provider,
    total_tasks: stats.total_tasks || 0,
    successful_tasks: stats.successful_tasks || 0,
    failed_tasks: stats.failed_tasks || 0,
    success_rate: stats.success_rate || 0,
    total_tokens: stats.total_tokens || 0,
    total_cost: stats.total_cost || 0,
    avg_duration_seconds: stats.avg_duration_seconds || 0,
    enabled: providerConfig ? !!providerConfig.enabled : false,
    priority: providerConfig ? providerConfig.priority : 0,
    max_concurrent: providerConfig ? providerConfig.max_concurrent : 0,
  };

  return { content: [{ type: 'text', text: output }], structuredData };
}


/**
 * Set default provider
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetDefaultProvider(args) {
  const { provider } = args;

  const providerName = (typeof provider === 'string' ? provider : '').trim();
  if (!providerName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }

  const availableProviders = db.listProviders().map((entry) => entry.provider);
  if (!availableProviders.includes(providerName)) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Unknown provider: ${providerName}. Known providers: ${availableProviders.join(', ')}`
    );
  }

  db.setDefaultProvider(providerName);

  let output = `## Default Provider Updated\n\n`;
  output += `New tasks will now use **${provider}** by default.\n\n`;
  output += `*Note: Existing tasks retain their original provider.*\n`;

  return { content: [{ type: 'text', text: output }] };
}


// ========================================
// Dashboard Handlers
// ========================================

/**
 * Start the dashboard server
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleStartDashboard(args) {
  try {
  
  const { port, open_browser } = args;
  

  const result = await dashboard.start({
    port,
    openBrowser: open_browser !== false
  });

  if (!result.success) {
    if (result.url) {
      // Already running or port in use
      let output = `## Dashboard Port In Use\n\n`;
      output += `The dashboard port is already in use.\n\n`;
      output += `- Try opening: **${result.url}**\n`;
      output += `- Or run: \`kill $(lsof -t -i:${port || 3456})\` to free the port\n`;
      output += `- Or use \`stop_dashboard\` if this session owns it`;
      return { content: [{ type: 'text', text: output }] };
    }
    return makeError(ErrorCodes.OPERATION_FAILED, result.error || 'Failed to start dashboard');
  }

  let output = `## Dashboard Started\n\n`;
  output += `The TORQUE dashboard is now running!\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| URL | ${result.url} |\n`;
  output += `| Port | ${result.port} |\n\n`;
  output += `The dashboard should open in your default browser automatically.\n\n`;
  output += `### Features\n`;
  output += `- **Kanban Board**: Visual task management with drag-drop\n`;
  output += `- **Task History**: Searchable, sortable task history\n`;
  output += `- **Provider Stats**: Charts for usage, success rates, costs\n`;
  output += `- **Real-time Updates**: Live task status via WebSocket\n`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Stop the dashboard server
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleStopDashboard(_args) {
  const status = dashboard.getStatus();

  if (!status.running) {
    return {
      content: [{
        type: 'text',
        text: `## Dashboard Not Running\n\nThe dashboard is not currently running. Use \`start_dashboard\` to start it.`
      }]
    };
  }

  const result = dashboard.stop();

  if (!result.success) {
    return makeError(ErrorCodes.OPERATION_FAILED, result.error || 'Failed to stop dashboard');
  }

  let output = `## Dashboard Stopped\n\n`;
  output += `The TORQUE dashboard has been stopped.\n\n`;
  output += `Use \`start_dashboard\` to start it again.`;

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Configure fallback chain for a provider
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleConfigureFallbackChain(args) {
  const { provider, chain } = args;

  if (!provider) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  if (!chain) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'chain is required (comma-separated provider names or JSON array)');

  let parsedChain;
  if (typeof chain === 'string') {
    try {
      parsedChain = JSON.parse(chain);
    } catch {
      parsedChain = chain.split(',').map(s => s.trim()).filter(Boolean);
    }
  } else if (Array.isArray(chain)) {
    parsedChain = chain;
  } else {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Invalid chain for provider '${provider}': expected a comma-separated string or JSON array`
    );
  }

  if (parsedChain.length === 0) return makeError(ErrorCodes.INVALID_PARAM, `Fallback chain for provider '${provider}' must not be empty`);

  db.setProviderFallbackChain(provider, parsedChain);

  return {
    content: [{
      type: 'text',
      text: `## Fallback Chain Updated: ${provider}\n\n**Chain:** ${parsedChain.join(' → ')}\n\nWhen ${provider} fails, tasks will be retried in this order.`
    }]
  };
}

/**
 * Detect provider performance degradation
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleDetectProviderDegradation(_args) {
  const degraded = db.detectProviderDegradation();

  if (degraded.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '## Provider Health\n\nAll providers operating within normal parameters. No degradation detected.'
      }]
    };
  }

  let output = '## Provider Degradation Detected\n\n';
  output += '| Provider | Failure Rate | Failed / Total |\n';
  output += '|----------|-------------|----------------|\n';
  for (const d of degraded) {
    output += `| **${d.provider}** | ${(d.failure_rate * 100).toFixed(1)}% | ${d.failed_tasks} / ${d.total_tasks} |\n`;
  }
  output += '\nConsider checking provider health or adjusting fallback chains.';

  return { content: [{ type: 'text', text: output }] };
}

function handleGetFormatSuccessRates(args) {
  if (args.model) {
    const hashline = db.getFormatSuccessRate(args.model, 'hashline');
    const lite = db.getFormatSuccessRate(args.model, 'hashline-lite');
    const best = db.getBestFormatForModel(args.model);
    let result = `## Format Success Rates: ${args.model}\n\n`;
    result += `| Format | Total | Success | Rate | Avg Duration |\n`;
    result += `|--------|-------|---------|------|-------------|\n`;
    result += `| hashline | ${hashline.total} | ${hashline.successes} | ${Math.round(hashline.rate * 100)}% | ${hashline.avg_duration}s |\n`;
    result += `| hashline-lite | ${lite.total} | ${lite.successes} | ${Math.round(lite.rate * 100)}% | ${lite.avg_duration}s |\n\n`;
    result += `**Recommended:** ${best.format || 'insufficient data'} (${best.reason})`;
    return { content: [{ type: 'text', text: result }] };
  }
  const summary = db.getFormatSuccessRatesSummary();
  if (summary.length === 0) {
    return { content: [{ type: 'text', text: 'No format success rate data recorded yet.' }] };
  }
  let result = `## Format Success Rates (All Models)\n\n`;
  result += `| Model | Format | Total | Success | Fail | Rate | Avg Duration | Failure Reasons |\n`;
  result += `|-------|--------|-------|---------|------|------|-------------|----------------|\n`;
  for (const r of summary) {
    result += `| ${r.model} | ${r.edit_format} | ${r.total} | ${r.successes} | ${r.failures} | ${r.success_rate_pct}% | ${r.avg_duration_s || '-'}s | ${r.failure_reasons || '-'} |\n`;
  }
  return { content: [{ type: 'text', text: result }] };
}

/**
 * Get provider health trend data
 * @param {Object} [args] - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetProviderHealthTrends(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'args must be an object');
  }

  const hasProvider = Object.prototype.hasOwnProperty.call(args, 'provider') && args.provider !== undefined;
  const hasDays = Object.prototype.hasOwnProperty.call(args, 'days') && args.days !== undefined;

  let providerName;
  if (hasProvider) {
    if (typeof args.provider !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'provider must be a string');
    }

    providerName = args.provider.trim();
    if (!providerName) {
      return makeError(ErrorCodes.INVALID_PARAM, 'provider must not be empty');
    }
  }

  let days;
  if (hasDays) {
    if (typeof args.days !== 'number' || !Number.isFinite(args.days) || args.days <= 0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'days must be a positive number');
    }

    days = args.days;
  }

  const result = providerName
    ? [db.getHealthTrend(providerName, days)].filter(Boolean)
    : db.listProviders().map((entry) => db.getHealthTrend(entry.provider, days)).filter(Boolean);

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * Get model performance leaderboard
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetModelLeaderboard(args) {
  const leaderboard = db.getModelLeaderboard({
    task_type: args.task_type,
    language: args.language,
    days: args.days,
    limit: args.limit
  });

  if (leaderboard.length === 0) {
    return { content: [{ type: 'text', text: 'No model outcome data available yet. Model outcomes are recorded for ollama provider tasks.' }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(leaderboard, null, 2) }] };
}

/**
 * Get provider duration percentile metrics (P50/P75/P90/P95/P99)
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetProviderPercentiles(args) {
  const { provider, days = 7 } = args;

  if (!provider) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider is required');
  }

  if (typeof days !== 'number' || days < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, 'days must be a positive number');
  }

  const fromDate = new Date(Date.now() - days * 86400000).toISOString();
  const tasks = db.listTasks({ provider, from_date: fromDate, limit: 1000 });
  const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);

  const durations = taskList
    .filter(t => t.completed_at && t.started_at)
    .map(t => (new Date(t.completed_at) - new Date(t.started_at)) / 1000)
    .sort((a, b) => a - b);

  if (durations.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Provider Percentiles: ${provider}\n\n**Period:** Last ${days} days\n\nNo completed tasks with duration data found.`
      }]
    };
  }

  const p = (arr, pct) => arr[Math.min(arr.length - 1, Math.floor(arr.length * pct / 100))] || null;
  const p50 = p(durations, 50);
  const p75 = p(durations, 75);
  const p90 = p(durations, 90);
  const p95 = p(durations, 95);
  const p99 = p(durations, 99);
  const min = durations[0];
  const max = durations[durations.length - 1];

  const fmt = (s) => s !== null ? `${Math.round(s)}s` : 'N/A';

  let output = `## Provider Percentiles: ${provider}\n\n`;
  output += `**Period:** Last ${days} days\n`;
  output += `**Sample Size:** ${durations.length} completed tasks\n\n`;
  output += `| Percentile | Duration |\n`;
  output += `|------------|----------|\n`;
  output += `| Min | ${fmt(min)} |\n`;
  output += `| P50 (median) | ${fmt(p50)} |\n`;
  output += `| P75 | ${fmt(p75)} |\n`;
  output += `| P90 | ${fmt(p90)} |\n`;
  output += `| P95 | ${fmt(p95)} |\n`;
  output += `| P99 | ${fmt(p99)} |\n`;
  output += `| Max | ${fmt(max)} |\n`;

  return { content: [{ type: 'text', text: output }] };
}

const ollamaHostHandlers = require('./provider-ollama-hosts');
const tuningHandlers = require('./provider-tuning');

module.exports = {
  handleApproveProviderSwitch,
  handleRejectProviderSwitch,
  handleListProviders,
  handleConfigureProvider,
  handleProviderStats,
  handleSetDefaultProvider,
  handleStartDashboard,
  handleStopDashboard,
  handleConfigureFallbackChain,
  handleDetectProviderDegradation,
  handleGetFormatSuccessRates,
  handleGetProviderHealthTrends,
  handleGetModelLeaderboard,
  handleGetProviderPercentiles,
  ...ollamaHostHandlers,
  ...tuningHandlers,
};
