import { describe, it, expect, vi } from 'vitest';
import {
  createVerifyStageRunner,
  createLearnStageRunner,
} from '../factory/stages/index.js';

const baseProject = { id: 42 };
const baseInstance = { id: 'inst-1', batch_id: 'batch-1' };

describe('VERIFY runner (Phase 2c Step B — policy lifted in)', () => {
  // Build the 8-dep bundle; per-test overrides supply the executor's
  // legacy return and the already-verified / terminal inputs.
  function makeVerifyDeps(overrides = {}) {
    const movedInstance = { id: 'inst-1', batch_id: 'batch-1', loop_state: 'LEARN' };
    const pausedInstance = { id: 'inst-1', batch_id: 'batch-1', paused_at_stage: 'VERIFY' };
    return {
      executeVerifyStage: overrides.executeVerifyStage || (async () => ({ status: 'passed', next_state: 'LEARN' })),
      getLatestStageDecision: overrides.getLatestStageDecision || (() => null),
      hasVerifiedBatchDecision: overrides.hasVerifiedBatchDecision || (() => false),
      isTerminalVerifyOutcome: overrides.isTerminalVerifyOutcome || (() => false),
      finalizeTerminalVerifyOutcome: overrides.finalizeTerminalVerifyOutcome
        || (() => ({ new_state: 'PAUSED', reason: 'verify_failed' })),
      tryMoveInstanceToStage: overrides.tryMoveInstanceToStage
        || vi.fn(() => ({ instance: movedInstance, blocked: false })),
      updateInstanceAndSync: overrides.updateInstanceAndSync || vi.fn(() => pausedInstance),
      nowIso: overrides.nowIso || (() => '2026-05-15T00:00:00Z'),
      _movedInstance: movedInstance,
      _pausedInstance: pausedInstance,
    };
  }
  const verifyCtx = () => ({
    project: baseProject,
    instance: { ...baseInstance, work_item_id: 'wi-1' },
    batchId: 'batch-1',
    previousState: 'EXECUTE',
    instance_id: 'inst-1',
  });

  it('throws when a required dep is missing', () => {
    expect(() => createVerifyStageRunner({ executeVerifyStage: async () => null }))
      .toThrow(/dep 'getLatestStageDecision' is required/);
  });

  it('verified batch → disposition=continue, nextState=LEARN, move issued', async () => {
    const deps = makeVerifyDeps();
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('LEARN');
    expect(outcome.reason).toBe('verified_batch');
    expect(outcome.advanceResult).toBeNull();
    expect(deps.tryMoveInstanceToStage).toHaveBeenCalled();
  });

  it('pause_at_stage → disposition=pause, instance updated, no advanceResult', async () => {
    const deps = makeVerifyDeps({
      executeVerifyStage: async () => ({ status: 'failed', pause_at_stage: 'VERIFY', reason: 'tests red' }),
    });
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('VERIFY');
    expect(outcome.reason).toBe('tests red');
    expect(outcome.advanceResult).toBeNull();
    expect(deps.updateInstanceAndSync).toHaveBeenCalled();
  });

  it('terminal verify outcome → disposition=terminate, advanceResult from finalize', async () => {
    const deps = makeVerifyDeps({
      executeVerifyStage: async () => ({ status: 'failed', exit_code: 1 }),
      isTerminalVerifyOutcome: () => true,
      finalizeTerminalVerifyOutcome: () => ({ new_state: 'PAUSED', reason: 'verify_terminal' }),
    });
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.nextState).toBe('PAUSED');
    expect(outcome.advanceResult).toMatchObject({ new_state: 'PAUSED', reason: 'verify_terminal' });
  });

  it('already-verified batch short-circuits the executor', async () => {
    const exec = vi.fn(async () => ({ status: 'passed' }));
    const deps = makeVerifyDeps({
      executeVerifyStage: exec,
      hasVerifiedBatchDecision: () => true,
      getLatestStageDecision: () => ({ action: 'verified_batch' }),
    });
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(exec).not.toHaveBeenCalled();
    expect(outcome.legacy).toMatchObject({ status: 'skipped', reason: 'batch_already_verified' });
    expect(outcome.disposition).toBe('continue');
  });

  it('approved rerun bypasses the already-verified short-circuit', async () => {
    const exec = vi.fn(async () => ({ status: 'passed' }));
    const deps = makeVerifyDeps({
      executeVerifyStage: exec,
      hasVerifiedBatchDecision: () => true,
      getLatestStageDecision: () => ({ action: 'gate_approved' }),
    });
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(exec).toHaveBeenCalled();
    expect(outcome.reason).toBe('verify_rerun_completed');
  });

  it('lean stageResult carries status/exit_code; full return rides the legacy bridge', async () => {
    const legacy = { status: 'passed', exit_code: 0, output_tail: 'ok', fix_task_id: null, extra: 'kept' };
    const deps = makeVerifyDeps({ executeVerifyStage: async () => legacy });
    const run = createVerifyStageRunner(deps);
    const outcome = await run(verifyCtx());
    expect(outcome.stageResult).toEqual({ status: 'passed', exit_code: 0, output_tail: 'ok', fix_task_id: null });
    expect(outcome.legacy).toBe(legacy);
  });
});

describe('LEARN runner (Phase 2c Step B — policy lifted in)', () => {
  // Build the 9-dep bundle; per-test overrides supply the executor's
  // analysis and the project-pause / auto_continue inputs.
  function makeLearnDeps(overrides = {}) {
    const movedInstance = { id: 'inst-1', batch_id: null, loop_state: 'SENSE' };
    const updatedInstance = { id: 'inst-1', batch_id: 'batch-1', paused_at_stage: 'LEARN' };
    return {
      executeLearnStage: overrides.executeLearnStage || (async () => ({ feedback_id: 'fb', summary: 's' })),
      getProjectOrThrow: overrides.getProjectOrThrow || (() => ({ id: 42, name: 'demo' })),
      isProjectPauseActive: overrides.isProjectPauseActive || (() => false),
      parseProjectConfigObject: overrides.parseProjectConfigObject || (() => ({})),
      tryMoveInstanceToStage: overrides.tryMoveInstanceToStage
        || vi.fn(() => ({ instance: movedInstance, blocked: false })),
      terminateInstanceAndSync: overrides.terminateInstanceAndSync || vi.fn(),
      recordFactoryIdleIfExhausted: overrides.recordFactoryIdleIfExhausted || vi.fn(),
      updateInstanceAndSync: overrides.updateInstanceAndSync || vi.fn(() => updatedInstance),
      nowIso: overrides.nowIso || (() => '2026-05-15T00:00:00Z'),
      _movedInstance: movedInstance,
      _updatedInstance: updatedInstance,
    };
  }
  const learnCtx = () => ({
    project: baseProject,
    instance: baseInstance,
    batchId: 'batch-1',
    previousState: 'VERIFY',
    instance_id: 'inst-1',
  });

  it('throws when a required dep is missing', () => {
    expect(() => createLearnStageRunner({ executeLearnStage: async () => null }))
      .toThrow(/dep 'getProjectOrThrow' is required/);
    expect(() => createLearnStageRunner({})).toThrow(/dep '.*' is required/);
  });

  it('shipping paused → disposition=pause, instance updated, no advanceResult', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({
        feedback_id: 'fb-1',
        shipping_result: { status: 'paused', pause_at_stage: 'LEARN', reason: 'gate_wait' },
      }),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('LEARN');
    expect(outcome.reason).toBe('gate_wait');
    expect(outcome.advanceResult).toBeNull();
    expect(outcome.instance).toBe(deps._updatedInstance);
    expect(deps.updateInstanceAndSync).toHaveBeenCalled();
    expect(deps.terminateInstanceAndSync).not.toHaveBeenCalled();
  });

  it('project paused after LEARN → disposition=terminate, advanceResult to IDLE', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({ feedback_id: 'fb-2' }),
      isProjectPauseActive: () => true,
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.advanceResult).toMatchObject({
      new_state: 'IDLE',
      reason: 'project_paused_after_learn',
      previous_state: 'VERIFY',
      instance_id: 'inst-1',
    });
    expect(deps.terminateInstanceAndSync).toHaveBeenCalledWith('inst-1');
    expect(deps.recordFactoryIdleIfExhausted).toHaveBeenCalled();
  });

  it('automation-ready auto_continue=true → disposition=continue, nextState=SENSE, recycle move issued', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({ feedback_id: 'fb-3' }),
      getProjectOrThrow: () => ({
        id: 42,
        name: 'demo',
        status: 'running',
        trust_level: 'dark',
        config: { loop: { auto_continue: true } },
      }),
      parseProjectConfigObject: () => ({ loop: { auto_continue: true } }),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('SENSE');
    expect(outcome.reason).toBeNull();
    expect(outcome.advanceResult).toBeNull();
    expect(deps.tryMoveInstanceToStage).toHaveBeenCalledWith(
      baseInstance, 'SENSE', { batch_id: null, work_item_id: null, paused_at_stage: null },
    );
  });

  it('auto_continue but recycle blocked → reason=stage_occupied', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({ feedback_id: 'fb-3b' }),
      getProjectOrThrow: () => ({
        id: 42,
        name: 'demo',
        status: 'running',
        trust_level: 'dark',
        config: { loop: { auto_continue: true } },
      }),
      parseProjectConfigObject: () => ({ loop: { auto_continue: true } }),
      tryMoveInstanceToStage: vi.fn(() => ({ instance: baseInstance, blocked: true })),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('continue');
    expect(outcome.reason).toBe('stage_occupied');
  });

  it('approval-gated auto_continue terminates after LEARN instead of recycling', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({ feedback_id: 'fb-3c' }),
      getProjectOrThrow: () => ({
        id: 42,
        name: 'demo',
        status: 'running',
        trust_level: 'autonomous',
        config: { loop: { auto_continue: true } },
      }),
      parseProjectConfigObject: () => ({ loop: { auto_continue: true } }),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.advanceResult).toMatchObject({ new_state: 'IDLE', reason: 'learn_completed' });
    expect(deps.tryMoveInstanceToStage).not.toHaveBeenCalled();
  });

  it('no auto_continue → disposition=terminate, advanceResult learn_completed', async () => {
    const deps = makeLearnDeps({
      executeLearnStage: async () => ({ feedback_id: 'fb-4', summary: 'done' }),
      parseProjectConfigObject: () => ({ loop: { auto_continue: false } }),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.advanceResult).toMatchObject({ new_state: 'IDLE', reason: 'learn_completed' });
    expect(outcome.advanceResult.stage_result).toMatchObject({ feedback_id: 'fb-4' });
    expect(deps.terminateInstanceAndSync).toHaveBeenCalledWith('inst-1');
  });

  it('lean stageResult: shipped_as_noop derived, analysis carried on the bridge field', async () => {
    const analysis = { feedback_id: 'fb-5', summary: 'noop', shipping_result: { status: 'noop_shipped' } };
    const deps = makeLearnDeps({
      executeLearnStage: async () => analysis,
      parseProjectConfigObject: () => ({ loop: { auto_continue: false } }),
    });
    const run = createLearnStageRunner(deps);
    const outcome = await run(learnCtx());
    expect(outcome.stageResult).toEqual({ shipped_as_noop: true, feedback_id: 'fb-5', summary: 'noop' });
    expect(outcome.analysis).toBe(analysis);
  });
});
