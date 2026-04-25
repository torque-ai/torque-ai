'use strict';

const metric = require('../perf/metrics/governance-evaluate');

describe('metric: governance-evaluate', () => {
  it('exposes the metric contract', () => {
    expect(metric.id).toBe('governance-evaluate');
    expect(metric.category).toBe('hot-path-runtime');
    expect(metric.units).toBe('ms');
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(5000);
  });
});
