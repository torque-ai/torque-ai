const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const costTracking = require('../db/cost-tracking');
const workflowEngine = require('../db/workflow-engine');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer, db;

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  db = require('../database');
  db.resetForTest(templateBuffer);
  costTracking.setDb(db.getDbInstance());
  costTracking.setGetTask((taskId) => db.getTask(taskId));
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
  costTracking.setDb(db.getDbInstance());
  costTracking.setGetTask((taskId) => db.getTask(taskId));
});
afterAll(() => { try { db.close(); } catch {} });

function createTask(overrides = {}) {
  const taskId = overrides.id || randomUUID();
  db.createTask({
    id: taskId,
    task_description: overrides.task_description || 'cost-tracking module task',
    status: overrides.status || 'queued',
    working_directory: overrides.working_directory || os.tmpdir(),
    provider: overrides.provider || 'codex',
    model: overrides.model || 'codex',
    priority: overrides.priority ?? 0,
    timeout_minutes: overrides.timeout_minutes || 30,
    project: overrides.project || 'cost-tracking-tests',
    ...overrides,
  });
  return taskId;
}

function budgetIdForName(name) {
  return `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

function uniqueName(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function setBudgetResetDate(name, resetDateIso, currentSpend = 0, overrides = {}) {
  const id = budgetIdForName(name);
  const fields = ['reset_at = ?', 'current_spend = ?', 'enabled = ?'];
  const values = [resetDateIso, currentSpend, overrides.enabled ?? 1];
  if (overrides.period) {
    fields.push('period = ?');
    values.push(overrides.period);
  }

  values.push(id);
  const stmt = db.getDbInstance().prepare(`UPDATE cost_budgets SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

describe('db/cost-tracking module', () => {
  describe('recordTokenUsage', () => {
    it('records token usage with model-aware estimation and project metadata', () => {
      const taskId = createTask({ project: 'alpha', model: 'gpt-4o' });
      const result = costTracking.recordTokenUsage(taskId, {
        input_tokens: 1000,
        output_tokens: 500,
        model: 'gpt-4o',
      });

      expect(result.task_id).toBe(taskId);
      expect(result.project).toBe('alpha');
      expect(result.total_tokens).toBe(1500);
      expect(result.model).toBe('gpt-4o');
      expect(result.estimated_cost_usd).toBeCloseTo(0.0125, 12);
    });

    it('defaults model lookup and handles missing token counts', () => {
      const taskId = createTask({ model: 'codex' });
      const result = costTracking.recordTokenUsage(taskId, { model: 'unknown-model' });

      expect(result.input_tokens).toBe(0);
      expect(result.output_tokens).toBe(0);
      expect(result.total_tokens).toBe(0);
      expect(result.model).toBe('unknown-model');
      expect(result.estimated_cost_usd).toBe(0);
    });

    it('rejects invalid token counts and does not insert rows', () => {
      const taskId = createTask();
      const before = db.getDbInstance().prepare('SELECT COUNT(*) as count FROM token_usage WHERE task_id = ?').get(taskId).count;
      const result = costTracking.recordTokenUsage(taskId, {
        input_tokens: -5,
        output_tokens: Number.NaN,
        model: 'codex',
      });

      expect(result).toBe(0);
      const after = db.getDbInstance().prepare('SELECT COUNT(*) as count FROM token_usage WHERE task_id = ?').get(taskId).count;
      expect(after).toBe(before);
    });
  });

  it('returns task usage history ordered by recorded timestamp', () => {
    const taskId = createTask();
    costTracking.recordTokenUsage(taskId, { input_tokens: 100, output_tokens: 10, model: 'codex' });
    costTracking.recordTokenUsage(taskId, { input_tokens: 200, output_tokens: 20, model: 'codex' });

    const usageRows = costTracking.getTaskTokenUsage(taskId);
    expect(usageRows).toHaveLength(2);
    expect(usageRows[0].recorded_at >= usageRows[1].recorded_at).toBe(true);
  });

  describe('getTokenUsageSummary', () => {
    it('returns totals and per-model aggregation', () => {
      const taskA = createTask({ project: 'project-a' });
      const taskB = createTask({ project: 'project-a' });

      costTracking.recordTokenUsage(taskA, { input_tokens: 1000, output_tokens: 500, model: 'codex' });
      costTracking.recordTokenUsage(taskB, { input_tokens: 500, output_tokens: 250, model: 'gpt-4' });

      const summary = costTracking.getTokenUsageSummary({ project: 'project-a' });
      expect(summary.task_count).toBe(2);
      expect(summary.total_input_tokens).toBe(1500);
      expect(summary.total_output_tokens).toBe(750);
      expect(summary.total_cost_usd).toBeGreaterThan(0);
      expect(typeof summary.by_model).toBe('object');
      expect(summary.by_model.codex.task_count).toBe(1);
      expect(summary.by_model['gpt-4'].task_count).toBe(1);
    });

    it('supports since/until filtering', () => {
      const taskId = createTask();
      costTracking.recordTokenUsage(taskId, { input_tokens: 100, output_tokens: 50, model: 'codex' });
      const since = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const summary = costTracking.getTokenUsageSummary({ since });
      expect(summary.task_count).toBe(0);
      expect(summary.total_tokens).toBe(0);
    });
  });

  describe('cost period grouping', () => {
    it('groups by period for day/hour/week/month', () => {
      // Insert token usage so period grouping has data to return
      const taskId = createTask();
      costTracking.recordTokenUsage(taskId, { input_tokens: 500, output_tokens: 200, model: 'codex' });

      const periodDays = costTracking.getCostByPeriod('day', 7);
      const periodHours = costTracking.getCostByPeriod('hour', 5);
      const periodWeeks = costTracking.getCostByPeriod('week', 5);
      const periodMonths = costTracking.getCostByPeriod('month', 5);

      expect(Array.isArray(periodDays)).toBe(true);
      expect(Array.isArray(periodHours)).toBe(true);
      expect(Array.isArray(periodWeeks)).toBe(true);
      expect(Array.isArray(periodMonths)).toBe(true);

      expect(periodDays.length).toBeGreaterThan(0);
      expect(periodDays[0]).toHaveProperty('period');
      expect(periodDays[0]).toHaveProperty('tokens');
      expect(periodDays[0]).toHaveProperty('cost');
      expect(periodDays[0]).toHaveProperty('tasks');
    });
  });

  describe('estimateCost', () => {
    it('estimates cost from task description with selected model', () => {
      const estimate = costTracking.estimateCost('Write unit tests for cost forecasting', 'gpt-4o');

      expect(estimate.model).toBe('gpt-4o');
      expect(estimate.estimated_input_tokens).toBeGreaterThan(0);
      expect(estimate.estimated_output_tokens).toBeGreaterThan(0);
      expect(estimate.estimated_total_tokens).toBe(estimate.estimated_input_tokens * 3);
      expect(estimate.estimated_cost_usd).toBeGreaterThan(0);
    });

    it('defaults to codex model', () => {
      const estimate = costTracking.estimateCost('ab');
      expect(estimate.model).toBe('codex');
      expect(estimate.estimated_input_tokens).toBe(1);
      expect(estimate.estimated_output_tokens).toBe(2);
    });
  });

  describe('provider cost tracking and summaries', () => {
    it('records provider cost and exposes per-provider summaries', () => {
      const taskId = createTask();
      const cost = costTracking.recordCost('codex', taskId, 1000, 500, 'gpt-5');

      expect(cost).toBeGreaterThan(0);

      const summaryAll = costTracking.getCostSummary();
      expect(Array.isArray(summaryAll)).toBe(true);
      expect(summaryAll.some((row) => row.provider === 'codex')).toBe(true);

      const summaryCodex = costTracking.getCostSummary('codex', 30);
      expect(summaryCodex.provider).toBe('codex');
      expect(summaryCodex.total_cost).toBeCloseTo(cost, 10);
    });

    it('rejects invalid usage amounts for provider cost tracking', () => {
      const taskId = createTask();
      const result = costTracking.recordCost('codex', taskId, Number.NaN, Number.POSITIVE_INFINITY, 'gpt-5');
      const row = db.getDbInstance().prepare('SELECT 1 FROM cost_tracking WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);

      expect(result).toBe(0);
      expect(row).toBeUndefined();
    });
  });

  describe('budget management', () => {
    it('creates and updates budgets by name', () => {
      const budgetName = uniqueName('Monthly Budget');
      const created = costTracking.setBudget(budgetName, 100, null, 'monthly', 80);
      const updated = costTracking.setBudget(budgetName, 200, null, 'monthly', 90);

      expect(created.id).toBe(updated.id);
      expect(updated.budget_usd).toBe(200);
      expect(updated.period).toBe('monthly');
      expect(updated.alert_threshold).toBe(90);
    });

    it('supports transactional budget checks to avoid overspending', () => {
      const atomicBudgetName = uniqueName('Atomic Budget');
      costTracking.setBudget(atomicBudgetName, 75, null, 'monthly', 80);
      const budgetId = budgetIdForName(atomicBudgetName);
      db.getDbInstance().prepare('UPDATE cost_budgets SET current_spend = 0 WHERE id = ?').run(budgetId);
      const startBudget = costTracking.getBudgetStatus(budgetId);
      const startSpend = startBudget.current_spend || 0;

      const txn = db.getDbInstance().transaction((amount) => {
        const budget = db.getDbInstance().prepare('SELECT * FROM cost_budgets WHERE id = ?').get(budgetId);
        if (!budget) return { allowed: false };

        const projectedSpend = budget.current_spend + amount;
        if (projectedSpend > budget.budget_usd) {
          return { allowed: false, current: budget.current_spend, limit: budget.budget_usd };
        }

        db.getDbInstance().prepare('UPDATE cost_budgets SET current_spend = current_spend + ? WHERE id = ?')
          .run(amount, budgetId);
        return { allowed: true, newSpend: projectedSpend };
      });

      const first = txn(50);
      const second = txn(30);
      const third = txn(30);

      expect(first.allowed).toBe(true);
      expect(first.newSpend).toBe(startSpend + 50);
      expect(second.allowed).toBe(false);
      expect(second.current).toBe(startSpend + 50);
      expect(second.limit).toBe(75);

      const budget = costTracking.getBudgetStatus(budgetId);
      expect(budget.current_spend).toBe(startSpend + 50);
      expect(third.allowed).toBe(false);
    });

    it('updates matching budgets atomically and blocks over-spend', () => {
      const globalBudgetName = uniqueName('Global Budget');
      const providerBudgetName = uniqueName('Provider Budget');
      costTracking.setBudget(globalBudgetName, 120, null, 'monthly', 80);
      costTracking.setBudget(providerBudgetName, 90, 'codex', 'monthly', 80);
      const first = costTracking.updateBudgetSpend('codex', 40);
      const second = costTracking.updateBudgetSpend('codex', 90);

      expect(first.allowed).toBe(true);
      expect(first.updatedBudgets).toBeGreaterThanOrEqual(2);
      expect(second.allowed).toBe(false);

      const globalBudget = costTracking.getBudgetStatus(budgetIdForName(globalBudgetName));
      const providerBudget = costTracking.getBudgetStatus(budgetIdForName(providerBudgetName));

      expect(globalBudget.current_spend).toBe(40);
      expect(providerBudget.current_spend).toBe(40);
      expect(second.current).toBe(40);
      expect(second.limit).toBeGreaterThanOrEqual(75);
    });

    it('can delete budgets by id or name', () => {
      const budget = costTracking.setBudget(uniqueName('Delete Me'), 60, null, 'monthly', 80);
      const byId = costTracking.deleteBudget(budget.id);
      expect(byId).toEqual({ deleted: true, id: budget.id });
      expect(costTracking.getBudgetStatus(budget.id)).toBeUndefined();

      const deleteByName = uniqueName('Delete Me Too');
      const byName = costTracking.setBudget(deleteByName, 75, null, 'monthly', 80);
      const nameDelete = costTracking.deleteBudget(deleteByName);
      expect(nameDelete).toEqual({ deleted: true, id: deleteByName });
      expect(costTracking.getBudgetStatus(byName.id)).toBeUndefined();
    });

    it('resets expired budgets and leaves others untouched', () => {
      const activeName = uniqueName('Resettable Monthly');
      const totalName = uniqueName('No Reset Total');
      const disabledName = uniqueName('Disabled Reset');
      const active = costTracking.setBudget(activeName, 100, null, 'monthly', 80);
      const total = costTracking.setBudget(totalName, 100, null, 'total', 80);
      const disabled = costTracking.setBudget(disabledName, 100, null, 'monthly', 80);
      setBudgetResetDate(activeName, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), 55);
      setBudgetResetDate(totalName, new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), 55);
      setBudgetResetDate(disabledName, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), 55, { enabled: 0 });

      const resets = costTracking.resetExpiredBudgets();

      expect(resets).toBeGreaterThanOrEqual(1);

      const activeAfter = costTracking.getBudgetStatus(active.id);
      const totalAfter = costTracking.getBudgetStatus(total.id);
      const disabledAfter = costTracking.getBudgetStatus(disabled.id);
      expect(activeAfter.current_spend).toBe(0);
      expect(totalAfter.current_spend).toBe(55);
      expect(disabledAfter.current_spend).toBe(55);
    });

    it('reports warnings and exceeded thresholds', () => {
      const warningBudgetName = uniqueName('Warning Budget');
      const warningProvider = `${warningBudgetName}-provider`;
      costTracking.setBudget(warningBudgetName, 100, warningProvider, 'monthly', 50);
      const first = costTracking.updateBudgetSpend(warningProvider, 40);
      const second = costTracking.updateBudgetSpend(warningProvider, 20);

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);

      const exceeded = costTracking.isBudgetExceeded();
      expect(exceeded.warning).toBe(true);
      expect(exceeded.spent).toBe(60);
      expect(exceeded.limit).toBe(100);
    });
  });

  describe('cost forecasting', () => {
    it('computes trend-aware forecasts from historical token usage and budgets', () => {
      const now = Date.now();
      for (let i = 0; i < 6; i += 1) {
        const taskId = createTask();
        costTracking.recordTokenUsage(taskId, {
          input_tokens: 1000 + i * 250,
          output_tokens: 500 + i * 100,
          model: 'codex',
        });

        const row = db.getDbInstance().prepare('SELECT id FROM token_usage WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
        const recordedAt = new Date(now - (5 - i) * 24 * 60 * 60 * 1000).toISOString();
        db.getDbInstance().prepare('UPDATE token_usage SET recorded_at = ? WHERE id = ?').run(recordedAt, row.id);
      }

      const forecastBudgetName = uniqueName('Forecast Budget');
      costTracking.setBudget(forecastBudgetName, 500, null, 'monthly', 80);
      const forecast = costTracking.getCostForecast(10);

      expect(forecast.days_analyzed).toBe(6);
      expect(forecast.daily_avg).toBeGreaterThan(0);
      expect(forecast.projected_monthly).toBeGreaterThan(0);
      expect(['increasing', 'decreasing', 'stable']).toContain(forecast.trend_direction);
      expect(forecast.slope).toBeGreaterThanOrEqual(0);

      const budgetForecast = forecast.budgets.find((entry) => entry.name === forecastBudgetName);
      expect(budgetForecast).toBeDefined();
      expect(budgetForecast.days_remaining).toBeGreaterThan(0);
      expect(budgetForecast.projected_exhaustion_date).toBeTruthy();
    });

    it('returns zero projections with Infinity exhaustion when no usage exists', () => {
      const noSpendBudgetName = uniqueName('No Spend Budget');
      costTracking.setBudget(noSpendBudgetName, 60, null, 'monthly', 80);
      const forecast = costTracking.getCostForecast(30);

      expect(forecast.days_analyzed).toBe(0);
      expect(forecast.total_cost_analyzed).toBe(0);
      expect(forecast.daily_avg).toBe(0);
      expect(forecast.projected_monthly).toBe(0);

      const budgetForecast = forecast.budgets.find((entry) => entry.name === noSpendBudgetName);
      expect(budgetForecast.days_remaining).toBe(Infinity);
      expect(budgetForecast.projected_exhaustion_date).toBeNull();
    });
  });

  describe('workflow-level and aggregate summaries', () => {
    it('aggregates workflow token costs by model and totals', () => {
      const workflowId = `wf-cost-${Date.now()}`;
      workflowEngine.createWorkflow({ id: workflowId, name: 'Cost Workflow' });

      const taskA = createTask({ workflow_id: workflowId, model: 'codex' });
      const taskB = createTask({ workflow_id: workflowId, model: 'gpt-4' });
      costTracking.recordTokenUsage(taskA, { input_tokens: 1000, output_tokens: 500, model: 'codex' });
      costTracking.recordTokenUsage(taskB, { input_tokens: 500, output_tokens: 250, model: 'gpt-4' });

      const summary = costTracking.getWorkflowCostSummary(workflowId);

      expect(summary.total_input_tokens).toBe(1500);
      expect(summary.total_output_tokens).toBe(750);
      expect(summary.total_cost_usd).toBeGreaterThan(0);
      expect(summary.by_model).toHaveLength(2);
      expect(summary.by_model.map((row) => row.model).sort()).toEqual(['codex', 'gpt-4'].sort());
    });

    it('returns zero values for workflow without tasks', () => {
      const summary = costTracking.getWorkflowCostSummary('wf-does-not-exist');

      expect(summary.total_cost_usd).toBe(0);
      expect(summary.total_input_tokens).toBe(0);
      expect(summary.total_output_tokens).toBe(0);
      expect(summary.by_model).toEqual([]);
    });
  });
});
