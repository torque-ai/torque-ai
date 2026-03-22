'use strict';

const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');

let db, mod, modelCaps;

function setup() {
  ({ db, mod } = setupTestDbModule('../db/host-management', 'adaptive'));
  modelCaps = require('../db/model-capabilities');
}

function teardown() {
  teardownTestDb();
}

describe('Adaptive Scoring', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  describe('recordTaskOutcome', () => {
    it('records a successful outcome', () => {
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'code_gen', 'typescript', true, 45.2);
      const rows = rawDb().prepare(
        'SELECT * FROM model_task_outcomes WHERE model_name = ?'
      ).all('qwen2.5-coder:32b');
      expect(rows.length).toBe(1);
      expect(rows[0].success).toBe(1);
      expect(rows[0].task_type).toBe('code_gen');
      expect(rows[0].language).toBe('typescript');
      expect(rows[0].duration_s).toBeCloseTo(45.2, 1);
      expect(rows[0].failure_category).toBeNull();
    });

    it('records a failed outcome', () => {
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'testing', 'javascript', false, 30.0, 'test_failure');
      const rows = rawDb().prepare(
        'SELECT * FROM model_task_outcomes WHERE model_name = ?'
      ).all('qwen2.5-coder:32b');
      expect(rows.length).toBe(1);
      expect(rows[0].success).toBe(0);
      expect(rows[0].failure_category).toBe('test_failure');
    });

    it('records outcome with null language', () => {
      mod.recordTaskOutcome('qwen3:8b', 'docs', null, true, 10.0);
      const rows = rawDb().prepare(
        'SELECT * FROM model_task_outcomes WHERE model_name = ? AND language IS NULL'
      ).all('qwen3:8b');
      expect(rows.length).toBe(1);
    });

    it('records outcome with null duration', () => {
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'python', true, null);
      const rows = rawDb().prepare(
        'SELECT * FROM model_task_outcomes WHERE model_name = ? AND duration_s IS NULL'
      ).all('qwen3:8b');
      expect(rows.length).toBe(1);
    });
  });

  describe('computeAdaptiveScores', () => {
    it('returns null with fewer than 5 outcomes', () => {
      mod.recordTaskOutcome('qwen3:8b', 'docs', null, true, 10.0);
      mod.recordTaskOutcome('qwen3:8b', 'code_gen', 'python', true, null);

      expect(mod.computeAdaptiveScores('qwen3:8b')).toBeNull();
    });

    it('returns per-task-type success rates with 5+ outcomes', () => {
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'code_gen', 'typescript', true, 45.2);
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'testing', 'javascript', false, 30.0, 'test_failure');
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'code_gen', 'typescript', true, 40);
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'code_gen', 'typescript', true, 35);
      mod.recordTaskOutcome('qwen2.5-coder:32b', 'code_gen', 'typescript', false, 50);

      const scores = mod.computeAdaptiveScores('qwen2.5-coder:32b');
      expect(scores).toBeTruthy();
      expect(scores.code_gen).toBeTruthy();
      expect(scores.code_gen.successRate).toBeCloseTo(0.75, 2); // 3 success / 4 total code_gen
      expect(scores.code_gen.count).toBe(4);
      expect(scores.testing.successRate).toBe(0); // 0/1
      expect(scores.testing.count).toBe(1);
    });

    it('returns null for unknown model', () => {
      expect(mod.computeAdaptiveScores('nonexistent:1b')).toBeNull();
    });
  });

  describe('getModelFormatFailures', () => {
    it('returns only recent models with repeated parse and format failures', () => {
      modelCaps.recordTaskOutcome('format-model-a', 'code_gen', 'typescript', false, 12, 'parse_error');
      modelCaps.recordTaskOutcome('format-model-a', 'code_gen', 'typescript', false, 10, 'parse_error');
      modelCaps.recordTaskOutcome('format-model-a', 'code_gen', 'typescript', false, 9, 'parse_error');
      modelCaps.recordTaskOutcome('format-model-b', 'code_gen', 'javascript', false, 8, 'format_mismatch');
      modelCaps.recordTaskOutcome('format-model-b', 'code_gen', 'javascript', false, 7, 'format_mismatch');
      modelCaps.recordTaskOutcome('format-model-b', 'code_gen', 'javascript', false, 6, 'format_mismatch');
      modelCaps.recordTaskOutcome('format-model-c', 'testing', 'javascript', false, 15, 'test_failure');
      modelCaps.recordTaskOutcome('format-model-c', 'testing', 'javascript', false, 14, 'test_failure');
      modelCaps.recordTaskOutcome('format-model-c', 'testing', 'javascript', false, 13, 'test_failure');

      const rows = modelCaps.getModelFormatFailures(3);

      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          model_name: 'format-model-a',
          failure_category: 'parse_error',
          failure_count: 3,
        }),
        expect.objectContaining({
          model_name: 'format-model-b',
          failure_category: 'format_mismatch',
          failure_count: 3,
        }),
      ]));
      expect(rows).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ model_name: 'format-model-c' }),
      ]));
    });
  });
});
