import { describe, it, expect } from 'vitest';
import { createLearnStage } from '../factory/stages/learn.js';

// Phase 3: the executeLearnStage body moved to stages/learn.js
// (createLearnStage), alongside the Step B createLearnStageRunner.
// Behavioral coverage of the LEARN stage stays in the loop-controller
// factory tests; this file pins the new createLearnStage factory's
// dependency-injection contract.

describe('createLearnStage — dependency-injection contract', () => {
  const fullDeps = {
    safeLogDecision: () => {},
    maybeShipWorkItemAfterLearn: async () => null,
  };

  it('returns the executeLearnStage executor when all deps are supplied', () => {
    const executeLearnStage = createLearnStage(fullDeps);
    expect(typeof executeLearnStage).toBe('function');
    expect(executeLearnStage.constructor.name).toBe('AsyncFunction');
  });

  it('throws when any required dep is missing', () => {
    for (const missing of ['safeLogDecision', 'maybeShipWorkItemAfterLearn']) {
      const deps = { ...fullDeps };
      delete deps[missing];
      expect(() => createLearnStage(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when called with no deps at all', () => {
    expect(() => createLearnStage()).toThrow(/is required/);
  });
});
