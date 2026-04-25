'use strict';

const metric = require('../perf/metrics/handler-project-stats');

describe('metric: handler-project-stats', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('handler-project-stats');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
  });

  it('run() returns a positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  }, 30000);
});
