import { describe, it, expect } from 'vitest';
import { createExecuteDeferral } from '../factory/execute-deferral.js';

// Phase 3 slice 5 re-scope (3a): the EXECUTE-stage deferral cluster (12
// members) moved from loop-controller.js to execute-deferral.js. Behavioral
// coverage of the deferral path stays in the loop-controller factory tests.
// This file pins the createExecuteDeferral dependency-injection contract.

const FN_DEPS = [
  'findExistingPlanTaskSubmission', 'getDatabaseHandle', 'getDecisionRowWorkItemId',
  'getProjectOrThrow', 'getWorkItemDecisionContext', 'hydrateDecisionRow',
  'normalizeWorkItemId', 'parseJsonObject', 'routePlanQualityGateFailureToNeedsReplan',
  'safeLogDecision',
];

const RETURNED = [
  'ExecuteDeferredPausedError', 'deferExecutePlanTaskIfProjectPaused',
  'getLatestExecutePausedDeferral', 'hasExecuteDeferralFollowup', 'logExecuteDeferredResume',
  'normalizePlanTaskNumber', 'getDeferredRemainingPlanTaskNumber', 'getNextExecutablePlanTask',
  'inspectExecuteDeferredResume', 'logExecuteDeferredPausedStaleWarning',
  'maybeRejectResumedDeferredPlan', 'maybeWarnStaleExecuteDeferral',
];

function makeFullDeps() {
  const deps = { EXECUTE_DEFERRED_STALE_MS: 24 * 60 * 60 * 1000 };
  for (const name of FN_DEPS) deps[name] = () => {};
  return deps;
}

describe('createExecuteDeferral — dependency-injection contract', () => {
  it('returns all 12 deferral cluster members with full deps', () => {
    const api = createExecuteDeferral(makeFullDeps());
    for (const name of RETURNED) {
      expect(typeof api[name]).toBe('function');
    }
    expect(Object.keys(api).sort()).toEqual([...RETURNED].sort());
  });

  it('throws naming each missing function dep', () => {
    for (const missing of FN_DEPS) {
      const deps = makeFullDeps();
      delete deps[missing];
      expect(() => createExecuteDeferral(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when EXECUTE_DEFERRED_STALE_MS is missing or not a number', () => {
    const missing = makeFullDeps();
    delete missing.EXECUTE_DEFERRED_STALE_MS;
    expect(() => createExecuteDeferral(missing)).toThrow(/EXECUTE_DEFERRED_STALE_MS/);

    const bad = makeFullDeps();
    bad.EXECUTE_DEFERRED_STALE_MS = '86400000';
    expect(() => createExecuteDeferral(bad)).toThrow(/EXECUTE_DEFERRED_STALE_MS/);
  });

  it('throws when called with no deps at all', () => {
    expect(() => createExecuteDeferral()).toThrow(/is required/);
  });

  it('ExecuteDeferredPausedError is a usable Error subclass', () => {
    const { ExecuteDeferredPausedError } = createExecuteDeferral(makeFullDeps());
    const err = new ExecuteDeferredPausedError({ project_id: 7 });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('FACTORY_EXECUTE_DEFERRED_PAUSED');
    expect(err.project_id).toBe(7);
  });
});
