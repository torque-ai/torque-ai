'use strict';

const metric = require('../perf/metrics/queue-scheduler-tick');

describe('metric: queue-scheduler-tick', () => {
  it('exposes the metric contract fields', () => {
    expect(metric.id).toBe('queue-scheduler-tick');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(100);
    expect(metric.warmup).toBeGreaterThanOrEqual(5);
    expect(typeof metric.run).toBe('function');
  });

  it('run() returns a positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThan(500);
  });
});
