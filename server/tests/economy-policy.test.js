'use strict';
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('economy/policy.js', () => {
  let db;
  let policy;

  beforeAll(() => {
    ({ db } = setupTestDb('economy-policy'));
    policy = require('../economy/policy');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    db.setConfig('economy_policy', null);
  });

  function createWorkflow(policyValue) {
    const workflowId = `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    db.createWorkflow({
      id: workflowId,
      name: `Economy Workflow ${workflowId}`,
      status: 'pending'
    });
    db.updateWorkflow(workflowId, { economy_policy: JSON.stringify(policyValue) });
    return workflowId;
  }

  it('returns a complete default policy', () => {
    const { getDefaultPolicy } = policy;
    const current = getDefaultPolicy();

    expect(current.enabled).toBe(false);
    expect(current.trigger).toBeNull();
    expect(current.auto_trigger_threshold).toBe(85);
    expect(current.complexity_exempt).toBe(true);
    expect(current.provider_tiers.preferred).toContain('hashline-ollama');
    expect(current.provider_tiers.allowed).toContain('deepinfra');
    expect(current.provider_tiers.blocked).toContain('codex');
    expect(current.auto_lift_conditions).toEqual({
      budget_reset: true,
      codex_recovered: true,
      utilization_below: 50,
    });
  });

  it('returns a deep-cloned default policy each call', () => {
    const { getDefaultPolicy } = policy;
    const first = getDefaultPolicy();
    const second = getDefaultPolicy();
    first.provider_tiers.preferred.push('extra-provider');
    expect(second.provider_tiers.preferred).not.toContain('extra-provider');
  });

  it('reads null when global policy is not configured', () => {
    const { getGlobalEconomyPolicy } = policy;
    const current = getGlobalEconomyPolicy();
    expect(current).toBeNull();
  });

  it('merges defaults when setting a partial global policy', () => {
    const { setGlobalEconomyPolicy, getGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });

    const current = getGlobalEconomyPolicy();
    expect(current).not.toBeNull();
    expect(current.enabled).toBe(true);
    expect(current.trigger).toBe('manual');
    expect(current.provider_tiers.preferred).toEqual(policy.DEFAULT_POLICY.provider_tiers.preferred);
    expect(current.auto_trigger_threshold).toBe(policy.DEFAULT_POLICY.auto_trigger_threshold);
    expect(current.auto_lift_conditions).toEqual(policy.DEFAULT_POLICY.auto_lift_conditions);
  });

  it('returns null when economy is off at every scope', () => {
    const { resolveEconomyPolicy } = policy;
    const resolved = resolveEconomyPolicy({}, null, null);
    expect(resolved).toBeNull();
  });

  it('task-level economy false overrides global policy', () => {
    const { setGlobalEconomyPolicy, resolveEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
    const resolved = resolveEconomyPolicy({ economy: false }, null, null);
    expect(resolved).toBeNull();
  });

  it('task-level economy true enables economy regardless of scope', () => {
    const { setGlobalEconomyPolicy, resolveEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto', reason: 'global auto' });
    const resolved = resolveEconomyPolicy({ economy: true }, null, null);
    expect(resolved).not.toBeNull();
    expect(resolved.enabled).toBe(true);
    expect(resolved.trigger).toBe('manual');
    expect(resolved.complexity_exempt).toBe(true);
  });

  it('task-level economy object override enables with explicit fields', () => {
    const { resolveEconomyPolicy } = policy;
    const resolved = resolveEconomyPolicy({ economy: { complexity_exempt: false, reason: 'task override' } }, null, null);
    expect(resolved).not.toBeNull();
    expect(resolved.enabled).toBe(true);
    expect(resolved.trigger).toBe('manual');
    expect(resolved.complexity_exempt).toBe(false);
    expect(resolved.reason).toBe('task override');
  });

  it('parses workflow-scoped economy policy JSON', () => {
    const { setGlobalEconomyPolicy, getWorkflowEconomyPolicy, resolveEconomyPolicy } = policy;
    const workflowPolicy = { ...policy.getDefaultPolicy(), enabled: true, trigger: 'manual' };
    const workflowId = createWorkflow(workflowPolicy);

    const stored = getWorkflowEconomyPolicy(workflowId);
    expect(stored).toEqual(workflowPolicy);

    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual', reason: 'global manual' });
    const resolved = resolveEconomyPolicy({}, workflowId, '/tmp/workflow-project');
    expect(resolved.provider_tiers.preferred).toEqual(policy.DEFAULT_POLICY.provider_tiers.preferred);
    expect(resolved.trigger).toBe('manual');
  });

  it('returns null for workflow economy policy parse failure', () => {
    const { getWorkflowEconomyPolicy } = policy;
    const workflowId = `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    db.createWorkflow({ id: workflowId, name: 'Bad policy workflow', status: 'pending' });
    db.updateWorkflow(workflowId, { economy_policy: '{invalid-json' });

    expect(getWorkflowEconomyPolicy(workflowId)).toBeNull();
  });

  it('reads project-scoped economy policy (JSON string)', () => {
    const { getProjectEconomyPolicy, getDefaultPolicy, setGlobalEconomyPolicy, resolveEconomyPolicy } = policy;
    const project = `C:/projects/econ-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectPolicy = JSON.stringify({ ...getDefaultPolicy(), enabled: true, trigger: 'manual', reason: 'project' });
    db.setProjectConfig(project, { economy_policy: projectPolicy });

    const parsed = getProjectEconomyPolicy(project);
    expect(parsed).toEqual(JSON.parse(projectPolicy));

    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto', reason: 'global' });
    const resolved = resolveEconomyPolicy({}, null, project);
    expect(resolved.trigger).toBe('manual');
    expect(resolved.reason).toBe('project');
  });

  it('supports project policy objects returned directly from getProjectConfig', () => {
    const { getProjectEconomyPolicy } = policy;
    const original = db.getProjectConfig;
    db.getProjectConfig = () => ({ economy_policy: { enabled: true, trigger: 'manual', reason: 'direct object' } });

    try {
      const resolved = getProjectEconomyPolicy('/tmp/unused');
      expect(resolved).toEqual({ enabled: true, trigger: 'manual', reason: 'direct object' });
    } finally {
      db.getProjectConfig = original;
    }
  });

  it('returns null for missing project economy policy', () => {
    const { getProjectEconomyPolicy } = policy;
    expect(getProjectEconomyPolicy('/tmp/absent-project')).toBeNull();
  });

  it('returns project over global and workflow over project in resolution order', () => {
    const { setGlobalEconomyPolicy, resolveEconomyPolicy } = policy;
    const project = `C:/projects/order-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual', reason: 'global' });
    db.setProjectConfig(project, {
      economy_policy: JSON.stringify({ ...policy.getDefaultPolicy(), enabled: true, trigger: 'auto', reason: 'project' })
    });
    const workflowId = createWorkflow({ ...policy.getDefaultPolicy(), enabled: true, trigger: 'auto', reason: 'workflow' });

    const resolved = resolveEconomyPolicy({}, workflowId, project);
    expect(resolved.reason).toBe('workflow');
    expect(resolved.trigger).toBe('auto');
  });

  it('parses workflow and project JSON safely with invalid input', () => {
    const { getProjectEconomyPolicy, getWorkflowEconomyPolicy } = policy;
    const project = `C:/projects/invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    db.setProjectConfig(project, { economy_policy: '{not-json' });
    const workflowId = `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    db.createWorkflow({ id: workflowId, name: 'bad wf', status: 'pending' });
    db.updateWorkflow(workflowId, { economy_policy: '{bad-json' });

    expect(getProjectEconomyPolicy(project)).toBeNull();
    expect(getWorkflowEconomyPolicy(workflowId)).toBeNull();
  });

  it('filters providers only when economy is enabled', () => {
    const { filterProvidersForEconomy } = policy;
    const policyObject = policy.getDefaultPolicy();
    policyObject.enabled = true;
    expect(filterProvidersForEconomy(policyObject)).not.toBeNull();

    const disabled = policy.getDefaultPolicy();
    disabled.enabled = false;
    expect(filterProvidersForEconomy(disabled)).toBeNull();
  });

  it('returns separated provider lists and combined fallback provider list', () => {
    const { filterProvidersForEconomy } = policy;
    const p = policy.getDefaultPolicy();
    p.enabled = true;
    const filtered = filterProvidersForEconomy(p);
    expect(filtered.isEconomy).toBe(true);
    expect(filtered.preferred).toEqual(policy.DEFAULT_POLICY.provider_tiers.preferred);
    expect(filtered.allowed).toEqual(policy.DEFAULT_POLICY.provider_tiers.allowed);
    expect(filtered.blocked).toEqual(policy.DEFAULT_POLICY.provider_tiers.blocked);
    expect(filtered.providers).toEqual([
      ...policy.DEFAULT_POLICY.provider_tiers.preferred,
      ...policy.DEFAULT_POLICY.provider_tiers.allowed,
    ]);
  });

  it('handles empty preferred list in filtering', () => {
    const { filterProvidersForEconomy } = policy;
    const modified = policy.getDefaultPolicy();
    modified.enabled = true;
    modified.provider_tiers.preferred = [];
    const filtered = filterProvidersForEconomy(modified);
    expect(filtered.preferred).toEqual([]);
    expect(filtered.providers).toEqual(modified.provider_tiers.allowed);
    expect(filtered.allowed).toEqual(policy.DEFAULT_POLICY.provider_tiers.allowed);
  });

  it('returns current economy state from global policy: off/manual/auto', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.OFF);

    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.MANUAL);

    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.AUTO);
  });

  it('applies OFF -> MANUAL transition', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy(null);
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.OFF);

    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.MANUAL);
  });

  it('applies OFF -> AUTO transition', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy(null);
    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.AUTO);
  });

  it('applies MANUAL -> OFF transition', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.MANUAL);

    setGlobalEconomyPolicy(null);
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.OFF);
  });

  it('does not keep auto state when manual override is set', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.AUTO);

    setGlobalEconomyPolicy({ enabled: true, trigger: 'manual' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.MANUAL);
  });

  it('replaces auto with off only when explicitly disabled', () => {
    const { getEconomyState, setGlobalEconomyPolicy } = policy;
    setGlobalEconomyPolicy({ enabled: true, trigger: 'auto' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.AUTO);

    setGlobalEconomyPolicy({ enabled: false, trigger: 'manual' });
    expect(getEconomyState()).toBe(policy.ECONOMY_STATE.OFF);
  });
});
