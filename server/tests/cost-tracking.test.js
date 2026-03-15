/**
 * Cost Tracking Module Tests
 *
 * Unit tests for cost-tracking.js — token usage, cost estimation,
 * budgets, and per-workflow cost aggregation.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-cost-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  return db;
}

function teardownDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || uuidv4();
  db.createTask({
    id,
    task_description: 'test task',
    provider: 'codex',
    status: 'completed',
    ...overrides,
  });
  return id;
}

describe('Cost Tracking Module', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // ── Token Usage ──────────────────────────────────────────

  describe('recordTokenUsage', () => {
    it('records usage and returns summary', () => {
      const taskId = createTask();
      const result = db.recordTokenUsage(taskId, {
        input_tokens: 1000,
        output_tokens: 500,
        model: 'codex',
      });

      expect(result.task_id).toBe(taskId);
      expect(result.input_tokens).toBe(1000);
      expect(result.output_tokens).toBe(500);
      expect(result.total_tokens).toBe(1500);
      expect(result.estimated_cost_usd).toBeGreaterThan(0);
      expect(result.model).toBe('codex');
    });

    it('uses default cost rates for unknown models', () => {
      const taskId = createTask();
      const result = db.recordTokenUsage(taskId, {
        input_tokens: 1000,
        output_tokens: 1000,
        model: 'unknown-model-xyz',
      });

      expect(result.estimated_cost_usd).toBeGreaterThan(0);
      expect(result.model).toBe('unknown-model-xyz');
    });

    it('handles missing token counts gracefully', () => {
      const taskId = createTask();
      const result = db.recordTokenUsage(taskId, { model: 'codex' });

      expect(result.input_tokens).toBe(0);
      expect(result.output_tokens).toBe(0);
      expect(result.total_tokens).toBe(0);
    });
  });

  describe('getTaskTokenUsage', () => {
    it('returns all usage records for a task', () => {
      const taskId = createTask();
      db.recordTokenUsage(taskId, { input_tokens: 100, output_tokens: 50, model: 'codex' });
      db.recordTokenUsage(taskId, { input_tokens: 200, output_tokens: 100, model: 'codex' });

      const records = db.getTaskTokenUsage(taskId);
      expect(records).toHaveLength(2);
      expect(records[0].task_id).toBe(taskId);
    });

    it('returns empty array for task with no usage', () => {
      const records = db.getTaskTokenUsage('nonexistent-task');
      expect(records).toEqual([]);
    });
  });

  describe('getTokenUsageSummary', () => {
    it('returns aggregate summary', () => {
      const summary = db.getTokenUsageSummary();

      expect(summary).toHaveProperty('total_input_tokens');
      expect(summary).toHaveProperty('total_output_tokens');
      expect(summary).toHaveProperty('total_tokens');
      expect(summary).toHaveProperty('total_cost_usd');
      expect(summary).toHaveProperty('by_model');
    });

    it('filters by project', () => {
      const taskId = createTask({ project: 'test-project-cost' });
      db.recordTokenUsage(taskId, { input_tokens: 500, output_tokens: 250, model: 'codex' });

      const summary = db.getTokenUsageSummary({ project: 'test-project-cost' });
      expect(summary.task_count).toBeGreaterThanOrEqual(1);
    });

    it('filters by date range', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const summary = db.getTokenUsageSummary({ since: future });
      expect(summary.task_count).toBe(0);
    });
  });

  describe('getCostByPeriod', () => {
    it('returns costs grouped by day', () => {
      const result = db.getCostByPeriod('day', 7);
      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        expect(result[0]).toHaveProperty('period');
        expect(result[0]).toHaveProperty('tokens');
        expect(result[0]).toHaveProperty('cost');
      }
    });

    it('supports hour/week/month periods', () => {
      for (const period of ['hour', 'week', 'month']) {
        const result = db.getCostByPeriod(period, 5);
        expect(Array.isArray(result)).toBe(true);
      }
    });
  });

  describe('estimateCost', () => {
    it('estimates cost from task description', () => {
      const estimate = db.estimateCost('Write a function that sorts an array', 'codex');

      expect(estimate.estimated_input_tokens).toBeGreaterThan(0);
      expect(estimate.estimated_output_tokens).toBeGreaterThan(0);
      expect(estimate.estimated_cost_usd).toBeGreaterThan(0);
      expect(estimate.model).toBe('codex');
    });

    it('uses default model when none specified', () => {
      const estimate = db.estimateCost('hello');
      expect(estimate.model).toBe('codex');
    });
  });

  // ── Provider Cost Tracking ──────────────────────────────────

  describe('recordCost', () => {
    it('records provider cost', () => {
      const taskId = createTask();
      const cost = db.recordCost('codex', taskId, 1000, 500, 'gpt-5.3-codex-spark');
      expect(cost).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getCostSummary', () => {
    it('returns per-provider cost summary', () => {
      const result = db.getCostSummary(null, 30);
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns single provider summary', () => {
      const taskId = createTask();
      db.recordCost('codex', taskId, 500, 250, 'spark');

      const result = db.getCostSummary('codex', 30);
      // Single provider returns an object, not array
      if (result) {
        expect(result.provider).toBe('codex');
      }
    });
  });

  // ── Budgets ──────────────────────────────────────────────

  describe('setBudget', () => {
    it('creates a budget', () => {
      const budget = db.setBudget('Test Budget', 100, null, 'monthly', 80);

      expect(budget.name).toBe('Test Budget');
      expect(budget.budget_usd).toBe(100);
      expect(budget.period).toBe('monthly');
    });

    it('upserts on duplicate name', () => {
      db.setBudget('Upsert Test', 50);
      const updated = db.setBudget('Upsert Test', 200);

      expect(updated.budget_usd).toBe(200);
    });
  });

  describe('getBudgetStatus', () => {
    it('returns enabled budgets', () => {
      db.setBudget('Status Test', 100);
      const budgets = db.getBudgetStatus();
      expect(Array.isArray(budgets)).toBe(true);
      expect(budgets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isBudgetExceeded', () => {
    it('returns not exceeded for fresh budget', () => {
      db.setBudget('Fresh Budget', 1000);
      const result = db.isBudgetExceeded();

      expect(result.exceeded).toBe(false);
    });
  });

  // ── Budget Period Reset ──────────────────────────────────

  describe('resetExpiredBudgets', () => {
    it('resets monthly budget after 32 days', () => {
      const name = `reset-monthly-${Date.now()}`;
      db.setBudget(name, 100, null, 'monthly', 80);

      // Set reset_at to 32 days ago and current_spend to 50
      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      const pastDate = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
      db.getDbInstance().prepare('UPDATE cost_budgets SET reset_at = ?, current_spend = 50 WHERE id = ?')
        .run(pastDate, budgetId);

      const resetCount = db.resetExpiredBudgets();
      expect(resetCount).toBeGreaterThanOrEqual(1);

      const budget = db.getBudgetStatus(budgetId);
      expect(budget.current_spend).toBe(0);
    });

    it('does NOT reset when period has not elapsed', () => {
      const name = `no-reset-${Date.now()}`;
      db.setBudget(name, 100, null, 'monthly', 80);

      // Budget was just created with reset_at = now, so period has not elapsed
      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      db.getDbInstance().prepare('UPDATE cost_budgets SET current_spend = 25 WHERE id = ?')
        .run(budgetId);

      db.resetExpiredBudgets();
      // This budget should NOT be reset (it's fresh), but others may reset
      const budget = db.getBudgetStatus(budgetId);
      expect(budget.current_spend).toBe(25);
    });

    it('resets weekly budget after 8 days', () => {
      const name = `reset-weekly-${Date.now()}`;
      db.setBudget(name, 50, null, 'weekly', 80);

      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      const pastDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      db.getDbInstance().prepare('UPDATE cost_budgets SET reset_at = ?, current_spend = 30 WHERE id = ?')
        .run(pastDate, budgetId);

      const resetCount = db.resetExpiredBudgets();
      expect(resetCount).toBeGreaterThanOrEqual(1);

      const budget = db.getBudgetStatus(budgetId);
      expect(budget.current_spend).toBe(0);
    });

    it('does NOT reset disabled budgets', () => {
      const name = `disabled-budget-${Date.now()}`;
      db.setBudget(name, 100, null, 'monthly', 80);

      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      const pastDate = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();
      db.getDbInstance().prepare('UPDATE cost_budgets SET reset_at = ?, current_spend = 75, enabled = 0 WHERE id = ?')
        .run(pastDate, budgetId);

      db.resetExpiredBudgets();

      const budget = db.getBudgetStatus(budgetId);
      expect(budget.current_spend).toBe(75);
    });
  });

  describe('setBudget reset_at', () => {
    it('sets reset_at on creation', () => {
      const name = `reset-at-test-${Date.now()}`;
      db.setBudget(name, 100, null, 'monthly', 80);

      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      const budget = db.getBudgetStatus(budgetId);
      expect(budget.reset_at).toBeTruthy();
      // reset_at should be a valid ISO date string
      expect(new Date(budget.reset_at).getTime()).toBeGreaterThan(0);
    });

    it('preserves existing reset_at on upsert', () => {
      const name = `upsert-reset-${Date.now()}`;
      db.setBudget(name, 100, null, 'monthly', 80);

      const budgetId = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
      const originalBudget = db.getBudgetStatus(budgetId);
      const originalResetAt = originalBudget.reset_at;

      // Upsert with new budget amount
      db.setBudget(name, 200, null, 'monthly', 90);

      const updatedBudget = db.getBudgetStatus(budgetId);
      expect(updatedBudget.reset_at).toBe(originalResetAt);
      expect(updatedBudget.budget_usd).toBe(200);
    });
  });

  // ── Workflow Cost Summary ──────────────────────────────────

  describe('getWorkflowCostSummary', () => {
    it('returns zero cost for workflow with no tasks', () => {
      const result = db.getWorkflowCostSummary('nonexistent-workflow');

      expect(result.total_cost_usd).toBe(0);
      expect(result.total_input_tokens).toBe(0);
      expect(result.total_output_tokens).toBe(0);
      expect(result.by_model).toEqual([]);
    });

    it('aggregates costs across workflow tasks', () => {
      const workflowId = `wf-cost-${Date.now()}`;
      db.createWorkflow({ id: workflowId, name: 'Cost Test Workflow' });

      const task1 = createTask({ workflow_id: workflowId });
      const task2 = createTask({ workflow_id: workflowId });

      db.recordTokenUsage(task1, { input_tokens: 1000, output_tokens: 500, model: 'codex' });
      db.recordTokenUsage(task2, { input_tokens: 2000, output_tokens: 1000, model: 'gpt-4' });

      const result = db.getWorkflowCostSummary(workflowId);

      expect(result.total_input_tokens).toBe(3000);
      expect(result.total_output_tokens).toBe(1500);
      expect(result.total_cost_usd).toBeGreaterThan(0);
      expect(result.by_model).toHaveLength(2);
      expect(result.by_model.some(m => m.model === 'codex')).toBe(true);
      expect(result.by_model.some(m => m.model === 'gpt-4')).toBe(true);
    });

    it('groups by model in cost descending order', () => {
      const workflowId = `wf-model-${Date.now()}`;
      db.createWorkflow({ id: workflowId, name: 'Model Order Test' });

      const task1 = createTask({ workflow_id: workflowId });
      // gpt-4 is more expensive than codex
      db.recordTokenUsage(task1, { input_tokens: 5000, output_tokens: 5000, model: 'gpt-4' });
      db.recordTokenUsage(task1, { input_tokens: 100, output_tokens: 100, model: 'gpt-3.5-turbo' });

      const result = db.getWorkflowCostSummary(workflowId);

      expect(result.by_model.length).toBeGreaterThanOrEqual(2);
      // First model should have higher cost
      expect(result.by_model[0].cost_usd).toBeGreaterThanOrEqual(result.by_model[1].cost_usd);
    });
  });

  // ── Cost Forecasting ──────────────────────────────────

  describe('getCostForecast', () => {
    it('should return daily average and projection from cost data', () => {
      for (let i = 0; i < 10; i++) {
        const taskId = createTask();
        db.recordCost('codex', taskId, 1000, 500, 'gpt-5.3-codex-spark');
      }
      const forecast = db.getCostForecast();
      expect(forecast).toHaveProperty('daily_avg');
      expect(forecast).toHaveProperty('projected_monthly');
      expect(forecast.daily_avg).toBeGreaterThan(0);
      expect(forecast.projected_monthly).toBeCloseTo(forecast.daily_avg * 30, 0);
    });

    it('should include budget forecasts with days_remaining', () => {
      db.setBudget('fc-budget', 100, null, 'monthly', 80);
      for (let i = 0; i < 5; i++) {
        const taskId = createTask();
        db.recordCost('codex', taskId, 1000, 500, 'model');
      }
      const forecast = db.getCostForecast();
      expect(forecast.budgets.length).toBeGreaterThan(0);
      expect(forecast.budgets[0]).toHaveProperty('days_remaining');
      expect(forecast.budgets[0]).toHaveProperty('utilization_percent');
    });

    it('should return Infinity days_remaining when daily_avg is zero', () => {
      // getCostForecast uses token_usage table (getCostByPeriod), not cost_tracking.
      // When token_usage has no data, daily_avg is 0 and days_remaining is Infinity.
      // Use a fresh DB to ensure no prior token_usage data.
      const freshDir = path.join(os.tmpdir(), `torque-vtest-forecast-${Date.now()}`);
      fs.mkdirSync(freshDir, { recursive: true });
      const origDir = process.env.TORQUE_DATA_DIR;
      process.env.TORQUE_DATA_DIR = freshDir;

      const dbModPath = require.resolve('../database');
      const freshDb = require('../database');
      freshDb.init();

      try {
        freshDb.setBudget('no-spend-fresh', 50, null, 'monthly', 80);
        const forecast = freshDb.getCostForecast();
        const budget = forecast.budgets.find(b => b.name === 'no-spend-fresh');
        expect(budget).toBeDefined();
        expect(budget.days_remaining).toBe(Infinity);
        expect(budget.projected_exhaustion_date).toBeNull();
      } finally {
        try { freshDb.close(); } catch { /* ignore */ }
        fs.rmSync(freshDir, { recursive: true, force: true });
        process.env.TORQUE_DATA_DIR = origDir;
      }
    });

    it('should return zero values when no cost data', () => {
      // Use a fresh DB with no prior data
      const freshDir = path.join(os.tmpdir(), `torque-vtest-forecast-zero-${Date.now()}`);
      fs.mkdirSync(freshDir, { recursive: true });
      const origDir = process.env.TORQUE_DATA_DIR;
      process.env.TORQUE_DATA_DIR = freshDir;

      const dbModPath = require.resolve('../database');
      const freshDb = require('../database');
      freshDb.init();

      try {
        const forecast = freshDb.getCostForecast();
        expect(forecast.daily_avg).toBe(0);
        expect(forecast.projected_monthly).toBe(0);
      } finally {
        try { freshDb.close(); } catch { /* ignore */ }
        fs.rmSync(freshDir, { recursive: true, force: true });
        process.env.TORQUE_DATA_DIR = origDir;
      }
    });
  });
});
