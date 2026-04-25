'use strict';

const { runMetric } = require('../perf/driver');

describe('perf driver', () => {
  it('runs warmup then measurement, returns trimmed median', async () => {
    let invocations = 0;
    const metric = {
      id: 'fake', name: 'Fake', category: 'hot-path-runtime', units: 'ms',
      warmup: 3, runs: 7,
      run: async () => {
        invocations++;
        const measureIdx = invocations - 3;
        if (measureIdx < 1) return { value: 999 };
        return { value: measureIdx };
      }
    };
    const result = await runMetric(metric);
    expect(result.median).toBe(4);
    expect(result.runs).toBe(7);
    expect(result.warmup).toBe(3);
    expect(invocations).toBe(10);
  });

  it('trims 10% top+bottom outliers when runs >= 10', async () => {
    const metric = {
      id: 'fake2', name: 'Fake2', category: 'hot-path-runtime', units: 'ms',
      warmup: 0, runs: 10,
      run: async ({ iter }) => ({ value: iter === 0 ? 0.5 : iter === 9 ? 100 : iter })
    };
    const result = await runMetric(metric);
    expect(result.median).toBe(4.5);
  });

  it('iterates variants when metric.variants is set', async () => {
    const seen = [];
    const metric = {
      id: 'fake3', name: 'Fake3', category: 'db-query', units: 'ms',
      warmup: 0, runs: 1, variants: ['raw', 'parsed'],
      run: async ({ variant }) => {
        seen.push(variant);
        return { value: variant === 'raw' ? 10 : 20 };
      }
    };
    const result = await runMetric(metric);
    expect(seen).toEqual(['raw', 'parsed']);
    expect(result.byVariant).toEqual({
      raw: { median: 10, runs: 1 },
      parsed: { median: 20, runs: 1 }
    });
  });
});
