let db;
const costTracking = require('../db/cost-tracking');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

function setupDb() {
  ({ db } = setupTestDbOnly('budget-completeness-'));
}

function teardownDb() {
  teardownTestDb();
}

function budgetIdForName(name) {
  return `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

describe('Budget completeness checks', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('deleteBudget deletes by ID', () => {
    const budget = costTracking.setBudget('Budget Delete By ID', 100, null, 'monthly', 80);
    const deleted = costTracking.deleteBudget(budget.id);

    expect(deleted).toEqual({ deleted: true, id: budget.id });
    expect(costTracking.getBudgetStatus(budget.id)).toBeUndefined();
  });

  it('deleteBudget deletes by name', () => {
    const budgetName = 'Budget Delete By Name';
    costTracking.setBudget(budgetName, 100, null, 'monthly', 80);

    const deleted = costTracking.deleteBudget(budgetName);
    const budgetId = budgetIdForName(budgetName);

    expect(deleted).toEqual({ deleted: true, id: budgetName });
    expect(costTracking.getBudgetStatus(budgetId)).toBeUndefined();
  });

  it('deleteBudget returns deleted:false for nonexistent budget', () => {
    const missing = 'does-not-exist';

    const deleted = costTracking.deleteBudget(missing);
    expect(deleted).toEqual({ deleted: false, id: missing });
  });

  it('does not reset total-period budgets in resetExpiredBudgets', () => {
    const budgetName = 'Total Budget Example';
    const budget = costTracking.setBudget(budgetName, 100, null, 'total', 80);

    const past = new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString();
    db.getDbInstance().prepare('UPDATE cost_budgets SET reset_at = ?, current_spend = ? WHERE id = ?')
      .run(past, 75, budget.id);

    const before = costTracking.getBudgetStatus(budget.id);
    costTracking.resetExpiredBudgets();
    const after = costTracking.getBudgetStatus(budget.id);

    expect(before).toBeTruthy();
    expect(after.current_spend).toBe(before.current_spend);
    expect(after.reset_at).toBe(before.reset_at);
  });
});
