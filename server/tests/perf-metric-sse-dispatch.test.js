'use strict';

const metric = require('../perf/metrics/sse-dispatch');

describe('metric: sse-dispatch', () => {
  it('contract', () => {
    expect(metric.id).toBe('sse-dispatch');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(20);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(100);
  }, 30000);
});
