'use strict';

/**
 * Coordination Module
 *
 * Extracted from database.js — multi-agent coordination, task claiming,
 * agent groups, routing, failover, and distributed locking.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const crypto = require('crypto');
const logger = require('../logger').child({ component: 'coordination' });
const { safeJsonParse } = require('../utils/json');
const eventBus = require('../event-bus');

let db;
let getTaskFn;

function emitQueueChanged() {
  eventBus.emitQueueChanged();
}

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { getTaskFn = fn; }


// ============================================
// Phase 1: Agent Lifecycle
// ============================================

/**
 * Register a new agent
 * @param {any} options
 * @returns {any}
 */
function registerAgent({ id, name, capabilities, max_concurrent, agent_type, priority, metadata }) {
  const agentId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, agent_type, status, capabilities, max_concurrent, priority, metadata, last_heartbeat_at, registered_at)
    VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    agentId,
    name,
    agent_type || 'worker',
    capabilities ? JSON.stringify(capabilities) : null,
    max_concurrent || 1,
    priority || 0,
    metadata ? JSON.stringify(metadata) : null,
    now,
    now
  );

  recordCoordinationEvent('agent_joined', agentId, null, JSON.stringify({ name, capabilities }));

  return getAgent(agentId);
}

/**
 * Unregister an agent.
 *
 * The multi-table delete is wrapped in a transaction so the agent row and all
 * FK-dependent rows (task_claims, agent_metrics, work_stealing_log,
 * coordination_events, agent_group_members) are removed atomically.
 * Without a transaction, a crash between deletes would leave orphaned rows
 * referencing a non-existent agent, violating referential integrity.
 *
 * @param {any} agentId
 * @param {any} reassignTasks
 * @returns {any}
 */
function unregisterAgent(agentId, reassignTasks = true) {
  const agent = getAgent(agentId);
  if (!agent) return null;

  // If reassigning, release all active claims (each releaseTaskClaim is already
  // transactional internally, so do this outside the deletion transaction).
  if (reassignTasks) {
    const claims = db.prepare(`
      SELECT * FROM task_claims WHERE agent_id = ? AND status = 'active'
    `).all(agentId);

    for (const claim of claims) {
      releaseTaskClaim(claim.id, 'agent_unregistered');
    }
  }

  // Record the event BEFORE deleting the agent row, otherwise the FK
  // constraint on coordination_events.agent_id would be violated.
  recordCoordinationEvent('agent_left', agentId, null, JSON.stringify({ name: agent.name }));

  // Delete all FK-dependent rows atomically before removing the agent row.
  // Keep coordination_events for audit trail.
  db.transaction(() => {
    db.prepare('DELETE FROM task_claims WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agent_metrics WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM work_stealing_log WHERE victim_agent_id = ? OR thief_agent_id = ?').run(agentId, agentId);
    db.prepare('DELETE FROM agent_group_members WHERE agent_id = ?').run(agentId);
    // Nullify agent_id in coordination_events to preserve audit trail
    db.prepare('UPDATE coordination_events SET agent_id = NULL WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  })();

  return agent;
}

/**
 * Update agent heartbeat
 * @param {any} agentId
 * @param {any} currentLoad
 * @param {any} status
 * @returns {any}
 */
function updateAgentHeartbeat(agentId, currentLoad, status) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE agents
    SET last_heartbeat_at = ?,
        current_load = COALESCE(?, current_load),
        status = COALESCE(?, status)
    WHERE id = ?
  `);

  const result = stmt.run(now, currentLoad, status, agentId);
  return result.changes > 0;
}

/**
 * Get agent by ID
 */
function getAgent(agentId, includeMetrics = false) {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) return null;

  agent.capabilities = safeJsonParse(agent.capabilities, []);
  agent.metadata = safeJsonParse(agent.metadata, null);

  // Get groups
  agent.groups = db.prepare(`
    SELECT g.* FROM agent_groups g
    JOIN agent_group_members m ON g.id = m.group_id
    WHERE m.agent_id = ?
  `).all(agentId);

  // Get active claims count
  agent.active_claims = db.prepare(`
    SELECT COUNT(*) as count FROM task_claims
    WHERE agent_id = ? AND status = 'active'
  `).get(agentId).count;

  if (includeMetrics) {
    agent.metrics = db.prepare(`
      SELECT metric_type, metric_value, recorded_at
      FROM agent_metrics
      WHERE agent_id = ?
      ORDER BY recorded_at DESC
      LIMIT 100
    `).all(agentId);
  }

  return agent;
}

/**
 * List agents with filters
 * @param {any} options
 * @returns {any}
 */
function listAgents({ status, group_id, capability, limit = 50 } = {}) {
  let query;
  const params = [];

  if (group_id) {
    // Join against agent_group_members in SQL so LIMIT applies after the
    // group filter, not before (the previous post-query JS filter missed
    // members beyond the first `limit` rows).
    query = `SELECT a.* FROM agents a
      INNER JOIN agent_group_members agm ON agm.agent_id = a.id
      WHERE agm.group_id = ?`;
    params.push(group_id);
  } else {
    query = 'SELECT a.* FROM agents a WHERE 1=1';
  }

  if (status) {
    query += ' AND a.status = ?';
    params.push(status);
  }

  if (capability) {
    query += " AND a.capabilities LIKE ? ESCAPE '\\'";
    params.push(`%"${capability.replace(/[\\%_]/g, '\\$&')}"%`);
  }

  query += ' ORDER BY a.priority DESC, a.registered_at ASC LIMIT ?';
  params.push(limit);

  const agents = db.prepare(query).all(...params);

  for (const agent of agents) {
    if (!agent) continue;
    agent.capabilities = safeJsonParse(agent.capabilities, []);
    agent.metadata = safeJsonParse(agent.metadata, null);
  }

  return agents;
}

/**
 * Update agent properties
 * @param {any} agentId
 * @param {any} updates
 * @returns {any}
 */
function updateAgent(agentId, updates) {
  const allowed = ['name', 'capabilities', 'max_concurrent', 'priority', 'metadata', 'status'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      if (key === 'capabilities' || key === 'metadata') {
        params.push(value ? JSON.stringify(value) : null);
      } else {
        params.push(value);
      }
    }
  }

  if (sets.length === 0) return getAgent(agentId);

  params.push(agentId);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return getAgent(agentId);
}

/**
 * Check for offline agents (missed heartbeats)
 */
function checkOfflineAgents() {
  const config = getFailoverConfig();
  const interval = parseInt(config.heartbeat_interval_seconds, 10) || 30;
  const missedThreshold = parseInt(config.offline_threshold_missed, 10) || 3;
  const threshold = interval * missedThreshold;
  const cutoff = new Date(Date.now() - threshold * 1000).toISOString();

  const offlineAgents = db.prepare(`
    SELECT * FROM agents
    WHERE status = 'online'
    AND last_heartbeat_at < ?
  `).all(cutoff);

  for (const agent of offlineAgents) {
    db.prepare(`
      UPDATE agents SET status = 'offline', disconnected_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), agent.id);

    recordCoordinationEvent('agent_offline', agent.id, null, JSON.stringify({
      last_heartbeat: agent.last_heartbeat_at
    }));
  }

  return offlineAgents;
}

/**
 * Record coordination event
 * @param {any} eventType
 * @param {any} agentId
 * @param {any} taskId
 * @param {any} details
 * @returns {any}
 */
function recordCoordinationEvent(eventType, agentId, taskId, details) {
  const stmt = db.prepare(`
    INSERT INTO coordination_events (event_type, agent_id, task_id, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(eventType, agentId, taskId, details, new Date().toISOString());
}

function createTaskClaim(taskId, agentId, leaseSeconds = 300, claimedAt = new Date()) {
  const requestedLeaseSeconds = Number(leaseSeconds);
  const effectiveLeaseSeconds = Number.isFinite(requestedLeaseSeconds) && requestedLeaseSeconds > 0
    ? requestedLeaseSeconds
    : 300;
  const now = claimedAt instanceof Date ? claimedAt : new Date(claimedAt);
  const claimedAtIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + effectiveLeaseSeconds * 1000).toISOString();
  const claimId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO task_claims (id, task_id, agent_id, status, lease_expires_at, lease_duration_seconds, claimed_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(claimId, taskId, agentId, expiresAt, effectiveLeaseSeconds, claimedAtIso);

  db.prepare(`UPDATE tasks SET claimed_by_agent = ? WHERE id = ?`).run(agentId, taskId);

  db.prepare(`UPDATE agents SET current_load = current_load + 1 WHERE id = ?`).run(agentId);

  recordCoordinationEvent('task_claimed', agentId, taskId, JSON.stringify({ lease_seconds: effectiveLeaseSeconds }));

  return {
    id: claimId,
    task_id: taskId,
    agent_id: agentId,
    lease_expires_at: expiresAt,
    lease_duration_seconds: effectiveLeaseSeconds
  };
}

// ============================================
// Phase 2: Task Claiming
// ============================================

/**
 * Claim a task with a lease
 */
function claimTask(taskId, agentId, leaseSeconds = 300) {
  const task = getTaskFn(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Use IMMEDIATE transaction to prevent TOCTOU double-claim race:
  // DEFERRED (the default) only acquires a write lock on the first write,
  // so two concurrent callers can both pass the existence check before
  // either inserts. IMMEDIATE acquires the write lock upfront.
  return db.transaction(() => {
    // Check if task is already claimed
    const existingClaim = db.prepare(`
      SELECT * FROM task_claims WHERE task_id = ? AND status = 'active'
    `).get(taskId);

    if (existingClaim) {
      // Check if lease expired
      if (new Date(existingClaim.lease_expires_at) > new Date()) {
        throw new Error(`Task already claimed by agent: ${existingClaim.agent_id}`);
      }
      // Expire the old claim
      db.prepare(`UPDATE task_claims SET status = 'expired' WHERE id = ?`).run(existingClaim.id);
    }

    return createTaskClaim(taskId, agentId, leaseSeconds);
  }).immediate();
}

/**
 * Renew a lease
 * @param {any} claimId
 * @param {any} extendSeconds
 * @returns {any}
 */
function renewLease(claimId, extendSeconds) {
  const claim = db.prepare('SELECT * FROM task_claims WHERE id = ?').get(claimId);
  if (!claim) {
    throw new Error(`Claim not found: ${claimId}`);
  }

  if (claim.status !== 'active') {
    throw new Error(`Claim is not active: ${claim.status}`);
  }

  const duration = extendSeconds || claim.lease_duration_seconds;
  const newExpiry = new Date(Date.now() + duration * 1000).toISOString();

  db.prepare(`
    UPDATE task_claims
    SET lease_expires_at = ?, renewals = renewals + 1
    WHERE id = ?
  `).run(newExpiry, claimId);

  recordCoordinationEvent('lease_renewed', claim.agent_id, claim.task_id, JSON.stringify({
    new_expiry: newExpiry,
    renewals: claim.renewals + 1
  }));

  return {
    ...claim,
    lease_expires_at: newExpiry,
    renewals: claim.renewals + 1
  };
}

/**
 * Release a task claim
 * @param {any} claimId
 * @param {any} reason
 * @returns {any}
 */
function releaseTaskClaim(claimId, reason) {
  const claim = db.prepare('SELECT * FROM task_claims WHERE id = ?').get(claimId);
  if (!claim) {
    throw new Error(`Claim not found: ${claimId}`);
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE task_claims
      SET status = 'released', released_at = ?, release_reason = ?
      WHERE id = ?
    `).run(new Date().toISOString(), reason, claimId);

    // Clear task claimed_by
    db.prepare(`UPDATE tasks SET claimed_by_agent = NULL WHERE id = ?`).run(claim.task_id);

    // Update agent load
    db.prepare(`UPDATE agents SET current_load = MAX(0, current_load - 1) WHERE id = ?`).run(claim.agent_id);

    recordCoordinationEvent('task_released', claim.agent_id, claim.task_id, JSON.stringify({ reason }));

    return claim;
  })();
}

/**
 * Get claim details
 * @param {any} taskIdOrClaimId
 * @returns {any}
 */
function getClaim(taskIdOrClaimId) {
  // Try as claim ID first
  let claim = db.prepare('SELECT * FROM task_claims WHERE id = ?').get(taskIdOrClaimId);

  // Try as task ID
  if (!claim) {
    claim = db.prepare(`
      SELECT * FROM task_claims WHERE task_id = ? ORDER BY claimed_at DESC LIMIT 1
    `).get(taskIdOrClaimId);
  }

  return claim;
}

/**
 * List claims with filters
 * @param {any} options
 * @returns {any}
 */
function listClaims({ agent_id, task_id, status, include_expired = false, limit = 50 } = {}) {
  let query = 'SELECT c.*, t.task_description FROM task_claims c JOIN tasks t ON c.task_id = t.id WHERE 1=1';
  const params = [];

  if (agent_id) {
    query += ' AND c.agent_id = ?';
    params.push(agent_id);
  }

  if (task_id) {
    query += ' AND c.task_id = ?';
    params.push(task_id);
  }

  if (status) {
    query += ' AND c.status = ?';
    params.push(status);
  } else if (!include_expired) {
    query += " AND c.status IN ('active', 'released')";
  }

  query += ' ORDER BY c.claimed_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

/**
 * Expire stale leases
 */
function expireStaleLeases() {
  return db.transaction(() => {
    const now = new Date().toISOString();

    const expired = db.prepare(`
      SELECT * FROM task_claims
      WHERE status = 'active' AND lease_expires_at < ?
    `).all(now) || [];
    const updateClaimStmt = db.prepare(`UPDATE task_claims SET status = 'expired' WHERE id = ?`);
    const returnTaskStmt = db.prepare(`UPDATE tasks SET claimed_by_agent = NULL, status = 'queued' WHERE id = ? AND status = 'running'`);
    const updateLoadStmt = db.prepare(`UPDATE agents SET current_load = MAX(0, current_load - 1) WHERE id = ?`);

    for (const claim of expired) {
      if (!claim) continue;
      updateClaimStmt.run(claim.id);
      const returnedTasks = returnTaskStmt.run(claim.task_id);
      if (returnedTasks && returnedTasks.changes > 0) {
        emitQueueChanged();
      }
      updateLoadStmt.run(claim.agent_id);

      recordCoordinationEvent('lease_expired', claim.agent_id, claim.task_id, null);
    }
    return expired;
  })();
}

/**
 * Get claimable tasks for an agent
 * @param {any} agentId
 * @param {any} limit
 * @returns {any}
 */
function getClaimableTasksForAgent(agentId, limit = 10) {
  const agent = getAgent(agentId);
  if (!agent) return [];

  // Get tasks that match agent capabilities and aren't claimed
  const tasks = db.prepare(`
    SELECT t.* FROM tasks t
    LEFT JOIN task_claims c ON t.id = c.task_id AND c.status = 'active'
    WHERE t.status = 'queued'
    AND c.id IS NULL
    ORDER BY t.priority DESC, t.created_at ASC
    LIMIT ?
  `).all(limit);

  // Filter by capabilities if agent has any
  if (agent.capabilities && agent.capabilities.length > 0) {
    return tasks.filter(task => {
      if (!task.required_capabilities) return true;
      let required;
      try { required = JSON.parse(task.required_capabilities); } catch { required = []; }
      return required.every(cap => agent.capabilities.includes(cap));
    });
  }

  return tasks;
}

// ============================================
// Phase 3: Routing & Groups
// ============================================

/**
 * Create an agent group
 */
function createAgentGroup({ id, name, description, routing_strategy, max_agents }) {
  const now = new Date().toISOString();
  const groupId = id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO agent_groups (id, name, description, routing_strategy, max_agents, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, name, description, routing_strategy || 'round_robin', max_agents, now);

  return getAgentGroup(groupId);
}

/**
 * Get agent group
 */
function getAgentGroup(groupId) {
  const group = db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(groupId);
  if (!group) return null;

  const memberRows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN agent_group_members m ON a.id = m.agent_id
    WHERE m.group_id = ?
  `).all(groupId);
  const rows = Array.isArray(memberRows) ? memberRows : [];
  group.members = rows.filter(member => member && member.id !== undefined && member.id !== null);

  for (const member of group.members) {
    member.capabilities = safeJsonParse(member && member.capabilities, []);
  }

  return group;
}

/**
 * List agent groups
 * @returns {any}
 */
function listAgentGroups() {
  const groups = db.prepare(`
    SELECT g.*, COALESCE(counts.member_count, 0) AS member_count
    FROM agent_groups g
    LEFT JOIN (
      SELECT group_id, COUNT(*) AS member_count
      FROM agent_group_members
      GROUP BY group_id
    ) counts ON counts.group_id = g.id
    ORDER BY g.name
  `).all();

  return groups;
}

/**
 * Add agent to group
 * @param {string} agentId - Agent identifier.
 * @param {string} groupId - Agent group identifier.
 * @returns {object} Updated agent group.
 */
function addAgentToGroup(agentId, groupId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const group = getAgentGroup(groupId);
  if (!group) throw new Error(`Group not found: ${groupId}`);

  // Check max_agents limit
  if (group.max_agents && group.members.length >= group.max_agents) {
    throw new Error(`Group ${group.name} is at maximum capacity`);
  }

  db.prepare(`
    INSERT OR IGNORE INTO agent_group_members (agent_id, group_id, joined_at)
    VALUES (?, ?, ?)
  `).run(agentId, groupId, new Date().toISOString());

  return getAgentGroup(groupId);
}

/**
 * Remove agent from group
 * @param {any} agentId
 * @param {any} groupId
 * @returns {any}
 */
function removeAgentFromGroup(agentId, groupId) {
  db.prepare('DELETE FROM agent_group_members WHERE agent_id = ? AND group_id = ?').run(agentId, groupId);
  return getAgentGroup(groupId);
}

/**
 * Create a routing rule
 */
function createRoutingRule({ id, name, priority, condition_type, condition_value, target_type, target_value }) {
  const ruleId = id || crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO task_routing_rules (id, name, priority, condition_type, condition_value, target_type, target_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ruleId, name, priority || 0, condition_type, condition_value, target_type, target_value, now);

  return db.prepare('SELECT * FROM task_routing_rules WHERE id = ?').get(ruleId);
}

/**
 * List routing rules
 * @param {any} options
 * @returns {any}
 */
function listRoutingRules({ enabled, target_type } = {}) {
  let query = 'SELECT * FROM task_routing_rules WHERE 1=1';
  const params = [];

  if (enabled !== undefined) {
    query += ' AND enabled = ?';
    params.push(enabled ? 1 : 0);
  }

  if (target_type) {
    query += ' AND target_type = ?';
    params.push(target_type);
  }

  query += ' ORDER BY priority DESC, created_at ASC';
  return db.prepare(query).all(...params);
}

/**
 * Delete a routing rule
 */
function deleteRoutingRule(ruleId) {
  const result = db.prepare('DELETE FROM task_routing_rules WHERE id = ?').run(ruleId);
  return result.changes > 0;
}

/**
 * Match a task to routing rules
 * @param {any} task
 * @returns {any}
 */
function matchRoutingRule(task) {
  const rules = listRoutingRules({ enabled: true });

  for (const rule of rules) {
    let matches = false;

    switch (rule.condition_type) {
      case 'tag': {
        // Handle both string JSON and already-parsed arrays
        const tags = typeof task.tags === 'string' ? safeJsonParse(task.tags, []) : (task.tags || []);
        matches = tags.includes(rule.condition_value);
        break;
      }
      case 'keyword':
        matches = task.task_description.toLowerCase().includes(rule.condition_value.toLowerCase());
        break;
      case 'project':
        matches = task.project === rule.condition_value;
        break;
      case 'directory':
        matches = task.working_directory && task.working_directory.includes(rule.condition_value);
        break;
    }

    if (matches) return rule;
  }

  return null;
}

/**
 * Route a task to available agents
 * @param {any} task
 * @returns {any}
 */
function routeTaskToAgent(task) {
  // 1. Check routing rules
  const rule = matchRoutingRule(task);
  if (rule) {
    const agents = getAgentsByTarget(rule.target_type, rule.target_value);
    if (agents.length > 0) {
      return selectAgentByStrategy(agents, 'affinity_first');
    }
  }

  // 2. Check capability requirements
  if (task.required_capabilities) {
    const required = typeof task.required_capabilities === 'string'
      ? JSON.parse(task.required_capabilities)
      : task.required_capabilities;

    if (required.length > 0) {
      const capable = getAgentsWithCapabilities(required);
      if (capable.length > 0) {
        return selectAgentByStrategy(capable, 'least_loaded');
      }
    }
  }

  // 3. Fall back to all available agents
  const available = listAgents({ status: 'online' });
  return selectAgentByStrategy(available, 'least_loaded');
}

/**
 * Get agents by target type
 */
function getAgentsByTarget(targetType, targetValue) {
  switch (targetType) {
    case 'agent': {
      const agent = getAgent(targetValue);
      return agent && agent.status === 'online' ? [agent] : [];
    }
    case 'group': {
      const group = getAgentGroup(targetValue);
      return group ? group.members.filter(a => a.status === 'online') : [];
    }
    case 'capability':
      return getAgentsWithCapabilities([targetValue]);
    default:
      return [];
  }
}

/**
 * Get agents with specific capabilities
 */
function getAgentsWithCapabilities(capabilities) {
  const agents = listAgents({ status: 'online' });
  return agents.filter(agent => {
    if (!agent.capabilities || agent.capabilities.length === 0) return false;
    return capabilities.every(cap => agent.capabilities.includes(cap));
  });
}

let roundRobinIndex = 0;

/**
 * Select agent using routing strategy
 * @param {any} agents
 * @param {any} strategy
 * @returns {any}
 */
function selectAgentByStrategy(agents, strategy) {
  if (agents.length === 0) return null;

  // Filter out overloaded agents
  const available = agents.filter(a => a.current_load < a.max_concurrent);
  if (available.length === 0) return null;

  switch (strategy) {
    case 'round_robin': {
      const selected = available[roundRobinIndex % available.length];
      roundRobinIndex = (roundRobinIndex + 1) % available.length;
      return selected;
    }
    case 'least_loaded':
      return available.sort((a, b) =>
        (a.current_load / a.max_concurrent) - (b.current_load / b.max_concurrent)
      )[0];
    case 'random':
      // Security: Use crypto.randomInt() instead of Math.random() for unpredictable selection
      return available[crypto.randomInt(available.length)];
    case 'affinity_first':
      // Sort by priority (affinity) then by load
      return available.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return (a.current_load / a.max_concurrent) - (b.current_load / b.max_concurrent);
      })[0];
    default:
      return available[0];
  }
}

// ============================================
// Phase 4: Work Stealing & Failover
// ============================================

/**
 * Steal a task from another agent
 * @param {any} taskId
 * @param {any} thiefAgentId
 * @param {any} reason
 * @returns {any}
 */
function stealTask(taskId, thiefAgentId, reason = 'manual') {
  return db.transaction(() => {
    const claim = db.prepare(`
      SELECT * FROM task_claims WHERE task_id = ? AND status = 'active'
    `).get(taskId);

    if (!claim) {
      throw new Error(`No active claim for task: ${taskId}`);
    }

    const victimAgentId = claim.agent_id;
    const now = new Date();
    const nowIso = now.toISOString();
    const nextLeaseSeconds = Number(claim && claim.lease_duration_seconds);
    const leaseSeconds = Number.isFinite(nextLeaseSeconds) && nextLeaseSeconds > 0 ? nextLeaseSeconds : 300;

    // Mark old claim as stolen
    db.prepare(`
      UPDATE task_claims SET status = 'stolen', released_at = ?, release_reason = ?
      WHERE id = ?
    `).run(nowIso, reason, claim.id);

    // Update victim agent load
    if (victimAgentId) {
      db.prepare(`UPDATE agents SET current_load = MAX(0, current_load - 1) WHERE id = ?`).run(victimAgentId);
    }

    // Log the steal
    db.prepare(`
      INSERT INTO work_stealing_log (victim_agent_id, thief_agent_id, task_id, reason, stolen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(victimAgentId, thiefAgentId, taskId, reason, nowIso);

    recordCoordinationEvent('work_stolen', thiefAgentId, taskId, JSON.stringify({
      from_agent: victimAgentId,
      reason
    }));

    // Create new claim for thief — if this throws, the entire transaction
    // rolls back so the victim's claim is not left marked 'stolen' without
    // a replacement.
    return createTaskClaim(taskId, thiefAgentId, leaseSeconds, now);
  })();
}

/**
 * Trigger failover for an agent
 * @param {any} agentId
 * @param {any} reassignTo
 * @returns {any}
 */
function triggerFailover(agentId, reassignTo = null) {
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const results = {
    agent_id: agentId,
    tasks_released: 0,
    tasks_reassigned: 0
  };

  return db.transaction((reassignTarget) => {
    // Get all active claims for this agent
    const claims = db.prepare(`
      SELECT * FROM task_claims WHERE agent_id = ? AND status = 'active'
    `).all(agentId);
    const releaseClaimStmt = db.prepare(`
      UPDATE task_claims
      SET status = 'released', released_at = ?, release_reason = ?
      WHERE id = ?
    `);
    const clearClaimedStmt = db.prepare(`UPDATE tasks SET claimed_by_agent = NULL WHERE id = ?`);
    const updateLoadStmt = db.prepare(`UPDATE agents SET current_load = MAX(0, current_load - 1) WHERE id = ?`);
    const requeueStmt = db.prepare(`UPDATE tasks SET status = 'queued' WHERE id = ? AND status = 'running'`);

    for (const claim of claims || []) {
      if (!claim) continue;

      // Release the claim
      releaseClaimStmt.run(new Date().toISOString(), 'failover', claim.id);

      clearClaimedStmt.run(claim.task_id);

      if (claim.agent_id) {
        updateLoadStmt.run(claim.agent_id);
      }

      recordCoordinationEvent('task_released', claim.agent_id, claim.task_id, JSON.stringify({ reason: 'failover' }));

      results.tasks_released++;

      // Return task to queue — only if still running (avoid re-queuing completed tasks)
      const returnedTasks = requeueStmt.run(claim.task_id);
      if (returnedTasks && returnedTasks.changes > 0) {
        emitQueueChanged();
      }

      // If reassigning to specific agent
      if (reassignTarget) {
        try {
          const nextLeaseSeconds = Number(claim.lease_duration_seconds);
          const leaseSeconds = Number.isFinite(nextLeaseSeconds) && nextLeaseSeconds > 0 ? nextLeaseSeconds : 300;
          createTaskClaim(claim.task_id, reassignTarget, leaseSeconds);
          results.tasks_reassigned++;
        } catch (_e) {
          void _e;
          // Agent might be overloaded
        }
      }
    }

    // Mark agent as offline
    db.prepare(`UPDATE agents SET status = 'offline', disconnected_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), agentId);

    recordCoordinationEvent('failover_triggered', agentId, null, JSON.stringify(results));

    return results;
  })(reassignTo);
}

/**
 * Get work stealing history
 * @param {any} options
 * @returns {any}
 */
function getStealingHistory({ victim_agent_id, thief_agent_id, since, limit = 50 } = {}) {
  let query = 'SELECT * FROM work_stealing_log WHERE 1=1';
  const params = [];

  if (victim_agent_id) {
    query += ' AND victim_agent_id = ?';
    params.push(victim_agent_id);
  }

  if (thief_agent_id) {
    query += ' AND thief_agent_id = ?';
    params.push(thief_agent_id);
  }

  if (since) {
    query += ' AND stolen_at >= ?';
    params.push(since);
  }

  query += ' ORDER BY stolen_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

/**
 * Get failover configuration
 * @returns {any}
 */
function getFailoverConfig() {
  const rows = db.prepare('SELECT key, value FROM failover_config').all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Update failover configuration
 * @param {any} updates
 * @returns {any}
 */
function updateFailoverConfig(updates) {
  const stmt = db.prepare('INSERT OR REPLACE INTO failover_config (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, String(value));
  }
  return getFailoverConfig();
}

// ============================================
// Phase 5: Coordination & Analytics
// ============================================

/**
 * Record agent metric
 * @param {any} agentId
 * @param {any} metricType
 * @param {any} value
 * @param {any} periodStart
 * @param {any} periodEnd
 * @returns {any}
 */
function recordAgentMetric(agentId, metricType, value, periodStart, periodEnd) {
  db.prepare(`
    INSERT INTO agent_metrics (agent_id, metric_type, metric_value, period_start, period_end, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agentId, metricType, value, periodStart, periodEnd, new Date().toISOString());
}

/**
 * Get coordination dashboard stats
 * @param {any} timeRangeHours
 * @returns {any}
 */
function getCoordinationDashboard(timeRangeHours = 24) {
  const since = new Date(Date.now() - timeRangeHours * 60 * 60 * 1000).toISOString();

  // Agent stats
  const agentStats = db.prepare(`
    SELECT
      COUNT(*) as total_agents,
      COUNT(CASE WHEN status = 'online' THEN 1 END) as online,
      COUNT(CASE WHEN status = 'offline' THEN 1 END) as offline,
      COUNT(CASE WHEN status = 'busy' THEN 1 END) as busy,
      COUNT(CASE WHEN status = 'draining' THEN 1 END) as draining,
      SUM(current_load) as total_load,
      SUM(max_concurrent) as total_capacity
    FROM agents
  `).get();

  // Claim stats
  const claimStats = db.prepare(`
    SELECT
      COUNT(*) as total_claims,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      COUNT(CASE WHEN status = 'released' THEN 1 END) as released,
      COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired,
      COUNT(CASE WHEN status = 'stolen' THEN 1 END) as stolen
    FROM task_claims
    WHERE claimed_at >= ?
  `).get(since);

  // Work stealing stats
  const stealingStats = db.prepare(`
    SELECT
      COUNT(*) as total_steals,
      COUNT(DISTINCT victim_agent_id) as unique_victims,
      COUNT(DISTINCT thief_agent_id) as unique_thieves
    FROM work_stealing_log
    WHERE stolen_at >= ?
  `).get(since);

  // Coordination events
  const eventStats = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM coordination_events
    WHERE created_at >= ?
    GROUP BY event_type
  `).all(since);

  // Lock stats
  const lockStats = db.prepare(`
    SELECT
      COUNT(*) as active_locks,
      COUNT(CASE WHEN expires_at < datetime('now') THEN 1 END) as expired_locks
    FROM distributed_locks
  `).get();

  // Load distribution
  const loadDistribution = db.prepare(`
    SELECT
      id,
      name,
      current_load,
      max_concurrent,
      ROUND(CAST(current_load AS FLOAT) / max_concurrent * 100, 1) as load_percent
    FROM agents
    WHERE status = 'online'
    ORDER BY load_percent DESC
  `).all();

  return {
    agents: agentStats,
    claims: claimStats,
    stealing: stealingStats,
    events: eventStats.reduce((acc, e) => { acc[e.event_type] = e.count; return acc; }, {}),
    locks: lockStats,
    load_distribution: loadDistribution,
    period_hours: timeRangeHours
  };
}

// ============================================
// Enhanced Distributed Locking
// ============================================

/**
 * Try to acquire a distributed lock with lease-based expiration
 * Uses atomic INSERT OR REPLACE with expiration check
 *
 * @param {string} lockName - Name of the lock (e.g., 'queue_processor')
 * @param {string} holderId - Unique ID for this process/holder
 * @param {number} leaseSeconds - How long the lock is valid (default 30s)
 * @param {string} holderInfo - Optional info about the holder (for debugging)
 * @returns {{ acquired: boolean, holder?: string, expiresAt?: string }}
 */
function acquireLock(lockName, holderId, leaseSeconds = 30, holderInfo = null) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  const nowIso = now.toISOString();
  const expiresIso = expiresAt.toISOString();

  // Heartbeat stale threshold - if no heartbeat for 15 seconds, consider lock stale
  // Use a transaction for atomicity
  const transaction = db.transaction(() => {
    // Check if lock exists and is still valid
    const existing = db.prepare(
      'SELECT * FROM distributed_locks WHERE lock_name = ?'
    ).get(lockName);

    if (existing) {
      const existingExpires = new Date(existing.expires_at);

      // If lock is held by us, extend the lease and update heartbeat
      if (existing.holder_id === holderId) {
        if (holderInfo !== null) {
          db.prepare(
            'UPDATE distributed_locks SET expires_at = ?, acquired_at = ?, last_heartbeat = ?, holder_info = ? WHERE lock_name = ?'
          ).run(expiresIso, nowIso, nowIso, holderInfo, lockName);
        } else {
          db.prepare(
            'UPDATE distributed_locks SET expires_at = ?, acquired_at = ?, last_heartbeat = ? WHERE lock_name = ?'
          ).run(expiresIso, nowIso, nowIso, lockName);
        }
        return { acquired: true, extended: true, expiresAt: expiresIso };
      }

      const isLeaseExpired = existingExpires <= now;

      // If lock is held by someone else and not expired, fail
      if (!isLeaseExpired) {
        return {
          acquired: false,
          holder: existing.holder_id,
          expiresAt: existing.expires_at,
          holderInfo: existing.holder_info
        };
      }

      logger.info(`[Lock] Taking over expired lock '${lockName}' from ${existing.holder_id}`);
    }

    // Insert or replace the lock with initial heartbeat
    db.prepare(`
      INSERT OR REPLACE INTO distributed_locks (lock_name, holder_id, acquired_at, expires_at, holder_info, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(lockName, holderId, nowIso, expiresIso, holderInfo, nowIso);

    return { acquired: true, expiresAt: expiresIso };
  });

  return transaction();
}

/**
 * Update heartbeat for a held lock.
 * Should be called periodically (every 5 seconds) while holding the lock.
 * @param {string} lockName - Name of the lock
 * @param {string} holderId - Our holder ID
 * @returns {{ updated: boolean }}
 */
function updateLockHeartbeat(lockName, holderId) {
  try {
    const now = new Date().toISOString();
    const result = db.prepare(
      'UPDATE distributed_locks SET last_heartbeat = ? WHERE lock_name = ? AND holder_id = ?'
    ).run(now, lockName, holderId);
    return { updated: result.changes > 0 };
  } catch (_e) {
    void _e;
    // Column might not exist yet, ignore
    return { updated: false };
  }
}

/**
 * Check if a lock's heartbeat is stale (holder may have died).
 * @param {string} lockName - Name of the lock
 * @param {number} staleThresholdMs - How long without heartbeat to consider stale (default 15s)
 * @returns {{ isStale: boolean, lastHeartbeat?: string, staleDurationMs?: number }}
 */
function isLockHeartbeatStale(lockName, staleThresholdMs = 15000) {
  try {
    const lock = db.prepare(
      'SELECT last_heartbeat, holder_id FROM distributed_locks WHERE lock_name = ?'
    ).get(lockName);

    if (!lock) {
      return { isStale: false };
    }

    if (!lock.last_heartbeat) {
      // No heartbeat recorded yet - not stale (backwards compatibility)
      return { isStale: false };
    }

    const lastHeartbeat = new Date(lock.last_heartbeat).getTime();
    const now = Date.now();
    const staleDurationMs = now - lastHeartbeat;

    return {
      isStale: staleDurationMs > staleThresholdMs,
      lastHeartbeat: lock.last_heartbeat,
      staleDurationMs,
      holderId: lock.holder_id
    };
  } catch (_e) {
    void _e;
    return { isStale: false };
  }
}

/**
 * Force-release a stale lock (heartbeat not updated for too long).
 * Use with caution - only when lock holder is presumed dead.
 * @param {string} lockName - Name of the lock
 * @returns {{ released: boolean, reason?: string }}
 */
function forceReleaseStaleLock(lockName) {
  const lock = db.prepare(
    'SELECT * FROM distributed_locks WHERE lock_name = ?'
  ).get(lockName);

  if (!lock) {
    return { released: false, reason: 'lock_not_found' };
  }

  const now = new Date();
  const expiresAt = new Date(lock.expires_at);
  const isExpired = expiresAt <= now;

  // Also consider heartbeat staleness — holder may have died before expiry
  const lastHeartbeat = lock.last_heartbeat;
  const heartbeatAge = lastHeartbeat ? (now.getTime() - new Date(lastHeartbeat).getTime()) : Infinity;
  const isHeartbeatStale = heartbeatAge > (60 * 1000);

  if (!isExpired && !isHeartbeatStale) {
    return { released: false, reason: 'lock_not_stale' };
  }

  const result = db.prepare(
    'DELETE FROM distributed_locks WHERE lock_name = ?'
  ).run(lockName);

  return {
    released: result.changes > 0,
    previousHolder: lock.holder_id,
    staleDurationMs: now - expiresAt
  };
}

/**
 * Release a distributed lock (only if we hold it)
 *
 * @param {string} lockName - Name of the lock
 * @param {string} holderId - Our holder ID
 * @returns {{ released: boolean, reason?: string }}
 */
function releaseLock(lockName, holderId) {
  const result = db.prepare(
    'DELETE FROM distributed_locks WHERE lock_name = ? AND holder_id = ?'
  ).run(lockName, holderId);

  if (result.changes > 0) {
    return { released: true };
  }

  // Check why we couldn't release
  const existing = db.prepare(
    'SELECT holder_id FROM distributed_locks WHERE lock_name = ?'
  ).get(lockName);

  if (!existing) {
    return { released: false, reason: 'lock_not_found' };
  }

  return { released: false, reason: 'not_holder', currentHolder: existing.holder_id };
}

/**
 * Check if a lock is currently held (and by whom)
 *
 * @param {string} lockName - Name of the lock
 * @returns {{ held: boolean, holder?: string, expiresAt?: string, expired?: boolean }}
 */
function checkLock(lockName) {
  const lock = db.prepare(
    'SELECT * FROM distributed_locks WHERE lock_name = ?'
  ).get(lockName);

  if (!lock) {
    return { held: false };
  }

  const now = new Date();
  const expiresAt = new Date(lock.expires_at);
  const expired = expiresAt <= now;

  return {
    held: !expired,
    expired,
    holder: lock.holder_id,
    expiresAt: lock.expires_at,
    holderInfo: lock.holder_info
  };
}

/**
 * Get all active MCP instances (heartbeat within threshold).
 * Queries distributed_locks for all mcp_instance:* rows with fresh heartbeats.
 * @param {number} [staleThresholdMs=30000] - Max age of heartbeat to consider alive
 * @returns {Array<{ instanceId: string, pid: number, port: number|null, startedAt: string, lockName: string }>}
 */
function getActiveInstances(staleThresholdMs = 30000) {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  const rows = db.prepare(
    "SELECT lock_name, holder_id, holder_info, last_heartbeat, acquired_at FROM distributed_locks WHERE lock_name LIKE 'mcp_instance:%' AND last_heartbeat >= ?"
  ).all(cutoff);

  return rows.map(row => {
    let info = {};
    try { info = JSON.parse(row.holder_info) || {}; } catch { /* ignore */ }
    return {
      instanceId: row.holder_id,
      pid: info.pid || null,
      port: info.port || null,
      startedAt: info.startedAt || row.acquired_at,
      lockName: row.lock_name
    };
  });
}

/**
 * Clean up expired locks (maintenance function)
 * @returns {number} Number of expired locks removed
 */
function cleanupExpiredLocks() {
  const now = new Date().toISOString();
  const result = db.prepare(
    'DELETE FROM distributed_locks WHERE expires_at < ?'
  ).run(now);
  return result.changes;
}

// ============================================
// Exports
// ============================================

/**
 * Factory function for DI container.
 * @param {{ db: object, taskCore?: object }} deps
 */
function createCoordination({ db: dbInstance, taskCore }) {
  setDb(dbInstance);
  setGetTask(taskCore?.getTask || (() => null));
  return {
    registerAgent,
    unregisterAgent,
    updateAgentHeartbeat,
    getAgent,
    listAgents,
    updateAgent,
    checkOfflineAgents,
    recordCoordinationEvent,
    claimTask,
    renewLease,
    releaseTaskClaim,
    getClaim,
    listClaims,
    expireStaleLeases,
    getClaimableTasksForAgent,
    createAgentGroup,
    getAgentGroup,
    listAgentGroups,
    addAgentToGroup,
    removeAgentFromGroup,
    createRoutingRule,
    listRoutingRules,
    deleteRoutingRule,
    matchRoutingRule,
    routeTaskToAgent,
    getAgentsByTarget,
    getAgentsWithCapabilities,
    selectAgentByStrategy,
    stealTask,
    triggerFailover,
    getStealingHistory,
    getFailoverConfig,
    updateFailoverConfig,
    recordAgentMetric,
    getCoordinationDashboard,
    acquireLock,
    updateLockHeartbeat,
    isLockHeartbeatStale,
    forceReleaseStaleLock,
    releaseLock,
    checkLock,
    getActiveInstances,
    cleanupExpiredLocks,
  };
}

module.exports = {
  setDb,
  setGetTask,
  createCoordination,

  // Phase 1: Agent Lifecycle
  registerAgent,
  unregisterAgent,
  updateAgentHeartbeat,
  getAgent,
  listAgents,
  updateAgent,
  checkOfflineAgents,
  recordCoordinationEvent,

  // Phase 2: Task Claiming
  claimTask,
  renewLease,
  releaseTaskClaim,
  getClaim,
  listClaims,
  expireStaleLeases,
  getClaimableTasksForAgent,

  // Phase 3: Routing & Groups
  createAgentGroup,
  getAgentGroup,
  listAgentGroups,
  addAgentToGroup,
  removeAgentFromGroup,
  createRoutingRule,
  listRoutingRules,
  deleteRoutingRule,
  matchRoutingRule,
  routeTaskToAgent,
  getAgentsByTarget,
  getAgentsWithCapabilities,
  selectAgentByStrategy,

  // Phase 4: Work Stealing & Failover
  stealTask,
  triggerFailover,
  getStealingHistory,
  getFailoverConfig,
  updateFailoverConfig,

  // Phase 5: Coordination & Analytics
  recordAgentMetric,
  getCoordinationDashboard,

  // Enhanced Distributed Locking
  acquireLock,
  updateLockHeartbeat,
  isLockHeartbeatStale,
  forceReleaseStaleLock,
  releaseLock,
  checkLock,
  getActiveInstances,
  cleanupExpiredLocks,
};
