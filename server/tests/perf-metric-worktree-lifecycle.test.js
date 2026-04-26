'use strict';

const metric = require('../perf/metrics/worktree-lifecycle');

describe('metric: worktree-lifecycle', () => {
  it('contract', () => {
    expect(metric.id).toBe('worktree-lifecycle');
    expect(metric.category).toBe('dev-iteration');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(3);
    expect(metric.warmup).toBeGreaterThanOrEqual(0);
  });

  it('run() completes and returns positive ms', async () => {
    const r = await metric.run({ iter: 0 });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(60000);
  }, 90000);
});
