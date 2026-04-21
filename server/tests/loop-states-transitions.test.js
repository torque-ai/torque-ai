'use strict';

const { LOOP_STATES, TRANSITIONS } = require('../factory/loop-states');

const stateEntries = Object.entries(LOOP_STATES);
const stateValues = Object.values(LOOP_STATES);
const terminalStates = new Set([LOOP_STATES.IDLE, LOOP_STATES.PAUSED, LOOP_STATES.STARVED]);
const specialStates = new Set([LOOP_STATES.PLAN_REVIEW]);
const linearStates = stateValues.filter((state) => (
  !terminalStates.has(state) && !specialStates.has(state)
));

function getReachableStates(startState) {
  const visited = new Set([startState]);
  const queue = [startState];

  while (queue.length > 0) {
    const state = queue.shift();
    const nextState = TRANSITIONS[state];

    if (!nextState || visited.has(nextState)) {
      continue;
    }

    visited.add(nextState);
    queue.push(nextState);
  }

  return visited;
}

describe('LOOP_STATES structure', () => {
  it('maps every key to a matching non-empty uppercase string', () => {
    for (const [key, value] of stateEntries) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      expect(value).toBe(key);
      expect(value).toMatch(/^[A-Z_]+$/);
    }
  });

  it('contains no duplicate values', () => {
    expect(new Set(stateValues).size).toBe(stateValues.length);
  });
});

describe('TRANSITIONS coverage', () => {
  it('defines a transition for every linear loop state', () => {
    for (const state of linearStates) {
      expect(Object.prototype.hasOwnProperty.call(TRANSITIONS, state)).toBe(true);
    }
  });

  it('only points to valid loop states', () => {
    for (const nextState of Object.values(TRANSITIONS)) {
      expect(stateValues).toContain(nextState);
    }
  });

  it('never transitions a state to itself', () => {
    for (const [state, nextState] of Object.entries(TRANSITIONS)) {
      expect(nextState).not.toBe(state);
    }
  });
});

describe('reachability', () => {
  it('keeps SENSE reachability inside known loop states without self-loops', () => {
    let currentState = LOOP_STATES.SENSE;

    for (let step = 0; step < stateValues.length; step += 1) {
      expect(stateValues).toContain(currentState);
      const nextState = TRANSITIONS[currentState];
      if (!nextState) {
        expect(terminalStates.has(currentState)).toBe(true);
        return;
      }

      expect(nextState).not.toBe(currentState);
      currentState = nextState;
    }

    const reachableStates = getReachableStates(LOOP_STATES.SENSE);
    for (const state of reachableStates) {
      expect(stateValues).toContain(state);
    }
  });

  it('keeps every linear state on the SENSE path', () => {
    const reachableFromSense = getReachableStates(LOOP_STATES.SENSE);
    for (const state of linearStates) {
      const reachableStates = getReachableStates(state);
      expect(reachableFromSense.has(state)).toBe(true);
      for (const reachableState of reachableStates) {
        expect(stateValues).toContain(reachableState);
      }
    }
  });
});

describe('terminal states', () => {
  it('either omit terminal transitions or keep them inside terminal states', () => {
    for (const terminalState of terminalStates) {
      if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, terminalState)) {
        continue;
      }

      expect(terminalStates.has(TRANSITIONS[terminalState])).toBe(true);
    }
  });
});
