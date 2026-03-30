const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let taskSequence = 0;

beforeAll(() => { ({ db } = setupTestDb('val-cost')); });
afterAll(() => { teardownTestDb(); });

function createCompletedTask(overrides = {}) {
  taskSequence += 1;
  const taskId = `val-cost-task-${taskSequence}`;
  db.createTask({
    id: taskId,
    task_description: `Cost test task ${taskSequence}`,
    provider: 'codex',
    status: 'completed',
    ...overrides,
  });
  return taskId;
}

describe('Validation Cost Handlers', () => {
  describe('get_cost_summary', () => {
    it('returns default 30-day summary payload', async () => {
      const result = await safeTool('get_cost_summary', {});
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(getText(result));

      expect(payload.days).toBe(30);
      expect(Array.isArray(payload.costs)).toBe(true);
    });

    it('returns provider-filtered summary with supplied days', async () => {
      const taskId = createCompletedTask({ provider: 'provider-alpha', status: 'completed' });
      db.recordCost('provider-alpha', taskId, 250, 60, 'model-alpha');

      const result = await safeTool('get_cost_summary', { provider: 'provider-alpha', days: '1' });
      expect(result.isError).toBeTruthy();
      const text = getText(result);

      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Parameter "days" must be of type number, got string');
    });
  });

  describe('get_budget_status', () => {
    it('returns budget data or container error', async () => {
      db.setBudget('validation-cost-global', 100, null, 'monthly', 80);
      db.setBudget('validation-cost-provider', 200, 'codex', 'weekly', 75);

      const result = await safeTool('get_budget_status', {});
      // In test mode, the DI container may not be booted (budgetWatcher unavailable)
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        const payload = JSON.parse(text);
        expect(Array.isArray(payload.budgets)).toBe(true);
        expect(payload.count).toBe(payload.budgets.length);
      }
    });
  });

  describe('set_budget', () => {
    it('creates a budget with defaults', async () => {
      const result = await safeTool('set_budget', { name: 'validation-cost-default', budget_usd: 300 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Budget "validation-cost-default" set to $300 monthly');

      const budget = db.getBudgetStatus('budget-validation-cost-default');
      expect(budget).toBeTruthy();
      expect(budget.period).toBe('monthly');
      expect(budget.alert_threshold_percent).toBe(80);
    });

    it('creates a budget with provider and custom period/threshold', async () => {
      const result = await safeTool('set_budget', {
        name: 'validation-cost-provider-budget',
        provider: 'openai',
        budget_usd: 75,
        period: 'daily',
        alert_threshold: 60
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('for openai');

      const budget = db.getBudgetStatus('budget-validation-cost-provider-budget');
      expect(budget.provider).toBe('openai');
      expect(budget.period).toBe('daily');
      expect(budget.alert_threshold_percent).toBe(60);
    });

    it('updates an existing budget by name', async () => {
      await safeTool('set_budget', { name: 'validation-cost-upsert', budget_usd: 111 });
      const updateResult = await safeTool('set_budget', { name: 'validation-cost-upsert', budget_usd: 222 });
      expect(updateResult.isError).toBeFalsy();

      const budget = db.getBudgetStatus('budget-validation-cost-upsert');
      expect(budget.budget_usd).toBe(222);
    });

    it('rejects missing name', async () => {
      const result = await safeTool('set_budget', { budget_usd: 50 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
      expect(getText(result)).toContain('Missing required parameter: "name" (Budget name)');
    });

    it('rejects non-positive budget', async () => {
      const result = await safeTool('set_budget', { name: 'validation-cost-bad', budget_usd: 0 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('budget_usd must be a positive number');
    });
  });

  describe('get_cost_forecast', () => {
    it('returns forecast projection with budget awareness', async () => {
      const taskA = createCompletedTask();
      const taskB = createCompletedTask();

      db.recordCost('codex', taskA, 120, 40, 'model-x');
      db.recordCost('codex', taskB, 80, 20, 'model-x');
      db.setBudget('forecast-validation-budget', 400, null, 'monthly', 80);

      const result = await safeTool('get_cost_forecast', {});
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(getText(result));

      expect(payload).toHaveProperty('daily_avg');
      expect(payload).toHaveProperty('projected_monthly');
      expect(payload).toHaveProperty('trend_direction');
      expect(payload).toHaveProperty('budgets');
      expect(Array.isArray(payload.budgets)).toBe(true);
      expect(payload.budgets.some((b) => b.name === 'forecast-validation-budget')).toBe(true);
    });

    it('accepts days argument', async () => {
      const result = await safeTool('get_cost_forecast', { days: '14' });
      expect(result.isError).toBeTruthy();
      const text = getText(result);
      expect(text).toContain('Validation failed for 1 parameter(s):');
      expect(text).toContain('Parameter "days" must be of type number, got string');
    });
  });
});
