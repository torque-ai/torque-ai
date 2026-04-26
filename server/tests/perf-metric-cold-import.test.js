'use strict';

const metric = require('../perf/metrics/cold-import');

describe('metric: cold-import', () => {
  it('exposes the module variants', () => {
    expect(metric.id).toBe('cold-import');
    expect(metric.category).toBe('test-infra');
    expect(metric.units).toBe('ms');
    expect(metric.variants).toEqual(['tools', 'tool-registry', 'task-manager', 'database', 'db-task-core']);
    expect(metric.runs).toBeGreaterThanOrEqual(5);
    expect(metric.warmup).toBeGreaterThanOrEqual(0);
  });

  it('run({variant: "database"}) returns positive ms', async () => {
    const r = await metric.run({ iter: 0, variant: 'database' });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(5000);
  }, 30000);

  it('run({variant: "db-task-core"}) returns positive ms', async () => {
    const r = await metric.run({ iter: 0, variant: 'db-task-core' });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(5000);
  }, 30000);
});
