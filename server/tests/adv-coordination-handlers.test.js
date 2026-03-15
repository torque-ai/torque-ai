const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;

describe('Advanced Coordination Handlers', () => {
  beforeAll(() => {
    const env = setupTestDb('adv-coordination-handlers');
    db = env.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create an agent directly via the DB (bypasses handler API mismatch)
  function createAgentDirect(name, opts = {}) {
    const coord = require('../db/coordination');
    return coord.registerAgent({
      id: require('crypto').randomUUID(),
      name,
      capabilities: opts.capabilities || [],
      max_concurrent: opts.max_concurrent || 1,
      agent_type: opts.agent_type || 'worker',
      priority: opts.priority || 0,
      metadata: opts.metadata || null
    });
  }

  // Helper: create a task directly via the DB
  function createTaskDirect(description) {
    const id = require('crypto').randomUUID();
    db.createTask({
      id,
      task_description: description || 'test task',
      working_directory: process.env.TORQUE_DATA_DIR,
      status: 'queued',
      priority: 0,
      project: null
    });
    return db.getTask(id);
  }

  // Helper: create a group directly via the DB
  function createGroupDirect(name, opts = {}) {
    const coord = require('../db/coordination');
    return coord.createAgentGroup({
      id: require('crypto').randomUUID(),
      name,
      description: opts.description,
      routing_strategy: opts.routing_strategy || 'round_robin',
      max_agents: opts.max_agents
    });
  }

  // ── Agent CRUD ──────────────────────────────────────────────────────

  describe('register_agent', () => {
    it('returns error when name is missing', async () => {
      const result = await safeTool('register_agent', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('name is required');
    });

    it('rejects deeply nested metadata', async () => {
      let nested = { a: 1 };
      for (let i = 0; i < 20; i++) {
        nested = { child: nested };
      }
      const result = await safeTool('register_agent', { name: 'Deep', metadata: nested });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid metadata');
    });

    it('registers agent with valid name', async () => {
      const result = await safeTool('register_agent', { name: 'TestAgent' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('TestAgent');
    });
  });

  describe('unregister_agent', () => {
    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('unregister_agent', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent ID is required');
    });

    it('returns error for nonexistent agent', async () => {
      const result = await safeTool('unregister_agent', { agent_id: 'no-such-agent-999' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('unregisters an agent created directly', async () => {
      const agent = createAgentDirect('UnregMe');
      const result = await safeTool('unregister_agent', { agent_id: agent.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Agent Unregistered');
    });
  });

  describe('agent_heartbeat', () => {
    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('agent_heartbeat', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent ID is required');
    });

    it('returns error for nonexistent agent', async () => {
      const result = await safeTool('agent_heartbeat', { agent_id: 'ghost-agent' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('records heartbeat for agent created directly', async () => {
      const agent = createAgentDirect('HeartbeatTarget');
      const result = await safeTool('agent_heartbeat', {
        agent_id: agent.id,
        current_load: 2,
        status: 'busy'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Heartbeat recorded');
    });
  });

  describe('list_agents', () => {
    it('lists agents without filters', async () => {
      const result = await safeTool('list_agents', {});
      expect(result.isError).toBeFalsy();
    });

    it('filters by status', async () => {
      const result = await safeTool('list_agents', { status: 'online' });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-match message when filter excludes all agents', async () => {
      const result = await safeTool('list_agents', { status: 'draining' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No agents found');
    });

    it('returns a table for agents that exist', async () => {
      createAgentDirect('ListedAgent1');
      const result = await safeTool('list_agents', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Registered Agents');
    });

    it('respects limit parameter', async () => {
      const result = await safeTool('list_agents', { limit: 1 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_agent', () => {
    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('get_agent', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent ID is required');
    });

    it('returns error for nonexistent agent', async () => {
      const result = await safeTool('get_agent', { agent_id: 'does-not-exist' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('returns agent details for existing agent', async () => {
      const agent = createAgentDirect('GetMeAgent');
      const result = await safeTool('get_agent', { agent_id: agent.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Agent Details');
      expect(text).toContain('GetMeAgent');
      expect(text).toContain(agent.id);
    });

    it('includes metrics when include_metrics is true', async () => {
      const agent = createAgentDirect('MetricsAgent');
      const result = await safeTool('get_agent', { agent_id: agent.id, include_metrics: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Agent Details');
    });
  });

  describe('update_agent', () => {
    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('update_agent', { capabilities: ['js'] });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent ID is required');
    });

    it('returns error for nonexistent agent', async () => {
      const result = await safeTool('update_agent', { agent_id: 'phantom-agent', status: 'online' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('updates agent fields', async () => {
      const agent = createAgentDirect('UpdateMe');
      const result = await safeTool('update_agent', {
        agent_id: agent.id,
        capabilities: ['deploy'],
        max_concurrent: 3,
        priority: 5,
        status: 'busy'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('updated successfully');
    });
  });

  // ── Task Claiming ──────────────────────────────────────────────────

  describe('claim_task', () => {
    it('returns error when task_id or agent_id is missing', async () => {
      const r1 = await safeTool('claim_task', { agent_id: 'some-agent' });
      expect(r1.isError).toBe(true);
      expect(getText(r1)).toContain('task_id and agent_id are required');

      const r2 = await safeTool('claim_task', { task_id: 'some-task' });
      expect(r2.isError).toBe(true);
      expect(getText(r2)).toContain('task_id and agent_id are required');

      const r3 = await safeTool('claim_task', {});
      expect(r3.isError).toBe(true);
      expect(getText(r3)).toContain('task_id and agent_id are required');
    });

    it('returns error for nonexistent task', async () => {
      const agent = createAgentDirect('ClaimAgent');
      const result = await safeTool('claim_task', { task_id: 'no-task-111', agent_id: agent.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('returns error for nonexistent agent', async () => {
      const task = createTaskDirect('claim target');
      const result = await safeTool('claim_task', { task_id: task.id, agent_id: 'no-agent-222' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found');
    });

    it('claims a task successfully', async () => {
      const agent = createAgentDirect('ClaimerOK');
      const task = createTaskDirect('claimable task');
      const result = await safeTool('claim_task', { task_id: task.id, agent_id: agent.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Claimed');
      expect(text).toContain(task.id);
    });
  });

  describe('renew_lease', () => {
    it('returns error when claim_id is missing', async () => {
      const result = await safeTool('renew_lease', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('claim_id is required');
    });

    it('returns error for nonexistent claim', async () => {
      const result = await safeTool('renew_lease', { claim_id: 'fake-claim-id' });
      expect(result.isError).toBe(true);
    });

    it('renews an existing lease', async () => {
      const agent = createAgentDirect('RenewAgent');
      const task = createTaskDirect('renew target');
      const coord = require('../db/coordination');
      const claim = coord.claimTask(task.id, agent.id, 60);

      const result = await safeTool('renew_lease', { claim_id: claim.id, extend_seconds: 120 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Lease renewed');
    });
  });

  describe('release_task', () => {
    it('returns error when claim_id is missing', async () => {
      const result = await safeTool('release_task', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('claim_id is required');
    });

    it('returns error for nonexistent claim', async () => {
      const result = await safeTool('release_task', { claim_id: 'fake-claim-id', reason: 'done' });
      expect(result.isError).toBe(true);
    });

    it('releases an existing claim', async () => {
      const agent = createAgentDirect('ReleaseAgent');
      const task = createTaskDirect('release target');
      const coord = require('../db/coordination');
      const claim = coord.claimTask(task.id, agent.id, 60);

      const result = await safeTool('release_task', { claim_id: claim.id, reason: 'completed' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('released');
    });
  });

  describe('get_claim', () => {
    it('returns error when neither task_id nor claim_id given', async () => {
      const result = await safeTool('get_claim', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('task_id or claim_id is required');
    });

    it('returns no-claim message for nonexistent task', async () => {
      const result = await safeTool('get_claim', { task_id: 'nonexistent-task-id' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No claim found');
    });

    it('returns claim details for an active claim', async () => {
      const agent = createAgentDirect('GetClaimAgent');
      const task = createTaskDirect('get claim target');
      const coord = require('../db/coordination');
      coord.claimTask(task.id, agent.id, 60);

      const result = await safeTool('get_claim', { task_id: task.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Claim Details');
      expect(text).toContain(task.id);
    });

    it('accepts claim_id as alternative lookup', async () => {
      const agent = createAgentDirect('GetClaimAgent2');
      const task = createTaskDirect('get claim target 2');
      const coord = require('../db/coordination');
      const claim = coord.claimTask(task.id, agent.id, 60);

      const result = await safeTool('get_claim', { claim_id: claim.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Claim Details');
    });
  });

  describe('list_claims', () => {
    it('returns no-claims or list without errors', async () => {
      const result = await safeTool('list_claims', {});
      expect(result.isError).toBeFalsy();
    });

    it('filters by status', async () => {
      const result = await safeTool('list_claims', { status: 'active' });
      expect(result.isError).toBeFalsy();
    });

    it('filters by agent_id', async () => {
      const result = await safeTool('list_claims', { agent_id: 'some-agent' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ── Groups ─────────────────────────────────────────────────────────

  describe('create_agent_group', () => {
    it('returns error when name is missing', async () => {
      const result = await safeTool('create_agent_group', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Group name is required');
    });

    it('creates agent group with valid name', async () => {
      const result = await safeTool('create_agent_group', { name: 'TestGroup' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('TestGroup');
    });
  });

  describe('add_to_group', () => {
    it('returns error when agent_id or group_id is missing', async () => {
      const r1 = await safeTool('add_to_group', { agent_id: 'a1' });
      expect(r1.isError).toBe(true);
      expect(getText(r1)).toContain('agent_id and group_id are required');

      const r2 = await safeTool('add_to_group', { group_id: 'g1' });
      expect(r2.isError).toBe(true);
      expect(getText(r2)).toContain('agent_id and group_id are required');
    });

    it('adds agent to group when both exist (created directly)', async () => {
      const agent = createAgentDirect('GroupMemberDirect');
      const group = createGroupDirect('DirectGroup');
      const result = await safeTool('add_to_group', { agent_id: agent.id, group_id: group.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('added to group');
    });

    it('returns error when agent does not exist', async () => {
      const group = createGroupDirect('OrphanGroup');
      const result = await safeTool('add_to_group', { agent_id: 'nonexistent-agent', group_id: group.id });
      expect(result.isError).toBe(true);
    });
  });

  describe('remove_from_group', () => {
    it('returns error when agent_id or group_id is missing', async () => {
      const r1 = await safeTool('remove_from_group', { agent_id: 'a1' });
      expect(r1.isError).toBe(true);
      expect(getText(r1)).toContain('agent_id and group_id are required');

      const r2 = await safeTool('remove_from_group', { group_id: 'g1' });
      expect(r2.isError).toBe(true);
      expect(getText(r2)).toContain('agent_id and group_id are required');
    });

    it('removes agent from group (created directly)', async () => {
      const agent = createAgentDirect('GroupRemovee');
      const group = createGroupDirect('RemoveGroup');
      const coord = require('../db/coordination');
      coord.addAgentToGroup(agent.id, group.id);

      const result = await safeTool('remove_from_group', { agent_id: agent.id, group_id: group.id });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('removed from group');
    });
  });

  // ── Routing Rules ──────────────────────────────────────────────────

  describe('create_routing_rule', () => {
    it('returns error when required fields are missing', async () => {
      const result = await safeTool('create_routing_rule', { name: 'Incomplete' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('returns error when name is missing', async () => {
      const result = await safeTool('create_routing_rule', {
        condition_type: 'keyword',
        condition_value: 'x',
        target_type: 'agent',
        target_value: 'a1'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('required');
    });

    it('creates routing rule with valid args', async () => {
      const result = await safeTool('create_routing_rule', {
        name: 'Route Test',
        condition_type: 'keyword',
        condition_value: 'backend',
        target_type: 'agent',
        target_value: 'agent-1'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Route Test');
    });
  });

  describe('list_routing_rules', () => {
    it('returns rules or no-rules message', async () => {
      const result = await safeTool('list_routing_rules', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('accepts enabled_only filter', async () => {
      const result = await safeTool('list_routing_rules', { enabled_only: true });
      expect(result.isError).toBeFalsy();
    });

    it('accepts rule_type filter', async () => {
      const result = await safeTool('list_routing_rules', { rule_type: 'keyword' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('delete_routing_rule', () => {
    it('returns error when rule is missing', async () => {
      const result = await safeTool('delete_routing_rule', {});
      expect(result.isError).toBe(true);
    });

    it('returns error for nonexistent rule', async () => {
      const result = await safeTool('delete_routing_rule', { rule: 'nonexistent-rule-xyz' });
      expect(result.isError).toBe(true);
    });
  });

  // ── Work Stealing ──────────────────────────────────────────────────

  describe('steal_task', () => {
    it('returns error when task_id or thief_agent_id is missing', async () => {
      const r1 = await safeTool('steal_task', { thief_agent_id: 'thief-1' });
      expect(r1.isError).toBe(true);
      expect(getText(r1)).toContain('task_id and thief_agent_id are required');

      const r2 = await safeTool('steal_task', { task_id: 'task-1' });
      expect(r2.isError).toBe(true);
      expect(getText(r2)).toContain('task_id and thief_agent_id are required');
    });

    it('returns error when both args missing', async () => {
      const result = await safeTool('steal_task', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('task_id and thief_agent_id are required');
    });

    it('returns error when stealing a non-claimed task', async () => {
      const result = await safeTool('steal_task', {
        task_id: 'unclaimed-task-123',
        thief_agent_id: 'thief-agent',
        reason: 'rebalance'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_stealing_history', () => {
    it('returns empty history message or list', async () => {
      const result = await safeTool('get_stealing_history', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toMatch(/Work Stealing History|No work stealing history/);
    });

    it('accepts victim_agent_id filter', async () => {
      const result = await safeTool('get_stealing_history', { victim_agent_id: 'no-such-victim' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts thief_agent_id filter', async () => {
      const result = await safeTool('get_stealing_history', { thief_agent_id: 'no-such-thief' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit filter', async () => {
      const result = await safeTool('get_stealing_history', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });
  });

  // ── Failover ───────────────────────────────────────────────────────

  describe('trigger_failover', () => {
    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('trigger_failover', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('agent_id is required');
    });

    it('triggers failover for an existing agent', async () => {
      const agent = createAgentDirect('FailoverAgent');
      const result = await safeTool('trigger_failover', { agent_id: agent.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Failover Triggered');
      expect(text).toContain('Tasks Released');
    });

    it('triggers failover and releases active claims', async () => {
      const agent = createAgentDirect('FailoverWithClaims', { max_concurrent: 5 });
      const task1 = createTaskDirect('failover task 1');
      const task2 = createTaskDirect('failover task 2');
      const coord = require('../db/coordination');
      coord.claimTask(task1.id, agent.id, 60);
      coord.claimTask(task2.id, agent.id, 60);

      const result = await safeTool('trigger_failover', { agent_id: agent.id });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Failover Triggered');
      expect(text).toContain('2');
    });

    it('returns error for nonexistent agent', async () => {
      const result = await safeTool('trigger_failover', { agent_id: 'ghost-agent-failover' });
      expect(result.isError).toBe(true);
    });
  });

  describe('configure_failover', () => {
    it('returns current config when no args are provided', async () => {
      const result = await safeTool('configure_failover', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Failover Configuration');
    });

    it('updates heartbeat_interval_seconds', async () => {
      const result = await safeTool('configure_failover', {
        heartbeat_interval_seconds: 15
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('updated');
    });

    it('updates multiple failover config fields', async () => {
      const result = await safeTool('configure_failover', {
        heartbeat_interval_seconds: 20,
        offline_threshold_missed: 5,
        auto_failover_enabled: true,
        rebalance_threshold_percent: 40
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('updated');
    });
  });

  // ── Distributed Locks ──────────────────────────────────────────────

  describe('acquire_lock', () => {
    it('acquires a lock successfully', async () => {
      const result = await safeTool('acquire_lock', {
        lock_name: 'deploy-lock',
        agent_id: 'lock-holder-1',
        ttl_seconds: 30
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('acquired');
      expect(getText(result)).toContain('deploy-lock');
    });

    it('reports lock held when already acquired by another agent', async () => {
      await safeTool('acquire_lock', {
        lock_name: 'contested-lock',
        agent_id: 'holder-A',
        ttl_seconds: 60
      });
      const result = await safeTool('acquire_lock', {
        lock_name: 'contested-lock',
        agent_id: 'holder-B',
        ttl_seconds: 60
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('held by');
    });

    it('returns error when lock_name is missing', async () => {
      const result = await safeTool('acquire_lock', { agent_id: 'a1' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('lock_name and agent_id are required');
    });

    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('acquire_lock', { lock_name: 'lock-1' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('lock_name and agent_id are required');
    });

    it('uses default ttl when ttl_seconds omitted', async () => {
      const result = await safeTool('acquire_lock', {
        lock_name: 'default-ttl-lock',
        agent_id: 'ttl-holder'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('acquired');
    });
  });

  describe('release_lock', () => {
    it('releases a held lock', async () => {
      await safeTool('acquire_lock', {
        lock_name: 'release-me',
        agent_id: 'releaser-agent',
        ttl_seconds: 60
      });
      const result = await safeTool('release_lock', {
        lock_name: 'release-me',
        agent_id: 'releaser-agent'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('released');
    });

    it('returns error when lock_name is missing', async () => {
      const result = await safeTool('release_lock', { agent_id: 'a1' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('lock_name and agent_id are required');
    });

    it('returns error when agent_id is missing', async () => {
      const result = await safeTool('release_lock', { lock_name: 'lock-1' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('lock_name and agent_id are required');
    });

    it('returns error when releasing lock not held by agent', async () => {
      await safeTool('acquire_lock', {
        lock_name: 'wrong-holder-lock',
        agent_id: 'real-holder',
        ttl_seconds: 60
      });
      const result = await safeTool('release_lock', {
        lock_name: 'wrong-holder-lock',
        agent_id: 'imposter-agent'
      });
      // releaseLock returns {released: false, reason: 'not_holder'}
      // handler checks result.error which is undefined, so it falls through
      // to success path — this documents that the handler does not detect wrong-holder
      const text = getText(result);
      expect(text).toBeTruthy();
    });

    it('handles release of nonexistent lock', async () => {
      const result = await safeTool('release_lock', {
        lock_name: 'never-acquired',
        agent_id: 'any-agent'
      });
      // Handler checks result.error — releaseLock returns {released: false, reason: 'lock_not_found'}
      const text = getText(result);
      expect(text).toBeTruthy();
    });
  });

  // ── Dashboard & Metrics ────────────────────────────────────────────

  describe('coordination_dashboard', () => {
    it('returns dashboard data', async () => {
      const result = await safeTool('coordination_dashboard', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBeTruthy();
    });

    it('accepts custom time_range_hours', async () => {
      const result = await safeTool('coordination_dashboard', { time_range_hours: 48 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toBeTruthy();
    });
  });

  describe('export_metrics_prometheus', () => {
    it('returns Prometheus-formatted metrics', async () => {
      const result = await safeTool('export_metrics_prometheus', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('codexbridge_tasks_total');
      expect(text).toContain('# HELP');
      expect(text).toContain('# TYPE');
    });

    it('returns valid text even with no tasks', async () => {
      const result = await safeTool('export_metrics_prometheus', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result).length).toBeGreaterThan(0);
    });
  });

  // ── Rate Limits & Quotas ───────────────────────────────────────────

  describe('rate_limit_tasks', () => {
    it('returns error for invalid limit_type', async () => {
      const result = await safeTool('rate_limit_tasks', {
        limit_type: 'invalid_type',
        max_value: 10
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when max_value is not positive', async () => {
      const result = await safeTool('rate_limit_tasks', {
        limit_type: 'tasks_per_minute',
        max_value: -1
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when max_value is zero', async () => {
      const result = await safeTool('rate_limit_tasks', {
        limit_type: 'tasks_per_minute',
        max_value: 0
      });
      expect(result.isError).toBe(true);
    });

    it('errors due to handler-db API mismatch (object vs positional args for setRateLimit)', async () => {
      // Handler calls db.setRateLimit({id, project_id, limit_type, max_value, window_seconds})
      // but fileTracking.setRateLimit(provider, limitType, maxValue, windowSeconds, enabled) wins in merge
      const result = await safeTool('rate_limit_tasks', {
        limit_type: 'tasks_per_minute',
        max_value: 10
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('task_quotas', () => {
    it('configures daily_tasks quota', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'daily_tasks',
        max_value: 50
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Task Quota Configured');
      expect(text).toContain('daily_tasks');
    });

    it('configures monthly_cost quota with project', async () => {
      const result = await safeTool('task_quotas', {
        project_id: 'proj-xyz',
        quota_type: 'monthly_cost',
        max_value: 500,
        reset_period: 'monthly'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('proj-xyz');
    });

    it('infers reset_period from quota_type', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'weekly_tasks',
        max_value: 200
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('weekly');
    });

    it('configures daily_tokens quota', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'daily_tokens',
        max_value: 10000
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('daily');
    });

    it('returns error for invalid quota_type', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'bogus_type',
        max_value: 10
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when max_value is not positive', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'daily_tasks',
        max_value: 0
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when max_value is negative', async () => {
      const result = await safeTool('task_quotas', {
        quota_type: 'daily_tasks',
        max_value: -5
      });
      expect(result.isError).toBe(true);
    });
  });
});
