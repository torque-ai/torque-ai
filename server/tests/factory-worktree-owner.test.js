import { describe, it, expect } from 'vitest';
import { createWorktreeOwner } from '../factory/worktree-owner.js';

// Phase 3 slice 5 re-scope (3b): the worktree-owner cluster (21 functions:
// 15 loop-controller-referenced + 6 cluster-internal fold-ins) moved from
// loop-controller.js to worktree-owner.js. Behavioral coverage stays in the
// loop-controller factory tests. This file pins the createWorktreeOwner
// dependency-injection contract.

const FN_DEPS = [
  'getPlanGenerationTask', 'getTaskMetadataObject', 'getWorkItemDecisionContext',
  'isTaskPidAlive', 'normalizeOptionalString', 'safeLogDecision', 'taskHasFactoryTag',
];
const SET_DEPS = [
  'LIVE_WORKTREE_OWNER_STATUSES', 'REUSABLE_WORKTREE_OWNER_STATUSES',
  'REPLACEMENT_WORKTREE_OWNER_STATUSES',
];
const RETURNED = [
  'isLiveWorktreeOwner', 'isReusableWorktreeOwner', 'getWorktreeDirtyStatus',
  'findLiveReplacementWorktreeOwner', 'findReusableReplacementWorktreeOwner',
  'ensureReusedFactoryWorktreeFresh', 'maybeReuseCompletedWorktreeOwner',
  'adoptReplacementWorktreeOwner', 'resolveTaskReplacementChain',
  'getActiveBatchWorktreeForPlanGate', 'getLiveActiveBatchWorktreeOwner',
  'getFactoryWorktreePath', 'getFactoryWorktreeWorkItemId',
  'factoryWorktreeBelongsToWorkItem', 'prepareReusedFactoryWorktreeDependencies',
];

function makeFullDeps() {
  const deps = {};
  for (const name of FN_DEPS) deps[name] = () => {};
  for (const name of SET_DEPS) deps[name] = new Set();
  return deps;
}

describe('createWorktreeOwner — dependency-injection contract', () => {
  it('returns all 15 externally-used worktree-owner functions with full deps', () => {
    const api = createWorktreeOwner(makeFullDeps());
    for (const name of RETURNED) expect(typeof api[name]).toBe('function');
    expect(Object.keys(api).sort()).toEqual([...RETURNED].sort());
  });

  it('throws naming each missing function dep', () => {
    for (const missing of FN_DEPS) {
      const deps = makeFullDeps();
      delete deps[missing];
      expect(() => createWorktreeOwner(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when a status-Set dep is missing or not a Set', () => {
    for (const missing of SET_DEPS) {
      const noSet = makeFullDeps();
      delete noSet[missing];
      expect(() => createWorktreeOwner(noSet)).toThrow(new RegExp(`dep '${missing}'`));

      const badSet = makeFullDeps();
      badSet[missing] = ['x'];
      expect(() => createWorktreeOwner(badSet)).toThrow(new RegExp(`dep '${missing}'`));
    }
  });

  it('throws when called with no deps at all', () => {
    expect(() => createWorktreeOwner()).toThrow(/is required/);
  });
});
