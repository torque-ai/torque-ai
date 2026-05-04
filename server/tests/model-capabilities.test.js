'use strict';

const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let mod;

describe('Model Capabilities Registry', () => {
  beforeAll(() => {
    ({ mod } = setupTestDbModule('../db/host/management', 'model-caps'));
    mod.upsertModelCapabilities(TEST_MODELS.QUALITY, {
      score_code_gen: 0.9,
      score_refactoring: 0.85,
      score_testing: 0.8,
      score_reasoning: 0.7,
      score_docs: 0.65,
      lang_typescript: 0.9,
      lang_javascript: 0.9,
      lang_python: 0.75,
      lang_csharp: 0.7,
      lang_go: 0.65,
      lang_rust: 0.6,
      lang_general: 0.75,
      context_window: 16384,
      param_size_b: 32,
      source: 'fixture',
    });
    mod.upsertModelCapabilities(TEST_MODELS.BALANCED, {
      score_code_gen: 0.75,
      score_refactoring: 0.7,
      score_testing: 0.65,
      score_reasoning: 0.6,
      score_docs: 0.7,
      lang_typescript: 0.75,
      lang_javascript: 0.75,
      lang_python: 0.7,
      lang_csharp: 0.65,
      lang_go: 0.6,
      lang_rust: 0.55,
      lang_general: 0.7,
      context_window: 8192,
      param_size_b: 14,
      source: 'fixture',
    });
    // Reasoning-specialist model (replaces hardcoded deepseek-r1:14b refs)
    mod.upsertModelCapabilities('test-reasoning:14b', {
      score_code_gen: 0.6,
      score_refactoring: 0.6,
      score_testing: 0.6,
      score_reasoning: 0.95,
      score_docs: 0.5,
      lang_typescript: 0.6, lang_javascript: 0.6, lang_python: 0.7,
      lang_csharp: 0.5, lang_go: 0.5, lang_rust: 0.5, lang_general: 0.65,
      context_window: 16384,
      param_size_b: 14,
      is_thinking_model: 1,
      source: 'fixture',
    });
    // Small-context model for context_window filter tests
    mod.upsertModelCapabilities('test-small-ctx:4b', {
      score_code_gen: 0.4,
      score_refactoring: 0.3,
      score_testing: 0.3,
      score_reasoning: 0.3,
      score_docs: 0.4,
      lang_typescript: 0.4, lang_javascript: 0.4, lang_python: 0.4,
      lang_csharp: 0.3, lang_go: 0.3, lang_rust: 0.3, lang_general: 0.35,
      context_window: 2048,
      param_size_b: 4,
      source: 'fixture',
    });
  });
  afterAll(() => teardownTestDb());

  describe('table seeding', () => {
    it('model_capabilities table exists with seeded data', () => {
      const rows = rawDb().prepare('SELECT * FROM model_capabilities').all();
      expect(rows.length).toBeGreaterThan(0);
    });

    it('the quality test model has highest code_gen score', () => {
      const row = rawDb().prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get(TEST_MODELS.QUALITY);
      expect(row).toBeTruthy();
      expect(row.score_code_gen).toBeGreaterThanOrEqual(0.85);
    });

    it('test-reasoning:14b has highest reasoning score', () => {
      const row = rawDb().prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get('test-reasoning:14b');
      expect(row).toBeTruthy();
      expect(row.score_reasoning).toBeGreaterThanOrEqual(0.85);
    });

    it('all scores are between 0 and 1', () => {
      const rows = rawDb().prepare('SELECT * FROM model_capabilities').all();
      const scoreCols = ['score_code_gen','score_refactoring','score_testing','score_reasoning','score_docs','lang_typescript','lang_javascript','lang_python','lang_csharp','lang_go','lang_rust','lang_general'];
      for (const row of rows) {
        for (const col of scoreCols) {
          expect(row[col]).toBeGreaterThanOrEqual(0);
          expect(row[col]).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('getModelCapabilities', () => {
    it('returns capabilities for a known model', () => {
      const caps = mod.getModelCapabilities(TEST_MODELS.QUALITY);
      expect(caps).toBeTruthy();
      expect(caps.model_name).toBe(TEST_MODELS.QUALITY);
      expect(caps.context_window).toBeGreaterThan(0);
    });

    it('returns null for unknown model', () => {
      expect(mod.getModelCapabilities('nonexistent:1b')).toBeNull();
    });
  });

  describe('listModelCapabilities', () => {
    it('returns all seeded models', () => {
      expect(mod.listModelCapabilities().length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('upsertModelCapabilities', () => {
    it('inserts a new model', () => {
      mod.upsertModelCapabilities('test-model:7b', { score_code_gen: 0.6, score_refactoring: 0.5, score_testing: 0.4, score_reasoning: 0.3, score_docs: 0.7, lang_typescript: 0.5, lang_python: 0.8, context_window: 8192, param_size_b: 7, source: 'user' });
      const caps = mod.getModelCapabilities('test-model:7b');
      expect(caps).toBeTruthy();
      expect(caps.score_code_gen).toBe(0.6);
      expect(caps.lang_python).toBe(0.8);
      expect(caps.source).toBe('user');
    });

    it('updates an existing model', () => {
      mod.upsertModelCapabilities('test-model:7b', { score_code_gen: 0.9 });
      const caps = mod.getModelCapabilities('test-model:7b');
      expect(caps.score_code_gen).toBe(0.9);
      expect(caps.lang_python).toBe(0.8);
    });
  });

  describe('selectBestModel', () => {
    it('ranks the quality test model first for code_gen + typescript', () => {
      const result = mod.selectBestModel('code_gen', 'typescript', 'complex', [TEST_MODELS.QUALITY, TEST_MODELS.BALANCED, 'test-reasoning:14b']);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].model).toBe(TEST_MODELS.QUALITY);
    });

    it('ranks reasoning model first for reasoning tasks', () => {
      const result = mod.selectBestModel('reasoning', 'general', 'normal', [TEST_MODELS.QUALITY, TEST_MODELS.BALANCED, 'test-reasoning:14b']);
      expect(result[0].model).toBe('test-reasoning:14b');
    });

    it('filters models by context window', () => {
      const result = mod.selectBestModel('code_gen', 'typescript', 'normal', [TEST_MODELS.QUALITY, 'test-small-ctx:4b'], { estimatedTokens: 5000 });
      expect(result.map(r => r.model)).not.toContain('test-small-ctx:4b');
    });

    it('returns empty array for empty models', () => {
      expect(mod.selectBestModel('code_gen', 'typescript', 'normal', [])).toEqual([]);
    });

    it('gives unknown models default 0.5 scores', () => {
      const result = mod.selectBestModel('code_gen', 'typescript', 'normal', ['unknown-model:7b']);
      expect(result.length).toBe(1);
      expect(result[0].score).toBeGreaterThan(0);
    });

    it('applies complexity bonus for larger models on complex tasks', () => {
      const complexResult = mod.selectBestModel('code_gen', 'general', 'complex', [TEST_MODELS.QUALITY, 'qwen3:8b']);
      const simpleResult = mod.selectBestModel('code_gen', 'general', 'simple', [TEST_MODELS.QUALITY, 'qwen3:8b']);
      expect(complexResult[0].score - complexResult[1].score).toBeGreaterThan(simpleResult[0].score - simpleResult[1].score);
    });

    it('returns results sorted by score descending', () => {
      const result = mod.selectBestModel('code_gen', 'typescript', 'normal', ['gemma3:4b', TEST_MODELS.QUALITY, TEST_MODELS.BALANCED, 'qwen3:8b']);
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
      }
    });
  });

  describe('getModelLeaderboard', () => {
    beforeEach(() => {
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'javascript', 1, 30);
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'javascript', 1, 25);
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'javascript', 0, 40);
      mod.recordTaskOutcome(TEST_MODELS.BALANCED, 'code_gen', 'javascript', 1, 20);
      mod.recordTaskOutcome(TEST_MODELS.BALANCED, 'code_gen', 'javascript', 1, 18);
    });

    it('should return models ranked by success rate', () => {
      const lb = mod.getModelLeaderboard();
      expect(lb.length).toBeGreaterThan(0);
      expect(lb[0].model_name).toBe(TEST_MODELS.BALANCED);
      expect(lb[0].success_rate).toBe(100);
    });

    it('should filter by task_type', () => {
      mod.recordTaskOutcome('qwen3:8b', 'testing', 'javascript', 1, 15);
      const lb = mod.getModelLeaderboard({ task_type: 'testing' });
      expect(lb.length).toBe(1);
    });

    it('should filter by language', () => {
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'python', 1, 20);
      expect(mod.getModelLeaderboard({ language: 'python' }).length).toBe(1);
    });

    it('should respect limit parameter', () => {
      expect(mod.getModelLeaderboard({ limit: 1 }).length).toBe(1);
    });

    it('should return empty array when no data', () => {
      expect(mod.getModelLeaderboard({ days: 0 })).toEqual([]);
    });
  });
});
