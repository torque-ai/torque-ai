'use strict';

const { LOOP_STATES, TRANSITIONS } = require('../factory/loop-states');

const stateEntries = Object.entries(LOOP_STATES);
const stateValues = Object.values(LOOP_STATES);
const terminalStates = new Set([LOOP_STATES.IDLE, LOOP_STATES.PAUSED]);
const nonTerminalStates = stateValues.filter((state) => !terminalStates.has(state));

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
  it('defines a transition for every non-terminal state', () => {
    for (const state of nonTerminalStates) {
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
  it('reaches IDLE from SENSE within at most LOOP_STATES.length steps', () => {
    let currentState = LOOP_STATES.SENSE;

    for (let step = 0; step < stateValues.length && currentState !== LOOP_STATES.IDLE; step += 1) {
      currentState = TRANSITIONS[currentState];
    }

    expect(currentState).toBe(LOOP_STATES.IDLE);
  });

  it('reaches IDLE from every non-terminal state', () => {
    for (const state of nonTerminalStates) {
      const reachableStates = getReachableStates(state);
      expect(reachableStates.has(LOOP_STATES.IDLE)).toBe(true);
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
