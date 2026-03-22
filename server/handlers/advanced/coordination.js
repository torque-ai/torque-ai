/**
 * Advanced handlers — Multi-Agent Coordination
 *
 * 27 handlers for agent lifecycle, task claiming, routing/groups,
 * work stealing, failover, locks, rate limits, quotas, and coordination dashboard.
 * Extracted from advanced-handlers.js during Phase 7 handler decomposition.
 */

const crypto = require('crypto');
const { safeJsonParse } = require('../../db/event-tracking');
const coordinationDb = require('../../db/coordination');
const { getPrometheusMetrics, setRateLimit, setTaskQuota, getRoutingRules } = require('../../db/provider-routing-core');
const serverConfig = require('../../config');
const { validateObjectDepth, safeLimit, safeDate, requireTask, ErrorCodes, makeError } = require('../shared');


// Phase 1: Agent Lifecycle Handlers

/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleRegisterAgent(args) {
  const { name, capabilities, max_concurrent, agent_type, priority, metadata } = args;

  if (!name) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Agent name is required');
  }

  // Security: Validate metadata depth to prevent stack overflow
  if (metadata !== undefined) {
    const depthCheck = validateObjectDepth(metadata);
    if (!depthCheck.valid) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid metadata: ${depthCheck.error}`);
    }
  }

  const agent = coordinationDb.registerAgent({ id: crypto.randomUUID(), name, capabilities: capabilities || [], max_concurrent: max_concurrent || 1, agent_type: agent_type || 'worker', priority: priority || 0, metadata });

  let output = `## Agent Registered\n\n`;
  output += `**ID:** ${agent.id}\n`;
  output += `**Name:** ${agent.name}\n`;
  output += `**Type:** ${agent.agent_type}\n`;
  output += `**Status:** ${agent.status}\n`;
  output += `**Max Concurrent:** ${agent.max_concurrent}\n`;
  if (agent.capabilities && agent.capabilities.length > 0) {
    const caps = Array.isArray(agent.capabilities) ? agent.capabilities : safeJsonParse(agent.capabilities, []);
    output += `**Capabilities:** ${caps.join(', ')}\n`;
  }
  output += `**Registered At:** ${agent.registered_at}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleUnregisterAgent(args) {
  const { agent_id, reassign_tasks } = args;

  if (!agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Agent ID is required');
  }

  const agent = coordinationDb.getAgent(agent_id);
  if (!agent) {
    return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
  }

  const result = coordinationDb.unregisterAgent(agent_id, reassign_tasks !== false);

  let output = `## Agent Unregistered\n\n`;
  output += `**Agent:** ${agent.name} (${agent_id})\n`;
  if (result && result.tasks_reassigned > 0) {
    output += `**Tasks Reassigned:** ${result.tasks_reassigned}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAgentHeartbeat(args) {
  const { agent_id, current_load, status } = args;

  if (!agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Agent ID is required');
  }

  const agent = coordinationDb.getAgent(agent_id);
  if (!agent) {
    return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
  }

  coordinationDb.updateAgentHeartbeat(agent_id, current_load, status);

  return {
    content: [{ type: 'text', text: `Heartbeat recorded for agent ${agent.name}` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListAgents(args) {
  const { status, group_id, capability, limit } = args;

  const agents = coordinationDb.listAgents({ status, group_id, capability, limit: safeLimit(limit, 50) });

  if (agents.length === 0) {
    return {
      content: [{ type: 'text', text: 'No agents found matching criteria' }]
    };
  }

  let output = `## Registered Agents (${agents.length})\n\n`;
  output += `| Name | Type | Status | Load | Capabilities |\n`;
  output += `|------|------|--------|------|---------------|\n`;

  for (const agent of agents) {
    const caps = Array.isArray(agent.capabilities) ? agent.capabilities : safeJsonParse(agent.capabilities, []);
    const capList = caps.length > 0 ? caps.slice(0, 3).join(', ') + (caps.length > 3 ? '...' : '') : '-';
    output += `| ${agent.name} | ${agent.agent_type} | ${agent.status} | ${agent.current_load}/${agent.max_concurrent} | ${capList} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetAgent(args) {
  const { agent_id, include_metrics } = args;

  if (!agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Agent ID is required');
  }

  const agent = coordinationDb.getAgent(agent_id, include_metrics);
  if (!agent) {
    return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
  }

  let output = `## Agent Details\n\n`;
  output += `**ID:** ${agent.id}\n`;
  output += `**Name:** ${agent.name}\n`;
  output += `**Type:** ${agent.agent_type}\n`;
  output += `**Status:** ${agent.status}\n`;
  output += `**Load:** ${agent.current_load}/${agent.max_concurrent}\n`;
  output += `**Priority:** ${agent.priority}\n`;

  if (agent.capabilities) {
    const caps = Array.isArray(agent.capabilities) ? agent.capabilities : safeJsonParse(agent.capabilities, []);
    output += `**Capabilities:** ${caps.join(', ') || 'none'}\n`;
  }

  output += `**Last Heartbeat:** ${agent.last_heartbeat_at || 'never'}\n`;
  output += `**Registered:** ${agent.registered_at}\n`;

  if (agent.metadata) {
    output += `**Metadata:** ${agent.metadata}\n`;
  }

  if (include_metrics && agent.metrics) {
    output += `\n### Recent Metrics\n\n`;
    for (const metric of agent.metrics) {
      output += `- ${metric.metric_type}: ${metric.metric_value}\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleUpdateAgent(args) {
  const { agent_id, capabilities, max_concurrent, priority, status } = args;

  if (!agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Agent ID is required');
  }

  const agent = coordinationDb.getAgent(agent_id);
  if (!agent) {
    return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
  }

  const updates = {};
  if (capabilities !== undefined) updates.capabilities = capabilities;
  if (max_concurrent !== undefined) updates.max_concurrent = max_concurrent;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) updates.status = status;

  coordinationDb.updateAgent(agent_id, updates);

  return {
    content: [{ type: 'text', text: `Agent ${agent.name} updated successfully` }]
  };
}


// Phase 2: Task Claiming Handlers

/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleClaimTask(args) {
  const { task_id, agent_id, lease_seconds } = args;

  if (!task_id || !agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id and agent_id are required');
  }

  const { task: _task, error: taskErr } = requireTask(db, task_id);
  if (taskErr) return taskErr;

  const agent = coordinationDb.getAgent(agent_id);
  if (!agent) {
    return makeError(ErrorCodes.AGENT_NOT_FOUND, `Agent not found: ${agent_id}`);
  }

  const result = coordinationDb.claimTask(task_id, agent_id, lease_seconds || 300);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to claim task: ${result.error}`);
  }

  let output = `## Task Claimed\n\n`;
  output += `**Claim ID:** ${result.claim_id}\n`;
  output += `**Task:** ${task_id}\n`;
  output += `**Agent:** ${agent.name}\n`;
  output += `**Lease Expires:** ${result.lease_expires_at}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleRenewLease(args) {
  const { claim_id, extend_seconds } = args;

  if (!claim_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'claim_id is required');
  }

  const result = coordinationDb.renewLease(claim_id, extend_seconds || 300);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to renew lease: ${result.error}`);
  }

  return {
    content: [{ type: 'text', text: `Lease renewed. New expiry: ${result.new_expires_at}. Renewals: ${result.renewals}` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleReleaseTask(args) {
  const { claim_id, reason, final_status } = args;

  if (!claim_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'claim_id is required');
  }

  const result = coordinationDb.releaseTaskClaim(claim_id, reason || 'released', final_status);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to release task: ${result.error}`);
  }

  return {
    content: [{ type: 'text', text: `Task claim released. Reason: ${reason || 'released'}` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetClaim(args) {
  const { task_id, claim_id } = args;

  if (!task_id && !claim_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id or claim_id is required');
  }

  const claim = coordinationDb.getClaim(task_id || claim_id);

  if (!claim) {
    return {
      content: [{ type: 'text', text: 'No claim found' }]
    };
  }

  let output = `## Claim Details\n\n`;
  output += `**Claim ID:** ${claim.id}\n`;
  output += `**Task ID:** ${claim.task_id}\n`;
  output += `**Agent ID:** ${claim.agent_id}\n`;
  output += `**Status:** ${claim.status}\n`;
  output += `**Claimed At:** ${claim.claimed_at}\n`;
  output += `**Lease Expires:** ${claim.lease_expires_at}\n`;
  output += `**Renewals:** ${claim.renewals}\n`;

  if (claim.released_at) {
    output += `**Released At:** ${claim.released_at}\n`;
    output += `**Release Reason:** ${claim.release_reason}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListClaims(args) {
  const { agent_id, status, include_expired, limit } = args;

  const claims = coordinationDb.listClaims({ agent_id, status, include_expired, limit: safeLimit(limit, 50) });

  if (claims.length === 0) {
    return {
      content: [{ type: 'text', text: 'No claims found matching criteria' }]
    };
  }

  let output = `## Task Claims (${claims.length})\n\n`;
  output += `| Task ID | Agent | Status | Expires | Renewals |\n`;
  output += `|---------|-------|--------|---------|----------|\n`;

  for (const claim of claims) {
    const taskId = (claim.task_id || '').substring(0, 8) + '...';
    output += `| ${taskId} | ${(claim.agent_id || '').substring(0, 8)}... | ${claim.status} | ${claim.lease_expires_at} | ${claim.renewals} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


// Phase 3: Routing & Groups Handlers

/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCreateAgentGroup(args) {
  const { name, description, routing_strategy, max_agents } = args;

  if (!name) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Group name is required');
  }

  const group = coordinationDb.createAgentGroup({ name, description, routing_strategy: routing_strategy || 'round_robin', max_agents });

  let output = `## Agent Group Created\n\n`;
  output += `**ID:** ${group.id}\n`;
  output += `**Name:** ${group.name}\n`;
  output += `**Routing Strategy:** ${group.routing_strategy}\n`;
  if (max_agents) {
    output += `**Max Agents:** ${max_agents}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAddToGroup(args) {
  const { agent_id, group_id } = args;

  if (!agent_id || !group_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'agent_id and group_id are required');
  }

  const result = coordinationDb.addAgentToGroup(agent_id, group_id);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to add to group: ${result.error}`);
  }

  return {
    content: [{ type: 'text', text: `Agent added to group successfully` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleRemoveFromGroup(args) {
  const { agent_id, group_id } = args;

  if (!agent_id || !group_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'agent_id and group_id are required');
  }

  coordinationDb.removeAgentFromGroup(agent_id, group_id);

  return {
    content: [{ type: 'text', text: `Agent removed from group successfully` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCreateRoutingRule(args) {
  const { name, priority, condition_type, condition_value, target_type, target_value } = args;

  if (!name || !condition_type || !condition_value || !target_type || !target_value) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name, condition_type, condition_value, target_type, and target_value are required');
  }

  const rule = coordinationDb.createRoutingRule({ name, priority: priority || 0, condition_type, condition_value, target_type, target_value });

  let output = `## Routing Rule Created\n\n`;
  output += `**ID:** ${rule.id}\n`;
  output += `**Name:** ${rule.name}\n`;
  output += `**Priority:** ${rule.priority}\n`;
  output += `**Condition:** ${condition_type} = "${condition_value}"\n`;
  output += `**Target:** ${target_type} = "${target_value}"\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List all routing rules
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListRoutingRules(args) {
  const { enabled_only, rule_type } = args;

  const options = {};
  if (enabled_only) options.enabled = true;
  if (rule_type) options.rule_type = rule_type;

  const rules = getRoutingRules(options);

  if (rules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Routing Rules Found\n\nNo routing rules match your criteria. Use \`add_routing_rule\` to create rules.`
      }]
    };
  }

  // Group rules by target provider
  const byProvider = {};
  for (const rule of rules) {
    if (!byProvider[rule.target_provider]) {
      byProvider[rule.target_provider] = [];
    }
    byProvider[rule.target_provider].push(rule);
  }

  let output = `## Smart Routing Rules\n\n`;
  output += `**Total:** ${rules.length} rule(s)\n\n`;

  // Show smart routing config
  const smartEnabled = serverConfig.isOptIn('smart_routing_enabled');
  const defaultProvider = serverConfig.get('smart_routing_default_provider') || 'hashline-ollama';
  output += `**Smart Routing:** ${smartEnabled ? 'Enabled' : 'Disabled'}\n`;
  output += `**Default Provider:** ${defaultProvider}\n\n`;

  output += `| Priority | Name | Type | Pattern | Provider | Enabled |\n`;
  output += `|----------|------|------|---------|----------|---------|\n`;

  for (const rule of rules) {
    const pattern = rule.pattern.length > 30 ? rule.pattern.substring(0, 27) + '...' : rule.pattern;
    output += `| ${rule.priority} | ${rule.name} | ${rule.rule_type} | \`${pattern}\` | ${rule.target_provider} | ${rule.enabled ? '✓' : '✗'} |\n`;
  }

  output += `\n### Rules by Provider\n\n`;
  for (const [provider, providerRules] of Object.entries(byProvider)) {
    output += `**${provider}:** ${providerRules.length} rule(s)\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List agent-level routing rules from the task_routing_rules table.
 * Distinct from list_routing_rules which returns provider-level smart routing rules.
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleListAgentRoutingRules(args) {
  const { enabled_only, target_type } = args;

  const options = {};
  if (enabled_only !== undefined) options.enabled = enabled_only;
  if (target_type) options.target_type = target_type;

  const rules = coordinationDb.listRoutingRules(options);

  if (rules.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Agent Routing Rules Found\n\nNo agent routing rules match your criteria. Use \`create_routing_rule\` to create rules.`
      }]
    };
  }

  let output = `## Agent Routing Rules (${rules.length})\n\n`;
  output += `| Priority | Name | Condition | Target | Enabled |\n`;
  output += `|----------|------|-----------|--------|---------|\n`;

  for (const rule of rules) {
    const condVal = (rule.condition_value || '').length > 30
      ? rule.condition_value.substring(0, 27) + '...'
      : (rule.condition_value || '');
    output += `| ${rule.priority} | ${rule.name} | ${rule.condition_type}="${condVal}" | ${rule.target_type}="${rule.target_value}" | ${rule.enabled ? 'yes' : 'no'} |\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Delete an agent-level routing rule from the task_routing_rules table.
 * Distinct from delete_routing_rule which removes provider-level smart routing rules.
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleDeleteAgentRoutingRule(args) {
  const { rule_id } = args;

  if (!rule_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'rule_id is required');
  }

  const deleted = coordinationDb.deleteRoutingRule(rule_id);

  if (!deleted) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Agent routing rule not found: ${rule_id}`);
  }

  return {
    content: [{ type: 'text', text: `## Agent Routing Rule Deleted\n\nSuccessfully deleted rule: **${rule_id}**` }]
  };
}


// Phase 4: Work Stealing & Failover Handlers

/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleStealTask(args) {
  const { task_id, thief_agent_id, reason } = args;

  if (!task_id || !thief_agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id and thief_agent_id are required');
  }

  const result = coordinationDb.stealTask(task_id, thief_agent_id, reason || 'manual');

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to steal task: ${result.error}`);
  }

  let output = `## Task Stolen\n\n`;
  output += `**Task ID:** ${task_id}\n`;
  output += `**From Agent:** ${result.victim_agent_id}\n`;
  output += `**To Agent:** ${thief_agent_id}\n`;
  output += `**Reason:** ${reason || 'manual'}\n`;
  output += `**New Claim ID:** ${result.new_claim_id}\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleTriggerFailover(args) {
  const { agent_id, reassign_to } = args;

  if (!agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'agent_id is required');
  }

  const result = coordinationDb.triggerFailover(agent_id, reassign_to);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failover failed: ${result.error}`);
  }

  let output = `## Failover Triggered\n\n`;
  output += `**Agent:** ${agent_id}\n`;
  output += `**Tasks Released:** ${result.tasks_released}\n`;
  if (result.tasks_reassigned > 0) {
    output += `**Tasks Reassigned:** ${result.tasks_reassigned}\n`;
    output += `**Reassigned To:** ${reassign_to}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleGetStealingHistory(args) {
  const { victim_agent_id, thief_agent_id, since, limit } = args;

  const history = coordinationDb.getStealingHistory({ victim_agent_id, thief_agent_id, since: safeDate(since), limit: safeLimit(limit, 50) });

  if (history.length === 0) {
    return {
      content: [{ type: 'text', text: 'No work stealing history found' }]
    };
  }

  let output = `## Work Stealing History (${history.length})\n\n`;
  output += `| Task | Victim | Thief | Reason | Time |\n`;
  output += `|------|--------|-------|--------|------|\n`;

  for (const entry of history) {
    const taskId = (entry.task_id || '').substring(0, 8) + '...';
    output += `| ${taskId} | ${(entry.victim_agent_id || '').substring(0, 8)}... | ${(entry.thief_agent_id || '').substring(0, 8)}... | ${entry.reason} | ${entry.stolen_at} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleConfigureFailover(args) {
  const {
    heartbeat_interval_seconds,
    offline_threshold_missed,
    default_lease_seconds,
    auto_failover_enabled,
    rebalance_threshold_percent
  } = args;

  const updates = {};
  if (heartbeat_interval_seconds !== undefined) updates.heartbeat_interval_seconds = heartbeat_interval_seconds;
  if (offline_threshold_missed !== undefined) updates.offline_threshold_missed = offline_threshold_missed;
  if (default_lease_seconds !== undefined) updates.default_lease_seconds = default_lease_seconds;
  if (auto_failover_enabled !== undefined) updates.auto_failover_enabled = auto_failover_enabled ? 1 : 0;
  if (rebalance_threshold_percent !== undefined) updates.rebalance_threshold_percent = rebalance_threshold_percent;

  if (Object.keys(updates).length === 0) {
    // Return current config
    const config = coordinationDb.getFailoverConfig();
    let output = `## Current Failover Configuration\n\n`;
    for (const [key, value] of Object.entries(config)) {
      output += `**${key}:** ${value}\n`;
    }
    return {
      content: [{ type: 'text', text: output }]
    };
  }

  coordinationDb.updateFailoverConfig(updates);

  return {
    content: [{ type: 'text', text: `Failover configuration updated: ${Object.keys(updates).join(', ')}` }]
  };
}


// Phase 5: Coordination & Analytics Handlers

/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleAcquireLock(args) {
  const { lock_name, agent_id, ttl_seconds } = args;

  if (!lock_name || !agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'lock_name and agent_id are required');
  }

  const result = coordinationDb.acquireLock(lock_name, agent_id, ttl_seconds || 60);

  if (!result.acquired) {
    return {
      content: [{ type: 'text', text: `Lock "${lock_name}" is held by agent ${result.held_by}. Expires: ${result.expires_at}` }]
    };
  }

  return {
    content: [{ type: 'text', text: `Lock "${lock_name}" acquired. Expires: ${result.expires_at}` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleReleaseLock(args) {
  const { lock_name, agent_id } = args;

  if (!lock_name || !agent_id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'lock_name and agent_id are required');
  }

  const result = coordinationDb.releaseLock(lock_name, agent_id);

  if (result.error) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to release lock: ${result.error}`);
  }
  if (result.released === false) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to release lock: ${result.reason || 'lock not held by this agent'}`);
  }

  return {
    content: [{ type: 'text', text: `Lock "${lock_name}" released` }]
  };
}


/**
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleCoordinationDashboard(args) {
  const { time_range_hours } = args;

  const dashboard = coordinationDb.getCoordinationDashboard(time_range_hours || 24);

  let output = `## Multi-Agent Coordination Dashboard\n\n`;
  output += `### Agent Summary\n\n`;
  output += `| Status | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Online | ${dashboard.agents?.online || 0} |\n`;
  output += `| Offline | ${dashboard.agents?.offline || 0} |\n`;
  output += `| Busy | ${dashboard.agents?.busy || 0} |\n`;
  output += `| Draining | ${dashboard.agents?.draining || 0} |\n`;
  output += `\n**Total Agents:** ${dashboard.agents?.total_agents || 0}\n`;

  output += `\n### Claims Summary\n\n`;
  output += `| Status | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Active | ${dashboard.claims?.active || 0} |\n`;
  output += `| Released | ${dashboard.claims?.released || 0} |\n`;
  output += `| Expired | ${dashboard.claims?.expired || 0} |\n`;
  output += `| Stolen | ${dashboard.claims?.stolen || 0} |\n`;

  output += `\n### Activity (Last ${time_range_hours || 24}h)\n\n`;
  const eventCount = Object.values(dashboard.events || {}).reduce((a, b) => a + b, 0);
  output += `- **Coordination Events:** ${eventCount}\n`;
  output += `- **Work Steals:** ${dashboard.stealing?.total_steals || 0}\n`;
  output += `- **Active Locks:** ${dashboard.locks?.active_locks || 0}\n`;

  if (dashboard.load_distribution && dashboard.load_distribution.length > 0) {
    output += `\n### Top Agents by Load\n\n`;
    output += `| Agent | Load | Load % |\n`;
    output += `|-------|------|--------|\n`;
    for (const agent of dashboard.load_distribution.slice(0, 5)) {
      output += `| ${agent.name} | ${agent.current_load}/${agent.max_concurrent} | ${agent.load_percent}% |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Export metrics in Prometheus format
 *
 * @param {Object} _args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleExportMetricsPrometheus(_args) {
  const metrics = getPrometheusMetrics();

  return {
    content: [{
      type: 'text',
      text: `# HELP codexbridge_tasks_total Total tasks by status\n# TYPE codexbridge_tasks_total gauge\n${metrics}`
    }]
  };
}


/**
 * Configure rate limiting
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleRateLimitTasks(args) {
  const { project_id, limit_type, max_value, window_seconds } = args;

  // Input validation
  if (!limit_type || !['tasks_per_minute', 'tasks_per_hour', 'concurrent'].includes(limit_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'limit_type must be "tasks_per_minute", "tasks_per_hour", or "concurrent"');
  }
  if (typeof max_value !== 'number' || max_value <= 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'max_value must be a positive number');
  }

  // Calculate window seconds based on limit type if not provided
  let windowSecs = window_seconds;
  if (!windowSecs) {
    switch (limit_type) {
      case 'tasks_per_minute': windowSecs = 60; break;
      case 'tasks_per_hour': windowSecs = 3600; break;
      case 'concurrent': windowSecs = 0; break;
    }
  }

  const rateLimit = setRateLimit({
    id: `${project_id || 'global'}_${limit_type}`,
    project_id,
    limit_type,
    max_value,
    window_seconds: windowSecs
  });

  let output = `## Rate Limit Configured\n\n`;
  output += `**ID:** \`${rateLimit.id}\`\n`;
  output += `**Project:** ${project_id || 'Global'}\n`;
  output += `**Type:** ${limit_type}\n`;
  output += `**Max Value:** ${max_value}\n`;
  if (windowSecs > 0) {
    output += `**Window:** ${windowSecs} seconds\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Configure task quotas
 *
 * @param {Object} args - Handler arguments.
 * @returns {Object} MCP response payload.
 */
function handleTaskQuotas(args) {
  const { project_id, quota_type, max_value, reset_period } = args;

  // Input validation
  if (!quota_type || !['daily_tasks', 'weekly_tasks', 'monthly_tasks', 'daily_tokens', 'monthly_cost'].includes(quota_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'quota_type must be "daily_tasks", "weekly_tasks", "monthly_tasks", "daily_tokens", or "monthly_cost"');
  }
  if (typeof max_value !== 'number' || max_value <= 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'max_value must be a positive number');
  }

  // Infer reset period from quota type if not provided
  let period = reset_period;
  if (!period) {
    if (quota_type.includes('daily')) period = 'daily';
    else if (quota_type.includes('weekly')) period = 'weekly';
    else if (quota_type.includes('monthly')) period = 'monthly';
  }

  const quota = setTaskQuota({
    id: `${project_id || 'global'}_${quota_type}`,
    project_id,
    quota_type,
    max_value,
    reset_period: period
  });

  let output = `## Task Quota Configured\n\n`;
  output += `**ID:** \`${quota.id}\`\n`;
  output += `**Project:** ${project_id || 'Global'}\n`;
  output += `**Type:** ${quota_type}\n`;
  output += `**Max Value:** ${max_value}\n`;
  output += `**Reset Period:** ${period}\n`;

  return { content: [{ type: 'text', text: output }] };
}


function createCoordinationHandlers() {
  return {
    handleRegisterAgent,
    handleUnregisterAgent,
    handleAgentHeartbeat,
    handleListAgents,
    handleGetAgent,
    handleUpdateAgent,
    handleClaimTask,
    handleRenewLease,
    handleReleaseTask,
    handleGetClaim,
    handleListClaims,
    handleCreateAgentGroup,
    handleAddToGroup,
    handleRemoveFromGroup,
    handleCreateRoutingRule,
    handleListRoutingRules,
    handleListAgentRoutingRules,
    handleDeleteAgentRoutingRule,
    handleStealTask,
    handleTriggerFailover,
    handleGetStealingHistory,
    handleConfigureFailover,
    handleAcquireLock,
    handleReleaseLock,
    handleCoordinationDashboard,
    handleExportMetricsPrometheus,
    handleRateLimitTasks,
    handleTaskQuotas,
  };
}

module.exports = {
  handleRegisterAgent,
  handleUnregisterAgent,
  handleAgentHeartbeat,
  handleListAgents,
  handleGetAgent,
  handleUpdateAgent,
  handleClaimTask,
  handleRenewLease,
  handleReleaseTask,
  handleGetClaim,
  handleListClaims,
  handleCreateAgentGroup,
  handleAddToGroup,
  handleRemoveFromGroup,
  handleCreateRoutingRule,
  handleListRoutingRules,
  handleListAgentRoutingRules,
  handleDeleteAgentRoutingRule,
  handleStealTask,
  handleTriggerFailover,
  handleGetStealingHistory,
  handleConfigureFailover,
  handleAcquireLock,
  handleReleaseLock,
  handleCoordinationDashboard,
  handleExportMetricsPrometheus,
  handleRateLimitTasks,
  handleTaskQuotas,
  createCoordinationHandlers,
};
