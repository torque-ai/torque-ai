'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const providerPerformance = require('../db/provider/performance');

const FIXED_NOW = new Date('2026-03-13T12:00:00.000Z');

let ctx;

function rawDb() {
  return ctx.db.getDb ? ctx.db.getDb() : ctx.db.getDbInstance();
}

function recordOutcome(overrides = {}) {
  providerPerformance.recordTaskOutcome({
    provider: 'codex',
    taskType: 'code_edit',
    durationSeconds: 30,
    success: true,
    resubmitted: false,
    autoCheckPassed: true,
    ...overrides,
  });
}

describe('db/provider/performance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    ctx = setupE2eDb('provider-perf');
    providerPerformance.setDb(ctx.db);
  });

  afterEach(async () => {
    providerPerformance.setDb(null);
    if (ctx) {
      await teardownE2eDb(ctx);
      ctx = null;
    }
    vi.useRealTimers();
  });

  describe('recordTaskOutcome', () => {
    it('records success', () => {
      recordOutcome();

      const row = rawDb().prepare(`
        SELECT provider, task_type, window_start, total_tasks, successful_tasks, failed_tasks,
               resubmitted_tasks, avg_duration_seconds, auto_check_pass_rate
        FROM provider_performance
        WHERE provider = ? AND task_type = ?
      `).get('codex', 'code_edit');

      expect(row).toMatchObject({
        provider: 'codex',
        task_type: 'code_edit',
        window_start: '2026-03-13',
        total_tasks: 1,
        successful_tasks: 1,
        failed_tasks: 0,
        resubmitted_tasks: 0,
      });
      expect(row.avg_duration_seconds).toBe(30);
      expect(row.auto_check_pass_rate).toBe(1);
    });

    it('records failure', () => {
      recordOutcome({
        provider: 'anthropic',
        taskType: 'code_review',
        durationSeconds: 45,
        success: false,
        resubmitted: true,
        autoCheckPassed: false,
      });

      const row = rawDb().prepare(`
        SELECT provider, task_type, total_tasks, successful_tasks, failed_tasks,
               resubmitted_tasks, avg_duration_seconds, auto_check_pass_rate
        FROM provider_performance
        WHERE provider = ? AND task_type = ?
      `).get('anthropic', 'code_review');

      expect(row).toMatchObject({
        provider: 'anthropic',
        task_type: 'code_review',
        total_tasks: 1,
        successful_tasks: 0,
        failed_tasks: 1,
        resubmitted_tasks: 1,
      });
      expect(row.avg_duration_seconds).toBe(45);
      expect(row.auto_check_pass_rate).toBe(0);
    });

    it('accumulates multiple outcomes', () => {
      recordOutcome({ durationSeconds: 30, success: true, resubmitted: false, autoCheckPassed: true });
      recordOutcome({ durationSeconds: 60, success: false, resubmitted: true, autoCheckPassed: false });
      recordOutcome({ durationSeconds: 90, success: true, resubmitted: true, autoCheckPassed: true });

      const row = rawDb().prepare(`
        SELECT total_tasks, successful_tasks, failed_tasks, resubmitted_tasks,
               avg_duration_seconds, auto_check_pass_rate
        FROM provider_performance
        WHERE provider = ? AND task_type = ?
      `).get('codex', 'code_edit');

      expect(row.total_tasks).toBe(3);
      expect(row.successful_tasks).toBe(2);
      expect(row.failed_tasks).toBe(1);
      expect(row.resubmitted_tasks).toBe(2);
      expect(row.avg_duration_seconds).toBeCloseTo(60, 5);
      expect(row.auto_check_pass_rate).toBeCloseTo(2 / 3, 5);
    });

    it('supports a raw sqlite handle passed through setDb', () => {
      const db = rawDb();
      providerPerformance.setDb(db);

      recordOutcome();

      const row = db.prepare(`
        SELECT provider, task_type, window_start, total_tasks, successful_tasks, failed_tasks,
               resubmitted_tasks, avg_duration_seconds, auto_check_pass_rate
        FROM provider_performance
        WHERE provider = ? AND task_type = ?
      `).get('codex', 'code_edit');

      expect(row).toMatchObject({
        provider: 'codex',
        task_type: 'code_edit',
        window_start: '2026-03-13',
        total_tasks: 1,
        successful_tasks: 1,
        failed_tasks: 0,
        resubmitted_tasks: 0,
      });
      expect(row.avg_duration_seconds).toBe(30);
      expect(row.auto_check_pass_rate).toBe(1);
    });
  });

  describe('getProviderTaskStats', () => {
    it('reads aggregated stats through raw sqlite handle', () => {
      const db = rawDb();
      providerPerformance.setDb(db);

      recordOutcome({ durationSeconds: 10, success: true, autoCheckPassed: true, resubmitted: false });
      recordOutcome({ durationSeconds: 20, success: false, autoCheckPassed: false, resubmitted: true });

      const row = providerPerformance.getProviderTaskStats('codex', 'code_edit', 7);

      expect(row.total_tasks).toBe(2);
      expect(row.successful_tasks).toBe(1);
      expect(row.failed_tasks).toBe(1);
      expect(row.resubmitted_tasks).toBe(1);
      expect(row.avg_duration_seconds).toBeCloseTo(15, 5);
      expect(row.auto_check_pass_rate).toBeCloseTo(0.5, 5);
    });
  });

  describe('getEmpiricalRank', () => {
    it('returns 0 with fewer than 5 samples', () => {
      for (let i = 0; i < 4; i += 1) {
        recordOutcome({ provider: 'groq', taskType: 'general', success: true });
      }

      expect(providerPerformance.getEmpiricalRank('groq', 'general')).toBe(0);
    });

    it('returns negative for high success rate with 10 successes', () => {
      for (let i = 0; i < 10; i += 1) {
        recordOutcome({ provider: 'ollama', taskType: 'refactoring', success: true });
      }

      expect(providerPerformance.getEmpiricalRank('ollama', 'refactoring')).toBe(-1);
    });

    it('returns positive for low success rate', () => {
      for (let i = 0; i < 5; i += 1) {
        recordOutcome({ provider: 'deepinfra', taskType: 'test_writing', success: false, autoCheckPassed: false });
      }

      expect(providerPerformance.getEmpiricalRank('deepinfra', 'test_writing')).toBe(1);
    });
  });

  describe('inferTaskType', () => {
    it('maps create tasks to file_creation', () => {
      expect(providerPerformance.inferTaskType('Create a new API handler file')).toBe('file_creation');
    });

    it('maps review tasks to code_review', () => {
      expect(providerPerformance.inferTaskType('Review this routing change')).toBe('code_review');
    });

    it('maps fix tasks to code_edit', () => {
      expect(providerPerformance.inferTaskType('Fix the broken scheduler')).toBe('code_edit');
    });

    it('maps generic descriptions to general', () => {
      expect(providerPerformance.inferTaskType('Coordinate task execution')).toBe('general');
    });
  });
});
