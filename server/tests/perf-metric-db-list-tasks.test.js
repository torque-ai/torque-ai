'use strict';

const metric = require('../perf/metrics/db-list-tasks');

describe('metric: db-list-tasks', () => {
  it('contract', () => {
    expect(metric.id).toBe('db-list-tasks');
    expect(metric.category).toBe('db-query');
    expect(metric.units).toBe('ms');
    expect(metric.variants).toEqual(['parsed', 'raw']);
    expect(metric.runs).toBeGreaterThanOrEqual(20);
    expect(metric.warmup).toBeGreaterThanOrEqual(5);
  });

  it('run({variant: "parsed"}) returns positive value', async () => {
    const r = await metric.run({ iter: 0, variant: 'parsed' });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  });

  it('run({variant: "raw"}) returns positive value', async () => {
    const r = await metric.run({ iter: 0, variant: 'raw' });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  });
});
