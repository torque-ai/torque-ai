'use strict';
const { describe, it, expect } = require('vitest');
const freshSession = require('../plugins/auto-recovery-core/strategies/retry-with-fresh-session');
const fallback = require('../plugins/auto-recovery-core/strategies/fallback-provider');
const retryPlan = require('../plugins/auto-recovery-core/strategies/retry-plan-generation');
const freshWorktree = require('../plugins/auto-recovery-core/strategies/fresh-worktree');

function baseServices(overrides = {}) {
  const calls = {};
  return {
    calls,
    cancelTask: async (x) => { calls.cancel = x; return { ok: true }; },
    smartSubmitTask: async (x) => { calls.submit = x; return { task_id: 't1' }; },
    retryFactoryVerify: async (x) => { calls.retry = x; return { ok: true }; },
    retryPlanGeneration: async (x) => { calls.plan = x; return { ok: true }; },
    recreateWorktree: async (x) => { calls.recreate = x; return { worktree_path: '/new' }; },
    logger: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

describe('complex strategies', () => {
  it('retry_with_fresh_session cancels then resubmits', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { generation_task_id: 'tX', work_item_id: 7 }, batch_id: 'b1' };
    const r = await freshSession.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'sandbox_interrupt' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.cancel).toEqual({ task_id: 'tX', reason: 'auto_recovery_fresh_session' });
  });

  it('fallback_provider resubmits with a different provider', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { last_provider: 'codex', work_item_id: 9 }, batch_id: 'b1' };
    const r = await fallback.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'plan_failure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.submit.provider_hint).toBeDefined();
    expect(services.calls.submit.provider_hint).not.toBe('codex');
  });

  it('retry_plan_generation re-invokes architect', async () => {
    const services = baseServices();
    const decision = { stage: 'plan', action: 'cannot_generate_plan',
                       outcome: { work_item_id: 42 }, batch_id: 'b1' };
    const r = await retryPlan.run({
      project: { id: 'p1' }, decision, services,
      classification: { category: 'plan_failure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.plan).toEqual({ project_id: 'p1', work_item_id: 42 });
  });

  it('fresh_worktree recreates then retries verify', async () => {
    const services = baseServices();
    const decision = { stage: 'verify', action: 'worktree_verify_failed', batch_id: 'b1',
                       outcome: { worktree_path: '/old', branch: 'feat/x' } };
    const r = await freshWorktree.run({
      project: { id: 'p1', worktree_path: '/old' }, decision, services,
      classification: { category: 'infrastructure' },
    });
    expect(r.next_action).toBe('retry');
    expect(services.calls.recreate).toEqual({ project_id: 'p1', batch_id: 'b1', branch: 'feat/x' });
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });
});
