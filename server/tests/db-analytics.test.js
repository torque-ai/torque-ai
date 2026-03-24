'use strict';
/* global describe, it, expect, beforeAll, afterAll, beforeEach, vi */

const { randomUUID } = require('crypto');
const analytics = require('../db/analytics');
const { setupTestDb, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let db;
let testDir;
let getCacheStatsMock;
let setCacheConfigMock;

const RESET_TABLES = [
  'duration_predictions',
  'prediction_models',
  'task_priority_scores',
  'task_dependencies',
  'workflows',
  'similar_tasks',
  'failure_patterns',
  'intelligence_log',
  'retry_history',
  'adaptive_retry_rules',
  'strategy_experiments',
  'priority_config',
  'cache_config',
  'templates',
  'tasks',
];

function ensureColumn(tableName, columnName, definition) {
  const exists = rawDb()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);

  if (!exists) {
    rawDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
    id,
    task_description: overrides.task_description || `analytics task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex',
    model: overrides.model || 'test-model',
    project: overrides.project || null,
    template_name: overrides.template_name || null,
    workflow_id: overrides.workflow_id || null,
    metadata: overrides.metadata || null,
  });

  if (overrides.patch) {
    patchTask(id, overrides.patch);
  }

  return db.getTask(id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;

  const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
  rawDb()
    .prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), taskId);
}

function ensureWorkflow(workflowId) {
  if (!workflowId) return;
  const existing = rawDb().prepare('SELECT id FROM workflows WHERE id = ?').get(workflowId);
  if (existing) return;

  rawDb().prepare(`
    INSERT INTO workflows (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
  `).run(workflowId, `Workflow ${workflowId}`, 'pending', new Date().toISOString());
}

function insertTaskDependency(taskId, dependsOnTaskId, workflowId = 'wf-analytics') {
  ensureWorkflow(workflowId);
  rawDb().prepare(`
    INSERT INTO task_dependencies (
      workflow_id, task_id, depends_on_task_id, condition_expr, on_fail, alternate_task_id, created_at
    ) VALUES (?, ?, ?, NULL, 'skip', NULL, ?)
  `).run(workflowId, taskId, dependsOnTaskId, new Date().toISOString());
}

function saveTemplate(name, avgDuration) {
  db.saveTemplate({
    name,
    task_template: `echo ${name}`,
    description: `${name} template`,
    default_timeout: 15,
  });
  rawDb().prepare('UPDATE templates SET avg_duration = ? WHERE name = ?').run(avgDuration, name);
  return db.getTemplate(name);
}

function insertFailurePattern({
  id = randomUUID(),
  pattern_type,
  pattern_definition,
  failure_count = 1,
  total_matches = 1,
  failure_rate = 1,
  suggested_intervention = null,
  confidence = 0.5,
  created_at = new Date().toISOString(),
  last_updated_at = new Date().toISOString(),
}) {
  rawDb().prepare(`
    INSERT INTO failure_patterns (
      id, pattern_type, pattern_definition, failure_count, total_matches,
      failure_rate, suggested_intervention, confidence, last_updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    pattern_type,
    JSON.stringify(pattern_definition),
    failure_count,
    total_matches,
    failure_rate,
    suggested_intervention ? JSON.stringify(suggested_intervention) : null,
    confidence,
    last_updated_at,
    created_at,
  );

  return id;
}

function insertRetryHistory(taskId, attemptNumber, strategyUsed, errorMessage, timestamp) {
  rawDb().prepare(`
    INSERT INTO retry_history (
      task_id, attempt_number, delay_used, error_message, prompt_modification,
      retried_at, strategy_used, timestamp
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(taskId, attemptNumber, 15, errorMessage, timestamp, strategyUsed, timestamp);
}

describe('server/db/analytics (real DB)', () => {
  beforeAll(() => {
    ({ db, testDir } = setupTestDb('db-analytics'));
    ensureColumn('templates', 'avg_duration', 'avg_duration REAL');
    ensureColumn('retry_history', 'strategy_used', 'strategy_used TEXT');
    ensureColumn('retry_history', 'timestamp', 'timestamp TEXT');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    resetTables(RESET_TABLES);

    getCacheStatsMock = vi.fn(() => ({ hits: 3, misses: 1, total: 4 }));
    setCacheConfigMock = vi.fn((key, value) => db.setCacheConfig(key, value));

    analytics.setDb(rawDb());
    analytics.setGetTask((taskId) => db.getTask(taskId));
    analytics.setDbFunctions({
      getTemplate: (name) => db.getTemplate(name),
      getCacheStats: getCacheStatsMock,
      setCacheConfig: setCacheConfigMock,
    });
    analytics.setFindSimilarTasks((taskId, options) => db.findSimilarTasks(taskId, options));
    analytics.setSetPriorityWeights(() => {});
  });

  describe('dependency injection and helpers', () => {
    it('supports dependency injection setters and routes through the injected functions', () => {
      const task = createTask({ timeout_minutes: 20 });
      const getTaskMock = vi.fn((taskId) => db.getTask(taskId));
      const findSimilarTasksMock = vi.fn(() => []);
      const getTemplateMock = vi.fn(() => ({ avg_duration: 75 }));
      const cacheStatsMock = vi.fn(() => ({ hits: 1, misses: 0, total: 1 }));

      expect(analytics.setDb(rawDb())).toBeUndefined();
      expect(analytics.setGetTask(getTaskMock)).toBeUndefined();
      expect(analytics.setDbFunctions({
        getTemplate: getTemplateMock,
        getCacheStats: cacheStatsMock,
        setCacheConfig: setCacheConfigMock,
      })).toBeUndefined();
      expect(analytics.setFindSimilarTasks(findSimilarTasksMock)).toBeUndefined();
      expect(analytics.setSetPriorityWeights(vi.fn())).toBeUndefined();

      const prediction = analytics.predictDuration('custom task', { template_name: 'template-only' });
      const priority = analytics.computePriorityScore(task.id);
      analytics.getIntelligenceDashboard('2026-03-01T00:00:00.000Z');

      expect(prediction).toMatchObject({
        predicted_seconds: 75,
        confidence: 0.57,
      });
      expect(prediction.factors).toEqual([
        { source: 'template', name: 'template-only', value: 75, weight: 0.4 },
      ]);
      expect(getTemplateMock).toHaveBeenCalledWith('template-only');
      expect(getTaskMock).toHaveBeenCalledWith(task.id);
      expect(findSimilarTasksMock).toHaveBeenCalledWith(task.id, { limit: 10 });
      expect(priority.task_id).toBe(task.id);
      expect(cacheStatsMock).toHaveBeenCalledWith('2026-03-01T00:00:00.000Z');
    });

    it('helper classifiers handle empty inputs and keyword combinations', () => {
      expect(analytics.extractPatternKey('Write regression tests')).toBe('test');
      expect(analytics.extractPatternKey('')).toBe('general');
      expect(analytics.estimateFromKeywords('quick integration test')).toEqual({
        keywords: ['test', 'integration', 'quick'],
        seconds: 135,
      });
      expect(analytics.estimateFromKeywords('plain housekeeping')).toBeNull();
      expect(analytics.getPatternCondition('create')).toContain("%create%");
      expect(analytics.getPatternCondition('unknown')).toBe('1=1');
    });
  });

  describe('duration prediction', () => {
    it('records predictions with default confidence and preserves null error for zero actual duration', () => {
      const task = createTask({ task_description: 'zero boundary task' });
      const predictionId = analytics.recordDurationPrediction({
        task_id: task.id,
        predicted_seconds: 120,
        factors: [{ source: 'fallback', value: 120 }],
      });

      analytics.updatePredictionActual(task.id, 0);

      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predictionId);
      expect(row.confidence).toBe(0.5);
      expect(row.actual_seconds).toBe(0);
      expect(row.error_percent).toBeNull();
    });

    it('updates actual duration only once and computes the error percent', () => {
      const task = createTask({ task_description: 'actual duration task' });
      const predictionId = analytics.recordDurationPrediction({
        task_id: task.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: [{ source: 'pattern', value: 100 }],
      });

      analytics.updatePredictionActual(task.id, 80);
      analytics.updatePredictionActual(task.id, 150);

      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predictionId);
      expect(row.actual_seconds).toBe(80);
      expect(row.error_percent).toBeCloseTo(25, 5);
    });

    it('creates and retrieves keyed and global prediction models', () => {
      const keyed = analytics.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 4,
        avg_seconds: 90,
        std_deviation: 12,
      });
      const global = analytics.updatePredictionModel({
        model_type: 'global',
        sample_count: 12,
        avg_seconds: 240,
      });

      expect(keyed).toMatchObject({
        id: 'pattern:test',
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 4,
        avg_seconds: 90,
      });
      expect(global).toMatchObject({
        id: 'global:global',
        model_key: null,
        avg_seconds: 240,
      });
      expect(analytics.getPredictionModel('pattern', 'missing')).toBeUndefined();
    });

    it('combines template, pattern, keyword, and global factors when predicting duration', () => {
      saveTemplate('tpl-duration', 200);
      analytics.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 5,
        avg_seconds: 100,
      });
      analytics.updatePredictionModel({
        model_type: 'global',
        sample_count: 15,
        avg_seconds: 400,
      });

      const result = analytics.predictDuration('Write unit test coverage', {
        template_name: 'tpl-duration',
      });

      expect(result).toEqual({
        predicted_seconds: 162,
        predicted_minutes: 2.7,
        confidence: 1,
        factors: [
          { source: 'template', name: 'tpl-duration', value: 200, weight: 0.4 },
          { source: 'pattern', name: 'test', value: 100, weight: 0.3 },
          { source: 'keywords', name: 'test, unit test', value: 60, weight: 0.2 },
          { source: 'global', name: 'average', value: 400, weight: 0.1 },
        ],
      });
    });

    it('falls back to the default five-minute estimate when no model data exists', () => {
      const result = analytics.predictDuration('Do generic work');

      expect(result).toEqual({
        predicted_seconds: 300,
        predicted_minutes: 5,
        confidence: 0.2,
        factors: [{ source: 'fallback', name: 'default', value: 300, weight: 1 }],
      });
    });

    it('calibrates global, pattern, and template models from task history', () => {
      saveTemplate('tpl-calibration', 180);

      const first = createTask({
        status: 'completed',
        task_description: 'test parser one',
        template_name: 'tpl-calibration',
      });
      const second = createTask({
        status: 'completed',
        task_description: 'test parser two',
        template_name: 'tpl-calibration',
      });
      const third = createTask({
        status: 'completed',
        task_description: 'test parser three',
      });

      patchTask(first.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:01:00.000Z',
      });
      patchTask(second.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:02:00.000Z',
      });
      patchTask(third.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:03:00.000Z',
      });

      const summary = analytics.calibratePredictionModels();
      const patternModel = analytics.getPredictionModel('pattern', 'test');
      const templateModel = analytics.getPredictionModel('template', 'tpl-calibration');

      expect(summary).toEqual({
        models_updated: 4,
        samples_processed: 3,
      });
      expect(analytics.getPredictionModel('global')).toBeTruthy();
      expect(patternModel.sample_count).toBe(3);
      expect(templateModel.sample_count).toBe(2);
      expect(templateModel.avg_seconds).toBeCloseTo(90, 4);
    });

    it('returns zero calibration results when there is no completed history', () => {
      expect(analytics.calibratePredictionModels()).toEqual({
        models_updated: 0,
        samples_processed: 0,
      });
    });

    it('returns empty duration insights when the prediction tables are empty', () => {
      const insights = analytics.getDurationInsights();

      expect(insights).toEqual({
        recent_predictions: [],
        accuracy: {
          total_predictions: 0,
          avg_error_percent: 0,
          within_20_percent: 0,
        },
        models: [],
      });
    });

    it('filters duration insights by project and parses stored factor JSON', () => {
      const taskA = createTask({
        status: 'completed',
        task_description: 'project A task',
        project: 'proj-a',
      });
      const taskB = createTask({
        status: 'completed',
        task_description: 'project B task',
        project: 'proj-b',
      });

      const predictionA = analytics.recordDurationPrediction({
        task_id: taskA.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: [{ source: 'pattern', value: 100 }],
      });
      analytics.recordDurationPrediction({
        task_id: taskB.id,
        predicted_seconds: 200,
        confidence: 0.9,
        factors: [{ source: 'global', value: 200 }],
      });

      analytics.updatePredictionActual(taskA.id, 90);
      analytics.updatePredictionActual(taskB.id, 180);

      rawDb().prepare('UPDATE duration_predictions SET created_at = ? WHERE id = ?').run(
        '2026-01-01T00:00:00.000Z',
        predictionA,
      );

      const insights = analytics.getDurationInsights({ project: 'proj-a', limit: 5 });

      expect(insights.recent_predictions).toHaveLength(1);
      expect(insights.recent_predictions[0].factors).toEqual([{ source: 'pattern', value: 100 }]);
      expect(insights.accuracy).toEqual({
        total_predictions: 1,
        avg_error_percent: 11.1,
        within_20_percent: 100,
      });
    });
  });

  describe('prioritization', () => {
    it('persists custom priority weights and keeps unspecified values intact', () => {
      analytics.setPriorityWeights({ resource: 0.5, success: 0.3, dependency: 0.2 });
      analytics.setPriorityWeights({ resource: 0.8 });

      expect(analytics.getPriorityWeights()).toEqual({
        resource: 0.8,
        success: 0.3,
        dependency: 0.2,
      });
    });

    it('uses predictions for resource score and clamps long fallback durations to zero', () => {
      const predictedTask = createTask({ timeout_minutes: 60 });
      analytics.recordDurationPrediction({
        task_id: predictedTask.id,
        predicted_seconds: 300,
        factors: [],
      });

      const predictedScore = analytics.computeResourceScore(db.getTask(predictedTask.id));
      const longScore = analytics.computeResourceScore({ id: 'missing', timeout_minutes: 120 });

      expect(predictedScore).toBeCloseTo(1 - (300 / 3600), 5);
      expect(longScore).toBe(0);
    });

    it('computes success score from similar task outcomes and falls back to neutral for missing ids', () => {
      const target = createTask({ task_description: 'deploy api production' });
      const successOne = createTask({
        status: 'completed',
        task_description: 'deploy api production service',
      });
      const successTwo = createTask({
        status: 'completed',
        task_description: 'deploy api production rollback',
      });
      const failed = createTask({
        status: 'failed',
        task_description: 'deploy api production database',
      });
      createTask({
        status: 'completed',
        task_description: 'write documentation for the website',
      });

      patchTask(successOne.id, { exit_code: 0 });
      patchTask(successTwo.id, { exit_code: 0 });
      patchTask(failed.id, { exit_code: 1 });

      expect(analytics.computeSuccessScore({})).toBe(0.5);
      expect(analytics.computeSuccessScore(db.getTask(target.id))).toBeCloseTo(2 / 3, 5);
    });

    it('returns a neutral dependency score without workflow context and caps large dependency graphs at one', () => {
      const standalone = createTask();
      const root = createTask({ workflow_id: 'wf-deps' });

      for (let index = 0; index < 11; index++) {
        const dependent = createTask({ workflow_id: 'wf-deps' });
        insertTaskDependency(dependent.id, root.id, 'wf-deps');
      }

      expect(analytics.computeDependencyScore(db.getTask(standalone.id))).toBe(0.5);
      expect(analytics.computeDependencyScore(db.getTask(root.id))).toBe(1);
    });

    it('computes a combined priority score and stores the factor breakdown', () => {
      const task = createTask({
        task_description: 'deploy api production',
        timeout_minutes: 60,
        workflow_id: 'wf-priority',
      });

      analytics.recordDurationPrediction({
        task_id: task.id,
        predicted_seconds: 1800,
        factors: [],
      });

      const similarCompletedA = createTask({
        status: 'completed',
        task_description: 'deploy api production service',
        workflow_id: 'wf-priority',
      });
      const similarCompletedB = createTask({
        status: 'completed',
        task_description: 'deploy api production workers',
        workflow_id: 'wf-priority',
      });
      const similarFailed = createTask({
        status: 'failed',
        task_description: 'deploy api production database',
        workflow_id: 'wf-priority',
      });

      patchTask(similarCompletedA.id, { exit_code: 0 });
      patchTask(similarCompletedB.id, { exit_code: 0 });
      patchTask(similarFailed.id, { exit_code: 1 });

      for (let index = 0; index < 10; index++) {
        const dependent = createTask({ workflow_id: 'wf-priority' });
        insertTaskDependency(dependent.id, task.id, 'wf-priority');
      }

      expect(analytics.computePriorityScore('missing-task')).toBeNull();

      const result = analytics.computePriorityScore(task.id);
      const stored = rawDb().prepare('SELECT * FROM task_priority_scores WHERE task_id = ?').get(task.id);

      expect(result.combined_score).toBeCloseTo(0.75, 2);
      expect(result.factors).toMatchObject({
        resource: { score: 0.5, weight: 0.3 },
        success: { score: 2 / 3, weight: 0.3 },
        dependency: { score: 1, weight: 0.4 },
      });
      expect(JSON.parse(stored.factors)).toMatchObject(result.factors);
    });

    it('orders the priority queue by score and returns the highest queued task', () => {
      const high = createTask({ status: 'queued', task_description: 'short hotfix task', timeout_minutes: 5 });
      const low = createTask({ status: 'queued', task_description: 'refactor subsystem', timeout_minutes: 60 });
      createTask({ status: 'completed', task_description: 'finished task' });

      analytics.computePriorityScore(high.id);
      analytics.computePriorityScore(low.id);
      analytics.boostPriority(high.id, 0.4, 'urgent');

      const queue = analytics.getPriorityQueue(10, 0);

      expect(queue[0].id).toBe(high.id);
      expect(analytics.getHighestPriorityQueuedTask().id).toBe(high.id);
      expect(queue.every((task) => ['pending', 'queued'].includes(task.status))).toBe(true);
    });

    it('boosts existing priority rows and creates new boosted rows when none exist', () => {
      const scoredTask = createTask({ status: 'queued' });
      const freshTask = createTask({ status: 'queued' });

      analytics.computePriorityScore(scoredTask.id);

      const updated = analytics.boostPriority(scoredTask.id, 0.5, 'urgent');
      const inserted = analytics.boostPriority(freshTask.id, 0.3, 'manual');
      const freshRow = rawDb().prepare('SELECT * FROM task_priority_scores WHERE task_id = ?').get(freshTask.id);

      expect(updated.previous_score).toBeLessThanOrEqual(1);
      expect(updated.new_score).toBeCloseTo(Math.min(1, updated.previous_score + 0.5), 5);
      expect(inserted).toEqual({
        task_id: freshTask.id,
        previous_score: 0.5,
        new_score: 0.8,
      });
      expect(JSON.parse(freshRow.factors).manual_boost.reason).toBe('manual');
    });
  });

  describe('failure prediction', () => {
    it('extracts only high-signal keywords and ignores case', () => {
      expect(analytics.extractKeywords('DEPLOY to production and BUILD the release')).toEqual([
        'deploy',
        'production',
        'build',
        'release',
      ]);
      expect(analytics.extractKeywords('the quick brown fox')).toEqual([]);
      expect(analytics.extractKeywords(null)).toEqual([]);
    });

    it('returns null for missing or non-failed tasks and learns repeated keyword, time, and resource patterns', () => {
      expect(analytics.learnFailurePattern('missing')).toBeNull();

      const completed = createTask({ status: 'completed', task_description: 'completed task' });
      expect(analytics.learnFailurePattern(completed.id)).toBeNull();

      const failedA = createTask({ status: 'failed', task_description: 'deploy to production' });
      const failedB = createTask({ status: 'failed', task_description: 'deploy to production' });

      patchTask(failedA.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T01:00:00.000Z',
      });
      patchTask(failedB.id, {
        started_at: '2026-01-02T00:00:00.000Z',
        completed_at: '2026-01-02T01:00:00.000Z',
      });

      const patterns = analytics.learnFailurePattern(failedA.id);
      analytics.learnFailurePattern(failedB.id);

      const deployPattern = rawDb().prepare(`
        SELECT * FROM failure_patterns
        WHERE pattern_type = 'keyword' AND pattern_definition LIKE '%deploy%'
      `).get();
      const resourcePattern = rawDb().prepare(`
        SELECT * FROM failure_patterns
        WHERE pattern_type = 'resource'
      `).get();

      expect(patterns.map((pattern) => pattern.type)).toEqual(
        expect.arrayContaining(['keyword', 'time_based', 'resource']),
      );
      expect(deployPattern.failure_count).toBe(2);
      expect(resourcePattern).toBeTruthy();
    });

    it('matches only high-confidence keyword and time-based patterns', () => {
      const currentHour = new Date().getHours();
      const deployId = insertFailurePattern({
        id: 'deploy-pattern',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        confidence: 0.8,
        total_matches: 5,
        failure_rate: 0.9,
      });
      const timeId = insertFailurePattern({
        id: 'time-pattern',
        pattern_type: 'time_based',
        pattern_definition: { hour_start: currentHour, hour_end: currentHour + 1 },
        confidence: 0.4,
        total_matches: 3,
        failure_rate: 0.5,
      });
      insertFailurePattern({
        id: 'low-confidence',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'build' },
        confidence: 0.1,
      });

      const matches = analytics.matchPatterns('deploy the application');

      expect(matches.map((pattern) => pattern.id)).toEqual([deployId, timeId]);
    });

    it('returns the default low-risk failure prediction when no patterns match', () => {
      expect(analytics.predictFailureForTask('unique task')).toEqual({
        probability: 0.1,
        patterns: [],
        confidence: 0.5,
      });
    });

    it('computes weighted failure probability and parses matched pattern definitions', () => {
      const currentHour = new Date().getHours();
      insertFailurePattern({
        id: 'weighted-keyword',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        confidence: 0.5,
        total_matches: 5,
        failure_rate: 0.8,
      });
      insertFailurePattern({
        id: 'weighted-time',
        pattern_type: 'time_based',
        pattern_definition: { hour_start: currentHour, hour_end: currentHour + 1 },
        confidence: 0.4,
        total_matches: 10,
        failure_rate: 0.3,
      });

      const prediction = analytics.predictFailureForTask('deploy during release window');

      expect(prediction.probability).toBeCloseTo(3.2 / 6.5, 5);
      expect(prediction.confidence).toBeCloseTo(0.065, 5);
      expect(prediction.patterns).toEqual([
        {
          id: 'weighted-keyword',
          type: 'keyword',
          definition: { keyword: 'deploy' },
          failure_rate: 0.8,
          confidence: 0.5,
        },
        {
          id: 'weighted-time',
          type: 'time_based',
          definition: { hour_start: currentHour, hour_end: currentHour + 1 },
          failure_rate: 0.3,
          confidence: 0.4,
        },
      ]);
    });

    it('lists failure patterns with parsed JSON and deletes them by id', () => {
      const patternId = insertFailurePattern({
        id: 'listable-pattern',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        suggested_intervention: { type: 'review' },
        confidence: 0.6,
      });

      const listed = analytics.listFailurePatterns({
        patternType: 'keyword',
        minConfidence: 0.4,
        limit: 5,
      });

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: patternId,
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        failure_count: 1,
        total_matches: 1,
        failure_rate: 1,
        suggested_intervention: { type: 'review' },
        confidence: 0.6,
        last_updated_at: expect.any(String),
        created_at: expect.any(String),
      });
      expect(analytics.deleteFailurePattern(patternId)).toBe(true);
      expect(analytics.deleteFailurePattern('missing-pattern')).toBe(false);
    });

    it('suggests review, timeout, retry delay, and rescheduling for risky deployments', () => {
      const currentHour = new Date().getHours();
      insertFailurePattern({
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        confidence: 0.8,
        total_matches: 10,
        failure_rate: 0.9,
      });
      insertFailurePattern({
        pattern_type: 'time_based',
        pattern_definition: { hour_start: currentHour, hour_end: currentHour + 1 },
        confidence: 0.6,
        total_matches: 6,
        failure_rate: 0.7,
      });

      const result = analytics.suggestIntervention('deploy to production');

      expect(result.prediction.probability).toBeGreaterThan(0.5);
      expect(result.interventions.map((item) => item.type)).toEqual(
        expect.arrayContaining([
          'flag_for_review',
          'increase_timeout',
          'add_retry_delay',
          'suggest_reschedule',
        ]),
      );
    });

    it('logs intelligence actions, updates outcomes, adjusts confidence, and prunes weak patterns', () => {
      insertFailurePattern({
        id: 'keep-pattern',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        confidence: 0.4,
        total_matches: 5,
        failure_rate: 0.8,
      });
      insertFailurePattern({
        id: 'prune-pattern',
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'production' },
        confidence: 0.25,
        total_matches: 20,
        failure_rate: 0.7,
      });

      const logId = analytics.logIntelligenceAction(
        'task-intel',
        'failure_predicted',
        { pattern_ids: ['keep-pattern', 'prune-pattern'] },
        0.75,
      );

      analytics.updateIntelligenceOutcome(logId, 'incorrect');

      const log = rawDb().prepare('SELECT * FROM intelligence_log WHERE id = ?').get(logId);
      const remaining = rawDb().prepare('SELECT confidence FROM failure_patterns WHERE id = ?').get('keep-pattern');
      const pruned = rawDb().prepare('SELECT * FROM failure_patterns WHERE id = ?').get('prune-pattern');

      expect(log.outcome).toBe('incorrect');
      expect(remaining.confidence).toBeCloseTo(0.3, 5);
      expect(pruned).toBeUndefined();
    });
  });

  describe('adaptive retry', () => {
    it('returns no retry pattern aggregates when the history table is empty', () => {
      expect(analytics.analyzeRetryPatterns()).toEqual([]);
    });

    it('groups retry attempts by strategy and error type and respects the since filter', () => {
      const successTask = createTask({ status: 'completed' });
      const failedTask = createTask({ status: 'failed' });
      patchTask(successTask.id, { error_output: 'timeout error happened', exit_code: 0 });
      patchTask(failedTask.id, { error_output: 'timeout error happened', exit_code: 1 });

      insertRetryHistory(successTask.id, 1, 'exponential', 'timeout', '2026-03-10T00:00:00.000Z');
      insertRetryHistory(successTask.id, 2, 'exponential', 'timeout', '2026-03-10T00:01:00.000Z');
      insertRetryHistory(failedTask.id, 1, 'exponential', 'timeout', '2026-03-10T00:02:00.000Z');
      insertRetryHistory(failedTask.id, 2, 'exponential', 'timeout', '2026-03-10T00:03:00.000Z');

      const results = analytics.analyzeRetryPatterns('2026-03-01T00:00:00.000Z');

      expect(results).toEqual([
        {
          strategy_used: 'exponential',
          error_type: 'timeout error happened',
          attempts: 4,
          successes: 2,
          success_rate: 0.5,
        },
      ]);
    });

    it('creates adaptive retry rules, parses JSON adjustments, and filters by matching error text', () => {
      const timeoutRuleId = analytics.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 30 });
      const memoryRuleId = analytics.createAdaptiveRetryRule('memory', 'resize', { increase_memory: true });

      rawDb().prepare('UPDATE adaptive_retry_rules SET adjustment = ? WHERE id = ?').run('not-json', memoryRuleId);

      const allRules = analytics.getAdaptiveRetryRules();
      expect(allRules).toHaveLength(2);
      expect(allRules).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: timeoutRuleId,
          error_pattern: 'timeout',
          rule_type: 'delay',
          adjustment: { delay_seconds: 30 },
          success_count: 0,
          failure_count: 0,
          enabled: 1,
          created_at: expect.any(String),
        }),
        expect.objectContaining({
          id: memoryRuleId,
          error_pattern: 'memory',
          rule_type: 'resize',
          adjustment: {},
          success_count: 0,
          failure_count: 0,
          enabled: 1,
          created_at: expect.any(String),
        }),
      ]));
      expect(analytics.getAdaptiveRetryRules('request timeout while fetching')).toEqual([
        {
          id: timeoutRuleId,
          error_pattern: 'timeout',
          rule_type: 'delay',
          adjustment: { delay_seconds: 30 },
          success_count: 0,
          failure_count: 0,
          enabled: 1,
          created_at: expect.any(String),
        },
      ]);
    });

    it('updates retry rule success and failure counters', () => {
      const ruleId = analytics.createAdaptiveRetryRule('error', 'adjust', {});

      analytics.updateRetryRuleStats(ruleId, true);
      analytics.updateRetryRuleStats(ruleId, false);

      const row = rawDb().prepare(`
        SELECT success_count, failure_count FROM adaptive_retry_rules WHERE id = ?
      `).get(ruleId);

      expect(row).toEqual({
        success_count: 1,
        failure_count: 1,
      });
    });

    it('returns null for missing retry recommendation tasks, applies rule matches, and falls back to default adaptations', () => {
      const task = createTask({ timeout_minutes: 15 });
      const ruleId = analytics.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 60, timeout_factor: 2 });

      expect(analytics.getRetryRecommendation('missing-task', 'timeout')).toBeNull();
      expect(analytics.getRetryRecommendation(task.id, 'timeout occurred')).toEqual({
        task_id: task.id,
        original_timeout: 15,
        adaptations: { delay_seconds: 60, timeout_factor: 2 },
        applied_rules: [ruleId],
      });

      resetTables(['adaptive_retry_rules']);

      expect(analytics.getRetryRecommendation(task.id, 'timeout 429 OOM')).toEqual({
        task_id: task.id,
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

  describe('experimentation and dashboard', () => {
    it('creates, fetches, and lists experiments with parsed JSON fields', () => {
      const first = analytics.createExperiment(
        'Priority test',
        'prioritization',
        { resource: 0.3 },
        { resource: 0.6 },
        25,
      );
      const second = analytics.createExperiment(
        'Cache test',
        'caching',
        { ttl: 60 },
        { ttl: 300 },
        10,
      );

      rawDb().prepare('UPDATE strategy_experiments SET status = ? WHERE id = ?').run('completed', second.id);

      expect(analytics.getExperiment(first.id)).toMatchObject({
        id: first.id,
        name: 'Priority test',
        strategy_type: 'prioritization',
        status: 'running',
        variant_a: { resource: 0.3 },
        variant_b: { resource: 0.6 },
        results_a: { count: 0, successes: 0, total_duration: 0 },
        results_b: { count: 0, successes: 0, total_duration: 0 },
      });
      expect(analytics.listExperiments()).toHaveLength(2);
      expect(analytics.listExperiments('completed')).toHaveLength(1);
      expect(analytics.getExperiment('missing')).toBeNull();
    });

    it('assigns experiment variants deterministically and spreads assignments across tasks', () => {
      const first = analytics.assignExperimentVariant('task-1', 'exp-1');
      const second = analytics.assignExperimentVariant('task-1', 'exp-1');
      const variants = new Set();

      for (let index = 0; index < 20; index++) {
        variants.add(analytics.assignExperimentVariant(`task-${index}`, 'exp-distribution'));
      }

      expect(first).toBe(second);
      expect(['a', 'b']).toContain(first);
      expect(variants.size).toBe(2);
    });

    it('records experiment outcomes and rejects missing or completed experiments', () => {
      const experiment = analytics.createExperiment('Outcome test', 'test', {}, {});

      expect(analytics.recordExperimentOutcome('missing', 'a', true, 10)).toBe(false);
      expect(analytics.recordExperimentOutcome(experiment.id, 'a', true, 120)).toBe(true);
      expect(analytics.recordExperimentOutcome(experiment.id, 'b', false, 60)).toBe(true);

      rawDb().prepare('UPDATE strategy_experiments SET status = ? WHERE id = ?').run('completed', experiment.id);

      expect(analytics.recordExperimentOutcome(experiment.id, 'a', true, 10)).toBe(false);
      expect(analytics.getExperiment(experiment.id)).toMatchObject({
        results_a: { count: 1, successes: 1, total_duration: 120 },
        results_b: { count: 1, successes: 0, total_duration: 60 },
      });
    });

    it('computes experiment significance for both insufficient and significant samples', () => {
      const low = analytics.createExperiment('Low sample', 'test', {}, {});
      const high = analytics.createExperiment('High sample', 'test', {}, {});

      for (let index = 0; index < 5; index++) {
        analytics.recordExperimentOutcome(low.id, 'a', true, 10);
        analytics.recordExperimentOutcome(low.id, 'b', false, 10);
      }

      for (let index = 0; index < 15; index++) {
        analytics.recordExperimentOutcome(high.id, 'a', index < 12, 10);
        analytics.recordExperimentOutcome(high.id, 'b', index < 5, 10);
      }

      expect(analytics.computeExperimentSignificance(low.id)).toMatchObject({
        significant: false,
        reason: 'insufficient_samples',
      });
      expect(analytics.computeExperimentSignificance(high.id)).toMatchObject({
        significant: true,
        winner: 'a',
      });
      expect(analytics.computeExperimentSignificance('missing')).toBeNull();
    });

    it('concludes prioritization experiments and applies the winning weights when requested', () => {
      const experiment = analytics.createExperiment(
        'Priority winner',
        'prioritization',
        { resource: 0.6, success: 0.2, dependency: 0.2 },
        { resource: 0.2, success: 0.3, dependency: 0.5 },
      );

      for (let index = 0; index < 15; index++) {
        analytics.recordExperimentOutcome(experiment.id, 'a', index < 13, 10);
        analytics.recordExperimentOutcome(experiment.id, 'b', index < 4, 10);
      }

      const result = analytics.concludeExperiment(experiment.id, true);

      expect(result).toMatchObject({
        significant: true,
        winner: 'a',
        applied: 'a',
      });
      expect(analytics.getExperiment(experiment.id)).toMatchObject({
        status: 'completed',
        winner: 'a',
      });
      expect(analytics.getPriorityWeights()).toEqual({
        resource: 0.6,
        success: 0.2,
        dependency: 0.2,
      });
    });

    it('concludes caching experiments and applies the winning cache config through the injected setter', () => {
      const experiment = analytics.createExperiment(
        'Cache winner',
        'caching',
        { ttl: 60, mode: 'cold' },
        { ttl: 300, mode: 'warm' },
      );

      for (let index = 0; index < 15; index++) {
        analytics.recordExperimentOutcome(experiment.id, 'a', index < 2, 10);
        analytics.recordExperimentOutcome(experiment.id, 'b', index < 13, 10);
      }

      const result = analytics.concludeExperiment(experiment.id, true);

      expect(result).toMatchObject({
        significant: true,
        winner: 'b',
        applied: 'b',
      });
      expect(setCacheConfigMock).toHaveBeenCalledWith('ttl', '300');
      expect(setCacheConfigMock).toHaveBeenCalledWith('mode', 'warm');
      expect(db.getCacheConfig('ttl')).toBe('300');
      expect(db.getCacheConfig('mode')).toBe('warm');
    });

    it('aggregates intelligence dashboard metrics and computes accuracy from resolved predictions', () => {
      analytics.createExperiment('Dashboard experiment', 'test', {}, {});
      insertFailurePattern({
        pattern_type: 'keyword',
        pattern_definition: { keyword: 'deploy' },
        confidence: 0.6,
        failure_rate: 0.8,
      });
      insertFailurePattern({
        pattern_type: 'time_based',
        pattern_definition: { hour_start: 0, hour_end: 1 },
        confidence: 0.4,
        failure_rate: 0.2,
      });

      const firstLogId = analytics.logIntelligenceAction('task-1', 'failure_predicted', { risk: 0.8 }, 0.7);
      const secondLogId = analytics.logIntelligenceAction('task-2', 'failure_predicted', { risk: 0.6 }, 0.6);
      analytics.logIntelligenceAction('task-3', 'failure_predicted', { risk: 0.2 }, 0.5);
      analytics.updateIntelligenceOutcome(firstLogId, 'correct');
      analytics.updateIntelligenceOutcome(secondLogId, 'incorrect');

      const dashboard = analytics.getIntelligenceDashboard('2026-03-01T00:00:00.000Z');

      expect(getCacheStatsMock).toHaveBeenCalledWith('2026-03-01T00:00:00.000Z');
      expect(dashboard).toEqual({
        cache: { hits: 3, misses: 1, total: 4 },
        predictions: {
          total_predictions: 3,
          correct: 1,
          incorrect: 1,
          pending: 1,
          accuracy: 0.5,
        },
        patterns: {
          total_patterns: 2,
          avg_confidence: expect.any(Number),
          avg_failure_rate: expect.any(Number),
        },
        experiments: {
          total_experiments: 1,
          running: 1,
          completed: 0,
        },
      });
    });

    it('reports null dashboard accuracy when every prediction is still pending', () => {
      analytics.logIntelligenceAction('task-1', 'failure_predicted', { risk: 0.3 }, 0.4);

      expect(analytics.getIntelligenceDashboard().predictions.accuracy).toBeNull();
    });
  });
});
