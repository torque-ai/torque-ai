/**
 * Advanced handlers — Task Intelligence
 *
 * 26 handlers for caching, prioritization, failure prediction,
 * adaptive retry, A/B experiments, and intelligence analytics.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const db = require('../../database');
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

  const { task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'completed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not completed. Current status: ${task.status}`)
    };
  }

  const cacheEntry = db.cacheTaskResult(task, { ttl_hours });

  let output = `## Task Result Cached\n\n`;
  output += `**Cache ID:** ${cacheEntry.id}\n`;
  output += `**Content Hash:** ${cacheEntry.content_hash.substring(0, 16)}...\n`;
  output += `**Expires:** ${new Date(cacheEntry.expires_at).toLocaleString()}\n`;
  output += `**Confidence:** ${Math.round(cacheEntry.confidence_score * 100)}%\n`;

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
  const { task_description, working_directory, min_confidence, use_semantic } = args;

  const result = db.lookupCache(task_description, {
    working_directory,
    min_confidence: min_confidence || 0.7,
    use_semantic: use_semantic !== false
  });

  if (!result) {
    return {
      content: [{ type: 'text', text: `No cached result found for this task.\n\nTask: ${task_description.substring(0, 100)}...` }]
    };
  }

  let output = `## Cache Hit!\n\n`;
  output += `**Match Type:** ${result.match_type}\n`;
  output += `**Confidence:** ${Math.round(result.confidence * 100)}%\n`;
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
    const result = db.invalidateCache({ cacheId: cache_id });
    invalidated = result.deleted || 0;
  } else if (task_description) {
    const result = db.invalidateCache({ pattern: task_description });
    invalidated = result.deleted || 0;
  } else if (older_than_hours) {
    const cutoff = new Date(Date.now() - older_than_hours * 3600000).toISOString();
    const result = db.invalidateCache({ olderThan: cutoff });
    invalidated = result.deleted || 0;
  } else if (all_expired) {
    const result = db.invalidateCache();
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

  let stats = db.getCacheStats();

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
  if (config.default_ttl_hours !== undefined) db.setConfig('cache_ttl_hours', String(config.default_ttl_hours));
  if (config.max_entries !== undefined) db.setConfig('cache_max_entries', String(config.max_entries));
  if (config.min_confidence_threshold !== undefined) db.setConfig('cache_min_confidence', String(config.min_confidence_threshold));
  if (config.enable_semantic !== undefined) db.setConfig('cache_enable_semantic', String(config.enable_semantic));

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
  const { limit, min_exit_code } = args;

  const warmed = db.warmCache({
    limit: safeLimit(limit, 50),
    min_exit_code: min_exit_code || 0
  });

  let output = `## Cache Warmed\n\n`;
  output += `**Entries Added:** ${warmed.added}\n`;
  output += `**Already Cached:** ${warmed.skipped}\n`;
  output += `**Failed:** ${warmed.failed}\n`;

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
  const { task_id, recalculate } = args;

  const { task: _task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  const score = db.computePriorityScore(task_id, { recalculate });

  let output = `## Priority Score: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Final Score:** ${score.final_score.toFixed(2)}\n\n`;
  output += `### Components\n\n`;
  output += `| Factor | Score | Weight | Contribution |\n`;
  output += `|--------|-------|--------|-------------|\n`;
  output += `| Resource | ${score.resource_score.toFixed(2)} | ${(score.weights.resource * 100).toFixed(0)}% | ${(score.resource_score * score.weights.resource).toFixed(2)} |\n`;
  output += `| Success Rate | ${score.success_score.toFixed(2)} | ${(score.weights.success * 100).toFixed(0)}% | ${(score.success_score * score.weights.success).toFixed(2)} |\n`;
  output += `| Dependency | ${score.dependency_score.toFixed(2)} | ${(score.weights.dependency * 100).toFixed(0)}% | ${(score.dependency_score * score.weights.dependency).toFixed(2)} |\n`;

  if (score.manual_boost) {
    output += `\n**Manual Boost:** +${score.manual_boost}`;
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
  const { status, limit } = args;

  const queue = db.getPriorityQueue({
    status: status || 'queued',
    limit: safeLimit(limit, 20)
  });

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
    output += `| ${i + 1} | ${t.id.substring(0, 8)} | ${t.priority_score?.toFixed(2) || 'N/A'} | ${desc} |\n`;
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
  if (config.resource_weight !== undefined) db.setConfig('priority_resource_weight', String(config.resource_weight));
  if (config.success_weight !== undefined) db.setConfig('priority_success_weight', String(config.success_weight));
  if (config.dependency_weight !== undefined) db.setConfig('priority_dependency_weight', String(config.dependency_weight));

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

  const { task, error: taskErr } = requireTask(db, task_id);
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
  const { task_id, boost_amount, expires_in_minutes } = args;

  const { task: _task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  db.boostPriority(task_id, boost_amount, expires_in_minutes);

  const newScore = db.computePriorityScore(task_id, { recalculate: true });

  let output = `## Priority Boosted\n\n`;
  output += `**Task:** ${task_id.substring(0, 8)}...\n`;
  output += `**Boost:** +${boost_amount}\n`;
  output += `**New Score:** ${newScore.final_score.toFixed(2)}\n`;
  if (expires_in_minutes) {
    output += `**Expires:** ${expires_in_minutes} minutes\n`;
  }

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
    const { task, error: taskErr } = requireTask(db, task_id);
    if (taskErr) return taskErr;
    prediction = db.predictFailureForTask(task);
  } else if (task_description) {
    prediction = db.predictFailureForTask({
      task_description,
      working_directory
    });
  } else {
    return {
      ...makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide either task_id or task_description')
    };
  }

  let output = `## Failure Prediction\n\n`;
  output += `**Failure Probability:** ${Math.round(prediction.probability * 100)}%\n`;
  output += `**Risk Level:** ${prediction.risk_level}\n`;
  output += `**Confidence:** ${Math.round(prediction.confidence * 100)}%\n\n`;

  if (prediction.patterns && prediction.patterns.length > 0) {
    output += `### Matched Patterns\n\n`;
    for (const p of prediction.patterns) {
      output += `- **${p.pattern_type}**: ${p.description} (${Math.round(p.contribution * 100)}% contribution)\n`;
    }
  }

  if (prediction.recommendations && prediction.recommendations.length > 0) {
    output += `\n### Recommendations\n\n`;
    for (const r of prediction.recommendations) {
      output += `- ${r}\n`;
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

  const { task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  // Extract signature from task output
  const output = task.output || task.error_output || task.error || '';
  if (!output) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Task has no output to learn from');
  }

  // Create a signature based on the first distinctive pattern found
  const lines = output.split('\n').filter(l => l.trim());
  const signature = lines[0] ? lines[0].substring(0, 100) : 'empty output';

  db.learnFailurePattern(task_id, signature, name, description);

  return {
    content: [{
      type: 'text',
      text: `## Failure Pattern Learned\n\n- **Name:** ${name}\n- **Source Task:** ${task_id}\n- **Signature:** ${signature.substring(0, 50)}...\n- **Provider:** ${task.provider || 'unknown'}`
    }]
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
  const patterns = db.getFailurePatterns(provider, enabled_only);

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
    output += `| ${p.name} | ${p.provider || 'all'} | ${p.severity} | ${p.match_count} | ${p.enabled ? '✓' : '✗'} |\n`;
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
  const deleted = db.deleteFailurePattern(args.pattern_id);

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

  const { task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  const suggestions = db.suggestIntervention(task);

  let output = `## Intervention Suggestions: ${task_id.substring(0, 8)}...\n\n`;

  if (suggestions.length === 0) {
    output += `No interventions suggested. Task appears healthy.`;
  } else {
    output += `| # | Type | Suggestion | Impact |\n`;
    output += `|---|------|------------|--------|\n`;

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      output += `| ${i + 1} | ${s.type} | ${s.suggestion.substring(0, 40)}... | ${s.expected_impact} |\n`;
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

  const { task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  // Apply intervention based on type
  let result = { success: false, message: 'Unknown intervention type' };
  try {
    if (intervention_type === 'cancel') {
      db.updateTaskStatus(task_id, 'cancelled', { error_output: `Cancelled via intervention: ${JSON.stringify(parameters || {})}` });
      result = { success: true, message: 'Task cancelled' };
    } else if (intervention_type === 'requeue') {
      db.updateTaskStatus(task_id, 'queued', { pid: null, started_at: null });
      result = { success: true, message: 'Task requeued' };
    } else if (intervention_type === 'reprioritize' && parameters?.priority !== undefined) {
      db.updateTaskStatus(task_id, task.status, { priority: parameters.priority });
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
  const { time_range_hours, min_retries } = args;

  const analysis = db.analyzeRetryPatterns({
    time_range_hours: time_range_hours || 168, // 7 days default
    min_retries: min_retries || 2
  });

  let output = `## Retry Pattern Analysis\n\n`;
  output += `**Period:** Last ${time_range_hours || 168} hours\n\n`;

  output += `### Summary\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Total Tasks with Retries | ${analysis.total_tasks} |\n`;
  output += `| Total Retry Attempts | ${analysis.total_retries} |\n`;
  output += `| Success Rate After Retry | ${Math.round(analysis.success_rate * 100)}% |\n`;
  output += `| Avg Retries to Success | ${analysis.avg_retries_to_success?.toFixed(1) || 'N/A'} |\n`;

  if (analysis.by_error_type && Object.keys(analysis.by_error_type).length > 0) {
    output += `\n### By Error Type\n\n`;
    output += `| Error Type | Count | Success Rate |\n`;
    output += `|------------|-------|-------------|\n`;

    for (const [errorType, stats] of Object.entries(analysis.by_error_type)) {
      output += `| ${errorType} | ${stats.count} | ${Math.round(stats.success_rate * 100)}% |\n`;
    }
  }

  if (analysis.recommendations && analysis.recommendations.length > 0) {
    output += `\n### Recommendations\n\n`;
    for (const r of analysis.recommendations) {
      output += `- ${r}\n`;
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
    db.setConfig('adaptive_retry_enabled', enabled ? '1' : '0');
    updates.push(`enabled → ${enabled}`);
  }

  if (default_fallback) {
    db.setConfig('adaptive_retry_default_fallback', default_fallback);
    updates.push(`default_fallback → ${default_fallback}`);
  }

  if (max_retries_per_task !== undefined) {
    db.setConfig('adaptive_retry_max_per_task', max_retries_per_task.toString());
    updates.push(`max_retries_per_task → ${max_retries_per_task}`);
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

  const { task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  if (task.status !== 'failed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not failed. Status: ${task.status}`)
    };
  }

  const recommendation = db.getRetryRecommendation(task);

  let output = `## Retry Recommendation: ${task_id.substring(0, 8)}...\n\n`;
  output += `**Should Retry:** ${recommendation.should_retry ? 'Yes' : 'No'}\n`;
  output += `**Confidence:** ${Math.round(recommendation.confidence * 100)}%\n\n`;

  if (recommendation.should_retry) {
    output += `### Recommended Strategy\n\n`;
    output += `| Setting | Value |\n`;
    output += `|---------|-------|\n`;
    output += `| Strategy | ${recommendation.strategy} |\n`;
    output += `| Delay | ${recommendation.delay_seconds} seconds |\n`;
    output += `| Max Additional Retries | ${recommendation.max_retries} |\n`;

    if (recommendation.adaptations && recommendation.adaptations.length > 0) {
      output += `\n### Suggested Adaptations\n\n`;
      for (const a of recommendation.adaptations) {
        output += `- ${a}\n`;
      }
    }
  } else {
    output += `**Reason:** ${recommendation.reason}\n`;
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

  const { task, error: taskErr2 } = requireTask(db, task_id);
  if (taskErr2) return taskErr2;

  if (task.status !== 'failed') {
    return {
      ...makeError(ErrorCodes.INVALID_STATUS_TRANSITION, `Task is not failed. Status: ${task.status}`)
    };
  }

  // Get recommendation
  const recommendation = db.getRetryRecommendation(task);

  if (!recommendation.should_retry) {
    return {
      content: [{ type: 'text', text: `## Retry Not Recommended\n\n**Reason:** ${recommendation.reason}` }]
    };
  }

  // Apply adaptations if requested (log as analytics events)
  if (apply_recommendations && recommendation.adaptations) {
    for (const adaptation of recommendation.adaptations) {
      db.recordEvent('pre_retry_adaptation', task_id, { adaptation });
    }
  }

  // Reset task and update with strategy
  db.updateTaskStatus(task_id, 'pending', {
    retry_strategy: recommendation.strategy,
    retry_delay_seconds: recommendation.delay_seconds,
    output: null,
    error_output: null,
    exit_code: null
  });

  // Record retry attempt
  db.recordRetryAttempt(task_id, {
    attempt_number: (task.retry_count || 0) + 1,
    delay_used: recommendation.delay_seconds || 0,
    error_message: task.error_output?.substring(0, 500) || null,
    prompt_modification: apply_recommendations ? JSON.stringify(recommendation.adaptations) : null
  });

  // Start task
  const startResult = taskManager.startTask(task_id);

  let output = `## Adaptive Retry Started\n\n`;
  output += `**Task:** ${task_id.substring(0, 8)}...\n`;
  output += `**Strategy:** ${recommendation.strategy}\n`;
  output += `**Delay:** ${recommendation.delay_seconds} seconds\n`;
  output += `**Status:** ${startResult.queued ? 'Queued' : 'Running'}\n`;

  if (apply_recommendations && recommendation.adaptations) {
    output += `\n**Adaptations Applied:**\n`;
    for (const a of recommendation.adaptations) {
      output += `- ${a}\n`;
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

  const dashboard = db.getIntelligenceDashboard({
    time_range_hours: time_range_hours || 24
  });

  let output = `## Task Intelligence Dashboard\n\n`;
  output += `**Period:** Last ${time_range_hours || 24} hours\n\n`;

  output += `### Cache Performance\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Hit Rate | ${dashboard.cache.hit_rate ? Math.round(dashboard.cache.hit_rate * 100) + '%' : 'N/A'} |\n`;
  output += `| Total Lookups | ${dashboard.cache.total_lookups} |\n`;
  output += `| Time Saved | ${dashboard.cache.time_saved_minutes || 0} min |\n`;

  output += `\n### Prioritization\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Tasks Prioritized | ${dashboard.priority.tasks_prioritized} |\n`;
  output += `| Avg Wait Time | ${dashboard.priority.avg_wait_minutes?.toFixed(1) || 'N/A'} min |\n`;
  output += `| Queue Efficiency | ${dashboard.priority.queue_efficiency ? Math.round(dashboard.priority.queue_efficiency * 100) + '%' : 'N/A'} |\n`;

  output += `\n### Failure Prediction\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Predictions Made | ${dashboard.prediction.total_predictions} |\n`;
  output += `| Accuracy | ${dashboard.prediction.accuracy ? Math.round(dashboard.prediction.accuracy * 100) + '%' : 'N/A'} |\n`;
  output += `| Prevented Failures | ${dashboard.prediction.prevented_failures} |\n`;

  output += `\n### Adaptive Retries\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Total Retries | ${dashboard.retry.total_retries} |\n`;
  output += `| Success Rate | ${dashboard.retry.success_rate ? Math.round(dashboard.retry.success_rate * 100) + '%' : 'N/A'} |\n`;
  output += `| Avg Attempts | ${dashboard.retry.avg_attempts?.toFixed(1) || 'N/A'} |\n`;

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
  const { task_id, operation, outcome, details } = args;

  db.recordEvent('intelligence_outcome', task_id, {
    operation,
    outcome,
    details: typeof details === 'object' ? JSON.stringify(details) : details
  });

  return {
    content: [{ type: 'text', text: `## Outcome Logged\n\n**Task:** ${task_id?.substring(0, 8) || 'N/A'}\n**Operation:** ${operation}\n**Outcome:** ${outcome}` }]
  };
}


/**
 * Create an A/B experiment
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCreateExperiment(args) {
  const { name, description, strategy_a, strategy_b, sample_size } = args;

  if (!name || !strategy_a || !strategy_b) {
    return {
      ...makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Provide name, strategy_a, and strategy_b')
    };
  }

  const experiment = db.createExperiment({
    name,
    description,
    strategy_a,
    strategy_b,
    sample_size: sample_size || 100
  });

  let output = `## Experiment Created\n\n`;
  output += `**ID:** ${experiment.id}\n`;
  output += `**Name:** ${experiment.name}\n`;
  output += `**Strategy A:** ${experiment.strategy_a}\n`;
  output += `**Strategy B:** ${experiment.strategy_b}\n`;
  output += `**Sample Size:** ${experiment.sample_size}\n`;
  output += `**Status:** ${experiment.status}\n`;

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
  const experiment = db.getExperiment(args.experiment_id);

  if (!experiment) {
    return {
      ...makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Experiment not found: ${args.experiment_id}`)
    };
  }

  let output = `## Experiment: ${experiment.name}\n\n`;
  output += `**Status:** ${experiment.status}\n`;
  output += `**Progress:** ${experiment.samples_collected}/${experiment.sample_size}\n\n`;

  output += `### Strategy A: ${experiment.strategy_a}\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Samples | ${experiment.results_a?.count || 0} |\n`;
  output += `| Success Rate | ${experiment.results_a?.success_rate ? Math.round(experiment.results_a.success_rate * 100) + '%' : 'N/A'} |\n`;
  output += `| Avg Duration | ${experiment.results_a?.avg_duration?.toFixed(1) || 'N/A'} sec |\n`;

  output += `\n### Strategy B: ${experiment.strategy_b}\n\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Samples | ${experiment.results_b?.count || 0} |\n`;
  output += `| Success Rate | ${experiment.results_b?.success_rate ? Math.round(experiment.results_b.success_rate * 100) + '%' : 'N/A'} |\n`;
  output += `| Avg Duration | ${experiment.results_b?.avg_duration?.toFixed(1) || 'N/A'} sec |\n`;

  if (experiment.significance !== undefined) {
    output += `\n### Statistical Significance\n\n`;
    output += `**p-value:** ${experiment.significance.toFixed(4)}\n`;
    output += `**Significant:** ${experiment.significance < 0.05 ? 'Yes (p < 0.05)' : 'No'}\n`;

    if (experiment.significance < 0.05) {
      const winner = experiment.results_a?.success_rate > experiment.results_b?.success_rate ? 'A' : 'B';
      output += `**Recommended:** Strategy ${winner}\n`;
    }
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
  const { experiment_id, winner } = args;

  const experiment = db.getExperiment(experiment_id);
  if (!experiment) {
    return {
      ...makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Experiment not found: ${experiment_id}`)
    };
  }

  if (experiment.status === 'concluded') {
    return {
      content: [{ type: 'text', text: `Experiment already concluded. Winner: ${experiment.winner}` }]
    };
  }

  const result = db.concludeExperiment(experiment_id, winner);

  let output = `## Experiment Concluded\n\n`;
  output += `**Name:** ${experiment.name}\n`;
  output += `**Winner:** Strategy ${result.winner}\n`;
  output += `**Strategy:** ${result.winning_strategy}\n\n`;

  if (result.auto_applied) {
    output += `*Winning strategy has been automatically applied as the new default.*`;
  }

  return {
    content: [{ type: 'text', text: output }]
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
};
