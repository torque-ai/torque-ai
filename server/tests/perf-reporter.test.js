'use strict';

const { compareToBaseline } = require('../perf/report');

describe('perf reporter compareToBaseline', () => {
  it('returns no regressions when current matches baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 100 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it('flags regression when current >10% above baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 115 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].id).toBe('foo');
    expect(result.regressions[0].delta_pct).toBeCloseTo(15, 1);
  });

  it('does NOT flag a 9% increase as regression', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 109 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
  });

  it('flags an improvement when current <-10% below baseline', () => {
    const baseline = { metrics: { foo: { median: 100 } } };
    const current = { metrics: { foo: { median: 70 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toHaveLength(1);
  });

  it('handles variants by exploding into per-variant entries', () => {
    const baseline = {
      metrics: { 'cold-import': { byVariant: { tools: { median: 300 }, database: { median: 80 } } } }
    };
    const current = {
      metrics: { 'cold-import': { byVariant: { tools: { median: 350 }, database: { median: 80 } } } }
    };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].id).toBe('cold-import.tools');
  });

  it('skips comparison when env mismatches and reports advisory', () => {
    const baseline = { metrics: { foo: { median: 100 } }, env: { host_label: 'omen' } };
    const current = { metrics: { foo: { median: 200 } }, env: { host_label: 'macbook' } };
    const result = compareToBaseline(baseline, current);
    expect(result.advisory).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('returns first-run note when baseline is null', () => {
    const result = compareToBaseline(null, { metrics: { foo: { median: 100 } } });
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.notes).toContain('no baseline.json — first run');
  });

  it('does NOT flag sub-millisecond regression below the absolute floor', () => {
    // 0.32ms → 0.51ms is +59% but only +0.19ms — well within timer-resolution
    // and Defender scheduling noise. Must not trip the gate.
    const baseline = { metrics: { foo: { median: 0.32 } } };
    const current = { metrics: { foo: { median: 0.51 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it('still flags large-percent regressions above the absolute floor', () => {
    // 5ms → 7ms is +40% AND +2ms. The 2ms exceeds the 0.5ms floor so this
    // genuine regression must still be reported.
    const baseline = { metrics: { foo: { median: 5 } } };
    const current = { metrics: { foo: { median: 7 } } };
    const result = compareToBaseline(baseline, current);
    expect(result.regressions).toHaveLength(1);
  });
});

const { captureEnv } = require('../perf/report');

describe('perf captureEnv', () => {
  it('includes cpu_count, total_memory_mb, node_version, platform, host_label', () => {
    const env = captureEnv();
    expect(env.cpu_count).toBeGreaterThan(0);
    expect(env.total_memory_mb).toBeGreaterThan(0);
    expect(env.node_version).toMatch(/^v/);
    expect(env.platform).toMatch(/^(win32|linux|darwin)$/);
    expect(env.host_label).toBeTruthy();
  });

  it('honors PERF_HOST_LABEL when set', () => {
    const orig = process.env.PERF_HOST_LABEL;
    try {
      process.env.PERF_HOST_LABEL = 'test-host';
      const env = captureEnv();
      expect(env.host_label).toBe('test-host');
    } finally {
      if (orig === undefined) delete process.env.PERF_HOST_LABEL;
      else process.env.PERF_HOST_LABEL = orig;
    }
  });
});
