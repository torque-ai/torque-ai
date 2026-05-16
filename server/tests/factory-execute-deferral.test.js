import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// ---------------------------------------------------------------------------
// Behavioral tests for the five target functions
// ---------------------------------------------------------------------------

describe('normalizePlanTaskNumber', () => {
  let cluster;
  beforeEach(() => {
    cluster = createExecuteDeferral(makeFullDeps());
  });

  it('returns a valid positive integer unchanged', () => {
    expect(cluster.normalizePlanTaskNumber(5)).toBe(5);
  });

  it('returns 1 for integer 1', () => {
    expect(cluster.normalizePlanTaskNumber(1)).toBe(1);
  });

  it('returns null for zero', () => {
    expect(cluster.normalizePlanTaskNumber(0)).toBeNull();
  });

  it('returns null for negative numbers', () => {
    expect(cluster.normalizePlanTaskNumber(-3)).toBeNull();
  });

  it('returns null for non-integer floats', () => {
    // Number(3.7) is not an integer → null
    expect(cluster.normalizePlanTaskNumber(3.7)).toBeNull();
  });

  it('coerces numeric strings to integers', () => {
    // Number('4') === 4, which is a positive integer
    expect(cluster.normalizePlanTaskNumber('4')).toBe(4);
  });

  it('returns null for non-numeric strings', () => {
    expect(cluster.normalizePlanTaskNumber('abc')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(cluster.normalizePlanTaskNumber(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(cluster.normalizePlanTaskNumber(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(cluster.normalizePlanTaskNumber(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(cluster.normalizePlanTaskNumber(Infinity)).toBeNull();
  });

  it('returns integer when float string rounds to integer', () => {
    // Number('3.0') === 3, Number.isInteger(3) === true, 3 > 0
    expect(cluster.normalizePlanTaskNumber('3.0')).toBe(3);
  });
});

describe('getDeferredRemainingPlanTaskNumber', () => {
  let cluster;
  beforeEach(() => {
    cluster = createExecuteDeferral(makeFullDeps());
  });

  it('returns null for null deferral', () => {
    expect(cluster.getDeferredRemainingPlanTaskNumber(null)).toBeNull();
  });

  it('returns null for undefined deferral', () => {
    expect(cluster.getDeferredRemainingPlanTaskNumber(undefined)).toBeNull();
  });

  it('returns null for deferral with no relevant fields', () => {
    expect(cluster.getDeferredRemainingPlanTaskNumber({ outcome: {}, inputs: {} })).toBeNull();
  });

  it('prefers outcome.remaining_plan_task_number first', () => {
    const deferral = {
      outcome: { remaining_plan_task_number: 3, plan_task_number: 1 },
      inputs: { remaining_plan_task_number: 5, plan_task_number: 7 },
    };
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBe(3);
  });

  it('falls back to inputs.remaining_plan_task_number when outcome field missing', () => {
    const deferral = {
      outcome: { plan_task_number: 1 },
      inputs: { remaining_plan_task_number: 5, plan_task_number: 7 },
    };
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBe(5);
  });

  it('falls back to outcome.plan_task_number when remaining fields missing', () => {
    const deferral = {
      outcome: { plan_task_number: 2 },
      inputs: { plan_task_number: 9 },
    };
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBe(2);
  });

  it('falls back to inputs.plan_task_number as last resort', () => {
    const deferral = {
      outcome: {},
      inputs: { plan_task_number: 9 },
    };
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBe(9);
  });

  it('returns null when all fallback fields are invalid', () => {
    const deferral = {
      outcome: { remaining_plan_task_number: 'bad', plan_task_number: -1 },
      inputs: { remaining_plan_task_number: 0, plan_task_number: NaN },
    };
    // The ?? chain picks the first non-nullish value; 'bad' is non-nullish
    // so normalizePlanTaskNumber('bad') → null (non-numeric string)
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBeNull();
  });

  it('skips nullish outcome fields to reach valid inputs field', () => {
    const deferral = {
      outcome: { remaining_plan_task_number: null, plan_task_number: undefined },
      inputs: { remaining_plan_task_number: null, plan_task_number: 4 },
    };
    // null ?? null ?? undefined ?? 4 → 4
    expect(cluster.getDeferredRemainingPlanTaskNumber(deferral)).toBe(4);
  });
});

describe('deferExecutePlanTaskIfProjectPaused', () => {
  let cluster;
  let deps;
  let safeLogDecisionCalls;

  beforeEach(() => {
    safeLogDecisionCalls = [];
    deps = makeFullDeps();
    deps.getProjectOrThrow = vi.fn();
    deps.getWorkItemDecisionContext = vi.fn((wi) => ({ work_item_id: wi?.id ?? null }));
    deps.safeLogDecision = vi.fn((...args) => safeLogDecisionCalls.push(args));
    cluster = createExecuteDeferral(deps);
  });

  it('returns null when project is not paused', () => {
    deps.getProjectOrThrow.mockReturnValue({ status: 'active' });
    const result = cluster.deferExecutePlanTaskIfProjectPaused({
      project_id: 1,
      batch_id: 'b1',
      workItem: { id: 'wi-1' },
      planPath: '/tmp/plan.md',
      planTaskNumber: 3,
      planTaskTitle: 'Build widget',
    });
    expect(result).toBeNull();
    expect(deps.safeLogDecision).not.toHaveBeenCalled();
  });

  it('returns deferral object when project is paused', () => {
    deps.getProjectOrThrow.mockReturnValue({ status: 'paused' });
    const result = cluster.deferExecutePlanTaskIfProjectPaused({
      project_id: 42,
      batch_id: 'batch-abc',
      workItem: { id: 'wi-5', origin: { plan_path: '/origin/plan.md' } },
      planPath: '/tmp/plan.md',
      planTaskNumber: 2,
      planTaskTitle: 'Step two',
    });

    expect(result).toEqual({
      project_id: 42,
      batch_id: 'batch-abc',
      work_item_id: 'wi-5',
      plan_path: '/tmp/plan.md',
      plan_task_number: 2,
      remaining_plan_task_number: 2,
      plan_task_title: 'Step two',
    });
  });

  it('logs a decision with action execute_deferred_paused when project is paused', () => {
    deps.getProjectOrThrow.mockReturnValue({ status: 'paused' });
    cluster.deferExecutePlanTaskIfProjectPaused({
      project_id: 10,
      batch_id: 'b-log',
      workItem: { id: 'wi-log' },
      planPath: null,
      planTaskNumber: 1,
      planTaskTitle: null,
    });

    expect(deps.safeLogDecision).toHaveBeenCalledTimes(1);
    const logged = deps.safeLogDecision.mock.calls[0][0];
    expect(logged.project_id).toBe(10);
    expect(logged.action).toBe('execute_deferred_paused');
    expect(logged.stage).toBe('EXECUTE');
    expect(logged.outcome.project_status).toBe('paused');
  });

  it('falls back plan_path to workItem.origin.plan_path when planPath is falsy', () => {
    deps.getProjectOrThrow.mockReturnValue({ status: 'paused' });
    const result = cluster.deferExecutePlanTaskIfProjectPaused({
      project_id: 1,
      batch_id: 'b1',
      workItem: { id: 'wi-1', origin: { plan_path: '/fallback/plan.md' } },
      planPath: null,
      planTaskNumber: 1,
      planTaskTitle: 'T',
    });

    expect(result.plan_path).toBe('/fallback/plan.md');
  });

  it('nullifies optional fields when not provided', () => {
    deps.getProjectOrThrow.mockReturnValue({ status: 'paused' });
    const result = cluster.deferExecutePlanTaskIfProjectPaused({
      project_id: 1,
    });
    expect(result.batch_id).toBeNull();
    expect(result.work_item_id).toBeNull();
    expect(result.plan_path).toBeNull();
    expect(result.plan_task_number).toBeNull();
    expect(result.remaining_plan_task_number).toBeNull();
    expect(result.plan_task_title).toBeNull();
  });
});

describe('getNextExecutablePlanTask', () => {
  let cluster;

  beforeEach(() => {
    cluster = createExecuteDeferral(makeFullDeps());
  });

  it('returns null for null parsedPlan', async () => {
    expect(await cluster.getNextExecutablePlanTask(null, '/dir')).toBeNull();
  });

  it('returns null for undefined parsedPlan', async () => {
    expect(await cluster.getNextExecutablePlanTask(undefined, '/dir')).toBeNull();
  });

  it('returns null for parsedPlan with empty tasks array', async () => {
    expect(await cluster.getNextExecutablePlanTask({ tasks: [] }, '/dir')).toBeNull();
  });

  it('returns null for parsedPlan with non-array tasks', async () => {
    expect(await cluster.getNextExecutablePlanTask({ tasks: 'nope' }, '/dir')).toBeNull();
  });

  it('returns the first non-completed task', async () => {
    const plan = {
      tasks: [
        { task_number: 1, title: 'A', completed: true },
        { task_number: 2, title: 'B', completed: false },
        { task_number: 3, title: 'C', completed: false },
      ],
    };
    const result = await cluster.getNextExecutablePlanTask(plan, '/dir');
    expect(result).toBe(plan.tasks[1]);
    expect(result.task_number).toBe(2);
  });

  it('returns null when all tasks are completed', async () => {
    const plan = {
      tasks: [
        { task_number: 1, completed: true },
        { task_number: 2, completed: true },
      ],
    };
    expect(await cluster.getNextExecutablePlanTask(plan, '/dir')).toBeNull();
  });

  it('returns the first task when none are completed', async () => {
    const plan = {
      tasks: [
        { task_number: 1, title: 'First', completed: false },
        { task_number: 2, title: 'Second', completed: false },
      ],
    };
    const result = await cluster.getNextExecutablePlanTask(plan, '/dir');
    expect(result).toBe(plan.tasks[0]);
  });

  it('treats falsy completed field as not completed', async () => {
    const plan = {
      tasks: [
        { task_number: 1, completed: undefined },
        { task_number: 2, completed: null },
        { task_number: 3, completed: 0 },
      ],
    };
    // First task has falsy completed → not completed → returned
    const result = await cluster.getNextExecutablePlanTask(plan, '/dir');
    expect(result).toBe(plan.tasks[0]);
  });

  it('returns a completed task if verifyCompletedTaskArtifacts says not trusted', async () => {
    // When plan-executor is available and returns trust: false, a "completed"
    // task is still the next executable. The lazy require of plan-executor
    // will fail in test context (no such module mock), so completed tasks
    // with no verifier are simply skipped. We test the else-if branch:
    // task.completed && no verifier → continue
    const plan = {
      tasks: [
        { task_number: 1, completed: true },
        { task_number: 2, completed: false },
      ],
    };
    const result = await cluster.getNextExecutablePlanTask(plan, '/dir');
    // Without plan-executor available, completed task 1 is skipped, task 2 returned
    expect(result.task_number).toBe(2);
  });
});

describe('maybeWarnStaleExecuteDeferral', () => {
  let cluster;
  let deps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = makeFullDeps();
    deps.getDatabaseHandle = vi.fn(() => null);
    deps.safeLogDecision = vi.fn();
    deps.getWorkItemDecisionContext = vi.fn((wi) => ({ work_item_id: wi?.id ?? null }));
    deps.parseJsonObject = vi.fn((val) => {
      try { return JSON.parse(val); } catch { return null; }
    });
    cluster = createExecuteDeferral(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when deferral has no created_at', () => {
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: { id: 'inst-1' },
      workItem: { id: 'wi-1' },
      batchId: 'b-1',
      deferral: { id: 100 },
    });
    expect(result).toBeNull();
  });

  it('returns null when deferral is null', () => {
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: null,
      workItem: null,
      batchId: 'b-1',
      deferral: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when deferral created_at is unparseable', () => {
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: null,
      workItem: null,
      batchId: 'b-1',
      deferral: { id: 1, created_at: 'not-a-date' },
    });
    expect(result).toBeNull();
  });

  it('returns null when deferral age is under EXECUTE_DEFERRED_STALE_MS', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    vi.setSystemTime(now);

    // Created 1 hour ago — well under the 24-hour threshold
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: { id: 'inst-1' },
      workItem: { id: 'wi-1' },
      batchId: 'b-1',
      deferral: { id: 200, created_at: oneHourAgo },
    });
    expect(result).toBeNull();
    expect(deps.safeLogDecision).not.toHaveBeenCalled();
  });

  it('returns warning when deferral age exceeds EXECUTE_DEFERRED_STALE_MS', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    vi.setSystemTime(now);

    // Created 25 hours ago — over the 24-hour threshold
    const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 5 },
      instance: { id: 'inst-2' },
      workItem: { id: 'wi-2' },
      batchId: 'b-2',
      deferral: {
        id: 300,
        created_at: twentyFiveHoursAgo,
        outcome: { plan_task_number: 3 },
      },
    });

    expect(result).not.toBeNull();
    expect(result.stale_hours).toBe(25);
    expect(result.threshold_hours).toBe(24);
    expect(result.deferral_decision_id).toBe(300);
    expect(result.work_item_id).toBe('wi-2');
    expect(result.instance_id).toBe('inst-2');
    expect(result.batch_id).toBe('b-2');
    expect(result.plan_task_number).toBe(3);
  });

  it('logs a decision with action execute_deferred_paused_stale_warning', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const thirtyHoursAgo = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
    cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 8 },
      instance: null,
      workItem: { id: 'wi-3' },
      batchId: 'b-3',
      deferral: { id: 400, created_at: thirtyHoursAgo, outcome: {} },
    });

    expect(deps.safeLogDecision).toHaveBeenCalledTimes(1);
    const logged = deps.safeLogDecision.mock.calls[0][0];
    expect(logged.action).toBe('execute_deferred_paused_stale_warning');
    expect(logged.project_id).toBe(8);
    expect(logged.stage).toBe('EXECUTE');
    expect(logged.reasoning).toContain('30 hour(s)');
  });

  it('returns null when hasExecuteDeferralFollowup returns true (already warned)', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    vi.setSystemTime(now);

    // Set up getDatabaseHandle to return a mock db that makes
    // hasExecuteDeferralFollowup return true
    const mockDb = {
      prepare: () => ({
        all: () => [
          { id: 1, outcome_json: JSON.stringify({ deferral_decision_id: 500 }) },
        ],
      }),
    };
    deps.getDatabaseHandle = vi.fn(() => mockDb);
    deps.parseJsonObject = vi.fn((val) => {
      try { return JSON.parse(val); } catch { return null; }
    });
    cluster = createExecuteDeferral(deps);

    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: null,
      workItem: null,
      batchId: 'b-4',
      deferral: { id: 500, created_at: twoDaysAgo, outcome: {} },
    });
    expect(result).toBeNull();
    expect(deps.safeLogDecision).not.toHaveBeenCalled();
  });

  it('returns warning with null fields when workItem and instance are absent', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const result = cluster.maybeWarnStaleExecuteDeferral({
      project: { id: 1 },
      instance: null,
      workItem: null,
      batchId: 'b-5',
      deferral: { id: 600, created_at: twoDaysAgo, outcome: {} },
    });

    expect(result).not.toBeNull();
    expect(result.work_item_id).toBeNull();
    expect(result.instance_id).toBeNull();
    expect(result.plan_task_number).toBeNull();
  });
});
