const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');

let testDir;
let origDataDir;
let db;
let mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-coordination-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/coordination');
  mod.setDb(db.getDb());
  mod.setGetTask(taskCore.getTask);
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

function rawDb() {
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function resetState() {
  const conn = rawDb();
  const tables = [
    'coordination_events',
    'work_stealing_log',
    'agent_metrics',
    'task_claims',
    'task_routing_rules',
    'agent_group_members',
    'agent_groups',
    'agents',
    'distributed_locks',
    'tasks'
  ];

  for (const table of tables) {
    conn.prepare(`DELETE FROM ${table}`).run();
  }

  mod.updateFailoverConfig({
    heartbeat_interval_seconds: 30,
    offline_threshold_missed: 3,
    default_lease_seconds: 300,
    auto_failover_enabled: 1,
    auto_rebalance_enabled: 0,
    rebalance_threshold_percent: 30
  });
}

function makeAgent(overrides = {}) {
  const payload = {
    id: overrides.id || randomUUID(),
    name: overrides.name || `agent-${Math.random().toString(16).slice(2, 8)}`,
    capabilities: overrides.capabilities,
    max_concurrent: overrides.max_concurrent,
    agent_type: overrides.agent_type,
    priority: overrides.priority,
    metadata: overrides.metadata
  };
  return mod.registerAgent(payload);
}

function makeTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'coordination test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    priority: overrides.priority || 0,
    tags: overrides.tags,
    project: overrides.project || null
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const setSql = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

describe('coordination module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('agent lifecycle', () => {
    it('registerAgent stores and returns parsed agent fields', () => {
      const agent = makeAgent({
        id: 'agent-a',
        name: 'Alpha',
        capabilities: ['js', 'sql'],
        max_concurrent: 3,
        priority: 7,
        metadata: { zone: 'us-east' }
      });

      expect(agent.id).toBe('agent-a');
      expect(agent.status).toBe('online');
      expect(agent.capabilities).toEqual(['js', 'sql']);
      expect(agent.max_concurrent).toBe(3);
      expect(agent.priority).toBe(7);
      expect(agent.metadata).toEqual({ zone: 'us-east' });
      expect(agent.active_claims).toBe(0);
      expect(Array.isArray(agent.groups)).toBe(true);
    });

    it('registerAgent applies defaults when optional fields are omitted', () => {
      const agent = makeAgent({ id: 'agent-default', name: 'Default Agent' });
      expect(agent.agent_type).toBe('worker');
      expect(agent.max_concurrent).toBe(1);
      expect(agent.priority).toBe(0);
      expect(agent.capabilities).toEqual([]);
      expect(agent.metadata).toBeNull();
    });

    it('getAgent returns null for unknown id', () => {
      expect(mod.getAgent('missing-agent')).toBeNull();
    });

    it('listAgents filters by status and capability', () => {
      makeAgent({ id: 'agent-online', name: 'Online', capabilities: ['js'] });
      makeAgent({ id: 'agent-offline', name: 'Offline', capabilities: ['py'] });
      mod.updateAgent('agent-offline', { status: 'offline' });

      const online = mod.listAgents({ status: 'online' });
      const jsAgents = mod.listAgents({ capability: 'js' });

      expect(online.map(a => a.id)).toEqual(['agent-online']);
      expect(jsAgents.map(a => a.id)).toEqual(['agent-online']);
    });

    it('listAgents filters by group membership', () => {
      makeAgent({ id: 'g-agent-1', name: 'G1' });
      makeAgent({ id: 'g-agent-2', name: 'G2' });
      const group = mod.createAgentGroup({ id: 'grp-a', name: 'Group A' });
      mod.addAgentToGroup('g-agent-1', group.id);

      const inGroup = mod.listAgents({ group_id: group.id });
      expect(inGroup.map(a => a.id)).toEqual(['g-agent-1']);
    });

    it('updateAgent updates only allowed fields', () => {
      makeAgent({ id: 'upd-agent', name: 'Before' });
      const updated = mod.updateAgent('upd-agent', {
        name: 'After',
        capabilities: ['go'],
        metadata: { env: 'test' },
        status: 'busy',
        unsupported: 'ignored'
      });

      expect(updated.name).toBe('After');
      expect(updated.capabilities).toEqual(['go']);
      expect(updated.metadata).toEqual({ env: 'test' });
      expect(updated.status).toBe('busy');
    });

    it('updateAgent returns unchanged agent when no allowed fields are provided', () => {
      makeAgent({ id: 'noop-agent', name: 'Noop' });
      const unchanged = mod.updateAgent('noop-agent', { not_allowed: 123 });
      expect(unchanged.name).toBe('Noop');
    });

    it('updateAgentHeartbeat updates status/load and returns true', () => {
      makeAgent({ id: 'hb-agent', name: 'Heartbeat', max_concurrent: 5 });
      const ok = mod.updateAgentHeartbeat('hb-agent', 2, 'busy');
      const after = mod.getAgent('hb-agent');

      expect(ok).toBe(true);
      expect(after.current_load).toBe(2);
      expect(after.status).toBe('busy');
      expect(after.last_heartbeat_at).toBeTruthy();
    });

    it('updateAgentHeartbeat returns false for unknown agent', () => {
      expect(mod.updateAgentHeartbeat('missing-agent', 1, 'busy')).toBe(false);
    });

    it('checkOfflineAgents marks stale online agents offline', () => {
      makeAgent({ id: 'stale-agent', name: 'Stale' });
      makeAgent({ id: 'fresh-agent', name: 'Fresh' });
      mod.updateFailoverConfig({ heartbeat_interval_seconds: 1, offline_threshold_missed: 1 });

      const oldIso = new Date(Date.now() - 10000).toISOString();
      rawDb().prepare('UPDATE agents SET last_heartbeat_at = ? WHERE id = ?').run(oldIso, 'stale-agent');

      const offline = mod.checkOfflineAgents();
      const stale = mod.getAgent('stale-agent');
      const fresh = mod.getAgent('fresh-agent');

      expect(offline.map(a => a.id)).toEqual(['stale-agent']);
      expect(stale.status).toBe('offline');
      expect(stale.disconnected_at).toBeTruthy();
      expect(fresh.status).toBe('online');
    });

    it('unregisterAgent removes an agent and its group memberships', () => {
      const agent = makeAgent({ id: 'bye-agent', name: 'Bye' });
      const group = mod.createAgentGroup({ id: 'bye-group', name: 'Bye Group' });
      mod.addAgentToGroup(agent.id, group.id);

      const removed = mod.unregisterAgent(agent.id, false);
      const members = rawDb().prepare('SELECT * FROM agent_group_members WHERE agent_id = ?').all(agent.id);

      expect(removed.id).toBe(agent.id);
      expect(mod.getAgent(agent.id)).toBeNull();
      expect(members).toHaveLength(0);
      expect(mod.unregisterAgent('missing-agent')).toBeNull();
    });
  });

  describe('task claiming and leases', () => {
    it('claimTask creates active claim and updates task/agent load', () => {
      const agent = makeAgent({ id: 'claim-agent', name: 'Claimer' });
      const task = makeTask({ id: 'claim-task', status: 'queued' });
      const claim = mod.claimTask(task.id, agent.id, 60);

      const taskAfter = taskCore.getTask(task.id);
      const agentAfter = mod.getAgent(agent.id);

      expect(claim.task_id).toBe(task.id);
      expect(claim.agent_id).toBe(agent.id);
      expect(claim.lease_duration_seconds).toBe(60);
      expect(taskAfter.claimed_by_agent).toBe(agent.id);
      expect(agentAfter.current_load).toBe(1);
    });

    it('claimTask throws when task is missing', () => {
      const agent = makeAgent({ id: 'claim-missing-task-agent', name: 'Agent' });
      expect(() => mod.claimTask('missing-task', agent.id)).toThrow(/Task not found/);
    });

    it('claimTask throws when agent is missing', () => {
      const task = makeTask({ id: 'claim-missing-agent-task' });
      expect(() => mod.claimTask(task.id, 'missing-agent')).toThrow(/Agent not found/);
    });

    it('claimTask prevents double-claim while lease is active', () => {
      const a1 = makeAgent({ id: 'double-a1', name: 'A1' });
      const a2 = makeAgent({ id: 'double-a2', name: 'A2' });
      const task = makeTask({ id: 'double-task' });
      mod.claimTask(task.id, a1.id);

      expect(() => mod.claimTask(task.id, a2.id)).toThrow(/Task already claimed by agent/);
    });

    it('renewLease extends expiration and increments renewals', () => {
      const agent = makeAgent({ id: 'renew-agent', name: 'Renew' });
      const task = makeTask({ id: 'renew-task' });
      const claim = mod.claimTask(task.id, agent.id, 5);
      const renewed = mod.renewLease(claim.id, 120);

      expect(renewed.id).toBe(claim.id);
      expect(renewed.renewals).toBe(1);
      expect(new Date(renewed.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 30000);
    });

    it('renewLease throws for missing claim', () => {
      expect(() => mod.renewLease('missing-claim', 10)).toThrow(/Claim not found/);
    });

    it('renewLease throws when claim is not active', () => {
      const agent = makeAgent({ id: 'inactive-agent', name: 'Inactive' });
      const task = makeTask({ id: 'inactive-task' });
      const claim = mod.claimTask(task.id, agent.id, 30);
      mod.releaseTaskClaim(claim.id, 'test-release');

      expect(() => mod.renewLease(claim.id, 30)).toThrow(/Claim is not active/);
    });

    it('releaseTaskClaim marks claim released, clears task claim, and decrements load', () => {
      const agent = makeAgent({ id: 'rel-agent', name: 'Release' });
      const task = makeTask({ id: 'rel-task' });
      const claim = mod.claimTask(task.id, agent.id);

      const released = mod.releaseTaskClaim(claim.id, 'done');
      const claimRow = rawDb().prepare('SELECT * FROM task_claims WHERE id = ?').get(claim.id);
      const taskAfter = taskCore.getTask(task.id);
      const agentAfter = mod.getAgent(agent.id);

      expect(released.id).toBe(claim.id);
      expect(claimRow.status).toBe('released');
      expect(claimRow.release_reason).toBe('done');
      expect(taskAfter.claimed_by_agent).toBeNull();
      expect(agentAfter.current_load).toBe(0);
      expect(() => mod.releaseTaskClaim('missing-claim', 'x')).toThrow(/Claim not found/);
    });

    it('getClaim resolves by claim id and by task id', () => {
      const agent = makeAgent({ id: 'get-claim-agent', name: 'GetClaim' });
      const task = makeTask({ id: 'get-claim-task' });
      const claim = mod.claimTask(task.id, agent.id);

      const byId = mod.getClaim(claim.id);
      const byTask = mod.getClaim(task.id);

      expect(byId.id).toBe(claim.id);
      expect(byTask.id).toBe(claim.id);
    });

    it('listClaims excludes expired by default and can include them', () => {
      const a1 = makeAgent({ id: 'list-claims-a1', name: 'A1' });
      const task = makeTask({ id: 'list-claims-task' });
      const claim = mod.claimTask(task.id, a1.id);
      rawDb().prepare('UPDATE task_claims SET status = \'expired\' WHERE id = ?').run(claim.id);

      const defaultList = mod.listClaims();
      const withExpired = mod.listClaims({ include_expired: true });

      expect(defaultList.find(c => c.id === claim.id)).toBeFalsy();
      expect(withExpired.find(c => c.id === claim.id)).toBeTruthy();
    });

    it('expireStaleLeases expires old active claims and requeues running tasks', () => {
      const agent = makeAgent({ id: 'stale-lease-agent', name: 'LeaseAgent' });
      const task = makeTask({ id: 'stale-lease-task', status: 'queued' });
      const claim = mod.claimTask(task.id, agent.id);

      patchTask(task.id, { status: 'running' });
      const oldIso = new Date(Date.now() - 120000).toISOString();
      rawDb().prepare('UPDATE task_claims SET lease_expires_at = ? WHERE id = ?').run(oldIso, claim.id);

      const expired = mod.expireStaleLeases();
      const claimAfter = rawDb().prepare('SELECT status FROM task_claims WHERE id = ?').get(claim.id);
      const taskAfter = taskCore.getTask(task.id);
      const agentAfter = mod.getAgent(agent.id);

      expect(expired.map(c => c.id)).toEqual([claim.id]);
      expect(claimAfter.status).toBe('expired');
      expect(taskAfter.status).toBe('queued');
      expect(taskAfter.claimed_by_agent).toBeNull();
      expect(agentAfter.current_load).toBe(0);
    });

    it('getClaimableTasksForAgent returns unclaimed queued tasks matching capabilities', () => {
      const agent = makeAgent({ id: 'claimable-agent', name: 'Claimable', capabilities: ['js'] });
      const other = makeAgent({ id: 'other-agent', name: 'Other' });

      const t1 = makeTask({ id: 'claimable-1', priority: 10 });
      const t2 = makeTask({ id: 'claimable-2', priority: 5 });
      const t3 = makeTask({ id: 'claimable-3', priority: 1 });
      patchTask(t1.id, { required_capabilities: JSON.stringify(['js']) });
      patchTask(t2.id, { required_capabilities: JSON.stringify(['py']) });
      mod.claimTask(t3.id, other.id);

      const claimable = mod.getClaimableTasksForAgent(agent.id, 10);
      const ids = claimable.map(t => t.id);

      expect(ids).toContain(t1.id);
      expect(ids).not.toContain(t2.id);
      expect(ids).not.toContain(t3.id);
      expect(mod.getClaimableTasksForAgent('missing-agent')).toEqual([]);
    });
  });

  describe('groups and routing', () => {
    it('createAgentGroup/getAgentGroup/listAgentGroups work together', () => {
      const group = mod.createAgentGroup({
        id: 'group-core',
        name: 'Core',
        description: 'core workers',
        routing_strategy: 'least_loaded',
        max_agents: 5
      });

      const fetched = mod.getAgentGroup(group.id);
      const listed = mod.listAgentGroups();

      expect(fetched.id).toBe(group.id);
      expect(fetched.members).toEqual([]);
      expect(listed.find(g => g.id === group.id).member_count).toBe(0);
    });

    it('addAgentToGroup adds membership and ignores duplicates', () => {
      const agent = makeAgent({ id: 'group-agent-1', name: 'Group Agent 1' });
      const group = mod.createAgentGroup({ id: 'group-dup', name: 'Dup Group' });

      mod.addAgentToGroup(agent.id, group.id);
      const second = mod.addAgentToGroup(agent.id, group.id);

      expect(second.members).toHaveLength(1);
      expect(second.members[0].id).toBe(agent.id);
    });

    it('addAgentToGroup validates missing agent/group and max capacity', () => {
      const group = mod.createAgentGroup({ id: 'group-cap', name: 'Cap Group', max_agents: 1 });
      const a1 = makeAgent({ id: 'cap-a1', name: 'Cap A1' });
      const a2 = makeAgent({ id: 'cap-a2', name: 'Cap A2' });

      expect(() => mod.addAgentToGroup('missing', group.id)).toThrow(/Agent not found/);
      expect(() => mod.addAgentToGroup(a1.id, 'missing-group')).toThrow(/Group not found/);

      mod.addAgentToGroup(a1.id, group.id);
      expect(() => mod.addAgentToGroup(a2.id, group.id)).toThrow(/maximum capacity/);
    });

    it('removeAgentFromGroup removes membership', () => {
      const agent = makeAgent({ id: 'remove-group-agent', name: 'RG' });
      const group = mod.createAgentGroup({ id: 'remove-group', name: 'Remove Group' });
      mod.addAgentToGroup(agent.id, group.id);

      const updated = mod.removeAgentFromGroup(agent.id, group.id);
      expect(updated.members).toHaveLength(0);
    });

    it('createRoutingRule/listRoutingRules/deleteRoutingRule support filters', () => {
      const r1 = mod.createRoutingRule({
        id: 'rr1',
        name: 'Rule 1',
        priority: 10,
        condition_type: 'project',
        condition_value: 'alpha',
        target_type: 'agent',
        target_value: 'agent-x'
      });
      const r2 = mod.createRoutingRule({
        id: 'rr2',
        name: 'Rule 2',
        priority: 5,
        condition_type: 'keyword',
        condition_value: 'infra',
        target_type: 'group',
        target_value: 'grp-x'
      });
      rawDb().prepare('UPDATE task_routing_rules SET enabled = 0 WHERE id = ?').run(r2.id);

      const enabled = mod.listRoutingRules({ enabled: true });
      const disabled = mod.listRoutingRules({ enabled: false });
      const byTarget = mod.listRoutingRules({ target_type: 'agent' });

      expect(enabled.map(r => r.id)).toEqual([r1.id]);
      expect(disabled.map(r => r.id)).toContain(r2.id);
      expect(byTarget.map(r => r.id)).toContain(r1.id);
      expect(mod.deleteRoutingRule(r2.id)).toBe(true);
      expect(mod.deleteRoutingRule('missing-rule')).toBe(false);
    });

    it('matchRoutingRule prioritizes higher-priority matching rules', () => {
      const high = mod.createRoutingRule({
        id: 'tag-high',
        name: 'Tag High',
        priority: 50,
        condition_type: 'tag',
        condition_value: 'backend',
        target_type: 'agent',
        target_value: 'agent-a'
      });
      mod.createRoutingRule({
        id: 'kw-low',
        name: 'Keyword Low',
        priority: 10,
        condition_type: 'keyword',
        condition_value: 'backend',
        target_type: 'agent',
        target_value: 'agent-b'
      });

      const matched = mod.matchRoutingRule({
        task_description: 'backend task',
        tags: ['backend'],
        project: 'proj',
        working_directory: testDir
      });

      expect(matched.id).toBe(high.id);
    });

    it('matchRoutingRule supports keyword, project and directory conditions', () => {
      const kw = mod.createRoutingRule({
        id: 'rule-kw',
        name: 'KW',
        priority: 30,
        condition_type: 'keyword',
        condition_value: 'database',
        target_type: 'agent',
        target_value: 'a'
      });
      mod.createRoutingRule({
        id: 'rule-project',
        name: 'Project',
        priority: 20,
        condition_type: 'project',
        condition_value: 'proj-a',
        target_type: 'agent',
        target_value: 'b'
      });
      mod.createRoutingRule({
        id: 'rule-dir',
        name: 'Dir',
        priority: 10,
        condition_type: 'directory',
        condition_value: 'src',
        target_type: 'agent',
        target_value: 'c'
      });

      const matched = mod.matchRoutingRule({
        task_description: 'Database migration',
        tags: [],
        project: 'proj-a',
        working_directory: path.join(testDir, 'src')
      });

      expect(matched.id).toBe(kw.id);
    });

    it('routeTaskToAgent honors routing rule targets', () => {
      const agent = makeAgent({ id: 'route-rule-agent', name: 'Rule Agent', priority: 3 });
      mod.createRoutingRule({
        id: 'route-rule',
        name: 'Route by project',
        priority: 100,
        condition_type: 'project',
        condition_value: 'proj-route',
        target_type: 'agent',
        target_value: agent.id
      });

      const selected = mod.routeTaskToAgent({
        task_description: 'anything',
        project: 'proj-route',
        tags: [],
        working_directory: testDir
      });

      expect(selected.id).toBe(agent.id);
    });

    it('routeTaskToAgent uses capability matching then least_loaded strategy', () => {
      const a1 = makeAgent({ id: 'cap-route-a1', name: 'A1', capabilities: ['ts'], max_concurrent: 10 });
      const a2 = makeAgent({ id: 'cap-route-a2', name: 'A2', capabilities: ['ts'], max_concurrent: 2 });
      mod.updateAgentHeartbeat(a1.id, 2, 'online'); // 20%
      mod.updateAgentHeartbeat(a2.id, 1, 'online'); // 50%

      const selected = mod.routeTaskToAgent({
        task_description: 'compile',
        required_capabilities: ['ts'],
        tags: [],
        project: null,
        working_directory: testDir
      });

      expect(selected.id).toBe(a1.id);
    });

    it('routeTaskToAgent falls back to online least-loaded agent and selectAgentByStrategy handles edge cases', () => {
      const a1 = makeAgent({ id: 'fallback-a1', name: 'Fallback 1', max_concurrent: 4, priority: 1 });
      const a2 = makeAgent({ id: 'fallback-a2', name: 'Fallback 2', max_concurrent: 4, priority: 10 });
      mod.updateAgentHeartbeat(a1.id, 0, 'online');
      mod.updateAgentHeartbeat(a2.id, 2, 'online');

      const routed = mod.routeTaskToAgent({
        task_description: 'no special routing',
        tags: [],
        project: null,
        working_directory: testDir
      });
      expect(routed.id).toBe(a1.id);

      const manualLeast = mod.selectAgentByStrategy([a1, a2], 'least_loaded');
      const manualAffinity = mod.selectAgentByStrategy([a1, a2], 'affinity_first');
      const manualRandom = mod.selectAgentByStrategy([a1, a2], 'random');
      const manualRound = mod.selectAgentByStrategy([a1, a2], 'round_robin');
      const none = mod.selectAgentByStrategy([
        { id: 'x', current_load: 2, max_concurrent: 2 },
        { id: 'y', current_load: 1, max_concurrent: 1 }
      ], 'least_loaded');

      expect(manualLeast.id).toBe(a1.id);
      expect(manualAffinity.id).toBe(a2.id);
      expect([a1.id, a2.id]).toContain(manualRandom.id);
      expect([a1.id, a2.id]).toContain(manualRound.id);
      expect(none).toBeNull();
    });
  });

  describe('work stealing and failover', () => {
    it('stealTask throws when no active claim exists', () => {
      const thief = makeAgent({ id: 'steal-thief', name: 'Thief' });
      const task = makeTask({ id: 'steal-no-claim-task' });
      expect(() => mod.stealTask(task.id, thief.id)).toThrow(/No active claim/);
    });

    it('stealTask rolls back all side-effects on claim uniqueness failure (transactional)', () => {
      const victim = makeAgent({ id: 'steal-victim', name: 'Victim' });
      const thief = makeAgent({ id: 'steal-thief-2', name: 'Thief2' });
      const task = makeTask({ id: 'steal-task' });
      const originalClaim = mod.claimTask(task.id, victim.id);

      let err = null;
      try {
        mod.stealTask(task.id, thief.id, 'rebalance');
      } catch (e) {
        err = e;
      }

      const oldClaim = rawDb().prepare('SELECT status, release_reason FROM task_claims WHERE id = ?').get(originalClaim.id);
      const logEntry = rawDb().prepare('SELECT * FROM work_stealing_log WHERE task_id = ?').get(task.id);

      // stealTask is wrapped in db.transaction() so on UNIQUE constraint failure
      // the entire transaction rolls back — old claim stays 'active'
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/UNIQUE constraint failed/i);
      expect(oldClaim.status).toBe('active');
      expect(oldClaim.release_reason).toBeNull();
      expect(logEntry).toBeUndefined();
    });

    it('getStealingHistory filters by victim, thief, and since', () => {
      makeAgent({ id: 'v1', name: 'Victim' });
      makeAgent({ id: 't1', name: 'Thief 1' });
      makeAgent({ id: 't2', name: 'Thief 2' });
      makeTask({ id: 'task-old' });
      makeTask({ id: 'task-now' });

      const now = new Date().toISOString();
      const old = new Date(Date.now() - 86400000).toISOString();
      rawDb().prepare(`
        INSERT INTO work_stealing_log (victim_agent_id, thief_agent_id, task_id, reason, stolen_at)
        VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
      `).run('v1', 't1', 'task-old', 'old', old, 'v1', 't2', 'task-now', 'new', now);

      const byVictim = mod.getStealingHistory({ victim_agent_id: 'v1', limit: 10 });
      const byThief = mod.getStealingHistory({ thief_agent_id: 't2', limit: 10 });
      const recent = mod.getStealingHistory({ since: new Date(Date.now() - 3600000).toISOString(), limit: 10 });

      expect(byVictim.length).toBe(2);
      expect(byThief).toHaveLength(1);
      expect(byThief[0].task_id).toBe('task-now');
      expect(recent).toHaveLength(1);
      expect(recent[0].task_id).toBe('task-now');
    });

    it('triggerFailover releases claims, requeues tasks, and marks agent offline', () => {
      const victim = makeAgent({ id: 'failover-victim', name: 'Victim' });
      const t1 = makeTask({ id: 'failover-task-1' });
      const t2 = makeTask({ id: 'failover-task-2' });
      mod.claimTask(t1.id, victim.id);
      mod.claimTask(t2.id, victim.id);

      const result = mod.triggerFailover(victim.id);

      expect(result.agent_id).toBe(victim.id);
      expect(result.tasks_released).toBe(2);
      expect(result.tasks_reassigned).toBe(0);
      expect(mod.getAgent(victim.id).status).toBe('offline');
      expect(taskCore.getTask(t1.id).status).toBe('queued');
      expect(taskCore.getTask(t2.id).status).toBe('queued');
      expect(() => mod.triggerFailover('missing-agent')).toThrow(/Agent not found/);
    });

    it('triggerFailover with reassignTo tolerates claim errors and keeps reassigned count accurate', () => {
      const victim = makeAgent({ id: 'failover-src', name: 'Src' });
      const target = makeAgent({ id: 'failover-dst', name: 'Dst' });
      const task = makeTask({ id: 'failover-reassign-task' });
      mod.claimTask(task.id, victim.id);

      const result = mod.triggerFailover(victim.id, target.id);

      expect(result.tasks_released).toBe(1);
      expect(result.tasks_reassigned).toBe(0);
      expect(mod.getAgent(target.id).current_load).toBe(0);
    });

    it('getFailoverConfig returns defaults and updateFailoverConfig persists string values', () => {
      const config = mod.getFailoverConfig();
      expect(config.heartbeat_interval_seconds).toBeTruthy();
      expect(config.offline_threshold_missed).toBeTruthy();

      const updated = mod.updateFailoverConfig({
        heartbeat_interval_seconds: 12,
        auto_failover_enabled: 0
      });

      expect(updated.heartbeat_interval_seconds).toBe('12');
      expect(updated.auto_failover_enabled).toBe('0');
    });
  });

  describe('distributed locks', () => {
    it('acquireLock obtains a new lock and checkLock reports it as held', () => {
      const result = mod.acquireLock('lock-a', 'holder-a', 30, JSON.stringify({ pid: 1 }));
      const check = mod.checkLock('lock-a');

      expect(result.acquired).toBe(true);
      expect(check.held).toBe(true);
      expect(check.holder).toBe('holder-a');
      expect(check.holderInfo).toBe(JSON.stringify({ pid: 1 }));
    });

    it('acquireLock blocks other holders when lock is fresh and extends for same holder', () => {
      const first = mod.acquireLock('lock-b', 'holder-1', 30);
      const blocked = mod.acquireLock('lock-b', 'holder-2', 30);
      const extended = mod.acquireLock('lock-b', 'holder-1', 60);

      expect(first.acquired).toBe(true);
      expect(blocked.acquired).toBe(false);
      expect(blocked.holder).toBe('holder-1');
      expect(extended.acquired).toBe(true);
      expect(extended.extended).toBe(true);
    });

    it('updateLockHeartbeat updates holder heartbeat and stale checks reflect changes', () => {
      mod.acquireLock('lock-heartbeat', 'hb-holder', 30);
      const oldIso = new Date(Date.now() - 60000).toISOString();
      rawDb().prepare('UPDATE distributed_locks SET last_heartbeat = ? WHERE lock_name = ?').run(oldIso, 'lock-heartbeat');

      const staleBefore = mod.isLockHeartbeatStale('lock-heartbeat', 1000);
      const updated = mod.updateLockHeartbeat('lock-heartbeat', 'hb-holder');
      const staleAfter = mod.isLockHeartbeatStale('lock-heartbeat', 1000);
      const wrongHolder = mod.updateLockHeartbeat('lock-heartbeat', 'someone-else');
      const missing = mod.isLockHeartbeatStale('missing-lock');

      expect(staleBefore.isStale).toBe(true);
      expect(updated.updated).toBe(true);
      expect(staleAfter.isStale).toBe(false);
      expect(wrongHolder.updated).toBe(false);
      expect(missing.isStale).toBe(false);
    });

    it('forceReleaseStaleLock releases only stale locks', () => {
      mod.acquireLock('lock-stale', 'stale-holder', 30);
      const notStale = mod.forceReleaseStaleLock('lock-stale');
      expect(notStale.released).toBe(false);
      expect(notStale.reason).toBe('lock_not_stale');

      const staleIso = new Date(Date.now() - 60000).toISOString();
      rawDb().prepare('UPDATE distributed_locks SET expires_at = ? WHERE lock_name = ?').run(staleIso, 'lock-stale');
      const released = mod.forceReleaseStaleLock('lock-stale');

      expect(released.released).toBe(true);
      expect(released.previousHolder).toBe('stale-holder');
      expect(mod.checkLock('lock-stale').held).toBe(false);
    });

    it('releaseLock returns reasoned failures and successful release', () => {
      mod.acquireLock('lock-release', 'holder-real', 30);
      const notHolder = mod.releaseLock('lock-release', 'holder-fake');
      const success = mod.releaseLock('lock-release', 'holder-real');
      const missing = mod.releaseLock('missing-lock', 'holder-any');

      expect(notHolder.released).toBe(false);
      expect(notHolder.reason).toBe('not_holder');
      expect(success.released).toBe(true);
      expect(missing.released).toBe(false);
      expect(missing.reason).toBe('lock_not_found');
    });

    it('checkLock marks expired locks and cleanupExpiredLocks removes them', () => {
      mod.acquireLock('lock-expired', 'holder-exp', 30);
      rawDb().prepare('UPDATE distributed_locks SET expires_at = ? WHERE lock_name = ?')
        .run(new Date(Date.now() - 30000).toISOString(), 'lock-expired');

      const checked = mod.checkLock('lock-expired');
      const cleaned = mod.cleanupExpiredLocks();
      const checkedAfter = mod.checkLock('lock-expired');

      expect(checked.held).toBe(false);
      expect(checked.expired).toBe(true);
      expect(cleaned).toBe(1);
      expect(checkedAfter.held).toBe(false);
    });

    it('acquireLock takes over locks with stale lease expiry', () => {
      mod.acquireLock('lock-takeover', 'holder-old', 300);
      rawDb().prepare('UPDATE distributed_locks SET expires_at = ? WHERE lock_name = ?')
        .run(new Date(Date.now() - 60000).toISOString(), 'lock-takeover');

      const takeover = mod.acquireLock('lock-takeover', 'holder-new', 30);
      const check = mod.checkLock('lock-takeover');

      expect(takeover.acquired).toBe(true);
      expect(check.holder).toBe('holder-new');
      expect(check.held).toBe(true);
    });

    it('acquireLock keeps holders with fresh lease even with stale heartbeat', () => {
      mod.acquireLock('lock-heartbeat-only', 'holder-old', 30);
      rawDb().prepare('UPDATE distributed_locks SET last_heartbeat = ?, expires_at = ? WHERE lock_name = ?')
        .run(
          new Date(Date.now() - 60000).toISOString(),
          new Date(Date.now() + 120000).toISOString(),
          'lock-heartbeat-only',
        );

      const takeover = mod.acquireLock('lock-heartbeat-only', 'holder-new', 30);

      expect(takeover.acquired).toBe(false);
      expect(takeover.holder).toBe('holder-old');
    });
  });

  describe('analytics and events', () => {
    it('recordCoordinationEvent inserts event rows', () => {
      mod.recordCoordinationEvent('custom_event', 'agent-x', 'task-y', JSON.stringify({ ok: true }));
      const row = rawDb().prepare('SELECT * FROM coordination_events WHERE event_type = ?').get('custom_event');

      expect(row.agent_id).toBe('agent-x');
      expect(row.task_id).toBe('task-y');
      expect(row.details).toBe(JSON.stringify({ ok: true }));
    });

    it('recordAgentMetric persists metrics and getAgent(includeMetrics) returns them', () => {
      const agent = makeAgent({ id: 'metric-agent', name: 'Metric Agent' });
      mod.recordAgentMetric(agent.id, 'throughput', 12.5, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');

      const withMetrics = mod.getAgent(agent.id, true);
      expect(withMetrics.metrics).toHaveLength(1);
      expect(withMetrics.metrics[0].metric_type).toBe('throughput');
      expect(withMetrics.metrics[0].metric_value).toBe(12.5);
    });

    it('getCoordinationDashboard aggregates agents, claims, events, and locks', () => {
      const a1 = makeAgent({ id: 'dash-a1', name: 'Dash A1', max_concurrent: 3 });
      const a2 = makeAgent({ id: 'dash-a2', name: 'Dash A2', max_concurrent: 2 });
      mod.updateAgent(a2.id, { status: 'offline' });

      const task = makeTask({ id: 'dash-task' });
      const claim = mod.claimTask(task.id, a1.id);
      mod.releaseTaskClaim(claim.id, 'done');
      mod.recordCoordinationEvent('dashboard_event', a1.id, task.id, null);
      mod.acquireLock('dash-lock', 'dash-holder', 30);

      const dashboard = mod.getCoordinationDashboard(24);

      expect(dashboard.agents.total_agents).toBe(2);
      expect(dashboard.agents.online).toBe(1);
      expect(dashboard.agents.offline).toBe(1);
      expect(dashboard.claims.total_claims).toBeGreaterThanOrEqual(1);
      expect(dashboard.events.dashboard_event).toBe(1);
      expect(dashboard.locks.active_locks).toBe(1);
      expect(dashboard.period_hours).toBe(24);
      expect(Array.isArray(dashboard.load_distribution)).toBe(true);
    });
  });
});
