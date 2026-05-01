'use strict';
const retry = require('../plugins/auto-recovery-core/strategies/retry');
const cleanAndRetry = require('../plugins/auto-recovery-core/strategies/clean-and-retry');
const rejectAndAdvance = require('../plugins/auto-recovery-core/strategies/reject-and-advance');
const escalate = require('../plugins/auto-recovery-core/strategies/escalate');

function makeServices(overrides = {}) {
  const calls = {};
  return {
    calls,
    retryFactoryVerify: async (x) => { calls.retry = x; return { ok: true }; },
    cleanupWorktreeBuildArtifacts: async () => ({ deleted: ['/x/obj'], stacks: ['dotnet'] }),
    rejectWorkItem: async (x) => { calls.reject = x; return { ok: true }; },
    advanceLoop: async (x) => { calls.advance = x; return { ok: true }; },
    rejectGate: async (x) => { calls.rejectGate = x; return { ok: true }; },
    startLoop: async (x) => { calls.startLoop = x; return { ok: true }; },
    pauseProject: async (x) => { calls.pause = x; return { ok: true }; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const project = { id: 'p1', worktree_path: '/tmp/wt' };
const decision = { stage: 'verify', action: 'worktree_verify_failed', batch_id: 'b1' };

describe('simple strategies', () => {
  it('retry submits retryFactoryVerify', async () => {
    const services = makeServices();
    const r = await retry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(r.next_action).toBe('retry');
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('retry on READY_FOR_PLAN routes to advanceLoop, NOT approveGate', async () => {
    // Regression: pre-fix, the retry strategy called approveGate with
    // "READY_FOR_PLAN", which threw "Invalid gate stage" because READY_FOR_*
    // is not a valid LOOP_STATE. The strategy must detect the prefix and
    // route to advanceLoop (which knows how to transition out of ready state).
    const services = makeServices();
    let approveGateCalled = false;
    services.approveGate = async () => { approveGateCalled = true; };
    const readyProject = { id: 'p1', loop_paused_at_stage: 'READY_FOR_PLAN' };
    const r = await retry.run({
      project: readyProject,
      decision: { stage: 'plan', action: 'plan_recovery_failed', batch_id: null },
      services,
      classification: { category: 'unknown' },
    });
    expect(r.success).toBe(true);
    expect(r.next_action).toBe('retry');
    expect(r.outcome.mode).toBe('advance_loop_from_ready');
    expect(r.outcome.paused_stage).toBe('READY_FOR_PLAN');
    expect(services.calls.advance).toEqual({ project_id: 'p1' });
    expect(approveGateCalled).toBe(false);
  });

  it('retry on a normal non-verify gate (EXECUTE) still uses approveGate', async () => {
    // Sanity check: the READY_FOR_X carve-out shouldn't disturb the existing
    // approveGate path for paused-at-X gates.
    const services = makeServices();
    let approveGateCalled = null;
    services.approveGate = async (args) => { approveGateCalled = args; };
    const pausedProject = { id: 'p1', loop_paused_at_stage: 'EXECUTE' };
    const r = await retry.run({
      project: pausedProject,
      decision: { stage: 'execute', action: 'paused_at_gate', batch_id: 'b1' },
      services,
      classification: { category: 'unknown' },
    });
    expect(r.outcome.mode).toBe('approve_gate');
    expect(approveGateCalled).toEqual({ project_id: 'p1', stage: 'EXECUTE' });
  });

  it('clean_and_retry cleans then retries', async () => {
    const services = makeServices();
    const r = await cleanAndRetry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(r.success).toBe(true);
    expect(r.outcome.cleanup.deleted).toEqual(['/x/obj']);
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('clean_and_retry still retries when cleanup finds nothing', async () => {
    const services = makeServices({
      cleanupWorktreeBuildArtifacts: async () => ({ deleted: [], stacks: [] }),
    });
    await cleanAndRetry.run({ project, decision, services, classification: { category: 'transient' } });
    expect(services.calls.retry).toEqual({ project_id: 'p1' });
  });

  it('reject_and_advance rejects and advances', async () => {
    const services = makeServices();
    const workDecision = { ...decision, outcome: { work_item_id: 42 } };
    const r = await rejectAndAdvance.run({
      project, decision: workDecision, services,
      classification: { category: 'structural_failure' },
    });
    expect(r.next_action).toBe('advance');
    expect(services.calls.reject).toEqual({
      project_id: 'p1', work_item_id: 42, reason: 'auto_recovery_reject_and_advance',
    });
    expect(services.calls.advance).toEqual({ project_id: 'p1' });
  });

  it('reject_and_advance rejects a paused gate when normal advance is blocked', async () => {
    const services = makeServices({
      advanceLoop: async (x) => {
        services.calls.advance = x;
        throw new Error('Loop is paused — use approveGate to continue');
      },
    });
    const workDecision = {
      stage: 'execute',
      action: 'paused_at_gate',
      outcome: { work_item_id: 42 },
    };
    const r = await rejectAndAdvance.run({
      project, decision: workDecision, services,
      classification: { category: 'structural_failure' },
    });
    expect(r.outcome.gate_rejected).toBe(true);
    expect(services.calls.reject).toEqual({
      project_id: 'p1', work_item_id: 42, reason: 'auto_recovery_reject_and_advance',
    });
    expect(services.calls.rejectGate).toEqual({ project_id: 'p1', stage: 'EXECUTE' });
  });

  it('reject_and_advance starts a fresh loop when the previous instance is already idle', async () => {
    const services = makeServices({
      advanceLoop: async (x) => {
        services.calls.advance = x;
        throw new Error('Loop not started for this project');
      },
    });
    const workDecision = {
      stage: 'execute',
      action: 'paused_at_gate',
      outcome: { work_item_id: 42 },
    };
    const r = await rejectAndAdvance.run({
      project, decision: workDecision, services,
      classification: { category: 'structural_failure' },
    });
    expect(r.outcome.loop_started).toBe(true);
    expect(services.calls.reject).toEqual({
      project_id: 'p1', work_item_id: 42, reason: 'auto_recovery_reject_and_advance',
    });
    expect(services.calls.startLoop).toEqual({ project_id: 'p1', auto_advance: true });
  });

  it('escalate pauses the project', async () => {
    const services = makeServices();
    const r = await escalate.run({ project, decision, services, classification: { category: 'unknown' } });
    expect(r.next_action).toBe('escalate');
    expect(services.calls.pause).toEqual({ project_id: 'p1', reason: 'auto_recovery_exhausted' });
  });

  it('each strategy exposes name + applicable_categories + run + max_attempts_per_project', () => {
    for (const s of [retry, cleanAndRetry, rejectAndAdvance, escalate]) {
      expect(typeof s.name).toBe('string');
      expect(Array.isArray(s.applicable_categories)).toBe(true);
      expect(typeof s.run).toBe('function');
    }
    expect(retry.max_attempts_per_project).toBeGreaterThan(0);
  });
});
