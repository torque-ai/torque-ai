'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const analytics = require('../db/analytics');

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function createStatement(overrides = {}) {
  return {
    run: overrides.run || vi.fn(() => ({ changes: 1 })),
    get: overrides.get || vi.fn(() => undefined),
    all: overrides.all || vi.fn(() => []),
  };
}

function contains(fragment, statement) {
  return {
    match(sql) {
      return sql.includes(fragment);
    },
    statement,
  };
}

function exact(sqlText, statement) {
  const normalized = normalizeSql(sqlText);
  return {
    match(sql) {
      return sql === normalized;
    },
    statement,
  };
}

function installDb(routes) {
  const db = {
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);
      const route = routes.find((candidate) => candidate.match(normalized));
      if (!route) {
        throw new Error(`Unexpected SQL: ${normalized}`);
      }
      return typeof route.statement === 'function'
        ? route.statement(normalized)
        : route.statement;
    }),
  };

  analytics.setDb(db);
  return db;
}

function createExperimentDb(seed = {}) {
  const experiments = new Map();
  const priorityWrites = [];

  if (Array.isArray(seed.experiments)) {
    seed.experiments.forEach((exp) => {
      experiments.set(exp.id, { ...exp });
    });
  }

  const predictionStats = seed.predictionStats || {
    total_predictions: 0,
    correct: 0,
    incorrect: 0,
    pending: 0,
  };
  const patternStats = seed.patternStats || {
    total_patterns: 0,
    avg_confidence: null,
    avg_failure_rate: null,
  };

  const insertExperiment = createStatement({
    run: vi.fn((id, name, strategyType, variantA, variantB, sampleSize, resultsA, resultsB, createdAt) => {
      experiments.set(id, {
        id,
        name,
        strategy_type: strategyType,
        variant_a: variantA,
        variant_b: variantB,
        status: 'running',
        sample_size_target: sampleSize,
        results_a: resultsA,
        results_b: resultsB,
        winner: null,
        created_at: createdAt,
        completed_at: null,
      });
      return { changes: 1 };
    }),
  });

  const getById = createStatement({
    get: vi.fn((id) => experiments.get(id)),
  });

  const listByStatus = createStatement({
    all: vi.fn((status) => Array.from(experiments.values())
      .filter((exp) => exp.status === status)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))),
  });

  const listAll = createStatement({
    all: vi.fn(() => Array.from(experiments.values())
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))),
  });

  const updateResultsA = createStatement({
    run: vi.fn((resultsJson, id) => {
      const exp = experiments.get(id);
      if (exp) exp.results_a = resultsJson;
      return { changes: exp ? 1 : 0 };
    }),
  });

  const updateResultsB = createStatement({
    run: vi.fn((resultsJson, id) => {
      const exp = experiments.get(id);
      if (exp) exp.results_b = resultsJson;
      return { changes: exp ? 1 : 0 };
    }),
  });

  const completeExperiment = createStatement({
    run: vi.fn((winner, completedAt, id) => {
      const exp = experiments.get(id);
      if (exp) {
        exp.status = 'completed';
        exp.winner = winner;
        exp.completed_at = completedAt;
      }
      return { changes: exp ? 1 : 0 };
    }),
  });

  const priorityConfigInsert = createStatement({
    run: vi.fn((key, value) => {
      priorityWrites.push([key, value]);
      return { changes: 1 };
    }),
  });

  const experimentStats = createStatement({
    get: vi.fn(() => ({
      total_experiments: experiments.size,
      running: Array.from(experiments.values()).filter((exp) => exp.status === 'running').length,
      completed: Array.from(experiments.values()).filter((exp) => exp.status === 'completed').length,
    })),
  });

  const dashboardPredictionStats = createStatement({
    get: vi.fn(() => ({ ...predictionStats })),
  });

  const dashboardPatternStats = createStatement({
    get: vi.fn(() => ({ ...patternStats })),
  });

  installDb([
    contains('INSERT INTO strategy_experiments', insertExperiment),
    exact('SELECT * FROM strategy_experiments WHERE id = ?', getById),
    exact('SELECT * FROM strategy_experiments WHERE status = ? ORDER BY created_at DESC', listByStatus),
    exact('SELECT * FROM strategy_experiments ORDER BY created_at DESC', listAll),
    exact('UPDATE strategy_experiments SET results_a = ? WHERE id = ?', updateResultsA),
    exact('UPDATE strategy_experiments SET results_b = ? WHERE id = ?', updateResultsB),
    contains("UPDATE strategy_experiments SET status = 'completed', winner = ?, completed_at = ?", completeExperiment),
    exact('SELECT COUNT(*) as total_experiments, COUNT(CASE WHEN status = \'running\' THEN 1 END) as running, COUNT(CASE WHEN status = \'completed\' THEN 1 END) as completed FROM strategy_experiments', experimentStats),
    contains('FROM intelligence_log', dashboardPredictionStats),
    contains('FROM failure_patterns', dashboardPatternStats),
    exact('INSERT OR REPLACE INTO priority_config (key, value) VALUES (?, ?)', priorityConfigInsert),
  ]);

  return {
    experiments,
    priorityWrites,
    statements: {
      completeExperiment,
    },
  };
}

describe('server/db/analytics', () => {
  let getTaskMock;
  let getTemplateMock;
  let findSimilarTasksMock;
  let getCacheStatsMock;
  let setCacheConfigMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    getTaskMock = vi.fn(() => null);
    getTemplateMock = vi.fn(() => null);
    findSimilarTasksMock = vi.fn(() => []);
    getCacheStatsMock = vi.fn(() => ({ hits: 0, misses: 0, total: 0 }));
    setCacheConfigMock = vi.fn();

    analytics.setGetTask(getTaskMock);
    analytics.setFindSimilarTasks(findSimilarTasksMock);
    analytics.setDbFunctions({
      getTemplate: getTemplateMock,
      getCacheStats: getCacheStatsMock,
      setCacheConfig: setCacheConfigMock,
    });
    analytics.setSetPriorityWeights(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts dependency injection overrides', () => {
    expect(() => {
      analytics.setDb({ prepare: vi.fn() });
      analytics.setGetTask(() => null);
      analytics.setDbFunctions({ getTemplate: () => null });
      analytics.setFindSimilarTasks(() => []);
      analytics.setSetPriorityWeights(() => {});
    }).not.toThrow();
  });

  describe('helpers', () => {
    it('extractPatternKey maps common verbs and getPatternCondition returns SQL fragments', () => {
      expect(analytics.extractPatternKey('Write test coverage')).toBe('test');
      expect(analytics.extractPatternKey('Refactor queue scheduler')).toBe('refactor');
      expect(analytics.extractPatternKey('Create endpoint')).toBe('create');
      expect(analytics.extractPatternKey('Modify endpoint')).toBe('update');
      expect(analytics.extractPatternKey('Remove endpoint')).toBe('delete');
      expect(analytics.extractPatternKey('Unknown work item')).toBe('general');

      expect(analytics.getPatternCondition('create')).toContain("%add%");
      expect(analytics.getPatternCondition('update')).toContain("%modify%");
      expect(analytics.getPatternCondition('missing-pattern')).toBe('1=1');
    });

    it('estimateFromKeywords applies multipliers and returns null when no keyword matches', () => {
      expect(analytics.estimateFromKeywords('quick lint pass')).toEqual({
        keywords: ['lint', 'quick'],
        seconds: 14,
      });
      expect(analytics.estimateFromKeywords('plain housekeeping')).toBeNull();
    });

    it('extractKeywords returns high-signal words only', () => {
      expect(analytics.extractKeywords('Deploy to production and run test')).toEqual(
        expect.arrayContaining(['deploy', 'production', 'test'])
      );
      expect(analytics.extractKeywords('the quick brown fox')).toEqual([]);
      expect(analytics.extractKeywords(null)).toEqual([]);
    });
  });

  describe('duration prediction', () => {
    it('recordDurationPrediction inserts a row and returns the new row id', () => {
      const insert = createStatement({
        run: vi.fn(() => ({ lastInsertRowid: 17 })),
      });
      installDb([
        contains('INSERT INTO duration_predictions', insert),
      ]);

      const id = analytics.recordDurationPrediction({
        task_id: 'task-1',
        predicted_seconds: 120,
        factors: [{ source: 'template', value: 120 }],
      });

      expect(id).toBe(17);
      expect(insert.run).toHaveBeenCalledWith(
        'task-1',
        120,
        0.5,
        JSON.stringify([{ source: 'template', value: 120 }]),
        expect.any(String)
      );
    });

    it('updatePredictionActual forwards actual duration values into the update query', () => {
      const update = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      installDb([
        contains('UPDATE duration_predictions', update),
      ]);

      analytics.updatePredictionActual('task-2', 80);

      expect(update.run).toHaveBeenCalledWith(80, 80, 80, 'task-2');
    });

    it('getPredictionModel and updatePredictionModel support keyed and global models', () => {
      const models = new Map();
      const insert = createStatement({
        run: vi.fn((id, modelType, modelKey, sampleCount, avgSeconds, stdDeviation, lastCalibratedAt) => {
          models.set(`${modelType}:${modelKey || 'global'}`, {
            id,
            model_type: modelType,
            model_key: modelKey,
            sample_count: sampleCount,
            avg_seconds: avgSeconds,
            std_deviation: stdDeviation,
            last_calibrated_at: lastCalibratedAt,
          });
          return { changes: 1 };
        }),
      });
      const keyedSelect = createStatement({
        get: vi.fn((modelType, modelKey) => models.get(`${modelType}:${modelKey}`)),
      });
      const globalSelect = createStatement({
        get: vi.fn((modelType) => models.get(`${modelType}:global`)),
      });

      installDb([
        contains('INSERT OR REPLACE INTO prediction_models', insert),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key = ?', keyedSelect),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key IS NULL', globalSelect),
      ]);

      const patternModel = analytics.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 4,
        avg_seconds: 90,
      });
      analytics.updatePredictionModel({
        model_type: 'global',
        sample_count: 2,
        avg_seconds: 200,
      });

      expect(patternModel).toMatchObject({
        id: 'pattern:test',
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 4,
        avg_seconds: 90,
      });
      expect(analytics.getPredictionModel('global')).toMatchObject({
        id: 'global:global',
        model_key: null,
        avg_seconds: 200,
      });
      expect(analytics.getPredictionModel('pattern', 'missing')).toBeUndefined();
    });

    it('predictDuration combines template, pattern, keyword, and global factors', () => {
      getTemplateMock.mockReturnValue({ avg_duration: 200 });
      const keyedSelect = createStatement({
        get: vi.fn((modelType, modelKey) => {
          if (modelType === 'pattern' && modelKey === 'test') {
            return { model_key: 'test', avg_seconds: 100 };
          }
          return undefined;
        }),
      });
      const globalSelect = createStatement({
        get: vi.fn((modelType) => {
          if (modelType === 'global') return { avg_seconds: 400 };
          return undefined;
        }),
      });

      installDb([
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key = ?', keyedSelect),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key IS NULL', globalSelect),
      ]);

      const result = analytics.predictDuration('Write unit test coverage', {
        template_name: 'default-template',
      });

      expect(result).toEqual({
        predicted_seconds: 162,
        predicted_minutes: 2.7,
        confidence: 1,
        factors: [
          { source: 'template', name: 'default-template', value: 200, weight: 0.4 },
          { source: 'pattern', name: 'test', value: 100, weight: 0.3 },
          { source: 'keywords', name: 'test, unit test', value: 60, weight: 0.2 },
          { source: 'global', name: 'average', value: 400, weight: 0.1 },
        ],
      });
    });

    it('predictDuration falls back to a low-confidence default when no factors are available', () => {
      const keyedSelect = createStatement({ get: vi.fn(() => undefined) });
      const globalSelect = createStatement({ get: vi.fn(() => undefined) });
      installDb([
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key = ?', keyedSelect),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key IS NULL', globalSelect),
      ]);

      expect(analytics.predictDuration('Do generic work')).toEqual({
        predicted_seconds: 300,
        predicted_minutes: 5,
        confidence: 0.2,
        factors: [{ source: 'fallback', name: 'default', value: 300, weight: 1 }],
      });
    });

    it('calibratePredictionModels updates global, matching pattern, and template models', () => {
      const models = new Map();
      const globalStats = createStatement({
        get: vi.fn(() => ({ count: 4, avg_seconds: 120 })),
      });
      const patternStatsTest = createStatement({
        get: vi.fn(() => ({ count: 5, avg_seconds: 100, avg_sq: 11000 })),
      });
      const patternStatsDefault = createStatement({
        get: vi.fn(() => ({ count: 0, avg_seconds: null, avg_sq: null })),
      });
      const templateStats = createStatement({
        all: vi.fn(() => [{ template_name: 'tpl-build', count: 2, avg_seconds: 150 }]),
      });
      const insertModel = createStatement({
        run: vi.fn((id, modelType, modelKey, sampleCount, avgSeconds, stdDeviation, lastCalibratedAt) => {
          models.set(`${modelType}:${modelKey || 'global'}`, {
            id,
            model_type: modelType,
            model_key: modelKey,
            sample_count: sampleCount,
            avg_seconds: avgSeconds,
            std_deviation: stdDeviation,
            last_calibrated_at: lastCalibratedAt,
          });
          return { changes: 1 };
        }),
      });
      const keyedSelect = createStatement({
        get: vi.fn((modelType, modelKey) => models.get(`${modelType}:${modelKey}`)),
      });
      const globalSelect = createStatement({
        get: vi.fn((modelType) => models.get(`${modelType}:global`)),
      });

      installDb([
        exact(
          'SELECT COUNT(*) as count, AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_seconds FROM tasks WHERE status = \'completed\' AND started_at IS NOT NULL AND completed_at IS NOT NULL',
          globalStats
        ),
        {
          match(sql) {
            return sql.includes('FROM tasks') && sql.includes("AND (LOWER(task_description) LIKE '%test%')");
          },
          statement: patternStatsTest,
        },
        {
          match(sql) {
            return sql.includes('FROM tasks') && sql.includes('AND (') && !sql.includes("%test%");
          },
          statement: patternStatsDefault,
        },
        contains('GROUP BY template_name', templateStats),
        contains('INSERT OR REPLACE INTO prediction_models', insertModel),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key = ?', keyedSelect),
        exact('SELECT * FROM prediction_models WHERE model_type = ? AND model_key IS NULL', globalSelect),
      ]);

      const result = analytics.calibratePredictionModels();

      expect(result).toEqual({
        models_updated: 3,
        samples_processed: 4,
      });
      expect(models.get('pattern:test').std_deviation).toBeCloseTo(Math.sqrt(1000), 5);
      expect(models.get('template:tpl-build')).toMatchObject({
        sample_count: 2,
        avg_seconds: 150,
      });
    });

    it('getDurationInsights parses factors, rounds accuracy, and supports project filtering', () => {
      const recentPredictions = createStatement({
        all: vi.fn(() => [{
          id: 1,
          task_id: 'task-1',
          factors: '[{"source":"pattern"}]',
          actual_seconds: 70,
        }]),
      });
      const accuracy = createStatement({
        get: vi.fn(() => ({
          total: 2,
          avg_error: 12.34,
          within_20_pct: 87.66,
        })),
      });
      const models = createStatement({
        all: vi.fn(() => [{ model_type: 'pattern', model_key: 'test', sample_count: 3 }]),
      });

      installDb([
        {
          match(sql) {
            return sql.includes('FROM duration_predictions') && sql.includes('ORDER BY created_at DESC');
          },
          statement: recentPredictions,
        },
        {
          match(sql) {
            return sql.includes('FROM duration_predictions') && sql.includes('AVG(error_percent)');
          },
          statement: accuracy,
        },
        contains('FROM prediction_models', models),
      ]);

      const result = analytics.getDurationInsights({ project: 'proj-a', limit: 5 });

      expect(recentPredictions.all).toHaveBeenCalledWith('proj-a', 5);
      expect(accuracy.get).toHaveBeenCalledWith('proj-a');
      expect(result.recent_predictions[0].factors).toEqual([{ source: 'pattern' }]);
      expect(result.accuracy).toEqual({
        total_predictions: 2,
        avg_error_percent: 12.3,
        within_20_percent: 87.7,
      });
      expect(result.models).toEqual([{ model_type: 'pattern', model_key: 'test', sample_count: 3 }]);
    });
  });

  describe('prioritization', () => {
    it('setPriorityWeights writes only provided keys and getPriorityWeights parses stored values', () => {
      const insert = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const list = createStatement({
        all: vi.fn(() => [
          { key: 'resource_weight', value: '0.8' },
          { key: 'success_weight', value: '0.15' },
          { key: 'dependency_weight', value: '0.05' },
        ]),
      });

      installDb([
        exact('INSERT OR REPLACE INTO priority_config (key, value) VALUES (?, ?)', insert),
        exact('SELECT key, value FROM priority_config', list),
      ]);

      analytics.setPriorityWeights({ resource: 0.8, dependency: 0.05 });

      expect(insert.run).toHaveBeenCalledTimes(2);
      expect(insert.run).toHaveBeenCalledWith('resource_weight', '0.8');
      expect(insert.run).toHaveBeenCalledWith('dependency_weight', '0.05');
      expect(analytics.getPriorityWeights()).toEqual({
        resource: 0.8,
        success: 0.15,
        dependency: 0.05,
      });
    });

    it('computeResourceScore uses predictions when present and timeout fallback otherwise', () => {
      const selectPrediction = createStatement({
        get: vi.fn((taskId) => {
          if (taskId === 'predicted') return { predicted_seconds: 300 };
          return undefined;
        }),
      });
      installDb([
        contains('SELECT predicted_seconds FROM duration_predictions', selectPrediction),
      ]);

      const predictedScore = analytics.computeResourceScore({ id: 'predicted', timeout_minutes: 60 });
      const fallbackScore = analytics.computeResourceScore({ id: 'fallback', timeout_minutes: 30 });

      expect(predictedScore).toBeCloseTo(1 - (300 / 3600), 5);
      expect(fallbackScore).toBeCloseTo(1 - (1800 / 3600), 5);
      expect(predictedScore).toBeGreaterThan(fallbackScore);
    });

    it('computeSuccessScore returns neutral defaults and computes success rate from similar tasks', () => {
      expect(analytics.computeSuccessScore({})).toBe(0.5);

      findSimilarTasksMock.mockReturnValue([
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.9 },
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.8 },
        { task: { status: 'failed', exit_code: 1 }, similarity: 0.7 },
      ]);
      expect(analytics.computeSuccessScore({ id: 'task-1' })).toBeCloseTo(2 / 3, 5);

      findSimilarTasksMock.mockReturnValue([]);
      expect(analytics.computeSuccessScore({ id: 'task-1' })).toBe(0.5);
    });

    it('computeDependencyScore returns neutral without workflow context and normalizes dependent counts', () => {
      const dependents = createStatement({
        get: vi.fn((taskId) => ({ count: taskId === 'capped' ? 12 : 3 })),
      });
      installDb([
        contains('SELECT COUNT(*) as count FROM downstream', dependents),
      ]);

      expect(analytics.computeDependencyScore({ id: 'none' })).toBe(0.5);
      expect(analytics.computeDependencyScore({ id: 'few', workflow_id: 'wf-1' })).toBe(0.3);
      expect(analytics.computeDependencyScore({ id: 'capped', workflow_id: 'wf-1' })).toBe(1);
    });

    it('computePriorityScore returns null for unknown tasks and persists weighted factor details for known tasks', () => {
      getTaskMock.mockImplementation((taskId) => {
        if (taskId === 'missing') return null;
        return {
          id: taskId,
          timeout_minutes: 60,
          workflow_id: 'wf-1',
        };
      });
      findSimilarTasksMock.mockReturnValue([
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.9 },
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.8 },
        { task: { status: 'failed', exit_code: 1 }, similarity: 0.7 },
      ]);

      const weights = createStatement({
        all: vi.fn(() => [
          { key: 'resource_weight', value: '0.2' },
          { key: 'success_weight', value: '0.3' },
          { key: 'dependency_weight', value: '0.5' },
        ]),
      });
      const prediction = createStatement({
        get: vi.fn(() => ({ predicted_seconds: 1800 })),
      });
      const dependents = createStatement({
        get: vi.fn(() => ({ count: 10 })),
      });
      const insertScore = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });

      installDb([
        exact('SELECT key, value FROM priority_config', weights),
        contains('SELECT predicted_seconds FROM duration_predictions', prediction),
        contains('SELECT COUNT(*) as count FROM downstream', dependents),
        contains('INSERT OR REPLACE INTO task_priority_scores', insertScore),
      ]);

      expect(analytics.computePriorityScore('missing')).toBeNull();

      const result = analytics.computePriorityScore('task-1');
      const storedFactors = JSON.parse(insertScore.run.mock.calls[0][5]);

      expect(result.combined_score).toBeCloseTo(0.8, 5);
      expect(storedFactors).toMatchObject({
        resource: { score: 0.5, weight: 0.2 },
        success: { weight: 0.3 },
        dependency: { score: 1, weight: 0.5 },
      });
    });

    it('getPriorityQueue and getHighestPriorityQueuedTask read queued tasks from stored scores', () => {
      const queue = createStatement({
        all: vi.fn(() => [
          { id: 'task-high', combined_score: 0.9 },
          { id: 'task-low', combined_score: 0.4 },
        ]),
      });
      const highest = createStatement({
        get: vi.fn(() => ({ id: 'task-high', status: 'queued' })),
      });

      installDb([
        {
          match(sql) {
            return sql.includes("WHERE t.status IN ('pending', 'queued')");
          },
          statement: queue,
        },
        {
          match(sql) {
            return sql.includes("WHERE t.status = 'queued'");
          },
          statement: highest,
        },
      ]);

      expect(analytics.getPriorityQueue(2, 0.4)).toEqual([
        { id: 'task-high', combined_score: 0.9 },
        { id: 'task-low', combined_score: 0.4 },
      ]);
      expect(queue.all).toHaveBeenCalledWith(0.4, 2);
      expect(analytics.getHighestPriorityQueuedTask()).toEqual({ id: 'task-high', status: 'queued' });
    });

    it('boostPriority updates existing scores and creates new entries when none exist', () => {
      const existingSelect = createStatement({
        get: vi.fn((taskId) => {
          if (taskId === 'existing') {
            return {
              task_id: 'existing',
              combined_score: 0.8,
              factors: '{"resource":{"score":0.5}}',
            };
          }
          return undefined;
        }),
      });
      const updateExisting = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const insertNew = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });

      installDb([
        exact('SELECT * FROM task_priority_scores WHERE task_id = ?', existingSelect),
        contains('UPDATE task_priority_scores SET combined_score = ?, factors = ?, computed_at = ?', updateExisting),
        contains('INSERT INTO task_priority_scores', insertNew),
      ]);

      const updated = analytics.boostPriority('existing', 0.5, 'urgent');
      const inserted = analytics.boostPriority('new-task', 0.3, 'manual');

      expect(updated).toEqual({
        task_id: 'existing',
        previous_score: 0.8,
        new_score: 1,
      });
      expect(JSON.parse(updateExisting.run.mock.calls[0][1]).manual_boost).toMatchObject({
        amount: 0.5,
        reason: 'urgent',
      });
      expect(inserted).toEqual({
        task_id: 'new-task',
        previous_score: 0.5,
        new_score: 0.8,
      });
      expect(insertNew.run).toHaveBeenCalledWith(
        'new-task',
        0.8,
        expect.stringContaining('"manual_boost"'),
        expect.any(String)
      );
    });
  });

  describe('failure prediction', () => {
    it('learnFailurePattern returns null for unknown or non-failed tasks', () => {
      getTaskMock.mockReturnValueOnce(null);
      expect(analytics.learnFailurePattern('missing')).toBeNull();

      getTaskMock.mockReturnValueOnce({ id: 'task-1', status: 'completed' });
      expect(analytics.learnFailurePattern('task-1')).toBeNull();
    });

    it('learnFailurePattern creates keyword, time-based, and resource patterns for failed tasks', () => {
      getTaskMock.mockReturnValue({
        id: 'failed-1',
        status: 'failed',
        task_description: 'deploy to production',
        created_at: '2026-03-12T15:20:00.000Z',
        started_at: '2026-03-12T15:00:00.000Z',
        completed_at: '2026-03-12T15:45:01.000Z',
      });

      const existingPattern = createStatement({
        get: vi.fn(() => undefined),
      });
      const insertPattern = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });

      installDb([
        exact('SELECT * FROM failure_patterns WHERE id = ?', existingPattern),
        contains('INSERT INTO failure_patterns', insertPattern),
      ]);

      const patterns = analytics.learnFailurePattern('failed-1');

      expect(patterns.filter((pattern) => pattern.type === 'keyword')).toHaveLength(2);
      expect(patterns.map((pattern) => pattern.type)).toEqual(
        expect.arrayContaining(['keyword', 'time_based', 'resource'])
      );
      expect(insertPattern.run).toHaveBeenCalledTimes(4);
    });

    it('matchPatterns returns only patterns that match the current task context', () => {
      const currentHour = new Date().getHours();
      const listPatterns = createStatement({
        all: vi.fn(() => [
          {
            id: 'keyword-deploy',
            pattern_type: 'keyword',
            pattern_definition: '{"keyword":"deploy"}',
            confidence: 0.8,
            failure_rate: 0.9,
            total_matches: 4,
          },
          {
            id: 'time-now',
            pattern_type: 'time_based',
            pattern_definition: JSON.stringify({ hour_start: currentHour, hour_end: currentHour + 1 }),
            confidence: 0.4,
            failure_rate: 0.5,
            total_matches: 2,
          },
          {
            id: 'resource-only',
            pattern_type: 'resource',
            pattern_definition: '{"duration_threshold":1800}',
            confidence: 0.6,
            failure_rate: 0.7,
            total_matches: 3,
          },
          {
            id: 'bad-json',
            pattern_type: 'keyword',
            pattern_definition: 'not-json',
            confidence: 0.9,
            failure_rate: 1,
            total_matches: 1,
          },
        ]),
      });

      installDb([
        contains('SELECT * FROM failure_patterns', listPatterns),
      ]);

      const matches = analytics.matchPatterns('deploy the application');

      expect(matches.map((pattern) => pattern.id)).toEqual(['keyword-deploy', 'time-now']);
    });

    it('predictFailureForTask returns a default low probability when no patterns match', () => {
      const listPatterns = createStatement({
        all: vi.fn(() => []),
      });
      installDb([
        contains('SELECT * FROM failure_patterns', listPatterns),
      ]);

      expect(analytics.predictFailureForTask('unique task')).toEqual({
        probability: 0.1,
        patterns: [],
        confidence: 0.5,
      });
    });

    it('predictFailureForTask computes a weighted probability and parses pattern definitions', () => {
      const currentHour = new Date().getHours();
      const listPatterns = createStatement({
        all: vi.fn(() => [
          {
            id: 'keyword-deploy',
            pattern_type: 'keyword',
            pattern_definition: '{"keyword":"deploy"}',
            confidence: 0.5,
            failure_rate: 0.8,
            total_matches: 5,
          },
          {
            id: 'time-now',
            pattern_type: 'time_based',
            pattern_definition: JSON.stringify({ hour_start: currentHour, hour_end: currentHour + 1 }),
            confidence: 0.4,
            failure_rate: 0.3,
            total_matches: 10,
          },
        ]),
      });
      installDb([
        contains('SELECT * FROM failure_patterns', listPatterns),
      ]);

      const prediction = analytics.predictFailureForTask('deploy during release window');

      expect(prediction.probability).toBeCloseTo(3.2 / 6.5, 5);
      expect(prediction.confidence).toBeCloseTo(0.065, 5);
      expect(prediction.patterns).toEqual([
        {
          id: 'keyword-deploy',
          type: 'keyword',
          definition: { keyword: 'deploy' },
          failure_rate: 0.8,
          confidence: 0.5,
        },
        {
          id: 'time-now',
          type: 'time_based',
          definition: { hour_start: currentHour, hour_end: currentHour + 1 },
          failure_rate: 0.3,
          confidence: 0.4,
        },
      ]);
    });

    it('listFailurePatterns parses JSON fields and deleteFailurePattern reports whether a row was removed', () => {
      const listPatterns = createStatement({
        all: vi.fn(() => [{
          id: 'keyword-deploy',
          pattern_type: 'keyword',
          pattern_definition: '{"keyword":"deploy"}',
          suggested_intervention: '{"type":"review"}',
        }]),
      });
      const deletePattern = createStatement({
        run: vi.fn()
          .mockReturnValueOnce({ changes: 1 })
          .mockReturnValueOnce({ changes: 0 }),
      });

      installDb([
        contains('SELECT * FROM failure_patterns WHERE confidence >= ?', listPatterns),
        exact('DELETE FROM failure_patterns WHERE id = ?', deletePattern),
      ]);

      expect(analytics.listFailurePatterns({
        patternType: 'keyword',
        minConfidence: 0.4,
        limit: 5,
      })).toEqual([{
        id: 'keyword-deploy',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        suggested_intervention: { type: 'review' },
      }]);
      expect(listPatterns.all).toHaveBeenCalledWith(0.4, 'keyword', 5);
      expect(analytics.deleteFailurePattern('keyword-deploy')).toBe(true);
      expect(analytics.deleteFailurePattern('missing')).toBe(false);
    });

    it('suggestIntervention adds review, retry, timeout, and reschedule guidance for risky deployment tasks', () => {
      const currentHour = new Date().getHours();
      const listPatterns = createStatement({
        all: vi.fn(() => [
          {
            id: 'keyword-deploy',
            pattern_type: 'keyword',
            pattern_definition: '{"keyword":"deploy"}',
            confidence: 0.8,
            failure_rate: 0.9,
            total_matches: 10,
          },
          {
            id: 'time-now',
            pattern_type: 'time_based',
            pattern_definition: JSON.stringify({ hour_start: currentHour, hour_end: currentHour + 1 }),
            confidence: 0.6,
            failure_rate: 0.7,
            total_matches: 6,
          },
        ]),
      });
      installDb([
        contains('SELECT * FROM failure_patterns', listPatterns),
      ]);

      const result = analytics.suggestIntervention('deploy to production');

      expect(result.prediction.probability).toBeGreaterThan(0.5);
      expect(result.interventions.map((item) => item.type)).toEqual(
        expect.arrayContaining([
          'flag_for_review',
          'increase_timeout',
          'add_retry_delay',
          'suggest_reschedule',
        ])
      );
    });

    it('logIntelligenceAction stores a JSON payload and updateIntelligenceOutcome adjusts confidence and prunes weak patterns', () => {
      const insertLog = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const lastInsertId = createStatement({
        get: vi.fn(() => ({ id: 7 })),
      });
      const updateLog = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const getLog = createStatement({
        get: vi.fn(() => ({
          id: 7,
          action_type: 'failure_predicted',
          action_details: '{"pattern_ids":["p1","p2"]}',
        })),
      });
      const updatePatternConfidence = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const prunePatterns = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });

      installDb([
        contains('INSERT INTO intelligence_log', insertLog),
        exact('SELECT last_insert_rowid() as id', lastInsertId),
        contains('UPDATE intelligence_log SET outcome = ?', updateLog),
        exact('SELECT * FROM intelligence_log WHERE id = ?', getLog),
        contains('UPDATE failure_patterns SET confidence = MIN(1.0, MAX(0.1, confidence + ?))', updatePatternConfidence),
        contains('DELETE FROM failure_patterns WHERE confidence < 0.3 AND total_matches >= 20', prunePatterns),
      ]);

      const logId = analytics.logIntelligenceAction('task-1', 'failure_predicted', { risk: 0.8 }, 0.75);
      analytics.updateIntelligenceOutcome(logId, 'incorrect');

      expect(logId).toBe(7);
      expect(insertLog.run).toHaveBeenCalledWith(
        'task-1',
        'failure_predicted',
        '{"risk":0.8}',
        0.75,
        expect.any(String)
      );
      expect(updatePatternConfidence.run).toHaveBeenNthCalledWith(1, -0.1, expect.any(String), 'p1');
      expect(updatePatternConfidence.run).toHaveBeenNthCalledWith(2, -0.1, expect.any(String), 'p2');
      expect(prunePatterns.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('adaptive retry', () => {
    it('analyzeRetryPatterns computes success_rate and passes the optional since filter', () => {
      const patterns = createStatement({
        all: vi.fn(() => [
          { strategy_used: 'exponential', error_type: 'timeout', attempts: 4, successes: 3 },
          { strategy_used: 'linear', error_type: 'memory', attempts: 5, successes: 0 },
        ]),
      });
      installDb([
        contains('FROM retry_history rh JOIN tasks t ON rh.task_id = t.id', patterns),
      ]);

      const result = analytics.analyzeRetryPatterns('2026-03-01T00:00:00.000Z');

      expect(patterns.all).toHaveBeenCalledWith('2026-03-01T00:00:00.000Z');
      expect(result).toEqual([
        {
          strategy_used: 'exponential',
          error_type: 'timeout',
          attempts: 4,
          successes: 3,
          success_rate: 0.75,
        },
        {
          strategy_used: 'linear',
          error_type: 'memory',
          attempts: 5,
          successes: 0,
          success_rate: 0,
        },
      ]);
    });

    it('createAdaptiveRetryRule serializes adjustments and getAdaptiveRetryRules parses them for general and filtered lookups', () => {
      vi.spyOn(require('crypto'), 'randomUUID').mockReturnValue('rule-1');

      const insertRule = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const listAll = createStatement({
        all: vi.fn(() => [
          { id: 'rule-1', error_pattern: 'timeout', adjustment: '{"delay_seconds":30}', enabled: 1 },
          { id: 'rule-2', error_pattern: 'memory', adjustment: 'not-json', enabled: 1 },
        ]),
      });
      const listFiltered = createStatement({
        all: vi.fn(() => [
          { id: 'rule-1', error_pattern: 'timeout', adjustment: '{"delay_seconds":30}', enabled: 1 },
        ]),
      });

      installDb([
        contains('INSERT INTO adaptive_retry_rules', insertRule),
        exact('SELECT * FROM adaptive_retry_rules WHERE enabled = 1', listAll),
        contains("SELECT * FROM adaptive_retry_rules WHERE enabled = 1 AND ? LIKE '%' || error_pattern || '%' -- errorText contains error_pattern ORDER BY success_count DESC", listFiltered),
      ]);

      const id = analytics.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 30 });

      expect(id).toBe('rule-1');
      expect(insertRule.run).toHaveBeenCalledWith(
        'rule-1',
        'timeout',
        'delay',
        '{"delay_seconds":30}',
        expect.any(String)
      );
      expect(analytics.getAdaptiveRetryRules()).toEqual([
        { id: 'rule-1', error_pattern: 'timeout', adjustment: { delay_seconds: 30 }, enabled: 1 },
        { id: 'rule-2', error_pattern: 'memory', adjustment: {}, enabled: 1 },
      ]);
      expect(analytics.getAdaptiveRetryRules('timeout detected')).toEqual([
        { id: 'rule-1', error_pattern: 'timeout', adjustment: { delay_seconds: 30 }, enabled: 1 },
      ]);
    });

    it('updateRetryRuleStats increments success and failure counters on the matching statements', () => {
      const successUpdate = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });
      const failureUpdate = createStatement({
        run: vi.fn(() => ({ changes: 1 })),
      });

      installDb([
        exact('UPDATE adaptive_retry_rules SET success_count = success_count + 1 WHERE id = ?', successUpdate),
        exact('UPDATE adaptive_retry_rules SET failure_count = failure_count + 1 WHERE id = ?', failureUpdate),
      ]);

      analytics.updateRetryRuleStats('rule-1', true);
      analytics.updateRetryRuleStats('rule-1', false);

      expect(successUpdate.run).toHaveBeenCalledWith('rule-1');
      expect(failureUpdate.run).toHaveBeenCalledWith('rule-1');
    });

    it('getRetryRecommendation returns null for missing tasks, merges matching rules, and falls back to default adaptations', () => {
      getTaskMock.mockImplementation((taskId) => {
        if (taskId === 'missing') return null;
        return { id: taskId, timeout_minutes: 15 };
      });

      const filteredRules = createStatement({
        all: vi.fn((errorText) => {
          if (errorText === 'timeout happened') {
            return [
              {
                id: 'rule-timeout',
                error_pattern: 'timeout',
                adjustment: '{"delay_seconds":60,"timeout_factor":2}',
                enabled: 1,
              },
            ];
          }
          return [];
        }),
      });

      installDb([
        contains("SELECT * FROM adaptive_retry_rules WHERE enabled = 1 AND ? LIKE '%' || error_pattern || '%'", filteredRules),
      ]);

      expect(analytics.getRetryRecommendation('missing', 'timeout')).toBeNull();
      expect(analytics.getRetryRecommendation('task-1', 'timeout happened')).toEqual({
        task_id: 'task-1',
        original_timeout: 15,
        adaptations: { delay_seconds: 60, timeout_factor: 2 },
        applied_rules: ['rule-timeout'],
      });
      expect(analytics.getRetryRecommendation('task-2', 'timeout 429 memory OOM')).toEqual({
        task_id: 'task-2',
        original_timeout: 15,
        adaptations: {
          timeout_factor: 1.5,
          delay_seconds: 60,
          suggest_smaller_scope: true,
        },
        applied_rules: [],
      });
    });
  });

  describe('experimentation', () => {
    it('createExperiment, getExperiment, and listExperiments manage JSON-backed experiment state', () => {
      vi.spyOn(require('crypto'), 'randomUUID').mockReturnValue('exp-1');
      const env = createExperimentDb();

      const created = analytics.createExperiment(
        'Priority Tuning',
        'prioritization',
        { resource: 0.3 },
        { resource: 0.6 },
        25
      );
      const fetched = analytics.getExperiment('exp-1');
      const listed = analytics.listExperiments();

      expect(created).toEqual({
        id: 'exp-1',
        name: 'Priority Tuning',
        strategy_type: 'prioritization',
      });
      expect(fetched).toMatchObject({
        id: 'exp-1',
        name: 'Priority Tuning',
        strategy_type: 'prioritization',
        status: 'running',
        variant_a: { resource: 0.3 },
        variant_b: { resource: 0.6 },
        results_a: { count: 0, successes: 0, total_duration: 0 },
        results_b: { count: 0, successes: 0, total_duration: 0 },
      });
      expect(listed).toHaveLength(1);
      expect(analytics.getExperiment('missing')).toBeNull();
      expect(env.experiments.get('exp-1').sample_size_target).toBe(25);
    });

    it('assignExperimentVariant is deterministic for the same task and experiment pair', () => {
      const first = analytics.assignExperimentVariant('task-1', 'exp-1');
      const second = analytics.assignExperimentVariant('task-1', 'exp-1');

      expect(first).toBe(second);
      expect(['a', 'b']).toContain(first);
    });

    it('recordExperimentOutcome updates running experiments and rejects missing or completed ones', () => {
      vi.spyOn(require('crypto'), 'randomUUID')
        .mockReturnValueOnce('exp-a')
        .mockReturnValueOnce('exp-b');
      const env = createExperimentDb();

      analytics.createExperiment('Outcome A', 'test', {}, {});
      analytics.createExperiment('Outcome B', 'test', {}, {});
      env.experiments.get('exp-b').status = 'completed';

      expect(analytics.recordExperimentOutcome('missing', 'a', true, 10)).toBe(false);
      expect(analytics.recordExperimentOutcome('exp-b', 'a', true, 10)).toBe(false);
      expect(analytics.recordExperimentOutcome('exp-a', 'a', true, 120)).toBe(true);
      expect(analytics.recordExperimentOutcome('exp-a', 'a', false, 30)).toBe(true);
      expect(analytics.getExperiment('exp-a').results_a).toEqual({
        count: 2,
        successes: 1,
        total_duration: 150,
      });
    });

    it('computeExperimentSignificance handles insufficient samples and identifies the winning variant', () => {
      vi.spyOn(require('crypto'), 'randomUUID')
        .mockReturnValueOnce('exp-low')
        .mockReturnValueOnce('exp-high');
      createExperimentDb();

      analytics.createExperiment('Low N', 'test', {}, {});
      analytics.createExperiment('High N', 'test', {}, {});

      for (let index = 0; index < 5; index++) {
        analytics.recordExperimentOutcome('exp-low', 'a', true, 10);
        analytics.recordExperimentOutcome('exp-low', 'b', false, 10);
      }

      for (let index = 0; index < 15; index++) {
        analytics.recordExperimentOutcome('exp-high', 'a', index < 12, 10);
        analytics.recordExperimentOutcome('exp-high', 'b', index < 5, 10);
      }

      expect(analytics.computeExperimentSignificance('missing')).toBeNull();
      expect(analytics.computeExperimentSignificance('exp-low')).toMatchObject({
        significant: false,
        reason: 'insufficient_samples',
      });
      expect(analytics.computeExperimentSignificance('exp-high')).toMatchObject({
        significant: true,
        winner: 'a',
      });
    });

    it('concludeExperiment completes the experiment and applies winning cache settings when requested', () => {
      vi.spyOn(require('crypto'), 'randomUUID').mockReturnValue('exp-cache');
      const env = createExperimentDb();

      analytics.createExperiment('Cache TTL', 'caching', { ttl: 60 }, { ttl: 300 });
      for (let index = 0; index < 15; index++) {
        analytics.recordExperimentOutcome('exp-cache', 'a', index < 2, 10);
        analytics.recordExperimentOutcome('exp-cache', 'b', index < 13, 10);
      }

      const result = analytics.concludeExperiment('exp-cache', true);

      expect(result).toMatchObject({
        significant: true,
        winner: 'b',
        applied: 'b',
      });
      expect(analytics.getExperiment('exp-cache')).toMatchObject({
        status: 'completed',
        winner: 'b',
      });
      expect(setCacheConfigMock).toHaveBeenCalledWith('ttl', '300');
      expect(env.statements.completeExperiment.run).toHaveBeenCalledTimes(1);
      expect(analytics.concludeExperiment('missing', true)).toBeNull();
    });

    it('getIntelligenceDashboard combines cache, prediction, pattern, and experiment summaries', () => {
      vi.spyOn(require('crypto'), 'randomUUID').mockReturnValue('exp-dashboard');
      createExperimentDb({
        predictionStats: {
          total_predictions: 4,
          correct: 3,
          incorrect: 1,
          pending: 2,
        },
        patternStats: {
          total_patterns: 6,
          avg_confidence: 0.55,
          avg_failure_rate: 0.42,
        },
      });

      analytics.createExperiment('Dashboard', 'test', {}, {});
      const dashboard = analytics.getIntelligenceDashboard('2026-03-01T00:00:00.000Z');

      expect(getCacheStatsMock).toHaveBeenCalledWith('2026-03-01T00:00:00.000Z');
      expect(dashboard).toEqual({
        cache: { hits: 0, misses: 0, total: 0 },
        predictions: {
          total_predictions: 4,
          correct: 3,
          incorrect: 1,
          pending: 2,
          accuracy: 0.75,
        },
        patterns: {
          total_patterns: 6,
          avg_confidence: 0.55,
          avg_failure_rate: 0.42,
        },
        experiments: {
          total_experiments: 1,
          running: 1,
          completed: 0,
        },
      });
    });

    it('getIntelligenceDashboard reports null accuracy when no predictions have been resolved', () => {
      createExperimentDb({
        predictionStats: {
          total_predictions: 3,
          correct: 0,
          incorrect: 0,
          pending: 3,
        },
      });

      expect(analytics.getIntelligenceDashboard().predictions.accuracy).toBeNull();
    });
  });
});
