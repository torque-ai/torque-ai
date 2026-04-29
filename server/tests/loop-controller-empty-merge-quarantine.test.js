import { describe, it, expect } from 'vitest';

const {
  isEmptyBranchMergeError,
  countPriorEmptyMergeFailuresForWorkItem,
  shouldQuarantineForEmptyMerges,
  isMergeTargetOperatorBlockedError,
} = require('../factory/loop-controller');

describe('isEmptyBranchMergeError', () => {
  it('detects the canonical "no commits ahead" merge error', () => {
    expect(isEmptyBranchMergeError('worktree has no commits ahead of main — refusing to merge empty branch')).toBe(true);
  });

  it('detects the message regardless of base branch name', () => {
    expect(isEmptyBranchMergeError('worktree has no commits ahead of master')).toBe(true);
  });

  it('returns false for unrelated merge errors', () => {
    expect(isEmptyBranchMergeError('merge conflict in foo.txt')).toBe(false);
    expect(isEmptyBranchMergeError('CONFLICT (content): Merge conflict in bar')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(isEmptyBranchMergeError(null)).toBe(false);
    expect(isEmptyBranchMergeError(undefined)).toBe(false);
    expect(isEmptyBranchMergeError(42)).toBe(false);
  });
});

describe('countPriorEmptyMergeFailuresForWorkItem', () => {
  it('counts only worktree_merge_failed decisions for the matching work_item_id with empty-branch errors', () => {
    const decisions = [
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of main' } },
      { action: 'worktree_merge_failed', outcome: { work_item_id: 7, error: 'no commits ahead of main' } },
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'merge conflict' } },
      { action: 'worktree_merged',       outcome: { work_item_id: 5 } },
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of master' } },
    ];
    expect(countPriorEmptyMergeFailuresForWorkItem(decisions, 5)).toBe(2);
  });

  it('returns 0 for empty / missing inputs', () => {
    expect(countPriorEmptyMergeFailuresForWorkItem([], 5)).toBe(0);
    expect(countPriorEmptyMergeFailuresForWorkItem(null, 5)).toBe(0);
    expect(countPriorEmptyMergeFailuresForWorkItem([{ action: 'x' }], null)).toBe(0);
  });
});

describe('shouldQuarantineForEmptyMerges', () => {
  it('returns false when current error is not empty-branch related', () => {
    const decisions = [
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of main' } },
    ];
    expect(shouldQuarantineForEmptyMerges({
      currentErrorMessage: 'merge conflict in app.js',
      priorDecisions: decisions,
      workItemId: 5,
    })).toBe(false);
  });

  it('returns false when there are no prior empty-branch failures (first occurrence)', () => {
    expect(shouldQuarantineForEmptyMerges({
      currentErrorMessage: 'worktree has no commits ahead of main',
      priorDecisions: [],
      workItemId: 5,
    })).toBe(false);
  });

  it('returns true on the second consecutive empty-branch failure for the same work item', () => {
    const decisions = [
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of main' } },
    ];
    expect(shouldQuarantineForEmptyMerges({
      currentErrorMessage: 'worktree has no commits ahead of main',
      priorDecisions: decisions,
      workItemId: 5,
    })).toBe(true);
  });

  it('honors a custom threshold (e.g. quarantine only after 3 empties)', () => {
    const twoPrior = [
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of main' } },
      { action: 'worktree_merge_failed', outcome: { work_item_id: 5, error: 'no commits ahead of main' } },
    ];
    expect(shouldQuarantineForEmptyMerges({
      currentErrorMessage: 'worktree has no commits ahead of main',
      priorDecisions: twoPrior,
      workItemId: 5,
      threshold: 2,
    })).toBe(true);
    expect(shouldQuarantineForEmptyMerges({
      currentErrorMessage: 'worktree has no commits ahead of main',
      priorDecisions: twoPrior.slice(0, 1),
      workItemId: 5,
      threshold: 2,
    })).toBe(false);
  });
});

describe('isMergeTargetOperatorBlockedError', () => {
  it('matches git conflict states and dirty merge targets that require operator cleanup', () => {
    expect(isMergeTargetOperatorBlockedError({ code: 'IN_PROGRESS_GIT_OPERATION' })).toBe(true);
    expect(isMergeTargetOperatorBlockedError({ code: 'MAIN_REPO_SEMANTIC_DRIFT' })).toBe(true);
  });

  it('does not match generic merge failures that may be handled by other recovery paths', () => {
    expect(isMergeTargetOperatorBlockedError({ code: 'OTHER_FAILURE' })).toBe(false);
    expect(isMergeTargetOperatorBlockedError(null)).toBe(false);
    expect(isMergeTargetOperatorBlockedError(undefined)).toBe(false);
  });
});
