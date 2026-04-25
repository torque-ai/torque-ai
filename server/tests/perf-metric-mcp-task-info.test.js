'use strict';

const metric = require('../perf/metrics/mcp-task-info');

describe('metric: mcp-task-info', () => {
  it('contract', () => {
    expect(metric.id).toBe('mcp-task-info');
    expect(metric.category).toBe('request-latency');
    expect(metric.units).toBe('ms');
    expect(metric.runs).toBeGreaterThanOrEqual(50);
    expect(metric.warmup).toBeGreaterThanOrEqual(5);
  });

  it('run() returns positive ms value', async () => {
    const r = await metric.run({ iter: 0 });
    expect(typeof r.value).toBe('number');
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(2000);
  }, 30000);
});
