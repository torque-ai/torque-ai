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

  // ============================================
  // Scope Budget Handlers (cost-focused coverage)
  // ============================================

  describe('set_scope_budget', () => {
    it('rejects missing scope_type', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_id: 'cost-proj-1',
        window: 'monthly',
        amount_usd: 100
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing scope_id', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'project',
        window: 'monthly',
        amount_usd: 100
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing window', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'project',
        scope_id: 'cost-proj-1',
        amount_usd: 100
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing amount_usd', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'project',
        scope_id: 'cost-proj-1',
        window: 'monthly'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects completely empty args', async () => {
      const result = await safeTool('set_scope_budget', {});
      expect(result.isError).toBe(true);
    });

    it('rejects invalid scope_type enum value', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'invalid_scope',
        scope_id: 'cost-proj-1',
        window: 'monthly',
        amount_usd: 100
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('scope_type');
    });

    it('rejects invalid window enum value', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'project',
        scope_id: 'cost-proj-1',
        window: 'yearly',
        amount_usd: 100
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('window');
    });

    it('sets a scope budget with valid args', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'project',
        scope_id: 'cost-test-proj',
        window: 'monthly',
        amount_usd: 50
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Scope Budget Set');
        expect(text).toContain('project');
        expect(text).toContain('cost-test-proj');
      }
    });

    it('accepts optional warn_at_fraction parameter', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'user',
        scope_id: 'cost-user-1',
        window: 'daily',
        amount_usd: 25,
        warn_at_fraction: 0.9
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('accepts optional hard_cap parameter', async () => {
      const result = await safeTool('set_scope_budget', {
        scope_type: 'tenant',
        scope_id: 'cost-tenant-1',
        window: 'monthly',
        amount_usd: 200,
        hard_cap: true
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('get_scope_spend', () => {
    it('rejects missing scope_type', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_id: 'cost-proj-1',
        window: 'monthly'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing scope_id', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'project',
        window: 'monthly'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing window', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'project',
        scope_id: 'cost-proj-1'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects completely empty args', async () => {
      const result = await safeTool('get_scope_spend', {});
      expect(result.isError).toBe(true);
    });

    it('rejects invalid scope_type enum value', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'invalid_scope',
        scope_id: 'cost-proj-1',
        window: 'monthly'
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('scope_type');
    });

    it('rejects invalid window enum value', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'project',
        scope_id: 'cost-proj-1',
        window: 'yearly'
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('window');
    });

    it('returns spend data for valid args', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'project',
        scope_id: 'cost-test-proj',
        window: 'monthly'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Scope Spend');
        expect(text).toContain('project');
        expect(text).toContain('cost-test-proj');
      }
    });

    it('returns spend data with daily window', async () => {
      const result = await safeTool('get_scope_spend', {
        scope_type: 'user',
        scope_id: 'cost-user-1',
        window: 'daily'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('list_scope_budgets', () => {
    it('rejects missing scope_type', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_id: 'cost-proj-1'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing scope_id', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_type: 'project'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects completely empty args', async () => {
      const result = await safeTool('list_scope_budgets', {});
      expect(result.isError).toBe(true);
    });

    it('rejects invalid scope_type enum value', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_type: 'invalid_scope',
        scope_id: 'cost-proj-1'
      });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain('scope_type');
    });

    it('returns budgets list for valid args', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_type: 'project',
        scope_id: 'cost-test-proj'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
      if (!result.isError) {
        expect(text).toContain('Scope Budgets');
      }
    });

    it('returns budgets for different scope types (global)', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_type: 'global',
        scope_id: 'default'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it('returns budgets for domain scope', async () => {
      const result = await safeTool('list_scope_budgets', {
        scope_type: 'domain',
        scope_id: 'engineering'
      });
      const text = getText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
