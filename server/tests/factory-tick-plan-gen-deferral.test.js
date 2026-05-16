'use strict';

// Coverage for the stale plan-generation deferral guard (factory-tick.js).
// A plan-generation task hung on file-lock contention keeps the deferred
// EXECUTE wait alive forever; inspectStalePlanGenerationDeferral lets the
// tick detect that and recover instead of parking the loop indefinitely.

const factoryTick = require('../factory/factory-tick');

const { inspectStalePlanGenerationDeferral, PLAN_GENERATION_MAX_DEFERRAL_MS } =
  factoryTick._internalForTests;

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// Minimal taskCore stub — only getTask is exercised.
function taskCoreWith(task) {
  return { getTask: () => task };
}

describe('inspectStalePlanGenerationDeferral', () => {
  it('exports a positive default deferral cap', () => {
    expect(PLAN_GENERATION_MAX_DEFERRAL_MS).toBeGreaterThan(0);
  });

  it('returns not-stale when there is no deferral wait state', () => {
    expect(inspectStalePlanGenerationDeferral(null)).toEqual({ stale: false, age_ms: 0 });
    expect(inspectStalePlanGenerationDeferral(undefined)).toEqual({ stale: false, age_ms: 0 });
  });

  it('returns not-stale when the wait state has no task_id', () => {
    const r = inspectStalePlanGenerationDeferral({ work_item_id: 5 });
    expect(r.stale).toBe(false);
  });

  it('returns not-stale when the task cannot be found', () => {
    const r = inspectStalePlanGenerationDeferral({ task_id: 'gone' }, taskCoreWith(null));
    expect(r.stale).toBe(false);
  });

  it('returns not-stale for a freshly-created plan-generation task', () => {
    const r = inspectStalePlanGenerationDeferral(
      { task_id: 't1' },
      taskCoreWith({ id: 't1', created_at: isoAgo(60 * 1000) }), // 1 min old
    );
    expect(r.stale).toBe(false);
    expect(r.age_ms).toBeGreaterThanOrEqual(0);
  });

  it('flags a plan-generation task alive past the deferral cap as stale', () => {
    const r = inspectStalePlanGenerationDeferral(
      { task_id: 't2' },
      taskCoreWith({ id: 't2', created_at: isoAgo(PLAN_GENERATION_MAX_DEFERRAL_MS + 5 * 60 * 1000) }),
    );
    expect(r.stale).toBe(true);
    expect(r.age_ms).toBeGreaterThan(PLAN_GENERATION_MAX_DEFERRAL_MS);
  });

  it('prefers last_activity_at — recent activity keeps an old task not-stale', () => {
    const r = inspectStalePlanGenerationDeferral(
      { task_id: 't3' },
      taskCoreWith({
        id: 't3',
        created_at: isoAgo(PLAN_GENERATION_MAX_DEFERRAL_MS + 10 * 60 * 1000), // created long ago
        last_activity_at: isoAgo(30 * 1000), // ...but active 30s ago
      }),
    );
    expect(r.stale).toBe(false);
  });

  it('flags a task whose last_activity_at is past the cap as stale', () => {
    const r = inspectStalePlanGenerationDeferral(
      { task_id: 't4' },
      taskCoreWith({
        id: 't4',
        created_at: isoAgo(PLAN_GENERATION_MAX_DEFERRAL_MS + 60 * 60 * 1000),
        last_activity_at: isoAgo(PLAN_GENERATION_MAX_DEFERRAL_MS + 2 * 60 * 1000),
      }),
    );
    expect(r.stale).toBe(true);
  });

  it('returns not-stale when timestamps are unparseable', () => {
    const r = inspectStalePlanGenerationDeferral(
      { task_id: 't5' },
      taskCoreWith({ id: 't5', created_at: 'not-a-date' }),
    );
    expect(r.stale).toBe(false);
  });

  it('does not throw when taskCore.getTask itself throws', () => {
    const throwingCore = { getTask: () => { throw new Error('db down'); } };
    const r = inspectStalePlanGenerationDeferral({ task_id: 't6' }, throwingCore);
    expect(r.stale).toBe(false);
  });
});
