'use strict';

const metric = require('../perf/metrics/restart-barrier');

describe('metric: restart-barrier', () => {
  it('contract', () => {
    expect(metric.id).toBe('restart-barrier');
    expect(metric.category).toBe('dev-iteration');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(20);
    expect(metric.warmup).toBeGreaterThanOrEqual(5);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  });
});
