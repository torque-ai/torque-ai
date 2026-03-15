'use strict';

const scheduler = require('../execution/slot-pull-scheduler');

describe('slot-pull-scheduler smoke exports', () => {
  it('exports the expected API surface', () => {
    expect(scheduler.init).toBeTypeOf('function');
    expect(scheduler.onSlotFreed).toBeTypeOf('function');
    expect(scheduler.findBestTaskForProvider).toBeTypeOf('function');
    expect(scheduler.runSlotPullPass).toBeTypeOf('function');
    expect(scheduler.claimTask).toBeTypeOf('function');
    expect(scheduler.requeueAfterFailure).toBeTypeOf('function');
    expect(scheduler.STARVATION_THRESHOLD_MS).toBeTypeOf('number');
  });
});
