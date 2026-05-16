import { describe, it, expect } from 'vitest';
import { createSenseStage } from '../factory/stages/sense.js';

// Phase 3: the SENSE executor body moved to stages/sense.js. Behavioral
// coverage of executeSenseStage (plan-file intake, scanned_plans decision)
// stays in loop-controller-plans-dir.test.js, which exercises the wired
// executor via loop-controller's export. This file pins the new surface:
// the createSenseStage factory's dependency-injection contract.

describe('createSenseStage — dependency-injection contract', () => {
  const fullDeps = {
    getProjectOrThrow: () => ({ id: 1, config: {} }),
    getDatabaseHandle: () => null,
    safeLogDecision: () => {},
    getDecisionBatchId: () => null,
  };

  it('returns the executeSenseStage executor when all deps are supplied', () => {
    const executeSenseStage = createSenseStage(fullDeps);
    expect(typeof executeSenseStage).toBe('function');
    expect(executeSenseStage.length).toBe(1); // (project_id, instance = null)
  });

  it('throws when any required dep is missing', () => {
    for (const missing of ['getProjectOrThrow', 'getDatabaseHandle', 'safeLogDecision', 'getDecisionBatchId']) {
      const deps = { ...fullDeps };
      delete deps[missing];
      expect(() => createSenseStage(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when called with no deps at all', () => {
    expect(() => createSenseStage()).toThrow(/is required/);
  });
});
