import { describe, it, expect } from 'vitest';
import { createPrioritizeStage } from '../factory/stages/prioritize.js';

// Phase 3: the executePrioritizeStage + handlePrioritizeTransition bodies
// moved to stages/prioritize.js. Behavioral coverage of the PRIORITIZE
// stage stays in the loop-controller factory tests (handlePrioritizeTransition
// is still a loop-controller export, behavior-identical). This file pins
// the new createPrioritizeStage factory's dependency-injection contract.

const FN_DEPS = [
  'getNeedsReplanCooldownInfo', 'clearSelectedWorkItem', 'updateInstanceAndSync',
  'nowIso', 'claimNextWorkItemForInstance', 'safeLogDecision',
  'getWorkItemDecisionContext', 'getDecisionBatchId', 'parseFactoryTimestampMs',
  'scoreWorkItemForPrioritize', 'rememberSelectedWorkItem', 'getWorkItemScopedBatchId',
  'tryGetSelectedWorkItem', 'incrementConsecutiveEmptyCycles', 'terminateInstanceAndSync',
  'recordFactoryIdleIfExhausted', 'setConsecutiveEmptyCycles', 'getInstanceOrThrow',
  'getDatabaseHandle', 'getCurrentLoopState', 'markInstanceFallbackRouting',
  'tryMoveInstanceToStage', 'getExecutePlanStageForTransition',
];

function makeFullDeps() {
  const deps = { STARVATION_THRESHOLD: 3 };
  for (const name of FN_DEPS) deps[name] = () => {};
  return deps;
}

describe('createPrioritizeStage — dependency-injection contract', () => {
  it('returns both executePrioritizeStage and handlePrioritizeTransition with full deps', () => {
    const stage = createPrioritizeStage(makeFullDeps());
    expect(typeof stage.executePrioritizeStage).toBe('function');
    expect(typeof stage.handlePrioritizeTransition).toBe('function');
  });

  it('throws naming each missing function dep', () => {
    for (const missing of FN_DEPS) {
      const deps = makeFullDeps();
      delete deps[missing];
      expect(() => createPrioritizeStage(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when STARVATION_THRESHOLD is missing or not a number', () => {
    const noThreshold = makeFullDeps();
    delete noThreshold.STARVATION_THRESHOLD;
    expect(() => createPrioritizeStage(noThreshold)).toThrow(/STARVATION_THRESHOLD/);

    const badThreshold = makeFullDeps();
    badThreshold.STARVATION_THRESHOLD = 'three';
    expect(() => createPrioritizeStage(badThreshold)).toThrow(/STARVATION_THRESHOLD/);
  });

  it('throws when called with no deps at all', () => {
    expect(() => createPrioritizeStage()).toThrow(/is required/);
  });
});
