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

function ensureMinSamplesFor(provider, count = 5) {
  for (let i = 0; i < count; i += 1) {
    record(provider);
  }
}

describe('db/provider-scoring', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    providerScoring.init(db);
    providerScoring.setCompositeWeights(DEFAULT_WEIGHTS);
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('init creates provider_scores table with required schema columns', () => {
    const columns = db.prepare('PRAGMA table_info(provider_scores)').all();
    const columnNames = columns.map((column) => column.name);

    expect(columnNames).toEqual([
      'provider',
      'cost_efficiency',
      'speed_score',
      'reliability_score',
      'quality_score',
      'composite_score',
      'sample_count',
      'total_tasks',
      'total_successes',
      'total_failures',
      'avg_duration_ms',
      'p95_duration_ms',
      'avg_cost_usd',
      'last_updated',
      'trusted',
    ]);
    expect(columns.find((column) => column.name === 'provider')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(columns.find((column) => column.name === 'p95_duration_ms')).toMatchObject({
      type: 'REAL',
      dflt_value: '0',
    });
    expect(columns.find((column) => column.name === 'trusted')).toMatchObject({
      type: 'INTEGER',
      dflt_value: '0',
    });
  });

  it('init adds p95_duration_ms to an existing provider_scores table', () => {
    db.close();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE provider_scores (
        provider TEXT PRIMARY KEY,
        cost_efficiency REAL DEFAULT 0,
        speed_score REAL DEFAULT 0,
        reliability_score REAL DEFAULT 0,
        quality_score REAL DEFAULT 0,
        composite_score REAL DEFAULT 0,
        sample_count INTEGER DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        total_successes INTEGER DEFAULT 0,
        total_failures INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        avg_cost_usd REAL DEFAULT 0,
        last_updated TEXT,
        trusted INTEGER DEFAULT 0
      )
    `);

    providerScoring.init(db);

    const p95Column = db.prepare('PRAGMA table_info(provider_scores)').all()
      .find((column) => column.name === 'p95_duration_ms');

    expect(p95Column).toMatchObject({
      type: 'REAL',
      dflt_value: '0',
    });
  });

  it('recordTaskCompletion creates new provider entry', () => {
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

  it('accumulates multiple completions and computes reliability', () => {
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

  it('keeps composite at 0 and trusted at 0 before minimum samples', () => {
    for (let i = 0; i < 3; i += 1) {
      record('deepinfra', { durationMs: 90 + (i * 10), costUsd: 0.05 + (i * 0.01), qualityScore: 0.6 });
    }

    const row = providerScoring.getProviderScore('deepinfra');

    expect(row.sample_count).toBe(3);
    expect(row.trusted).toBe(0);
    expect(row.composite_score).toBe(0);
  });

  it('computes trusted and composite after minimum samples', () => {
    ensureMinSamplesFor('anthropic');
    const row = providerScoring.getProviderScore('anthropic');

    expect(row.sample_count).toBe(5);
    expect(row.trusted).toBe(1);
    expect(row.composite_score).toBeGreaterThan(0);
  });

  it('returns null from getProviderScore for unknown provider', () => {
    const row = providerScoring.getProviderScore('ghost-provider');
    expect(row).toBeNull();
  });

  it('getAllProviderScores returns rows sorted by composite score descending', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { durationMs: 100, costUsd: 0.05, qualityScore: 0.9 });
    }
    for (let i = 0; i < 5; i += 1) {
      record('ollama', { durationMs: 200, costUsd: 1.0, qualityScore: 0.3 });
    }

    const all = providerScoring.getAllProviderScores();
    expect(all.map((row) => row.provider)).toEqual(['codex', 'ollama']);
    expect(all[0].composite_score).toBeGreaterThan(all[1].composite_score);
  });

  it('trustedOnly filters untrusted providers', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { durationMs: 100, costUsd: 0.05, qualityScore: 0.9 });
    }
    for (let i = 0; i < 4; i += 1) {
      record('ollama', { durationMs: 200, costUsd: 0.05, qualityScore: 0.4 });
    }

    const all = providerScoring.getAllProviderScores();
    const trustedOnly = providerScoring.getAllProviderScores({ trustedOnly: true });

    expect(all.map((row) => row.provider)).toEqual(['codex', 'ollama']);
    expect(trustedOnly.map((row) => row.provider)).toEqual(['codex']);
    expect(trustedOnly.every((row) => row.trusted === 1)).toBe(true);
  });

  it('computes quality using exponential moving average', () => {
    record('groq', { qualityScore: 0.2 });
    record('groq', { qualityScore: 0.8 });
    record('groq', { qualityScore: 0.5 });

    const row = providerScoring.getProviderScore('groq');
    const expectedEma = (0.5 * 0.3) + ((0.3 * 0.8 + (0.2 * 0.7)) * 0.7);

    expect(row.quality_score).toBeCloseTo(expectedEma, 10);
  });

  it('assigns higher speed score to faster providers', () => {
    record('fast', { durationMs: 100, qualityScore: 0.5, costUsd: 0.1 });
    record('slow', { durationMs: 500, qualityScore: 0.5, costUsd: 0.1 });

    const fastRow = providerScoring.getProviderScore('fast');
    const slowRow = providerScoring.getProviderScore('slow');

    expect(fastRow.speed_score).toBeGreaterThan(slowRow.speed_score);
  });

  it('returns cost efficiency of 1.0 for free providers', () => {
    for (let i = 0; i < 3; i += 1) {
      record('free-provider', { costUsd: 0, qualityScore: 0.8, durationMs: 100 });
    }

    const row = providerScoring.getProviderScore('free-provider');

    expect(row.cost_efficiency).toBeCloseTo(1, 10);
  });
});
