'use strict';

const { LOOP_STATES, getNextState, isValidState } = require('../factory/loop-states');

describe('STARVED loop state', () => {
  it('is a valid loop state', () => {
    expect(isValidState(LOOP_STATES.STARVED)).toBe(true);
    expect(LOOP_STATES.STARVED).toBe('STARVED');
  });

  it('has no automatic transition', () => {
    for (const trust of ['supervised', 'guided', 'autonomous', 'dark']) {
      expect(getNextState(LOOP_STATES.STARVED, trust, 'approved')).toBe(LOOP_STATES.STARVED);
    }
  });
});
