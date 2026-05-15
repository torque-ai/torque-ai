import { describe, it, expect, vi } from 'vitest';
import { createSenseStageRunner } from '../factory/stages/sense.js';

describe('SENSE stage adapter (Phase 2c-adapt slice 1)', () => {
  it('wraps executeSenseStage into a (ctx) => StageOutcome runner', async () => {
    const fakeSummary = { balance: 0.5, dimension_count: 3, weakest_dimension: 'reliability' };
    const exec = vi.fn(() => fakeSummary);
    const runSenseStage = createSenseStageRunner({ executeSenseStage: exec });

    const ctx = { project: { id: 42 }, instance: { id: 'inst-1' } };
    const outcome = await runSenseStage(ctx);

    expect(exec).toHaveBeenCalledWith(42, ctx.instance);
    expect(outcome).toEqual({
      disposition: 'continue',
      nextState: null,
      stageResult: { summary: fakeSummary },
    });
  });

  it('passes null instance when ctx.instance is missing', async () => {
    const exec = vi.fn(() => null);
    const runSenseStage = createSenseStageRunner({ executeSenseStage: exec });

    const ctx = { project: { id: 7 } };
    const outcome = await runSenseStage(ctx);

    expect(exec).toHaveBeenCalledWith(7, null);
    expect(outcome.disposition).toBe('continue');
    expect(outcome.stageResult.summary).toBeNull();
  });

  it('normalizes an undefined-returning executor into stageResult.summary = null', async () => {
    const exec = vi.fn(() => undefined);
    const runSenseStage = createSenseStageRunner({ executeSenseStage: exec });

    const outcome = await runSenseStage({ project: { id: 1 } });
    expect(outcome.stageResult.summary).toBeNull();
  });

  it('throws when executeSenseStage dep is missing', () => {
    expect(() => createSenseStageRunner({})).toThrow(/executeSenseStage is required/);
    expect(() => createSenseStageRunner()).toThrow(/executeSenseStage is required/);
  });

  it('throws when ctx.project.id is missing at call time', async () => {
    const runSenseStage = createSenseStageRunner({ executeSenseStage: () => null });
    await expect(runSenseStage({})).rejects.toThrow(/project\.id/);
    await expect(runSenseStage({ project: {} })).rejects.toThrow(/project\.id/);
  });

  it('contract-binds disposition=continue (SENSE always advances; starvation is PRIORITIZE’s job)', async () => {
    const runSenseStage = createSenseStageRunner({ executeSenseStage: () => ({ balance: 0 }) });
    const outcome = await runSenseStage({ project: { id: 1 } });
    expect(outcome.disposition).toBe('continue');
  });
});
