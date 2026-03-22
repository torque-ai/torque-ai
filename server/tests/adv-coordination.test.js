const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

beforeEach(() => {
  const env = setupTestDb('adv-coordination');
  db = env.db;
});

afterEach(() => {
  teardownTestDb();
  db = null;
});

function rawDb() {
  return db.getDbInstance();
}

function createAgent(name = `agent-${randomUUID()}`, overrides = {}) {
  return db.registerAgent({
    id: overrides.id || randomUUID(),
    name,
    capabilities: overrides.capabilities || [],
    max_concurrent: overrides.max_concurrent ?? 1,
    agent_type: overrides.agent_type || 'worker',
    priority: overrides.priority ?? 0,
    metadata: overrides.metadata
  });
}

function createTask(description = 'coordination test task', overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
    id,
    task_description: description,
    working_directory: process.env.TORQUE_DATA_DIR,
    status: overrides.status || 'queued',
    priority: overrides.priority ?? 0,
    project: overrides.project ?? null,
    tags: overrides.tags
  });

  if (overrides.required_capabilities !== undefined) {
    rawDb()
      .prepare('UPDATE tasks SET required_capabilities = ? WHERE id = ?')
      .run(JSON.stringify(overrides.required_capabilities), id);
  }

  return db.getTask(id);
}

function createGroup(name = `group-${randomUUID()}`, overrides = {}) {
  return db.createAgentGroup({
    id: overrides.id || randomUUID(),
    name,
    description: overrides.description,
    routing_strategy: overrides.routing_strategy || 'round_robin',
    max_agents: overrides.max_agents
  });
}

function findAgentByName(name) {
  const row = rawDb().prepare('SELECT id FROM agents WHERE name = ?').get(name);
  return row ? db.getAgent(row.id) : null;
}

function findGroupByName(name) {
  const row = rawDb().prepare('SELECT id FROM agent_groups WHERE name = ?').get(name);
  return row ? db.getAgentGroup(row.id) : null;
}

function getMembership(agentId, groupId) {
  return rawDb()
    .prepare('SELECT * FROM agent_group_members WHERE agent_id = ? AND group_id = ?')
    .get(agentId, groupId);
}

function countMemberships(groupId) {
  return rawDb()
    .prepare('SELECT COUNT(*) AS count FROM agent_group_members WHERE group_id = ?')
    .get(groupId).count;
}

function getClaimRow(claimId) {
  return rawDb().prepare('SELECT * FROM task_claims WHERE id = ?').get(claimId);
}

function countClaimsForTask(taskId) {
  return rawDb()
    .prepare('SELECT COUNT(*) AS count FROM task_claims WHERE task_id = ?')
    .get(taskId).count;
}

function latestEvent(eventType) {
  return rawDb()
    .prepare('SELECT * FROM coordination_events WHERE event_type = ? ORDER BY id DESC LIMIT 1')
    .get(eventType);
}

function countEvents(eventType) {
  return rawDb()
    .prepare('SELECT COUNT(*) AS count FROM coordination_events WHERE event_type = ?')
    .get(eventType).count;
}

describe('adv-coordination handlers', () => {
  describe('agent registration and group management', () => {
    it('requires a name when registering an agent', async () => {
      const result = await safeTool('register_agent', {});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
    });

    it('registers an agent with defaults and records an agent_joined event', async () => {
      const result = await safeTool('register_agent', { name: 'Worker Alpha' });
      const agent = findAgentByName('Worker Alpha');
      const event = latestEvent('agent_joined');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Agent Registered');
      expect(agent).toBeTruthy();
      expect(agent.agent_type).toBe('worker');
      expect(agent.status).toBe('online');
      expect(agent.max_concurrent).toBe(1);
      expect(agent.priority).toBe(0);
      expect(agent.capabilities).toEqual([]);
      expect(event.agent_id).toBe(agent.id);
      expect(JSON.parse(event.details)).toEqual({ name: 'Worker Alpha', capabilities: [] });
    });

    it('persists capabilities, metadata, and scheduling fields during registration', async () => {
      const result = await safeTool('register_agent', {
        name: 'Metadata Agent',
        capabilities: ['build', 'test'],
        max_concurrent: 3,
        agent_type: 'coordinator',
        priority: 5,
        metadata: { zone: 'us-west', shift: 'day' }
      });
      const agent = findAgentByName('Metadata Agent');

      expect(result.isError).toBeFalsy();
      expect(agent).toBeTruthy();
      expect(agent.capabilities).toEqual(['build', 'test']);
      expect(agent.max_concurrent).toBe(3);
      expect(agent.agent_type).toBe('coordinator');
      expect(agent.priority).toBe(5);
      expect(agent.metadata).toEqual({ zone: 'us-west', shift: 'day' });
    });

    it('updates heartbeat load, status, and timestamp for an existing agent', async () => {
      const agent = createAgent('Heartbeat Agent');
      rawDb()
        .prepare('UPDATE agents SET last_heartbeat_at = ? WHERE id = ?')
        .run('2025-01-01T00:00:00.000Z', agent.id);

      const result = await safeTool('agent_heartbeat', {
        agent_id: agent.id,
        current_load: 2,
        status: 'busy'
      });
      const updated = db.getAgent(agent.id);

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Heartbeat recorded');
      expect(updated.current_load).toBe(2);
      expect(updated.status).toBe('busy');
      expect(updated.last_heartbeat_at).not.toBe('2025-01-01T00:00:00.000Z');
    });

    it('updates agent capabilities, priority, load limit, and status', async () => {
      const agent = createAgent('Update Agent');

      const result = await safeTool('update_agent', {
        agent_id: agent.id,
        capabilities: ['review'],
        max_concurrent: 4,
        priority: 9,
        status: 'draining'
      });
      const updated = db.getAgent(agent.id);

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('updated successfully');
      expect(updated.capabilities).toEqual(['review']);
      expect(updated.max_concurrent).toBe(4);
      expect(updated.priority).toBe(9);
      expect(updated.status).toBe('draining');
    });

    it('lists agents filtered by capability and status', async () => {
      createAgent('Build Worker', { capabilities: ['build'] });
      createAgent('Deploy Worker', { capabilities: ['deploy'] });
      const offline = createAgent('Offline Builder', { capabilities: ['build'] });
      db.updateAgent(offline.id, { status: 'offline' });

      const result = await safeTool('list_agents', {
        capability: 'build',
        status: 'online'
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Registered Agents');
      expect(text).toContain('Build Worker');
      expect(text).not.toContain('Deploy Worker');
      expect(text).not.toContain('Offline Builder');
    });

    it('creates an agent group with routing settings', async () => {
      const result = await safeTool('create_agent_group', {
        name: 'Reviewers',
        description: 'code review team',
        routing_strategy: 'least_loaded',
        max_agents: 2
      });
      const group = findGroupByName('Reviewers');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Agent Group Created');
      expect(group).toBeTruthy();
      expect(group.description).toBe('code review team');
      expect(group.routing_strategy).toBe('least_loaded');
      expect(group.max_agents).toBe(2);
    });

    it('requires a group name when creating an agent group', async () => {
      const result = await safeTool('create_agent_group', {});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
    });

    it('adds an agent to a group and stores the membership row', async () => {
      const agent = createAgent('Group Member');
      const group = createGroup('Coordination Team');

      const result = await safeTool('add_to_group', {
        agent_id: agent.id,
        group_id: group.id
      });
      const membership = getMembership(agent.id, group.id);

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('added to group');
      expect(membership).toBeTruthy();
      expect(db.getAgentGroup(group.id).members.map(member => member.id)).toEqual([agent.id]);
    });

    it('keeps group membership idempotent when the same agent is added twice', async () => {
      const agent = createAgent('Duplicate Member');
      const group = createGroup('Idempotent Team');

      await safeTool('add_to_group', { agent_id: agent.id, group_id: group.id });
      const second = await safeTool('add_to_group', { agent_id: agent.id, group_id: group.id });

      expect(second.isError).toBeFalsy();
      expect(countMemberships(group.id)).toBe(1);
      expect(db.getAgentGroup(group.id).members).toHaveLength(1);
    });

    it('rejects adding an unknown agent to a group', async () => {
      const group = createGroup('Known Group');

      const result = await safeTool('add_to_group', {
        agent_id: 'missing-agent',
        group_id: group.id
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('rejects adding an agent to an unknown group', async () => {
      const agent = createAgent('Known Agent');

      const result = await safeTool('add_to_group', {
        agent_id: agent.id,
        group_id: 'missing-group'
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Group not found');
    });

    it('rejects adding an agent when the group is at capacity', async () => {
      const first = createAgent('First Agent');
      const second = createAgent('Second Agent');
      const group = createGroup('Capacity One', { max_agents: 1 });

      await safeTool('add_to_group', { agent_id: first.id, group_id: group.id });
      const result = await safeTool('add_to_group', {
        agent_id: second.id,
        group_id: group.id
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('maximum capacity');
      expect(countMemberships(group.id)).toBe(1);
    });

    it('lists agents filtered by group membership', async () => {
      const grouped = createAgent('Grouped Agent');
      createAgent('Ungrouped Agent');
      const group = createGroup('Filtered Group');
      db.addAgentToGroup(grouped.id, group.id);

      const result = await safeTool('list_agents', { group_id: group.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Grouped Agent');
      expect(text).not.toContain('Ungrouped Agent');
    });

    it('removes an agent from a group', async () => {
      const agent = createAgent('Removed Agent');
      const group = createGroup('Removal Group');
      db.addAgentToGroup(agent.id, group.id);

      const result = await safeTool('remove_from_group', {
        agent_id: agent.id,
        group_id: group.id
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('removed from group');
      expect(getMembership(agent.id, group.id)).toBeFalsy();
      expect(db.getAgentGroup(group.id).members).toHaveLength(0);
    });

    it('unregisters an agent, removes memberships, and records an agent_left event', async () => {
      const agent = createAgent('Leaving Agent');
      const group = createGroup('Exit Group');
      db.addAgentToGroup(agent.id, group.id);

      const result = await safeTool('unregister_agent', { agent_id: agent.id });
      const leaveEvent = latestEvent('agent_left');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Agent Unregistered');
      expect(db.getAgent(agent.id)).toBeNull();
      expect(countMemberships(group.id)).toBe(0);
      // agent_id is nullified in coordination_events during agent deletion
      // to preserve audit trail without violating FK constraints
      expect(leaveEvent).toBeTruthy();
      expect(leaveEvent.agent_id).toBeNull();
      expect(JSON.parse(leaveEvent.details)).toEqual({ name: 'Leaving Agent' });
    });
  });

  describe('task claims and coordination events', () => {
    it('claims a task, updates ownership, and records a task_claimed event', async () => {
      const agent = createAgent('Claim Agent');
      const task = createTask('claim target');

      const result = await safeTool('claim_task', {
        task_id: task.id,
        agent_id: agent.id,
        lease_seconds: 90
      });
      const claim = db.getClaim(task.id);
      const claimedTask = db.getTask(task.id);
      const event = latestEvent('task_claimed');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task Claimed');
      expect(claim).toBeTruthy();
      expect(claim.agent_id).toBe(agent.id);
      expect(claim.lease_duration_seconds).toBe(90);
      expect(claimedTask.claimed_by_agent).toBe(agent.id);
      expect(db.getAgent(agent.id).current_load).toBe(1);
      expect(event.task_id).toBe(task.id);
      expect(JSON.parse(event.details)).toEqual({ lease_seconds: 90 });
    });

    it('rejects claiming a missing task', async () => {
      const agent = createAgent('Missing Task Agent');

      const result = await safeTool('claim_task', {
        task_id: 'missing-task',
        agent_id: agent.id
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('rejects claiming with an invalid agent id', async () => {
      const task = createTask('invalid agent target');

      const result = await safeTool('claim_task', {
        task_id: task.id,
        agent_id: 'invalid-agent'
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('rejects duplicate claims and keeps the original claim active', async () => {
      const first = createAgent('Original Owner');
      const second = createAgent('Second Owner');
      const task = createTask('duplicate claim target');

      await safeTool('claim_task', { task_id: task.id, agent_id: first.id });
      const result = await safeTool('claim_task', { task_id: task.id, agent_id: second.id });
      const claim = db.getClaim(task.id);

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('already claimed by agent');
      expect(claim.agent_id).toBe(first.id);
      expect(claim.status).toBe('active');
      expect(countClaimsForTask(task.id)).toBe(1);
      expect(db.getAgent(first.id).current_load).toBe(1);
      expect(db.getAgent(second.id).current_load).toBe(0);
      expect(countEvents('task_claimed')).toBe(1);
    });

    it('renews a lease, increments renewals, and records a lease_renewed event', async () => {
      const agent = createAgent('Renew Agent');
      const task = createTask('renew target');
      const claim = db.claimTask(task.id, agent.id, 60);
      const oldExpiry = new Date(claim.lease_expires_at).getTime();

      const result = await safeTool('renew_lease', {
        claim_id: claim.id,
        extend_seconds: 120
      });
      const renewed = getClaimRow(claim.id);
      const event = latestEvent('lease_renewed');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Lease renewed');
      expect(renewed.renewals).toBe(1);
      expect(new Date(renewed.lease_expires_at).getTime()).toBeGreaterThan(oldExpiry);
      expect(event.task_id).toBe(task.id);
      expect(JSON.parse(event.details).renewals).toBe(1);
    });

    it('rejects renewing a released claim', async () => {
      const agent = createAgent('Released Claim Agent');
      const task = createTask('released claim target');
      const claim = db.claimTask(task.id, agent.id, 60);
      db.releaseTaskClaim(claim.id, 'completed');

      const result = await safeTool('renew_lease', { claim_id: claim.id });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Claim is not active: released');
    });

    it('releases a claim, clears task ownership, decrements load, and records task_released', async () => {
      const agent = createAgent('Release Agent');
      const task = createTask('release target');
      const claim = db.claimTask(task.id, agent.id, 60);

      const result = await safeTool('release_task', {
        claim_id: claim.id,
        reason: 'completed'
      });
      const released = getClaimRow(claim.id);
      const releasedTask = db.getTask(task.id);
      const event = latestEvent('task_released');

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Task claim released');
      expect(released.status).toBe('released');
      expect(released.release_reason).toBe('completed');
      expect(released.released_at).toBeTruthy();
      expect(releasedTask.claimed_by_agent).toBeNull();
      expect(db.getAgent(agent.id).current_load).toBe(0);
      expect(event.task_id).toBe(task.id);
      expect(JSON.parse(event.details)).toEqual({ reason: 'completed' });
    });

    it('returns claim details for a released claim lookup', async () => {
      const agent = createAgent('Claim Details Agent');
      const task = createTask('claim detail target');
      const claim = db.claimTask(task.id, agent.id, 60);
      db.releaseTaskClaim(claim.id, 'cleanup');

      const result = await safeTool('get_claim', { claim_id: claim.id });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Claim Details');
      expect(text).toContain(claim.id);
      expect(text).toContain('released');
      expect(text).toContain('cleanup');
    });

    it('returns a no-claim message for unknown task ids', async () => {
      const result = await safeTool('get_claim', { task_id: 'missing-claim-task' });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No claim found');
    });

    it('filters listed claims by agent and released status', async () => {
      const agent = createAgent('Listing Agent');
      const other = createAgent('Other Agent');
      const activeTask = createTask('active claim', { id: 'actv0001-task' });
      const releasedTask = createTask('released claim', { id: 'rels0002-task' });
      const otherTask = createTask('other agent claim', { id: 'othr0003-task' });
      db.claimTask(activeTask.id, agent.id, 60);
      const releasedClaim = db.claimTask(releasedTask.id, agent.id, 60);
      db.claimTask(otherTask.id, other.id, 60);
      db.releaseTaskClaim(releasedClaim.id, 'done');

      const result = await safeTool('list_claims', {
        agent_id: agent.id,
        status: 'released'
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Task Claims');
      expect(text).toContain('rels0002...');
      expect(text).not.toContain('actv0001...');
      expect(text).not.toContain('othr0003...');
    });

    it('omits expired claims by default when listing claims', async () => {
      const agent = createAgent('Default Claim List Agent');
      const liveTask = createTask('live claim', { id: 'live0004-task' });
      const expiredTask = createTask('expired claim', { id: 'expd0005-task' });
      db.claimTask(liveTask.id, agent.id, 60);
      const expiredClaim = db.claimTask(expiredTask.id, createAgent('Expired Claim Agent').id, 60);
      rawDb().prepare("UPDATE task_claims SET status = 'expired' WHERE id = ?").run(expiredClaim.id);

      const result = await safeTool('list_claims', {});
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('live0004...');
      expect(text).not.toContain('expd0005...');
    });

    it('includes expired claims when requested', async () => {
      const agent = createAgent('Include Expired Agent');
      const liveTask = createTask('live include', { id: 'live0006-task' });
      const expiredTask = createTask('expired include', { id: 'expd0007-task' });
      db.claimTask(liveTask.id, agent.id, 60);
      const expiredClaim = db.claimTask(expiredTask.id, createAgent('Expired Include Agent').id, 60);
      rawDb().prepare("UPDATE task_claims SET status = 'expired' WHERE id = ?").run(expiredClaim.id);

      const result = await safeTool('list_claims', { include_expired: true });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('live0006...');
      expect(text).toContain('expd0007...');
    });
  });
});
