'use strict';

const Database = require('better-sqlite3');
const providerScoring = require('../db/provider/scoring');
const providerRoutingCore = require('../db/provider/routing-core');

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

function configureRoutingCoreForScoring() {
  db.getConfig = (key) => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_config (
      provider TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 50,
      transport TEXT,
      quota_error_patterns TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT,
      rule_type TEXT,
      pattern TEXT,
      target_provider TEXT,
      priority INTEGER DEFAULT 50,
      enabled INTEGER DEFAULT 1,
      complexity TEXT
    );
    CREATE TABLE IF NOT EXISTS routing_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      rules_json TEXT NOT NULL,
      complexity_overrides_json TEXT,
      preset INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT OR REPLACE INTO config (key, value) VALUES
      ('smart_routing_enabled', '1'),
      ('smart_routing_default_provider', 'ollama'),
      ('default_provider', 'ollama'),
      ('ollama_fallback_provider', 'codex');
  `);

  const insertProvider = db.prepare(`
    INSERT OR REPLACE INTO provider_config (provider, enabled, priority, transport, quota_error_patterns)
    VALUES (?, 1, ?, ?, '[]')
  `);
  insertProvider.run('ollama', 10, 'api');
  insertProvider.run('codex', 20, 'hybrid');
  insertProvider.run('claude-cli', 30, 'cli');
  insertProvider.run('claude-code-sdk', 40, 'cli');

  providerRoutingCore.createProviderRoutingCore({
    db,
    taskCore: () => null,
    hostManagement: {
      determineTaskComplexity: () => 'normal',
      routeTask: () => null,
    },
  });
  providerRoutingCore.setOllamaHealthy(true);
  providerRoutingCore.setProviderScoring(providerScoring);
}

function insertRoutingTemplate(name, rules) {
  db.prepare(`
    INSERT OR REPLACE INTO routing_templates (
      id,
      name,
      description,
      rules_json,
      complexity_overrides_json,
      preset,
      created_at,
      updated_at
    ) VALUES (?, ?, '', ?, '{}', 0, ?, ?)
  `).run(
    `test-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    JSON.stringify(rules),
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

describe('db/provider/scoring', () => {
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
    providerRoutingCore.setProviderScoring(null);
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

  it('computes speed and cost axes relative to observed provider maxima', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { durationMs: 100, costUsd: 0, qualityScore: 0.8 });
      record('deepinfra', { durationMs: 400, costUsd: 0.5, qualityScore: 0.8 });
    }

    const codex = providerScoring.getProviderScore('codex');
    const deepinfra = providerScoring.getProviderScore('deepinfra');

    expect(codex.speed_score).toBeCloseTo(0.75, 10);
    expect(deepinfra.speed_score).toBeCloseTo(0, 10);
    expect(codex.cost_efficiency).toBeCloseTo(1, 10);
    expect(deepinfra.cost_efficiency).toBeCloseTo(0, 10);
  });

  it('recomputes existing relative scores when later providers change maxima', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { durationMs: 100, costUsd: 0.1, qualityScore: 0.7 });
    }

    expect(providerScoring.getProviderScore('codex').speed_score).toBeCloseTo(0, 10);
    expect(providerScoring.getProviderScore('codex').cost_efficiency).toBeCloseTo(0, 10);

    for (let i = 0; i < 5; i += 1) {
      record('slower-expensive', { durationMs: 500, costUsd: 0.5, qualityScore: 0.7 });
    }

    const codex = providerScoring.getProviderScore('codex');
    const slowerExpensive = providerScoring.getProviderScore('slower-expensive');

    expect(codex.speed_score).toBeCloseTo(0.8, 10);
    expect(codex.cost_efficiency).toBeCloseTo(0.8, 10);
    expect(slowerExpensive.speed_score).toBeCloseTo(0, 10);
    expect(slowerExpensive.cost_efficiency).toBeCloseTo(0, 10);
  });

  it('persists composite weights and recomputes composites from new weights', () => {
    for (let i = 0; i < 5; i += 1) {
      record('codex', { success: i < 4, durationMs: 100, costUsd: 0.1, qualityScore: 0.7 });
    }

    const reliabilityOnlyWeights = {
      cost: 0,
      speed: 0,
      reliability: 1,
      quality: 0,
    };

    providerScoring.setCompositeWeights(reliabilityOnlyWeights);

    const score = providerScoring.getProviderScore('codex');
    const persisted = db.prepare('SELECT value FROM config WHERE key = ?')
      .get('provider_scoring_composite_weights');

    expect(providerScoring.getCompositeWeights()).toEqual(reliabilityOnlyWeights);
    expect(score.reliability_score).toBeCloseTo(0.8, 10);
    expect(score.composite_score).toBeCloseTo(0.8, 10);
    expect(JSON.parse(persisted.value)).toEqual(reliabilityOnlyWeights);

    providerScoring.init(db);
    expect(providerScoring.getCompositeWeights()).toEqual(reliabilityOnlyWeights);
  });

  it('rejects invalid composite weight updates', () => {
    expect(() => providerScoring.setCompositeWeights({
      cost: 1,
      speed: 1,
      reliability: 0,
      quality: 0,
    })).toThrow(/sum to 1\.0/);

    expect(() => providerScoring.setCompositeWeights({
      cost: 0.1,
      speed: 0.2,
      reliability: 0.3,
      quality: 0.4,
      latency: 0,
    })).toThrow(/Unknown composite weight/);
  });

  it('routes capability-filtered candidates by trusted composite score', () => {
    configureRoutingCoreForScoring();

    for (let i = 0; i < 5; i += 1) {
      record('codex', { success: true, durationMs: 100, costUsd: 0, qualityScore: 0.95 });
      record('claude-cli', { success: true, durationMs: 400, costUsd: 1, qualityScore: 0.2 });
    }

    const result = providerRoutingCore.analyzeTaskForRouting(
      'Create a new API handler',
      process.cwd(),
      [],
      { tierList: true },
    );

    expect(result.provider).toBe('codex');
    expect(result.eligible_providers[0]).toBe('codex');
    expect(result.routing_score_applied).toBe(true);
    expect(result.routing_score).toMatchObject({
      provider: 'codex',
      source: 'provider_scores',
    });
    expect(result.routing_score.composite_score).toBeGreaterThan(
      providerScoring.getProviderScore('claude-cli').composite_score,
    );
  });

  it('honors task template chain order over trusted composite score', () => {
    configureRoutingCoreForScoring();
    insertRoutingTemplate('Score Chain', {
      default: [
        { provider: 'claude-cli' },
        { provider: 'codex' },
      ],
    });

    for (let i = 0; i < 5; i += 1) {
      record('codex', { success: true, durationMs: 100, costUsd: 0, qualityScore: 0.95 });
      record('claude-cli', { success: true, durationMs: 400, costUsd: 1, qualityScore: 0.2 });
    }

    const result = providerRoutingCore.analyzeTaskForRouting(
      'Coordinate task execution',
      process.cwd(),
      [],
      { taskMetadata: { _routing_template: 'Score Chain' } },
    );

    expect(result.provider).toBe('claude-cli');
    expect(result.reason).not.toContain('score-ranked');
    expect(result.routing_score).toBeUndefined();
  });
});
