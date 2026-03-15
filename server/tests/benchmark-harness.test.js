import { describe, it, expect } from 'vitest';

const { BenchmarkHarness } = require('../orchestrator/benchmark');

describe('BenchmarkHarness', () => {
  it('creates with default config', () => {
    const harness = new BenchmarkHarness();
    expect(harness.results).toEqual([]);
  });

  it('records a benchmark result', () => {
    const harness = new BenchmarkHarness();
    harness.record({
      task_name: 'decompose_trade_system',
      source: 'llm',
      duration_ms: 2000,
      tokens: 700,
      cost: 0.001,
      confidence: 0.85,
      quality_score: null,
      tasks_generated: 5,
    });
    expect(harness.results).toHaveLength(1);
    expect(harness.results[0].task_name).toBe('decompose_trade_system');
  });

  it('generates summary statistics', () => {
    const harness = new BenchmarkHarness();
    harness.record({ task_name: 'a', source: 'llm', duration_ms: 1000, tokens: 500, cost: 0.001, confidence: 0.8 });
    harness.record({ task_name: 'b', source: 'llm', duration_ms: 2000, tokens: 700, cost: 0.002, confidence: 0.9 });
    harness.record({ task_name: 'c', source: 'deterministic', duration_ms: 5, tokens: 0, cost: 0, confidence: 0.6 });
    const summary = harness.summarize();
    expect(summary.total_runs).toBe(3);
    expect(summary.llm_runs).toBe(2);
    expect(summary.fallback_runs).toBe(1);
    expect(summary.avg_duration_ms).toBeCloseTo(1001.67, 0);
    expect(summary.total_cost).toBeCloseTo(0.003);
    expect(summary.avg_confidence).toBeCloseTo(0.767, 1);
  });

  it('exports results as CSV', () => {
    const harness = new BenchmarkHarness();
    harness.record({ task_name: 'a', source: 'llm', duration_ms: 1000, tokens: 500, cost: 0.001, confidence: 0.8 });
    const csv = harness.toCsv();
    expect(csv).toContain('task_name,source,duration_ms');
    expect(csv).toContain('a,llm,1000');
  });
});
