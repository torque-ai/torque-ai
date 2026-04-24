'use strict';

const { describe, it, expect } = require('vitest');
const { computeCompositeScore, summarize } = require('../bench/score');
const { renderReport } = require('../bench/render-report');

describe('computeCompositeScore', () => {
  it('higher is better; weights success, verify pass, low cost, low duration', () => {
    const good = computeCompositeScore({ status: 'completed', verify_pass_rate: 1.0, cost_usd: 0.1, duration_seconds: 60 });
    const bad = computeCompositeScore({ status: 'failed', verify_pass_rate: 0.2, cost_usd: 5.0, duration_seconds: 600 });
    expect(good).toBeGreaterThan(bad);
  });

  it('failed runs score 0', () => {
    expect(computeCompositeScore({ status: 'failed', verify_pass_rate: 1.0, cost_usd: 0, duration_seconds: 1 })).toBe(0);
  });

  it('cancelled runs score 0', () => {
    expect(computeCompositeScore({ status: 'cancelled' })).toBe(0);
  });
});

describe('summarize', () => {
  it('aggregates per-variant statistics', () => {
    const runs = [
      { spec_path: 'A.yaml', composite_score: 80, metrics: { cost_usd: 0.5, duration_seconds: 100 } },
      { spec_path: 'A.yaml', composite_score: 85, metrics: { cost_usd: 0.6, duration_seconds: 120 } },
      { spec_path: 'B.yaml', composite_score: 50, metrics: { cost_usd: 0.2, duration_seconds: 60 } },
    ];
    const summary = summarize(runs);
    const a = summary.find((s) => s.spec_path === 'A.yaml');
    const b = summary.find((s) => s.spec_path === 'B.yaml');
    expect(a.runs).toBe(2);
    expect(a.avg_score).toBeCloseTo(82.5);
    expect(b.runs).toBe(1);
    expect(a.avg_score).toBeGreaterThan(b.avg_score);
  });
});

describe('renderReport', () => {
  it('renders a ranked markdown report with a winner', () => {
    const report = renderReport({
      bench_id: '12345678-abcd-efgh',
      runs: [
        { spec_path: 'A.yaml', composite_score: 90, metrics: { cost_usd: 0.5, duration_seconds: 100 } },
        { spec_path: 'A.yaml', composite_score: 80, metrics: { cost_usd: 0.7, duration_seconds: 120 } },
        { spec_path: 'B.yaml', composite_score: 60, metrics: { cost_usd: 0.4, duration_seconds: 90 } },
      ],
    });

    expect(report).toContain('# Bench 12345678');
    expect(report).toContain('Total runs: 3');
    expect(report).toContain('| `A.yaml` | 2 | **85.0** | 90 | 80 | 0.6000 | 110 |');
    expect(report).toContain('Winner: `A.yaml` with average score 85.0.');
  });
});
