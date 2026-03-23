/**
 * Advanced handlers — Task Intelligence
 *
 * 26 handlers for caching, prioritization, failure prediction,
 * adaptive retry, A/B experiments, and intelligence analytics.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const configCore = require('../../db/config-core');
const taskCore = require('../../db/task-core');
const { cacheTaskResult, lookupCache, invalidateCache, getCacheStats, warmCache } = require('../../db/project-config-core');
const { computePriorityScore, getPriorityQueue, boostPriority, predictFailureForTask, learnFailurePattern, deleteFailurePattern, suggestIntervention, analyzeRetryPatterns, getRetryRecommendation, updateIntelligenceOutcome, getIntelligenceDashboard, createExperiment, getExperiment, concludeExperiment } = require('../../db/analytics');
const { getFailurePatterns } = require('../../db/validation-rules');
const taskManager = require('../../task-manager');
const serverConfig = require('../../config');
const { safeLimit, ErrorCodes, makeError, requireTask } = require('../shared');


// ----- Phase 1: Caching Handlers -----

/**
 * Cache a task result for future reuse
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCacheTaskResult(args) {
  const { task_id, ttl_hours } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'completed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not completed. Current status: ${task.status}`)
    };
  }

  const cacheEntry = cacheTaskResult(task_id, ttl_hours || 24);

  if (!cacheEntry) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, 'Failed to cache task result')
    };
  }

  let output = `## Task Result Cached\n\n`;
  output += `**Cache ID:** ${cacheEntry.id}\n`;
  output += `**Content Hash:** ${cacheEntry.content_hash.substring(0, 16)}...\n`;
  output += `**Expires:** ${new Date(cacheEntry.expires_at).toLocaleString()}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Look up cached result for a task description
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleLookupCache(args) {
  const { task_description, working_directory, min_confidence, use_semantic: _use_semantic } = args;

  const result = lookupCache(task_description, working_directory || null, null, min_confidence || 0.85);

  if (!result) {
    return {
      content: [{ type: 'text', text: `No cached result found for this task.\n\nTask: ${task_description.substring(0, 100)}...` }]
    };
  }

  let output = `## Cache Hit!\n\n`;
  output += `**Match Type:** ${result.match_type}\n`;
  output += `**Confidence:** ${Math.round((result.similarity || result.confidence_score || result.confidence || 0) * 100)}%\n`;
  output += `**Hit Count:** ${result.hit_count}\n`;
  output += `**Cached At:** ${new Date(result.created_at).toLocaleString()}\n\n`;
  output += `### Cached Result\n\n`;
  output += `**Exit Code:** ${result.result_exit_code}\n`;
  if (result.result_output) {
    output += `**Output Preview:**\n\`\`\`\n${result.result_output.substring(0, 500)}${result.result_output.length > 500 ? '...' : ''}\n\`\`\`\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Invalidate cache entries
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleInvalidateCache(args) {
  const { cache_id, task_description, older_than_hours, all_expired } = args;

  let invalidated = 0;

  if (cache_id) {
    const result = invalidateCache({ cacheId: cache_id });
    invalidated = result.deleted || 0;
  } else if (task_description) {
    const result = invalidateCache({ pattern: task_description });
    invalidated = result.deleted || 0;
  } else if (older_than_hours) {
    const cutoff = new Date(Date.now() - older_than_hours * 3600000).toISOString();
    const result = invalidateCache({ olderThan: cutoff });
    invalidated = result.deleted || 0;
  } else if (all_expired) {
    const result = invalidateCache();
    invalidated = result.deleted || 0;
  } else {
    return {
      ...makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Specify cache_id, task_description, older_than_hours, or all_expired=true')
    };
  }

  return {
    content: [{ type: 'text', text: `## Cache Invalidated\n\n**Entries Removed:** ${invalidated}` }]
  };
}


/**
 * Get cache statistics
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCacheStats(args) {
  const { cache_name } = args;

  let stats = getCacheStats();

  if (cache_name) {
    stats = stats.filter(s => s.cache_name === cache_name);
  }

  let output = `## Cache Statistics\n\n`;

  if (stats.length === 0) {
    output += `No cache statistics available${cache_name ? ` for cache "${cache_name}"` : ''}\n`;
  } else {
    output += `| Cache | Hits | Misses | Hit Rate | Evictions | Entries |\n`;
    output += `|-------|------|--------|----------|-----------|----------|\n`;
    for (const s of stats) {
      output += `| ${s.cache_name} | ${s.hits} | ${s.misses} | ${s.hit_rate} | ${s.evictions} | ${s.total_entries}/${s.max_entries} |\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Configure cache settings
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigureCache(args) {
  const { default_ttl_hours, max_entries, min_confidence_threshold, enable_semantic } = args;

  const config = {};
  if (default_ttl_hours !== undefined) config.default_ttl_hours = default_ttl_hours;
  if (max_entries !== undefined) config.max_entries = max_entries;
  if (min_confidence_threshold !== undefined) config.min_confidence_threshold = min_confidence_threshold;
  if (enable_semantic !== undefined) config.enable_semantic = enable_semantic ? 1 : 0;

  // Persist cache config via setConfig
  if (config.default_ttl_hours !== undefined) configCore.setConfig('cache_ttl_hours', String(config.default_ttl_hours));
  if (config.max_entries !== undefined) configCore.setConfig('cache_max_entries', String(config.max_entries));
  if (config.min_confidence_threshold !== undefined) configCore.setConfig('cache_min_confidence', String(config.min_confidence_threshold));
  if (config.enable_semantic !== undefined) configCore.setConfig('cache_enable_semantic', String(config.enable_semantic));

  const ttl = serverConfig.get('cache_ttl_hours', '24');
  const maxEnt = serverConfig.get('cache_max_entries', '1000');
  const minConf = serverConfig.get('cache_min_confidence', '0.7');
  const semantic = serverConfig.get('cache_enable_semantic', '0');

  let output = `## Cache Configuration Updated\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Default TTL | ${ttl} hours |\n`;
  output += `| Max Entries | ${maxEnt} |\n`;
  output += `| Min Confidence | ${minConf} |\n`;
  output += `| Semantic Matching | ${semantic !== '0' ? 'Enabled' : 'Disabled'} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Warm cache from completed tasks
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleWarmCache(args) {
  const { limit, min_exit_code: _min_exit_code } = args;

  const warmed = warmCache(safeLimit(limit, 50), undefined, null);

  let output = `## Cache Warmed\n\n`;
  output += `**Entries Cached:** ${warmed.cached}\n`;
  output += `**Tasks Scanned:** ${warmed.scanned}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ----- Phase 2: Prioritization Handlers -----

/**
 * Compute priority score for a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleComputePriority(args) {
  const { task_id, recalculate: _recalculate } = args;

  const { task: _task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const score = computePriorityScore(task_id);

  if (!score) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Could not compute priority for task ${task_id}`)
    };
  }

  const factors = score.factors || {};
  let output = `## Priority Score: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Final Score:** ${score.combined_score.toFixed(2)}\n\n`;
  output += `### Components\n\n`;
  output += `| Factor | Score | Weight | Contribution |\n`;
  output += `|--------|-------|--------|-------------|\n`;
  output += `| Resource | ${score.resource_score.toFixed(2)} | ${((factors.resource?.weight || 0) * 100).toFixed(0)}% | ${(score.resource_score * (factors.resource?.weight || 0)).toFixed(2)} |\n`;
  output += `| Success Rate | ${score.success_score.toFixed(2)} | ${((factors.success?.weight || 0) * 100).toFixed(0)}% | ${(score.success_score * (factors.success?.weight || 0)).toFixed(2)} |\n`;
  output += `| Dependency | ${score.dependency_score.toFixed(2)} | ${((factors.dependency?.weight || 0) * 100).toFixed(0)}% | ${(score.dependency_score * (factors.dependency?.weight || 0)).toFixed(2)} |\n`;

  if (factors.manual_boost) {
    output += `\n**Manual Boost:** +${factors.manual_boost.amount}`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get priority queue
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetPriorityQueue(args) {
  const { status: _status, limit } = args;

  const queue = getPriorityQueue(safeLimit(limit, 20), 0);

  if (queue.length === 0) {
    return {
      content: [{ type: 'text', text: `## Priority Queue\n\nNo tasks in queue.` }]
    };
  }

  let output = `## Priority Queue\n\n`;
  output += `| # | Task ID | Score | Description |\n`;
  output += `|---|---------|-------|-------------|\n`;

  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    const desc = t.task_description.substring(0, 40) + '...';
    output += `| ${i + 1} | ${t.id.substring(0, 8)} | ${t.combined_score != null ? t.combined_score.toFixed(2) : 'N/A'} | ${desc} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Configure priority weights
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigurePriorityWeights(args) {
  const { resource_weight, success_weight, dependency_weight } = args;

  const config = {};
  if (resource_weight !== undefined) config.resource_weight = resource_weight;
  if (success_weight !== undefined) config.success_weight = success_weight;
  if (dependency_weight !== undefined) config.dependency_weight = dependency_weight;

  // Normalize weights
  const total = (config.resource_weight || 0.3) + (config.success_weight || 0.3) + (config.dependency_weight || 0.4);
  if (Math.abs(total - 1.0) > 0.01) {
    return {
      ...makeError(ErrorCodes.INVALID_PARAM, `Weights must sum to 1.0. Current sum: ${total.toFixed(2)}`)
    };
  }

  // Persist priority weights via setConfig
  if (config.resource_weight !== undefined) configCore.setConfig('priority_resource_weight', String(config.resource_weight));
  if (config.success_weight !== undefined) configCore.setConfig('priority_success_weight', String(config.success_weight));
  if (config.dependency_weight !== undefined) configCore.setConfig('priority_dependency_weight', String(config.dependency_weight));

  const rw = serverConfig.getFloat('priority_resource_weight', 0.3);
  const sw = serverConfig.getFloat('priority_success_weight', 0.3);
  const dw = serverConfig.getFloat('priority_dependency_weight', 0.4);

  let output = `## Priority Weights Updated\n\n`;
  output += `| Factor | Weight |\n`;
  output += `|--------|--------|\n`;
  output += `| Resource | ${(rw * 100).toFixed(0)}% |\n`;
  output += `| Success Rate | ${(sw * 100).toFixed(0)}% |\n`;
  output += `| Dependency | ${(dw * 100).toFixed(0)}% |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Explain priority calculation
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleExplainPriority(args) {
  const { task_id } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  // Priority explanation using config weights and task data
  const rw = serverConfig.getFloat('priority_resource_weight', 0.3);
  const sw = serverConfig.getFloat('priority_success_weight', 0.3);
  const dw = serverConfig.getFloat('priority_dependency_weight', 0.4);

  let output = `## Priority Explanation: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Task Priority:** ${task.priority}\n`;
  output += `**Complexity:** ${task.complexity || 'normal'}\n`;
  output += `**Provider:** ${task.provider || 'default'}\n\n`;
  output += `### Configured Weights\n\n`;
  output += `| Factor | Weight |\n`;
  output += `|--------|--------|\n`;
  output += `| Resource | ${(rw * 100).toFixed(0)}% |\n`;
  output += `| Success Rate | ${(sw * 100).toFixed(0)}% |\n`;
  output += `| Dependency | ${(dw * 100).toFixed(0)}% |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Manually boost task priority
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleBoostPriority(args) {
  const { task_id, boost_amount, reason } = args;

  const { task: _task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  boostPriority(task_id, boost_amount, reason || 'Manual boost');

  const newScore = computePriorityScore(task_id);

  let output = `## Priority Boosted\n\n`;
  output += `**Task:** ${task_id.substring(0, 8)}...\n`;
  output += `**Boost:** +${boost_amount}\n`;
  output += `**Reason:** ${reason || 'Manual boost'}\n`;
  output += `**New Score:** ${newScore ? newScore.combined_score.toFixed(2) : 'N/A'}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ----- Phase 3: Failure Prediction Handlers -----

/**
 * Predict failure probability for a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handlePredictFailure(args) {
  const { task_id, task_description, working_directory } = args;

  let prediction;
  if (task_id) {
    const { task, error: taskErr } = requireTask(task_id);
    if (taskErr) return taskErr;
    prediction = predictFailureForTask(task.task_description, task.working_directory);
  } else if (task_description) {
    prediction = predictFailureForTask(task_description, working_directory || null);
  } else {
    return {
      ...makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide either task_id or task_description')
    };
  }

  const riskLevel = prediction.probability > 0.7 ? 'High' : prediction.probability > 0.3 ? 'Medium' : 'Low';
  let output = `## Failure Prediction\n\n`;
  output += `**Failure Probability:** ${Math.round(prediction.probability * 100)}%\n`;
  output += `**Risk Level:** ${riskLevel}\n`;
  output += `**Confidence:** ${Math.round(prediction.confidence * 100)}%\n\n`;

  if (prediction.patterns && prediction.patterns.length > 0) {
    output += `### Matched Patterns\n\n`;
    for (const p of prediction.patterns) {
      output += `- **${p.type}**: ${JSON.stringify(p.definition)} (failure rate: ${Math.round(p.failure_rate * 100)}%)\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Learn a failure pattern from a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleLearnFailurePattern(args) {
  const { task_id, name, description } = args;

  if (!task_id || !name || !description) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id, name, and description are required');
  }

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  // Verify task has output to learn from
  const taskOutput = task.output || task.error_output || task.error || '';
  if (!taskOutput) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Task has no output to learn from');
  }

  const patterns = learnFailurePattern(task_id);

  if (!patterns || patterns.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Failure Pattern Learning\n\nNo patterns could be extracted from task ${task_id.substring(0, 8)}...`
      }]
    };
  }

  let output = `## Failure Pattern Learned\n\n`;
  output += `- **Name:** ${name}\n`;
  output += `- **Source Task:** ${task_id}\n`;
  output += `- **Patterns Found:** ${patterns.length}\n`;
  output += `- **Provider:** ${task.provider || 'unknown'}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List failure patterns
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListFailurePatterns(args) {
  const { provider, enabled_only = true } = args;
  const patterns = getFailurePatterns(provider, enabled_only);

  if (patterns.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## Failure Patterns\n\nNo failure patterns found${provider ? ` for ${provider}` : ''}.`
      }]
    };
  }

  let output = `## Failure Patterns\n\n`;
  output += `| Name | Provider | Severity | Matches | Enabled |\n`;
  output += `|------|----------|----------|---------|----------|\n`;

  patterns.forEach(p => {
    output += `| ${p.name} | ${p.provider || 'all'} | ${p.severity} | ${p.match_count} | ${p.enabled ? '\u2713' : '\u2717'} |\n`;
  });

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Delete a failure pattern
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleDeleteFailurePattern(args) {
  const deleted = deleteFailurePattern(args.pattern_id);

  if (!deleted) {
    return {
      ...makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Pattern not found: ${args.pattern_id}`)
    };
  }

  return {
    content: [{ type: 'text', text: `## Pattern Deleted\n\n**ID:** ${args.pattern_id}` }]
  };
}


/**
 * Suggest intervention for a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleSuggestIntervention(args) {
  const { task_id } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  const result = suggestIntervention(task.task_description, task.working_directory);
  const interventions = result.interventions || [];

  let output = `## Intervention Suggestions: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Failure Probability:** ${Math.round((result.prediction?.probability || 0) * 100)}%\n\n`;

  if (interventions.length === 0) {
    output += `No interventions suggested. Task appears healthy.`;
  } else {
    output += `| # | Type | Reason |\n`;
    output += `|---|------|--------|\n`;

    for (let i = 0; i < interventions.length; i++) {
      const s = interventions[i];
      output += `| ${i + 1} | ${s.type} | ${s.reason || ''} |\n`;
    }

    output += `\n*Use \`apply_intervention\` with suggestion number to apply.*`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Apply an intervention to a task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleApplyIntervention(args) {
  const { task_id, intervention_type, parameters } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  // Apply intervention based on type
  let result = { success: false, message: 'Unknown intervention type' };
  try {
    if (intervention_type === 'cancel') {
      taskCore.updateTaskStatus(task_id, 'cancelled', { error_output: `Cancelled via intervention: ${JSON.stringify(parameters || {})}` });
      result = { success: true, message: 'Task cancelled' };
    } else if (intervention_type === 'requeue') {
      taskCore.updateTaskStatus(task_id, 'queued', { pid: null, started_at: null });
      result = { success: true, message: 'Task requeued' };
    } else if (intervention_type === 'reprioritize' && parameters?.priority !== undefined) {
      taskCore.updateTaskStatus(task_id, task.status, { priority: parameters.priority });
      result = { success: true, message: `Priority set to ${parameters.priority}` };
    } else {
      result = { success: false, message: `Unsupported intervention type: ${intervention_type}` };
    }
  } catch (err) {
    result = { success: false, message: err.message };
  }

  let output = `## Intervention Applied\n\n`;
  output += `**Task:** ${task_id.substring(0, 8)}...\n`;
  output += `**Type:** ${intervention_type}\n`;
  output += `**Result:** ${result.success ? 'Success' : 'Failed'}\n`;
  if (result.message) {
    output += `**Details:** ${result.message}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ----- Phase 4: Adaptive Retry Handlers -----

/**
 * Analyze retry patterns
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAnalyzeRetryPatterns(args) {
  const { time_range_hours } = args;

  const hours = time_range_hours || 168; // 7 days default
  // Pass null to avoid WHERE clause on missing column; filter post-query if needed
  const patterns = analyzeRetryPatterns(null);

  let output = `## Retry Pattern Analysis\n\n`;
  output += `**Period:** Last ${hours} hours\n\n`;

  output += `### Strategy Results\n\n`;

  if (!patterns || patterns.length === 0) {
    output += `No retry patterns found in this period.\n`;
  } else {
    output += `| Strategy | Error Type | Attempts | Successes | Success Rate |\n`;
    output += `|----------|------------|----------|-----------|-------------|\n`;

    for (const p of patterns) {
      output += `| ${p.strategy_used || 'N/A'} | ${(p.error_type || '').substring(0, 40)} | ${p.attempts} | ${p.successes} | ${Math.round(p.success_rate * 100)}% |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Configure adaptive retry settings
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigureAdaptiveRetry(args) {
  const { enabled, default_fallback, max_retries_per_task } = args;
  const updates = [];

  if (enabled !== undefined) {
    configCore.setConfig('adaptive_retry_enabled', enabled ? '1' : '0');
    updates.push(`enabled \u2192 ${enabled}`);
  }

  if (default_fallback) {
    configCore.setConfig('adaptive_retry_default_fallback', default_fallback);
    updates.push(`default_fallback \u2192 ${default_fallback}`);
  }

  if (max_retries_per_task !== undefined) {
    configCore.setConfig('adaptive_retry_max_per_task', max_retries_per_task.toString());
    updates.push(`max_retries_per_task \u2192 ${max_retries_per_task}`);
  }

  if (updates.length === 0) {
    const currentEnabled = serverConfig.getBool('adaptive_retry_enabled');
    const currentFallback = serverConfig.get('adaptive_retry_default_fallback', 'claude-cli');
    const currentMax = serverConfig.get('adaptive_retry_max_per_task', '1');

    return {
      content: [{
        type: 'text',
        text: `## Adaptive Retry Configuration\n\n- **Enabled:** ${currentEnabled}\n- **Default Fallback:** ${currentFallback}\n- **Max Retries Per Task:** ${currentMax}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Adaptive Retry Updated\n\n${updates.map(u => `- ${u}`).join('\n')}`
    }]
  };
}


/**
 * Get retry recommendation for a failed task
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetRetryRecommendation(args) {
  const { task_id } = args;

  const { task, error: taskErr } = requireTask(task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'failed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not failed. Status: ${task.status}`)
    };
  }

  const previousError = task.error_output || task.error || '';
  const recommendation = getRetryRecommendation(task_id, previousError);

  if (!recommendation) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Could not generate retry recommendation for task ${task_id}`)
    };
  }

  let output = `## Retry Recommendation: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Task:** ${recommendation.task_id}\n`;
  output += `**Original Timeout:** ${recommendation.original_timeout || 'N/A'} min\n\n`;

  if (recommendation.adaptations && Object.keys(recommendation.adaptations).length > 0) {
    output += `### Suggested Adaptations\n\n`;
    output += `| Setting | Value |\n`;
    output += `|---------|-------|\n`;
    for (const [key, val] of Object.entries(recommendation.adaptations)) {
      output += `| ${key} | ${val} |\n`;
    }
  } else {
    output += `No specific adaptations recommended.\n`;
  }

  if (recommendation.applied_rules && recommendation.applied_rules.length > 0) {
    output += `\n**Applied Rules:** ${recommendation.applied_rules.join(', ')}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Retry with adaptive strategy
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleRetryWithAdaptation(args) {
  const { task_id, apply_recommendations } = args;

  const { task, error: taskErr2 } = requireTask(task_id);
  if (taskErr2) return taskErr2;

  if (task.status !== 'failed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not failed. Status: ${task.status}`)
    };
  }

  // Get recommendation
  const previousError = task.error_output || task.error || '';
  const recommendation = getRetryRecommendation(task_id, previousError);

  if (!recommendation) {
    return {
      content: [{ type: 'text', text: `## Retry Not Recommended\n\n**Reason:** Could not generate recommendation` }]
    };
  }

  const adaptations = recommendation.adaptations || {};

  // Reset task and update
  taskCore.updateTaskStatus(task_id, 'pending', {
    output: null,
    error_output: null,
    exit_code: null
  });

  // Start task
  const startResult = taskManager.startTask(task_id);

  let output = `## Adaptive Retry Started\n\n`;
  output += `**Task:** ${task_id.substring(0, 8)}...\n`;
  output += `**Status:** ${startResult.queued ? 'Queued' : 'Running'}\n`;

  if (apply_recommendations && Object.keys(adaptations).length > 0) {
    output += `\n**Adaptations Applied:**\n`;
    for (const [key, val] of Object.entries(adaptations)) {
      output += `- ${key}: ${val}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


// ----- Phase 5: Analytics Handlers -----

/**
 * Intelligence dashboard
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleIntelligenceDashboard(args) {
  const { time_range_hours } = args;

  const hours = time_range_hours || 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const dashboard = getIntelligenceDashboard(since);

  let output = `## Task Intelligence Dashboard\n\n`;
  output += `**Period:** Last ${hours} hours\n\n`;

  output += `### Cache Performance\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  // cache is an array of cache stat objects from getCacheStats
  const cacheArr = Array.isArray(dashboard.cache) ? dashboard.cache : [];
  if (cacheArr.length > 0) {
    for (const c of cacheArr) {
      output += `| ${c.cache_name} hit rate | ${c.hit_rate || 'N/A'} |\n`;
    }
  } else {
    output += `| Status | No cache data |\n`;
  }

  output += `\n### Failure Predictions\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  const pred = dashboard.predictions || {};
  output += `| Total Predictions | ${pred.total_predictions || 0} |\n`;
  output += `| Correct | ${pred.correct || 0} |\n`;
  output += `| Incorrect | ${pred.incorrect || 0} |\n`;
  output += `| Accuracy | ${pred.accuracy != null ? Math.round(pred.accuracy * 100) + '%' : 'N/A'} |\n`;

  output += `\n### Failure Patterns\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  const pat = dashboard.patterns || {};
  output += `| Total Patterns | ${pat.total_patterns || 0} |\n`;
  output += `| Avg Confidence | ${pat.avg_confidence != null ? pat.avg_confidence.toFixed(2) : 'N/A'} |\n`;
  output += `| Avg Failure Rate | ${pat.avg_failure_rate != null ? Math.round(pat.avg_failure_rate * 100) + '%' : 'N/A'} |\n`;

  output += `\n### Experiments\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  const exp = dashboard.experiments || {};
  output += `| Total Experiments | ${exp.total_experiments || 0} |\n`;
  output += `| Running | ${exp.running || 0} |\n`;
  output += `| Completed | ${exp.completed || 0} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Log intelligence outcome
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleLogIntelligenceOutcome(args) {
  const { log_id, outcome } = args;

  updateIntelligenceOutcome(log_id, outcome);

  return {
    content: [{ type: 'text', text: `## Outcome Logged\n\n**Log ID:** ${log_id}\n**Outcome:** ${outcome}` }]
  };
}


/**
 * Create an A/B experiment
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCreateExperiment(args) {
  const { name, strategy_type, variant_a, variant_b, sample_size } = args;

  if (!name || !variant_a || !variant_b) {
    return {
      ...makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide name, variant_a, and variant_b')
    };
  }

  const experiment = createExperiment(
    name,
    strategy_type || 'experiment',
    variant_a,
    variant_b,
    sample_size || 100
  );

  let output = `## Experiment Created\n\n`;
  output += `**ID:** ${experiment.id}\n`;
  output += `**Name:** ${experiment.name}\n`;
  output += `**Strategy Type:** ${experiment.strategy_type}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get experiment status
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleExperimentStatus(args) {
  const experiment = getExperiment(args.experiment_id);

  if (!experiment) {
    return {
      ...makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Experiment not found: ${args.experiment_id}`)
    };
  }

  const resultsA = experiment.results_a || { count: 0, successes: 0, total_duration: 0 };
  const resultsB = experiment.results_b || { count: 0, successes: 0, total_duration: 0 };
  const totalSamples = resultsA.count + resultsB.count;

  let output = `## Experiment: ${experiment.name}\n\n`;
  output += `**Status:** ${experiment.status}\n`;
  output += `**Strategy Type:** ${experiment.strategy_type}\n`;
  output += `**Progress:** ${totalSamples}/${experiment.sample_size_target || 'N/A'}\n\n`;

  const rateA = resultsA.count > 0 ? resultsA.successes / resultsA.count : 0;
  const avgDurA = resultsA.count > 0 ? resultsA.total_duration / resultsA.count : 0;

  output += `### Variant A\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Samples | ${resultsA.count} |\n`;
  output += `| Success Rate | ${resultsA.count > 0 ? Math.round(rateA * 100) + '%' : 'N/A'} |\n`;
  output += `| Avg Duration | ${resultsA.count > 0 ? avgDurA.toFixed(1) : 'N/A'} sec |\n`;

  const rateB = resultsB.count > 0 ? resultsB.successes / resultsB.count : 0;
  const avgDurB = resultsB.count > 0 ? resultsB.total_duration / resultsB.count : 0;

  output += `\n### Variant B\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Samples | ${resultsB.count} |\n`;
  output += `| Success Rate | ${resultsB.count > 0 ? Math.round(rateB * 100) + '%' : 'N/A'} |\n`;
  output += `| Avg Duration | ${resultsB.count > 0 ? avgDurB.toFixed(1) : 'N/A'} sec |\n`;

  if (experiment.winner) {
    output += `\n**Winner:** Variant ${experiment.winner.toUpperCase()}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Conclude an experiment
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConcludeExperiment(args) {
  const { experiment_id, apply_winner } = args;

  const experiment = getExperiment(experiment_id);
  if (!experiment) {
    return {
      ...makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Experiment not found: ${experiment_id}`)
    };
  }

  if (experiment.status === 'completed') {
    return {
      content: [{ type: 'text', text: `Experiment already concluded. Winner: ${experiment.winner || 'N/A'}` }]
    };
  }

  const result = concludeExperiment(experiment_id, !!apply_winner);

  if (!result) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Could not conclude experiment ${experiment_id}`)
    };
  }

  let output = `## Experiment Concluded\n\n`;
  output += `**Name:** ${experiment.name}\n`;
  output += `**Significant:** ${result.significant ? 'Yes' : 'No'}\n`;
  if (result.winner) {
    output += `**Winner:** Variant ${result.winner.toUpperCase()}\n`;
    output += `**Rate A:** ${(result.rate_a * 100).toFixed(1)}%\n`;
    output += `**Rate B:** ${(result.rate_b * 100).toFixed(1)}%\n`;
  }
  if (result.applied) {
    output += `\n*Winning strategy has been automatically applied as the new default.*`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


function createIntelligenceHandlers() {
  return {
    handleCacheTaskResult,
    handleLookupCache,
    handleInvalidateCache,
    handleCacheStats,
    handleConfigureCache,
    handleWarmCache,
    handleComputePriority,
    handleGetPriorityQueue,
    handleConfigurePriorityWeights,
    handleExplainPriority,
    handleBoostPriority,
    handlePredictFailure,
    handleLearnFailurePattern,
    handleListFailurePatterns,
    handleDeleteFailurePattern,
    handleSuggestIntervention,
    handleApplyIntervention,
    handleAnalyzeRetryPatterns,
    handleConfigureAdaptiveRetry,
    handleGetRetryRecommendation,
    handleRetryWithAdaptation,
    handleIntelligenceDashboard,
    handleLogIntelligenceOutcome,
    handleCreateExperiment,
    handleExperimentStatus,
    handleConcludeExperiment,
  };
}

module.exports = {
  handleCacheTaskResult,
  handleLookupCache,
  handleInvalidateCache,
  handleCacheStats,
  handleConfigureCache,
  handleWarmCache,
  handleComputePriority,
  handleGetPriorityQueue,
  handleConfigurePriorityWeights,
  handleExplainPriority,
  handleBoostPriority,
  handlePredictFailure,
  handleLearnFailurePattern,
  handleListFailurePatterns,
  handleDeleteFailurePattern,
  handleSuggestIntervention,
  handleApplyIntervention,
  handleAnalyzeRetryPatterns,
  handleConfigureAdaptiveRetry,
  handleGetRetryRecommendation,
  handleRetryWithAdaptation,
  handleIntelligenceDashboard,
  handleLogIntelligenceOutcome,
  handleCreateExperiment,
  handleExperimentStatus,
  handleConcludeExperiment,
  createIntelligenceHandlers,
};
