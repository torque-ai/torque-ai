'use strict';

const metric = require('../perf/metrics/task-core-create');

describe('metric: task-core-create', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('task-core-create');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(50);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(500);
  });
});
