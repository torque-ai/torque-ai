'use strict';

const providerScoring = require('../db/provider-scoring');
const providerRoutingCore = require('../db/provider-routing-core');
const templateStore = require('../routing/template-store');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');

const DEFAULT_WEIGHTS = {
  cost: 0.15,
  speed: 0.25,
  reliability: 0.35,
  quality: 0.25,
};

function upsertConfig(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function recordSamples(provider, options) {
  for (let i = 0; i < 5; i += 1) {
    providerScoring.recordTaskCompletion({
      provider,
      success: true,
      durationMs: options.durationMs,
      costUsd: options.costUsd,
      qualityScore: options.qualityScore,
    });
  }
}

describe('smart routing template precedence', () => {
  let db;

  beforeEach(() => {
    setupTestDbOnly('smart-routing-template-precedence');
    db = rawDb();

    providerScoring.init(db);
    providerScoring.setCompositeWeights(DEFAULT_WEIGHTS);
    providerRoutingCore.createProviderRoutingCore({
      db,
      taskCore: () => null,
      hostManagement: {
        determineTaskComplexity: () => 'normal',
        routeTask: () => null,
      },
    });
    providerRoutingCore.setProviderScoring(providerScoring);
    providerRoutingCore.setOllamaHealthy(true);

    templateStore.setDb(db);
    templateStore.seedPresets();

    upsertConfig(db, 'smart_routing_enabled', '1');

    const codexPrimary = templateStore.getTemplateByName('Codex Primary');
    expect(codexPrimary).toBeTruthy();
    templateStore.setActiveTemplate(codexPrimary.id);
  });

  afterEach(() => {
    providerRoutingCore.setProviderScoring(null);
    teardownTestDb();
  });

  it('honors explicit active template chain order over trusted provider scores', () => {
    recordSamples('claude-cli', { durationMs: 50, costUsd: 0, qualityScore: 0.99 });
    recordSamples('codex', { durationMs: 1000, costUsd: 5, qualityScore: 0.1 });

    expect(providerScoring.getProviderScore('claude-cli').composite_score)
      .toBeGreaterThan(providerScoring.getProviderScore('codex').composite_score);

    const result = providerRoutingCore.analyzeTaskForRouting(
      'Architect for a software factory: prioritize work items based on project health',
      process.cwd(),
      [],
    );

    expect(result.provider).toBe('codex');
    expect(result.reason).not.toContain('score-ranked');
  });
});
