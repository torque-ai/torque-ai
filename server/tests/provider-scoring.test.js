'use strict';

const Database = require('better-sqlite3');
const providerScoring = require('../db/provider-scoring');

const DEFAULT_WEIGHTS = {
  cost: 0.15,
  speed: 0.25,
  reliability: 0.35,
  quality: 0.25,
};

let db;

function record(provider, overrides = {}) {
  return providerScoring.recordTaskCompletion({
    provider,
    success: true,
    durationMs: 100,
    costUsd: 0.1,
    qualityScore: 0.5,
    ...overrides,
  });
}

describe('db/provider-scoring', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    providerScoring.init(db);
    providerScoring.setCompositeWeights(DEFAULT_WEIGHTS);
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('records first task for a new provider', () => {
    record('codex', { success: true, durationMs: 120, costUsd: 0.25, qualityScore: 0.8 });

    const row = providerScoring.getProviderScore('codex');

    expect(row).toMatchObject({
      provider: 'codex',
      sample_count: 1,
      total_tasks: 1,
      total_successes: 1,
      total_failures: 0,
      trusted: 0,
    });
    expect(row.avg_duration_ms).toBe(120);
    expect(row.avg_cost_usd).toBe(0.25);
    expect(row.reliability_score).toBe(1);
    expect(row.quality_score).toBe(0.8);
    expect(row.composite_score).toBe(0);
  });

  it('computes reliability from success/failure ratio', () => {
    record('codex', { success: true });
    record('codex', { success: true });
    record('codex', { success: true });
    record('codex', { success: false });

    const row = providerScoring.getProviderScore('codex');

    expect(row.total_tasks).toBe(4);
    expect(row.total_successes).toBe(3);
    expect(row.total_failures).toBe(1);
    expect(row.reliability_score).toBeCloseTo(0.75, 10);
  });

  it('marks trusted after 5 samples', () => {
    for (let i = 0; i < 5; i += 1) {
      record('anthropic', { qualityScore: 0.4 + (i * 0.1) });
    }

    const row = providerScoring.getProviderScore('anthropic');

    expect(row.sample_count).toBe(5);
    expect(row.trusted).toBe(1);
  });

  it('untrusted provider has composite_score 0', () => {
    for (let i = 0; i < 3; i += 1) {
      record('deepinfra', { durationMs: 90 + (i * 10), costUsd: 0.05 + (i * 0.01), qualityScore: 0.6 });
    }

    const row = providerScoring.getProviderScore('deepinfra');

    expect(row.sample_count).toBe(3);
    expect(row.trusted).toBe(0);
    expect(row.composite_score).toBe(0);
  });

  it('computes exponential moving average for quality', () => {
    record('groq', { qualityScore: 0.2 });
    record('groq', { qualityScore: 0.8 });
    record('groq', { qualityScore: 0.5 });

    const row = providerScoring.getProviderScore('groq');
    const expectedEma = (0.5 * 0.3) + ((0.8 * 0.3 + (0.2 * 0.7)) * 0.7);

    expect(row.quality_score).toBeCloseTo(expectedEma, 10);
  });

  it('recomputes relative speed scores across providers', () => {
    record('codex', { durationMs: 100, costUsd: 0.2 });
    record('anthropic', { durationMs: 200, costUsd: 0.2 });

    const codex = providerScoring.getProviderScore('codex');
    const anthropic = providerScoring.getProviderScore('anthropic');

    expect(codex.speed_score).toBeCloseTo(0.5, 10);
    expect(anthropic.speed_score).toBeCloseTo(0, 10);
  });

  it('getAllProviderScores with trustedOnly filters correctly', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { durationMs: 100 + i, costUsd: 0.1, qualityScore: 0.7 });
    }
    for (let i = 0; i < 4; i += 1) {
      record('ollama', { durationMs: 200 + i, costUsd: 0.05, qualityScore: 0.6 });
    }

    const all = providerScoring.getAllProviderScores();
    const trustedOnly = providerScoring.getAllProviderScores({ trustedOnly: true });

    expect(all.map((row) => row.provider)).toEqual(['codex', 'ollama']);
    expect(trustedOnly.map((row) => row.provider)).toEqual(['codex']);
  });

  it('setCompositeWeights rejects weights that dont sum to 1', () => {
    expect(() => {
      providerScoring.setCompositeWeights({
        cost: 0.5,
        speed: 0.3,
        reliability: 0.3,
        quality: 0.3,
      });
    }).toThrow(/sum to 1/i);
  });
});
