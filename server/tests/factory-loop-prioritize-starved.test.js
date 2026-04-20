'use strict';

const loopController = require('../factory/loop-controller');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');

describe('PRIORITIZE short-circuit on empty intake', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('does not enter PLAN when PRIORITIZE returns no work item', async () => {
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    vi.spyOn(factoryLoopInstances, 'updateInstance').mockReturnValue(null);
    const planSpy = vi.spyOn(loopController._internalForTests, 'executePlanStage');

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: { id: 'p1', trust_level: 'dark', path: process.cwd() },
      instance: { id: 'i1', loop_state: 'PRIORITIZE', work_item_id: null },
      currentState: 'PRIORITIZE',
    });

    expect(planSpy).not.toHaveBeenCalled();
    expect(result.transitionReason).toBe('no_open_work_item');
    expect(result.nextState).toBe('IDLE');
  });
});
