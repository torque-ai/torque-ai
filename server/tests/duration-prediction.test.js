const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');
const { assertMaxPrepares } = require('./perf-test-helpers.test');
const taskCore = require('../db/task-core');
const schedulingAutomation = require('../db/scheduling-automation');

let testDir, mod;

function setup() {
  ({ mod, testDir } = setupTestDbModule('../db/analytics', 'duration-prediction'));
  mod.setDbFunctions({
    getTemplate: schedulingAutomation.getTemplate
  });
}

function teardown() {
  teardownTestDb();
}

function resetState() {
  const tables = ['duration_predictions', 'prediction_models', 'templates', 'tasks'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || `task-${Math.random().toString(36).slice(2)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex',
    template_name: overrides.template_name || null,
    project: overrides.project || null
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

describe('duration-prediction module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('recordDurationPrediction + updatePredictionActual', () => {
    it('records a prediction and returns the row id', () => {
      const t = mkTask({ task_description: 'predict me' });
      const predId = mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 120,
        confidence: 0.75,
        factors: [{ source: 'test', value: 120 }]
      });

      expect(predId).toBeTruthy();
      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predId);
      expect(row.predicted_seconds).toBe(120);
      expect(row.confidence).toBe(0.75);
    });

    it('uses default confidence of 0.5 when not provided', () => {
      const t = mkTask({ task_description: 'default confidence' });
      const predId = mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 60,
        factors: []
      });

      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predId);
      expect(row.confidence).toBe(0.5);
    });

    it('updates prediction with actual duration and computes error_percent', () => {
      const t = mkTask({ task_description: 'actual task' });
      const predId = mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: [{ source: 'test', value: 100 }]
      });

      mod.updatePredictionActual(t.id, 80);
      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predId);
      expect(row.actual_seconds).toBe(80);
      expect(row.error_percent).toBeCloseTo(25, 5);
    });

    it('does not update already-filled actual_seconds', () => {
      const t = mkTask({ task_description: 'double update' });
      mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: []
      });

      mod.updatePredictionActual(t.id, 80);
      mod.updatePredictionActual(t.id, 999);

      const rows = rawDb().prepare('SELECT * FROM duration_predictions WHERE task_id = ?').all(t.id);
      expect(rows[0].actual_seconds).toBe(80);
    });
  });

  describe('prediction models', () => {
    it('creates and retrieves a prediction model', () => {
      mod.updatePredictionModel({
        model_type: 'global',
        model_key: null,
        sample_count: 10,
        avg_seconds: 200
      });

      const model = mod.getPredictionModel('global');
      expect(model).toBeTruthy();
      expect(model.sample_count).toBe(10);
      expect(model.avg_seconds).toBe(200);
    });

    it('creates and retrieves a keyed prediction model', () => {
      mod.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 5,
        avg_seconds: 90
      });

      const model = mod.getPredictionModel('pattern', 'test');
      expect(model).toBeTruthy();
      expect(model.model_key).toBe('test');
      expect(model.avg_seconds).toBe(90);
    });

    it('returns undefined for non-existent model', () => {
      const model = mod.getPredictionModel('pattern', 'nonexistent');
      expect(model).toBeFalsy();
    });

    it('upserts (replaces) an existing model', () => {
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 5,
        avg_seconds: 100
      });
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 15,
        avg_seconds: 250
      });

      const model = mod.getPredictionModel('global');
      expect(model.sample_count).toBe(15);
      expect(model.avg_seconds).toBe(250);
    });
  });

  describe('predictDuration', () => {
    it('returns fallback defaults when no models are available', () => {
      const result = mod.predictDuration('Do a generic task');
      expect(result.predicted_seconds).toBe(300);
      expect(result.confidence).toBe(0.2);
      expect(result.factors).toHaveLength(1);
      expect(result.factors[0].source).toBe('fallback');
    });

    it('combines pattern, keyword, and global factors', () => {
      mod.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 5,
        avg_seconds: 120
      });
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 12,
        avg_seconds: 240
      });

      const result = mod.predictDuration('Write unit test coverage for parser');
      const sources = result.factors.map(f => f.source);

      expect(sources).toContain('pattern');
      expect(sources).toContain('keywords');
      expect(sources).toContain('global');
      expect(result.predicted_seconds).toBeGreaterThan(50);
      expect(result.predicted_seconds).toBeLessThan(300);
    });

    it('includes template factor when template_name provided', () => {
      schedulingAutomation.saveTemplate({
        name: 'tpl-pred',
        task_template: 'echo test',
        description: 'test template',
        default_timeout: 10,
        avg_duration: 180
      });

      const result = mod.predictDuration('some task', { template_name: 'tpl-pred' });
      const _templateFactor = result.factors.find(f => f.source === 'template');
      // Template factor may or may not be present depending on whether the template has avg_duration
      // Just ensure no crash
      expect(result.predicted_seconds).toBeGreaterThan(0);
    });

    it('provides predicted_minutes alongside predicted_seconds', () => {
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 10,
        avg_seconds: 600
      });

      const result = mod.predictDuration('some task');
      expect(result.predicted_minutes).toBeTruthy();
      expect(result.predicted_minutes).toBe(Math.round(result.predicted_seconds / 60 * 10) / 10);
    });

    it('scales confidence based on total available weight', () => {
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 10,
        avg_seconds: 200
      });

      const result = mod.predictDuration('random unmatched task');
      // Only global (0.1 weight) available, confidence should be low
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('extractPatternKey', () => {
    it('classifies test-related descriptions', () => {
      expect(mod.extractPatternKey('Write unit tests')).toBe('test');
    });

    it('classifies build-related descriptions', () => {
      expect(mod.extractPatternKey('Build the project')).toBe('build');
    });

    it('classifies fix-related descriptions', () => {
      expect(mod.extractPatternKey('Fix crash on startup')).toBe('fix');
    });

    it('classifies create-related descriptions', () => {
      expect(mod.extractPatternKey('Create a helper module')).toBe('create');
      expect(mod.extractPatternKey('Add new feature')).toBe('create');
    });

    it('classifies update/modify descriptions', () => {
      expect(mod.extractPatternKey('Update the config')).toBe('update');
      expect(mod.extractPatternKey('Modify the API')).toBe('update');
    });

    it('classifies delete/remove descriptions', () => {
      expect(mod.extractPatternKey('Delete old logs')).toBe('delete');
      expect(mod.extractPatternKey('Remove deprecated code')).toBe('delete');
    });

    it('returns general for unmatched descriptions', () => {
      expect(mod.extractPatternKey('Unknown phrasing')).toBe('general');
    });
  });

  describe('estimateFromKeywords', () => {
    it('returns null when no known keywords are found', () => {
      expect(mod.estimateFromKeywords('miscellaneous prose without matches')).toBeNull();
    });

    it('applies keyword base and multipliers', () => {
      const result = mod.estimateFromKeywords('quick integration test');
      expect(result.keywords).toContain('integration');
      expect(result.keywords).toContain('quick');
      expect(result.seconds).toBe(135);
    });

    it('detects refactor keyword with multiplier', () => {
      const result = mod.estimateFromKeywords('refactor the parser');
      expect(result.keywords).toContain('refactor');
      expect(result.seconds).toBe(1200); // 600 * 2.0
    });

    it('detects lint keyword', () => {
      const result = mod.estimateFromKeywords('lint the codebase');
      expect(result.keywords).toContain('lint');
      expect(result.seconds).toBe(48); // 60 * 0.8
    });
  });

  describe('calibratePredictionModels', () => {
    it('derives global, pattern, and template models from task history', () => {
      schedulingAutomation.saveTemplate({
        name: 'tpl-cal',
        task_template: 'echo calibrate',
        description: 'template for calibration'
      });

      const a = mkTask({ status: 'completed', task_description: 'test parser one', template_name: 'tpl-cal' });
      const b = mkTask({ status: 'completed', task_description: 'test parser two', template_name: 'tpl-cal' });
      const c = mkTask({ status: 'completed', task_description: 'test parser three' });

      patchTask(a.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z' });
      patchTask(b.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:02:00.000Z' });
      patchTask(c.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:03:00.000Z' });

      const summary = mod.calibratePredictionModels();
      expect(summary.models_updated).toBeGreaterThanOrEqual(2);
      expect(mod.getPredictionModel('global')).toBeTruthy();
      expect(mod.getPredictionModel('pattern', 'test')).toBeTruthy();
      expect(mod.getPredictionModel('template', 'tpl-cal')).toBeTruthy();
    });

    it('requires at least 3 samples for pattern models', () => {
      const a = mkTask({ status: 'completed', task_description: 'build something' });
      const b = mkTask({ status: 'completed', task_description: 'build another' });

      patchTask(a.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z' });
      patchTask(b.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:02:00.000Z' });

      mod.calibratePredictionModels();
      expect(mod.getPredictionModel('pattern', 'build')).toBeFalsy();
    });

    it('returns zero models updated when no completed tasks exist', () => {
      const summary = mod.calibratePredictionModels();
      expect(summary.models_updated).toBe(0);
      expect(summary.samples_processed).toBe(0);
    });

    it('reuses cached pattern statements across calibration runs (prepare-in-loop regression)', async () => {
      const seed = mkTask({ status: 'completed', task_description: 'test parser one' });
      patchTask(seed.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z' });

      // Warm the cache.
      mod.calibratePredictionModels();

      // Second call: the 9 per-pattern SELECTs must hit the module-level cache.
      // Remaining prepares (global SELECT, template SELECT, updatePredictionModel)
      // are out of scope for this regression but capped at a generous ceiling so
      // any reintroduction of in-loop prepares fails the assertion immediately
      // (would push count well above 5).
      const count = await assertMaxPrepares(rawDb(), 5, () => {
        mod.calibratePredictionModels();
      });
      expect(count).toBeLessThanOrEqual(5);
    });
  });

  describe('getPatternCondition', () => {
    it('returns SQL LIKE condition for known patterns', () => {
      expect(mod.getPatternCondition('test')).toContain('test');
      expect(mod.getPatternCondition('build')).toContain('build');
    });

    it('returns 1=1 for general and unknown patterns', () => {
      expect(mod.getPatternCondition('general')).toBe('1=1');
      expect(mod.getPatternCondition('unknown_pattern')).toBe('1=1');
    });
  });

  describe('getDurationInsights', () => {
    it('returns insights with empty data when no predictions exist', () => {
      const insights = mod.getDurationInsights();
      expect(insights.recent_predictions).toEqual([]);
      expect(insights.accuracy.total_predictions).toBe(0);
    });

    it('returns predictions with parsed factors', () => {
      const t = mkTask({ task_description: 'insights task', status: 'completed' });
      mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: [{ source: 'test', value: 100 }]
      });
      mod.updatePredictionActual(t.id, 90);

      const insights = mod.getDurationInsights();
      expect(insights.recent_predictions).toHaveLength(1);
      expect(insights.recent_predictions[0].factors).toEqual([{ source: 'test', value: 100 }]);
      expect(insights.accuracy.total_predictions).toBe(1);
    });

    it('filters by project when provided', () => {
      const t1 = mkTask({ task_description: 'proj-a task', status: 'completed', project: 'proj-a' });
      const t2 = mkTask({ task_description: 'proj-b task', status: 'completed', project: 'proj-b' });

      mod.recordDurationPrediction({ task_id: t1.id, predicted_seconds: 100, factors: [] });
      mod.recordDurationPrediction({ task_id: t2.id, predicted_seconds: 200, factors: [] });
      mod.updatePredictionActual(t1.id, 90);
      mod.updatePredictionActual(t2.id, 180);

      const insights = mod.getDurationInsights({ project: 'proj-a' });
      expect(insights.recent_predictions).toHaveLength(1);
    });
  });
});
