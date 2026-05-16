import { describe, it, expect } from 'vitest';
import { createVerifyStage } from '../factory/stages/verify.js';

// Phase 3: the executeVerifyStage body moved to stages/verify.js. Behavioral
// coverage of the VERIFY stage stays in the loop-controller factory tests
// (runExecuteVerifyStage / verifyStageRunner are still loop-controller exports,
// behavior-identical). This file pins the new createVerifyStage factory's
// dependency-injection contract.

const FN_DEPS = [
  'getWorktreeRunner', 'listTasksForFactoryBatch', 'safeLogDecision',
  'resolveFactoryVerifyCommand', 'isProjectStatusPaused', 'resolveVerifyEmptyBranch',
  'attemptSilentRerun', 'submitVerifyFixTask', 'enforceVerifyRetryScopeEnvelope',
  'getProjectOrThrow',
];

function makeFullDeps() {
  const deps = {
    MAX_AUTO_VERIFY_RETRIES: 3,
    MAX_SUBMISSION_FAILURES: 2,
    FATAL_SUBMISSION_REASONS: new Set(['cwd_missing']),
  };
  for (const name of FN_DEPS) deps[name] = () => {};
  return deps;
}

describe('createVerifyStage — dependency-injection contract', () => {
  it('returns the executeVerifyStage async function with full deps', () => {
    const executeVerifyStage = createVerifyStage(makeFullDeps());
    expect(typeof executeVerifyStage).toBe('function');
    expect(executeVerifyStage.constructor.name).toBe('AsyncFunction');
  });

  it('throws naming each missing function dep', () => {
    for (const missing of FN_DEPS) {
      const deps = makeFullDeps();
      delete deps[missing];
      expect(() => createVerifyStage(deps)).toThrow(new RegExp(`dep '${missing}' is required`));
    }
  });

  it('throws when MAX_AUTO_VERIFY_RETRIES is missing or not a number', () => {
    const missing = makeFullDeps();
    delete missing.MAX_AUTO_VERIFY_RETRIES;
    expect(() => createVerifyStage(missing)).toThrow(/MAX_AUTO_VERIFY_RETRIES/);

    const bad = makeFullDeps();
    bad.MAX_AUTO_VERIFY_RETRIES = '3';
    expect(() => createVerifyStage(bad)).toThrow(/MAX_AUTO_VERIFY_RETRIES/);
  });

  it('throws when MAX_SUBMISSION_FAILURES is missing or not a number', () => {
    const missing = makeFullDeps();
    delete missing.MAX_SUBMISSION_FAILURES;
    expect(() => createVerifyStage(missing)).toThrow(/MAX_SUBMISSION_FAILURES/);

    const bad = makeFullDeps();
    bad.MAX_SUBMISSION_FAILURES = '2';
    expect(() => createVerifyStage(bad)).toThrow(/MAX_SUBMISSION_FAILURES/);
  });

  it('throws when FATAL_SUBMISSION_REASONS is missing or not a Set', () => {
    const missing = makeFullDeps();
    delete missing.FATAL_SUBMISSION_REASONS;
    expect(() => createVerifyStage(missing)).toThrow(/FATAL_SUBMISSION_REASONS/);

    const bad = makeFullDeps();
    bad.FATAL_SUBMISSION_REASONS = ['cwd_missing'];
    expect(() => createVerifyStage(bad)).toThrow(/FATAL_SUBMISSION_REASONS/);
  });

  it('throws when called with no deps at all', () => {
    expect(() => createVerifyStage()).toThrow(/is required/);
  });
});
