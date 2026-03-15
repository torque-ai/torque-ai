const path = require('path');
const os = require('os');
const fs = require('fs');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
let testDir;
let origDataDir;
let db;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-budget-completeness-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
}

function teardownDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

function budgetIdForName(name) {
  return `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

describe('Budget completeness checks', () => {
  beforeEach(() => setupDb());
  afterEach(() => teardownDb());

  it('deleteBudget deletes by ID', () => {
    const budget = db.setBudget('Budget Delete By ID', 100, null, 'monthly', 80);
    const deleted = db.deleteBudget(budget.id);

    expect(deleted).toEqual({ deleted: true, id: budget.id });
    expect(db.getBudgetStatus(budget.id)).toBeUndefined();
  });

  it('deleteBudget deletes by name', () => {
    const budgetName = 'Budget Delete By Name';
    db.setBudget(budgetName, 100, null, 'monthly', 80);

    const deleted = db.deleteBudget(budgetName);
    const budgetId = budgetIdForName(budgetName);

    expect(deleted).toEqual({ deleted: true, id: budgetName });
    expect(db.getBudgetStatus(budgetId)).toBeUndefined();
  });

  it('deleteBudget returns deleted:false for nonexistent budget', () => {
    const missing = 'does-not-exist';

    const deleted = db.deleteBudget(missing);
    expect(deleted).toEqual({ deleted: false, id: missing });
  });

  it('does not reset total-period budgets in resetExpiredBudgets', () => {
    const budgetName = 'Total Budget Example';
    const budget = db.setBudget(budgetName, 100, null, 'total', 80);

    const past = new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)).toISOString();
    db.getDbInstance().prepare('UPDATE cost_budgets SET reset_at = ?, current_spend = ? WHERE id = ?')
      .run(past, 75, budget.id);

    const before = db.getBudgetStatus(budget.id);
    db.resetExpiredBudgets();
    const after = db.getBudgetStatus(budget.id);

    expect(before).toBeTruthy();
    expect(after.current_spend).toBe(before.current_spend);
    expect(after.reset_at).toBe(before.reset_at);
  });
});
