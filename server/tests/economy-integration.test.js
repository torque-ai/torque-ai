'use strict';

const path = require('path');
const {
  setupTestDb,
  teardownTestDb,
  safeTool,
  getText,
  rawDb,
} = require('./vitest-setup');

describe('economy integration', () => {
  let db;
  let testDir;
  let policyMod;
  let triggerMod;
  let queueReroute;

  beforeAll(() => {
    ({ db, testDir } = setupTestDb('economy-integration'));
    policyMod = require('../economy/policy');
    triggerMod = require('../economy/triggers');
    queueReroute = require('../economy/queue-reroute');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    db.setConfig('economy_policy', null);
    db.setConfig('smart_routing_enabled', '1');
    db.setConfig('codex_quota_exhausted', '0');
    db.setConfig('cost_days_remaining', '');
    db.setConfig('budget_period_reset', '0');
    db.setConfig('codex_enabled', '1');

    const raw = rawDb();
    raw.prepare('DELETE FROM tasks').run();
    raw.prepare('DELETE FROM cost_budgets').run();
    raw.prepare('DELETE FROM provider_usage').run();
    raw.prepare('DELETE FROM project_config').run();

    if (typeof db.updateProvider === 'function') {
      db.updateProvider('deepinfra', { enabled: 0 });
      db.updateProvider('google-ai', { enabled: 0 });
      db.updateProvider('openrouter', { enabled: 0 });
      db.updateProvider('hyperbolic', { enabled: 0 });
      db.updateProvider('aider-ollama', { enabled: 1 });
      db.updateProvider('hashline-ollama', { enabled: 1 });
      db.updateProvider('codex', { enabled: 1 });
    }
  });

  function parseTaskId(text) {
    const match = text.match(/\|\s*Task ID\s*\|\s*`([^`]+)`/);
    return match ? match[1] : null;
  }

  function parseProvider(text) {
    const match = text.match(/\|\s*Provider\s*\|\s*\*\*([^*]+)\*\*/);
    return match ? match[1] : null;
  }

  function parseStatus(result) {
    const text = getText(result);
    return text ? JSON.parse(text) : {};
  }

  function setEconomyPolicy(overrides = {}) {
    const next = policyMod.getDefaultPolicy();
    if (overrides.provider_tiers) {
      next.provider_tiers = {
        ...next.provider_tiers,
        ...overrides.provider_tiers,
      };
    }
    Object.assign(next, overrides);
    policyMod.setGlobalEconomyPolicy(next);
    return next;
  }

  function setProviderEnabled(provider, enabled) {
    if (typeof db.updateProvider === 'function') {
      db.updateProvider(provider, { enabled: enabled ? 1 : 0 });
    }
  }

  function makeQueuedTask(taskId, overrides = {}) {
    const description = overrides.task_description || 'Route test task';
    const provider = overrides.provider || 'codex';
    const row = db.createTask(description, {
      id: taskId,
      provider,
      working_directory: testDir,
      status: overrides.status || 'queued',
      metadata: overrides.metadata || '{}',
      complexity: overrides.complexity || 'simple',
    });

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(overrides, 'original_provider')) {
      patch.original_provider = overrides.original_provider;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'metadata_override')) {
      patch.metadata = overrides.metadata_override;
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'complexity')) {
      patch.complexity = overrides.complexity;
    }
    if (Object.keys(patch).length > 0) {
      db.updateTask(row, patch);
    }

    return row;
  }

  function readTask(taskId) {
    return db.getTask(taskId);
  }

  function seedBudget({ name = 'economy-budget', budgetUsd = 100, provider = null, period = 'monthly' } = {}) {
    if (typeof db.setBudget !== 'function') {
      return null;
    }
    return db.setBudget(name, budgetUsd, provider, period, 85);
  }

  function seedProviderUsage(provider, costEstimate, recordedAt = new Date().toISOString()) {
    rawDb().prepare(`
      INSERT INTO provider_usage (provider, task_id, cost_estimate, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(provider, `budget-${provider}`, costEstimate, recordedAt);
  }

  // ── Routing integration

  describe('routing integration', () => {
    it('routes simple economy task to enabled economy preferred provider', async () => {
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['deepinfra'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      const result = await safeTool('smart_submit_task', {
        task: 'Prepare the deployment checklist for the next release cycle.',
        working_directory: testDir,
      });

      expect(result.isError).toBe(false);
      const text = getText(result);
      const taskId = parseTaskId(text);
      const provider = parseProvider(text);
      expect(taskId).toBeTruthy();
      expect(provider).toBe('deepinfra');

      const task = readTask(taskId);
      expect(task.provider).toBe('deepinfra');
      const meta = task?.metadata || {};
      expect(meta.user_provider_override).toBe(false);
    });

    it('does not apply economy routing for complex task (complexity_exempt)', async () => {
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['deepinfra'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
        complexity_exempt: true,
      });

      const result = await safeTool('smart_submit_task', {
        task: 'Implement a distributed role-based authentication pipeline with multi-service token propagation, ' +
          'then wire policy checks into the message bus, and finally add observability for request failures across all hosts.',
        working_directory: testDir,
      });

      expect(result.isError).toBe(false);
      const text = getText(result);
      const taskId = parseTaskId(text);
      const provider = parseProvider(text);

      expect(taskId).toBeTruthy();
      expect(provider).not.toBe('deepinfra');
      expect(db.determineTaskComplexity((readTask(taskId) || {}).task_description || '', []))
        .toBe('complex');
    });

    it('respects explicit provider override and keeps requested provider', async () => {
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['deepinfra'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      const result = await safeTool('smart_submit_task', {
        task: 'Audit routing for release notes across all environment manifests.',
        working_directory: testDir,
        provider: 'deepinfra',
      });

      expect(result.isError).toBe(false);
      const text = getText(result);
      const taskId = parseTaskId(text);
      const provider = parseProvider(text);

      expect(taskId).toBeTruthy();
      expect(provider).toBe('deepinfra');

      const task = readTask(taskId);
      const meta = task?.metadata || {};
      expect(meta.user_provider_override).toBe(true);
      expect(meta.requested_provider).toBe('deepinfra');
    });

    it('respects override_provider alias the same way as provider', async () => {
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['deepinfra'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      const result = await safeTool('smart_submit_task', {
        task: 'Create an audit matrix for all scheduled tasks and publish it.',
        working_directory: testDir,
        override_provider: 'deepinfra',
      });

      expect(result.isError).toBe(false);
      const text = getText(result);
      const taskId = parseTaskId(text);
      const provider = parseProvider(text);

      expect(taskId).toBeTruthy();
      expect(provider).toBe('deepinfra');

      const task = readTask(taskId);
      const meta = task?.metadata || {};
      expect(meta.user_provider_override).toBe(true);
      expect(meta.requested_provider).toBe('deepinfra');
    });

    it('keeps complexity metadata for normal and economy-enabled submission', async () => {
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['deepinfra'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      const result = await safeTool('smart_submit_task', {
        task: 'Build end-to-end migration path for cross-domain authorization headers.',
        working_directory: testDir,
      });

      expect(result.isError).toBe(false);
      const task = readTask(parseTaskId(getText(result)));
      expect(task?.complexity).toBe('normal');
      expect(task?.metadata.smart_routing).toBe(true);
    });

    it('analyzeTaskForRouting picks preferred economy provider when enabled globally', () => {
      setProviderEnabled('hashline-ollama', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['hashline-ollama'],
          allowed: ['aider-ollama'],
          blocked: ['codex', 'claude-cli'],
        },
      });

      const routing = db.analyzeTaskForRouting(
        'Write a concise summary of planned engineering experiments.',
        testDir,
      );

      expect(routing.provider).toBe('hashline-ollama');
      expect(routing.provider).not.toBe('codex');
      expect(routing.provider).not.toBe('claude-cli');
      expect(routing.reason).toContain('Economy mode preferred provider');
    });

    it('bypasses economy for complex tasks when complexity_exempt is true', () => {
      setProviderEnabled('hashline-ollama', true);
      setProviderEnabled('deepinfra', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        complexity_exempt: true,
        provider_tiers: {
          preferred: ['hashline-ollama'],
          allowed: ['deepinfra'],
          blocked: ['codex', 'claude-cli'],
        },
      });

      const task = 'Implement a distributed role-based authentication pipeline with cross-service token propagation, ' +
        'policy checks, and observability for request failures across all services.';

      const withEconomy = db.analyzeTaskForRouting(task, testDir);
      const withEconomyOff = db.analyzeTaskForRouting(task, testDir, [], { economy: false });

      expect(db.determineTaskComplexity(task, [])).toBe('complex');
      expect(withEconomy.provider).toBe(withEconomyOff.provider);
      expect(withEconomy.provider).not.toBe('hashline-ollama');
    });

    it('respects task-level economy:false override and routes normally', () => {
      setProviderEnabled('hashline-ollama', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['hashline-ollama'],
          allowed: [],
          blocked: ['codex', 'claude-cli'],
        },
      });

      const task = 'Summarize the onboarding checklist for new team members.';
      const withEconomy = db.analyzeTaskForRouting(task, testDir);
      const normalRouting = db.analyzeTaskForRouting(task, testDir, [], { economy: false });

      expect(withEconomy.provider).toBe('hashline-ollama');
      expect(normalRouting.provider).not.toBe('hashline-ollama');
    });
  });

  // ── Queue rerouting

  describe('queue re-routing', () => {
    it('reroutes queued tasks on activation and leaves running tasks untouched', () => {
      setProviderEnabled('aider-ollama', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['aider-ollama'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      makeQueuedTask('econ-queued-1', {
        task_description: 'Refactor a small utility module.',
        provider: 'codex',
        status: 'queued',
        original_provider: null,
        metadata_override: '{}',
      });

      makeQueuedTask('econ-running-1', {
        task_description: 'Refactor a small utility module while running.',
        provider: 'codex',
        status: 'running',
        original_provider: null,
        metadata_override: '{}',
      });

      const policy = policyMod.getGlobalEconomyPolicy();
      const rerouteResult = queueReroute.onEconomyActivated(policy);

      expect(rerouteResult).toMatchObject({ rerouted: 1, skipped: 0 });
      expect(readTask('econ-queued-1').provider).toBe('aider-ollama');
      expect(readTask('econ-running-1').provider).toBe('codex');
    });

    it('skips queued task rerouting when user override is present', () => {
      setProviderEnabled('aider-ollama', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        provider_tiers: {
          preferred: ['aider-ollama'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      makeQueuedTask('econ-queued-override', {
        task_description: 'Update one test helper class.',
        provider: 'codex',
        status: 'queued',
        original_provider: null,
        metadata_override: { user_provider_override: true },
      });

      const policy = policyMod.getGlobalEconomyPolicy();
      const rerouteResult = queueReroute.rerouteQueuedTasks('global', policy);

      expect(rerouteResult).toMatchObject({ rerouted: 0, skipped: 1 });
      expect(readTask('econ-queued-override').provider).toBe('codex');
    });

    it('does not reroute complex queued tasks when complexity_exempt is enabled', () => {
      setProviderEnabled('aider-ollama', true);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
        complexity_exempt: true,
        provider_tiers: {
          preferred: ['aider-ollama'],
          allowed: [],
          blocked: ['codex', 'claude-cli', 'anthropic'],
        },
      });

      makeQueuedTask('econ-queued-complex', {
        task_description: 'Build a multi-service pipeline with real-time event fan-out.',
        provider: 'codex',
        status: 'queued',
        complexity: 'complex',
        original_provider: null,
        metadata_override: '{}',
      });

      const policy = policyMod.getGlobalEconomyPolicy();
      const rerouteResult = queueReroute.rerouteQueuedTasks('global', policy);

      expect(rerouteResult).toMatchObject({ rerouted: 0, skipped: 1 });
      expect(readTask('econ-queued-complex').provider).toBe('codex');
    });

    it('does not reroute queued tasks when economy is disabled', () => {
      setEconomyPolicy({
        enabled: false,
      });

      makeQueuedTask('econ-queued-disabled', {
        task_description: 'Small housekeeping docs task.',
        provider: 'codex',
        status: 'queued',
        original_provider: null,
        metadata_override: '{}',
      });

      const rerouteResult = queueReroute.rerouteQueuedTasks('global', policyMod.getGlobalEconomyPolicy());

      expect(rerouteResult).toMatchObject({ rerouted: 0, skipped: 0 });
      expect(readTask('econ-queued-disabled').provider).toBe('codex');
    });
  });

  // ── Auto-trigger / auto-lift

  describe('auto-trigger and auto-lift', () => {
    it('budget threshold exceeded => auto-trigger conditions satisfied', () => {
      setEconomyPolicy({ enabled: false });
      seedBudget({ name: 'monthly-exp', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 90);

      const trigger = triggerMod.checkAutoTriggerConditions();
      expect(trigger.shouldTrigger).toBe(true);
      expect(trigger.reasons.join(' ')).toContain('budget utilization above 85%');
    });

    it('budget below threshold => no auto-trigger conditions', () => {
      setEconomyPolicy({ enabled: false });
      seedBudget({ name: 'monthly-safe', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 10);

      const trigger = triggerMod.checkAutoTriggerConditions();
      expect(trigger.shouldTrigger).toBe(false);
      expect(trigger.reasons).toHaveLength(0);
    });

    it('auto-trigger fires and sets state to AUTO', () => {
      setEconomyPolicy({ enabled: false });
      seedBudget({ name: 'auto-monthly', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 90);

      const trigger = triggerMod.checkAutoTriggerConditions();
      expect(trigger.shouldTrigger).toBe(true);
      if (trigger.shouldTrigger) {
        triggerMod.activateEconomyMode('auto', trigger.reasons.join('; '));
      }

      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.AUTO);
      expect(policyMod.getGlobalEconomyPolicy().trigger).toBe('auto');
    });

    it('all lift conditions met => auto-lift available', () => {
      seedBudget({ name: 'monthly-lift', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 10);
      db.setConfig('budget_period_reset', '1');
      triggerMod.activateEconomyMode('auto', 'seed');

      const policy = policyMod.getGlobalEconomyPolicy();
      const lift = triggerMod.checkAutoLiftConditions(policy);

      expect(lift.shouldLift).toBe(true);
      expect(lift.reasons).toEqual([]);
    });

    it('auto state with lift conditions met => auto-lift fires', () => {
      setEconomyPolicy({
        enabled: true,
        trigger: 'auto',
      });
      seedBudget({ name: 'monthly-lift-fire', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 10);
      db.setConfig('budget_period_reset', '1');
      db.setConfig('codex_quota_exhausted', '0');

      const policy = policyMod.getGlobalEconomyPolicy();
      const lift = triggerMod.checkAutoLiftConditions(policy);
      expect(lift.shouldLift).toBe(true);

      triggerMod.deactivateEconomyMode(lift.reasons.join('; ') || 'economy lift');
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.OFF);
    });

    it('manual economy state does not auto-lift automatically', () => {
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
      });
      seedBudget({ name: 'monthly-no-lift', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 10);
      db.setConfig('budget_period_reset', '1');
      db.setConfig('codex_quota_exhausted', '0');

      const policy = policyMod.getGlobalEconomyPolicy();
      const lift = triggerMod.checkAutoLiftConditions(policy);
      expect(lift.shouldLift).toBe(true);
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.MANUAL);
    });
  });

  // ── Policy resolution

  describe('policy resolution', () => {
    it('resolveEconomyPolicy merges defaults when global policy is on', () => {
      const defaultPolicy = policyMod.getDefaultPolicy();
      setEconomyPolicy({ enabled: true, trigger: 'manual' });

      const resolved = policyMod.resolveEconomyPolicy({}, null, null);

      expect(resolved).not.toBeNull();
      expect(resolved.enabled).toBe(true);
      expect(resolved.trigger).toBe('manual');
      expect(resolved.provider_tiers).toEqual(defaultPolicy.provider_tiers);
    });

    it('filterProvidersForEconomy returns preferred/allowed/blocked split', () => {
      const filtered = policyMod.filterProvidersForEconomy({
        enabled: true,
        provider_tiers: {
          preferred: ['hashline-ollama', 'aider-ollama'],
          allowed: ['deepinfra'],
          blocked: ['codex', 'claude-cli'],
        },
      });

      expect(filtered).toMatchObject({
        preferred: ['hashline-ollama', 'aider-ollama'],
        allowed: ['deepinfra'],
        blocked: ['codex', 'claude-cli'],
        providers: ['hashline-ollama', 'aider-ollama', 'deepinfra'],
        isEconomy: true,
      });
    });
  });

  // ── MCP tools

  describe('MCP economy tools', () => {
    it('get_economy_status returns an off status by default', async () => {
      const result = await safeTool('get_economy_status', {});
      const status = parseStatus(result);

      expect(result.isError).not.toBe(true);
      expect(status.state).toBe('off');
      expect(status.enabled).toBe(false);
      expect(status.trigger).toBeNull();
      expect(status.scope).toBe('global');
    });

    it('set_economy_mode enables and disables global economy', async () => {
      const enableResult = await safeTool('set_economy_mode', {
        scope: 'global',
        enabled: true,
      });
      expect(enableResult.isError).not.toBe(true);

      const enabledStatus = parseStatus(await safeTool('get_economy_status', {}));
      expect(enabledStatus.state).toBe('manual');
      expect(enabledStatus.enabled).toBe(true);
      expect(enabledStatus.trigger).toBe('manual');

      const disableResult = await safeTool('set_economy_mode', {
        scope: 'global',
        enabled: false,
      });
      expect(disableResult.isError).not.toBe(true);

      const disabledStatus = parseStatus(await safeTool('get_economy_status', {}));
      expect(disabledStatus.state).toBe('off');
      expect(disabledStatus.enabled).toBe(false);
      expect(disabledStatus.trigger).toBeNull();
    });

    it('set_economy_mode with project scope persists in project_config', async () => {
      const enableResult = await safeTool('set_economy_mode', {
        scope: 'project',
        working_directory: testDir,
        enabled: true,
      });
      expect(enableResult.isError).not.toBe(true);

      const project = path.basename(testDir);
      const row = rawDb().prepare('SELECT economy_policy FROM project_config WHERE project = ?').get(project);
      expect(row?.economy_policy).toBeTruthy();
      expect(JSON.parse(row.economy_policy).enabled).toBe(true);
      expect(JSON.parse(row.economy_policy).trigger).toBe('manual');

      const disableResult = await safeTool('set_economy_mode', {
        scope: 'project',
        working_directory: testDir,
        enabled: false,
      });
      expect(disableResult.isError).not.toBe(true);

      const cleared = rawDb().prepare('SELECT economy_policy FROM project_config WHERE project = ?').get(project);
      expect(cleared?.economy_policy).toBeNull();
    });

    it('project scope set updates status response when project is active', async () => {
      await safeTool('set_economy_mode', {
        scope: 'project',
        working_directory: testDir,
        enabled: true,
      });

      const status = parseStatus(await safeTool('get_economy_status', { working_directory: testDir }));
      expect(status.enabled).toBe(true);
      expect(status.scope).toBe('project');
      expect(status.state).toBe('manual');
    });
  });

  // ── State machine

  describe('state machine', () => {
    it('OFF + setGlobalEconomyPolicy({enabled:true, trigger:\"manual\"}) returns manual state', () => {
      db.setConfig('economy_policy', null);
      setEconomyPolicy({
        enabled: true,
        trigger: 'manual',
      });

      expect(policyMod.getEconomyState()).toBe('manual');
    });

    it('OFF + activateEconomyMode(\"auto\", \"budget\") returns auto state', () => {
      db.setConfig('economy_policy', null);
      triggerMod.activateEconomyMode('auto', 'budget');

      expect(policyMod.getEconomyState()).toBe('auto');
      expect(policyMod.getGlobalEconomyPolicy()?.trigger).toBe('auto');
    });

    it('AUTO + deactivateEconomyMode(\"conditions clear\") returns off state', () => {
      setEconomyPolicy({ enabled: true, trigger: 'auto' });
      expect(policyMod.getEconomyState()).toBe('auto');

      triggerMod.deactivateEconomyMode('conditions clear');
      expect(policyMod.getEconomyState()).toBe('off');
    });

    it('MANUAL + deactivateEconomyMode(\"user disabled\") returns off state', () => {
      setEconomyPolicy({ enabled: true, trigger: 'manual' });
      expect(policyMod.getEconomyState()).toBe('manual');

      triggerMod.deactivateEconomyMode('user disabled');
      expect(policyMod.getEconomyState()).toBe('off');
    });

    it('OFF -> manual on -> MANUAL', async () => {
      await safeTool('set_economy_mode', { scope: 'global', enabled: false });
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.OFF);

      const result = await safeTool('set_economy_mode', { scope: 'global', enabled: true });
      expect(result.isError).not.toBe(true);
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.MANUAL);
    });

    it('OFF -> auto trigger -> AUTO', async () => {
      await safeTool('set_economy_mode', { scope: 'global', enabled: false });
      seedBudget({ name: 'state-off-auto', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 90);

      const trigger = triggerMod.checkAutoTriggerConditions();
      expect(trigger.shouldTrigger).toBe(true);
      triggerMod.activateEconomyMode('auto', trigger.reasons.join('; '));

      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.AUTO);
    });

    it('AUTO -> lift -> OFF', async () => {
      setEconomyPolicy({ enabled: true, trigger: 'auto' });
      seedBudget({ name: 'state-auto-lift', budgetUsd: 100, period: 'monthly', provider: null });
      seedProviderUsage('openrouter', 10);
      db.setConfig('budget_period_reset', '1');

      const policy = policyMod.getGlobalEconomyPolicy();
      const lift = triggerMod.checkAutoLiftConditions(policy);
      expect(lift.shouldLift).toBe(true);

      triggerMod.deactivateEconomyMode('auto lift');
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.OFF);
    });

    it('MANUAL -> off -> OFF', async () => {
      await safeTool('set_economy_mode', { scope: 'global', enabled: true });
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.MANUAL);

      await safeTool('set_economy_mode', { scope: 'global', enabled: false });
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.OFF);
    });

    it('AUTO -> manual on -> MANUAL', async () => {
      triggerMod.activateEconomyMode('auto', 'seed');
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.AUTO);

      const result = await safeTool('set_economy_mode', { scope: 'global', enabled: true });
      expect(result.isError).not.toBe(true);
      expect(policyMod.getEconomyState()).toBe(policyMod.ECONOMY_STATE.MANUAL);
      expect(policyMod.getGlobalEconomyPolicy().trigger).toBe('manual');
    });
  });
});
