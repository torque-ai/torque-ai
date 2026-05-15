import { describe, it, expect, vi } from 'vitest';
import {
  createPrioritizeStageRunner,
  createPlanStageRunner,
  createExecuteStageRunner,
  isPlanFileWorkItem,
  createVerifyStageRunner,
  createLearnStageRunner,
  createIdleStageRunner,
} from '../factory/stages/index.js';

const baseProject = { id: 42 };
const baseInstance = { id: 'inst-1', batch_id: 'batch-1' };

describe('PRIORITIZE adapter', () => {
  it('returns disposition=continue when legacy emits a work_item', async () => {
    const exec = vi.fn(async () => ({
      work_item: { id: 'wi-7', kind: 'plan_file' },
      stage_result: { open_count: 3 },
      reason: 'picked highest score',
    }));
    const run = createPrioritizeStageRunner({ executePrioritizeStage: exec });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(exec).toHaveBeenCalledWith(baseProject, baseInstance, null);
    expect(outcome.disposition).toBe('continue');
    expect(outcome.workItem.id).toBe('wi-7');
    expect(outcome.stageResult.open_count).toBe(3);
    expect(outcome.reason).toBe('picked highest score');
  });

  it('returns disposition=idle when legacy emits no work_item', async () => {
    const run = createPrioritizeStageRunner({ executePrioritizeStage: async () => ({ work_item: null, reason: 'queue empty' }) });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.disposition).toBe('idle');
    expect(outcome.workItem).toBeNull();
  });

  it('throws on missing dep / missing ctx pieces', async () => {
    expect(() => createPrioritizeStageRunner({})).toThrow(/executePrioritizeStage is required/);
    const run = createPrioritizeStageRunner({ executePrioritizeStage: async () => null });
    await expect(run({ project: { id: null }, instance: baseInstance })).rejects.toThrow(/project\.id/);
    await expect(run({ project: baseProject, instance: { id: null } })).rejects.toThrow(/instance\.id/);
  });
});

describe('PLAN adapter', () => {
  it('materialized plan → continue + stageResult.status=materialized', async () => {
    const run = createPlanStageRunner({ executePlanStage: async () => ({ plan_path: '/repo/plans/foo.md' }) });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.stageResult.status).toBe('materialized');
    expect(outcome.stageResult.plan_path).toBe('/repo/plans/foo.md');
  });

  it('deferred plan → pause at EXECUTE_DEFERRED with status=deferred', async () => {
    const run = createPlanStageRunner({
      executePlanStage: async () => ({ deferred: true, plan_generation_task_id: 'task-99' }),
    });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('EXECUTE_DEFERRED');
    expect(outcome.stageResult.status).toBe('deferred');
    expect(outcome.stageResult.plan_generation_task_id).toBe('task-99');
  });

  it('no plan_path and no defer → status=failed', async () => {
    const run = createPlanStageRunner({ executePlanStage: async () => ({}) });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.stageResult.status).toBe('failed');
  });
});

describe('EXECUTE adapter', () => {
  it('routes plan-file work items to executePlanFileStage', async () => {
    const planFn = vi.fn(async () => ({ batch_id: 'b-1', tasks_submitted: 4 }));
    const nonPlanFn = vi.fn();
    const run = createExecuteStageRunner({
      executeNonPlanFileStage: nonPlanFn,
      executePlanFileStage: planFn,
    });
    const workItem = { id: 'wi-1', origin: { plan_path: '/repo/plans/foo.md' } };
    const outcome = await run({ project: baseProject, instance: baseInstance, workItem });
    expect(planFn).toHaveBeenCalled();
    expect(nonPlanFn).not.toHaveBeenCalled();
    expect(outcome.disposition).toBe('continue');
    expect(outcome.batchId).toBe('b-1');
    expect(outcome.stageResult.mode).toBe('plan_file');
    expect(outcome.stageResult.tasks_submitted).toBe(4);
  });

  it('routes other work items to executeNonPlanFileStage', async () => {
    const planFn = vi.fn();
    const nonPlanFn = vi.fn(async () => ({ batch_id: 'b-2', tasks_submitted: 1 }));
    const run = createExecuteStageRunner({
      executeNonPlanFileStage: nonPlanFn,
      executePlanFileStage: planFn,
    });
    const outcome = await run({ project: baseProject, instance: baseInstance, workItem: { id: 'wi-2' } });
    expect(nonPlanFn).toHaveBeenCalled();
    expect(outcome.stageResult.mode).toBe('non_plan_file');
  });

  it('null legacy return → disposition=idle', async () => {
    const run = createExecuteStageRunner({
      executeNonPlanFileStage: async () => null,
      executePlanFileStage: async () => null,
    });
    const outcome = await run({ project: baseProject, instance: baseInstance, workItem: { id: 'wi-3' } });
    expect(outcome.disposition).toBe('idle');
  });

  it('stop_execution → disposition=pause', async () => {
    const run = createExecuteStageRunner({
      executeNonPlanFileStage: async () => ({ stop_execution: true, batch_id: 'b-3', reason: 'awaiting gate' }),
      executePlanFileStage: async () => null,
    });
    const outcome = await run({ project: baseProject, instance: baseInstance, workItem: { id: 'wi-4' } });
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('EXECUTE');
    expect(outcome.reason).toBe('awaiting gate');
  });

  it('isPlanFileWorkItem detects work item by origin.plan_path', () => {
    expect(isPlanFileWorkItem({ origin: { plan_path: '/x.md' } })).toBe(true);
    expect(isPlanFileWorkItem({ origin: {} })).toBe(false);
    expect(isPlanFileWorkItem(null)).toBe(false);
  });
});

describe('VERIFY adapter', () => {
  it('passing verify → disposition=continue, nextState passed through', async () => {
    const run = createVerifyStageRunner({
      executeVerifyStage: async () => ({ next_state: 'LEARN', status: 'passed', exit_code: 0 }),
    });
    const outcome = await run({ project: baseProject, instance: baseInstance, batchId: 'b-9' });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('LEARN');
    expect(outcome.stageResult.status).toBe('passed');
  });

  it('failing verify → disposition=pause at VERIFY', async () => {
    const run = createVerifyStageRunner({
      executeVerifyStage: async () => ({ status: 'failed', exit_code: 1, output_tail: 'AssertionError: oops' }),
    });
    const outcome = await run({ project: baseProject, instance: baseInstance, batchId: 'b-10' });
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('VERIFY');
    expect(outcome.stageResult.exit_code).toBe(1);
    expect(outcome.stageResult.output_tail).toMatch(/AssertionError/);
  });
});

describe('LEARN adapter', () => {
  it('passes through analysis fields and routes to IDLE', async () => {
    const run = createLearnStageRunner({
      executeLearnStage: async () => ({
        feedback_id: 'fb-1',
        summary: 'all good',
        shipping_result: { status: 'shipped' },
      }),
    });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('IDLE');
    expect(outcome.stageResult.feedback_id).toBe('fb-1');
    expect(outcome.stageResult.shipped_as_noop).toBe(false);
  });

  it('detects noop_shipped from shipping_result.status', async () => {
    const run = createLearnStageRunner({
      executeLearnStage: async () => ({ shipping_result: { status: 'noop_shipped' } }),
    });
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.stageResult.shipped_as_noop).toBe(true);
  });
});

describe('IDLE adapter', () => {
  it('returns disposition=idle without calling any executor', async () => {
    const run = createIdleStageRunner();
    const outcome = await run({ project: baseProject, instance: baseInstance });
    expect(outcome.disposition).toBe('idle');
    expect(outcome.stageResult).toBeNull();
  });

  it('throws on missing ctx.project.id', async () => {
    const run = createIdleStageRunner();
    await expect(run({})).rejects.toThrow(/project\.id/);
  });
});

describe('all adapter factories — contract surface', () => {
  it('each factory rejects a missing primary dep', () => {
    expect(() => createPrioritizeStageRunner({})).toThrow();
    expect(() => createPlanStageRunner({})).toThrow();
    expect(() => createExecuteStageRunner({})).toThrow();
    expect(() => createExecuteStageRunner({ executeNonPlanFileStage: () => null })).toThrow(/executePlanFileStage/);
    expect(() => createVerifyStageRunner({})).toThrow();
    expect(() => createLearnStageRunner({})).toThrow();
    // IDLE has no required dep
    expect(() => createIdleStageRunner()).not.toThrow();
  });
});
