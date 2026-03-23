/**
 * Tests for server/db/event-tracking.js
 *
 * Event recording, analytics queries, success metrics,
 * format tracking, output search, export/import.
 */

const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb } = require('./vitest-setup');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');

let db, mod, testDir;

function setup() {
  ({ db, mod, testDir } = setupTestDbModule('../db/event-tracking', 'evttrack'));

  const schedulingAutomation = require('../db/scheduling-automation');

  mod.setGetTask((id) => taskCore.getTask(id));
  mod.setDbFunctions({
    getConfig: configCore.getConfig,
    getPipelineSteps: schedulingAutomation.getPipelineSteps,
    getAllConfig: configCore.getAllConfig,
    createTask: taskCore.createTask,
    getTemplate: schedulingAutomation.getTemplate,
    saveTemplate: schedulingAutomation.saveTemplate,
    deleteTemplate: schedulingAutomation.deleteTemplate,
    getPipeline: schedulingAutomation.getPipeline,
    createPipeline: schedulingAutomation.createPipeline,
    addPipelineStep: schedulingAutomation.addPipelineStep,
    getScheduledTask: schedulingAutomation.getScheduledTask,
    deleteScheduledTask: schedulingAutomation.deleteScheduledTask,
    createScheduledTask: schedulingAutomation.createScheduledTask,
  });
}

function teardown() {
  teardownTestDb();
}

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: overrides.task_description || 'event tracking test',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    ...overrides,
  };
  taskCore.createTask(payload);
  return taskCore.getTask(payload.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

function resetState() {
  const conn = rawDb();
  for (const table of ['analytics', 'success_metrics', 'format_success_rates', 'tasks', 'templates', 'scheduled_tasks', 'pipeline_steps', 'pipelines']) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
}

describe('event-tracking module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  // ====================================================
  // recordEvent / getAnalytics
  // ====================================================
  describe('recordEvent', () => {
    it('records an event with type and task_id', () => {
      mod.recordEvent('task_completed', 'task-123', { duration: 42 });
      const rows = rawDb().prepare("SELECT * FROM analytics WHERE event_type='task_completed'").all();
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe('task-123');
      expect(JSON.parse(rows[0].data)).toEqual({ duration: 42 });
    });

    it('records event without task_id or data', () => {
      mod.recordEvent('system_start');
      const rows = rawDb().prepare("SELECT * FROM analytics WHERE event_type='system_start'").all();
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBeNull();
      expect(rows[0].data).toBeNull();
    });

    it('records multiple events of different types', () => {
      mod.recordEvent('type_a');
      mod.recordEvent('type_b');
      mod.recordEvent('type_c');
      const count = rawDb().prepare('SELECT COUNT(*) as cnt FROM analytics').get().cnt;
      expect(count).toBe(3);
    });
  });

  describe('getAnalytics', () => {
    it('returns task status counts', () => {
      createTask({ status: 'completed' });
      createTask({ status: 'completed' });
      createTask({ status: 'failed' });

      const analytics = mod.getAnalytics();
      expect(analytics.tasksByStatus.completed).toBe(2);
      expect(analytics.tasksByStatus.failed).toBe(1);
    });

    it('computes success rate', () => {
      createTask({ status: 'completed' });
      createTask({ status: 'completed' });
      createTask({ status: 'completed' });
      createTask({ status: 'failed' });

      const analytics = mod.getAnalytics();
      expect(analytics.successRate).toBe(75);
    });

    it('returns 0 success rate when no completed/failed tasks', () => {
      createTask({ status: 'queued' });
      const analytics = mod.getAnalytics();
      expect(analytics.successRate).toBe(0);
    });

    it('calculates average duration for completed tasks', () => {
      const now = new Date();
      const tenMinAgo = new Date(now.getTime() - 10 * 60000).toISOString();
      const task = createTask({ status: 'completed' });
      patchTask(task.id, { started_at: tenMinAgo, completed_at: now.toISOString() });

      const analytics = mod.getAnalytics();
      expect(analytics.avgDurationMinutes).toBeGreaterThan(0);
    });

    it('includes recent events when includeEvents is true', () => {
      mod.recordEvent('test_event', null, { key: 'value' });
      const analytics = mod.getAnalytics({ includeEvents: true, eventLimit: 5 });
      expect(analytics.recentEvents).toBeTruthy();
      expect(analytics.recentEvents.length).toBeGreaterThanOrEqual(1);
      expect(analytics.recentEvents[0].data).toEqual({ key: 'value' });
    });

    it('does not include events by default', () => {
      mod.recordEvent('hidden_event');
      const analytics = mod.getAnalytics();
      expect(analytics.recentEvents).toBeUndefined();
    });
  });

  // ====================================================
  // Success Metrics
  // ====================================================
  describe('recordSuccessMetrics / getSuccessRates', () => {
    it('records and retrieves success metrics by project', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00Z',
        period_type: 'day',
        project: 'alpha',
        total_tasks: 10,
        successful_tasks: 8,
        failed_tasks: 2,
        cancelled_tasks: 0,
      });

      const rates = mod.getSuccessRates({ groupBy: 'project', project: 'alpha' });
      expect(rates.length).toBe(1);
      expect(rates[0].group_key).toBe('alpha');
      expect(rates[0].success_rate).toBe(80);
    });

    it('groups by template when requested', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00Z',
        period_type: 'day',
        template: 'build',
        total_tasks: 5,
        successful_tasks: 4,
        failed_tasks: 1,
      });

      const rates = mod.getSuccessRates({ groupBy: 'template' });
      expect(rates.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by date range', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00Z',
        period_type: 'day',
        project: 'beta',
        total_tasks: 5,
        successful_tasks: 3,
        failed_tasks: 2,
      });

      const rates = mod.getSuccessRates({
        from_date: '2025-12-01T00:00:00Z',
        to_date: '2026-02-01T00:00:00Z',
      });
      expect(rates.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 0 success rate for zero total tasks', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00Z',
        period_type: 'day',
        project: 'empty',
        total_tasks: 0,
        successful_tasks: 0,
        failed_tasks: 0,
      });
      const rates = mod.getSuccessRates({ project: 'empty' });
      expect(rates[0].success_rate).toBe(0);
    });
  });

  describe('comparePerformance', () => {
    it('compares current and previous period metrics', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00Z',
        period_type: 'day',
        project: 'proj',
        total_tasks: 10,
        successful_tasks: 7,
        failed_tasks: 3,
      });
      mod.recordSuccessMetrics({
        period_start: '2026-02-01T00:00:00Z',
        period_type: 'day',
        project: 'proj',
        total_tasks: 10,
        successful_tasks: 9,
        failed_tasks: 1,
      });

      const result = mod.comparePerformance({
        current_from: '2026-02-01T00:00:00Z',
        current_to: '2026-02-28T00:00:00Z',
        previous_from: '2026-01-01T00:00:00Z',
        previous_to: '2026-01-31T00:00:00Z',
      });

      expect(result.current).toBeTruthy();
      expect(result.previous).toBeTruthy();
      expect(Array.isArray(result.comparison)).toBe(true);
    });
  });

  describe('aggregateSuccessMetrics', () => {
    it('aggregates metrics from completed tasks in the current period', () => {
      createTask({ status: 'completed', project: 'agg-test' });
      createTask({ status: 'failed', project: 'agg-test' });

      const result = mod.aggregateSuccessMetrics('day');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ====================================================
  // Format Success Tracking
  // ====================================================
  describe('recordFormatSuccess / getFormatSuccessRate', () => {
    it('records format success and calculates rate', () => {
      mod.recordFormatSuccess('qwen3:8b', 'hashline', true, null, 30);
      mod.recordFormatSuccess('qwen3:8b', 'hashline', true, null, 25);
      mod.recordFormatSuccess('qwen3:8b', 'hashline', false, 'parse_error', 40);

      const rate = mod.getFormatSuccessRate('qwen3:8b', 'hashline');
      expect(rate.total).toBe(3);
      expect(rate.successes).toBe(2);
      expect(rate.rate).toBeCloseTo(0.67, 1);
      expect(rate.avg_duration).toBeGreaterThan(0);
    });

    it('returns zero stats for unknown model/format', () => {
      const rate = mod.getFormatSuccessRate('unknown-model', 'unknown-format');
      expect(rate.total).toBe(0);
      expect(rate.rate).toBe(0);
    });
  });

  describe('getBestFormatForModel', () => {
    it('returns insufficient_data when too few samples', () => {
      const result = mod.getBestFormatForModel('new-model');
      expect(result.format).toBeNull();
      expect(result.reason).toBe('insufficient_data');
    });

    it('recommends hashline-lite when hashline is below threshold', () => {
      // Record enough hashline failures
      for (let i = 0; i < 4; i++) {
        mod.recordFormatSuccess('poor-model', 'hashline', false, 'error', 10);
      }

      const result = mod.getBestFormatForModel('poor-model');
      expect(result.format).toBe('hashline-lite');
      expect(result.reason).toBe('hashline_below_threshold');
    });

    it('recommends hashline when it is acceptable', () => {
      for (let i = 0; i < 4; i++) {
        mod.recordFormatSuccess('good-model', 'hashline', true, null, 10);
      }

      const result = mod.getBestFormatForModel('good-model');
      expect(result.format).toBe('hashline');
      expect(result.reason).toBe('hashline_acceptable');
    });
  });

  describe('getFormatSuccessRatesSummary', () => {
    it('returns summary grouped by model and edit_format', () => {
      mod.recordFormatSuccess('m1', 'hashline', true, null, 10);
      mod.recordFormatSuccess('m1', 'hashline-lite', false, 'err', 20);

      const summary = mod.getFormatSuccessRatesSummary();
      expect(summary.length).toBeGreaterThanOrEqual(2);
      expect(summary[0].model).toBeTruthy();
      expect(summary[0].edit_format).toBeTruthy();
      expect(typeof summary[0].success_rate_pct).toBe('number');
    });
  });

  // ====================================================
  // Output Search
  // ====================================================
  describe('searchTaskOutputs', () => {
    it('finds tasks matching pattern in output', () => {
      const task = createTask({ output: 'Error: connection timeout occurred' });
      patchTask(task.id, { output: 'Error: connection timeout occurred' });

      const results = mod.searchTaskOutputs('timeout');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].snippets.length).toBeGreaterThanOrEqual(1);
    });

    it('finds tasks matching pattern in error_output', () => {
      const task = createTask();
      patchTask(task.id, { error_output: 'FATAL: disk full error' });

      const results = mod.searchTaskOutputs('disk full');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', () => {
      const t1 = createTask({ status: 'completed' });
      patchTask(t1.id, { output: 'search-unique-xyz' });
      const t2 = createTask({ status: 'failed' });
      patchTask(t2.id, { output: 'search-unique-xyz' });

      const results = mod.searchTaskOutputs('search-unique-xyz', { status: 'completed' });
      expect(results.every(r => r.status === 'completed')).toBe(true);
    });

    it('respects limit option', () => {
      for (let i = 0; i < 5; i++) {
        const t = createTask();
        patchTask(t.id, { output: 'common-search-pattern' });
      }

      const results = mod.searchTaskOutputs('common-search-pattern', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array when no matches', () => {
      const results = mod.searchTaskOutputs('nonexistent-pattern-xyz-999');
      expect(results).toEqual([]);
    });

    it('escapes LIKE wildcards in pattern', () => {
      const task = createTask();
      patchTask(task.id, { output: 'has 50% discount' });

      // The % should be escaped so it's treated as literal
      const results = mod.searchTaskOutputs('50%');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getOutputStats', () => {
    it('returns aggregate output statistics', () => {
      const t1 = createTask({ status: 'completed' });
      patchTask(t1.id, { output: 'some output', error_output: 'some error' });
      const t2 = createTask({ status: 'failed' });
      patchTask(t2.id, { error_output: 'error only' });

      const stats = mod.getOutputStats();
      expect(stats.total_tasks).toBeGreaterThanOrEqual(2);
      expect(stats.tasks_with_output).toBeGreaterThanOrEqual(1);
      expect(stats.tasks_with_errors).toBeGreaterThanOrEqual(1);
    });
  });

  // ====================================================
  // Export/Import
  // ====================================================
  describe('exportData', () => {
    it('exports tasks, templates, pipelines, and config', () => {
      createTask({ status: 'completed' });

      const exported = mod.exportData({});
      expect(exported.version).toBe('2.0');
      expect(exported.exported_at).toBeTruthy();
      expect(exported.data.tasks).toBeTruthy();
      expect(Array.isArray(exported.data.tasks)).toBe(true);
    });

    it('filters export by status', () => {
      createTask({ status: 'completed' });
      createTask({ status: 'failed' });

      const exported = mod.exportData({ status: 'completed' });
      expect(exported.data.tasks.every(t => t.status === 'completed')).toBe(true);
    });

    it('respects limit option', () => {
      for (let i = 0; i < 5; i++) {
        createTask();
      }
      const exported = mod.exportData({ limit: 2 });
      expect(exported.data.tasks.length).toBeLessThanOrEqual(2);
    });

    it('excludes sections when set to false', () => {
      const exported = mod.exportData({ tasks: false, templates: false });
      expect(exported.data.tasks).toBeUndefined();
      expect(exported.data.templates).toBeUndefined();
    });
  });

  // ====================================================
  // Helper functions
  // ====================================================
  describe('helper functions', () => {
    it('safeJsonParse parses valid JSON', () => {
      expect(mod.safeJsonParse('{"ok":true}', null)).toEqual({ ok: true });
    });

    it('safeJsonParse returns fallback for invalid JSON', () => {
      expect(mod.safeJsonParse('{bad', 'fallback')).toBe('fallback');
    });

    it('safeJsonParse returns fallback for null', () => {
      expect(mod.safeJsonParse(null, 'default')).toBe('default');
    });

    it('escapeLikePattern escapes %, _, and backslash', () => {
      expect(mod.escapeLikePattern('50%_test\\')).toBe('50\\%\\_test\\\\');
    });

    it('escapeLikePattern returns empty string for non-string', () => {
      expect(mod.escapeLikePattern(123)).toBe('');
    });

    it('escapeRegex escapes special regex characters', () => {
      expect(mod.escapeRegex('a.b*c?')).toBe('a\\.b\\*c\\?');
    });
  });
});
