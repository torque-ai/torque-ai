'use strict';

const metric = require('../perf/metrics/db-factory-cost-summary');

describe('metric: db-factory-cost-summary', () => {
  it('contract', () => {
    expect(metric.id).toBe('db-factory-cost-summary');
    expect(metric.category).toBe('db-query');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(20);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  });
});
